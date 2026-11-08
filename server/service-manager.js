// Optional services manager: Moonlight, Jellyfin, Plex, Audiobookshelf, Sunshine
// Start, stop, and manage these services from the FreeMessenger app

import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execAsync = promisify(exec);
const SERVICES_DIR = path.join(process.env.HOME || process.env.USERPROFILE, ".freemessenger-services");

const SERVICES = {
  sunshine: {
    cmd: "sunshine",
    port: 47989,
    args: ["--config", path.join(SERVICES_DIR, "sunshine.conf")],
    healthCheck: "http://localhost:47989/api/version"
  },
  jellyfin: {
    cmd: "jellyfin",
    port: 8096,
    args: ["--datadir", path.join(SERVICES_DIR, "jellyfin"), "--cachedir", path.join(SERVICES_DIR, "jellyfin-cache")],
    healthCheck: "http://localhost:8096/api/system/info"
  },
  plex: {
    cmd: "plex",
    port: 32400,
    healthCheck: "http://localhost:32400/identity"
  },
  audiobookshelf: {
    cmd: "audiobookshelf",
    port: 13378,
    args: ["--port", "13378", "--config", path.join(SERVICES_DIR, "audiobookshelf")],
    healthCheck: "http://localhost:13378/api/status"
  }
};

let runningServices = {};

// Initialize services directory
function initServicesDir() {
  if (!fs.existsSync(SERVICES_DIR)) {
    fs.mkdirSync(SERVICES_DIR, { recursive: true });
  }
}

// Start a service
export async function startService(serviceName) {
  if (runningServices[serviceName]) return true; // Already running

  const svc = SERVICES[serviceName];
  if (!svc) return false;

  try {
    const proc = spawn(svc.cmd, svc.args || [], { detached: true, stdio: "ignore" });
    proc.unref(); // Allow parent to exit
    runningServices[serviceName] = { pid: proc.pid, started: Date.now() };
    
    // Wait for health check
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(svc.healthCheck, { timeout: 1000 });
        if (res.ok) return true;
      } catch (e) {
        // Not ready yet
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    
    return false; // Health check failed
  } catch (e) {
    console.error(`Failed to start ${serviceName}:`, e.message);
    return false;
  }
}

// Stop a service
export async function stopService(serviceName) {
  const svc = runningServices[serviceName];
  if (!svc) return true; // Not running

  try {
    if (process.platform === "win32") {
      await execAsync(`taskkill /PID ${svc.pid} /F`);
    } else {
      await execAsync(`kill -9 ${svc.pid}`);
    }
    delete runningServices[serviceName];
    return true;
  } catch (e) {
    return false;
  }
}

// Check if service is running
export function isServiceRunning(serviceName) {
  return !!runningServices[serviceName];
}

// Install a service (stubbed - real install would download/extract binaries)
export async function installService(serviceName, config) {
  initServicesDir();
  
  // Save config
  const configFile = path.join(SERVICES_DIR, `${serviceName}.json`);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  
  console.log(`[Services] ${serviceName} installed with config:`, config);
  return true;
}

// Get service status
export function getServiceStatus(serviceName) {
  const svc = SERVICES[serviceName];
  if (!svc) return null;
  
  return {
    name: serviceName,
    port: svc.port,
    running: isServiceRunning(serviceName),
    healthCheck: svc.healthCheck
  };
}

// List all services and their status
export function listServices() {
  return Object.keys(SERVICES).map(name => getServiceStatus(name)).filter(Boolean);
}

// Auto-start enabled services on startup
export function autoStartServices() {
  initServicesDir();
  
  // Read enabled services from config
  try {
    const enabledFile = path.join(SERVICES_DIR, "enabled.json");
    if (fs.existsSync(enabledFile)) {
      const enabled = JSON.parse(fs.readFileSync(enabledFile, "utf8"));
      for (const serviceName of enabled) {
        startService(serviceName).catch(e => console.error(`Auto-start ${serviceName} failed:`, e.message));
      }
    }
  } catch (e) {
    console.error("Error reading enabled services:", e.message);
  }
}

// Stop all services on shutdown
export async function stopAllServices() {
  const promises = Object.keys(runningServices).map(name => stopService(name));
  await Promise.all(promises);
}

export default { startService, stopService, isServiceRunning, installService, getServiceStatus, listServices, autoStartServices, stopAllServices };
