// players.js — media adapters for Remote Theatre.
// Every adapter implements:
//   load(src) -> Promise, play(), pause(), seek(sec), getTime(), setRate(r),
//   isPlaying(), onEvent(cb) -> unsubscribe, destroy()
// plus helpers: getDuration(), setMuted(bool), kind ('html5' | 'youtube').
// Adapter events (cb receives {type, message?}):
//   'ready'     — can play (also after buffering ends)
//   'play' | 'pause' | 'seeked' | 'ended'
//   'buffering' — stalled for longer than BUFFER_DEBOUNCE_MS
//   'blocked'   — autoplay was refused; the video was muted instead
//   'error'     — message holds a human-readable reason
// No DOM access happens at import time, so the pure helpers can be unit-tested in Node.

export const HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js';
export const YT_API_URL = 'https://www.youtube.com/iframe_api';
const BUFFER_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------- pure helpers

/** Parse "90", "90s", "1m30s", "1h2m3s" into seconds (0 if unparseable). */
export function parseTimeParam(v) {
  if (v == null) return 0;
  const s = String(v).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.floor(parseFloat(s));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || !s) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|ogg|mkv)$/i;

/**
 * Turn a pasted link into a source descriptor, or null if it is not an http(s) URL.
 *   {type:'yt', id, start}
 *   {type:'html5', url, hls, guess}   (guess=true when the URL does not look like a video file)
 */
export function parseSource(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!/\./.test(u.hostname) && u.hostname !== 'localhost') return null;
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') id = u.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1];
  }
  if (id !== null) {
    if (!id || !YT_ID.test(id)) return null;
    const start = parseTimeParam(u.searchParams.get('t') ?? u.searchParams.get('start'));
    return { type: 'yt', id, start };
  }
  const hls = /\.m3u8$/i.test(u.pathname);
  const direct = hls || VIDEO_EXT.test(u.pathname);
  return { type: 'html5', url: u.href, hls, guess: !direct };
}

/** Compare a picked File (or {name,size}) with the room's file descriptor. */
export function matchFile(file, src) {
  const nameOk = file.name === src.name;
  const sizeOk = file.size === src.size;
  return { ok: nameOk && sizeOk, nameOk, sizeOk };
}

// ---------------------------------------------------------------- script loader

const scriptCache = new Map();
/** Load a classic script once; resolves when it has executed. */
export function loadScript(url) {
  if (!scriptCache.has(url)) {
    scriptCache.set(url, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { scriptCache.delete(url); reject(new Error('Could not load ' + url)); };
      document.head.appendChild(s);
    }));
  }
  return scriptCache.get(url);
}

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
    const t = setTimeout(() => reject(new Error('YouTube API timed out (blocked network?)')), 15000);
    loadScript(YT_API_URL).catch((e) => { clearTimeout(t); reject(e); });
    // resolve() above clears nothing; the timer is harmless once settled.
  });
}

// ---------------------------------------------------------------- base class

class BaseAdapter {
  constructor(container) { this.container = container; this._cbs = new Set(); }
  onEvent(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }
  _emit(ev) { for (const cb of [...this._cbs]) { try { cb(ev); } catch (e) { console.error(e); } } }
}

// ---------------------------------------------------------------- HTML5 / HLS / local file

export class HTML5Player extends BaseAdapter {
  constructor(container) {
    super(container);
    this.kind = 'html5';
    this.v = document.createElement('video');
    this.v.playsInline = true;
    this.v.preload = 'auto';
    this.v.controls = false;          // all control goes through the synced UI
    this.v.className = 'rt-video';
    container.appendChild(this.v);
    this.hls = null; this._objectUrl = null; this._bufTimer = null; this._buffering = false;
    this._wire();
  }

