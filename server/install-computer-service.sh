#!/bin/bash
# FreeMessenger Computer Service Installer (macOS/Linux)
# Installs the background service that handles remote access requests

set -e

echo "🔒 FreeMessenger Remote Access Service"
echo "======================================"
echo ""
echo "⚠️  IMPORTANT: This installs a background service on your computer."
echo ""
echo "What this service does:"
echo "  ✓ Allows you to share your computer with others for remote support"
echo "  ✓ Shows a popup when someone requests access (you approve/deny)"
echo "  ✓ Lets the service admin monitor activity to prevent abuse"
echo "  ✓ Runs silently in the background when not in use"
echo ""
echo "To STOP this service at any time:"
echo "  macOS: Remove ~/Library/LaunchAgents/io.freemessenger.service.plist"
echo "  Linux: sudo systemctl disable freemessenger-service"
echo ""
read -p "Do you understand and consent? (yes/no) " -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Installation cancelled."
  exit 1
fi

echo "Installing FreeMessenger Computer Service..."

# Create service directory
SERVICE_DIR="$HOME/.freemessenger"
mkdir -p "$SERVICE_DIR"

# Get relay info from FreeMessenger app (or use defaults)
RELAY_HOST="${FM_RELAY_HOST:-localhost}"
RELAY_PORT="${FM_RELAY_PORT:-8790}"
USERNAME="${FM_USERNAME:-$(whoami)}"
COMPUTER_ID="${FM_COMPUTER_ID:-$(openssl rand -hex 8)}"
HOSTNAME="${FM_HOSTNAME:-$(hostname)}"

# Create wrapper script
cat > "$SERVICE_DIR/run-service.sh" << 'EOFSCRIPT'
#!/bin/bash
NODE_VERSION=$(node --version 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "Node.js not found. Please install Node.js v18+ from nodejs.org"
  exit 1
fi

export FM_RELAY_HOST="${FM_RELAY_HOST:-localhost}"
export FM_RELAY_PORT="${FM_RELAY_PORT:-8790}"
export FM_USERNAME="${FM_USERNAME:-$(whoami)}"
export FM_COMPUTER_ID="${FM_COMPUTER_ID:-${COMPUTER_ID}}"
export FM_HOSTNAME="${FM_HOSTNAME:-$(hostname)}"

# Download and run the service
curl -s https://raw.githubusercontent.com/A-Hackers-Guide/FreeMessenger/main/server/computer-service.js | node --input-type=module
EOFSCRIPT

chmod +x "$SERVICE_DIR/run-service.sh"

if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS: create LaunchAgent
  PLIST_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$PLIST_DIR"

  cat > "$PLIST_DIR/io.freemessenger.service.plist" << EOFPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.freemessenger.service</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SERVICE_DIR/run-service.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>$HOME/.freemessenger/service.log</string>
  <key>StandardOutPath</key>
  <string>$HOME/.freemessenger/service.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FM_USERNAME</key>
    <string>$USERNAME</string>
    <key>FM_COMPUTER_ID</key>
    <string>$COMPUTER_ID</string>
    <key>FM_HOSTNAME</key>
    <string>$HOSTNAME</string>
    <key>FM_RELAY_HOST</key>
    <string>$RELAY_HOST</string>
    <key>FM_RELAY_PORT</key>
    <string>$RELAY_PORT</string>
  </dict>
</dict>
</plist>
EOFPLIST

  chmod 644 "$PLIST_DIR/io.freemessenger.service.plist"

  echo "✓ Service installed: ~/Library/LaunchAgents/io.freemessenger.service.plist"
  echo "✓ Starting service..."
  launchctl load "$PLIST_DIR/io.freemessenger.service.plist"
  echo ""
  echo "✓ FreeMessenger Computer Service is now running."
  echo "  Log file: ~/.freemessenger/service.log"
  echo "  To stop: launchctl unload ~/Library/LaunchAgents/io.freemessenger.service.plist"

else
  # Linux: create systemd service
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SYSTEMD_DIR"

  cat > "$SYSTEMD_DIR/freemessenger-service.service" << EOFSYSTEMD
[Unit]
Description=FreeMessenger Computer Service
After=network.target

[Service]
Type=simple
ExecStart=$SERVICE_DIR/run-service.sh
Restart=always
RestartSec=5
Environment="FM_USERNAME=$USERNAME"
Environment="FM_COMPUTER_ID=$COMPUTER_ID"
Environment="FM_HOSTNAME=$HOSTNAME"
Environment="FM_RELAY_HOST=$RELAY_HOST"
Environment="FM_RELAY_PORT=$RELAY_PORT"
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOFSYSTEMD

  systemctl --user daemon-reload
  systemctl --user enable freemessenger-service
  systemctl --user start freemessenger-service

  echo "✓ Service installed and started."
  echo "  To view logs: journalctl --user -u freemessenger-service -f"
  echo "  To stop: systemctl --user stop freemessenger-service"
fi

echo ""
echo "🎉 Installation complete!"
echo "   Your computer will now handle incoming remote access requests."
echo "   You'll see a popup on your screen when someone requests access."
