#!/bin/sh
# Builds the two macOS installers: build.sh <version> <output folder>
set -e
cd "$(dirname "$0")"
ver="$1"; out="$2"; root="$(cd ../.. && pwd)"
rm -rf build && mkdir -p build/icon.iconset build/res

# ---- Messenger: /Applications/FreeMessenger.app ----
app=build/root/Applications/FreeMessenger.app/Contents
mkdir -p "$app/MacOS" "$app/Resources"
for s in 16 32 128 256 512; do
  sips -z $s $s "$root/client/icon-512.png" --out build/icon.iconset/icon_${s}x${s}.png >/dev/null
  d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d "$root/client/icon-512.png" --out build/icon.iconset/icon_${s}x${s}@2x.png >/dev/null
done
cp "$root/client/icon-512.png" build/icon.iconset/icon_512x512@2x.png
iconutil -c icns build/icon.iconset -o "$app/Resources/AppIcon.icns"
cp launcher.sh "$app/MacOS/FreeMessenger"; chmod 755 "$app/MacOS/FreeMessenger"
sed "s/@VERSION@/$ver/g" Info.plist.in > "$app/Info.plist"
COPYFILE_DISABLE=1 pkgbuild --root build/root --identifier io.github.a-hackers-guide.freemessenger --version "$ver" --install-location / "$out/FreeMessenger-Messenger-$ver.pkg" >/dev/null
sh repack.sh "$out/FreeMessenger-Messenger-$ver.pkg" build/root

# ---- Server: relay files + "FreeMessenger Server Setup" in Applications ----
srv=build/server-root
lib="$srv/Library/Application Support/FreeMessenger Server"
mkdir -p "$lib/server" "$lib/relay/src" "$srv/Applications"
cp "$root/server/server.js" "$root/server/proxy.js" "$root/server/setup.mjs" "$root/server/package.json" "$root/server/package-lock.json" "$root/server/install-mac.sh" "$lib/server/"
cp "$root/relay/src/shared.js" "$lib/relay/src/"
printf '#!/bin/sh\n# Sets up the FreeMessenger home relay on this Mac.\nexec sh "/Library/Application Support/FreeMessenger Server/server/install-mac.sh"\n' > "$srv/Applications/FreeMessenger Server Setup.command"
chmod 755 "$srv/Applications/FreeMessenger Server Setup.command"
COPYFILE_DISABLE=1 pkgbuild --root "$srv" --identifier io.github.a-hackers-guide.freemessenger-server --version "$ver" --install-location / build/server-component.pkg >/dev/null
sh repack.sh build/server-component.pkg "$srv"
cp conclusion.html build/res/
sed "s/@VERSION@/$ver/g" dist.xml.in > build/dist.xml
productbuild --distribution build/dist.xml --resources build/res --package-path build "$out/FreeMessenger-Server-$ver.pkg" >/dev/null
rm -rf build
