#!/bin/sh
# Builds the two Linux AppImages: build.sh <version> <runtime-x86_64 path>
set -e
cd "$(dirname "$0")"
ver="$1"; runtime="$2"; root="$(cd ../.. && pwd)"
rm -rf build && mkdir -p build

# ---- Messenger: opens FreeMessenger in its own window ----
m=build/Messenger.AppDir
mkdir -p "$m"
cp "$root/client/icon-512.png" "$m/freemessenger.png"; cp "$m/freemessenger.png" "$m/.DirIcon"
cat > "$m/freemessenger.desktop" <<D
[Desktop Entry]
Type=Application
Name=FreeMessenger
Comment=Free texting, voice and video calls
Exec=AppRun
Icon=freemessenger
Categories=Network;InstantMessaging;
D
cat > "$m/AppRun" <<'R'
#!/bin/sh
URL="https://a-hackers-guide.github.io/FreeMessenger/"
for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
  if command -v "$b" >/dev/null 2>&1; then exec "$b" --app="$URL"; fi
done
exec xdg-open "$URL"
R
chmod +x "$m/AppRun"

# ---- Server: sets up the home relay as a systemd user service ----
s=build/Server.AppDir
mkdir -p "$s/server" "$s/relay/src"
cp "$root/client/icon-512.png" "$s/freemessenger-server.png"; cp "$s/freemessenger-server.png" "$s/.DirIcon"
cp "$root/server/server.js" "$root/server/proxy.js" "$root/server/setup.mjs" "$root/server/package.json" "$root/server/package-lock.json" "$root/server/install-linux.sh" "$s/server/"
cp "$root/relay/src/shared.js" "$s/relay/src/"
cat > "$s/freemessenger-server.desktop" <<D
[Desktop Entry]
Type=Application
Name=FreeMessenger Server
Comment=Turn this computer into your FreeMessenger home relay
Exec=AppRun
Icon=freemessenger-server
Terminal=true
Categories=Network;
D
cat > "$s/AppRun" <<'R'
#!/bin/sh
here="$(dirname "$(readlink -f "$0")")"
exec sh "$here/server/install-linux.sh" "$@"
R
chmod +x "$s/AppRun"

for kind in Messenger Server; do
  mksquashfs "build/$kind.AppDir" "build/$kind.squashfs" -root-owned -noappend -comp zstd -quiet -no-xattrs
  out="FreeMessenger-$kind-$ver-x86_64.AppImage"
  cat "$runtime" "build/$kind.squashfs" > "$out"
  chmod +x "$out"
done
ls -la *.AppImage
