// Keeps this computer's relay up to date with the project's own GitHub repo.
//
// Every few hours the server asks GitHub for the newest version. When there is
// one, this downloads just the relay's code, makes sure every file parses,
// swaps them in (keeping a copy of the old ones under app/.prev), and reports
// back so the server can restart on the new code. Anything goes wrong — no
// network, a half-written download, a file that won't parse — and it changes
// nothing and tries again next time.
//
// It only ever pulls the handful of files the relay is made of, checks their
// syntax before swapping, and refuses a core file that came back suspiciously
// small, so a bad download can't brick the relay. Set "autoUpdate": false in
// config.json to turn it off.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_REPO = "a-hackers-guide/FreeMessenger";
const DEFAULT_BRANCH = "main";

// The files the relay is made of, and where each one lives under the app folder.
const FILES = [
  ["server/server.js", "server/server.js"],
  ["server/gateway.js", "server/gateway.js"],
  ["server/update.js", "server/update.js"],
  ["server/proxy.js", "server/proxy.js"],
  ["server/setup.mjs", "server/setup.mjs"],
  ["server/package.json", "server/package.json"],
  ["server/package-lock.json", "server/package-lock.json"],
  ["relay/src/shared.js", "relay/src/shared.js"],
];

async function latestSha(repo, branch) {
  const r = await fetch(`https://api.github.com/repos/${repo}/commits/${branch}`, {
    headers: { "User-Agent": "FreeMessenger-updater", Accept: "application/vnd.github.sha" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("github " + r.status);
  const sha = (await r.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("bad sha");
  return sha;
}

async function fetchFile(repo, sha, p) {
  const r = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${p}`, {
    headers: { "User-Agent": "FreeMessenger-updater" }, signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Checks for a newer version and, if there is one, applies it. Returns
// { updated, sha, reason }. Never throws.
export async function checkAndUpdate({ appDir, dataDir, repo = DEFAULT_REPO, branch = DEFAULT_BRANCH, currentSha, log = () => {} } = {}) {
  try {
    const verFile = path.join(dataDir, "version.json");
    if (currentSha === undefined) {
      try { currentSha = JSON.parse(fs.readFileSync(verFile, "utf8")).sha; } catch { currentSha = null; }
    }
    const sha = await latestSha(repo, branch);
    if (sha === currentSha) return { updated: false, reason: "up to date", sha };

    // Download everything first; abort on any failure so we never apply a partial set.
    const staged = [];
    for (const [remote, local] of FILES) {
      const buf = await fetchFile(repo, sha, remote);
      if (local.endsWith(".js") && buf.length < 200) return { updated: false, reason: "suspicious tiny file " + remote };
      staged.push([local, buf]);
    }

    // Check every .js parses, in a scratch folder, before touching anything live.
    const tmp = path.join(dataDir, ".update-" + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    try {
      for (const [local, buf] of staged) {
        if (!local.endsWith(".js")) continue;
        const f = path.join(tmp, path.basename(local));
        fs.writeFileSync(f, buf);
        try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
        catch { throw new Error("new " + local + " doesn't parse — skipped"); }
      }
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }

    // If every file already matches (e.g. first run with no stored version),
    // just record the version — no need to rewrite files or restart.
    const changed = staged.some(([local, buf]) => {
      const dest = path.join(appDir, local);
      try { return !fs.existsSync(dest) || !fs.readFileSync(dest).equals(buf); } catch { return true; }
    });
    if (!changed) { try { fs.writeFileSync(path.join(dataDir, "version.json"), JSON.stringify({ sha, at: Date.now() })); } catch {} return { updated: false, reason: "already current", sha }; }

    // Swap the files in, keeping the old ones under app/.prev for rollback.
    const prev = path.join(appDir, ".prev");
    fs.mkdirSync(prev, { recursive: true });
    let pkgChanged = false;
    for (const [local, buf] of staged) {
      const dest = path.join(appDir, local);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const old = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
      if (old) { try { fs.writeFileSync(path.join(prev, path.basename(local)), old); } catch {} }
      if (local.endsWith("package.json") && (!old || !old.equals(buf))) pkgChanged = true;
      fs.writeFileSync(dest, buf);
    }

    // Only reinstall dependencies when the package files actually changed.
    if (pkgChanged) {
      try { execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: path.join(appDir, "server"), stdio: "pipe" }); }
      catch (e) { log("update: npm ci failed (" + e.message + ") — keeping existing packages"); }
    }

    fs.writeFileSync(verFile, JSON.stringify({ sha, at: Date.now() }));
    return { updated: true, sha, pkgChanged };
  } catch (e) {
    return { updated: false, reason: String(e && e.message || e) };
  }
}
