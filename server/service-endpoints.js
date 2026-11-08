// HTTP endpoints for service management (add these to server.js)
// POST /api/service/start
// POST /api/service/stop
// GET /api/services

import * as SM from "./service-manager.js";

const VALID_SERVICES = new Set(["sunshine", "moonlight", "jellyfin", "plex", "audiobookshelf"]);

function isValidService(name) {
  return typeof name === "string" && VALID_SERVICES.has(name);
}

export function setupServiceEndpoints(app) {
  // Start a service
  app.post("/api/service/start", async (req, res) => {
    const { service } = req.body;
    if (!isValidService(service)) return res.status(400).json({ error: "Invalid service" });

    const success = await SM.startService(service);
    res.json({ ok: success, status: SM.getServiceStatus(service) });
  });

  // Stop a service
  app.post("/api/service/stop", async (req, res) => {
    const { service } = req.body;
    if (!isValidService(service)) return res.status(400).json({ error: "Invalid service" });

    const success = await SM.stopService(service);
    res.json({ ok: success, status: SM.getServiceStatus(service) });
  });

  // Install a service
  app.post("/api/service/install", async (req, res) => {
    const { service, config } = req.body;
    if (!isValidService(service)) return res.status(400).json({ error: "Invalid service" });

    const success = await SM.installService(service, config);
    res.json({ ok: success });
  });

  // List all services
  app.get("/api/services", (req, res) => {
    res.json({ services: SM.listServices() });
  });

  // Health check for a service
  app.get("/api/service/:name/health", (req, res) => {
    const name = req.params.name;
    if (!isValidService(name)) return res.status(404).json({ error: "Service not found" });
    const status = SM.getServiceStatus(name);
    if (!status) return res.status(404).json({ error: "Service not found" });
    res.json({ ...status });
  });
}

export default setupServiceEndpoints;
