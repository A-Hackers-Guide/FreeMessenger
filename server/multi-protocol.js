// Multi-protocol handler: WebSocket, gRPC, HTTP/2, custom binary
// All over encrypted channels with mutual TLS authentication

import { WebSocketServer } from "ws";
import spdy from "spdy";
import crypto from "node:crypto";

export class MultiProtocolGateway {
  constructor(secureContext) {
    this.secureContext = secureContext;
    this.handlers = new Map();
    this.messageQueue = new Map();
    this.encryptionKeys = new Map();
  }

  // Register protocol handler
  registerProtocol(name, handler) {
    this.handlers.set(name, handler);
  }

  // Create WebSocket secure server (WSS)
  createWebSocketServer(server) {
    const wss = new WebSocketServer({ server, perMessageDeflate: false });

    wss.on("connection", async (ws, req) => {
      const connId = crypto.randomUUID();
      const remoteIp = req.socket.remoteAddress;

      // Generate per-connection encryption key
      const sessionKey = crypto.randomBytes(32);
      this.encryptionKeys.set(connId, sessionKey);

      // Expect authentication message within 10 seconds
      const authTimeout = setTimeout(() => {
        ws.close(4001, "Authentication timeout");
      }, 10000);

      ws.once("message", async (data) => {
        clearTimeout(authTimeout);
        try {
          const authMsg = JSON.parse(data.toString());
          if (!await this.verifyAuth(authMsg, remoteIp)) {
            ws.close(4003, "Authentication failed");
            return;
          }

          // Mark as authenticated
          ws.authenticated = true;
          ws.connId = connId;

          ws.on("message", async (msg) => {
            await this.handleMessage(ws, connId, msg, "WSS");
          });
        } catch (e) {
          ws.close(4002, "Invalid auth format");
        }
      });

      ws.on("close", () => {
        this.encryptionKeys.delete(connId);
      });
    });

    return wss;
  }

  // Create HTTP/2 server (for gRPC and HTTP/2)
  createHTTP2Server(options) {
    const server = spdy.createSecureServer(options, async (req, res) => {
      const connId = crypto.randomUUID();
      const protocol = req.httpVersion === "2.0" ? "HTTP/2" : "HTTP/1.1";

      // Check authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      if (!await this.verifyAuth({ token: authHeader }, req.socket.remoteAddress)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }

      // Route to appropriate handler
      if (req.url.startsWith("/grpc")) {
        await this.handleGRPC(req, res, connId, protocol);
      } else {
        await this.handleHTTP2(req, res, connId, protocol);
      }
    });

    return server;
  }

  // Handle gRPC calls
  async handleGRPC(req, res, connId, protocol) {
    const [service, method] = req.url.split("/").filter(Boolean);
    const handler = this.handlers.get(`grpc:${service}:${method}`);

    if (!handler) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const result = await handler(req, res);
      res.writeHead(200, { "content-type": "application/grpc+proto" });
      res.end(result);
    } catch (e) {
      res.writeHead(500);
      res.end();
    }
  }

  // Handle HTTP/2 requests
  async handleHTTP2(req, res, connId, protocol) {
    const handler = this.handlers.get(`http2:${req.method}:${req.url}`);
    if (!handler) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      await handler(req, res);
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Handle generic message (encrypted)
  async handleMessage(ws, connId, encryptedData, protocol) {
    try {
      const sessionKey = this.encryptionKeys.get(connId);
      const msg = this.decrypt(encryptedData, sessionKey);
      const handler = this.handlers.get(`${protocol}:${msg.type}`);

      if (!handler) {
        ws.send(JSON.stringify({ error: "Unknown message type" }));
        return;
      }

      const response = await handler(msg, connId);
      const encrypted = this.encrypt(JSON.stringify(response), sessionKey);
      ws.send(encrypted);
    } catch (e) {
      ws.send(JSON.stringify({ error: "Processing error" }));
    }
  }

  // Encrypt with AES-256-GCM
  encrypt(data, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    let encrypted = cipher.update(data, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag();
    return JSON.stringify({
      iv: iv.toString("hex"),
      data: encrypted,
      tag: authTag.toString("hex")
    });
  }

  // Decrypt with AES-256-GCM
  decrypt(encryptedJson, key) {
    const { iv, data, tag } = JSON.parse(encryptedJson.toString());
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    let decrypted = decipher.update(data, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return JSON.parse(decrypted);
  }

  // Verify authentication (stub - implement with your auth system)
  async verifyAuth(authMsg, remoteIp) {
    // Verify JWT, HMAC, or certificate
    return true; // Replace with real verification
  }
}

export default MultiProtocolGateway;
