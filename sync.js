// sync.js — pure sync math for Remote Theatre (no DOM, no network, unit-tested in Node).
// All times are milliseconds unless a name ends in "Sec". "Host clock" means the
// clock of the room host; every other peer converts with `hostNow = localNow + offset`.

/** Tunable constants from PLAN.md section 4. */
export const CONST = Object.freeze({
  PING_COUNT: 8,            // pings per clock-sync round
  CLOCK_RESYNC_MS: 15000,   // re-sync interval
  MIN_LEAD_MS: 150,         // minimum scheduled-start lead
  LEAD_MARGIN_MS: 50,       // added to the slowest guest's one-way delay
  DRIFT_TICK_MS: 500,       // drift-correction interval
  HTML5_SEEK_MS: 400,       // above this: hard seek
  HTML5_NUDGE_MS: 40,       // 40..400: playbackRate nudge
  YT_SEEK_MS: 300,          // YouTube: seek when above this
  NUDGE_RATE: 0.05,         // +-5 %
  BUFFER_TIMEOUT_MS: 8000,  // max wait for a buffering peer
  ECHO_WINDOW_MS: 600,      // ignore player events this long after we drive the player
});

/** Monotonic-ish wall clock in ms with sub-ms resolution (works in browsers and Node). */
export function nowMs() {
  if (typeof performance !== 'undefined' && performance.timeOrigin) {
    return performance.timeOrigin + performance.now();
  }
  return Date.now();
}

/**
 * Pick the best clock sample. A sample is {t0, t1, th}:
 *   t0 = local send time, t1 = local receive time, th = host clock when it answered.
 * The sample with the smallest round trip is the least distorted by queueing, so we keep it.
 * Returns {offset, rtt} where offset = hostTime - localTime, or null if no samples.
 */
export function computeOffset(samples) {
  let best = null;
  for (const s of samples || []) {
    if (!s || !Number.isFinite(s.t0) || !Number.isFinite(s.t1) || !Number.isFinite(s.th)) continue;
    const rtt = s.t1 - s.t0;
    if (rtt < 0) continue;
    if (!best || rtt < best.rtt) best = { rtt, offset: s.th - (s.t0 + s.t1) / 2 };
  }
  return best;
}

/**
 * Expected media position (seconds) at host time `hostNowMs`.
 * state = {pos (sec), at (host ms), playing, rate}.
 * Before `at` (a scheduled start still in the future) the position holds at `pos`.
 */
export function expectedPosition(state, hostNowMs) {
  if (!state) return 0;
  const pos = Number(state.pos) || 0;
  if (!state.playing) return pos;
  const elapsed = Math.max(0, hostNowMs - state.at);
  return pos + (elapsed / 1000) * (state.rate || 1);
}

/** Lead time for scheduled starts: max(150 ms, slowest guest one-way delay + 50 ms). */
export function leadTime(maxOneWayMs) {
  const ow = Number.isFinite(maxOneWayMs) ? maxOneWayMs : 0;
  return Math.max(CONST.MIN_LEAD_MS, ow + CONST.LEAD_MARGIN_MS);
}

/**
 * Decide how to fix drift. `drift` = local position - expected position, in ms
 * (positive = we are ahead). `kind` is 'html5' or 'youtube'.
 * Returns {type:'none'|'seek'|'rate', rate}. `rate` is a multiplier on the room rate.
 */
export function driftAction(drift, kind) {
  const d = Math.abs(drift);
  if (!Number.isFinite(d)) return { type: 'none', rate: 1 };
  if (kind === 'youtube') {
    return d > CONST.YT_SEEK_MS ? { type: 'seek', rate: 1 } : { type: 'none', rate: 1 };
  }
  if (d > CONST.HTML5_SEEK_MS) return { type: 'seek', rate: 1 };
  if (d >= CONST.HTML5_NUDGE_MS) {
    // Ahead -> slow down, behind -> speed up.
    return { type: 'rate', rate: drift > 0 ? 1 - CONST.NUDGE_RATE : 1 + CONST.NUDGE_RATE };
  }
  return { type: 'none', rate: 1 };
}

/** UI colour band for a drift value: green < 80, amber < 250, red otherwise. */
export function driftColor(ms) {
  if (!Number.isFinite(ms)) return 'grey';
  const d = Math.abs(ms);
  return d < 80 ? 'green' : d < 250 ? 'amber' : 'red';
}

/**
 * Echo guard: when we drive the player ourselves (play/pause/seek from a remote command),
 * the player fires events that must not be re-sent as user actions.
 * Pass the clock in so it stays testable.
 */
export class EchoGuard {
  constructor(windowMs = CONST.ECHO_WINDOW_MS) { this.windowMs = windowMs; this.until = 0; }
  /** Call right before driving the player programmatically. */
  suppress(now = nowMs(), ms = this.windowMs) { this.until = Math.max(this.until, now + ms); }
  isSuppressed(now = nowMs()) { return now < this.until; }
}

/** True if message sequence `seq` is newer than the last applied one. */
export function isNewerSeq(seq, lastSeq) {
  return Number.isFinite(seq) && seq > (Number.isFinite(lastSeq) ? lastSeq : -1);
}

/**
 * Buffer gate decision for the host. Inputs:
 *   waiting  — Set/array of peer ids still buffering
 *   startedAt/now — ms, when the gate closed and the current time
 * Returns 'wait' | 'resume' | 'timeout'.
 */
export function bufferGateStatus(waiting, startedAt, now, timeoutMs = CONST.BUFFER_TIMEOUT_MS) {
  const n = waiting && (waiting.size ?? waiting.length) || 0;
  if (n === 0) return 'resume';
  return now - startedAt >= timeoutMs ? 'timeout' : 'wait';
}

/** Format seconds as m:ss or h:mm:ss. */
export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor((sec / 60) % 60), h = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/** Random room code: "rt-" + 6 lowercase alphanumerics. */
export function makeRoomId(rand = Math.random) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(rand() * chars.length) % chars.length];
  return 'rt-' + s;
}
