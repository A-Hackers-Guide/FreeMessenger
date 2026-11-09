#!/bin/sh
# Sets up FreeMessenger's home relay on Linux as a systemd user service that
# restarts by itself. Needs Node.js 22.13+ and cloudflared.
#   sh install-linux.sh yourname        (run it again to update; keeps your data)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
admin="$(printf %s "${1:-}" | tr 'A-Z' 'a-z' | sed 's/^@//')"
while ! printf %s "$admin" | grep -Eq '^[a-z0-9_]{3,20}$'; do
  printf "Your FreeMessenger username (you become the admin): "; read -r admin
  admin="$(printf %s "$admin" | tr 'A-Z' 'a-z' | sed 's/^@//')"
done
command -v node >/dev/null || { echo "Install Node.js 22.13 or newer first (https://nodejs.org)."; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' || { echo "Node.js is too old: 22.13 or newer is needed."; exit 1; }
cf="$(command -v cloudflared || true)"
[ -n "$cf" ] || echo "cloudflared isn't installed, so the app can only reach this relay on your network. Get it at https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
base="${FM_HOME:-$HOME/.local/share/freemessenger-server}"
app="$base/app"; data="$base/data"
mkdir -p "$app/server" "$app/relay/src" "$data"
cp "$here/server.js" "$here/proxy.js" "$here/setup.mjs" "$here/package.json" "$here/package-lock.json" "$app/server/"
cp "$here/../relay/src/shared.js" "$app/relay/src/"
printf '{ "type": "module" }\n' > "$app/relay/package.json"
(cd "$app/server" && npm ci --omit=dev --no-audit --no-fund)
node "$app/server/setup.mjs" "$data" --admin "$admin" ${cf:+--cloudflared "$cf"}
chmod 700 "$data"
unit="$HOME/.config/systemd/user/freemessenger-relay.service"
mkdir -p "$(dirname "$unit")"
cat > "$unit" <<UNIT
[Unit]
Description=FreeMessenger home relay
After=network-online.target

[Service]
WorkingDirectory=$app/server
ExecStart=$(command -v node) $app/server/server.js $data
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now freemessenger-relay.service
loginctl enable-linger "$(id -un)" 2>/dev/null || true
echo "Done. The relay runs now and restarts by itself. Log: journalctl --user -u freemessenger-relay -f"
