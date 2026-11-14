// Which relay to talk to. The main one runs on the site owner's computer and
// its address changes when it restarts, so an always-on backup relay (on
// Cloudflare, RELAY_URL) says where it is. If the main one can't be reached,
// everything goes through a backup, and the two copy messages to each other.
//
// You can add more backups in Settings — another domain for the same relay, a
// friend's relay, or a proxy that forwards to one — so a block on the built-in
// one (or on GitHub/Cloudflare) is routed around by the next.

import { RELAY_URL } from "./config.js";
import { request } from "./transport.js";
import { store } from "./store.js";

export const extraRelays = () => (store.get("relays.extra", []) || []).filter((u) => /^https?:\/\/[^\s]+$/i.test(u));
export const backups = () => [RELAY_URL, ...extraRelays()];
export const isBackup = (url) => backups().includes(url);

export let BACKUP = RELAY_URL;                 // the backup in use right now
let current = store.get("relay", null) || RELAY_URL;

export const get = () => current;
export const onPrimary = () => !isBackup(current);

async function reachable(url) {
  try {
    const r = await request(url + "/api", undefined, 6000);
    return r.ok && r.data && r.data.service === "FreeMessenger relay" ? r.data : null;
  } catch {
    return null;
  }
}

// Finds the best relay: the home server if a reachable backup can point us to
// it and it answers, otherwise the first backup that responds at all.
export async function pick() {
  const list = backups();
  let primary = store.get("primary", null);
  let liveBackup = null;
  for (const b of list) {
    try {
      const r = await request(b + "/api/primary", undefined, 7000);
      if (r.ok) { liveBackup = b; if (r.data && r.data.url) { primary = r.data.url; store.set("primary", primary); } break; }
    } catch {}
  }
  BACKUP = liveBackup || list[0];
  const info = primary && (await reachable(primary));
  current = info && info.primary ? primary : BACKUP;
  store.set("relay", current);
  return current;
}
