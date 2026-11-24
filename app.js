// app.js — UI + wiring for Remote Theatre.
// Responsibilities: landing/join/room views, applying the host's authoritative state to the
// local player (scheduled start, drift loop, buffering reports, echo suppression),
// screen-share stage, people list, chat, reactions, settings dialog.
// Networking lives in net.js, pure sync math in sync.js, media adapters in players.js.

import { CONST, EchoGuard, driftAction, driftColor, expectedPosition, formatTime, nowMs } from './sync.js';
import { parseSource, createPlayer, matchFile, getDisplayStream } from './players.js';
import { Room, loadTurn, saveTurn } from './net.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SIGNAL = params.get('signal') || '';
const ROOM_CODE = (params.get('r') || '').toLowerCase().replace(/^rt-/, '').replace(/[^a-z0-9]/g, '').slice(0, 6);
const EMOJIS = ['👍', '😂', '😮', '❤️', '👏'];

/** All mutable app state in one place (also exposed as window.__rt for tests/debugging). */
const S = {
  room: null, isHost: false, player: null, state: { src: { type: 'none' }, playing: false, pos: 0, at: 0, rate: 1, seq: 0 },
  srcKey: '', loading: false, loadToken: 0, unlocked: false,
  file: null, fileKey: '', fileMismatch: false,
  echo: new EchoGuard(), settleUntil: 0, buffering: false, startTimer: null,
  shareInfo: null, screenStream: null, screenFrom: '', dragging: false, userMuted: false, started: false,
};
window.__rt = { S };

// ---------------------------------------------------------------- tiny UI helpers

function toast(msg, kind = '', ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
function showView(id) {
  for (const v of ['view-landing', 'view-join', 'view-room']) $(v).classList.toggle('hidden', v !== id);
}
const show = (el, on) => $(el).classList.toggle('hidden', !on);
const srcKey = (src) => JSON.stringify(src || { type: 'none' });
const getName = (id, dflt) => (($(id).value || '').trim() || dflt).slice(0, 24);

async function copyText(text, inputEl) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  inputEl.focus(); inputEl.select();
  try { return document.execCommand('copy'); } catch { return false; }
}

// ---------------------------------------------------------------- landing / join

function initLanding() {
  const saved = localStorage.getItem('rt-name') || '';
  $('landing-name').value = saved; $('join-name').value = saved;

  const err = (m) => { $('landing-error').textContent = m; show('landing-error', !!m); };
  $('btn-create').onclick = () => {
    const url = $('landing-url').value.trim();
    let src = { type: 'none' };
    if (url) {
      src = parseSource(url);
      if (!src) return err('That does not look like a link. Use a YouTube or direct video URL (https://…).');
    }
    err(''); createRoom(src, null);
  };
  $('btn-create-screen').onclick = () => { err(''); createRoom({ type: 'none' }, null); };
  $('btn-create-file').onclick = () => $('landing-file').click();
  $('landing-file').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    createRoom({ type: 'file', name: f.name, size: f.size }, f);
  };
  for (const id of ['landing-url', 'landing-name']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create').click(); });
  $('btn-settings-landing').onclick = openSettings;
  $('btn-settings-join').onclick = openSettings;
}

function createRoom(src, file) {
  const name = getName('landing-name', 'Host');
  localStorage.setItem('rt-name', name);
  S.file = file; S.fileKey = file ? srcKey(src) : '';
  S.initialSrc = src;
  startRoom('host', name);
}

