// The web viewer: fetches a page for someone the admin allowed, strips out
// everything that could run code, and points its links, pictures and styles
// back through here. Pages are shown in a sandbox with scripts off, and
// nothing on this computer's own network can be reached through it.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import zlib from "node:zlib";

const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 20e3;
const MAX_REDIRECTS = 5;

export const proxyAllowed = (flags) => !!(flags && (flags.admin || flags.proxy));

// ---------- never reach private networks ----------

const blocked = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) blocked.addSubnet(a, p, "ipv6");

export function isPrivate(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 6) {
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPrivate(mapped[1]);
    if (/^::ffff:/i.test(ip)) return true;
  }
  return blocked.check(ip, v === 4 ? "ipv4" : "ipv6");
}

// Looks the name up, refuses if any address is private, and connects to the
// address it checked (so a second lookup can't be pointed somewhere else).
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, list) => {
    if (err) return callback(err);
    if (!list.length || list.some((a) => isPrivate(a.address))) return callback(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }));
    const pick = list.find((a) => a.family === 4) || list[0];
    if (options && options.all) return callback(null, [pick]);
    callback(null, pick.address, pick.family);
  });
}

function fetchOnce(target) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    if (u.protocol !== "http:" && u.protocol !== "https:") return reject(new Error("Only http and https links work here."));
    if (u.username || u.password) return reject(new Error("Links with passwords in them don't work here."));
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (![80, 443, 8080, 8443].includes(port)) return reject(new Error("That port isn't allowed."));
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isPrivate(host)) return reject(new Error("That address is on a private network."));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method: "GET",
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
      headers: {
        "User-Agent": "Mozilla/5.0 (FreeMessenger web viewer)",
        Accept: "text/html,application/xhtml+xml,image/*,text/css,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en",
      },
    }, (res) => {
      const parts = [];
      let size = 0;
      let stream = res;
      const ce = String(res.headers["content-encoding"] || "").toLowerCase();
      if (ce === "gzip" || ce === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (ce === "deflate") stream = res.pipe(zlib.createInflate());
      else if (ce === "br") stream = res.pipe(zlib.createBrotliDecompress());
      stream.on("data", (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); reject(new Error("That page is too big (over 15 MB).")); return; }
        parts.push(c);
      });
      stream.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      stream.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("The site took too long to answer.")));
    req.on("error", (e) => reject(e.code === "EBLOCKED" ? new Error("That address is on a private network.") : e));
    req.end();
  });
}

export async function fetchFollow(target) {
  let url = target;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await fetchOnce(url);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      url = new URL(r.headers.location, url).href;
      continue;
    }
    return { ...r, url };
  }
  throw new Error("Too many redirects.");
}

