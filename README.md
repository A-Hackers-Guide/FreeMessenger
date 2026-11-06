# FreeMessenger

[![Download FreeMessenger](https://img.shields.io/sourceforge/dt/ahg-freemessenger.svg?label=SourceForge%20downloads)](https://sourceforge.net/projects/ahg-freemessenger/files/latest/download) [![Download FreeMessenger](https://a.fsdn.com/con/app/sf-download-button)](https://sourceforge.net/projects/ahg-freemessenger/files/latest/download)


**Free texting, voice calls and video calls in any web browser. Your username works like a phone number.**

### 👉 [Open FreeMessenger](https://a-hackers-guide.github.io/FreeMessenger/)

No app to install (but you can). No email, phone number or password. Works on phones, tablets and computers.

### 📲 Get the app

| Device | How |
|---|---|
| **Android** | [Download FreeMessenger.apk](https://github.com/A-Hackers-Guide/FreeMessenger/releases/latest/download/FreeMessenger.apk) and open it (allow installing from your browser if asked). Or in Chrome: ⋮ → **Install app**. |
| **iPhone / iPad** | Open the site in Safari → **Share** → **Add to Home Screen**. Open it from your home screen to get notifications. |
| **Mac** | Safari: **File → Add to Dock**. Chrome or Edge: the install icon in the address bar. |
| **Windows / Linux / ChromeOS** | Chrome or Edge: the install icon in the address bar. |

Every version is the same app and updates itself. In the app: ⋯ → **Get the app**.

---

## How to use it

1. **Open the site** and pick a username, like `@sam`.
2. **Download your backup file** when it asks. You'll need it to sign in on another device. ([Why?](#what-is-the-backup-file))
3. **Type a friend's username** in the box and start chatting. Tap 📞 for a voice call or 🎥 for a video call.

Your friend does the same thing in their own browser. That's it.

### What you can do

| | |
|---|---|
| 💬 **Chat** | Texts, replies, emoji reactions, editing and deleting (for everyone), "typing…", and Sent / Delivered / Read |
| 📊 **Polls, pins and stars** | Polls (one or several answers), pin a message for everyone at the top of a chat, star messages to find later (⋯ → **Starred messages**), and forward anything to other chats |
| 😊 **Emoji and stickers** | An emoji picker, animated stickers, and your own stickers made from pictures |
| 🔗 **Link previews** | Title, description and picture for links, fetched once by the server so the people you send it to never contact the site |
| ⏰ **Scheduled messages** | Write now, send later. The server sends it at that time even if your device is off. |
| 📷 **Share** | Photos, videos, voice messages and any file up to 10 MB. Paste or drag them into a chat. |
| 👥 **Groups** | Up to 256 people. Group admins rename, add and remove people and make other admins, and can share an invite link that adds people automatically. |
| 📞 **Call** | Voice and video calls, **group calls up to 8 people**, screen sharing, front/back camera switching, and a call history (⋯ → **Call history**) |
| 💻 **All your devices** | Use your account on several devices: what you send on one shows up on the others, and each catches up on what it missed. |
| ✏️ **Change your username** | Once a month (Settings). Your old name keeps leading to you and can't be taken by anyone else. |
| ⏱ **Disappearing messages** | Messages delete themselves after 1 hour, 1 day, 1 week or 30 days |
| 🔔 **Notifications** | Even when the site is closed (on iPhone and iPad, install the app first) |
| 📲 **Install it** | ⋯ → **Install app** puts it on your home screen or desktop. It opens even when you're offline. |
| 🙂 **Profiles** | A profile picture, display name, real name, status and "about" text (⋯ → **My profile**). Tap someone's name in a chat to see theirs. |
| 🔎 **Find things** | Search all chats, or one chat. Renaming a chat (just for you), mute, block and clear history are in each chat's ⋮ menu. |
| 🎨 **Make it yours** | Ready-made themes, an accent color, fonts, bubble shapes and colors, and a color, gradient or picture for each bar. Every chat can have its own background and one of 15 animations (aurora, bubbles, stars, snow, hearts, waves, rain, confetti, fireflies, petals, balloons, sparkles, lava lamp, matrix, northern lights). Plus light or dark mode, four text sizes, what Enter does, and read receipts or typing on or off. |
| 🗂 **Your history anywhere** | Messages are kept on the server, so a new browser can download your old chats (Settings → **Get my old messages**). |
| ✍️ **Formatting** | **bold**, _italic_, ~strike~, `code`, ||spoilers||, and @mentions that reach you even in muted groups |
| 🗂 **Organize** | Pin chats to the top, archive them, mark as unread, drafts kept per chat, and ⭐ **Saved messages** for notes to yourself |
| 🎆 **Send effects** | Long-press or right-click **Send**: send silently, or with confetti, fireworks, hearts, balloons, lasers, snow or a shake |
| 👀 **More** | View-once photos, location sharing, voice messages at 1.5× and 2×, "recording…" indicator, each chat's photos, files and links in one place, reply privately from a group, announcement-only groups |
| 🔒 **Privacy** | Online and last seen (turn it off and you can't see others'), an app lock PIN, and Do Not Disturb hours |
| 🚩 **Report** | Tap a message → **Report to admin** if something's wrong. |
| 🌐 **Web viewer** | For people the admin allows: open links through the server in a safe viewer with scripts turned off. |

Tap any message for its options (react, reply, copy, edit, delete).

**Invite a friend with a link:** open the **⋯** menu and choose **Share my link**. It looks like `https://a-hackers-guide.github.io/FreeMessenger/#sam`. Anyone who opens it can sign up and lands right in a chat with you.

---

## Questions

### Is it really free?
Yes. There are no ads, subscriptions or paid features. It runs on the free tiers of GitHub Pages and Cloudflare.

### Is it private?
Partly, and here's exactly how:

- Messages are **encrypted in your browser** before they're sent. The servers that pass them along can't read them.
- **But the site's admin can.** Every saved message also carries an "admin copy", encrypted for the admin, so they can check for illegal content in the admin panel. You're told this when you sign up.
- The admin can also see account details (username, profile, when you joined and were last online) and **IP addresses**, and can freeze, time out, ban or remove accounts.
- Typing indicators and call audio and video are never saved. Voice and video go directly between your browser and your friend's whenever possible.

**Verify encryption** in a chat shows a 12-digit code. If it matches your friend's, nobody swapped keys between you. It doesn't stop the admin copy.

### What is the backup file?
Your account isn't stored on a server. It lives in your browser as a pair of secret keys. The backup file is a copy of those keys.

Use it to:
- sign in on a new phone or computer (choose **Restore from a backup file** on the welcome screen)
- get your account back after clearing your browser data

> ⚠️ **Keep it safe and don't share it.** Anyone with the file can use your account. If you lose both your browser data and the backup file, **the account can't be recovered**. No one can reset it, not even us.

### Where are my messages saved?
In your browser, and on the main server, which keeps every message (encrypted) with no limit except its disk space. On a new device, restore your backup, then use **Settings → Get my old messages** to download your texts. Photos and files aren't downloaded again.

The main server runs on the site owner's computer. When it's off, a backup server on Cloudflare takes over and holds messages for up to 30 days, and the two copy everything to each other when the main one comes back.

### Will I get notified about new messages?
Yes, even when FreeMessenger is closed. Go to **⋯ → Settings → Notifications** and allow them. On iPhone and iPad, first install the app (Share → Add to Home Screen) and turn them on from there; Apple only allows notifications for installed web apps.

Notifications only say who wrote to you. The message itself stays encrypted until FreeMessenger opens and unscrambles it.

### A call won't connect. What can I do?
- Allow the camera and microphone when your browser asks.
- Both people need to have FreeMessenger open. You can't call someone who's offline.
- Some strict networks (work, school, some mobile carriers) block direct calls. Try another Wi-Fi or mobile data.
- Group calls work best with a few people: each person sends their audio and video to everyone else.

### Which browsers and networks does it work on?
Texting works in any browser from about 2017 on (Chrome, Firefox, Safari, Edge, Samsung Internet, Opera, Brave and others), including:
- networks that block WebSockets, like many school, work and hotel Wi-Fi networks, proxies and VPN apps. FreeMessenger notices and switches to ordinary web requests. The green dot's tooltip says "compatibility mode" when that happens.
- pages opened through a web proxy or a plain `http://` address. Encryption still works there with a built-in library, and invite links still point at the real site.

Calls need a browser that supports WebRTC and an address that starts with `https://`. Tor Browser turns WebRTC off, so it can text but not call.

### What usernames can I pick?
3 to 20 characters using `a–z`, `0–9` and `_`. Names are first come, first served, and once taken they can't be changed. They only become free again if the admin removes the account.

### Can I use it on more than one device?
Yes. Restore your backup file on each device. Each device keeps its own chat history, and messages that arrive while a device is offline may only show up on whichever device was online to receive them.

---

## Limits

| | |
|---|---|
| Message length | 8,000 characters |
| Photos, videos, voice messages and files | Up to 10 MB each (photos are made smaller automatically) |
| Group size | 256 people |
| How often you can send | 1 message a second (a few quick ones in a row are fine; the app waits and sends the rest by itself) |
| Saved messages | No limit while the main server is on. On the backup server: up to 5,000 waiting per person, for 30 days. |
| Group calls | Up to 8 people (everyone sends to everyone, so it needs decent upload speed) |
| Phone (SMS/calling real numbers) | Not yet (see roadmap) |

---

## Roadmap

1. ✅ Browser-to-browser texting, voice and video calls
2. ✅ Works through proxies and filters, and in older browsers
3. ✅ Photos, files, voice messages, groups, reactions, replies, read receipts, disappearing messages
4. ✅ Installable app with notifications even when the site is closed
5. ✅ Profiles, themes, chat backgrounds and animations, server-side history, web viewer, admin panel
6. ✅ Group calls, group admins and invite links, device sync, username changes
7. ✅ Android app (APK), and installable on iPhone, iPad, Mac, Windows, Linux and ChromeOS
8. Optional **broadcaster** app: send texts and make calls through your own phone line (Android phone, USB cell modem or SIP/VoIP), with plugins for different hardware

---

## For developers

<details>
<summary><strong>How it works</strong></summary>

| Part | Folder | Runs on |
|---|---|---|
| Web app (plain HTML, CSS and JavaScript; the Deploy workflow bundles it for older browsers) | [`client/`](client/) | GitHub Pages |
| Main relay: accounts, message passing, every message saved in SQLite, admin panel, web viewer, TURN logins | [`server/`](server/) | The owner's PC (Node.js), reached through a free Cloudflare quick tunnel |
| Backup relay: the same protocol, takes over when the main relay is off | [`relay/`](relay/) | Cloudflare Workers + Durable Objects (free plan) |

- **Accounts:** each browser makes an ECDSA P-256 key pair (proves who you are to the relay) and an ECDH P-256 key pair (encryption). The relay stores only the public halves, one Durable Object per username.
- **Sign-in:** when you connect, the relay sends a random challenge, and your browser signs it.
- **Connection:** a WebSocket. If one isn't signed in within 8 seconds, or fails twice, the app switches to `POST /api/http/:name` requests (`text/plain`, so there's no CORS preflight) that poll every 1 to 15 seconds and work through almost any proxy. See [`client/transport.js`](client/transport.js).
- **Browsers without WebCrypto** (plain `http://` pages, some older browsers) load [`@noble/curves`](https://github.com/paulmillr/noble-curves) and [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) instead. They produce the same keys, signatures and ciphertext, so both kinds of browser can talk to each other.
- **Messages:** encrypted with AES-256-GCM using a key both people derive from ECDH. The relay sets the sender's name itself, so nobody can pretend to be someone else.
- **Admin copy:** each saved message is also encrypted with ECDH between the sender and the admin account's public key (`/api/admin-key`). The main relay stores it; the admin panel ([`client/admin.js`](client/admin.js)) decrypts it in the admin's browser.
- **Two relays:** the app asks the backup relay where the main one is (`/api/primary`, since the quick-tunnel address changes on restart) and uses it if it answers. Every 30 seconds the main relay calls the backup's `/api/sync`, signed with a key only the main relay has (`PRIMARY_KEY` in `wrangler.toml` is the public half). The sync copies accounts, profiles, moderation, push subscriptions and messages both ways.
- **Send limit:** 1 chat message a second per person (a burst of 5), counted once per message even in groups. File pieces, receipts and typing have a much larger allowance.
- **Web viewer:** [`server/proxy.js`](server/proxy.js) fetches pages for allowed accounts, refuses private and local network addresses (checked on the address it actually connects to), strips scripts, frames and event handlers, routes links and pictures back through itself, and serves everything with a `sandbox` Content-Security-Policy.
- **Calls:** WebRTC. The relay only passes the encrypted call setup between the two browsers.
- **Files:** split into 32 KB pieces, each encrypted like a message ([`client/files.js`](client/files.js)). Pieces are acknowledged only once the whole file has arrived, so a reload resumes the transfer.
- **Groups:** no server-side groups. The sender encrypts a copy for each member, and group changes (create, rename, add, leave) are messages too.
- **Notifications:** standard Web Push. The relay makes its own VAPID key on first use and stores it, so there's nothing to configure. Push messages are encrypted for the browser (RFC 8291) and say only who wrote, plus whether it was a message or a missed call.
- **Code:** [`client/crypto.js`](client/crypto.js), [`client/transport.js`](client/transport.js), [`client/app.js`](client/app.js), [`relay/src/index.js`](relay/src/index.js).

</details>

<details>
<summary><strong>Run it on your computer</strong></summary>

Needs Node.js and Python 3.

```bash
cd relay && npm install && npx wrangler dev
```

In a second terminal:

```bash
cd client && npm install && npm run build && python3 -m http.server 8080
```

Run `npm run build` again after changing the client's code.

Open `http://localhost:8080` in one browser and `http://127.0.0.1:8080` in another. They count as two separate people.

</details>

<details>
<summary><strong>Run the main relay on your own PC</strong></summary>

Needs Node.js 22.13 or newer and, for the TURN server, Docker Desktop. On Windows, one command does everything (copies the relay, makes its keys, starts the TURN server and sets the relay to start when you sign in):

```powershell
powershell -ExecutionPolicy Bypass -File server\install.ps1 -Admin yourname
```

Then put the `PRIMARY_KEY=…` line it prints into `relay/wrangler.toml` under `[vars]` and redeploy the backup relay.

**Admin tools:** accounts (approve, freeze, time out, ban, remove, storage limits), reports, word alerts (checked in the admin's browser after decrypting), announcements to everyone, sign-up modes (open, approval, invite codes, closed), and nightly database backups at 3 AM to `-BackupFolder` (default `H:\FreeMessenger-backups`, last 14 kept).

**Admin access** is tied to the admin account's own key (pinned in `config.json` the first time the relay sees that account). On top of that, only **trusted browsers** open the admin panel directly: each keeps a device key it can't export, and proves itself by signing the connection's challenge. The first browser is trusted with a one-time setup code the relay writes to `data\device-setup-code.txt`. Any other browser needs the 6-digit code shown on a trusted browser (Admin panel → **Devices & codes**), and can be trusted from there. Five wrong codes lock the panel for 15 minutes, and each code works once.

On other systems: `cd server && npm ci && node setup.mjs data --admin yourname --cloudflared "$(which cloudflared)" && node server.js data`.

</details>

<details>
<summary><strong>Build the Android app</strong></summary>

[`android/`](android/) is a Trusted Web Activity: the site running full-screen in the phone's browser engine, with a WebView fallback. It needs JDK 17+ and the Android SDK.

```bash
cd android
FM_KEYSTORE=/path/to/release.jks FM_KEYSTORE_PASSWORD=... ./gradlew assembleRelease
```

The signing key stays outside the repo. Its SHA-256 fingerprint is published at `https://a-hackers-guide.github.io/.well-known/assetlinks.json`, which is what lets the app hide the browser bar. Updates must be signed with the same key.

</details>

<details>
<summary><strong>Host your own copy</strong></summary>

1. Fork this repo.
2. Deploy the relay to your free Cloudflare account:
   ```bash
   cd relay && npm install && npx wrangler login && npx wrangler deploy
   ```
   Copy the `https://….workers.dev` address it prints.
3. In your fork, go to **Settings → Secrets and variables → Actions → Variables** and add `RELAY_URL` with that address.
4. In **Settings → Pages**, set **Source** to **GitHub Actions**.
5. Push to `main`. The [Deploy workflow](.github/workflows/deploy.yml) publishes the site.

Optional:
- Add a `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secret and pushes will redeploy the relay too.
- For calls through strict firewalls, set up Cloudflare TURN: `npx wrangler secret put TURN_KEY_ID` and `npx wrangler secret put TURN_KEY_API_TOKEN`. TURN usage beyond Cloudflare's free allowance is billed.

</details>

<details>
<summary><strong>Built to need no maintenance</strong></summary>

- The web app has zero libraries, so there's nothing to update.
- The relay is pinned to a fixed Cloudflare compatibility date, which Cloudflare keeps working.
- On the backup relay, offline messages are capped and expire. The main relay has a storage cap (100 GB by default) and removes the oldest file pieces first when it's nearly full.
- Keep-alive pings are answered without waking the relay, which keeps usage inside the free tier.

</details>
