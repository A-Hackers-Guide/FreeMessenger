// Admin panel: Computer management
// Shows linked computers, active sessions, access logs

export function renderComputersTab() {
  const html = `
    <h3>Linked Computers</h3>
    <div id="computers-list" style="display: grid; gap: 12px;">
      <p class="fine">No computers linked yet.</p>
    </div>

    <h3 style="margin-top: 24px;">Install on Your Computer</h3>
    <div style="background: #f5f5f5; padding: 12px; border-radius: 6px; margin: 12px 0;">
      <p><strong>1. Download and install Node.js</strong> (v18+) from nodejs.org</p>
      <p><strong>2. Run this command:</strong></p>
      <code style="display: block; background: #333; color: #0f0; padding: 12px; margin: 8px 0; border-radius: 4px; overflow: auto;">
curl -s https://a-hackers-guide.github.io/FreeMessenger/install-computer-service.sh | bash
      </code>
      <p class="fine">⚠️ This registers a background service that will handle incoming remote access requests.</p>
      <p class="fine">🔓 You'll see a popup on your screen when someone requests access.</p>
      <p class="fine">🛑 To stop it: remove the service from your system's Services panel or run: <code>npm uninstall -g freemessenger-service</code></p>
    </div>

    <h3 style="margin-top: 24px;">Active Sessions</h3>
    <div id="sessions-list" style="display: grid; gap: 8px;">
      <p class="fine">No active sessions.</p>
    </div>

    <h3 style="margin-top: 24px;">Access Log</h3>
    <div id="access-log" style="display: grid; gap: 6px; font-size: 12px;">
      <p class="fine">No access history.</p>
    </div>
  `;
  return html;
}

function escapeHtml(text) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

export function updateComputersUI(computers, sessions, accessLog) {
  const computersList = document.getElementById("computers-list");
  if (computersList) {
    if (!computers || Object.keys(computers).length === 0) {
      computersList.innerHTML = '<p class="fine">No computers linked yet.</p>';
    } else {
      computersList.innerHTML = Object.entries(computers).map(([id, comp]) => {
        const hostnameEsc = escapeHtml(comp.hostname);
        const platformEsc = escapeHtml(comp.platform || "unknown");
        const lastSeen = comp.last_seen ? new Date(comp.last_seen).toLocaleTimeString() : "Never";
        return `
          <div style="border: 1px solid #ddd; padding: 12px; border-radius: 6px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>${hostnameEsc}</strong> <span class="fine">(${platformEsc})</span>
                <div class="fine">${comp.active ? "🟢 Online" : "🔴 Offline"} • Last seen: ${escapeHtml(lastSeen)}</div>
              </div>
              <button type="button" class="ghost small" data-id="${escapeHtml(id)}">Unlink</button>
            </div>
          </div>
        `;
      }).join("");
    }
  }

  const sessionsList = document.getElementById("sessions-list");
  if (sessionsList) {
    if (!sessions || sessions.length === 0) {
      sessionsList.innerHTML = '<p class="fine">No active sessions.</p>';
    } else {
      sessionsList.innerHTML = sessions.map(sess => {
        const requesterEsc = escapeHtml(sess.requester);
        const computerEsc = escapeHtml(sess.computer);
        const startedAt = new Date(sess.started_at).toLocaleTimeString();
        return `
          <div style="border-left: 3px solid #f97316; padding: 12px; background: #fffbf0; border-radius: 4px;">
            <strong>${requesterEsc}</strong> is accessing <strong>${computerEsc}</strong>
            <div class="fine">Started ${escapeHtml(startedAt)}</div>
            <button type="button" class="ghost small" data-session="${escapeHtml(sess.id || '')}">Disconnect</button>
          </div>
        `;
      }).join("");
    }
  }

  const logDiv = document.getElementById("access-log");
  if (logDiv) {
    if (!accessLog || accessLog.length === 0) {
      logDiv.innerHTML = '<p class="fine">No access history.</p>';
    } else {
      logDiv.innerHTML = accessLog.map(log => {
        const requesterEsc = escapeHtml(log.requester);
        const computerEsc = escapeHtml(log.computer);
        const timeStr = new Date(log.timestamp).toLocaleString();
        return `
          <div style="padding: 8px; background: ${log.approved ? "#f0fff4" : "#fff5f5"}; border-radius: 4px;">
            ${log.approved ? "✅" : "❌"}
            <strong>${requesterEsc}</strong> requested access to
            <strong>${computerEsc}</strong>
            <span class="fine">${escapeHtml(timeStr)}</span>
          </div>
        `;
      }).join("");
    }
  }
}