function initJoin() {
  $('join-code').textContent = ROOM_CODE;
  const go = () => {
    const name = getName('join-name', 'Guest');
    localStorage.setItem('rt-name', name);
    $('btn-join').disabled = true;
    $('join-status').textContent = 'Connecting to host…';
    startRoom('guest', name);
  };
  $('btn-join').onclick = go;
  $('join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('join-name').focus();
}

function startRoom(role, name) {
  const room = S.room = new Room({ role, name, code: ROOM_CODE, signal: SIGNAL, turn: loadTurn() });
  S.isHost = role === 'host'; S.unlocked = S.isHost;
  wireRoom(room);
  room.start();
  window.addEventListener('pagehide', () => room.leave());
}

// ---------------------------------------------------------------- room wiring

function wireRoom(room) {
  room.on('status', ({ state, message }) => {
    $('status').dataset.state = state; $('status-text').textContent = message || state;
    if (state === 'error') { $('join-status').textContent = message; $('btn-join').disabled = false; toast(message, 'warn', 6000); }
  });
  room.on('open', () => {                                   // host only
    enterRoom();
    if (S.initialSrc && S.initialSrc.type !== 'none') room.request('src', { src: S.initialSrc });
  });
  room.on('welcome', (w) => {                               // guest only
    enterRoom();
    $('chat-log').textContent = '';                        // history is resent on every (re)join
    for (const m of w.chat || []) addChat(m);
    applyState(w.state);
  });
  room.on('state', (st) => applyState(st));
  room.on('roster', renderRoster);
  room.on('settings', updateControls);
  room.on('share', (info) => {
    S.shareInfo = info;
    if (!info) { S.screenStream = null; }
    renderStage(); syncNow();
  });
  room.on('stream', ({ stream, from, name }) => {
    if (S.screenStream === stream) return;
    S.screenStream = stream; S.screenFrom = name || from;
    renderStage();
  });
  room.on('streamclosed', ({ from }) => {
    if (S.screenStream && !(S.shareInfo && S.shareInfo.id !== from)) { S.screenStream = null; renderStage(); syncNow(); }
  });
  room.on('chat', addChat);
  room.on('react', (m) => floatReaction(m.emoji, m.name));
  room.on('denied', () => toast('The host has locked the controls.', 'warn'));
  room.on('hostleft', () => { show('hostleft', true); stopLocalPlayback(); });
}

/** First time the room is usable: build the room view and start the loops. */
function enterRoom() {
  if (S.started) return;
  S.started = true;
  showView('view-room');
  $('invite-link').value = S.room.roomLink;
  show('btn-share', !!navigator.share);
  show('host-only-wrap', S.isHost);
  buildEmojiBar();
  updateControls(); renderStage(); renderRoster(S.room.roster);
  setInterval(driftLoop, CONST.DRIFT_TICK_MS);
  setInterval(uiTick, 250);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
}

// ---------------------------------------------------------------- source loading + state application

async function loadSource(src) {
  const key = S.srcKey = srcKey(src);
  const token = ++S.loadToken;
  S.loading = true; S.buffering = false;
  clearTimeout(S.startTimer);
  if (S.player) { S.player.destroy(); S.player = null; }
  show('btn-unmute', false);
  if (src.type === 'none' || (src.type === 'file' && S.fileKey !== key)) {   // nothing to load / waiting for file pick
    S.loading = false; renderStage(); return;
  }
  const p = S.player = createPlayer(src, $('player-host'));
  p.onEvent((ev) => onPlayerEvent(p, ev));
  try {
    await p.load(src.type === 'file' ? { file: S.file } : src.type === 'html5' ? { url: src.url, hls: src.hls } : src);
  } catch (e) {
    toast('Could not load the video: ' + e.message, 'warn', 6000);
  }
  if (token !== S.loadToken) return;                    // superseded by a newer source
  S.loading = false;
  p.setMuted(S.userMuted);
  p.setVolume(Number($('volume').value));
  renderStage();
}

async function applyState(st) {
  S.state = st;
  if (srcKey(st.src) !== S.srcKey) await loadSource(st.src);
  updateControls(); renderStage();
  syncNow();
}

/** Drive the local player to match the authoritative state (scheduled start for play). */
function syncNow() {
  const p = S.player, room = S.room, st = S.state;
  if (!p || !room || S.loading) return;
  clearTimeout(S.startTimer);
  if (screenActive()) { S.echo.suppress(); p.pause(); return; }
  const hostNow = room.hostNow();
  const seekIfFar = (target, tol) => {
    if (Math.abs(p.getTime() - target) > tol) { S.echo.suppress(); p.seek(target); }
  };
  S.echo.suppress();
  if (st.playing) {
    if (hostNow < st.at) {
      // Scheduled start: park at the start position, then start exactly at `at`.
      p.pause(); seekIfFar(st.pos, 0.05);
      S.startTimer = setTimeout(() => { S.echo.suppress(); S.settleUntil = nowMs() + 1500; p.setRate(st.rate); p.play(); },
        Math.max(0, st.at - hostNow - 6));
    } else {
      seekIfFar(expectedPosition(st, hostNow), 0.15);
      S.settleUntil = nowMs() + 1500; p.setRate(st.rate); p.play();
    }
  } else {
    p.pause(); seekIfFar(st.pos, 0.05);
  }
}

function stopLocalPlayback() {
  clearTimeout(S.startTimer);
  if (S.player) { S.echo.suppress(); S.player.pause(); }
}

const screenActive = () => !!(S.shareInfo || S.screenStream || (S.room && S.room.localStream));

/** Every 500 ms: measure drift against the host-clock expectation and correct it. */
function driftLoop() {
  const p = S.player, room = S.room, st = S.state;
  if (!p || !room || S.loading || screenActive()) return;
  const hostNow = room.hostNow();
  if (!st.playing) {
    const d = (p.getTime() - st.pos) * 1000;
    room.setDrift(Number.isFinite(d) ? d : 0);
    if (Math.abs(d) > 300 && nowMs() > S.settleUntil) { S.echo.suppress(); p.seek(st.pos); }
    return;
  }
  if (hostNow < st.at || nowMs() < S.settleUntil || S.buffering) return;
  const exp = expectedPosition(st, hostNow);
  const dur = p.getDuration();
  if (dur && exp >= dur) return;                         // past the end: host will pause on 'ended'
  const drift = (p.getTime() - exp) * 1000;
  room.setDrift(drift);
  const act = driftAction(drift, p.kind);
  if (act.type === 'seek') {
    S.echo.suppress(); S.settleUntil = nowMs() + 1200; p.seek(exp + 0.05);
  } else if (act.type === 'rate') {
    p.setRate(st.rate * act.rate);
  } else {
    p.setRate(st.rate);
    if (!p.isPlaying() && nowMs() > S.settleUntil + 500) { S.echo.suppress(); p.play(); }   // lost a play() somewhere
  }
}

/** Adapter events: buffering reports, autoplay fallback, errors, and native-control echoes. */
function onPlayerEvent(p, ev) {
  if (p !== S.player) return;
  const room = S.room, st = S.state;
  switch (ev.type) {
    case 'buffering': S.buffering = true; room.reportBuffering(true); break;
    case 'ready': if (S.buffering) { S.buffering = false; room.reportBuffering(false); } break;
    case 'blocked': show('btn-unmute', true); break;
    case 'error': toast('Player error: ' + ev.message, 'warn', 6000); break;
    case 'ended': if (S.isHost && st.playing) room.request('pause'); break;
    case 'play': case 'pause': {
      // Echo guard: ignore events caused by our own commands; otherwise treat as a user action.
      if (S.echo.isSuppressed() || nowMs() < S.settleUntil || S.loading || screenActive()) break;
      if (ev.type === 'play' && !st.playing) room.request('play');
      else if (ev.type === 'pause' && st.playing && !(p.getDuration() && p.getTime() >= p.getDuration() - 0.5)) room.request('pause');
      break;
    }
  }
}

// ---------------------------------------------------------------- stage, overlay, controls

function renderStage() {
  const room = S.room; if (!room) return;
  const src = S.state.src, sharing = screenActive();
  const mine = !!room.localStream;
  const stream = mine ? room.localStream : S.screenStream;
  show('screen-wrap', sharing);
  $('player-host').style.visibility = sharing ? 'hidden' : 'visible';
  const v = $('screen-video');
  if (stream) {
    if (v.srcObject !== stream) {
      v.srcObject = stream; v.muted = mine;
      v.play().catch(() => { v.muted = true; v.play().catch(() => {}); show('btn-unmute', true); });
    }
  } else if (v.srcObject) v.srcObject = null;
  const who = mine ? 'You' : (S.shareInfo && S.shareInfo.name) || S.screenFrom || 'Someone';
  $('screen-label').textContent = stream ? (mine ? 'You are sharing your screen' : `${who} is sharing their screen`) : `Connecting to ${who}’s screen…`;
  $('btn-screen').textContent = mine ? 'Stop sharing' : 'Share screen';

  const empty = !sharing && (src.type === 'none');
  show('stage-empty', empty);
  $('stage-empty-text').textContent = 'No video yet. Paste a link below, pick a local file, or share your screen.';

  const needFile = !sharing && src.type === 'file' && S.fileKey !== srcKey(src);
  const needTap = !sharing && !S.unlocked && src.type !== 'none' && !needFile;
  show('overlay', needFile || needTap);
  show('overlay-file', needFile); show('overlay-tap', !needFile && needTap);
  if (needFile) $('file-want').textContent = `${src.name} (${(src.size / 1048576).toFixed(1)} MB)`;
  const reason = S.state.reason === 'buffering' && !sharing;
  show('buffer-note', reason);
  if (reason) {
    const w = room.roster.filter((r) => r.buffering).map((r) => r.name);
    $('buffer-note').textContent = w.length ? `Waiting for ${w.join(', ')} to buffer…` : 'Waiting for buffering…';
  }
}

function updateControls() {
  const room = S.room; if (!room) return;
  const locked = !S.isHost && room.settings.hostOnly;
  const st = S.state;
  $('btn-play').textContent = st.playing ? '⏸' : '▶';
  $('btn-play').setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
  for (const id of ['btn-play', 'seek', 'change-url', 'btn-change-file']) $(id).disabled = locked;
  $('change-form').querySelector('button[type=submit]').disabled = locked;
  show('lock-note', locked);
  $('host-only').checked = room.settings.hostOnly;
}

/** 4 Hz: seek bar + clock labels (skipped while the user drags the slider). */
function uiTick() {
  const p = S.player, room = S.room;
  if (!p || !room || S.loading) return;
  const dur = p.getDuration();
  const seek = $('seek');
  seek.max = dur || 100;
  if (!S.dragging) {
    const cur = S.state.playing ? Math.min(p.getTime(), dur || Infinity) : S.state.pos;
    seek.value = cur; $('time-cur').textContent = formatTime(cur);
  }
  $('time-dur').textContent = formatTime(dur);
  if (S.state.reason === 'buffering') renderStage();
  renderRoster(room.roster);
}

function initControls() {
  $('btn-play').onclick = () => S.room.request(S.state.playing ? 'pause' : 'play');
  const seek = $('seek');
  seek.addEventListener('input', () => { S.dragging = true; $('time-cur').textContent = formatTime(+seek.value); });
  seek.addEventListener('change', () => { S.dragging = false; S.room.request('seek', { pos: +seek.value }); });
  $('btn-mute').onclick = () => {
    S.userMuted = !S.userMuted; $('btn-mute').textContent = S.userMuted ? '🔇' : '🔊';
    if (S.player) S.player.setMuted(S.userMuted);
  };
  $('volume').oninput = (e) => { if (S.player) S.player.setVolume(+e.target.value); $('screen-video').volume = +e.target.value; };
  $('btn-full').onclick = () => {
    const el = $('stage');
    if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen();
  };
  $('btn-unmute').onclick = () => {
    S.userMuted = false; $('btn-mute').textContent = '🔊';
    if (S.player) S.player.setMuted(false);
    const v = $('screen-video'); v.muted = !!(S.room && S.room.localStream); v.play().catch(() => {});
    show('btn-unmute', false);
  };
  // "Tap to join playback": one gesture unlocks audio for the whole session.
  $('btn-tap').onclick = () => {
    S.unlocked = true; show('overlay', false);
    const p = S.player;
    if (p) {
      p.setMuted(S.userMuted);
      if (p.kind === 'html5' && !S.state.playing) {          // prime the element inside the gesture
        S.echo.suppress(1500); Promise.resolve(p.play()).then(() => { if (!S.state.playing) p.pause(); });
      }
    }
    syncNow(); renderStage();
  };
  // Guest picks the room's local file.
  $('guest-file').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const want = S.state.src, m = matchFile(f, want);
    S.file = f; S.fileKey = srcKey(want); S.unlocked = true;
    if (!m.ok) {
      const bits = [!m.nameOk && 'name', !m.sizeOk && 'size'].filter(Boolean).join(' and ');
      toast(`This file’s ${bits} differs from the host’s. It may not be the same video, so sync can look off.`, 'warn', 7000);
    }
    loadSource(want).then(() => { renderStage(); syncNow(); });
  };

  $('host-only').onchange = (e) => S.room.setHostOnly(e.target.checked);

  // Change video: link or local file.
  $('change-form').onsubmit = (e) => {
    e.preventDefault();
    const err = $('change-error');
    const src = parseSource($('change-url').value);
    if (!src) { err.textContent = 'Paste a YouTube or direct video link (https://…).'; show('change-error', true); return; }
    show('change-error', false);
    $('change-url').value = '';
    S.room.request('src', { src });
  };
  $('btn-change-file').onclick = () => $('change-file').click();
  $('change-file').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const src = { type: 'file', name: f.name, size: f.size };
    S.file = f; S.fileKey = srcKey(src);
    S.room.request('src', { src });
    e.target.value = '';
  };

  // Invite link.
  $('btn-copy').onclick = async () => {
    const ok = await copyText($('invite-link').value, $('invite-link'));
    toast(ok ? 'Link copied. Send it to your friends.' : 'Press Ctrl/Cmd+C to copy the selected link.');
  };
  $('btn-share').onclick = () => {
    navigator.share({ title: 'Watch together on Remote Theatre', text: 'Join my watch room:', url: $('invite-link').value }).catch(() => {});
  };
  $('invite-link').onfocus = (e) => e.target.select();

  // Screen share.
  $('btn-screen').onclick = async () => {
    const room = S.room;
    if (room.localStream) { room.stopShare(); renderStage(); syncNow(); return; }
    let stream;
    try { stream = await getDisplayStream(); }
    catch (e) { toast('Screen share was not started: ' + (e.message || e.name), 'warn'); return; }
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (room.localStream === stream) { room.stopShare(); renderStage(); syncNow(); } });
    room.startShare(stream);
    renderStage();
  };

  $('btn-leave').onclick = goHome;
  $('btn-home').onclick = goHome;
  $('btn-settings').onclick = openSettings;

  // Chat + reactions.
  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const t = $('chat-input').value.trim();
    if (t) S.room.sendChat(t);
    $('chat-input').value = '';
  };
}

