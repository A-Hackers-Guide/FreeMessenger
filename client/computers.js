// Remote computer linking and access control

export const Computers = {
  computers: {},
  sessions: [],

  async linkComputer(username, computer_id, hostname) {
    // Register this device with the relay
    const res = await fetch("/api/computer/register", {
      method: "POST",
      body: JSON.stringify({ username, computer_id, hostname, platform: navigator.platform })
    });
    if (!res.ok) throw new Error((await res.json()).error);
    this.computers[computer_id] = { hostname, linked_at: Date.now(), active: true };
    return await res.json();
  },

  async requestAccess(target_username, computer_id) {
    // Ask to access someone else's linked computer
    const res = await fetch(`/api/computer/access/${target_username}/${computer_id}`, {
      method: "POST",
      body: JSON.stringify({ requester: username })
    });
    if (!res.ok) throw new Error("Access request failed");
    return await res.json();
  },

  async approveSession(sessionId) {
    // Device owner approves an incoming access request
    // Send via the app's message system (will be a control message)
    return await api("/api/send", {
      kind: "remote-response",
      target: "system",
      sessionId,
      approved: true
    });
  },

  async denySession(sessionId) {
    return await api("/api/send", {
      kind: "remote-response",
      target: "system",
      sessionId,
      approved: false
    });
  },

  handleIncoming(msg) {
    if (msg.kind === "remote-request") {
      // Someone is asking for access to MY computer
      return this.showAccessPrompt(msg);
    }
    if (msg.kind === "remote-response") {
      // Response to my access request
      this.handleAccessResponse(msg);
    }
    if (msg.kind === "remote-status") {
      // Session status update
      this.updateSessionStatus(msg);
    }
  },

  showAccessPrompt(msg) {
    // Show approval dialog on device owner's screen
    const dialog = document.getElementById("remote-access-dialog");
    if (!dialog) return; // Device is not linked
    
    const text = dialog.querySelector("p");
    text.textContent = `${msg.requester} wants to access your computer "${msg.hostname || "Desktop"}". Allow?`;
    
    const approve = dialog.querySelector("#remote-approve");
    const deny = dialog.querySelector("#remote-deny");
    
    approve.onclick = () => this.approveSession(msg.request_id);
    deny.onclick = () => this.denySession(msg.request_id);
    
    dialog.showModal();
  },

  updateSessionStatus(msg) {
    if (msg.status === "active") {
      // Show banner: "XXX is controlling your computer"
      const banner = document.getElementById("remote-banner");
      if (banner) {
        banner.textContent = `${msg.requester} is accessing your computer`;
        banner.style.display = "block";
      }
    } else if (msg.status === "ended") {
      const banner = document.getElementById("remote-banner");
      if (banner) banner.style.display = "none";
    }
  }
};
