/* Reports - the nine Looker Studio pages, rebuilt on live data.
 *
 * The original is a Google Sheets extract refreshed on Looker's schedule; these read the database
 * directly, so they are current rather than as-of-last-refresh, and they share the app's filter bar
 * instead of each page carrying its own set of controls.
 *
 * Improvements over the original, deliberately:
 *   * every page gets a totals row - the Looker tables make you scroll and add up
 *   * "Production" shows the real furthest stage from preparation_events instead of the
 *     hand-typed "_______" placeholders in the sheet
 *   * Short Rail Orders is the Railing page with a width bucket applied, not a separate extract
 *   * every table exports to CSV
 */
import { apiAll, isSignedIn } from "./api.js";
import { tr } from "./i18n.js";
import { PREP_STAGES } from "./config.js";
import {
  $, esc, el, num, aed, fmtDate, today, loading, chip, downloadCsv,
} from "./ui.js";
import { toQuery } from "./filters.js";
import { syncBar } from "./sync.js";

/* Each page: the view it reads, and the columns to show. `fmt` renders a cell; `total` marks a
 * column that gets summed into the totals row. */
export const REPORT_PAGES = [
  {
    id: "orders", key: "rep.orderDetails", view: "v_ops_report_orders",
    order: "installation_date.desc.nullslast",
    cols: [
      { k: "installation_time", key: "rep.instTime" },
      { k: "city", key: "col.city" },
      { k: "issue_flag", key: "rep.issueFlag", fmt: (v) => chip(v || "—", v === "Issue" ? "warn" : "mute") },
      { k: "order_id", key: "col.order", bold: true },
      { k: "customer_name", key: "col.customer" },
      { k: "american_meters", key: "rep.americanM", n: 1, total: 1 },
      { k: "wave_meters", key: "rep.waveM", n: 1, total: 1 },
      { k: "owl_curtains", key: "col.owlCurtains", n: 1, total: 1 },
      { k: "window_count", key: "col.windows", n: 1, total: 1 },
      { k: "owl_blinds", key: "col.owlBlinds", n: 1, total: 1 },
      { k: "owl_total", key: "col.owlTotal", n: 1, total: 1 },
      { k: "meters_sent_total", key: "col.metersSent", n: 1, total: 1 },
      { k: "credits", key: "rep.credits", money: 1, total: 1 },
    ],
  },
  {
    id: "scheduling", key: "rep.scheduling", view: "v_ops_report_orders",
    order: "installation_date.asc.nullslast",
    cols: [
      { k: "installation_time", key: "rep.instTime" },
      { k: "city", key: "col.city" },
      { k: "issue_flag", key: "rep.issueFlag", fmt: (v) => chip(v || "—", v === "Issue" ? "warn" : "mute") },
      { k: "order_id", key: "col.order", bold: true },
      { k: "customer_name", key: "col.customer" },
      { k: "est_minutes", key: "rep.estTime", n: 1, total: 1,
        fmt: (v) => v ? Math.round(v / 60 * 10) / 10 + " h" : "—" },
      { k: "owl_total", key: "col.owlTotal", n: 1, total: 1 },
      { k: "window_count", key: "col.windows", n: 1, total: 1 },
      { k: "owl_blinds", key: "col.owlBlinds", n: 1, total: 1 },
      { k: "owl_curtains", key: "col.owlCurtains", n: 1, total: 1 },
      { k: "n_pelmet", key: "sp.pelmet", n: 1, total: 1 },
      { k: "n_bend_rail", key: "sp.bend", n: 1, total: 1 },
      { k: "n_motor", key: "sp.motor", n: 1, total: 1 },
      { k: "n_scaffolding", key: "sp.scaffolding", n: 1, total: 1 },
      { k: "n_pull_cord", key: "sp.pullcord", n: 1, total: 1 },
      { k: "n_roman", key: "sp.roman", n: 1, total: 1 },
    ],
  },
  {
    id: "production", key: "rep.production", view: "v_ops_report_orders",
    order: "installation_date.asc.nullslast",
    cols: [
      { k: "installation_date", key: "col.install", date: 1 },
      { k: "city", key: "col.city" },
      { k: "issue_flag", key: "rep.issueFlag", fmt: (v) => chip(v || "—", v === "Issue" ? "warn" : "mute") },
      { k: "order_id", key: "col.order", bold: true },
      { k: "_recv", key: "rep.receive", fmt: (_v, r) => bar(r.recv_fab_done, r.recv_fab_total) },
      { k: "_mat", key: "rep.materials", fmt: (_v, r) => bar(r.recv_mat_done, r.recv_mat_total) },
      { k: "_stage", key: "col.production", fmt: (_v, r) => stageCell(r) },
      { k: "window_count", key: "col.windows", n: 1, total: 1 },
      { k: "owl_curtains", key: "rep.curtains", n: 1, total: 1 },
      { k: "meters_sent_total", key: "col.metersSent", n: 1, total: 1 },
      { k: "received_meters", key: "rep.recMeter", n: 1, total: 1 },
    ],
  },
  {
    id: "stitching", key: "rep.stitching", view: "v_ops_report_stitching",
    order: "order_id.desc",
    cols: [
      { k: "window_ref", key: "f.windowRef", bold: true },
      { k: "curtain_stitching_type", key: "f.stitching" },
      { k: "l1_fabric", key: "f.fabric1" },
      { k: "l1_meters_sent", key: "rep.l1Meter", n: 1, total: 1 },
      { k: "l1_width", key: "rep.l1Width" },
      { k: "l1_height", key: "rep.l1Height" },
      { k: "pieces_label", key: "rep.pieces" },
      { k: "l1_pp_comment", key: "rep.l1Comment" },
      { k: "l1_bottom_finish", key: "rep.l1Bottom" },
      { k: "l2_fabric", key: "f.fabric2" },
      { k: "l2_meters_sent", key: "rep.l2Meter", n: 1, total: 1 },
      { k: "l2_width", key: "rep.l2Width" },
      { k: "l2_height", key: "rep.l2Height" },
      { k: "optional_comment", key: "f.comment", wide: 1 },
    ],
  },
  {
    id: "railing", key: "rep.railing", view: "v_ops_report_railing",
    order: "order_id.desc",
    cols: [
      { k: "window_ref", key: "f.windowRef", bold: true },
      { k: "stitching_type", key: "rep.stitchType" },
      { k: "number_of_layers", key: "rep.layers", n: 1 },
      { k: "railing_length", key: "rep.railLength" },
      { k: "num_railings", key: "rep.numRails" },
      { k: "drilling_type", key: "rep.drilling" },
      { k: "brackets", key: "rep.brackets", wide: 1 },
      { k: "production_comment", key: "rep.comments", wide: 1 },
    ],
  },
  {
    id: "shortrail", key: "rep.shortRail", view: "v_ops_report_railing",
    order: "railing_length_num.asc.nullslast",
    extra: "&width_bucket=in.(under 100,100-150)",
    cols: [
      { k: "width_bucket", key: "rep.widthBucket", fmt: (v) => chip(v || "—", "warn") },
      { k: "order_id", key: "col.order", bold: true },
      { k: "window_ref", key: "f.windowRef" },
      { k: "stitching_type", key: "rep.stitchType" },
      { k: "number_of_layers", key: "rep.layers", n: 1 },
      { k: "railing_length", key: "rep.railLength" },
      { k: "num_railings", key: "rep.numRails" },
      { k: "drilling_type", key: "rep.drilling" },
    ],
  },
  {
    id: "dragonmart", key: "rep.dragonMart", view: "v_ops_report_dragonmart",
    order: "installation_date.desc.nullslast",
    cols: [
      { k: "installation_time", key: "rep.instTime" },
      { k: "city", key: "col.city" },
      { k: "issue_flag", key: "rep.issueFlag", fmt: (v) => chip(v || "—", v === "Issue" ? "warn" : "mute") },
      { k: "order_id", key: "col.order", bold: true },
      { k: "customer_name", key: "col.customer" },
      { k: "tailor", key: "rep.dmTailor", bold: true },
      { k: "dispatch_status", key: "rep.dmDispatch",
        fmt: (v) => chip(v || "—", v === "qc_passed" ? "ok" : v === "qc_failed" ? "bad" : "info") },
      { k: "payment_status", key: "rep.dmPayment",
        fmt: (v) => chip(v || "unpaid", v === "paid" ? "ok" : v === "disputed" ? "bad" : "warn") },
      { k: "amount_aed", key: "adj.amount", money: 1, total: 1 },
      { k: "items_count", key: "disp.items", n: 1, total: 1 },
    ],
  },
  /* Comments used to be a ninth entry here, handed off to mod-comments.js. It was never a table like
   * the eight above it - it is the per-line review screen, with its own marking, its own filter bar
   * and its own paging - and it is the screen coordinators work THROUGH rather than glance at.
   * Burying it as a report inside a section inside a tab put it three clicks from the ribbon. It is
   * the PO tab now. Old ?rep=comments links redirect there; see app.js. */
];

