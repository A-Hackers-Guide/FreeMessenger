// Service gateway.
//
// This exposes THIS computer's own local services — Plex, Jellyfin,
// Audiobookshelf, Sunshine and anything else the owner lists — to the owner
// (and people the owner explicitly shares with), through the relay this
// computer already runs. So each person's own PC carries only their own
// traffic.
//
// It is deliberately NOT proxy.js. proxy.js is the locked-down PUBLIC web
// viewer: it blocks the LAN and strips scripts. This is the opposite — a full,
// streaming, scripts-and-websockets passthrough — so it is fenced in hard:
//
//   * Only a fixed allowlist of the owner's OWN services is reachable. There
//     is no request-controlled host or port, so it can't be pointed at the
//     rest of the LAN or the internet (no SSRF).
//   * Every request needs a short-lived ticket, and a ticket is only ever
//     handed to a signed-in account that is the owner or on the share list.
//   * Services are reached on 127.0.0.1 only.
//
// server.js calls issueTicket() from inside an authenticated op, and routes
// /svc/<ticket>/<id>/... (and websocket upgrades) here.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";

// Well-known self-hosted services and the localhost port each listens on. The
// owner's config.json can override ports, drop entries, or add custom ones.
export const KNOWN = {
  plex: { name: "Plex", port: 32400, icon: "🎥" },
  jellyfin: { name: "Jellyfin", port: 8096, icon: "🎬" },
  emby: { name: "Emby", port: 8096, icon: "🎬" },
  audiobookshelf: { name: "Audiobookshelf", port: 13378, icon: "🎧" },
  navidrome: { name: "Navidrome", port: 4533, icon: "🎵" },
  sunshine: { name: "Sunshine", port: 47990, icon: "🎮", https: true },
  qbittorrent: { name: "qBittorrent", port: 8080, icon: "⬇️" },
  homeassistant: { name: "Home Assistant", port: 8123, icon: "🏠" },
};

// ---------- the owner's service list ----------

// A clean, validated list from config.json, falling back to the known set.
// Each entry: { id, name, port, icon, https }.
export function services(config) {
  const raw = config && Array.isArray(config.services) ? config.services : null;
  const out = [];
  const seen = new Set();
  const add = (id, def) => {
    id = String(id || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!id || seen.has(id)) return;
    const port = Number(def.port);
    if (!(port >= 1 && port <= 65535)) return;
    seen.add(id);
    out.push({ id, name: String(def.name || id).slice(0, 40), port, icon: String(def.icon || "🔌").slice(0, 8), https: !!def.https });
  };
  if (raw) {
    for (const s of raw) add(s.id || s.name, s);
  } else {
    for (const id of Object.keys(KNOWN)) add(id, KNOWN[id]);
  }
  return out;
}

function find(config, id) {
  id = String(id || "").toLowerCase();
  return services(config).find((s) => s.id === id) || null;
}

// Who may open services: the owner always, plus any username the owner put on
// config.gatewayShare. `isOwner` is passed in (server.js knows isSuper/admin).
export function allowed(config, username, isOwner) {
  if (isOwner) return true;
  const share = (config && Array.isArray(config.gatewayShare) ? config.gatewayShare : []).map((u) => String(u).toLowerCase());
  return share.includes(String(username).toLowerCase());
}

// ---------- discovery ----------

// A service is "up" if something is listening on its localhost port. A plain
// TCP connect works for every service (HTTP, HTTPS, anything) and never needs
// a per-service health URL.
export function probe(port, timeout = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
    sock.setTimeout(timeout, () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(false));
  });
}

export async function status(config) {
  const list = services(config);
  await Promise.all(list.map(async (s) => { s.running = await probe(s.port); }));
  return list;
}

// ---------- tickets ----------

const tickets = new Map(); // token -> { username, until }
const TICKET_MS = 2 * 3600e3;
const rnd = () => crypto.randomBytes(20).toString("hex"); // 40 hex chars

export function issueTicket(username) {
  for (const [t, v] of tickets) if (v.until < Date.now()) tickets.delete(t);
  const token = rnd();
  tickets.set(token, { username: String(username), until: Date.now() + TICKET_MS });
  return token;
}

export function checkTicket(token) {
  const v = tickets.get(String(token || ""));
  if (!v || v.until < Date.now()) return null;
  return v.username;
}

// ---------- the reverse proxy ----------

// Hop-by-hop headers must not be forwarded.
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function cleanHeaders(headers) {
  const out = {};
  for (const k of Object.keys(headers)) if (!HOP.has(k.toLowerCase())) out[k] = headers[k];
  return out;
}

// Proxies one HTTP request to the service and streams the answer back.
// `base` is the public path prefix (/svc/<token>/<id>) so redirects can be
// rewritten to stay inside the gateway.
export function proxyHttp(req, res, svc, rest, base) {
  const lib = svc.https ? https : http;
  const headers = cleanHeaders(req.headers);
  headers.host = "127.0.0.1:" + svc.port;
  delete headers["accept-encoding"]; // let us rewrite redirects without fighting compression
  const options = {
    host: "127.0.0.1", port: svc.port, method: req.method,
    path: rest || "/", headers,
    rejectUnauthorized: false, // local self-signed (e.g. Sunshine) is fine
    timeout: 30000,
  };
  const up = lib.request(options, (upRes) => {
    const h = cleanHeaders(upRes.headers);
    // Keep redirects inside the gateway prefix.
    if (h.location && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(h.location)) {
      h.location = base + h.location.replace(/^https?:\/\/[^/]+/i, "");
    } else if (h.location && h.location.startsWith("/")) {
      h.location = base + h.location;
    }
    res.writeHead(upRes.statusCode || 502, h);
    upRes.pipe(res);
  });
  up.on("timeout", () => up.destroy(new Error("service timeout")));
  up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end("Service isn't reachable."); });
  req.pipe(up);
}

// Proxies a websocket upgrade to the service (Plex/Jellyfin notifications,
// Home Assistant, etc.). server.js calls this from its 'upgrade' handler.
export function proxyWs(req, socket, head, svc, rest) {
  const headers = cleanHeaders(req.headers);
  headers.host = "127.0.0.1:" + svc.port;
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade;
  const up = http.request({ host: "127.0.0.1", port: svc.port, method: req.method, path: rest || "/", headers });
  up.on("upgrade", (upRes, upSocket) => {
    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (const k of Object.keys(upRes.headers)) lines.push(`${k}: ${upRes.headers[k]}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upSocket.unshift(head);
    socket.pipe(upSocket);
    upSocket.pipe(socket);
  });
  up.on("error", () => { try { socket.destroy(); } catch {} });
  up.end();
}

// Parses /svc/<token>/<id>/<rest...> and returns what the caller needs, or an
// error. Pure; no side effects.
export function route(pathname, config) {
  const m = /^\/svc\/([0-9a-f]{40})\/([a-z0-9_-]+)(\/.*|)$/i.exec(pathname);
  if (!m) return { error: "not found", code: 404 };
  const username = checkTicket(m[1]);
  if (!username) return { error: "The service link expired. Open it again from FreeMessenger.", code: 403 };
  const svc = find(config, m[2]);
  if (!svc) return { error: "No such service.", code: 404 };
  return { username, svc, rest: m[3] || "/", base: `/svc/${m[1]}/${m[2]}` };
}
