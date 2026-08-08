/* Small shared DOM helpers. Same shape as pfc-order-app's, so the two codebases read alike. */
import { tr } from "./i18n.js";

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* Built on <template>, not a <div>. A div parses its innerHTML in "body" context, where the HTML
 * parser SILENTLY DISCARDS <tr>, <td>, <option> and friends - so el("<tr>...") would return null and
 * the caller would append nothing. <template> parses in a context that keeps them. */
export const el = (h) => {
  const t = document.createElement("template");
  t.innerHTML = h.trim();
  return t.content.firstElementChild;
};

export const aed = (n) => "AED " + Number(n || 0).toLocaleString("en-AE",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const aed0 = (n) => "AED " + Number(n || 0).toLocaleString("en-AE", { maximumFractionDigits: 0 });
export const num = (n) => Number(n || 0).toLocaleString("en-AE", { maximumFractionDigits: 1 });

export function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d + (String(d).length === 10 ? "T00:00:00" : ""));
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
}
export function fmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
export function today() {
  // Asia/Dubai, to agree with the server-side date_bucket
  return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}
export function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

export function toast(msg, kind) {
  const t = el(`<div class="toast ${kind || ""}">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
export function loading(on, msg) {
  const l = $("#loading");
  if (!l) return;
  l.style.display = on ? "flex" : "none";
  if (msg) $("#loadmsg").textContent = msg;
}

/* A bottom sheet on mobile, a centred dialog on desktop. Returns the sheet element; the caller
 * wires its own buttons and calls close(). */
export function modal(innerHtml) {
  const m = el(`<div class="modal"><div class="sheet">${innerHtml}</div></div>`);
  document.body.appendChild(m);
  const close = () => m.remove();
  m.addEventListener("click", (e) => { if (e.target === m) close(); });
  return { root: m, sheet: m.querySelector(".sheet"), close };
}

export function confirmSheet(title, body) {
  return new Promise((resolve) => {
    const m = modal(`
      <h3>${esc(title)}</h3>
      <p class="muted" style="margin:8px 0 16px">${esc(body || "")}</p>
      <div class="row" style="justify-content:flex-end">
        <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
        <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
      </div>`);
    m.sheet.querySelector("[data-no]").onclick = () => { m.close(); resolve(false); };
    m.sheet.querySelector("[data-yes]").onclick = () => { m.close(); resolve(true); };
  });
}

export function chip(text, tone, glyph) {
  return `<span class="chip ${tone || "mute"}">${glyph ? esc(glyph) + " " : ""}${esc(text)}</span>`;
}

export function progressBar(done, total) {
  if (!total) return `<span class="muted">—</span>`;
  const pct = Math.round((done / total) * 100);
  const cls = done >= total ? "" : "part";
  return `<span class="progress"><span class="bar ${cls}"><i style="width:${pct}%"></i></span>${done}/${total}</span>`;
}

export function selectHtml(name, options, current, placeholder) {
  const opts = options.map((o) => {
    const v = typeof o === "string" ? o : o.value;
    const l = typeof o === "string" ? o : o.label;
    return `<option value="${esc(v)}"${String(current) === String(v) ? " selected" : ""}>${esc(l)}</option>`;
  }).join("");
  return `<select name="${esc(name)}">${placeholder !== undefined
    ? `<option value=""${!current ? " selected" : ""}>${esc(placeholder)}</option>` : ""}${opts}</select>`;
}

/* Download a CSV built entirely client-side - no server round trip. */
export function downloadCsv(filename, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // clipboard API needs a secure context and a user gesture; fall back to a selectable textarea
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e2) {}
    ta.remove();
    return ok;
  }
}
