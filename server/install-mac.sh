#!/bin/sh
# Sets up FreeMessenger's home relay on a Mac as a launchd agent that macOS
# restarts by itself. Needs Node.js 22.13+ and cloudflared (brew install node cloudflared).
#   sh install-mac.sh yourname        (run it again to update; keeps your data)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
admin="$(printf %s "${1:-}" | tr 'A-Z' 'a-z' | sed 's/^@//')"
while ! printf %s "$admin" | grep -Eq '^[a-z0-9_]{3,20}$'; do
  printf "Your FreeMessenger username (you become the admin): "; read -r admin
  admin="$(printf %s "$admin" | tr 'A-Z' 'a-z' | sed 's/^@//')"
done
if ! command -v node >/dev/null; then
  if command -v brew >/dev/null; then brew install node; else echo "Install Node.js 22.13 or newer first (https://nodejs.org)."; exit 1; fi
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' || { echo "Node.js is too old: 22.13 or newer is needed."; exit 1; }
if ! command -v cloudflared >/dev/null && command -v brew >/dev/null; then brew install cloudflared; fi
cf="$(command -v cloudflared || true)"
[ -n "$cf" ] || echo "cloudflared isn't installed, so the app can only reach this relay on your network."
base="${FM_HOME:-$HOME/Library/Application Support/FreeMessenger Server}"
app="$base/app"; data="$base/data"
mkdir -p "$app/server" "$app/relay/src" "$data"
cp "$here/server.js" "$here/proxy.js" "$here/setup.mjs" "$here/package.json" "$here/package-lock.json" "$app/server/"
cp "$here/../relay/src/shared.js" "$app/relay/src/"
printf '{ "type": "module" }\n' > "$app/relay/package.json"
(cd "$app/server" && npm ci --omit=dev --no-audit --no-fund)
node "$app/server/setup.mjs" "$data" --admin "$admin" ${cf:+--cloudflared "$cf"} ${FM_BACKUP:+--backup "$FM_BACKUP"}
chmod 700 "$data"
label="io.github.a-hackers-guide.freemessenger-relay"
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$(command -v node)</string><string>$app/server/server.js</string><string>$data</string></array>
  <key>WorkingDirectory</key><string>$app/server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$data/relay.log</string>
  <key>StandardErrorPath</key><string>$data/relay.log</string>
</dict></plist>
P
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Done. The relay runs now and restarts by itself. Log: $data/relay.log"
