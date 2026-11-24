import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOffset, expectedPosition, driftAction, leadTime, driftColor, EchoGuard,
  bufferGateStatus, isNewerSeq, formatTime, makeRoomId } from '../sync.js';
import { parseSource, parseTimeParam, matchFile } from '../players.js';

test('computeOffset picks the min-RTT sample', () => {
  // True offset +1000. Sample B has symmetric 20 ms RTT; A is skewed by a 200 ms RTT.
  const a = { t0: 0, t1: 200, th: 1000 + 50 };
  const b = { t0: 300, t1: 320, th: 1000 + 310 };
  const r = computeOffset([a, b]);
  assert.equal(r.rtt, 20);
  assert.equal(r.offset, 1000);
});
test('computeOffset handles empty / garbage', () => {
  assert.equal(computeOffset([]), null);
  assert.equal(computeOffset(null), null);
  assert.equal(computeOffset([{ t0: 5, t1: 1, th: 3 }, { t0: NaN, t1: 1, th: 1 }]), null);
});
test('expectedPosition: paused, playing, scheduled, rate', () => {
  assert.equal(expectedPosition({ pos: 12, at: 0, playing: false, rate: 1 }, 5000), 12);
  assert.equal(expectedPosition({ pos: 10, at: 1000, playing: true, rate: 1 }, 3500), 12.5);
  assert.equal(expectedPosition({ pos: 10, at: 1000, playing: true, rate: 2 }, 3000), 14);
  assert.equal(expectedPosition({ pos: 10, at: 5000, playing: true, rate: 1 }, 4000), 10); // not started yet
  assert.equal(expectedPosition(null, 1), 0);
});
test('leadTime = max(150, oneWay+50)', () => {
  assert.equal(leadTime(0), 150);
  assert.equal(leadTime(80), 150);
  assert.equal(leadTime(100), 150);
  assert.equal(leadTime(120), 170);
  assert.equal(leadTime(undefined), 150);
});
test('driftAction html5 thresholds', () => {
  assert.equal(driftAction(10, 'html5').type, 'none');
  assert.equal(driftAction(-39, 'html5').type, 'none');
  assert.deepEqual(driftAction(100, 'html5'), { type: 'rate', rate: 0.95 });   // ahead -> slow
  assert.deepEqual(driftAction(-100, 'html5'), { type: 'rate', rate: 1.05 });  // behind -> fast
  assert.equal(driftAction(400, 'html5').type, 'rate');
  assert.equal(driftAction(401, 'html5').type, 'seek');
  assert.equal(driftAction(-900, 'html5').type, 'seek');
});
test('driftAction youtube never nudges', () => {
  assert.equal(driftAction(200, 'youtube').type, 'none');
  assert.equal(driftAction(300, 'youtube').type, 'none');
  assert.equal(driftAction(301, 'youtube').type, 'seek');
  assert.equal(driftAction(-1000, 'youtube').type, 'seek');
});
test('driftColor bands', () => {
  assert.equal(driftColor(79), 'green');
  assert.equal(driftColor(-80), 'amber');
  assert.equal(driftColor(249), 'amber');
  assert.equal(driftColor(250), 'red');
  assert.equal(driftColor(NaN), 'grey');
});
test('EchoGuard suppression window', () => {
  const g = new EchoGuard(500);
  assert.equal(g.isSuppressed(0), false);
  g.suppress(1000);
  assert.equal(g.isSuppressed(1400), true);
  assert.equal(g.isSuppressed(1500), false);
});
test('bufferGateStatus', () => {
  assert.equal(bufferGateStatus(new Set(), 0, 100), 'resume');
  assert.equal(bufferGateStatus(new Set(['a']), 0, 7999), 'wait');
  assert.equal(bufferGateStatus(new Set(['a']), 0, 8000), 'timeout');
});
test('misc helpers', () => {
  assert.ok(isNewerSeq(3, 2)); assert.ok(!isNewerSeq(2, 2)); assert.ok(isNewerSeq(0, undefined));
  assert.equal(formatTime(65), '1:05'); assert.equal(formatTime(3725), '1:02:05');
  assert.match(makeRoomId(), /^rt-[a-z0-9]{6}$/);
});
test('parseSource: YouTube variants', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [`https://youtu.be/${id}`, `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/shorts/${id}`, `https://www.youtube.com/embed/${id}`,
    `https://m.youtube.com/watch?v=${id}&feature=share`, `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`]) {
    const s = parseSource(u);
    assert.equal(s.type, 'yt', u); assert.equal(s.id, id, u); assert.equal(s.start, 0);
  }
  assert.equal(parseSource(`https://youtu.be/${id}?t=90`).start, 90);
  assert.equal(parseSource(`https://www.youtube.com/watch?v=${id}&t=1m30s`).start, 90);
  assert.equal(parseSource(`https://www.youtube.com/embed/${id}?start=15`).start, 15);
});
test('parseTimeParam', () => {
  assert.equal(parseTimeParam('1h2m3s'), 3723); assert.equal(parseTimeParam('45s'), 45);
  assert.equal(parseTimeParam('x'), 0); assert.equal(parseTimeParam(null), 0);
});
test('parseSource: direct video / hls / junk', () => {
  assert.deepEqual(parseSource('http://localhost:8080/a.mp4'), { type: 'html5', url: 'http://localhost:8080/a.mp4', hls: false, guess: false });
  assert.equal(parseSource('https://x.com/v/master.m3u8?token=1').hls, true);
  assert.equal(parseSource('https://x.com/clip.webm').guess, false);
  assert.equal(parseSource('https://x.com/clip.MOV').type, 'html5');
  assert.equal(parseSource('https://x.com/page').guess, true);
  assert.equal(parseSource('not a url'), null);
  assert.equal(parseSource('javascript:alert(1)'), null);
  assert.equal(parseSource(''), null);
});
test('matchFile by name+size', () => {
  const src = { type: 'file', name: 'a.mp4', size: 100 };
  assert.deepEqual(matchFile({ name: 'a.mp4', size: 100 }, src), { ok: true, nameOk: true, sizeOk: true });
  assert.equal(matchFile({ name: 'b.mp4', size: 100 }, src).ok, false);
  assert.equal(matchFile({ name: 'a.mp4', size: 99 }, src).sizeOk, false);
});
import { parseSignal, buildPeerOptions } from '../net.js';
test('parseSignal / buildPeerOptions', () => {
  assert.deepEqual(parseSignal('localhost:9000'), { host: 'localhost', port: 9000, path: '/', secure: false });
  assert.equal(parseSignal('peer.example.com:443').secure, true);
  assert.equal(parseSignal(''), null);
  const o = buildPeerOptions('localhost:9000', { url: 'turn:t.example:3478', username: 'u', credential: 'c' });
  assert.equal(o.host, 'localhost'); assert.equal(o.config.iceServers.length, 3);
  assert.equal(o.config.iceServers[0].urls, 'stun:stun.l.google.com:19302');
  assert.equal(buildPeerOptions('', {}).host, undefined);
});
