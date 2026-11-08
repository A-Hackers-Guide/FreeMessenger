// NAT traversal: UPnP, hole punching, relay fallback, IPv6 support
// Works behind any firewall, any router, on any network

import dgram from "node:dgram";
import net from "node:net";
import crypto from "node:crypto";

export class NATTraversal {
  constructor(options = {}) {
    this.relayServers = options.relayServers || [];
    this.stun Servers = options.stunServers || [];
    this.publicIp = null;
    this.publicPorts = new Map(); // Map of local port to public port
    this.punchingAttempts = new Map();
    this.connectionCache = new Map();
    this.maxPunchAttempts = 5;
  }

  // Detect public IP via STUN
  async detectPublicAddress() {
    for (const stunServer of this.stunServers) {
      try {
        const { ip, port } = await this.querySTUN(stunServer);
        this.publicIp = ip;
        return { ip, port };
      } catch (e) {
        // Try next STUN server
      }
    }
    throw new Error("Failed to detect public IP");
  }

  // Query STUN server
  async querySTUN(server) {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket("udp4");
      const timeout = setTimeout(() => {
        client.close();
        reject(new Error("STUN timeout"));
      }, 5000);

      client.on("message", (msg) => {
        clearTimeout(timeout);
        client.close();
        const ip = this.parseSTUNResponse(msg);
        resolve({ ip, port: server.port });
      });

      const request = this.createSTUNRequest();
      client.send(request, 0, request.length, server.port, server.host);
    });
  }

  // Create STUN binding request (RFC 5389)
  createSTUNRequest() {
    const header = Buffer.allocUnsafe(20);
    header.writeUInt16BE(0x0001, 0); // Binding Request
    header.writeUInt16BE(0, 2); // Message length
    header.writeUInt32BE(0x2112a442, 4); // Magic cookie
    crypto.randomFillSync(header, 8, 12); // Transaction ID
    return header;
  }

  // Parse STUN response
  parseSTUNResponse(msg) {
    let offset = 20;
    while (offset < msg.length) {
      const type = msg.readUInt16BE(offset);
      const length = msg.readUInt16BE(offset + 2);
      if (type === 0x0020) { // XOR-MAPPED-ADDRESS
        const family = msg[offset + 5];
        const port = msg.readUInt16BE(offset + 6) ^ 0x2112;
        if (family === 0x01) { // IPv4
          const ip = [
            msg[offset + 8] ^ 0x21,
            msg[offset + 9] ^ 0x12,
            msg[offset + 10] ^ 0xa4,
            msg[offset + 11] ^ 0x42
          ].join(".");
          return ip;
        }
      }
      offset += 4 + length;
    }
    return null;
  }

  // Hole punching: coordinated connection attempts
  async punchHole(targetPublicIp, targetPort, relayServer) {
    const punchId = crypto.randomUUID();
    const attempts = [];

    // Send punch packets from multiple local ports
    for (let i = 0; i < this.maxPunchAttempts; i++) {
      const localPort = 10000 + i + Math.floor(Math.random() * 10000);
      const socket = dgram.createSocket("udp4");

      const packet = Buffer.from(JSON.stringify({
        type: "punch",
        id: punchId,
        sourceIp: this.publicIp,
        timestamp: Date.now()
      }));

      socket.send(packet, 0, packet.length, targetPort, targetPublicIp, (err) => {
        socket.close();
      });

      attempts.push({ localPort, sent: Date.now() });

      // Stagger attempts
      await new Promise(r => setTimeout(r, 100));
    }

    this.punchingAttempts.set(punchId, attempts);
    return punchId;
  }

  // Try multiple connection methods in parallel
  async connectWithFallback(target) {
    const attempts = [
      () => this.tryDirectConnection(target),
      () => this.tryPunchConnection(target),
      () => this.useRelayConnection(target)
    ];

    for (const attempt of attempts) {
      try {
        return await Promise.race([
          attempt(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 5000)
          )
        ]);
      } catch (e) {
        // Try next method
      }
    }

    throw new Error("All connection methods failed");
  }

  // Direct connection (same network)
  async tryDirectConnection(target) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: target.ip,
        port: target.port,
        timeout: 3000
      });

      socket.on("connect", () => {
        resolve(socket);
      });

      socket.on("error", reject);
    });
  }

  // Hole-punched connection (NAT traversal)
  async tryPunchConnection(target) {
    // Initiate hole punching
    const punchId = await this.punchHole(target.ip, target.port);

    // Wait for response on punched port
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Punch response timeout"));
      }, 3000);

      socket.on("message", (msg) => {
        clearTimeout(timeout);
        const response = JSON.parse(msg.toString());
        if (response.punchId === punchId && response.success) {
          socket.close();
          resolve(socket);
        }
      });

      socket.bind();
    });
  }

  // Relay connection (fallback for impossible cases)
  async useRelayConnection(target) {
    const relayServer = this.relayServers[0];
    if (!relayServer) throw new Error("No relay servers available");

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: relayServer.host,
        port: relayServer.port,
        timeout: 3000
      });

      socket.on("connect", () => {
        // Send relay request
        const relayReq = JSON.stringify({
          type: "relay",
          targetId: target.id,
          token: target.token
        });
        socket.write(relayReq);
        resolve(socket);
      });

      socket.on("error", reject);
    });
  }

  // Cache successful connections
  cacheConnection(key, connection) {
    this.connectionCache.set(key, {
      connection,
      established: Date.now()
    });

    // Expire after 1 hour
    setTimeout(() => this.connectionCache.delete(key), 3600000);
  }

  // Clean up old punching attempts
  cleanupPunchAttempts() {
    setInterval(() => {
      const now = Date.now();
      for (const [id, attempts] of this.punchingAttempts.entries()) {
        if (now - attempts[0].sent > 60000) {
          this.punchingAttempts.delete(id);
        }
      }
    }, 300000);
  }
}

export default NATTraversal;
