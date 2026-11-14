// Extra features that layer on top of the app without touching the core:
// message text formatting, read-aloud, keyboard shortcuts and a jump-to-latest
// button. Everything here is guarded so an old browser just gets less, never a
// broken page.

const $ = (id) => document.getElementById(id);

// ---------- read aloud ----------

export function canSpeak() { return !!window.speechSynthesis && !!window.SpeechSynthesisUtterance; }
let speaking = false;
export function speak(text) {
  if (!canSpeak()) return false;
  try {
    const synth = window.speechSynthesis;
    if (speaking) { synth.cancel(); speaking = false; return true; } // tap again to stop
    const u = new SpeechSynthesisUtterance(String(text || "").slice(0, 4000));
    u.onend = u.onerror = () => { speaking = false; };
    speaking = true;
    synth.speak(u);
    return true;
  } catch { return false; }
}

// ---------- jump-to-latest button ----------

export function initScrollButton() {
  const list = $("messages"), btn = $("scroll-bottom");
  if (!list || !btn) return;
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const update = () => { btn.hidden = nearBottom(); };
  list.addEventListener("scroll", update, { passive: true });
  btn.onclick = () => { list.scrollTo ? list.scrollTo({ top: list.scrollHeight, behavior: "smooth" }) : (list.scrollTop = list.scrollHeight); };
  update();
  // keep it in step when messages are added/removed
  try { new MutationObserver(update).observe(list, { childList: true, subtree: true }); } catch {}
}

// ---------- keyboard shortcuts ----------

const typingInField = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

export function initShortcuts(ctx) {
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    // Esc closes whatever is open
    if (e.key === "Escape") { if (ctx.closeTop && ctx.closeTop()) e.preventDefault(); return; }
    // Ctrl/Cmd+K focuses search
    if (mod && (e.key === "k" || e.key === "K")) { const s = $("search"); if (s) { e.preventDefault(); s.focus(); s.select && s.select(); } return; }
    if (typingInField(e.target)) return;
    // ? shows the shortcut list
    if (e.key === "?" ) { e.preventDefault(); showShortcuts(); return; }
    // Alt+Up / Alt+Down move between chats
    if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const rows = [...document.querySelectorAll("#contacts li")];
      if (!rows.length) return;
      let i = rows.findIndex((r) => r.classList.contains("active"));
      i = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      if (i < 0) i = 0;
      rows[i].click();
    }
  });
}

const SHORTCUTS = [
  ["Ctrl / ⌘ + K", "Search chats and messages"],
  ["Esc", "Close the menu, panel or chat"],
  ["Alt + ↑ / ↓", "Previous / next chat"],
  ["?", "Show this list"],
];
export function showShortcuts() {
  let d = $("shortcuts-dialog");
  if (!d) {
    d = document.createElement("dialog");
    d.id = "shortcuts-dialog";
    d.innerHTML = `<h2>⌨️ Keyboard shortcuts</h2><dl class="shortcuts">${SHORTCUTS.map(([k, v]) => `<dt><kbd>${k}</kbd></dt><dd>${v}</dd>`).join("")}</dl><button class="primary" id="shortcuts-close">Done</button>`;
    document.body.appendChild(d);
    d.querySelector("#shortcuts-close").onclick = () => d.close();
  }
  d.showModal ? d.showModal() : d.setAttribute("open", "");
}