function goHome() {
  if (S.room) S.room.leave();
  const u = new URL(location.origin + location.pathname);
  if (SIGNAL) u.searchParams.set('signal', SIGNAL);
  location.href = u.toString();
}

// ---------------------------------------------------------------- people, chat, reactions

function renderRoster(list) {
  if (!S.room) return;
  const ul = $('people');
  const me = S.room.myId;
  ul.textContent = '';
  for (const r of list || []) {
    const li = document.createElement('li'); li.className = 'person';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.name;
    if (r.host) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'host'; nm.appendChild(b); }
    if (r.id === me) { const b = document.createElement('span'); b.className = 'badge soft'; b.textContent = 'you'; nm.appendChild(b); }
    if (r.buffering) { const b = document.createElement('span'); b.className = 'badge soft'; b.textContent = 'buffering'; nm.appendChild(b); }
    const rtt = r.id === me && !S.isHost ? S.room.rtt : r.rtt;
    const ping = document.createElement('span'); ping.className = 'stat';
    ping.textContent = r.host ? '—' : Math.round(rtt) + ' ms';
    const drift = document.createElement('span');
    const dv = r.id === me ? S.room.myDrift : r.drift;
    drift.className = 'pill ' + driftColor(dv); drift.textContent = Math.round(dv) + ' ms';
    li.append(nm, ping, drift); ul.appendChild(li);
  }
  $('people-count').textContent = (list || []).length;
}

