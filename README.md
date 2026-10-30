# FreeMessenger

**Free texting, voice calls and video calls in any web browser. Your username is your phone number.**

### 👉 [Open FreeMessenger](https://a-hackers-guide.github.io/FreeMessenger/)

No app to install. No email, phone number or password. Works on phones, tablets and computers.

---

## How to use it

1. **Open the site** and pick a username, like `@sam`.
2. **Download your backup file** when it asks. You'll need it to sign in on another device. ([Why?](#what-is-the-backup-file))
3. **Type a friend's username** in the box and start chatting. Tap 📞 for a voice call or 🎥 for a video call.

Your friend does the same thing in their own browser. That's it.

**Invite a friend with a link:** open the **⋯** menu and choose **Share my link**. It looks like `https://a-hackers-guide.github.io/FreeMessenger/#sam`. Anyone who opens it can sign up and lands right in a chat with you.

---

## Questions

### Is it really free?
Yes. There are no ads, subscriptions or paid features. It runs on the free tiers of GitHub Pages and Cloudflare.

### Is it private?
Messages and call setup are **end-to-end encrypted**. They're scrambled in your browser before they're sent, and only your friend's browser can unscramble them. The relay server that passes messages along can't read them.

To double-check, open a chat and tap **Verify encryption**. You'll see a 12-digit code. Compare it with your friend in person or on a call. If the codes match, nobody is listening in.

Voice and video go directly between your browser and your friend's whenever possible.

### What is the backup file?
Your account isn't stored on a server. It lives in your browser as a pair of secret keys. The backup file is a copy of those keys.

Use it to:
- sign in on a new phone or computer (choose **Restore from a backup file** on the welcome screen)
- get your account back after clearing your browser data

> ⚠️ **Keep it safe and don't share it.** Anyone with the file can use your account. If you lose both your browser data and the backup file, **the account can't be recovered**. No one can reset it, not even us.

### Where are my messages saved?
In your browser on your device. Messages sent while you're offline wait on the relay, still encrypted, for up to 30 days. Once your browser receives them, they're deleted from the relay.

Restoring a backup on a new device brings back your **account**, not your old chat history.

### Will I get notified about new messages?
Only while FreeMessenger is open in a tab. Choose **⋯ → Turn on notifications** to get alerts when that tab is in the background. Notifications with the site fully closed aren't supported yet.

### A call won't connect. What can I do?
- Allow the camera and microphone when your browser asks.
- Both people need to have FreeMessenger open. You can't call someone who's offline.
- Some strict networks (work, school, some mobile carriers) block direct calls. Try another Wi-Fi or mobile data.

### What usernames can I pick?
3 to 20 characters using `a–z`, `0–9` and `_`. Names are first come, first served, and once taken they can't be changed or released.

### Can I use it on more than one device?
Yes. Restore your backup file on each device. Each device keeps its own chat history, and messages that arrive while a device is offline may only show up on whichever device was online to receive them.

---

## Limits

| | |
|---|---|
| Message length | 8,000 characters |
| Messages waiting while you're offline | Up to 500, kept for 30 days |
| Group chats, photos and files | Not yet |
| Phone (SMS/calling real numbers) | Not yet (see roadmap) |

---

## Roadmap

1. ✅ Browser-to-browser texting, voice and video calls
2. Installable app with notifications even when the site is closed
3. Apps for Windows, macOS, Linux, Android and iOS
4. Optional **broadcaster** app: send texts and make calls through your own phone line (Android phone, USB cell modem or SIP/VoIP), with plugins for different hardware

---

## For developers

<details>
<summary><strong>How it works</strong></summary>

| Part | Folder | Runs on |
|---|---|---|
| Web app (plain HTML, CSS and JavaScript, no build step, no dependencies) | [`client/`](client/) | GitHub Pages |
| Relay: username directory, sign-in check, message passing, offline inbox | [`relay/`](relay/) | Cloudflare Workers + Durable Objects (free plan) |

- **Accounts:** each browser makes an ECDSA P-256 key pair (proves who you are to the relay) and an ECDH P-256 key pair (encryption). The relay stores only the public halves, one Durable Object per username.
- **Sign-in:** when you connect, the relay sends a random challenge, and your browser signs it.
- **Messages:** encrypted with AES-256-GCM using a key both people derive from ECDH. The relay sets the sender's name itself, so nobody can pretend to be someone else.
- **Calls:** WebRTC. The relay only passes the encrypted call setup between the two browsers.
- **Code:** [`client/crypto.js`](client/crypto.js), [`client/app.js`](client/app.js), [`relay/src/index.js`](relay/src/index.js).

</details>

<details>
<summary><strong>Run it on your computer</strong></summary>

Needs Node.js and Python 3.

```bash
cd relay && npm install && npx wrangler dev
```

In a second terminal:

```bash
cd client && python3 -m http.server 8080
```

Open `http://localhost:8080` in one browser and `http://127.0.0.1:8080` in another. They count as two separate people.

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
- Offline messages are capped and expire, so storage can't grow forever.
- Keep-alive pings are answered without waking the relay, which keeps usage inside the free tier.

</details>
