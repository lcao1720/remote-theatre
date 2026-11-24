// End-to-end test: local PeerJS server + static server + headless Chrome, 3 pages.
//   RT_TEST_DIR (default /home/claude/rt-test) must contain node_modules with
//   `peer`, `peerjs@1.5.5`, `hls.js` and `puppeteer-core` (kept out of the app folder).
// Run: node test/e2e.mjs
// Skip when picked up by `node --test test/` (older Node scans every file in the folder).
if (process.env.NODE_TEST_CONTEXT && !process.env.RT_E2E) { console.log('e2e skipped under node --test; run: node test/e2e.mjs'); process.exit(0); }
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RT = process.env.RT_TEST_DIR || '/home/claude/rt-test';
const require = createRequire(path.join(RT, 'package.json'));
const puppeteer = require('puppeteer-core');
const { PeerServer } = require('peer');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const MEDIA = path.join(RT, 'media');
const HTTP_PORT = 8080, PEER_PORT = 9000;

// ------------------------------------------------------------ fixtures
fs.mkdirSync(MEDIA, { recursive: true });
function makeVideo(name, secs, freq, vcodec) {
  const out = path.join(MEDIA, name);
  if (fs.existsSync(out)) return out;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${secs}:size=640x360:rate=25`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`, ...vcodec, '-g', '25', '-shortest', '-movflags', '+faststart', out]);
  return out;
}
const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
const VP8 = ['-c:v', 'libvpx', '-b:v', '600k', '-c:a', 'libvorbis'];
makeVideo('test60.mp4', 60, 440, H264);
makeVideo('test60.webm', 60, 440, VP8);
makeVideo('other20.mp4', 20, 880, H264);

// Static server with Range support (needed for seeking), serving the app plus /media/.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const web = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = u.startsWith('/media/') ? path.join(MEDIA, u.slice(7)) : path.join(APP, u === '/' ? 'index.html' : u);
  if (!file.startsWith(APP) && !file.startsWith(MEDIA) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  const size = fs.statSync(file).size, type = MIME[path.extname(file)] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const s = m[1] ? +m[1] : 0, e = m[2] ? +m[2] : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1 });
    fs.createReadStream(file, { start: s, end: e }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }
}).listen(HTTP_PORT, '127.0.0.1');
const peerServer = PeerServer({ port: PEER_PORT, path: '/', host: '127.0.0.1' });

// ------------------------------------------------------------ harness
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); rows.push({ name, ok: true, detail: detail || '' }); }
  catch (e) { rows.push({ name, ok: false, detail: String(e.message || e).replace(/\s+/g, ' ').slice(0, 200) }); }
  const r = rows.at(-1);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name}  ${r.detail}  (${Date.now() - t0} ms)`);
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 60000,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire',
    '--enable-usermedia-screen-capturing', '--allow-http-screen-capture',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--allow-loopback-in-peer-connection', '--enable-features=WebRtcHideLocalIpsWithMdns:false',
    '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

// CDN files are unreachable in the sandbox: serve the pinned local copies instead.
async function newPage(label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  // Input events need the tab in front (otherwise puppeteer's click/type can hang).
  for (const m of ['click', 'type']) { const o = page[m].bind(page); page[m] = async (...a) => { await page.bringToFront(); return o(...a); }; }
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('https://unpkg.com/peerjs@1.5.5/')) return r.respond({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(RT, 'node_modules/peerjs/dist/peerjs.min.js')) });
    if (u.includes('hls.js')) return r.respond({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(RT, 'node_modules/hls.js/dist/hls.min.js')) });
    if (u.startsWith('https://fonts.')) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    if (!u.startsWith('http://localhost') && !u.startsWith('data:') && !u.startsWith('blob:')) return r.abort();
    r.continue();
  });
  page.on('pageerror', (e) => console.log(`[${label}] pageerror:`, e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${label}] console.error:`, m.text()); });
  return page;
}
const base = `http://localhost:${HTTP_PORT}/?signal=localhost:${PEER_PORT}`;
const vid = (p) => p.evaluate(() => { const v = document.querySelector('#player-host video'); return v ? { t: v.currentTime, w: performance.timeOrigin + performance.now(), paused: v.paused, src: v.currentSrc } : null; });
/** Position difference in ms between two pages, normalised to the same wall-clock instant. */
async function skewMs(a, b) {
  const [x, y] = await Promise.all([vid(a), vid(b)]);
  const W = Math.max(x.w, y.w);
  return Math.abs((x.t + (W - x.w) / 1000) - (y.t + (W - y.w) / 1000)) * 1000;
}
const waitFn = (p, fn, arg, timeout = 15000) => p.waitForFunction(fn, { timeout, polling: 100 }, arg);
async function joinAs(page, link, name) {
  await page.goto(link);
  await page.$eval('#join-name', (e) => { e.value = ''; });   // name is prefilled from localStorage
  await page.type('#join-name', name);
  await page.click('#btn-join');
  await waitFn(page, () => !document.querySelector('#view-room').classList.contains('hidden') && document.querySelector('#status').dataset.state === 'connected');
}
const clickIf = async (page, sel) => { if (await page.$eval(sel, (e) => !e.closest('.hidden') && !e.classList.contains('hidden') && e.offsetParent !== null).catch(() => false)) await page.click(sel); };

