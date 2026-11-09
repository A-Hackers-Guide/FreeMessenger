#!/bin/sh
# Builds all six installers into installers/dist (run on a Mac):
#   sh installers/build-all.sh 1.3.0
# Needs: brew install msitools squashfs, plus the AppImage runtime
# (gh release download continuous --repo AppImage/type2-runtime -p runtime-x86_64).
set -e
ver="${1:?version, e.g. 1.3.0}"
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/.." && pwd)"
runtime="${APPIMAGE_RUNTIME:-$here/runtime-x86_64}"
dist="$here/dist"; rm -rf "$dist"; mkdir -p "$dist"

# Windows (.msi)
cd "$here/windows"
rm -rf stage && mkdir -p stage/server stage/relay/src
cp "$root/server/server.js" "$root/server/proxy.js" "$root/server/setup.mjs" "$root/server/package.json" "$root/server/package-lock.json" "$root/server/install.ps1" stage/server/
cp "$root/relay/src/shared.js" stage/relay/src/
printf '[InternetShortcut]\r\nURL=https://a-hackers-guide.github.io/FreeMessenger/\r\nIconIndex=0\r\n' > FreeMessenger.url
wixl -D Version="$ver" -o "$dist/FreeMessenger-Messenger-$ver.msi" messenger.wxs
wixl -D Version="$ver" -o "$dist/FreeMessenger-Server-$ver.msi" server.wxs
rm -rf stage FreeMessenger.url

# macOS (.pkg)
sh "$here/macos/build.sh" "$ver" "$dist"

# Linux (.AppImage)
sh "$here/linux/build.sh" "$ver" "$runtime"
mv "$here/linux"/FreeMessenger-*-"$ver"-x86_64.AppImage "$dist/"
rm -rf "$here/linux/build"

cd "$dist" && shasum -a 256 FreeMessenger-* > SHA256SUMS && ls -la
