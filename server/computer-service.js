// FreeMessenger Computer Service
// Runs in background on macOS/Windows, handles remote access requests
// Installed with bright warnings; stops via Services panel or the app

const net = require('net');
const os = require('os');
const crypto = require('crypto');

const SERVICE_PORT = 9988; // Private local port, not exposed
const SERVICE_NAME = 'freemessenger-computer';

let remoteSession = null; // Current remote control session
let sessionId = null;

// Listen for relay connections (will come via the app)
const server = net.createServer((socket) => {
  socket.on('data', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleRemoteMessage(msg, socket);
    } catch (e) {
      socket.write(JSON.stringify({error: 'Invalid message'}));
    }
  });
});

function handleRemoteMessage(msg, socket) {
  if (msg.type === 'request-session') {
    // Someone wants to access this computer
    // The app will show a consent popup on the device owner's screen
    sessionId = crypto.randomBytes(8).toString('hex');
    remoteSession = {
      id: sessionId,
      requester: msg.requester,
      startedAt: Date.now(),
      approved: false,
      socket: socket
    };
    // Notify the app to show the popup
    socket.write(JSON.stringify({type: 'waiting-approval', sessionId}));
  } else if (msg.type === 'approve-session') {
    if (remoteSession && remoteSession.id === msg.sessionId) {
      remoteSession.approved = true;
      socket.write(JSON.stringify({type: 'session-active', sessionId: msg.sessionId}));
    }
  } else if (msg.type === 'input' && remoteSession && remoteSession.approved) {
    // Handle mouse/keyboard/screen capture
    // (Platform-specific - will differ on macOS vs Windows)
    socket.write(JSON.stringify({type: 'input-ack'}));
  }
}

server.listen(SERVICE_PORT, '127.0.0.1', () => {
  console.log('[FreeMessenger Service] Running on port', SERVICE_PORT);
  console.log('[FreeMessenger Service] Install: sudo launchctl load /Library/LaunchDaemons/io.freemessenger.service.plist (macOS)');
  console.log('[FreeMessenger Service] Or: Register-ScheduledTask -TaskName "FreeMessenger" (Windows)');
});

process.on('SIGTERM', () => {
  console.log('[FreeMessenger Service] Stopping');
  if (remoteSession) remoteSession.socket.destroy();
  server.close();
  process.exit(0);
});
