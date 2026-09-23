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

/* An order is always "<id> <customer>". A bare order number is meaningless on a WhatsApp message
 * or a modal heading, and two orders for the same customer are told apart only by the number - so
 * neither half is ever dropped. Cards and tables already show the two in adjacent elements; this is
 * for the places that render an order inline as one string. */
export const orderLabel = (r) =>
  r ? [r.order_id, r.customer_name].filter(Boolean).join(" ").trim() : "";

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

/* A PDF of a table, without a PDF library.
 *
 * The browser's own print engine is the PDF writer: it already lays out every script this business
 * types - Arabic customer names, Hindi and Bengali labels - which the embedded-font route (jsPDF and
 * friends) does not without shipping a megabyte of fonts, and the app has no build step to bundle
 * them. So the button opens a print-only page holding just the report - title, filter summary, the
 * table with its heat shading and totals - and calls print(); the person picks "Save as PDF", which
 * every phone and desktop browser offers. Landscape A4, colours forced on, header row repeated on
 * every page. A blocked pop-up is reported rather than silently doing nothing. */
export function printSheet(title, subtitle, innerHtml, opts = {}) {
  const w = window.open("", "_blank");
  if (!w) return false;
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (css.getPropertyValue(name) || fallback).trim();
  const portrait = !!opts.portrait;
  /* Portrait sheets lay the table out fixed at the page width, so the columns' pixel widths (set on
   * the header cells for the screen) become PROPORTIONS: each is rewritten as its share of the
   * total. Left as pixels, a fixed layout would simply grow the table past the page edge. */
  if (portrait) {
    const px = [...innerHtml.matchAll(/<th[^>]*style="width:(\d+)px"/g)].map((m) => Number(m[1]));
    const sum = px.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      innerHtml = innerHtml.replace(/(<th[^>]*style=")width:(\d+)px"/g,
        (_m, pre, w) => `${pre}width:${(Number(w) / sum * 100).toFixed(2)}%"`);
    }
  }
  w.document.open();
  w.document.write(`<!doctype html><html lang="${esc(document.documentElement.lang || "en")}"><head>
    <meta charset="utf-8"><title>${esc(title)}</title>
    <style>
      @page{size:A4 ${portrait ? "portrait" : "landscape"};margin:10mm;}
      *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
      body{font:12px/1.35 -apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans Devanagari","Noto Sans Bengali",Arial,sans-serif;
           color:${v("--ink", "#16232a")};margin:0;padding:12px;}
      h1{font-size:18px;margin:0 0 2px;}
      .sub{color:${v("--muted", "#5f7480")};font-size:11px;margin:0 0 10px;}
      table{width:100%;border-collapse:collapse;font-size:11px;}
      thead{display:table-header-group;}
      th{background:${v("--info-bg", "#e8f0f3")};color:${v("--brand", "#0f4c5c")};text-align:left;padding:5px 6px;
         font-size:10px;text-transform:uppercase;letter-spacing:.03em;border-bottom:2px solid ${v("--line", "#d7dfe3")};}
      td{padding:4px 6px;border-bottom:1px solid ${v("--line", "#d7dfe3")};vertical-align:top;}
      th.num,td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;}
      tfoot th{background:${v("--mute-bg", "#f2f5f7")};color:inherit;text-transform:none;font-size:11px;border-top:2px solid ${v("--line", "#d7dfe3")};}
      tr{page-break-inside:avoid;}
      tr.sub td{font-size:10px;border-bottom:1px dashed ${v("--line", "#d7dfe3")};}
      tr.grp td{background:${v("--info-bg", "#e8f0f3")};font-weight:700;font-size:10px;text-transform:uppercase;}
      .muted{color:${v("--muted", "#5f7480")};}
      .chip{display:inline-block;border-radius:999px;padding:1px 7px;font-size:10px;font-weight:700;border:1px solid transparent;white-space:nowrap;}
      .chip.ok{background:${v("--ok-bg", "#eef7ef")};color:${v("--ok", "#1a7f37")};border-color:#bfe0c8;}
      .chip.warn{background:${v("--warn-bg", "#fff4e0")};color:${v("--warn", "#9a5b00")};border-color:#f0d9ac;}
      .chip.bad{background:${v("--bad-bg", "#fdecea")};color:${v("--danger", "#c0392b")};border-color:#f2c3bd;}
      .chip.info{background:${v("--info-bg", "#e8f0f3")};color:${v("--brand", "#0f4c5c")};border-color:#c5d8de;}
      .chip.mute,.chip.wait{background:${v("--mute-bg", "#f2f5f7")};color:${v("--muted", "#5f7480")};border-color:${v("--line", "#d7dfe3")};}
      .foot{margin-top:10px;font-size:10px;color:${v("--muted", "#5f7480")};}
      /* portrait (Planning): fixed layout at the page width, smaller type, wrapping where the
         column allows it and never inside a number, chips allowed to break onto two lines. These
         come LAST so they win over the rules above. */
      ${portrait ? `table{table-layout:fixed;font-size:9.5px;}
      th,th.num{white-space:normal;padding:4px 3px;overflow-wrap:anywhere;font-size:8px;}
      td{padding:3px 3px;} td.wrap{overflow-wrap:anywhere;white-space:normal;} td:not(.wrap),td.num,tfoot th{white-space:nowrap;overflow-wrap:normal;}
      .chip{font-size:9px;padding:1px 4px;white-space:normal;line-height:1.2;} .sarrow{display:none;}` : ""}
      /* the dashboard's stat tiles and inline-SVG charts, as app.css draws them */
      .statrow{display:flex;flex-wrap:wrap;gap:18px;margin:6px 0 12px;}
      .stat{display:flex;flex-direction:column;gap:1px;}
      .stat .sn{font-size:18px;font-weight:800;}
      .stat .sl{font-size:9px;color:${v("--muted", "#5f7480")};text-transform:uppercase;letter-spacing:.03em;}
      .chartwrap{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:0 0 12px;page-break-inside:avoid;}
      .chartwrap .card{border:1px solid ${v("--line", "#d7dfe3")};border-radius:8px;padding:8px 10px;}
      .chartwrap .spread{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;}
      .chartwrap h4{margin:0;font-size:12px;}
      .chartwrap details{display:none;}
      .chart{width:100%;height:auto;}
      .chart .track{fill:${v("--mute-bg", "#f2f5f7")};}
      .chart .lbl{font-size:11px;fill:${v("--muted", "#5f7480")};}
      .chart .val{font-size:11px;font-weight:700;fill:${v("--ink", "#16232a")};}
      .dnone{color:${v("--muted", "#5f7480")};font-style:italic;}
      /* tick boxes (Planning): a box to mark by hand, a tick where the system already knows */
      th.tickcol,td.tickcol{text-align:center;padding-left:2px;padding-right:2px;}
      .tick{display:inline-block;width:17px;height:17px;border:1px solid ${v("--muted", "#5f7480")};border-radius:3px;
            font-size:12px;line-height:16px;text-align:center;color:${v("--ok", "#1a7f37")};font-weight:700;vertical-align:middle;}
      .tick.on{border-color:${v("--ok", "#1a7f37")};background:${v("--ok-bg", "#eef7ef")};}
      /* the priority mark (Planning): a letter in the order cell, the colour down the row's edge */
      .prio{display:inline-block;width:15px;height:15px;border:1px dashed ${v("--line", "#d7dfe3")};border-radius:3px;
            font-size:10px;line-height:13px;text-align:center;font-weight:800;color:${v("--muted", "#5f7480")};
            vertical-align:middle;}
      .prio.bad{border:1px solid ${v("--danger", "#c0392b")};background:${v("--bad-bg", "#fdecea")};color:${v("--danger", "#c0392b")};}
      .prio.warn{border:1px solid ${v("--warn", "#9a5b00")};background:${v("--warn-bg", "#fff4e0")};color:${v("--warn", "#9a5b00")};}
      .prio.info{border:1px solid ${v("--brand", "#0f4c5c")};background:${v("--info-bg", "#e8f0f3")};color:${v("--brand", "#0f4c5c")};}
      tr.prio-bad td:first-child,tr.prio-warn td:first-child,tr.prio-info td:first-child{padding-left:8px;}
      tr.prio-bad  td:first-child{box-shadow:inset 4px 0 0 ${v("--danger", "#c0392b")};}
      tr.prio-warn td:first-child{box-shadow:inset 4px 0 0 ${v("--warn", "#9a5b00")};}
      tr.prio-info td:first-child{box-shadow:inset 4px 0 0 ${v("--brand", "#0f4c5c")};}
    </style></head><body>
    <h1>${esc(title)}</h1>
    <p class="sub">${esc(subtitle)}</p>
    ${innerHtml}
    <p class="foot">Handpicked Operations Management</p>
    </body></html>`);
  w.document.close();
  // give the new document a moment to lay out before the print engine snapshots it
  w.setTimeout(() => {
    /* One page, when asked: the sheet is shrunk to the printable height of the page rather than
     * spilling a totals row onto a second sheet. The page is A4 with 10 mm margins; CSS pixels are
     * 96 to the inch, so the printable height is (297 - 20) mm or (210 - 20) mm in landscape.
     * `zoom` scales layout and text together and survives the print engine; a sheet that already
     * fits is left alone, and nothing is shrunk below half size - past that it is not legible and a
     * second page is the honest answer. */
    if (opts.onePage) {
      const usableH = ((portrait ? 297 : 210) - 20) / 25.4 * 96;
      const usableW = ((portrait ? 210 : 297) - 20) / 25.4 * 96;
      const z = Math.min(1, usableH / w.document.body.scrollHeight, usableW / w.document.body.scrollWidth);
      if (z < 1) w.document.body.style.zoom = String(Math.max(0.5, z));
    }
    w.focus(); w.print();
  }, 250);
  return true;
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
