# FreeMessenger

Free texting, voice and video calls in any web browser. Your **username is your phone number**.
Open the site, pick a name, type a friend's name and you're talking. No app, email, phone number or password needed.

- **End-to-end encrypted.** Messages and call setup are encrypted in your browser. The relay only sees scrambled data.
- **Calls go browser to browser** over WebRTC.
- **Offline messages** wait up to 30 days for your friend to come online.
- **Invite links:** `https://<site>/#yourname` opens a chat with you.
- **Zero dependencies in the app.** Plain HTML, CSS and JavaScript with no build step, so there's nothing to update.

## How it's hosted

| Part | Folder | Runs on |
|---|---|---|
| Web app | `client/` | GitHub Pages |
| Relay (usernames, message passing, offline inbox) | `relay/` | Cloudflare Workers + Durable Objects, free plan |

## One-time setup

1. **Cloudflare:** create a free account. Create an API token with the **Edit Cloudflare Workers** template, and copy your **Account ID** from the dashboard.
2. **GitHub repo → Settings → Secrets and variables → Actions:** add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. **GitHub repo → Settings → Pages:** set **Source** to **GitHub Actions**.
4. Push to `main`. The **Deploy** workflow publishes the relay, points the web app at it and publishes the site.

Optional:
- **Custom relay domain:** set a repository variable `RELAY_URL`.
- **Calls through strict firewalls:** create a TURN key in Cloudflare Realtime and run `npx wrangler secret put TURN_KEY_ID` and `npx wrangler secret put TURN_KEY_API_TOKEN` in `relay/`. Without it, most calls still connect directly. TURN traffic beyond Cloudflare's free allowance is billed, so it's off by default.

## Run it on your computer

```bash
cd relay && npm install && npx wrangler dev
```

```bash
cd client && python3 -m http.server 8080
```

Open `http://localhost:8080` in two different browsers, or one normal window and one private window, and create two usernames.

## Your account

Your account is a pair of keys stored in your browser. **Download your backup file** from the menu. It's how you sign in on another browser or after clearing site data. Without it, a lost account can't be recovered. Nobody, including the relay, can reset it.

## Limits (by design)

- Usernames: 3–20 characters, `a-z 0-9 _`, first come, first served.
- Messages: up to 8,000 characters. Up to 500 waiting offline messages per user, kept 30 days.
- Notifications only appear while the tab is open.

## Roadmap

1. ✅ Browser-to-browser texting, voice and video
2. Installable app (PWA) with push notifications
3. Desktop and mobile apps wrapping the same web app
4. Broadcaster server app with phone-line plugins (Android SIM gateway, GSM modems, SIP)