// ---------- rewriting ----------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeAttr = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function absolute(ref, base) {
  const r = unescapeAttr(ref.trim());
  if (!r || r.startsWith("#") || /^(javascript|vbscript|data|blob|about|mailto|tel):/i.test(r)) return null;
  try {
    const u = new URL(r, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const via = (proxyBase, kind, url) => `${proxyBase}/${kind}?u=${encodeURIComponent(url)}`;

function rewriteCss(css, pageUrl, proxyBase) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (all, q, ref) => {
      if (/^data:image\//i.test(ref.trim())) return all;
      const abs = absolute(ref, pageUrl);
      return abs ? `url("${via(proxyBase, "res", abs)}")` : "url()";
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (all, q, ref) => {
      const abs = absolute(ref, pageUrl);
      return abs ? `@import "${via(proxyBase, "res", abs)}"` : "";
    })
    .replace(/expression\s*\(/gi, "(")
    .replace(/behavior\s*:/gi, "x:");
}

const DROP_WITH_CONTENT = /<(script|iframe|frame|frameset|object|embed|applet|template|svg:script)\b[\s\S]*?<\/\1\s*>/gi;
const DROP_TAGS = /<\/?(script|iframe|frame|frameset|object|embed|applet|base|portal|noscript)\b[^>]*>/gi;
const URL_ATTRS = new Set(["href", "src", "poster", "background", "action", "data", "formaction", "cite", "longdesc", "lowsrc", "dynsrc", "xlink:href"]);

function rewriteTag(tag, attrs, pageUrl, proxyBase) {
  const name = tag.toLowerCase();
  if (name === "meta" && /http-equiv\s*=\s*["']?\s*(refresh|set-cookie|content-security-policy)/i.test(attrs)) return "";
  if (name === "link" && !/rel\s*=\s*["']?[^"'>]*\b(stylesheet|icon)\b/i.test(attrs)) return "";
  let out = "";
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(attrs))) {
    const key = m[1].toLowerCase();
    let value = m[2] ?? m[3] ?? m[4];
    if (key.startsWith("on") || key === "srcdoc" || key === "formaction" || key === "ping" || key === "integrity" || key === "nonce" || key === "target") continue;
    if (value === undefined) { out += " " + key; continue; }
    if (URL_ATTRS.has(key)) {
      const abs = absolute(value, pageUrl);
      if (!abs) continue;
      const isPage = (name === "a" || name === "area") && key === "href";
      value = via(proxyBase, isPage ? "page" : "res", abs);
    } else if (key === "srcset" || key === "imagesrcset") {
      value = unescapeAttr(value).split(",").map((part) => {
        const [u, d] = part.trim().split(/\s+/, 2);
        const abs = u && absolute(u, pageUrl);
        return abs ? via(proxyBase, "res", abs) + (d ? " " + d : "") : "";
      }).filter(Boolean).join(", ");
    } else if (key === "style") {
      value = rewriteCss(unescapeAttr(value), pageUrl, proxyBase);
    } else {
      value = unescapeAttr(value);
      if (/^\s*(javascript|vbscript):/i.test(value)) continue;
    }
    out += ` ${key}="${esc(value)}"`;
  }
  if (name === "form") out += ` action="about:blank"`;
  return `<${tag}${out}>`;
}

export function sanitizeHtml(html, pageUrl, proxyBase) {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(DROP_WITH_CONTENT, "").replace(DROP_TAGS, "");
  s = s.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (all, a, css) => `<style>${rewriteCss(css, pageUrl, proxyBase)}</style>`);
  s = s.replace(/<([a-zA-Z][\w:-]*)(\s[^>]*?)?(\/?)>/g, (all, tag, attrs, slash) => {
    const t = rewriteTag(tag, attrs || "", pageUrl, proxyBase);
    return t && slash ? t.slice(0, -1) + " />" : t;
  });
  const banner = `<div style="all:initial;display:block;position:sticky;top:0;z-index:2147483647;background:#2f6fed;color:#fff;font:13px system-ui,sans-serif;padding:6px 10px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">FreeMessenger web viewer · scripts off · ${esc(pageUrl)}</div>`;
  if (/<body\b[^>]*>/i.test(s)) return s.replace(/<body\b[^>]*>/i, (b) => b + banner);
  return banner + s;
}

// ---------- responses ----------

const SANDBOX = "sandbox allow-popups allow-popups-to-escape-sandbox; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'";

function send(res, status, type, body) {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Security-Policy": SANDBOX,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, max-age=300",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  res.end(body);
}

function errorPage(res, message) {
  send(res, 502, "text/html; charset=utf-8", `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui,sans-serif;padding:24px;color:#333"><h2>Can't open this page</h2><p>${esc(message)}</p></body>`);
}

function decode(buf, contentType) {
  const m = /charset=([\w-]+)/i.exec(contentType || "") || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString("latin1"));
  try { return new TextDecoder(m ? m[1] : "utf-8").decode(buf); } catch { return buf.toString("utf8"); }
}

export async function proxyPage(target, proxyBase, res) {
  try {
    const r = await fetchFollow(target);
    const type = String(r.headers["content-type"] || "").toLowerCase();
    if (type.includes("text/html") || type.includes("application/xhtml")) {
      return send(res, 200, "text/html; charset=utf-8", sanitizeHtml(decode(r.body, type), r.url, proxyBase));
    }
    return sendResource(res, r, proxyBase);
  } catch (e) {
    errorPage(res, e.message || "Something went wrong.");
  }
}

export async function proxyResource(target, proxyBase, res) {
  try {
    sendResource(res, await fetchFollow(target), proxyBase);
  } catch {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("");
  }
}

const SAFE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)|video\/(mp4|webm|ogg)|audio\/(mpeg|ogg|wav|webm|mp4|aac)|font\/[\w-]+|application\/(font-woff2?|x-font-\w+|pdf)|text\/plain)/;

function sendResource(res, r, proxyBase) {
  const type = String(r.headers["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase();
  if (type === "text/css") return send(res, 200, "text/css; charset=utf-8", rewriteCss(decode(r.body, r.headers["content-type"]), r.url, proxyBase));
  if (type === "text/html" || type === "application/xhtml+xml") return send(res, 200, "text/html; charset=utf-8", sanitizeHtml(decode(r.body, r.headers["content-type"]), r.url, proxyBase));
  if (SAFE_TYPES.test(type)) return send(res, 200, type, r.body);
  // Anything else (scripts, programs, unknown files) isn't passed along.
  res.writeHead(415, { "Content-Type": "text/plain" });
  res.end("");
}

// ---------- link previews ----------
//
// The sender's app asks for a preview when it sends a link, and the preview
// travels inside the encrypted message, so the person receiving it never
// contacts the site. Only the title, a short description and a small picture.

function metaContent(html, names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${n}["'][^>]*>`, "i");
    const tag = html.match(re);
    if (tag) {
      const c = tag[0].match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i);
      if (c) return unescapeAttr(c[1] ?? c[2] ?? "").trim();
    }
  }
  return "";
}

export async function linkPreview(target) {
  const r = await fetchFollow(target);
  const type = String(r.headers["content-type"] || "").toLowerCase();
  if (!type.includes("text/html")) return null;
  const html = decode(r.body.subarray(0, 600000), type);
  const title = metaContent(html, ["og:title", "twitter:title"]) || ((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").trim();
  if (!title) return null;
  const out = {
    url: r.url,
    site: metaContent(html, ["og:site_name"]) || new URL(r.url).hostname.replace(/^www\./, ""),
    title: unescapeAttr(title).slice(0, 200),
    desc: metaContent(html, ["og:description", "twitter:description", "description"]).slice(0, 300),
  };
  const img = metaContent(html, ["og:image", "og:image:url", "twitter:image"]);
  const abs = img && absolute(img, r.url);
  if (abs) {
    try {
      const pic = await fetchFollow(abs);
      const ptype = String(pic.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (/^image\/(jpeg|png|webp)$/.test(ptype) && pic.body.length <= 60000) out.image = `data:${ptype};base64,${pic.body.toString("base64")}`;
    } catch {}
  }
  return out;
}
