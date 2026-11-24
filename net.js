// net.js — PeerJS room: star topology, host = hub + clock authority.
// The host owns the authoritative playback state and chat history; guests send *requests*
// and the host broadcasts the resulting state. Screen-share media goes in a full mesh:
// the sharer opens a PeerJS media call to every other peer (peer list comes from the roster).
//
// Events emitted (Room.on(name, fn)):
//   status {state:'connecting'|'connected'|'reconnecting'|'host-left'|'error', message}
//   open (code)           host: broker accepted our id, room link is valid
//   welcome (data)        guest: joined (clock synced, state + roster received)
//   state (state)         authoritative playback state changed
//   roster (list)         participants with ping/drift
//   settings (settings)   {hostOnly}
//   share ({id,name}|null)  who is sharing now
//   stream ({stream, from, name})  remote screen stream arrived
//   streamclosed ({from})
//   chat (msg), react (msg), denied (action), clock ({offset, rtt}), hostleft ()
// Protocol messages are JSON objects with a "t" field.

import { CONST, computeOffset, nowMs, leadTime, expectedPosition, bufferGateStatus,
  makeRoomId, isNewerSeq } from './sync.js';
import { tuneSender } from './players.js';

// ---------------------------------------------------------------- config helpers

export const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const TURN_KEY = 'rt-turn';

/** "host:port" -> PeerJS server options (secure unless localhost). */
export function parseSignal(str) {
  if (!str) return null;
  const m = /^([^:/\s]+)(?::(\d+))?$/.exec(str.trim());
  if (!m) return null;
  const host = m[1];
  const local = host === 'localhost' || host === '127.0.0.1';
  return { host, port: m[2] ? Number(m[2]) : (local ? 9000 : 443), path: '/', secure: !local };
}

export function loadTurn() {
  try { return JSON.parse(localStorage.getItem(TURN_KEY)) || {}; } catch { return {}; }
}
export function saveTurn(t) {
  if (!t || !t.url) localStorage.removeItem(TURN_KEY);
  else localStorage.setItem(TURN_KEY, JSON.stringify({ url: t.url, username: t.username || '', credential: t.credential || '' }));
}

/** Build the `new Peer(id, options)` options object. */
export function buildPeerOptions(signal, turn) {
  const iceServers = DEFAULT_ICE.slice();
  if (turn && turn.url) iceServers.push({ urls: turn.url, username: turn.username || undefined, credential: turn.credential || undefined });
  const opts = { config: { iceServers }, debug: 1 };
  const sig = parseSignal(signal);
  if (sig) Object.assign(opts, sig);
  return opts;
}

class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { for (const f of this._h[ev] || []) { try { f(...a); } catch (e) { console.error(ev, e); } } }
}

const CONTROL_ACTIONS = new Set(['play', 'pause', 'seek', 'src']);

// ---------------------------------------------------------------- Room

export class Room extends Emitter {
  /** opts: {role:'host'|'guest', code?, name, signal?, turn?} */
  constructor(opts) {
    super();
    this.role = opts.role;
    this.name = opts.name || 'Guest';
    this.signal = opts.signal || '';
    this.turn = opts.turn || {};
    this.code = opts.code || null;          // 6 chars; peer id is "rt-" + code
    this.myId = null; this.hostId = this.code ? 'rt-' + this.code : null;
    this.peer = null; this.conn = null;     // guest: connection to host
    this.peers = new Map();                 // host: id -> {conn, name, rtt, drift, buffering}
    this.roster = []; this.settings = { hostOnly: false }; this.share = null; this.chatLog = [];
    this.state = { src: { type: 'none' }, playing: false, pos: 0, at: 0, rate: 1, seq: 0 };
    this.offset = 0; this.rtt = 0; this.myDrift = 0; this.myBuffering = false;
    this.localStream = null; this.calls = new Map(); this.incoming = new Set();
    this._left = false; this._timers = []; this._gate = null; this._joined = false;
  }

  get isHost() { return this.role === 'host'; }
  /** Current time on the host's clock. */
  hostNow() { return nowMs() + this.offset; }
  get roomLink() {
    const u = new URL(location.origin + location.pathname);
    u.searchParams.set('r', this.code);
    if (this.signal) u.searchParams.set('signal', this.signal);
    return u.toString();
  }

