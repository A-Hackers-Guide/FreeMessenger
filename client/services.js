// Optional services: Moonlight (gaming), Jellyfin/Plex (media), Audiobookshelf (audio)
// All run locally, accessed through unified dashboard

import crypto from "node:crypto";

// Stub - will be set by app.js when imported
const api = globalThis.fm_api || (async () => { throw new Error("API not initialized"); });

export const Services = {
  // Service definitions
  available: {
    sunshine: {
      name: "Game Streaming (Sunshine)",
      description: "Stream games from your PC to any device. Custom build compatible with Moonlight.",
      icon: "🎮",
      platforms: ["macos", "windows", "linux"],
      port: 47989,
      requiresSetup: true,
      setupFields: [
        { name: "nvidia_gpu", label: "Use NVIDIA GPU acceleration?", type: "checkbox", default: true },
        { name: "bitrate", label: "Stream bitrate (Mbps)", type: "number", default: 50, min: 5, max: 150 }
      ]
    },
    moonlight: {
      name: "Game Streaming Client",
      description: "Play games on this computer from anywhere. Works with custom Sunshine or stock GameStream.",
      icon: "📱",
      platforms: ["macos", "windows", "linux"],
      requiresSetup: false
    },
    jellyfin: {
      name: "Jellyfin (Media Server)",
      description: "Self-hosted streaming for movies, shows, music. Free alternative to Plex.",
      icon: "🎬",
      platforms: ["macos", "windows", "linux"],
      port: 8096,
      requiresSetup: true,
      setupFields: [
        { name: "media_path", label: "Where are your media files?", type: "folder", default: "~/Media" },
        { name: "transcode", label: "Enable transcoding for old devices?", type: "checkbox", default: true }
      ]
    },
    plex: {
      name: "Plex Media Server",
      description: "Centralized home for all your entertainment.",
      icon: "🎥",
      platforms: ["macos", "windows", "linux"],
      port: 32400,
      requiresSetup: true,
      setupFields: [
        { name: "media_path", label: "Where are your media files?", type: "folder", default: "~/Media" }
      ]
    },
    audiobookshelf: {
      name: "Audiobookshelf",
      description: "Self-hosted audiobooks and podcasts. Listen anywhere.",
      icon: "🎧",
      platforms: ["macos", "windows", "linux"],
      port: 13378,
      requiresSetup: true,
      setupFields: [
        { name: "audiobooks_path", label: "Where are your audiobooks?", type: "folder", default: "~/Audiobooks" },
        { name: "podcasts_path", label: "Where are your podcasts?", type: "folder", default: "~/Podcasts" }
      ]
    }
  },

  // User's installed services
  installed: {},
  running: {},

  // Initialize services from saved config
  async init() {
    try {
      this.installed = JSON.parse(localStorage.getItem("fm.services") || "{}");
    } catch (e) {
      console.error("Failed to load services config:", e);
      this.installed = {};
    }
    await this.checkRunningServices();
  },

  // Check which services are running
  async checkRunningServices() {
    for (const [name, config] of Object.entries(this.installed)) {
      try {
        const res = await fetch(`http://localhost:${this.available[name].port}/health`, { timeout: 2000 });
        this.running[name] = res.ok;
      } catch {
        this.running[name] = false;
      }
    }
  },

  // Start a service
  async startService(name) {
    if (!this.installed[name]) return false;
    try {
      const res = await fetch(`/api/service/start`, {
        method: "POST",
        body: JSON.stringify({ service: name })
      });
      if (res.ok) {
        this.running[name] = true;
        return true;
      }
    } catch (e) {
      console.error(`Failed to start ${name}:`, e);
    }
    return false;
  },

  // Stop a service
  async stopService(name) {
    try {
      const res = await fetch(`/api/service/stop`, {
        method: "POST",
        body: JSON.stringify({ service: name })
      });
      if (res.ok) {
        this.running[name] = false;
        return true;
      }
    } catch (e) {
      console.error(`Failed to stop ${name}:`, e);
    }
    return false;
  },

  // Uninstall a service
  async uninstallService(name) {
    await this.stopService(name);
    delete this.installed[name];
    localStorage.setItem("fm.services", JSON.stringify(this.installed));
    return true;
  },

  // Mark service as installed (called by setup GUI)
  markInstalled(name, config) {
    this.installed[name] = config;
    this.running[name] = false;
    localStorage.setItem("fm.services", JSON.stringify(this.installed));
  }
};

