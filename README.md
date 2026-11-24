# Remote Theatre

Watch videos in sync and share your screen with friends who are far away.
One link. No install, no account, and no server that touches your media.

It is a static web page. Playback sync, chat and screen video go directly between browsers
(WebRTC through [PeerJS](https://peerjs.com)). A public PeerJS broker only does the first handshake.

## What it does

- **Sync playback.** Play, pause and seek are shared. Everybody starts at the same instant.
- **Sources.** YouTube links, direct video links (`.mp4`, `.webm`, `.mov`), HLS (`.m3u8`), or a local file that each person opens on their own device.
- **Screen share.** Anyone can share a screen or tab (with tab audio). Use it for sites that cannot be embedded.
- **Side panel.** People list with ping and drift, text chat, emoji reactions.
- **Host-only controls.** The host can lock play/pause/seek/change-video.

## How to use

1. Open the site. Type your name. Paste a video link and press **Create room**.
   (Or **Start with screen share only**, or **Local file…**.)
2. Press **Copy link** (or **Share…** on a phone) and send the room link to your friends.
3. Friends open the link, type a name and press **Join room**. They tap **Tap to join playback** once, so the browser allows sound.
4. Anyone can press play, pause or seek. Anyone can paste a new link under the player (**Change video**).
5. **Share screen** replaces the player with your screen for everyone. Press **Stop sharing** to go back.

For a **local file**: each person picks the same file when asked. The app compares file name and size and warns if they differ.

### Test or self-host the signalling broker

Add `?signal=host:port` to the page URL. Example: `https://you.github.io/remote-theatre/?signal=localhost:9000`.
The option is kept in room links. The connection is not encrypted (plain `ws://`) for `localhost`, and secure (`wss://`) for all other hosts.
Run a broker with `npx peerjs --port 9000 --path /` (package `peer`).

## Run locally

No build step. Serve the folder with any static server:

```sh
python -m http.server 8080      # then open http://localhost:8080
```

Use `localhost` or HTTPS: screen share and clipboard need a secure context.

## Tests

```sh
node --test test/            # unit tests for the sync math (sync.js) and URL parsing
node test/e2e.mjs            # end-to-end: 3 headless Chrome pages, local PeerJS broker
```

`npm test` runs the unit tests too. The e2e test needs Chrome, ffmpeg, and these packages installed **outside** the app folder
(default `/home/claude/rt-test`, override with `RT_TEST_DIR`): `peer`, `peerjs@1.5.5`, `hls.js`, `puppeteer-core`.
It serves the pinned PeerJS and hls.js files from there, so it works without access to the CDNs.

## Deploy

All three options serve the folder as it is. Upload `index.html`, `styles.css`, `app.js`, `net.js`, `sync.js` and `players.js`.
The `test/` folder, `package.json` and this README are not needed.

### GitHub Pages
1. Create a repository and push these files to the `main` branch.
2. Open **Settings → Pages**. Set **Source** to **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. After a minute the site is at `https://<user>.github.io/<repo>/`.

### Netlify Drop (no Git)
1. Open <https://app.netlify.com/drop>.
2. Drag the `remote-theatre` folder onto the page.
3. Netlify gives you a public HTTPS URL at once.

### Cloudflare Pages
1. In the Cloudflare dashboard open **Workers & Pages → Create → Pages**.
2. Choose **Upload assets** (or connect the Git repository).
3. Set no build command. Set the output directory to the folder root. Deploy.

The site must be served over **HTTPS** (all three do this) for screen share and copy-to-clipboard.

## Add a TURN server

Most friends connect with STUN only (defaults: `stun:stun.l.google.com:19302` and `stun:stun.cloudflare.com:3478`).
Some strict NATs and mobile networks need a relay.

1. Get TURN credentials (for example from Cloudflare Calls, Metered, Twilio, or your own [coturn](https://github.com/coturn/coturn)).
2. In the app press **Settings**. Fill in **TURN URL** (for example `turn:turn.example.com:3478`), **Username** and **Credential**. Press **Save**.
3. Do this on every device that fails to connect. The values are stored only in that browser (`localStorage`) and apply to the next room you create or join.

## Known limits

- Without TURN, about 10–15 % of peer pairs behind strict NAT may fail to connect. Add TURN credentials in Settings.
- Screen share upload grows with each viewer (the sharer sends one stream per viewer). Good for up to 6 viewers.
- DRM sites (Netflix, Disney+) show black in screen share in Chrome and Safari. They cannot be embedded either.
- The room exists only while the host's tab is open. If the host closes the tab, guests see "Host left". A guest who drops reconnects for 30 s.
- Star topology: the host relays chat and state. Best for 2–8 friends.
- YouTube: sync uses seeks (no speed nudging). Ads on a viewer's side can desync that viewer until the ad ends.
- The public PeerJS broker (`0.peerjs.com`) is a free shared service with no uptime promise. Use `?signal=` to point to your own.
- Browser autoplay rules: each guest must tap **Tap to join playback** once. If the browser refuses sound, the video starts muted and an **Unmute** button appears.
- Local file mode needs each person to have the same file. Some formats (for example `.mkv`) do not play in every browser.
