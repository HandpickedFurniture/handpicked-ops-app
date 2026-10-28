/* The "Express" and "Repeat" tags beside an order number, wherever one is shown.
 *
 * Each tag appears ONCE per order per screen (or per open sheet): an order id is drawn on every line
 * of a table and again in headers and detail panels, and a pill on every one of them was the noise
 * the coordinators complained about (28 Oct 2026). The first occurrence on the page wins.
 *
 * An order is express when it carries a 2-Day Express Installation line (sku EXP-*), exposed as
 * v_ops_express_orders. "Repeat" = another order has the same customer name and address
 * (order_repeat_customer, rebuilt every 10 minutes by fn_refresh_repeat_customers); hover the pill for
 * the other order numbers. There are ~130 and 134 places render an order id, so instead of touching
 * each template this watches the DOM: any five-digit number that IS in one of the sets gets a pill
 * after it. Requiring membership in a set is what makes a text scan safe - a quantity or a width that
 * happens to be five digits is not an order id. Order numbers inside a longer token (a PO number
 * like PO-20261024-79135-HAN-01, a decimal, a time) are left alone.
 *
 * Cannot tag text inside an <input>, <textarea> or <select> - the browser draws those, not the DOM. */
import { isSignedIn, apiAll, onSession } from "./api.js";

const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "NOSCRIPT", "TITLE", "CODE"]);
const ID = /(?<![\w\-./:,])\d{5}(?![\w\-]|[.,/:]\d)/g;
const REFRESH_MS = 5 * 60 * 1000;

let express = new Set();
let repeat = new Map();                              // order id -> the other order ids for that customer
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
  try {
    const rc = await apiAll("/rest/v1/order_repeat_customer?select=order_id,other_orders");
    repeat = new Map(rc.map((r) => [String(r.order_id), r.other_orders || []]));
    loadedAt = Date.now();
  } catch (e) {
    console.warn("repeat-customer tags unavailable", e);
  }
}

function pill(kind, id) {
  const s = document.createElement("span");
  s.dataset.o = id;
  if (kind === "x") {
    s.className = "xtag";
    s.textContent = "Express";
    s.title = "2-Day Express Installation order";
  } else {
    const others = repeat.get(id) || [];
    s.className = "xtag rtag";
    s.textContent = "Repeat";
    s.title = `Same customer (name and address) as order${others.length > 1 ? "s" : ""} ${others.join(", ")}`;
  }
  return s;
}

/* One pill per kind per order within a screen - or within the open sheet, since a sheet sits on top of
 * the page it was opened from and needs its own. */
function scopeOf(node) {
  const p = node.parentElement;
  return (p && p.closest(".modal")) || document.body;
}
function already(scope, kind, id) {
  return !!scope.querySelector(`.${kind === "x" ? "xtag:not(.rtag)" : "rtag"}[data-o="${id}"]`);
}

function tagText(node) {
  const text = node.nodeValue;
  if ((!express.size && !repeat.size) || !/\d{5}/.test(text)) return;
  ID.lastIndex = 0;
  let last = 0, hit = false;
  const scope = scopeOf(node), done = new Set();     // ids already tagged inside this text node
  const frag = document.createDocumentFragment();
  for (let m; (m = ID.exec(text)); ) {
    const id = m[0], add = [];
    if (express.has(id) && !done.has("x" + id) && !already(scope, "x", id)) add.push(pill("x", id));
    if (repeat.has(id) && !done.has("r" + id) && !already(scope, "r", id)) add.push(pill("r", id));
    if (!add.length) continue;
    hit = true;
    add.forEach((a) => done.add((a.classList.contains("rtag") ? "r" : "x") + id));
    const end = m.index + id.length;
    frag.append(text.slice(last, end), ...add);
    last = end;
  }
  if (!hit) return;
  frag.append(text.slice(last));
  node.replaceWith(frag);        // the pills are in the document now, so the next node's check sees them
}

function inScope(node) {
  for (let p = node.parentElement; p; p = p.parentElement) {
    if (p.classList.contains("xtag") || p.isContentEditable) return false;
    if (SKIP.has(p.tagName)) return false;
  }
  return true;
}

/* Backstop for the rule above: whatever path put a second pill on the same order in the same screen
 * or sheet, the extras are removed here (the first in document order stays). */
function dedupe() {
  const seen = new Map();
  document.querySelectorAll(".xtag[data-o]").forEach((p) => {
    const scope = p.closest(".modal") || document.body;
    const slot = seen.get(scope) || seen.set(scope, new Set()).get(scope);
    const key = (p.classList.contains("rtag") ? "r" : "x") + p.dataset.o;
    if (slot.has(key)) p.remove(); else slot.add(key);
  });
}

function scan(root) {
  if (!express.size && !repeat.size) return;
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
      dedupe();
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
    dedupe();
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  refresh();
  /* The sets are fetched again on sign-in and every few minutes, so an order that arrives mid-shift
   * is tagged without a reload. Orders already drawn are picked up by the full scan after the fetch. */
  window.addEventListener("hashchange", () => { if (Date.now() - loadedAt > REFRESH_MS) refresh(); });
  onSession(() => { if (isSignedIn()) refresh(); });
  clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
  return refresh;
}
