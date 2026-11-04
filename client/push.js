// Notifications and installing FreeMessenger as an app.
//
// While the site is open, notifications come from the page. With the browser
// signed up for Web Push, the relay can also wake the device when the site is
// closed; that notification only says who wrote, and the message itself is
// fetched and decrypted when FreeMessenger opens.

import { RELAY_URL } from "./config.js";
import { request } from "./transport.js";
import { store } from "./store.js";
import { unb64 } from "./compat.js";

const $ = (id) => document.getElementById(id);
let reg = null;
let installPrompt = null;
let openChat = () => {};

const supported = () => "Notification" in window;
const pushSupported = () => !!(reg && reg.pushManager && window.PushManager);
const standalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function registerWorker() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    $("install-btn").hidden = false;
  });
  if (isIOS() && !standalone()) $("install-btn").hidden = false;
  if (!("serviceWorker" in navigator) || window.isSecureContext === false) return;
  navigator.serviceWorker.register("sw.js").then((r) => { reg = r; }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "open" && e.data.chat) openChat(e.data.chat);
  });
}

export function init(opts) {
  openChat = opts.onOpenChat;
  const want = new URLSearchParams(location.search).get("open");
  if (want) {
    history.replaceState(null, "", location.pathname + location.hash);
    setTimeout(() => openChat(want), 0);
  }
}

export function install() {
  if (installPrompt) {
    installPrompt.prompt();
    installPrompt = null;
    $("install-btn").hidden = true;
    return;
  }
  alert(isIOS()
    ? "To install FreeMessenger: tap the Share button in Safari, then \"Add to Home Screen\". After that, open it from your home screen and turn on notifications in Settings."
    : "Use your browser's menu and choose \"Install app\" or \"Add to Home screen\".");
}

export function status() {
  if (!supported()) return isIOS() && !standalone() ? "Install the app first" : "Not available here";
  if (Notification.permission === "denied") return "Blocked by the browser";
  if (Notification.permission === "granted") return store.get("push", false) ? "On" : "On while open";
  return "Turn on";
}

const keyBytes = (b64url) => unb64(b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4));

export async function enable(conn) {
  if (!supported()) {
    return isIOS() && !standalone()
      ? "On iPhone and iPad, install FreeMessenger first: Share → Add to Home Screen."
      : "This browser doesn't support notifications.";
  }
  let p = Notification.permission;
  if (p === "default") p = await new Promise((resolve) => {
    const r = Notification.requestPermission(resolve);
    if (r && r.then) r.then(resolve);
  });
  if (p !== "granted") return "Notifications are blocked. Allow them in your browser's site settings.";
  if (!pushSupported()) return "Notifications are on while FreeMessenger is open.";
  try {
    const { data } = await request(RELAY_URL + "/api/vapid");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(data.key) });
    const r = conn ? await conn.op("push-sub", { sub: sub.toJSON() }) : { error: "offline" };
    if (r.error) return "Notifications are on while FreeMessenger is open. Try again when you're online for closed-app alerts.";
    store.set("push", true);
    return "Notifications are on, even when FreeMessenger is closed.";
  } catch {
    return "Notifications are on while FreeMessenger is open.";
  }
}

// Re-registers this browser with the relay each time it connects, in case
// the push service changed its address.
export async function refresh(conn) {
  if (!store.get("push", false) || !pushSupported() || Notification.permission !== "granted") return;
  try {
    const sub = await reg.pushManager.getSubscription();
    if (sub) conn.op("push-sub", { sub: sub.toJSON() });
  } catch {}
}

export async function disable(conn) {
  try {
    const sub = reg && reg.pushManager && (await reg.pushManager.getSubscription());
    if (sub) {
      if (conn) await conn.op("push-unsub", { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
  } catch {}
  store.set("push", false);
}

export function showLocal(title, body, chat, isCall) {
  if (!supported() || Notification.permission !== "granted") return;
  const opts = { body, tag: isCall ? "call" : "chat:" + chat, data: { chat }, icon: "icon-192.png", badge: "icon-192.png", renotify: true };
  if (reg && reg.showNotification) return reg.showNotification(title, opts).catch(() => {});
  try {
    const n = new Notification(title, opts);
    n.onclick = () => { window.focus(); openChat(chat); n.close(); };
  } catch {}
}

export function closeCallNotice() {
  if (reg && reg.getNotifications) reg.getNotifications({ tag: "call" }).then((ns) => ns.forEach((n) => n.close())).catch(() => {});
}

export function setBadge(n) {
  try {
    if (n && navigator.setAppBadge) navigator.setAppBadge(n);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch {}
}