  _wire() {
    const v = this.v;
    v.addEventListener('play', () => this._emit({ type: 'play' }));
    v.addEventListener('pause', () => this._emit({ type: 'pause' }));
    v.addEventListener('seeked', () => this._emit({ type: 'seeked' }));
    v.addEventListener('ended', () => this._emit({ type: 'ended' }));
    v.addEventListener('error', () => {
      const e = v.error;
      this._emit({ type: 'error', message: e ? (e.message || 'Media error ' + e.code) : 'Media error' });
    });
    const stall = () => {
      if (v.paused || this._bufTimer) return;
      this._bufTimer = setTimeout(() => {
        this._bufTimer = null;
        if (!v.paused && v.readyState < 3) { this._buffering = true; this._emit({ type: 'buffering' }); }
      }, BUFFER_DEBOUNCE_MS);
    };
    const ok = () => {
      clearTimeout(this._bufTimer); this._bufTimer = null;
      if (this._buffering || v.readyState >= 3) { this._buffering = false; this._emit({ type: 'ready' }); }
    };
    v.addEventListener('waiting', stall);
    v.addEventListener('stalled', stall);
    v.addEventListener('canplay', ok);
    v.addEventListener('playing', ok);
  }

  /** src: {url, hls} for links, or {file: File} for a local file. */
  async load(src) {
    const v = this.v;
    this._teardownSource();
    if (src.file) {
      this._objectUrl = URL.createObjectURL(src.file);
      v.src = this._objectUrl;
    } else if (src.hls) {
      if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = src.url;                         // Safari / iOS native HLS
      } else {
        await loadScript(HLS_URL);
        if (!window.Hls || !window.Hls.isSupported()) throw new Error('HLS is not supported in this browser');
        this.hls = new window.Hls({ enableWorker: true });
        this.hls.on(window.Hls.Events.ERROR, (_e, d) => {
          if (d.fatal) this._emit({ type: 'error', message: 'HLS error: ' + d.details });
        });
        this.hls.loadSource(src.url);
        this.hls.attachMedia(v);
      }
    } else {
      v.src = src.url;
    }
    v.load();
    // Resolve when metadata is there, or after 10 s so a slow server cannot hang the room.
    await new Promise((resolve) => {
      const done = () => { v.removeEventListener('loadedmetadata', done); clearTimeout(t); resolve(); };
      const t = setTimeout(done, 10000);
      v.addEventListener('loadedmetadata', done);
      if (v.readyState >= 1) done();
    });
    this._emit({ type: 'ready' });
  }

  _teardownSource() {
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
  }

  async play() {
    try { await this.v.play(); }
    catch (e) {
      if (e && e.name === 'AbortError') return;          // interrupted by a pause(): fine
      if (e && e.name === 'NotAllowedError') {
        // Autoplay policy: fall back to muted playback and let the UI offer an unmute button.
        this.v.muted = true;
        this._emit({ type: 'blocked' });
        try { await this.v.play(); } catch { /* still blocked: overlay will ask for a tap */ }
      } else this._emit({ type: 'error', message: String(e && e.message || e) });
    }
  }
  pause() { this.v.pause(); }
  seek(sec) { try { this.v.currentTime = Math.max(0, sec); } catch { /* not seekable yet */ } }
  getTime() { return this.v.currentTime || 0; }
  getDuration() { return Number.isFinite(this.v.duration) ? this.v.duration : 0; }
  setRate(r) { if (this.v.playbackRate !== r) this.v.playbackRate = r; }
  isPlaying() { return !this.v.paused && !this.v.ended; }
  setMuted(m) { this.v.muted = !!m; }
  isMuted() { return this.v.muted; }
  setVolume(x) { this.v.volume = Math.min(1, Math.max(0, x)); }
  destroy() {
    clearTimeout(this._bufTimer);
    this._teardownSource();
    this._cbs.clear();
    this.v.pause(); this.v.removeAttribute('src'); this.v.load(); this.v.remove();
  }
}

// ---------------------------------------------------------------- YouTube (IFrame Player API)

const YT_ERRORS = {
  2: 'Invalid YouTube video id', 5: 'YouTube HTML5 player error', 100: 'Video not found or private',
  101: 'The owner does not allow embedding this video', 150: 'The owner does not allow embedding this video',
};

export class YouTubePlayer extends BaseAdapter {
  constructor(container) {
    super(container);
    this.kind = 'youtube';
    this.p = null; this.ready = false; this._bufTimer = null; this._buffering = false;
  }

