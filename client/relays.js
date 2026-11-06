// Which relay to talk to. The main one runs on the site owner's computer and
// its address changes when it restarts, so the always-on backup relay (on
// Cloudflare, RELAY_URL) says where it is. If the main one can't be reached,
// everything goes through the backup, and the two copy messages to each other.

import { RELAY_URL } from "./config.js";
import { request } from "./transport.js";
import { store } from "./store.js";

export const BACKUP = RELAY_URL;
let current = store.get("relay", null) || RELAY_URL;

export const get = () => current;
export const onPrimary = () => current !== BACKUP;

async function reachable(url) {
  try {
    const r = await request(url + "/api", undefined, 6000);
    return r.ok && r.data && r.data.service === "FreeMessenger relay" ? r.data : null;
  } catch {
    return null;
  }
}

// Finds the best relay: the main one if it answers, otherwise the backup.
export async function pick() {
  let primary = store.get("primary", null);
  try {
    const r = await request(BACKUP + "/api/primary", undefined, 8000);
    if (r.ok) {
      primary = r.data.url || null;
      store.set("primary", primary);
    }
  } catch {}
  const info = primary && (await reachable(primary));
  current = info && info.primary ? primary : BACKUP;
  store.set("relay", current);
  return current;
}
