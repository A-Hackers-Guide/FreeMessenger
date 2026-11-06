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
  adminPins: old.adminPins || {},
  adminTotp: old.adminTotp && !args.includes("--reset-2fa") ? old.adminTotp : null,
};
// Pins only last for the same admin names.
for (const name of Object.keys(config.adminPins)) if (!admins.includes(name)) delete config.adminPins[name];
if (args.includes("--reset-admin-key")) config.adminPins = {};

// The admin panel's second step: a code from an authenticator app. The secret
// goes in a file on this computer only, never on screen or in the repo.
if (!config.adminTotp) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  config.adminTotp = Array.from(crypto.randomBytes(32), (b) => alphabet[b & 31]).join("");
  const grouped = config.adminTotp.match(/.{1,4}/g).join(" ");
  const uri = `otpauth://totp/FreeMessenger:admin?secret=${config.adminTotp}&issuer=FreeMessenger&digits=6&period=30`;
  fs.writeFileSync(path.join(dir, "admin-2fa.txt"), [
    "FreeMessenger admin code setup",
    "",
    "1. Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 2FAS, Aegis...).",
    "2. Add an account -> \"Enter a setup key\" (not \"Scan a QR code\").",
    "3. Name: FreeMessenger admin. Key: " + grouped + ". Type: time based.",
    "4. Delete this file once it's added. Anyone who sees this key can make admin codes.",
    "",
    "Or open this link on the phone if your app supports it:",
    uri,
    "",
  ].join("\r\n"), { mode: 0o600 });
  console.log("New admin code secret saved. Set up your authenticator app from " + path.join(dir, "admin-2fa.txt"));
}
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log("Saved " + file);
console.log("PRIMARY_KEY=" + JSON.stringify(syncKey.publicJwk));
