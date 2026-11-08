// Remote computer access: linking, sessions, file transfer, AI connectors

export const Computers = {
  computers: {},
  sessions: {},
  fileTransfers: {},
  aiRequests: {},

  // Computer linking
  async linkComputer(username, computer_id, hostname) {
    const res = await fetch("/api/computer/register", {
      method: "POST",
      body: JSON.stringify({ username, computer_id, hostname, platform: navigator.platform })
    });
    if (!res.ok) throw new Error((await res.json()).error);
    this.computers[computer_id] = { hostname, linked_at: Date.now(), active: true };
    return await res.json();
  },

  async requestAccess(target_username, computer_id) {
    const res = await fetch(`/api/computer/access/${target_username}/${computer_id}`, {
      method: "POST",
      body: JSON.stringify({ requester: username })
    });
    if (!res.ok) throw new Error("Access request failed");
    return await res.json();
  },

  // Session control
  async approveSession(sessionId) {
    return await api("/api/send", { kind: "remote-response", sessionId, approved: true });
  },

  async denySession(sessionId) {
    return await api("/api/send", { kind: "remote-response", sessionId, approved: false });
  },

  async endSession(sessionId) {
    if (this.sessions[sessionId]?.socket) {
      this.sessions[sessionId].socket.send(JSON.stringify({ type: "end-session", sessionId }));
    }
    delete this.sessions[sessionId];
  },

  // File transfer
  async requestFile(sessionId, path) {
    if (this.sessions[sessionId]?.socket) {
      const fileId = crypto.randomUUID();
      this.sessions[sessionId].socket.send(JSON.stringify({ type: "file-request", path, fileId }));
      this.fileTransfers[fileId] = { path, status: "pending" };
    }
  },

  async approveFileTransfer(fileId, sessionId) {
    if (this.sessions[sessionId]?.socket) {
      this.sessions[sessionId].socket.send(JSON.stringify({ type: "file-approved", fileId }));
      this.fileTransfers[fileId].status = "approved";
    }
  },

  async denyFileTransfer(fileId) {
    delete this.fileTransfers[fileId];
    return await api("/api/send", { kind: "file-denied", fileId });
  },

  // AI connector (access someone's API keys through their computer)
  async requestAIAccess(targetUsername, computerId, provider, purpose) {
    const requestId = crypto.randomUUID();
    this.aiRequests[requestId] = { targetUsername, computerId, provider, purpose };
    return await api("/api/send", {
      kind: "ai-access-request",
      target: targetUsername,
      requestId,
      provider,
      purpose
    });
  },

  async approveAIRequest(requestId, sessionId) {
    if (this.sessions[sessionId]?.socket) {
      this.sessions[sessionId].socket.send(JSON.stringify({ type: "ai-approved", requestId }));
    }
    return await api("/api/send", { kind: "ai-access-approved", requestId });
  },

  async denyAIRequest(requestId) {
    delete this.aiRequests[requestId];
    return await api("/api/send", { kind: "ai-access-denied", requestId });
  },

  // Message handling
  handleIncoming(msg) {
    if (msg.kind === "remote-request") this.showAccessPrompt(msg);
    else if (msg.kind === "remote-status") this.updateSessionStatus(msg);
    else if (msg.kind === "file-request") this.handleFileRequest(msg);
    else if (msg.kind === "ai-access-request") this.handleAIRequest(msg);
  },

  showAccessPrompt(msg) {
    const dialog = document.getElementById("remote-access-dialog");
    if (!dialog) return;
    const text = dialog.querySelector("p");
    text.textContent = `${msg.requester} wants to access your computer. Allow?`;
    dialog.querySelector("#remote-approve").onclick = () => this.approveSession(msg.request_id);
    dialog.querySelector("#remote-deny").onclick = () => this.denySession(msg.request_id);
    dialog.showModal();
  },

  handleFileRequest(msg) {
    const banner = document.getElementById("remote-banner");
    if (!banner) return;
    banner.innerHTML = `
      ${msg.requester} requesting: <strong>${msg.path}</strong>
      <button class="ghost small" onclick="Computers.approveFileTransfer('${msg.fileId}', '${msg.sessionId}')">Allow</button>
      <button class="ghost small" onclick="Computers.denyFileTransfer('${msg.fileId}')">Deny</button>
    `;
    banner.style.display = "block";
  },

  handleAIRequest(msg) {
    const banner = document.getElementById("remote-banner");
    if (!banner) return;
    banner.innerHTML = `
      ${msg.requester} wants to use your ${msg.provider} key for: <strong>${msg.purpose}</strong>
      <button class="ghost small" onclick="Computers.approveAIRequest('${msg.requestId}', '${msg.sessionId}')">Allow</button>
      <button class="ghost small" onclick="Computers.denyAIRequest('${msg.requestId}')">Deny</button>
    `;
    banner.style.display = "block";
  },

  updateSessionStatus(msg) {
    const banner = document.getElementById("remote-banner");
    if (!banner) return;
    if (msg.status === "active") {
      banner.textContent = `🔴 ${msg.requester} is accessing your computer`;
      banner.style.display = "block";
      this.sessions[msg.sessionId] = { active: true, requester: msg.requester };
    } else if (msg.status === "ended") {
      banner.style.display = "none";
      delete this.sessions[msg.sessionId];
    }
  }
};
