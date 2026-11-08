// Enterprise audit logging: security events, access logs, anomaly detection
// Immutable event chain with tamper detection

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class AuditLogger {
  constructor(options = {}) {
    this.logDir = options.logDir || "./.freemessenger-audit";
    this.encryptionKey = options.encryptionKey || crypto.randomBytes(32);
    this.events = [];
    this.previousHash = Buffer.alloc(32); // Hash of previous entry for chain
    this.createLogDirectory();
  }

  createLogDirectory() {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
      }
    } catch (e) {
      console.error("Failed to create audit log directory");
    }
  }

  // Log security event with cryptographic chain
  logEvent(eventType, details) {
    const event = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: eventType,
      details,
      previousHash: this.previousHash.toString("hex"),
      severity: this.getSeverity(eventType)
    };

    // Compute hash for this event
    const eventHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(event))
      .digest();

    event.hash = eventHash.toString("hex");
    this.previousHash = eventHash;

    this.events.push(event);

    // Write to immutable log
    this.writeToLog(event);

    // Check for anomalies
    this.detectAnomaly(event);

    return event;
  }

  // Write event to encrypted, immutable log file
  writeToLog(event) {
    try {
      const logEntry = JSON.stringify(event) + "\n";
      const logFile = path.join(this.logDir, `audit-${this.getDate()}.log`);

      // Encrypt before writing
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
      let encrypted = cipher.update(logEntry, "utf8", "hex");
      encrypted += cipher.final("hex");
      const tag = cipher.getAuthTag();

      const encryptedEntry = JSON.stringify({
        iv: iv.toString("hex"),
        data: encrypted,
        tag: tag.toString("hex")
      }) + "\n";

      fs.appendFileSync(logFile, encryptedEntry, { flag: "a", mode: 0o600 });
    } catch (e) {
      console.error("Failed to write audit log:", e.message);
    }
  }

  // Get event severity
  getSeverity(eventType) {
    const severityMap = {
      "auth-failure": "high",
      "unauthorized-access": "critical",
      "invalid-token": "high",
      "rate-limit-exceeded": "medium",
      "connection-established": "low",
      "session-started": "low",
      "encryption-error": "high",
      "certificate-invalid": "critical",
      "malformed-message": "medium",
      "replay-attack-detected": "critical"
    };
    return severityMap[eventType] || "medium";
  }

  // Anomaly detection
  detectAnomaly(event) {
    // Rate limit violations
    const recentEvents = this.events.filter(
      e => new Date(e.timestamp) > new Date(Date.now() - 60000)
    );

    const sameTypeCount = recentEvents.filter(e => e.type === event.type).length;
    if (sameTypeCount > 100) {
      this.logEvent("rate-limit-exceeded", {
        eventType: event.type,
        count: sameTypeCount
      });
    }

    // Repeated failures
    if (event.type === "auth-failure") {
      const failures = recentEvents.filter(
        e => e.type === "auth-failure" &&
        e.details.user === event.details.user
      );
      if (failures.length > 5) {
        this.logEvent("brute-force-detected", {
          user: event.details.user,
          attemptCount: failures.length
        });
      }
    }

    // Geographic anomalies
    if (event.details.ip && this.shouldAlertGeographic(event.details.ip)) {
      this.logEvent("geographic-anomaly", {
        ip: event.details.ip,
        lastIp: this.getLastIpForUser(event.details.user)
      });
    }
  }

  shouldAlertGeographic(ip) {
    // Check if IP is from different geographic region than recent logins
    // Stub implementation
    return false;
  }

  getLastIpForUser(user) {
    const userEvents = this.events.filter(
      e => e.details && e.details.user === user
    );
    return userEvents.length > 0 ? userEvents[userEvents.length - 1].details.ip : null;
  }

  // Verify log integrity
  verifyIntegrity() {
    let previousHash = Buffer.alloc(32);
    let corrupted = false;

    for (const event of this.events) {
      if (event.previousHash !== previousHash.toString("hex")) {
        console.warn(`Integrity violation at event ${event.id}`);
        corrupted = true;
      }

      const expectedHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(event))
        .digest()
        .toString("hex");

      if (event.hash !== expectedHash) {
        console.warn(`Hash mismatch at event ${event.id}`);
        corrupted = true;
      }

      previousHash = Buffer.from(event.hash, "hex");
    }

    return !corrupted;
  }

  // Export logs for compliance
  exportLogs(startDate, endDate) {
    const filtered = this.events.filter(e => {
      const eventDate = new Date(e.timestamp);
      return eventDate >= startDate && eventDate <= endDate;
    });

    const csv = [
      "timestamp,event_type,severity,user,ip,details,hash"
    ];

    for (const event of filtered) {
      csv.push([
        event.timestamp,
        event.type,
        event.severity,
        event.details.user || "system",
        event.details.ip || "unknown",
        JSON.stringify(event.details).replace(/"/g, '""'),
        event.hash
      ].map(v => `"${v}"`).join(","));
    }

    return csv.join("\n");
  }

  // Critical event alert
  logCritical(message, details) {
    const event = this.logEvent("critical-alert", { message, ...details });
    console.error(`[CRITICAL] ${message}`, details);
    // Could send to monitoring system
    return event;
  }

  getDate() {
    return new Date().toISOString().split("T")[0];
  }
}

// Connection monitoring
export class ConnectionMonitor {
  constructor() {
    this.connections = new Map();
    this.suspiciousPatterns = [];
  }

  trackConnection(connId, metadata) {
    this.connections.set(connId, {
      id: connId,
      ...metadata,
      established: Date.now(),
      bytesIn: 0,
      bytesOut: 0,
      messagesIn: 0,
      messagesOut: 0
    });
  }

  updateConnection(connId, data) {
    const conn = this.connections.get(connId);
    if (conn) {
      conn.bytesIn += data.bytesIn || 0;
      conn.bytesOut += data.bytesOut || 0;
      conn.messagesIn += data.messagesIn || 0;
      conn.messagesOut += data.messagesOut || 0;

      // Detect unusual patterns
      if (conn.bytesIn > 100 * 1024 * 1024) { // 100MB in 1 connection
        this.suspiciousPatterns.push({
          type: "large-transfer",
          connId,
          bytes: conn.bytesIn
        });
      }
    }
  }

  endConnection(connId) {
    this.connections.delete(connId);
  }

  getMetrics() {
    const conns = Array.from(this.connections.values());
    return {
      activeConnections: conns.length,
      totalBytesIn: conns.reduce((sum, c) => sum + c.bytesIn, 0),
      totalBytesOut: conns.reduce((sum, c) => sum + c.bytesOut, 0),
      totalMessages: conns.reduce((sum, c) => sum + c.messagesIn + c.messagesOut, 0),
      suspiciousPatterns: this.suspiciousPatterns
    };
  }
}

export { AuditLogger, ConnectionMonitor };
