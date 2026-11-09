#!/bin/sh
# Opens FreeMessenger in its own window when Chrome, Edge or Brave is installed, otherwise in the default browser.
URL="https://a-hackers-guide.github.io/FreeMessenger/"
for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if open -Ra "$app" 2>/dev/null; then exec open -na "$app" --args --app="$URL"; fi
done
exec open "$URL"
