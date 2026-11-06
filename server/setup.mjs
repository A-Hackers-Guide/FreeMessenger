// Makes data/config.json for a new home relay: the sync key pair, a TURN
// secret, and your settings. Prints the public key for relay/wrangler.toml.
//   node setup.mjs <data folder> --admin yourname [--cap 100] [--backup URL] [--cloudflared PATH] [--public-url URL]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const dir = path.resolve(args[0] || "data");
const opt = (name, d) => { const i = args.indexOf("--" + name); return i === -1 ? d : args[i + 1]; };
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "config.json");
const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};

let syncKey = old.syncKey;
if (!syncKey) {
  const pair = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  syncKey = {
    privateJwk: await crypto.webcrypto.subtle.exportKey("jwk", pair.privateKey),
    publicJwk: await crypto.webcrypto.subtle.exportKey("jwk", pair.publicKey),
  };
}
const admins = opt("admin") ? opt("admin").split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")) : old.admins || [];
const config = {
  port: Number(opt("port", old.port || 8790)),
  admins,
  capGB: Number(opt("cap", old.capGB || 100)),
  backup: opt("backup", old.backup || "https://freemessenger-relay.a-hackers-guide.workers.dev"),
  cloudflared: opt("cloudflared", old.cloudflared || ""),
  publicUrl: opt("public-url", old.publicUrl || ""),
  turn: old.turn || { secret: crypto.randomBytes(32).toString("hex"), port: Number(opt("turn-port", 3478)) },
  syncKey,
};
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log("Saved " + file);
console.log("PRIMARY_KEY=" + JSON.stringify(syncKey.publicJwk));
