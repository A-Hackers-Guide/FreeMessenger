#!/bin/sh
# Rebuilds a component pkg's payload without AppleDouble (._) files: repack.sh <pkg> <root>
set -e
pkg="$1"; root="$2"; tmp="$(mktemp -d)"
pkgutil --expand "$pkg" "$tmp/x"
(cd "$root" && bsdtar --format cpio --no-mac-metadata --uid 0 --gid 80 -cf - .) | gzip -9 > "$tmp/x/Payload"
(cd "$root" && find . | while read -r f; do if [ -d "$f" ]; then printf "%s\t40755\t0/80\n" "$f"; else m=$(stat -f %Lp "$f"); sz=$(stat -f %z "$f"); ck=$(cksum < "$f" | cut -d" " -f1); printf "%s\t100%s\t0/80\t%s\t%s\n" "$f" "$m" "$sz" "$ck"; fi; done) > "$tmp/list"; sed -i '' -e 's|^\.\t40755\t0/80$|.\t40755\t0/0|' -e 's|^\./Applications\t40755\t0/80$|./Applications\t40775\t0/80|' -e 's|^\./Library\t40755\t0/80$|./Library\t40755\t0/0|' -e 's|^\./Library/Application Support\t40755\t0/80$|./Library/Application Support\t40755\t0/0|' "$tmp/list"; mkbom -i "$tmp/list" "$tmp/x/Bom"
n=$(find "$root" | wc -l | tr -d ' ')
kb=$(du -sk "$root" | cut -f1)
sed -i '' -e 's/overwrite-permissions="true"/overwrite-permissions="false"/' -e "s/numberOfFiles=\"[0-9]*\"/numberOfFiles=\"$n\"/" -e "s/installKBytes=\"[0-9]*\"/installKBytes=\"$kb\"/" "$tmp/x/PackageInfo"
rm -f "$pkg"
pkgutil --flatten "$tmp/x" "$pkg"
rm -rf "$tmp"