function bar(done, total) {
  if (!total) return `<span class="muted">—</span>`;
  const tone = done >= total ? "ok" : done > 0 ? "warn" : "mute";
  return chip(`${done}/${total}`, tone, done >= total ? "✓" : "");
}

/* The furthest production stage actually reached - the Looker original shows hand-typed blanks. */
function stageCell(r) {
  const rank = Number(r.prep_max_rank || 0);
  if (!rank) return `<span class="muted">—</span>`;
  const s = PREP_STAGES[rank - 1];
  // packed and stacked are both finished work; only Started is still in progress
  const done = rank >= 2;
  return chip(tr(s.key), done ? "ok" : "info", done ? "✓" : "›")
    + `<div class="muted" style="font-size:11px">${r.prep_done}/${r.prep_total}</div>`;
}

export async function render(mount, state) {
  if (!isSignedIn()) return;

  // Order details is the default now that Comments has left for the PO tab
  const pageId = state.params.get("rep") || "orders";
  const page = REPORT_PAGES.find((p) => p.id === pageId) || REPORT_PAGES[0];

  mount.innerHTML = `
    <div class="sectionbar">
      <div class="subtabs" id="reptabs"></div>
      <span id="repsync"></span>
    </div>
    <div id="repbody"></div>`;
  $("#repsync", mount).appendChild(syncBar());

  $("#reptabs", mount).innerHTML = REPORT_PAGES.map((p) =>
    `<button data-rep="${p.id}" class="${p.id === page.id ? "on" : ""}">${esc(tr(p.key))}</button>`).join("");
  $("#reptabs", mount).querySelectorAll("[data-rep]").forEach((b) => {
    b.addEventListener("click", () => {
      // keep whatever filters are in the hash; only the report changes
      const q = new URLSearchParams(location.hash.split("?")[1] || "");
      q.set("rep", b.dataset.rep);
      location.hash = "/reports?" + q.toString();
    });
  });

  const box = $("#repbody", mount);

  loading(true, tr("t.loading"));
  let rows = [];
  try {
    rows = await apiAll(
      `/rest/v1/${page.view}?select=*&order=${page.order}${page.extra || ""}${toQuery(state.filters)}`,
      500);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  state.count = rows.length;

  if (!rows.length) {
    box.innerHTML = `<div class="card"><span class="muted">${esc(tr("t.empty"))}</span></div>`;
    return;
  }

  const totals = {};
  page.cols.filter((c) => c.total).forEach((c) => {
    totals[c.k] = rows.reduce((a, r) => a + (Number(r[c.k]) || 0), 0);
  });

  const cell = (c, r) => {
    const v = r[c.k];
    if (c.fmt) return c.fmt(v, r);
    if (v === null || v === undefined || v === "") return `<span class="muted">—</span>`;
    if (c.date) return esc(fmtDate(v));
    if (c.money) return esc(aed(v));
    if (c.n) return esc(num(v));
    return esc(String(v));
  };

  const wrap = el(`<div class="card scrollx" style="padding:0"></div>`);
  wrap.appendChild(el(`
    <table class="dense">
      <thead><tr>${page.cols.map((c) =>
        `<th class="${c.wide ? "wide" : ""}">${esc(tr(c.key))}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.map((r) => `<tr>${page.cols.map((c) =>
          `<td class="${c.wide ? "wide" : ""}">${c.bold ? "<b>" : ""}${cell(c, r)}${c.bold ? "</b>" : ""}</td>`
        ).join("")}</tr>`).join("")}
      </tbody>
      <tfoot><tr>${page.cols.map((c, i) => {
        if (i === 0) return `<th>${esc(tr("rep.total"))} (${rows.length})</th>`;
        if (!c.total) return "<th></th>";
        return `<th>${c.money ? esc(aed(totals[c.k])) : esc(num(totals[c.k]))}</th>`;
      }).join("")}</tr></tfoot>
    </table>`));
  box.appendChild(wrap);

  const dl = el(`<div class="row" style="justify-content:flex-end;margin-top:8px">
    <button class="btn sm">${esc(tr("dash.csv"))}</button></div>`);
  dl.querySelector("button").addEventListener("click", () =>
    downloadCsv(`${page.id}_${today()}.csv`, rows.map((r) => {
      const o = {};
      page.cols.forEach((c) => { if (!c.k.startsWith("_")) o[tr(c.key)] = r[c.k]; });
      return o;
    })));
  box.appendChild(dl);
}