let host, guest, late, link, VIDEO_URL;
try {
  host = await newPage('host'); guest = await newPage('guest');
  // Pick a playable format (Chrome for Testing may lack H.264).
  await host.goto(base);
  const h264 = await host.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'));
  const ext = h264 ? 'mp4' : 'webm';
  VIDEO_URL = `http://localhost:${HTTP_PORT}/media/test60.${ext}`;
  console.log('using video', VIDEO_URL, '(h264:', h264 || 'no', ')');

  await check('Host creates room (link has ?r= and ?signal=)', async () => {
    await host.type('#landing-name', 'Hosty');
    await host.type('#landing-url', VIDEO_URL);
    await host.click('#btn-create');
    await waitFn(host, () => document.querySelector('#invite-link').value.includes('?'));
    link = await host.$eval('#invite-link', (e) => e.value);
    must(/[?&]r=[a-z0-9]{6}(&|$)/.test(link), 'bad room link ' + link);
    must(link.includes('signal=localhost%3A9000') || link.includes('signal=localhost:9000'), 'signal not preserved: ' + link);
    const id = await host.evaluate(() => window.__rt.S.room.peer.id);
    must(/^rt-[a-z0-9]{6}$/.test(id), 'peer id ' + id);
    return link;
  });

  await check('Host video loads and Copy button works', async () => {
    await waitFn(host, () => { const v = document.querySelector('#player-host video'); return v && v.readyState >= 1; });
    await host.click('#btn-copy');
    await waitFn(host, () => [...document.querySelectorAll('.toast')].some((t) => /copied|Ctrl/.test(t.textContent)));
  });

  await check('Guest opens link, joins, connects', async () => {
    await joinAs(guest, link, 'Gina');
    await waitFn(host, () => window.__rt.S.room.roster.length === 2);
    await waitFn(guest, () => document.querySelectorAll('#people li').length === 2);
    await waitFn(guest, () => { const v = document.querySelector('#player-host video'); return v && v.readyState >= 1; });
    const off = await guest.evaluate(() => window.__rt.S.room.offset);
    const rtt = await guest.evaluate(() => window.__rt.S.room.rtt);
    must(Math.abs(off) < 30, 'clock offset on same machine should be ~0, got ' + off);
    return `offset ${off.toFixed(2)} ms, rtt ${rtt.toFixed(1)} ms`;
  });

  await check('Guest sees "Tap to join playback" overlay and can dismiss it', async () => {
    await waitFn(guest, () => !document.querySelector('#overlay').classList.contains('hidden'));
    await guest.click('#btn-tap');
    await waitFn(guest, () => document.querySelector('#overlay').classList.contains('hidden'));
  });

  await check('Host plays -> both playing within 150 ms after 3 s', async () => {
    await host.click('#btn-play');
    await waitFn(guest, () => { const v = document.querySelector('#player-host video'); return v && !v.paused; });
    await sleep(3000);
    const [a, b] = await Promise.all([vid(host), vid(guest)]);
    must(!a.paused && !b.paused, 'not both playing');
    must(a.t > 2.0, 'host did not advance: ' + a.t);
    const d = await skewMs(host, guest);
    must(d < 150, `skew ${d.toFixed(0)} ms`);
    return `skew ${d.toFixed(0)} ms`;
  });

  await check('Skew stays < 150 ms after another 6 s (drift loop)', async () => {
    let worst = 0;
    for (let i = 0; i < 6; i++) { await sleep(1000); worst = Math.max(worst, await skewMs(host, guest)); }
    must(worst < 150, `worst skew ${worst.toFixed(0)} ms`);
    const gd = await guest.evaluate(() => window.__rt.S.room.myDrift);
    must(Math.abs(gd) < 80, 'guest self-reported drift ' + gd);
    return `worst ${worst.toFixed(0)} ms, guest-reported drift ${gd.toFixed(0)} ms`;
  });

  await check('Guest pauses -> host paused', async () => {
    await guest.click('#btn-play');
    await waitFn(host, () => document.querySelector('#player-host video').paused, null, 5000);
    await waitFn(guest, () => document.querySelector('#player-host video').paused, null, 5000);
    await sleep(600);
    const d = await skewMs(host, guest);
    must(d < 100, 'paused positions differ by ' + d.toFixed(0));
    return `paused skew ${d.toFixed(0)} ms`;
  });

  await check('Host seeks to 30 s -> guest within 0.3 s', async () => {
    await host.$eval('#seek', (s) => { s.value = 30; s.dispatchEvent(new Event('change')); });
    await waitFn(guest, () => Math.abs(document.querySelector('#player-host video').currentTime - 30) < 0.3, null, 6000);
    const g = (await vid(guest)).t;
    return `guest at ${g.toFixed(2)}`;
  });

  await check('Play after seek stays in sync (guest-initiated play)', async () => {
    await guest.click('#btn-play');
    await waitFn(host, () => !document.querySelector('#player-host video').paused, null, 5000);
    await sleep(3000);
    const d = await skewMs(host, guest);
    const t = (await vid(host)).t;
    must(t > 32.5 && t < 36, 'host pos ' + t);
    must(d < 150, `skew ${d.toFixed(0)} ms`);
    return `skew ${d.toFixed(0)} ms at ${t.toFixed(1)} s`;
  });

  await check('Seek while playing (guest -> 10 s) re-syncs everyone', async () => {
    await guest.$eval('#seek', (s) => { s.value = 10; s.dispatchEvent(new Event('change')); });
    await sleep(2500);
    const t = (await vid(host)).t, d = await skewMs(host, guest);
    must(t > 11 && t < 14, 'host pos ' + t);
    must(d < 150, `skew ${d.toFixed(0)} ms`);
    return `skew ${d.toFixed(0)} ms`;
  });

  await check('Buffering gate: guest stalls -> all pause, resume on ready', async () => {
    await guest.evaluate(() => window.__rt.S.room.reportBuffering(true));
    await waitFn(host, () => window.__rt.S.state.playing === false && window.__rt.S.state.reason === 'buffering', null, 4000);
    await waitFn(guest, () => document.querySelector('#player-host video').paused, null, 4000);
    await guest.evaluate(() => window.__rt.S.room.reportBuffering(false));
    await waitFn(host, () => window.__rt.S.state.playing === true, null, 4000);
    await waitFn(guest, () => !document.querySelector('#player-host video').paused, null, 4000);
    await sleep(1500);
    return `skew ${(await skewMs(host, guest)).toFixed(0)} ms`;
  });

  await check('Buffering gate times out after 8 s', async () => {
    await guest.evaluate(() => window.__rt.S.room.reportBuffering(true));
    await waitFn(host, () => window.__rt.S.state.reason === 'buffering', null, 3000);
    const t0 = Date.now();
    await waitFn(host, () => window.__rt.S.state.playing === true, null, 12000);
    const dt = Date.now() - t0;
    must(dt > 7000 && dt < 10500, 'resumed after ' + dt);
    await guest.evaluate(() => window.__rt.S.room.reportBuffering(false));
    return `resumed after ${dt} ms`;
  });

  await check('Chat both directions', async () => {
    await guest.type('#chat-input', 'hello from guest'); await guest.keyboard.press('Enter');
    await waitFn(host, () => document.querySelector('#chat-log').textContent.includes('hello from guest'), null, 5000);
    await host.type('#chat-input', 'hi from host'); await host.keyboard.press('Enter');
    await waitFn(guest, () => document.querySelector('#chat-log').textContent.includes('hi from host'), null, 5000);
  });

  await check('Emoji reaction floats on all pages', async () => {
    await guest.click('#emoji-bar button:nth-child(2)');
    await waitFn(host, () => document.querySelectorAll('#reactions .float').length > 0, null, 4000);
    await waitFn(guest, () => document.querySelectorAll('#reactions .float').length > 0, null, 4000);
  });

  await check('People list shows ping + drift + host badge', async () => {
    await sleep(2500);
    const txt = await guest.$eval('#people', (e) => e.innerText);
    must(/host/i.test(txt) && /Gina/.test(txt) && /Hosty/.test(txt) && /ms/.test(txt), 'roster text: ' + txt.replace(/\n/g, ' | '));
    return txt.replace(/\s+/g, ' ');
  });

  await check('Host-only controls: guest play/pause denied; host still works', async () => {
    await host.click('#host-only');
    await waitFn(guest, () => document.querySelector('#btn-play').disabled, null, 4000);
    must(await guest.$eval('#change-url', (e) => e.disabled), 'change input should be disabled');
    // Even a forged request is rejected by the host.
    await guest.evaluate(() => window.__rt.S.room.request('pause'));
    await sleep(700);
    must((await host.evaluate(() => window.__rt.S.state.playing)) === true, 'host state changed by denied request');
    await host.click('#btn-play');
    await waitFn(guest, () => document.querySelector('#player-host video').paused, null, 4000);
    await host.click('#host-only');
    await waitFn(guest, () => !document.querySelector('#btn-play').disabled, null, 4000);
  });

  await check('Change video syncs to guest', async () => {
    await guest.type('#change-url', `http://localhost:${HTTP_PORT}/media/other20.mp4`);
    await guest.keyboard.press('Enter');
    await waitFn(host, () => (document.querySelector('#player-host video')?.currentSrc || '').includes('other20'), null, 8000);
    await waitFn(guest, () => (document.querySelector('#player-host video')?.currentSrc || '').includes('other20'), null, 8000);
    await host.click('#btn-play');
    await waitFn(guest, () => { const v = document.querySelector('#player-host video'); return v && !v.paused; }, null, 5000);
    await sleep(2500);
    const d = await skewMs(host, guest);
    must(d < 150, `skew ${d.toFixed(0)} ms`);
    return `skew ${d.toFixed(0)} ms`;
  });

  await check('Late join: 3rd peer joins mid-play and syncs', async () => {
    late = await newPage('late');
    await joinAs(late, link, 'Lena');
    await waitFn(late, () => { const v = document.querySelector('#player-host video'); return v && v.readyState >= 1; });
    await late.click('#btn-tap').catch(() => {});
    await waitFn(late, () => { const v = document.querySelector('#player-host video'); return v && !v.paused; }, null, 6000);
    await sleep(3000);
    const d = await skewMs(host, late);
    must(d < 150, `skew ${d.toFixed(0)} ms`);
    return `skew ${d.toFixed(0)} ms`;
  });

  // ---- screen share
  let realShareOk = false;
  await check('Screen share (real getDisplayMedia) host -> guests', async () => {
    await host.click('#btn-screen');
    await waitFn(host, () => !!window.__rt.S.room.localStream, null, 8000);
    await waitFn(guest, () => { const v = document.querySelector('#screen-video'); return v && v.videoWidth > 0 && !v.paused; }, null, 10000);
    const w = await guest.$eval('#screen-video', (v) => `${v.videoWidth}x${v.videoHeight}`);
    realShareOk = true;
    return 'guest video ' + w;
  });
  if (!realShareOk) {
    // Headless Linux has no screen to capture: stub the capture source with a canvas stream
    // so the rest of the pipeline (PeerJS media calls, UI, stage swap) is still tested.
    await host.evaluate(() => { const s = window.__rt.S.room; if (s.localStream) s.stopShare(); });
    for (const p of [host, guest, late]) await p.evaluateOnNewDocument(() => {});
    const stub = () => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas'); c.width = 640; c.height = 360;
        const g = c.getContext('2d'); let n = 0;
        setInterval(() => { g.fillStyle = `hsl(${n++ * 7 % 360},70%,50%)`; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText('share ' + n, 40, 100); }, 33);
        return c.captureStream(30);
      };
    };
    for (const p of [host, guest, late]) await p.evaluate(stub);
  }
  await check(`Screen share${realShareOk ? '' : ' (STUBBED canvas source)'}: host -> guest + late peer, stage swaps`, async () => {
    if (realShareOk) await host.click('#btn-screen'); // stop real share first
    await sleep(500);
    await host.click('#btn-screen');
    for (const p of [guest, late]) {
      await waitFn(p, () => { const v = document.querySelector('#screen-video'); return v && v.videoWidth > 0 && !v.paused; }, null, 12000);
      must(await p.$eval('#screen-wrap', (e) => !e.classList.contains('hidden')), 'screen wrap hidden');
      must(await p.$eval('#screen-label', (e) => /Hosty is sharing/.test(e.textContent)), 'label wrong');
      must(await p.$eval('#player-host', (e) => getComputedStyle(e).visibility === 'hidden'), 'player not replaced');
    }
    const hint = await host.evaluate(() => window.__rt.S.room.localStream.getVideoTracks()[0].contentHint);
    must(hint === 'motion', 'contentHint ' + hint);
  });

  await check('Stop share cleans up on all peers', async () => {
    await host.click('#btn-screen');
    for (const p of [guest, late]) {
      await waitFn(p, () => document.querySelector('#screen-wrap').classList.contains('hidden') && !document.querySelector('#screen-video').srcObject, null, 6000);
    }
    must(await host.evaluate(() => !window.__rt.S.room.localStream && window.__rt.S.room.calls.size === 0), 'host leaked calls');
  });

  await check('Guest shares screen (mesh): host + other guest receive', async () => {
    await guest.click('#btn-screen');
    for (const p of [host, late]) {
      await waitFn(p, () => { const v = document.querySelector('#screen-video'); return v && v.videoWidth > 0; }, null, 12000);
      must(await p.$eval('#screen-label', (e) => /Gina is sharing/.test(e.textContent)), 'label wrong');
    }
    await guest.click('#btn-screen');
    await waitFn(host, () => document.querySelector('#screen-wrap').classList.contains('hidden'), null, 6000);
  });

  await check('Reconnect: guest data connection drops, auto-rejoins', async () => {
    await guest.evaluate(() => window.__rt.S.room.conn.close());
    await waitFn(guest, () => ['reconnecting', 'connected'].includes(document.querySelector('#status').dataset.state), null, 3000);
    await sleep(2500);
    await waitFn(guest, () => document.querySelector('#status').dataset.state === 'connected' && window.__rt.S.room.conn && window.__rt.S.room.conn.open, null, 25000);
    await sleep(500);
    const names = await host.evaluate(() => window.__rt.S.room.roster.map((r) => r.name).join(','));
    must(/^Hosty,Gina,Lena$|^Hosty,Lena,Gina$/.test(names), 'host roster after rejoin: ' + names);
  });

  await host.screenshot({ path: path.join(RT, 'shot-desktop.png') });
  await guest.setViewport({ width: 390, height: 844 });
  await guest.screenshot({ path: path.join(RT, 'shot-mobile.png'), fullPage: true });
  await check('Host leaves -> guests see "Host left"', async () => {
    await host.evaluate(() => window.__rt.S.room.leave());
    for (const p of [guest, late]) await waitFn(p, () => !document.querySelector('#hostleft').classList.contains('hidden'), null, 8000);
  });

  await check('Join with unknown room shows an error (no hang)', async () => {
    const p = await newPage('ghost');
    await p.goto(`http://localhost:${HTTP_PORT}/?r=zzzzzz&signal=localhost:${PEER_PORT}`);
    await p.type('#join-name', 'Nobody'); await p.click('#btn-join');
    await waitFn(p, () => /Could not find/.test(document.querySelector('#join-status').textContent), null, 25000);
  });
} catch (e) {
  console.log('HARNESS ERROR', e);
  rows.push({ name: 'harness', ok: false, detail: String(e.message) });
}

// ------------------------------------------------------------ report
console.log('\n=== E2E RESULTS ===');
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
await browser.close().catch(() => {});
web.close(); peerServer.close?.();
process.exit(failed ? 1 : 0);