  /** src: {id, start}. First call builds the player; later calls cue another video. */
  async load(src) {
    await loadYouTubeApi();
    if (this.p && this.ready) { this.p.cueVideoById({ videoId: src.id, startSeconds: src.start || 0 }); return; }
    await new Promise((resolve, reject) => {
      const holder = document.createElement('div');
      this.container.appendChild(holder);
      this.p = new window.YT.Player(holder, {
        width: '100%', height: '100%', videoId: src.id,
        playerVars: {
          controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1, fs: 0,
          iv_load_policy: 3, start: src.start || 0, enablejsapi: 1, origin: location.origin,
        },
        events: {
          onReady: () => { this.ready = true; resolve(); this._emit({ type: 'ready' }); },
          onStateChange: (e) => this._onState(e.data),
          onError: (e) => {
            const message = YT_ERRORS[e.data] || 'YouTube error ' + e.data;
            this._emit({ type: 'error', message }); reject(new Error(message));
          },
          onAutoplayBlocked: () => this._emit({ type: 'blocked' }),
        },
      });
      // The iframe must not capture clicks: all control goes through the synced UI.
      const f = this.container.querySelector('iframe');
      if (f) f.style.pointerEvents = 'none';
    });
  }

  _onState(s) {
    const S = window.YT.PlayerState;
    if (s !== S.BUFFERING) { clearTimeout(this._bufTimer); this._bufTimer = null; }
    if (s === S.PLAYING) {
      if (this._buffering) { this._buffering = false; this._emit({ type: 'ready' }); }
      this._emit({ type: 'play' });
    } else if (s === S.PAUSED) this._emit({ type: 'pause' });
    else if (s === S.ENDED) this._emit({ type: 'ended' });
    else if (s === S.BUFFERING && !this._bufTimer) {
      this._bufTimer = setTimeout(() => {
        this._bufTimer = null; this._buffering = true; this._emit({ type: 'buffering' });
      }, BUFFER_DEBOUNCE_MS);
    } else if (s === S.CUED) this._emit({ type: 'ready' });
  }

  play() { if (this.ready) this.p.playVideo(); }
  pause() { if (this.ready) this.p.pauseVideo(); }
  seek(sec) { if (this.ready) this.p.seekTo(Math.max(0, sec), true); }
  getTime() { return this.ready ? (this.p.getCurrentTime() || 0) : 0; }
  getDuration() { return this.ready ? (this.p.getDuration() || 0) : 0; }
  setRate(r) {
    if (!this.ready || this.p.getPlaybackRate() === r) return;
    const rates = this.p.getAvailablePlaybackRates();
    if (rates.includes(r)) this.p.setPlaybackRate(r);
  }
  isPlaying() { return this.ready && this.p.getPlayerState() === window.YT.PlayerState.PLAYING; }
  setMuted(m) { if (this.ready) (m ? this.p.mute() : this.p.unMute()); }
  isMuted() { return this.ready ? this.p.isMuted() : false; }
  setVolume(x) { if (this.ready) this.p.setVolume(Math.round(x * 100)); }
  destroy() {
    clearTimeout(this._bufTimer); this._cbs.clear();
    try { if (this.p) this.p.destroy(); } catch { /* already gone */ }
    this.p = null; this.ready = false;
  }
}

/** Build the right adapter for a room source descriptor. */
export function createPlayer(src, container) {
  if (src.type === 'yt') return new YouTubePlayer(container);
  return new HTML5Player(container);   // 'html5' and 'file'
}

// ---------------------------------------------------------------- screen share helpers

/** Ask for a screen/tab with audio; fall back to video-only if audio constraints fail. */
export async function getDisplayStream() {
  const md = navigator.mediaDevices;
  if (!md || !md.getDisplayMedia) throw new Error('Screen sharing is not supported in this browser');
  const video = { frameRate: { ideal: 60, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } };
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  let stream;
  try { stream = await md.getDisplayMedia({ video, audio }); }
  catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) throw e;
    stream = await md.getDisplayMedia({ video: true });
  }
  const vt = stream.getVideoTracks()[0];
  if (vt) vt.contentHint = 'motion';       // prefer framerate over resolution
  return stream;
}

/** Raise the bitrate cap and prefer framerate on an outgoing PeerJS media call. */
export function tuneSender(call) {
  const pc = call && call.peerConnection;
  if (!pc) return;
  for (const s of pc.getSenders()) {
    if (!s.track || s.track.kind !== 'video') continue;
    try {
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = 6_000_000;
      p.degradationPreference = 'maintain-framerate';
      s.setParameters(p).catch(() => {});
    } catch { /* unsupported: ignore */ }
  }
}