  _opts() { return buildPeerOptions(this.signal, this.turn); }
  _every(fn, ms) { const t = setInterval(fn, ms); this._timers.push(t); return t; }
  _status(state, message = '') { this.emit('status', { state, message }); }

  // ------------------------------------------------------------ startup

  start() {
    this._status('connecting', this.isHost ? 'Opening room…' : 'Connecting to host…');
    if (this.isHost) this._startHost(0); else this._startGuest();
  }

  _startHost(attempt) {
    const id = makeRoomId();
    this.code = id.slice(3); this.hostId = id; this.myId = id;
    const peer = this.peer = new Peer(id, this._opts());
    peer.on('open', () => {
      this._status('connected', 'Room open');
      this.roster = this._buildRoster();
      this.emit('open', this.code);
      this._every(() => this._broadcastRoster(), 2000);
    });
    peer.on('connection', (c) => this._hostOnConn(c));
    peer.on('call', (c) => this._onCall(c));
    peer.on('disconnected', () => { if (!this._left && !peer.destroyed) peer.reconnect(); });
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id' && attempt < 5) { peer.destroy(); this._startHost(attempt + 1); return; }
      if (e.type === 'peer-unavailable') return;       // a guest-initiated call/connection failed
      this._status('error', 'Signalling error: ' + (e.message || e.type));
    });
  }

  _startGuest() {
    this._ensurePeer();
  }

  _ensurePeer() {
    if (this.peer && !this.peer.destroyed) return;
    const peer = this.peer = new Peer(undefined, this._opts());
    peer.on('open', (id) => { this.myId = id; this._connectHost(); });
    peer.on('call', (c) => this._onCall(c));
    peer.on('disconnected', () => { if (!this._left && !peer.destroyed) peer.reconnect(); });
    peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') this._scheduleRetry();
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) this._scheduleRetry();
      else this._status('error', 'Connection error: ' + (e.message || e.type));
    });
  }

  // ------------------------------------------------------------ guest connection + retry

  _connectHost() {
    if (this._left) return;
    const token = this._attempt = (this._attempt || 0) + 1;
    const conn = this.peer.connect(this.hostId, { serialization: 'json', reliable: true });
    const fail = setTimeout(() => { if (token === this._attempt && !conn.open) { try { conn.close(); } catch {} this._scheduleRetry(); } }, 6000);
    conn.on('open', () => {
      clearTimeout(fail);
      if (token !== this._attempt) return;
      this.conn = conn; this._retryUntil = 0;
      conn.send({ t: 'hello', name: this.name });
      this._pending = { welcome: null, clock: false };
      this._clockRound(true);
    });
    conn.on('data', (m) => this._guestMsg(m));
    conn.on('close', () => { clearTimeout(fail); if (this.conn === conn) { this.conn = null; this._guestLost(); } });
    conn.on('error', () => {});
  }

  _guestLost() {
    if (this._left || this._hostGone) return;
    this._retryUntil = nowMs() + 30000;
    this._status('reconnecting', 'Connection lost — retrying…');
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._left || this._hostGone || this._retryTimer) return;
    if (!this._retryUntil) this._retryUntil = nowMs() + (this._joined ? 30000 : 12000);
    if (this._joined) this._status('reconnecting', 'Reconnecting to host…');
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this._left || this._hostGone) return;
      if (nowMs() > this._retryUntil) return this._giveUp();
      if (!this.peer || this.peer.destroyed) this._ensurePeer();
      else if (this.peer.disconnected) { this.peer.reconnect(); setTimeout(() => this._connectHost(), 800); }
      else this._connectHost();
    }, 1500);
  }

  /** Retry window (12 s before first join, 30 s after) is over. */
  _giveUp() {
    this._hostGone = true;
    if (this._joined) { this._status('host-left', 'Host left'); this.emit('hostleft'); }
    else this._status('error', 'Could not find that room. The host may have closed it.');
  }

  // ------------------------------------------------------------ clock sync (guest)

  /** Send PING_COUNT pings, keep the min-RTT sample. `initial` gates the welcome event. */
  _clockRound(initial = false) {
    if (!this.conn || !this.conn.open) return;
    const round = this._round = (this._round || 0) + 1;
    const samples = [];
    this._clockSamples = { round, samples };
    for (let i = 0; i < CONST.PING_COUNT; i++) {
      setTimeout(() => {
        if (this.conn && this.conn.open) this.conn.send({ t: 'ping', round, n: i, t0: nowMs() });
      }, i * 25);
    }
    setTimeout(() => this._finishClock(round, initial), CONST.PING_COUNT * 25 + 700);
  }

  _finishClock(round, initial) {
    if (!this._clockSamples || this._clockSamples.round !== round) return;
    const best = computeOffset(this._clockSamples.samples);
    this._clockSamples = null;
    if (best) { this.offset = best.offset; this.rtt = best.rtt; this.emit('clock', best); }
    if (initial && this._pending) { this._pending.clock = true; this._maybeWelcome(); }
  }

  _maybeWelcome() {
    const p = this._pending;
    if (!p || !p.welcome || !p.clock) return;
    this._pending = null; this._joined = true; this._hostGone = false;
    const w = p.welcome;
    this.state = w.state; this.settings = w.settings; this.share = w.share; this.roster = w.roster;
    this._status('connected', 'Connected');
    this.emit('welcome', w);
    if (!this._guestTimers) {
      this._guestTimers = true;
      this._every(() => this._clockRound(false), CONST.CLOCK_RESYNC_MS);
      this._every(() => this._send({ t: 'report', rtt: this.rtt, drift: this.myDrift }), 2000);
    }
  }

  // ------------------------------------------------------------ guest messages

  _send(msg) { if (this.conn && this.conn.open) this.conn.send(msg); }

  _guestMsg(m) {
    switch (m.t) {
      case 'welcome': this.myId = m.id || this.myId; this._pending && (this._pending.welcome = m); this._maybeWelcome(); break;
      case 'pong': {
        const cs = this._clockSamples;
        if (cs && cs.round === m.round) cs.samples.push({ t0: m.t0, t1: nowMs(), th: m.th });
        break;
      }
      case 'state':
        if (isNewerSeq(m.state.seq, this.state && this.state.seq)) { this.state = m.state; this.emit('state', m.state); }
        break;
      case 'roster': this.roster = m.list; this._meshShare(); this.emit('roster', m.list); break;
      case 'settings': this.settings = m.settings; this.emit('settings', m.settings); break;
      case 'share': this.share = m.share; this._onShareChange(); break;
      case 'chat': this.chatLog.push(m); this.emit('chat', m); break;
      case 'react': this.emit('react', m); break;
      case 'denied': this.emit('denied', m.action); break;
      case 'bye': this._hostGone = true; this._status('host-left', 'Host left'); this.emit('hostleft'); break;
    }
  }

  // ------------------------------------------------------------ host: connections

  _hostOnConn(conn) {
    conn.on('data', (m) => this._hostMsg(conn, m));
    conn.on('close', () => this._hostDrop(conn));
    conn.on('error', () => {});
  }

  _hostMsg(conn, m) {
    const id = conn.peer;
    if (m.t === 'ping') { conn.send({ t: 'pong', round: m.round, n: m.n, t0: m.t0, th: nowMs() }); return; }
    if (m.t === 'hello') {
      const old = this.peers.get(id);
      if (old && old.conn !== conn) { old.conn._replaced = true; try { old.conn.close(); } catch {} }
      this.peers.set(id, { conn, name: String(m.name || 'Guest').slice(0, 24), rtt: 0, drift: 0, buffering: false });
      this.roster = this._buildRoster();
      conn.send({ t: 'welcome', id, hostId: this.hostId, state: this.state, roster: this.roster,
        settings: this.settings, share: this.share, chat: this.chatLog.slice(-50) });
      if (!old) this._systemChat(this.peers.get(id).name + ' joined');
      this._broadcastRoster();
      return;
    }
    const peer = this.peers.get(id);
    if (!peer) return;                       // ignore everything before hello
    switch (m.t) {
      case 'req': this._apply(m.a, m.p || {}, id); break;
      case 'report': peer.rtt = +m.rtt || 0; peer.drift = +m.drift || 0; break;
      case 'buf': this._hostBuf(id, !!m.on); break;
      case 'chat': this._chat(id, peer.name, m.text); break;
      case 'react': this._broadcast({ t: 'react', emoji: m.emoji, id, name: peer.name }, true); break;
      case 'share': this._hostShare(id, peer.name, !!m.on); break;
    }
  }

  _hostDrop(conn) {
    if (conn._replaced) return;
    const id = conn.peer, p = this.peers.get(id);
    if (!p || p.conn !== conn) return;
    this.peers.delete(id);
    this._systemChat(p.name + ' left');
    if (this.share && this.share.id === id) this._hostShare(id, p.name, false);
    this._hostBuf(id, false);
    this.roster = this._buildRoster(); this._broadcastRoster();
  }

  _buildRoster() {
    const list = [{ id: this.hostId, name: this.name, host: true, rtt: 0, drift: this.isHost ? this.myDrift : 0, buffering: this.myBuffering }];
    for (const [id, p] of this.peers) list.push({ id, name: p.name, host: false, rtt: p.rtt, drift: p.drift, buffering: p.buffering });
    return list;
  }

  _broadcastRoster() {
    this.roster = this._buildRoster();
    this._broadcast({ t: 'roster', list: this.roster });
    this._meshShare();
    this.emit('roster', this.roster);
  }

  /** Send to every guest; with `alsoLocal` also emit it to this (host) page. */
  _broadcast(msg, alsoLocal = false) {
    for (const p of this.peers.values()) if (p.conn.open) p.conn.send(msg);
    if (alsoLocal) this._hostLocal(msg);
  }
  _hostLocal(msg) { if (msg.t === 'chat') this.emit('chat', msg); else if (msg.t === 'react') this.emit('react', msg); }

  _systemChat(text) {
    const msg = { t: 'chat', system: true, text, ts: Date.now(), name: '', id: '' };
    this.chatLog.push(msg); if (this.chatLog.length > 100) this.chatLog.shift();
    this._broadcast(msg, true);
  }

  _chat(id, name, text) {
    text = String(text || '').slice(0, 500).trim();
    if (!text) return;
    const msg = { t: 'chat', id, name, text, ts: Date.now() };
    this.chatLog.push(msg); if (this.chatLog.length > 100) this.chatLog.shift();
    this._broadcast(msg, true);
  }

  // ------------------------------------------------------------ host: authoritative state

  _maxOneWay() {
    let m = 0;
    for (const p of this.peers.values()) m = Math.max(m, p.rtt / 2);
    return m;
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch, seq: this.state.seq + 1 };
    this._broadcast({ t: 'state', state: this.state });
    this.emit('state', this.state);
  }

  /** Apply a control request (from a guest or from the host's own UI). */
  _apply(action, p, from) {
    if (from !== this.hostId && this.settings.hostOnly && CONTROL_ACTIONS.has(action)) {
      const peer = this.peers.get(from); if (peer) peer.conn.send({ t: 'denied', action }); return;
    }
    const now = nowMs(), s = this.state;
    const lead = leadTime(this._maxOneWay());
    switch (action) {
      case 'play':
        this._gate = null;
        if (s.src.type === 'none' || s.playing) return;
        this._setState({ playing: true, at: now + lead, reason: null });
        break;
      case 'pause':
        this._gate = null;
        if (!s.playing) return;
        this._setState({ playing: false, pos: expectedPosition(s, now), at: now, reason: null });
        break;
      case 'seek': {
        if (s.src.type === 'none') return;
        const pos = Math.max(0, Number(p.pos) || 0);
        this._setState({ pos, at: s.playing ? now + lead : now, reason: null });
        break;
      }
      case 'src':
        this._gate = null;
        for (const x of this.peers.values()) x.buffering = false;
        this.myBuffering = false;
        this._setState({ src: p.src, playing: false, pos: (p.src && p.src.start) || 0, at: now, reason: null });
        break;
    }
  }

  // Buffering gate: pause everybody while a peer stalls, resume with a scheduled start.
  _hostBuf(id, on) {
    if (id === this.hostId) this.myBuffering = on;
    else { const p = this.peers.get(id); if (p) p.buffering = on; }
    const now = nowMs(), s = this.state;
    if (on && s.playing && !this._gate) {
      this._gate = { startedAt: now };
      this._setState({ playing: false, pos: expectedPosition(s, now), at: now, reason: 'buffering' });
      this._gateTimer = setTimeout(() => this._gateCheck(), CONST.BUFFER_TIMEOUT_MS + 20);
    }
    this._gateCheck();
  }

  _gateCheck() {
    if (!this._gate) return;
    const waiting = [];
    if (this.myBuffering) waiting.push(this.hostId);
    for (const [id, p] of this.peers) if (p.buffering) waiting.push(id);
    const st = bufferGateStatus(waiting, this._gate.startedAt, nowMs());
    if (st === 'wait') return;
    clearTimeout(this._gateTimer);
    this._gate = null;
    if (!this.state.playing && this.state.reason === 'buffering') {
      this._setState({ playing: true, at: nowMs() + leadTime(this._maxOneWay()), reason: null });
    }
  }

  // ------------------------------------------------------------ public API

  /** action: 'play' | 'pause' | 'seek' ({pos}) | 'src' ({src}). */
  request(action, p = {}) {
    if (this.isHost) this._apply(action, p, this.hostId);
    else this._send({ t: 'req', a: action, p });
  }
  sendChat(text) { if (this.isHost) this._chat(this.hostId, this.name, text); else this._send({ t: 'chat', text }); }
  sendReact(emoji) {
    if (this.isHost) this._broadcast({ t: 'react', emoji, id: this.hostId, name: this.name }, true);
    else this._send({ t: 'react', emoji });
  }
  setHostOnly(on) {
    if (!this.isHost) return;
    this.settings = { ...this.settings, hostOnly: !!on };
    this._broadcast({ t: 'settings', settings: this.settings });
    this.emit('settings', this.settings);
  }
  reportBuffering(on) {
    if (this.myBuffering === on) return;
    this.myBuffering = on;
    if (this.isHost) this._hostBuf(this.hostId, on); else this._send({ t: 'buf', on });
  }
  setDrift(ms) { this.myDrift = ms; }

  // ------------------------------------------------------------ screen share (mesh)

  _hostShare(id, name, on) {
    if (on) this.share = { id, name };
    else if (this.share && this.share.id === id) this.share = null;
    else return;
    this._broadcast({ t: 'share', share: this.share });
    this._onShareChange();
  }

  _onShareChange() {
    // Someone else started sharing: drop our own share.
    if (this.localStream && (!this.share || this.share.id !== this.myId)) this._closeCalls();
    this.emit('share', this.share);
  }

  /** Begin sharing `stream`; announces to host and calls every other peer. */
  startShare(stream) {
    this.localStream = stream;
    if (this.isHost) this._hostShare(this.hostId, this.name, true);
    else this._send({ t: 'share', on: true });
    this._meshShare();
  }

  stopShare() {
    if (!this.localStream) return;
    this._closeCalls();
    if (this.isHost) this._hostShare(this.hostId, this.name, false);
    else this._send({ t: 'share', on: false });
  }

  _closeCalls() {
    for (const c of this.calls.values()) { try { c.close(); } catch {} }
    this.calls.clear();
    if (this.localStream) { this.localStream.getTracks().forEach((t) => t.stop()); this.localStream = null; }
  }

  /** Call any roster peer we are not yet streaming to (also covers late joiners). */
  _meshShare() {
    if (!this.localStream || !this.peer) return;
    for (const r of this.roster) {
      if (r.id === this.myId || this.calls.has(r.id)) continue;
      const call = this.peer.call(r.id, this.localStream, { metadata: { kind: 'screen', name: this.name } });
      if (!call) continue;
      this.calls.set(r.id, call);
      call.on('close', () => { if (this.calls.get(r.id) === call) this.calls.delete(r.id); });
      call.on('error', () => this.calls.delete(r.id));
      setTimeout(() => tuneSender(call), 300);
      setTimeout(() => tuneSender(call), 2000);
    }
  }

  _onCall(call) {
    call.answer();                               // we only receive; no local stream
    this.incoming.add(call);
    call.on('stream', (stream) => this.emit('stream', { stream, from: call.peer, name: (call.metadata && call.metadata.name) || '' }));
    call.on('close', () => { this.incoming.delete(call); this.emit('streamclosed', { from: call.peer }); });
  }

  // ------------------------------------------------------------ teardown

  leave() {
    if (this._left) return;
    this._left = true;
    this._timers.forEach(clearInterval);
    clearTimeout(this._retryTimer); clearTimeout(this._gateTimer);
    this._closeCalls();
    if (this.isHost) this._broadcast({ t: 'bye' });
    try { if (this.peer) this.peer.destroy(); } catch {}
  }
}
