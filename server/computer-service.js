// FreeMessenger Computer Remote Access Service
// Runs in background, handles incoming remote control requests
// Install: npm install ws; then register via install script
// macOS: launchctl load ~/Library/LaunchAgents/io.freemessenger.service.plist
// Windows: powershell -ExecutionPolicy Bypass -File install.ps1

import http from "node:http";
import net from "node:net";
import os from "node:os";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Configuration
const RELAY_HOST = process.env.FM_RELAY_HOST || "localhost";
const RELAY_PORT = process.env.FM_RELAY_PORT || 8790;
const SERVICE_PORT = 9988; // Private local port for incoming connections
const COMPUTER_ID = process.env.FM_COMPUTER_ID || crypto.randomBytes(8).toString("hex");
const USERNAME = process.env.FM_USERNAME || os.userInfo().username;
const HOSTNAME = process.env.FM_HOSTNAME || os.hostname();
const PLATFORM = process.platform; // darwin, win32, linux
const MAX_SESSIONS = 5;

let remoteSession = null;
let screenInterval = null;
let activeSessions = 0;

// Screen capture (platform-specific)
async function captureScreen() {
  try {
    if (PLATFORM === "darwin") {
      // macOS: screencapture
      const { stdout } = await execAsync(
        `screencapture -x /tmp/fm_$$.png 2>/dev/null && base64 /tmp/fm_$$.png && rm -f /tmp/fm_$$.png`
      );
      return stdout.trim();
    } else if (PLATFORM === "win32") {
      // Windows: PowerShell
      const tmpFile = `$env:TEMP\\fm_${Date.now()}.png`;
      const cmd = `
        Add-Type -AssemblyName System.Windows.Forms;
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
        $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height);
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap);
        $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
        $bitmap.Save('${tmpFile}');
        $graphics.Dispose();
        $bitmap.Dispose();
        [Convert]::ToBase64String([IO.File]::ReadAllBytes('${tmpFile}')) | Write-Host;
        Remove-Item '${tmpFile}' -Force
      `;
      const { stdout } = await execAsync(`powershell -NoProfile "${cmd.replace(/"/g, '\\"')}"`);
      return stdout.trim();
    }
    return "";
  } catch (e) {
    return "";
  }
}

