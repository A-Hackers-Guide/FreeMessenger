# Remote Computer Access & Linking

## Design

**Goal:** Let you link your computer, share access with others (with explicit approval), and let the admin monitor activity.

### Architecture

- **Computer linking:** User installs a background service with bright warnings. Service registers itself with the relay.
- **Access requests:** When someone wants to control a linked computer, they send a request. The device owner gets a popup: "Alice wants to access your desktop — Allow/Deny."
- **Admin access:** You (admin) can access any linked computer without needing approval, for moderation.
- **Sessions:** Active sessions show a banner on the controlled device: "Alice is controlling your computer" with a Disconnect button.
- **Relay logs:** Service-level audit log shows who connected to whom and when.

### Message Types

New message kinds for remote control:
- `remote-request`: Someone asks to access a computer
- `remote-response`: Device owner approves/denies
- `remote-status`: Session status (active, ended, error)

### Relay Endpoints

#### POST `/api/computer/link`
Register a linked computer with the relay.

Body: `{ username, computer_id, hostname, platform }`

#### POST `/api/computer/access/:target/:computer_id`
Request access to someone's linked computer.

Body: `{ requester }`

#### GET `/api/computer/sessions`
Admin endpoint: list all active remote sessions.

Response: `{ sessions: [ { id, requester, target, computer, started_at, status } ] }`

### Local Endpoints (PC Server)

#### POST `/api/computer/register`
Service registers itself (called by computer-service.js on startup).

#### POST `/api/computer/active`
Service pings to stay alive.

### Client Components

- `computers.js`: Module for linking, access requests, session management.
- HTML dialogs: Access prompt, banner during active sessions.
- Admin panel tab: "Computers" showing linked devices, active sessions, activity log.

## Implementation Status

### Done ✓
- Relay endpoints scaffold
- Local server endpoints scaffold  
- Message types defined
- Native service skeleton (computer-service.js)
- Client module (computers.js)
- UI dialogs and banner

### TODO
- Integrate computers.js into app.js (import, call handlers)
- Add "Link Computer" button to admin panel (opens install instructions)
- Add "Computers" admin tab showing:
  - Linked computers (active/inactive, last seen)
  - Active sessions with disconnect button
  - Access log (who requested access, approved/denied, when)
- Implement real keyboard/mouse/screen capture in computer-service.js (macOS/Windows platform code)
- File transfer protocol over WebRTC (files only leave device with explicit approval)
- AI connector protocol (pass API keys through the remote computer)
- Install scripts for macOS/Windows (register as service with bright warnings)
- Browser approval + storage of approved browsers (so you don't have to approve every time)

## Security Model

- **No covert access:** Device owner must approve each session (except admin).
- **Visible control:** Banner shows who's controlling, always present during active session.
- **Audit trail:** All access attempts logged and visible to device owner and admin.
- **File control:** Files don't leave the device without explicit approval.
- **Encryption:** All traffic E2E encrypted (reuses existing E2E infrastructure).

## Timeline

This is a large feature. The foundation above can be committed as-is. The next steps are:
1. Native service platform code (macOS/Windows)
2. Admin UI integration
3. File transfer protocol
4. Testing and hardening
