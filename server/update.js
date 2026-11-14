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
import crypto from "node:crypto";
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

// The newest commit id, from GitHub. When GitHub itself is blocked this throws,
// and the updater falls back to fetching by branch from a mirror and tracking a
// content hash instead (see checkAndUpdate), so updates still get through.
async function latestSha(repo, branch) {
  const r = await fetch(`https://api.github.com/repos/${repo}/commits/${branch}`, { headers: { "User-Agent": "FreeMessenger-updater", Accept: "application/vnd.github.sha" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error("github " + r.status);
  const sha = (await r.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("bad sha");
  return sha;
}

// The same files on independent networks. raw.githubusercontent is GitHub
// itself; jsDelivr is a separate global CDN that mirrors public repos, so the
// code can still update where GitHub's own domains are blocked. `ref` is a
// commit id (normally) or a branch name (GitHub-blocked fallback).
const FILE_MIRRORS = [
  (repo, ref, p) => `https://raw.githubusercontent.com/${repo}/${ref}/${p}`,
  (repo, ref, p) => `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${p}`,
];

async function fetchFile(repo, ref, p) {
  for (const mk of FILE_MIRRORS) {
    try {
      const r = await fetch(mk(repo, ref, p), { headers: { "User-Agent": "FreeMessenger-updater" }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch {}
  }
  throw new Error(`fetch ${p}: all mirrors failed`);
}

// Checks for a newer version and, if there is one, applies it. Returns
// { updated, sha, reason }. Never throws.
export async function checkAndUpdate({ appDir, dataDir, repo = DEFAULT_REPO, branch = DEFAULT_BRANCH, currentSha, log = () => {} } = {}) {
  try {
    const verFile = path.join(dataDir, "version.json");
    if (currentSha === undefined) {
      try { currentSha = JSON.parse(fs.readFileSync(verFile, "utf8")).sha; } catch { currentSha = null; }
    }
    // Normally we track the commit id from GitHub. If GitHub is blocked, we
    // fetch the branch from a mirror instead and track a hash of the code.
    let sha = null;
    try { sha = await latestSha(repo, branch); } catch {}
    if (sha && sha === currentSha) return { updated: false, reason: "up to date", sha };
    const ref = sha || branch;

    // Download everything first; abort on any failure so we never apply a partial set.
    const staged = [];
    for (const [remote, local] of FILES) {
      const buf = await fetchFile(repo, ref, remote);
      if (local.endsWith(".js") && buf.length < 200) return { updated: false, reason: "suspicious tiny file " + remote };
      staged.push([local, buf]);
    }
    // The version marker: the commit id, or a hash of the files when GitHub was
    // unreachable (so new code is still noticed on the fallback path).
    const versionId = sha || "c:" + crypto.createHash("sha256").update(Buffer.concat(staged.map((s) => s[1]))).digest("hex").slice(0, 38);
    if (versionId === currentSha) return { updated: false, reason: "up to date", sha: versionId };

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
    if (!changed) { try { fs.writeFileSync(verFile, JSON.stringify({ sha: versionId, at: Date.now() })); } catch {} return { updated: false, reason: "already current", sha: versionId }; }

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
      // Fixed, constant arguments (no user input), so shell:true is safe here and
      // is what lets npm.cmd run on Windows.
      try { execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: path.join(appDir, "server"), stdio: "pipe", shell: true }); }
      catch (e) { log("update: npm ci failed (" + e.message + ") — keeping existing packages"); }
    }

    fs.writeFileSync(verFile, JSON.stringify({ sha: versionId, at: Date.now() }));
    return { updated: true, sha: versionId, pkgChanged };
  } catch (e) {
    return { updated: false, reason: String(e && e.message || e) };
  }
}
