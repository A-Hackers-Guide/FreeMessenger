// The connection to the relay. It uses a WebSocket when it can. Many school,
// work and hotel networks, proxies and VPN apps block or break WebSockets, so
// when one doesn't come up it switches to ordinary HTTPS requests that poll
// for new messages. Either way the app sees the same thing: messages arrive
// through onMessage, and send() reports what the relay said.

const WS_TIMEOUT_MS = 8000;           // a WebSocket that isn't signed in by then is treated as blocked
const PREFER_HTTP_MS = 24 * 3600e3;   // after a blocked WebSocket, go straight to HTTP for a day

// Plain XMLHttpRequest with a text/plain body: works in every browser, and
// counts as a "simple" request, so there's no CORS preflight for proxies to drop.
export function request(url, body, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(body === undefined ? "GET" : "POST", url);
    x.timeout = timeout;
    if (body !== undefined) x.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
    x.onload = () => {
      let data = {};
      try { data = JSON.parse(x.responseText); } catch {}
      resolve({ status: x.status, ok: x.status >= 200 && x.status < 300, data });
    };
    x.onerror = x.ontimeout = () => reject(new Error("network"));
    x.send(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body));
  });
}

export function createConnection({ relay, username, sign, store, onMessage, onState, onFatal }) {
  let mode = null;
  let stopped = false;
  let ready = false;
  const setReady = (on) => {
    if (on !== ready) { ready = on; onState(on, mode); }
  };

  // ---------- WebSocket ----------

  let ws = null;
  let refSeq = 0;
  const pending = new Map();
  let wsRetry = 0;
  let wsFailures = 0;

  function startWs() {
    mode = "ws";
    let signedIn = false;
    try {
      ws = new WebSocket(relay.replace(/^http/, "ws") + "/api/ws/" + username);
    } catch {
      return fallBack();
    }
    const timer = setTimeout(() => { if (!signedIn) fallBack(); }, WS_TIMEOUT_MS);
    ws.onmessage = async (ev) => {
      if (ev.data === "pong") return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "challenge") {
        ws.send(JSON.stringify({ type: "auth", signature: await sign(msg.challenge) }));
      } else if (msg.type === "ready") {
        signedIn = true;
        clearTimeout(timer);
        wsRetry = wsFailures = 0;
        store.set("transport", null);
        setReady(true);
      } else if (msg.type === "message") {
        onMessage(msg);
      } else if (msg.type === "sent") {
        const resolve = pending.get(msg.ref);
        pending.delete(msg.ref);
        if (resolve) resolve(msg);
      }
    };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      if (mode !== "ws") return;
      setReady(false);
      for (const resolve of pending.values()) resolve({ error: "offline" });
      pending.clear();
      if (ev.code === 4001) return onFatal();
      if (stopped) return;
      // Never got signed in twice in a row: something on the way blocks WebSockets.
      if (!signedIn && ++wsFailures >= 2) return fallBack();
      setTimeout(startWs, Math.min(30000, 1000 * 2 ** wsRetry++));
    };
  }

  // Ping often enough that proxies which cut idle connections after 30-60
  // seconds leave it alone. The relay answers pings without waking up.
  setInterval(() => {
    if (mode === "ws" && ws && ws.readyState === 1) {
      try { ws.send("ping"); } catch {}
    }
  }, 25000);

  function fallBack() {
    if (mode !== "ws") return;
    mode = "http";
    store.set("transport", { http: Date.now() });
    if (ws) {
      ws.onclose = ws.onmessage = null;
      try { ws.close(); } catch {}
      ws = null;
    }
    setReady(false);
    startHttp();
  }

  // ---------- HTTPS polling ----------

  let token = null;
  let cursor = null;        // newest message seen, so each poll only returns newer ones
  let fastUntil = 0;
  let pollTimer = null;
  let httpRetry = 0;
  const url = relay + "/api/http/" + username;

  async function call(op, data) {
    const r = await request(url, Object.assign({ op, token }, data));
    if (r.status === 401 && op !== "auth") {
      // Signed out on the relay: sign in again on the next poll, and report
      // offline until then so the app resends anything that failed meanwhile.
      token = null;
      setReady(false);
      throw new Error("session");
    }
    if (r.status === 403) { stopped = true; onFatal(); throw new Error("auth"); }
    if (!r.ok) throw new Error(r.data.error || "relay " + r.status);
    return r.data;
  }

  async function signIn() {
    const { challenge } = await call("challenge", {});
    token = (await call("auth", { challenge, signature: await sign(challenge) })).token;
  }

  async function poll() {
    pollTimer = null;
    if (stopped || mode !== "http") return;
    try {
      if (!token) await signIn();
      const { messages } = await call("poll", cursor ? { after: cursor } : {});
      httpRetry = 0;
      setReady(true);
      if (messages.length) boost(20000);
      for (const m of messages) {
        if (!m.ephemeral && (!cursor || m.ts > cursor.ts || (m.ts === cursor.ts && m.id > cursor.id))) cursor = { ts: m.ts, id: m.id };
        onMessage(Object.assign({ type: "message" }, m));
      }
    } catch (e) {
      if (stopped) return;
      if (e.message !== "session") { setReady(false); httpRetry++; }
    }
    schedule();
  }

  function schedule() {
    if (stopped || mode !== "http") return;
    clearTimeout(pollTimer);
    const delay = httpRetry
      ? Math.min(30000, 1000 * 2 ** httpRetry)
      : Date.now() < fastUntil ? 1000 : document.hidden ? 15000 : 4000;
    pollTimer = setTimeout(poll, delay);
  }

  function startHttp() {
    mode = "http";
    poll();
  }

  // Poll every second for a while: after messages arrive, and during calls.
  function boost(ms) {
    fastUntil = Math.max(fastUntil, Date.now() + ms);
    if (mode === "http" && pollTimer) schedule();
  }

  document.addEventListener("visibilitychange", () => {
    if (mode === "http" && !document.hidden && pollTimer) {
      clearTimeout(pollTimer);
      poll();
    }
  });

  // ---------- what the app uses ----------

  // hint tells the relay whether to send a notification if the other person
  // is offline: "msg" for messages, "call" for calls, nothing for the rest.
  function send(to, body, ephemeral, hint) {
    return op("send", { to, body, ephemeral: !!ephemeral, hint });
  }

  // Any request to the relay, over whichever connection is up.
  function op(type, data) {
    if (!ready) return Promise.resolve({ error: "offline" });
    if (mode === "http") {
      if (type === "send") boost(20000);
      return call(type, data).catch((e) => ({ error: e.message }));
    }
    return new Promise((resolve) => {
      const ref = ++refSeq;
      pending.set(ref, resolve);
      ws.send(JSON.stringify(Object.assign({ type, ref }, data)));
      setTimeout(() => { if (pending.delete(ref)) resolve({ error: "timeout" }); }, 15000);
    });
  }

  function ack(items) {
    if (mode === "http") call("ack", { items }).catch(() => {});
    else if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ack", items }));
  }

  const preferHttp = store.get("transport", null);
  if (!window.WebSocket || (preferHttp && Date.now() - preferHttp.http < PREFER_HTTP_MS)) startHttp();
  else startWs();

  return {
    send,
    op,
    ack,
    boost,
    get ready() { return ready; },
    get mode() { return mode; },
  };
}