function addChat(m) {
  const log = $('chat-log');
  const d = document.createElement('div'); d.className = 'msg' + (m.system ? ' sys' : '');
  if (m.system) d.textContent = m.text;
  else { const b = document.createElement('b'); b.textContent = m.name; d.append(b, document.createTextNode(m.text)); }
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.appendChild(d);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function buildEmojiBar() {
  const bar = $('emoji-bar'); let last = 0;
  for (const e of EMOJIS) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = e; b.setAttribute('aria-label', 'React ' + e);
    b.onclick = () => { if (nowMs() - last > 250) { last = nowMs(); S.room.sendReact(e); } };
    bar.appendChild(b);
  }
}

function floatReaction(emoji, name) {
  if (!EMOJIS.includes(emoji)) return;
  const el = document.createElement('div'); el.className = 'float';
  el.style.left = (8 + Math.random() * 80) + '%';
  el.textContent = emoji;
  const s = document.createElement('small'); s.textContent = name || ''; el.appendChild(s);
  $('reactions').appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

// ---------------------------------------------------------------- settings dialog (TURN)

function openSettings() {
  const t = loadTurn();
  $('turn-url').value = t.url || ''; $('turn-user').value = t.username || ''; $('turn-cred').value = t.credential || '';
  $('settings-dialog').showModal();
}
function initSettings() {
  $('settings-cancel').onclick = () => $('settings-dialog').close();
  $('settings-form').addEventListener('submit', () => {
    saveTurn({ url: $('turn-url').value.trim(), username: $('turn-user').value.trim(), credential: $('turn-cred').value });
    toast('Network settings saved. They apply to the next room you create or join.');
  });
}

// ---------------------------------------------------------------- boot

function boot() {
  initLanding(); initControls(); initSettings();
  if (typeof Peer === 'undefined') {
    toast('Could not load the connection library (PeerJS). Check your network or ad blocker.', 'warn', 10000);
  }
  if (ROOM_CODE) { showView('view-join'); initJoin(); } else showView('view-landing');
}
boot();