// Show approval dialog (platform-specific)
async function showApprovalDialog(requester, computerName) {
  try {
    if (PLATFORM === "darwin") {
      // macOS: osascript
      const msg = `${requester} wants to access your computer "${computerName}"`;
      const { stdout } = await execAsync(
        `osascript -e 'display dialog "${msg}" buttons {"Deny", "Allow"} default button 2 with icon caution' 2>/dev/null | grep -o "Allow"`
      );
      return stdout.includes("Allow");
    } else if (PLATFORM === "win32") {
      // Windows: PowerShell dialog
      const msg = `${requester} wants to access your computer. Allow?`;
      const script = `
        [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null;
        $result = [System.Windows.Forms.MessageBox]::Show('${msg}', 'FreeMessenger', 4);
        exit $result
      `;
      try {
        await execAsync(`powershell -NoProfile "${script}"`);
        return true; // If it didn't throw, user clicked Yes
      } catch {
        return false; // User clicked No or closed dialog
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

// Send input (mouse/keyboard)
async function sendInput(input) {
  try {
    // Validate input coordinates
    if (typeof input.x !== 'number' || typeof input.y !== 'number') return;
    if (input.x < 0 || input.y < 0 || input.x > 65535 || input.y > 65535) return;

    if (input.type === "mouse-move") {
      if (PLATFORM === "darwin") {
        await execAsync(`osascript -e 'tell application "System Events" to set mouse position to {${Math.floor(input.x)}, ${Math.floor(input.y)}}'`);
      } else if (PLATFORM === "win32") {
        const x = Math.floor(input.x);
        const y = Math.floor(input.y);
        const script = `
          Add-Type -AssemblyName System.Windows.Forms;
          [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
        `;
        await execAsync(`powershell -NoProfile "${script}"`);
      }
    } else if (input.type === "mouse-click") {
      if (PLATFORM === "darwin") {
        await execAsync(`osascript -e 'tell application "System Events" to click at {${Math.floor(input.x)}, ${Math.floor(input.y)}}'`);
      } else if (PLATFORM === "win32") {
        const x = Math.floor(input.x);
        const y = Math.floor(input.y);
        const script = `
          Add-Type -AssemblyName System.Windows.Forms;
          [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});
          [System.Windows.Forms.SendKeys]::SendWait('{LBUTTON}')
        `;
        await execAsync(`powershell -NoProfile "${script}"`);
      }
    } else if (input.type === "key") {
      if (typeof input.key !== 'string' || input.key.length > 100) return;
      if (PLATFORM === "darwin") {
        const escaped = input.key.replace(/"/g, '\\"');
        await execAsync(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`);
      } else if (PLATFORM === "win32") {
        const escaped = input.key.replace(/'/g, "''");
        const script = `
          Add-Type -AssemblyName System.Windows.Forms;
          [System.Windows.Forms.SendKeys]::SendWait('${escaped}')
        `;
        await execAsync(`powershell -NoProfile "${script}"`);
      }
    }
  } catch (e) {
    // Silently fail - input may not be available
  }
}

// Main TCP server
const server = net.createServer(async (socket) => {
  let buffer = "";
  socket.setTimeout(300000); // 5 min timeout

  socket.on("data", async (data) => {
    if (buffer.length > 1000000) {
      socket.destroy(); // Prevent unbounded buffer growth
      return;
    }
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        await handleMessage(msg, socket);
      } catch (e) {
        socket.write(JSON.stringify({ error: "Invalid message" }) + "\n");
      }
    }
  });

  socket.on("end", () => {
    if (remoteSession?.socket === socket) endSession();
  });
});

async function handleMessage(msg, socket) {
  if (msg.type === "request-session") {
    if (activeSessions >= MAX_SESSIONS) {
      socket.write(JSON.stringify({ type: "session-denied", reason: "too-many-sessions" }) + "\n");
      return;
    }

    const approved = await showApprovalDialog(msg.requester, HOSTNAME);

    if (approved) {
      const sessionId = crypto.randomBytes(8).toString("hex");
      remoteSession = { id: sessionId, requester: msg.requester, socket, started: Date.now() };
      activeSessions++;
      socket.write(JSON.stringify({ type: "session-active", sessionId }) + "\n");

      // Screen capture loop
      screenInterval = setInterval(async () => {
        try {
          const screenshot = await captureScreen();
          if (screenshot) {
            socket.write(JSON.stringify({ type: "screen", data: screenshot.slice(0, 100000) }) + "\n");
          }
        } catch (e) {
          // Silently fail
        }
      }, 500);
    } else {
      socket.write(JSON.stringify({ type: "session-denied" }) + "\n");
    }
  } else if (msg.type === "input" && remoteSession) {
    await sendInput(msg.input);
    socket.write(JSON.stringify({ type: "input-ack" }) + "\n");
  } else if (msg.type === "end-session" && remoteSession?.id === msg.sessionId) {
    endSession();
    socket.write(JSON.stringify({ type: "session-ended" }) + "\n");
  }
}

function endSession() {
  if (remoteSession) {
    clearInterval(screenInterval);
    remoteSession = null;
    activeSessions--;
  }
}

// Register with relay
async function registerWithRelay() {
  try {
    const body = JSON.stringify({ username: USERNAME, computer_id: COMPUTER_ID, hostname: HOSTNAME, platform: PLATFORM });
    const req = http.request(
      { hostname: RELAY_HOST, port: RELAY_PORT, path: "/api/computer/register", method: "POST" },
      (res) => {
        if (res.statusCode === 200) {
          console.log(`[FM Service] Registered: ${USERNAME}@${HOSTNAME}`);
        }
      }
    );
    req.write(body);
    req.end();
    req.on("error", () => {});
  } catch (e) {
    // Silently fail
  }
}

// Heartbeat
setInterval(async () => {
  try {
    const body = JSON.stringify({ username: USERNAME, computer_id: COMPUTER_ID });
    const req = http.request({ hostname: RELAY_HOST, port: RELAY_PORT, path: "/api/computer/active", method: "POST" }, (res) => {});
    req.write(body);
    req.end();
    req.on("error", () => {});
  } catch (e) {
    // Silently fail
  }
}, 30000);

// Start
server.listen(SERVICE_PORT, "127.0.0.1", () => {
  console.log(`[FM Service] Running (${USERNAME}@${HOSTNAME}, ${PLATFORM})`);
  registerWithRelay();
});

process.on("SIGTERM", () => {
  endSession();
  server.close();
  process.exit(0);
});
