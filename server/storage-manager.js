// Storage monitoring & management for optional services
// Warn when space is low, clean caches, manage retention

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process"; // For df/Get-Volume only

const SERVICES_DIR = path.join(process.env.HOME || process.env.USERPROFILE, ".freemessenger-services");
const WARN_THRESHOLD = 0.1; // Warn when <10% free space
const CRITICAL_THRESHOLD = 0.05; // Stop services when <5% free space

// Get disk space usage
export async function getDiskSpace() {
  try {
    let totalBytes, freeBytes;

    if (process.platform === "win32") {
      try {
        const output = execSync(`powershell -NoProfile "Get-Volume | Where-Object DriveLetter -eq (Split-Path -Qualifier $env:TEMP) | Select-Object Size,SizeRemaining"`).toString();
        const match = output.match(/(\d+)\s+(\d+)/);
        if (match) {
          totalBytes = Number(match[1]);
          freeBytes = Number(match[2]);
        }
      } catch (e) {
        return null;
      }
    } else {
      try {
        const dir = SERVICES_DIR || process.env.HOME || "/";
        const output = execSync(`df -B1 "${dir}" | tail -1`).toString();
        const parts = output.split(/\s+/);
        totalBytes = Number(parts[1]);
        freeBytes = Number(parts[3]);
      } catch (e) {
        return null;
      }
    }

    if (!totalBytes || !freeBytes) return null;
    const usedBytes = totalBytes - freeBytes;
    const usedPercent = (usedBytes * 100) / totalBytes;
    const freePercent = (freeBytes * 100) / totalBytes;

    return {
      total: Number(totalBytes),
      used: Number(usedBytes),
      free: Number(freeBytes),
      usedPercent,
      freePercent,
      warning: freePercent < WARN_THRESHOLD,
      critical: freePercent < CRITICAL_THRESHOLD
    };
  } catch (e) {
    return null;
  }
}

// Calculate directory size recursively
function getDirSize(dir) {
  let size = 0;
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      try {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          size += getDirSize(filePath);
        } else {
          size += stat.size;
        }
      } catch (e) {
        // Skip files we can't stat
      }
    }
  } catch (e) {
    // Skip directories we can't read
  }
  return size;
}

// Get service storage usage
export function getServiceStorage() {
  const usage = {};

  const serviceDirs = {
    jellyfin: path.join(SERVICES_DIR, "jellyfin"),
    jellyfin_cache: path.join(SERVICES_DIR, "jellyfin-cache"),
    plex: path.join(SERVICES_DIR, "plex"),
    audiobookshelf: path.join(SERVICES_DIR, "audiobookshelf"),
    sunshine: path.join(SERVICES_DIR, "sunshine")
  };

  for (const [name, dir] of Object.entries(serviceDirs)) {
    try {
      usage[name] = fs.existsSync(dir) ? getDirSize(dir) : 0;
    } catch (e) {
      usage[name] = 0;
    }
  }

  return usage;
}

// Clean service caches
export async function cleanCache(service) {
  const cacheDirs = {
    jellyfin: path.join(SERVICES_DIR, "jellyfin-cache"),
    plex: path.join(SERVICES_DIR, "plex", "metadata-cache"),
    sunshine: path.join(SERVICES_DIR, "sunshine", "cache")
  };

  const dir = cacheDirs[service];
  if (!dir || !fs.existsSync(dir)) return false;

  try {
    // Use fs.rmSync instead of shell commands to avoid injection attacks
    for (const file of fs.readdirSync(dir)) {
      const filePath = path.join(dir, file);
      fs.rmSync(filePath, { recursive: true, force: true });
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Remove old transcode files (older than N days)
export async function cleanOldTranscodes(service = "jellyfin", olderThanDays = 7) {
  const transcodeDirs = {
    jellyfin: path.join(SERVICES_DIR, "jellyfin-cache", "transcodes")
  };

  const dir = transcodeDirs[service];
  if (!dir) return 0;

  const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
  let removed = 0;

  try {
    if (!fs.existsSync(dir)) return 0;

    for (const file of fs.readdirSync(dir)) {
      try {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoffTime) {
          fs.rmSync(filePath, { recursive: true, force: true });
          removed++;
        }
      } catch (e) {
        // Continue on individual file errors
      }
    }
  } catch (e) {
    // Continue on directory read errors
  }

  return removed;
}

// Compress media metadata (reduce Plex/Jellyfin database sizes)
export async function compressMetadata(service) {
  const dbPaths = {
    jellyfin: path.join(SERVICES_DIR, "jellyfin", "metadata"),
    plex: path.join(SERVICES_DIR, "plex", "metadata")
  };

  const dir = dbPaths[service];
  if (!dir) return false;

  try {
    if (!fs.existsSync(dir)) return false;

    // Remove thumbnails and old art
    const thumbDir = path.join(dir, "thumbnails");
    if (fs.existsSync(thumbDir)) {
      for (const file of fs.readdirSync(thumbDir)) {
        try {
          fs.rmSync(path.join(thumbDir, file), { recursive: true, force: true });
        } catch (e) {
          // Continue on error
        }
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Get storage recommendations
export async function getStorageRecommendations() {
  const disk = await getDiskSpace();
  const serviceUsage = getServiceStorage();
  const recommendations = [];

  // Disk space warnings
  if (disk.critical) {
    recommendations.push({
      severity: "critical",
      message: "⚠️  CRITICAL: Less than 5% disk space free. Services may stop.",
      action: "Clean caches immediately or add more storage"
    });
  } else if (disk.warning) {
    recommendations.push({
      severity: "warning",
      message: "⚠️  WARNING: Less than 10% disk space free.",
      action: "Consider cleaning old transodes or archiving media"
    });
  }

  // Service-specific recommendations
  if (serviceUsage.jellyfin_cache > 50 * 1024 * 1024 * 1024) { // >50GB
    recommendations.push({
      severity: "info",
      service: "jellyfin",
      message: `Jellyfin cache is ${(serviceUsage.jellyfin_cache / 1024 / 1024 / 1024).toFixed(1)}GB`,
      action: "Clean transcodes or metadata cache"
    });
  }

  if ((serviceUsage.plex || 0) > 100 * 1024 * 1024 * 1024) { // >100GB
    recommendations.push({
      severity: "info",
      service: "plex",
      message: `Plex metadata is ${((serviceUsage.plex) / 1024 / 1024 / 1024).toFixed(1)}GB`,
      action: "Compress metadata or remove old artwork"
    });
  }

  return {
    disk,
    serviceUsage,
    recommendations
  };
}

export default {
  getDiskSpace,
  getServiceStorage,
  cleanCache,
  cleanOldTranscodes,
  compressMetadata,
  getStorageRecommendations
};