// Service setup wizard
export function renderServiceSetup() {
  const services = Object.entries(Services.available).filter(([_, s]) => !Services.installed[_]);

  if (services.length === 0) {
    return `<p class="fine">All available services are installed.</p>`;
  }

  return `
    <div style="display: grid; gap: 16px;">
      <h3>Optional Services</h3>
      <p class="fine">Pick any to install. All integrate with FreeMessenger and start/stop with the app.</p>
      ${services.map(([name, svc]) => `
        <div style="border: 1px solid #ddd; padding: 16px; border-radius: 6px;">
          <div style="display: flex; justify-content: space-between; align-items: start;">
            <div>
              <h4>${svc.icon} ${svc.name}</h4>
              <p class="fine">${svc.description}</p>
              <p class="fine">Runs on port ${svc.port}</p>
            </div>
            <button type="button" class="primary" onclick="Services.showSetupGUI('${name}')">Install</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

// Service setup GUI (opens for each service)
export function renderServiceSetupGUI(name) {
  const svc = Services.available[name];
  if (!svc || !svc.requiresSetup) return "";

  return `
    <dialog id="service-setup-${name}" style="max-width: 500px;">
      <h2>${svc.icon} Set up ${svc.name}</h2>
      <form id="setup-form-${name}">
        ${svc.setupFields.map(field => `
          <label style="display: block; margin: 12px 0;">
            <strong>${field.label}</strong>
            ${field.type === "checkbox" ? `
              <input type="checkbox" name="${field.name}" ${field.default ? "checked" : ""} style="margin-left: 8px;">
            ` : field.type === "folder" ? `
              <input type="text" name="${field.name}" placeholder="${field.default}" style="width: 100%; margin-top: 4px; padding: 6px; border: 1px solid #ddd; border-radius: 3px;">
              <small class="fine">Click to browse or type path</small>
            ` : field.type === "number" ? `
              <input type="number" name="${field.name}" value="${field.default}" min="${field.min}" max="${field.max}" style="width: 100%; margin-top: 4px; padding: 6px; border: 1px solid #ddd; border-radius: 3px;">
            ` : ""}
          </label>
        `).join("")}
        <div style="display: flex; gap: 8px; margin-top: 20px;">
          <button type="button" class="ghost" onclick="document.getElementById('service-setup-${name}').close()">Cancel</button>
          <button type="submit" class="primary">Install ${svc.name}</button>
        </div>
      </form>
    </dialog>
  `;
}

// Unified dashboard (shows all services)
export function renderServicesDashboard() {
  return `
    <div style="display: grid; gap: 20px;">
      <h2>🎮 Media & Gaming Center</h2>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
        ${Object.entries(Services.installed).map(([name, config]) => {
          const svc = Services.available[name];
          const running = Services.running[name];
          return `
            <div style="border: 1px solid ${running ? "#4ade80" : "#ddd"}; padding: 16px; border-radius: 8px; background: ${running ? "#f0fdf4" : "#fafafa"};">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0;">${svc.icon} ${svc.name}</h3>
                <button type="button" class="ghost small" onclick="Services.uninstallService('${name}')">Uninstall</button>
              </div>
              <p class="fine">${svc.description}</p>

              <div style="margin: 12px 0;">
                <button type="button" class="${running ? "ghost" : "primary"}" onclick="Services.${running ? "stopService" : "startService"}('${name}')">
                  ${running ? "🟢 Running" : "🔴 Stopped"}
                </button>
                ${running ? `
                  <a href="http://localhost:${svc.port}" target="_blank" class="ghost small" style="margin-left: 8px;">Open</a>
                ` : ""}
              </div>
            </div>
          `;
        }).join("")}
      </div>

      <div style="border-top: 1px solid #ddd; padding-top: 20px;">
        ${renderServiceSetup()}
      </div>
    </div>
  `;
}
