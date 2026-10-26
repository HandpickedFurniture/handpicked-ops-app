/* The "Express" tag beside an order number, wherever one is shown.
 *
 * An order is express when it carries a 2-Day Express Installation line (sku EXP-*), exposed as
 * v_ops_express_orders. There are ~130 and 134 places render an order id, so instead of touching each
 * template this watches the DOM: any five-digit number that IS in the express set gets a pill after it.
 * Requiring membership in the set is what makes a text scan safe - a quantity or a width that happens
 * to be five digits is not an express order id. Order numbers inside a longer token (a PO number
 * like PO-20261024-79135-HAN-01, a decimal, a time) are left alone.
 *
 * Cannot tag text inside an <input>, <textarea> or <select> - the browser draws those, not the DOM. */
import { isSignedIn, apiAll, onSession } from "./api.js";

const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "NOSCRIPT", "TITLE", "CODE"]);
const ID = /(?<![\w\-./:,])\d{5}(?![\w\-]|[.,/:]\d)/g;
const REFRESH_MS = 5 * 60 * 1000;

let express = new Set();
let loadedAt = 0;
let loading = null;
let timer = null;

async function load() {
  if (!isSignedIn()) return;
  try {
    const rows = await apiAll("/rest/v1/v_ops_express_orders?select=order_id");
    express = new Set(rows.map((r) => String(r.order_id)));
    loadedAt = Date.now();
  } catch (e) {
    console.warn("express tags unavailable", e);     // a missing tag must never break a screen
  }
}

function pill() {
  const s = document.createElement("span");
  s.className = "xtag";
  s.textContent = "Express";
  s.title = "2-Day Express Installation order";
  return s;
}

function tagText(node) {
  const text = node.nodeValue;
  if (!express.size || !/\d{5}/.test(text)) return;
  ID.lastIndex = 0;
  let last = 0, hit = false;
  const frag = document.createDocumentFragment();
  for (let m; (m = ID.exec(text)); ) {
    if (!express.has(m[0])) continue;
    hit = true;
    const end = m.index + m[0].length;
    frag.append(text.slice(last, end), pill());
    last = end;
  }
  if (!hit) return;
  frag.append(text.slice(last));
  node.replaceWith(frag);
}

function inScope(node) {
  for (let p = node.parentElement; p; p = p.parentElement) {
    if (p.classList.contains("xtag") || p.isContentEditable) return false;
    if (SKIP.has(p.tagName)) return false;
  }
  return true;
}

function scan(root) {
  if (!express.size) return;
  const base = root.nodeType === 3 ? root.parentNode : root;
  if (!base) return;
  const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
  const found = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/\d{5}/.test(n.nodeValue) && inScope(n)) found.push(n);
  }
  found.forEach(tagText);
}

export function startExpressTags() {
  const obs = new MutationObserver((muts) => {
    obs.disconnect();                                  // our own edits must not re-trigger us
    try {
      for (const m of muts) {
        if (m.type === "characterData") scan(m.target);
        else m.addedNodes.forEach((n) => { if (n.nodeType === 1 || n.nodeType === 3) scan(n); });
      }
    } finally {
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  });
  const refresh = async () => {
    if (loading) return loading;
    loading = load().finally(() => { loading = null; });
    await loading;
    obs.disconnect();
    scan(document.body);
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  refresh();
  /* The set is fetched again on sign-in and every few minutes, so an order that arrives mid-shift
   * is tagged without a reload. Orders already drawn are picked up by the full scan after the fetch. */
  window.addEventListener("hashchange", () => { if (Date.now() - loadedAt > REFRESH_MS) refresh(); });
  onSession(() => { if (isSignedIn()) refresh(); });
  clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
  return refresh;
}
