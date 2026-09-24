/* Reports - the Looker Studio pages, rebuilt on live data, plus the Management Dashboard.
 *
 * The original is a Google Sheets extract refreshed on Looker's schedule; these read the database
 * directly, so they are current rather than as-of-last-refresh, and they share the app's filter bar
 * instead of each page carrying its own set of controls.
 *
 * Improvements over the original, deliberately:
 *   * every page gets a totals row - the Looker tables make you scroll and add up
 *   * "Production tracking" shows the live receiving / preparation counts instead of the
 *     hand-typed "_______" placeholders in the sheet. The seven Looker stage columns (Cut, Hemming,
 *     Iron, Mark + Cut, Taping...) were retired from the workshop screen in Aug 2026, so the live
 *     stages are Fabric in / Materials in / Started / Packed and the furthest stage reached
 *   * Short Rail Orders is the Railing page with a width bucket applied, not a separate extract
 *   * every table exports to CSV
 *
 * Filters (user, 18 Sep 2026): every page mounts the shared bar - installation date, order id,
 * window ref, customer, commercial name, city, 3D-sheet status, plus the four-valued issue flag.
 * Every report view carries the columns the bar emits (report_views_filter_columns migration), so
 * one bar drives all eight pages and the hash carries the filters from page to page.
 *
 * Conditional formatting (same request): numeric columns marked `heat` are shaded by size against
 * the column's own maximum in the filtered set - the Looker tables' blue heat map. One hue for
 * quantities, a second for money, both light enough that the figure stays black on top. Status-like
 * columns are chips with a tone AND a word, never colour alone.
 */
import { apiAll, rpc, submit, isSignedIn, isViewer, currentActor, pendingWrites } from "./api.js";
import { tr, tv } from "./i18n.js";
import { PREP_STAGES, ISSUE_FLAGS, PLAN_PRIORITIES, STORAGE_PREFIX, flagOf, priorityOf } from "./config.js";
import {
  $, esc, el, num, aed, aed0, fmtDate, fmtDateTime, today, loading, chip, downloadCsv, printSheet, toast,
  confirmSheet,
} from "./ui.js";
import { renderFilterBar, toQuery, deriveOptions, writeHash, vals, TEXT_FIELDS, MULTI_FIELDS } from "./filters.js";
import { syncBar } from "./sync.js";

/* The issue flag as a chip: tone from ISSUE_FLAGS, wording translated. */
const flagChip = (v) => {
  const f = flagOf(v);
  return chip(f.key ? tr(f.key) : (v || "—"), f.tone);
};

/* Each page: the view it reads, and the columns to show. `fmt` renders a cell; `total` marks a
 * column that gets summed into the totals row; `heat` shades the cell by size (1 = quantity hue,
 * "money" = the money hue). `caps` tells the filter bar which optional fields the view supports. */
const CAPS = { flag: true };

export const REPORT_PAGES = [
  { id: "mgmt", key: "rep.mgmt", custom: true },
  {
    id: "orders", key: "rep.orderDetails", view: "v_ops_report_orders",
    order: "installation_date.desc.nullslast",
    cols: [
      { k: "installation_date", key: "col.install", date: 1 },
      { k: "installation_time", key: "rep.instTime" },
      { k: "city", key: "col.city" },
      { k: "issue_flag", key: "rep.issueFlag", fmt: flagChip },
      { k: "order_id", key: "col.order", bold: true },
      { k: "customer_name", key: "col.customer" },
      { k: "american_meters", key: "rep.americanM", n: 1, total: 1, heat: 1 },
      { k: "wave_meters", key: "rep.waveM", n: 1, total: 1, heat: 1 },
      { k: "owl_curtains", key: "col.owlCurtains", n: 1, total: 1, heat: 1 },
      { k: "window_count", key: "col.windows", n: 1, total: 1, heat: 1 },
      { k: "owl_blinds", key: "col.owlBlinds", n: 1, total: 1, heat: 1 },
      { k: "owl_total", key: "col.owlTotal", n: 1, total: 1, heat: 1 },
      { k: "report_meters", key: "col.meters", n: 1, total: 1, heat: 1 },
      { k: "credits", key: "rep.credits", money: 1, total: 1, heat: "money" },
    ],
  },
  {
    id: "scheduling", key: "rep.scheduling", view: "v_ops_report_orders",
    order: "installation_date.asc.nullslast",
    cols: [
      { k: "installation_date", key: "col.install", date: 1 },
      { k: "installation_time", key: "rep.instTime" },
      { k: "city", key: "col.city" },
      { k: "issue_flag", key: "rep.issueFlag", fmt: flagChip },
      { k: "order_id", key: "col.order", bold: true },
      { k: "customer_name", key: "col.customer" },
      { k: "est_minutes", key: "rep.estTime", n: 1, total: 1, heat: 1,
        fmt: (v) => v ? Math.round(v / 60 * 10) / 10 + " h" : "—" },
      { k: "owl_total", key: "col.owlTotal", n: 1, total: 1, heat: 1 },
      { k: "window_count", key: "col.windows", n: 1, total: 1, heat: 1 },
      { k: "owl_blinds", key: "col.owlBlinds", n: 1, total: 1, heat: 1 },
      { k: "owl_curtains", key: "col.owlCurtains", n: 1, total: 1, heat: 1 },
      { k: "n_pelmet", key: "sp.pelmet", n: 1, total: 1, heat: 1 },
      { k: "n_bend_rail", key: "sp.bend", n: 1, total: 1, heat: 1 },
      { k: "n_motor", key: "sp.motor", n: 1, total: 1, heat: 1 },
      { k: "n_scaffolding", key: "sp.scaffolding", n: 1, total: 1, heat: 1 },
      { k: "n_pull_cord", key: "sp.pullcord", n: 1, total: 1, heat: 1 },
      { k: "n_roman", key: "sp.roman", n: 1, total: 1, heat: 1 },
    ],
  },
  {
    /* The Looker "Production Tracking" page - called PLANNING since 18 Sep 2026 (user), and on the
     * launcher, Home and the ribbon as its own target. It is the workshop's sheet, and since the
     * same day it is LIVE: the seven Looker stage columns - Receive, Cut, Hemming, Iron, Marking,
     * Taping, Fold - are tick boxes the production team ticks here, per order, plus a comment. A
     * tick writes planning_status (fn_ops_planning_set, through the offline queue like every other
     * write), and the roster's production_state reads it, so the Dashboard's "by production status"
     * moves with the sheet. A box the app already knows from its own records - Receive when every
     * fabric is received, Cut when preparation started, Fold when packed - is shown ticked and
     * LOCKED: what the Preparation and Production screens recorded per window is not undone from a
     * sheet at order grain. Ad hoc orders are added at the foot of the list for a date
     * (planning_extra). Printed portrait, one page, it is still the paper sheet. Opens sorted by
     * type (Order first), city, order id; any header re-sorts it. */
    id: "production", key: "rep.production", view: "v_ops_report_orders",
    order: "installation_date.asc.nullslast",
    defaultSort: ["issue_flag", "city", "order_id"],
    print: { portrait: true, onePage: true },
    live: true,
    /* The foot of the sheet is three subtotal rows rather than one total - Abu Dhabi, Dubai, and the
     * two together - with ISR rows left out of all three: a rework's metres are not the day's
     * production (user, 24 Sep 2026). Rows with no city count in neither. */
    subtotals: { by: "city", groups: ["Abu Dhabi", "Dubai"], skipFlag: "ISR" },
    /* `w` is a width in px, applied to the header cell. On screen it fixes the column; on the
     * portrait sheet the table is laid out fixed at 100%, so these act as PROPORTIONS. The stage
     * boxes are the point of the sheet and get the room; customer and time give it up (user, 18 Sep). */
    cols: [
      // screen only: tick orders to add their fabric up in the bar above the sheet (see pickBar);
      // the column is taken out of the printed sheet, so the widths below keep their proportions
      { k: "_sel", key: "rep.pick", sel: 1, w: 30 },
      { k: "installation_date", key: "col.install", date: 1, w: 68, wrap: 1 },
      { k: "installation_time", key: "rep.time", w: 54 },
      { k: "city", key: "col.city", w: 64, wrap: 1 },
      { k: "issue_flag", key: "rep.issueFlag", fmt: flagChip, w: 62 },
      // 60 -> 78: the order cell carries the priority mark too (prioCell). The printed sheet reads
      // these widths as proportions of their own total, so the other columns give up a hair each
      // rather than the sheet growing past the page.
      { k: "order_id", key: "col.order", bold: true, w: 78 },
      { k: "customer_name", key: "col.customer", w: 90, wrap: 1 },
      { k: "_recv", key: "rep.receive", fmt: (_v, r) => bar(r.recv_fab_done, r.recv_fab_total), w: 66, wrap: 1 },
      { k: "_mat", key: "rep.materials", fmt: (_v, r) => bar(r.recv_mat_done, r.recv_mat_total), w: 70, wrap: 1 },
      { k: "_st_receive", key: "rep.stReceive", tick: 1, w: 62, fmt: (_v, r) => tickCell(r, "receive") },
      { k: "_st_cut",     key: "rep.stCut",     tick: 1, w: 62, fmt: (_v, r) => tickCell(r, "cut") },
      { k: "_st_hem",     key: "rep.stHem",     tick: 1, w: 62, fmt: (_v, r) => tickCell(r, "hemming") },
      { k: "_st_iron",    key: "rep.stIron",    tick: 1, w: 62, fmt: (_v, r) => tickCell(r, "iron") },
      { k: "_st_mark",    key: "rep.stMark",    tick: 1, w: 62, fmt: (_v, r) => tickCell(r, "marking") },
      { k: "_st_tape",    key: "rep.stTape",    tick: 1, w: 62, fmt: (_v, r) => tickCell(r, "taping") },
      { k: "_st_fold",    key: "rep.stFold",    tick: 1, w: 62, fmt: (_v, r) => tickCell(r, "fold") },
      { k: "plan_comment", key: "rep.comment", w: 120, wrap: 1, fmt: (v, r) => commentCell(r) },
      { k: "owl_curtains", key: "rep.curtains", n: 1, total: 1, heat: 1, w: 52 },
      { k: "report_meters", key: "col.meters", n: 1, total: 1, heat: 1, w: 62 },
      { k: "received_meters", key: "rep.recMeter", n: 1, total: 1, heat: 1, w: 62 },
    ],
  },
  {
    id: "stitching", key: "rep.stitching", view: "v_ops_report_stitching",
    order: "order_id.desc",
    cols: [
      { k: "order_id", key: "col.order", bold: true },
      { k: "installation_date", key: "col.install", date: 1 },
      { k: "issue_flag", key: "rep.issueFlag", fmt: flagChip },
      { k: "window_ref", key: "f.windowRef", bold: true },
      { k: "curtain_stitching_type", key: "f.stitching" },
      { k: "l1_fabric", key: "f.fabric1" },
      { k: "l1_meters_sent", key: "rep.l1Meter", n: 1, total: 1, heat: 1 },
      { k: "l1_width", key: "rep.l1Width" },
      { k: "l1_height", key: "rep.l1Height" },
      { k: "pieces_label", key: "rep.pieces" },
      { k: "l1_pp_comment", key: "rep.l1Comment" },
      { k: "l1_bottom_finish", key: "rep.l1Bottom" },
      { k: "l2_fabric", key: "f.fabric2" },
      { k: "l2_meters_sent", key: "rep.l2Meter", n: 1, total: 1, heat: 1 },
      { k: "l2_width", key: "rep.l2Width" },
      { k: "l2_height", key: "rep.l2Height" },
      { k: "optional_comment", key: "f.comment", wide: 1 },
    ],
  },
  {
    id: "railing", key: "rep.railing", view: "v_ops_report_railing",
    order: "order_id.desc",
    cols: [
      { k: "order_id", key: "col.order", bold: true },
      { k: "installation_date", key: "col.install", date: 1 },
      { k: "issue_flag", key: "rep.issueFlag", fmt: flagChip },
      { k: "window_ref", key: "f.windowRef", bold: true },
      { k: "stitching_type", key: "rep.stitchType" },
      { k: "number_of_layers", key: "rep.layers", n: 1 },
      { k: "railing_length", key: "rep.railLength" },
      { k: "num_railings", key: "rep.numRails" },
      { k: "drilling_type", key: "rep.drilling" },
      { k: "brackets", key: "rep.brackets", wide: 1 },
      { k: "production_comment", key: "rep.comments", wide: 1 },
      { k: "rail_done", key: "rep.railDone",
        fmt: (v) => v ? chip(tr("t.yes"), "ok", "✓") : chip(tr("t.no"), "mute") },
    ],
  },
  {
    id: "shortrail", key: "rep.shortRail", view: "v_ops_report_railing",
    order: "railing_length_num.asc.nullslast",
    extra: "&width_bucket=in.(under 100,100-150)",
    cols: [
      { k: "width_bucket", key: "rep.widthBucket", fmt: (v) => chip(v || "—", "warn") },
      { k: "order_id", key: "col.order", bold: true },
      { k: "installation_date", key: "col.install", date: 1 },
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
      { k: "installation_date", key: "col.install", date: 1 },
      { k: "installation_time", key: "rep.instTime" },
      { k: "city", key: "col.city" },
      { k: "issue_flag", key: "rep.issueFlag", fmt: flagChip },
      { k: "order_id", key: "col.order", bold: true },
      { k: "customer_name", key: "col.customer" },
      { k: "tailor", key: "rep.dmTailor", bold: true },
      { k: "dispatch_status", key: "rep.dmDispatch",
        fmt: (v) => chip(v || "—", v === "qc_passed" ? "ok" : v === "qc_failed" ? "bad" : "info") },
      { k: "payment_status", key: "rep.dmPayment",
        fmt: (v) => chip(v || "unpaid", v === "paid" ? "ok" : v === "disputed" ? "bad" : "warn") },
      { k: "amount_aed", key: "adj.amount", money: 1, total: 1, heat: "money" },
      { k: "items_count", key: "disp.items", n: 1, total: 1, heat: 1 },
    ],
  },
  {
    /* Tailors' own reports over WhatsApp (wa-inbound, the tailor path): one row per window a tailor
     * said they finished, with the metres the order's lines carry for that window - which is how
     * "who stitched how much" is answered. Summed per tailor above the table. */
    id: "tailors", key: "rep.tailorWork", view: "v_tailor_work",
    order: "created_at.desc",
    summaryBy: { k: "tailor_name", sum: "meters", unit: "m" },
    cols: [
      { k: "created_at", key: "rep.when", fmt: (v) => esc(fmtDateTime(v)) },
      { k: "tailor_name", key: "rep.dmTailor", bold: true },
      { k: "order_id", key: "col.order", bold: true },
      { k: "customer_name", key: "col.customer" },
      { k: "window_name", key: "f.windowRef" },
      { k: "work", key: "rep.work", fmt: (v) => v ? String(v).split(", ").map((w) => chip(tr(WORK_KEY[w] || "rep.work"), "info")).join(" ") : `<span class="muted">—</span>` },
      { k: "meters", key: "col.meters", n: 1, total: 1, heat: 1 },
      { k: "fabrics", key: "f.fabric1" },
      { k: "layers", key: "rep.layers", n: 1 },
      { k: "installation_date", key: "col.install", date: 1 },
      { k: "city", key: "col.city" },
      { k: "said", key: "rep.said", wide: 1 },
    ],
  },
  /* Comments used to be a ninth entry here, handed off to mod-comments.js. It was never a table like
   * the eight above it - it is the per-line review screen, with its own marking, its own filter bar
   * and its own paging - and it is the screen coordinators work THROUGH rather than glance at.
   * Burying it as a report inside a section inside a tab put it three clicks from the ribbon. It is
   * the PO tab now. Old ?rep=comments links redirect there; see app.js. */
];

/* What the filter bar is narrowing to, as one line for the PDF header - so a printed sheet says
 * what it is a sheet OF, which a screen with the bar above it never had to. */
function filterSummary(f) {
  const parts = [];
  TEXT_FIELDS.forEach((k) => { if (f[k]) parts.push(`${k}: ${f[k]}`); });
  MULTI_FIELDS.forEach((k) => { const v = vals(f, k); if (v.length) parts.push(`${k}: ${v.join(", ")}`); });
  return parts.length ? parts.join(" · ") : tr("f.none", { m: "" }).replace(/\s*·.*$/, "");
}

/* The CSV and PDF buttons under a table. The PDF is the table as drawn - chips, heat shading, totals
 * - printed through the browser (see printSheet in ui.js), so it needs the table's HTML, not the rows. */
function downloadRow(pageId, title, rows, csvRows, tableHtml, f, printOpts) {
  const row = el(`<div class="row" style="justify-content:flex-end;margin-top:8px;gap:8px">
    <button class="btn sm" data-csv>${esc(tr("dash.csv"))}</button>
    <button class="btn sm" data-pdf>${esc(tr("dash.pdf"))}</button></div>`);
  row.querySelector("[data-csv]").addEventListener("click", () => downloadCsv(`${pageId}_${today()}.csv`, csvRows()));
  row.querySelector("[data-pdf]").addEventListener("click", () => {
    const sub = `${filterSummary(f)} · ${rows} ${tr("rep.rows")} · ${fmtDateTime(new Date().toISOString())}`;
    if (!printSheet(title, sub, tableHtml(), printOpts)) toast(tr("rep.pdfBlocked"), "bad");
  });
  return row;
}

/* ---------------------------------------------------------------- sorting
 * Every column title sorts, in the browser, over the whole filtered set - the same discipline as
 * the Production module: the rows are already here, so a click costs no round trip, and the stage
 * columns are built out of several fields each and could not be an `order=` anyway. A page may
 * carry a defaultSort (several keys, applied in turn) that the first paint uses; clicking a header
 * goes ascending, then descending, then back to that default. Sort state lives per page for the
 * session, so switching tabs and back keeps what was chosen. */
const SORT = {};                                  // page id -> { col, dir } | null
const FLAG_RANK = Object.fromEntries(ISSUE_FLAGS.map((f, i) => [f.value, i]));
const frac = (done, total) => (Number(total) ? Number(done) / Number(total) : -1);
const SORT_KEYS = {
  issue_flag: (r) => (r.issue_flag in FLAG_RANK ? FLAG_RANK[r.issue_flag] : ISSUE_FLAGS.length),
  _recv:      (r) => frac(r.recv_fab_done, r.recv_fab_total),
  _mat:       (r) => frac(r.recv_mat_done, r.recv_mat_total),
  _started:   (r) => frac(r.prep_started, r.prep_total),
  _packed:    (r) => frac(r.prep_done, r.prep_total),
  _stage:     (r) => Number(r.prep_max_rank || 0) + Math.max(0, frac(r.prep_done, r.prep_total)),
  _st_receive: (r) => (stageOn(r, "receive") ? 1 : 0),
  _st_cut:     (r) => (stageOn(r, "cut") ? 1 : 0),
  _st_hem:     (r) => (stageOn(r, "hemming") ? 1 : 0),
  _st_iron:    (r) => (stageOn(r, "iron") ? 1 : 0),
  _st_mark:    (r) => (stageOn(r, "marking") ? 1 : 0),
  _st_tape:    (r) => (stageOn(r, "taping") ? 1 : 0),
  _st_fold:    (r) => (stageOn(r, "fold") ? 1 : 0),
};
const blank = (v) => v === null || v === undefined || v === "";
// a numeric column compares as a number, but an EMPTY cell stays empty so it sorts last (below)
const sortKey = (c) => SORT_KEYS[c.k]
  || ((r) => (c.n || c.money ? (blank(r[c.k]) ? r[c.k] : Number(r[c.k]) || 0) : r[c.k]));
const cmp = (a, b) => (typeof a === "number" && typeof b === "number"
  ? a - b
  : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }));
/* A sorted COPY. The index tiebreak keeps equal rows in the order the server gave them. */
function sortRows(page, rows) {
  const st = SORT[page.id];
  const keys = st
    ? [{ key: sortKey(page.cols.find((c) => c.k === st.col) || { k: st.col }), dir: st.dir === "desc" ? -1 : 1 }]
    : (page.defaultSort || []).map((k) => ({ key: sortKey(page.cols.find((c) => c.k === k) || { k }), dir: 1 }));
  if (!keys.length) return rows.slice();
  return rows
    .map((r, i) => ({ r, i, ks: keys.map((k) => k.key(r)) }))
    .sort((a, b) => {
      for (let j = 0; j < keys.length; j++) {
        const A = a.ks[j], B = b.ks[j];
        // blanks last in BOTH directions: reversing a column must not fill the top with empties
        if (blank(A) !== blank(B)) return blank(A) ? 1 : -1;
        if (!blank(A)) {
          const c = cmp(A, B);
          if (c) return c * keys[j].dir;
        }
      }
      return a.i - b.i;
    })
    .map((x) => x.r);
}
const sortState = (page, k) => (SORT[page.id]?.col === k ? (SORT[page.id].dir === "desc" ? "descending" : "ascending") : "none");
const sortGlyph = (page, k) => (SORT[page.id]?.col === k ? (SORT[page.id].dir === "desc" ? "▼" : "▲") : "↕");

const WORK_KEY = { hemming: "rep.stHem", taping: "rep.stTape", tie_belts: "rep.tieBelts", lead_band: "rep.leadBand" };

/* Heat map. Five light steps of the app's single hue for quantities (the light end of
 * ORDINAL_RAMP, extended down), a warm ramp for money so the two never read as one scale. Every
 * step keeps black text above 7:1, which is the whole reason these stop where they do. */
const HEAT_QTY = ["", "#f2f7f9", "#e3eef2", "#d1e3ea", "#bfd8e1", "#accdd8"];
const HEAT_AED = ["", "#fbf5ec", "#f7ebd8", "#f2dfc1", "#edd3aa", "#e8c793"];
function heatStyle(v, max, kind) {
  const n = Number(v) || 0;
  if (!(n > 0) || !(max > 0)) return "";
  const ramp = kind === "money" ? HEAT_AED : HEAT_QTY;
  const step = Math.min(ramp.length - 1, Math.max(1, Math.ceil((n / max) * (ramp.length - 1))));
  return ` style="background:${ramp[step]}"`;
}

/* ---------------------------------------------------------------- the live Planning sheet
 * What the app's own records already say about a stage. These are the ticks that come locked: a
 * fabric the Production tab marked received, a window the Preparation screen started or packed. */
const SYS_TICK = {
  receive: (r) => Number(r.recv_fab_total) > 0 && Number(r.recv_fab_done) >= Number(r.recv_fab_total),
  cut:     (r) => Number(r.prep_started) > 0,
  fold:    (r) => Number(r.prep_done) > 0,
};
const stageOn = (r, stage) => !!(r["plan_" + stage] || (SYS_TICK[stage] && SYS_TICK[stage](r)));
const STAGE_KEY = { receive: "rep.stReceive", cut: "rep.stCut", hemming: "rep.stHem", iron: "rep.stIron",
                    marking: "rep.stMark", taping: "rep.stTape", fold: "rep.stFold" };

/* A tick box. Ticked by the team here, or ticked-and-locked by the app's records; a viewer sees the
 * state and cannot change it. Never colour alone - the glyph is the state, the padlock the lock. */
function tickCell(r, stage) {
  const sys = !!(SYS_TICK[stage] && SYS_TICK[stage](r));
  const on = stageOn(r, stage);
  const cls = `tick${on ? " on" : ""}${sys ? " sys" : ""}`;
  if (isViewer() || sys) {
    return `<span class="${cls}" title="${sys ? esc(tr("rep.planLocked")) : ""}">${on ? "✓" : ""}</span>`;
  }
  return `<button type="button" class="${cls}" data-tick="${esc(stage)}" data-order="${esc(r.order_id)}"
            aria-pressed="${on}" title="${esc(tr("rep.planTick"))}">${on ? "✓" : ""}</button>`;
}
const tick = (on) => `<span class="tick${on ? " on" : ""}">${on ? "✓" : ""}</span>`;

/* ---------------------------------------------------------------- the priority mark (22 Sep 2026)
 * High / Medium / Low, or nothing. Asked for as a colour, and given no column of its own: the mark
 * rides INSIDE the order cell and colours the row's left edge, so the fourteen columns the sheet
 * already fits on one portrait page keep their room (user, 22 Sep 2026).
 *
 * One tap moves to the next - none → High → Medium → Low → none - and unlike a stage tick it asks
 * no question first. A tick reaches the Dashboard the same second and is worth a question; a
 * priority reaches nobody but this sheet, and the next tap takes it back.
 *
 * A viewer sees the mark and not a button, and sees nothing at all where there is no priority -
 * an empty box on every row of a sheet they cannot change is clutter, not information. */
const prioNext = (v) => {
  const i = PLAN_PRIORITIES.findIndex((p) => p.value === v);
  return i < 0 ? PLAN_PRIORITIES[0].value : (PLAN_PRIORITIES[i + 1] || { value: null }).value;
};
const prioWords = (p) => `${tr("rep.priority")}: ${p ? tr(p.key) : tr("rep.prioNone")}`;
function prioCell(r) {
  const p = priorityOf(r.plan_priority);
  const cls = `prio${p ? " " + p.tone : ""}`;
  if (isViewer()) {
    return p ? `<span class="${cls}" title="${esc(prioWords(p))}">${esc(p.glyph)}</span> ` : "";
  }
  return `<button type="button" class="${cls}" data-prio="${esc(r.order_id)}"
            title="${esc(prioWords(p) + " — " + tr("rep.prioTap"))}"
            aria-label="${esc(prioWords(p))}">${esc(p ? p.glyph : "")}</button> `;
}

function commentCell(r) {
  const v = r.plan_comment || "";
  if (isViewer()) return esc(v) || `<span class="muted">—</span>`;
  return `<input class="plancmt" data-cmt="${esc(r.order_id)}" value="${esc(v)}" placeholder="…"
            aria-label="${esc(tr("rep.comment"))} ${esc(r.order_id)}">`;
}

/* Ticks and comments, delegated on the table so a re-sort (which rebuilds the body) keeps them.
 * Every tick asks first (user, 18 Sep 2026) - a stage marked done reaches the Dashboard the same
 * second, and a thumb on a phone in a workshop lands on the wrong row often enough - and ticking
 * again undoes it, through the same question. Then optimistic: the box flips at once, the write
 * goes through the offline queue, and a refusal flips it back with the server's reason. The row
 * object is updated too, so a later sort or the CSV sees what was ticked without a re-fetch.
 *
 * The row and the box are looked up in LIVE - the sheet as it stands NOW - rather than held from
 * the click. Since the sheet paints from the device's copy and then again from the server (see
 * renderLive), a table can be replaced while the question is still open; a tick applied to the
 * old row object and a detached button would go to the server and never show on screen. */
const LIVE = { key: null, rows: [], byId: new Map(), table: null };
const liveRow = (id) => LIVE.byId.get(String(id));
const liveBox = (id, stage) => LIVE.table && LIVE.table.querySelector(
  `[data-tick="${CSS.escape(stage)}"][data-order="${CSS.escape(String(id))}"]`);
const paintTick = (id, stage, on) => {
  const b = liveBox(id, stage);
  if (!b) return;
  b.classList.toggle("on", on); b.textContent = on ? "✓" : ""; b.setAttribute("aria-pressed", String(on));
};
/* The mark AND the row's edge, which is the half of it that can be read from across the workshop. */
const paintPrio = (id, v) => {
  const b = LIVE.table && LIVE.table.querySelector(`[data-prio="${CSS.escape(String(id))}"]`);
  if (!b) return;
  const p = priorityOf(v);
  b.className = `prio${p ? " " + p.tone : ""}`;
  b.textContent = p ? p.glyph : "";
  b.title = prioWords(p) + " — " + tr("rep.prioTap");
  b.setAttribute("aria-label", prioWords(p));
  const row = b.closest("tr");
  if (row) {
    PLAN_PRIORITIES.forEach((q) => row.classList.remove("prio-" + q.tone));
    if (p) row.classList.add("prio-" + p.tone);
  }
};
function wireLive(table) {
  table.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-tick]");
    if (!b) return;
    const id = b.dataset.order, stage = b.dataset.tick;
    const r0 = liveRow(id);
    if (!r0) return;
    const next = !r0["plan_" + stage];
    const who = `${r0.order_id}${r0.customer_name ? " · " + r0.customer_name : ""}`;
    const ok = await confirmSheet(
      tr(next ? "rep.confirmTick" : "rep.confirmUntick", { stage: tr(STAGE_KEY[stage]), id: who }),
      tr(next ? "rep.confirmTickBody" : "rep.confirmUntickBody"));
    if (!ok) return;
    const r = liveRow(id) || r0;          // the sheet may have been repainted while the question was open
    r["plan_" + stage] = next; r._touched = Date.now();
    paintTick(id, stage, next);
    keepSheet(LIVE.key, LIVE.rows);
    try {
      await submit("fn_ops_planning_set", { p_order_id: r.order_id, p_stage: stage, p_on: next, p_actor: currentActor() });
    } catch (err) {
      const r2 = liveRow(id) || r;
      r2["plan_" + stage] = !next; r2._touched = Date.now();
      paintTick(id, stage, !next);
      keepSheet(LIVE.key, LIVE.rows);
      toast(err.message || String(err), "bad");
    }
  });
  /* Priority: optimistic like a tick, through the same queue, and put back with the server's
   * reason if the write is refused. No confirmation - see prioCell. */
  table.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-prio]");
    if (!b) return;
    const id = b.dataset.prio;
    const r0 = liveRow(id);
    if (!r0) return;
    const prev = r0.plan_priority || null;
    const next = prioNext(prev);
    r0.plan_priority = next; r0._touched = Date.now();
    paintPrio(id, next);
    keepSheet(LIVE.key, LIVE.rows);
    try {
      await submit("fn_ops_planning_priority", { p_order_id: r0.order_id, p_priority: next, p_actor: currentActor() });
    } catch (err) {
      const r2 = liveRow(id) || r0;
      r2.plan_priority = prev; r2._touched = Date.now();
      paintPrio(id, prev);
      keepSheet(LIVE.key, LIVE.rows);
      toast(err.message || String(err), "bad");
    }
  });
  table.addEventListener("change", async (e) => {
    const i = e.target.closest("[data-cmt]");
    if (!i) return;
    const r = liveRow(i.dataset.cmt);
    if (!r) return;
    const prev = r.plan_comment || "";
    r.plan_comment = i.value.trim(); r._touched = Date.now();
    keepSheet(LIVE.key, LIVE.rows);
    try {
      await submit("fn_ops_planning_comment", { p_order_id: r.order_id, p_comment: r.plan_comment, p_actor: currentActor() });
    } catch (err) {
      r.plan_comment = prev; i.value = prev; r._touched = Date.now();
      keepSheet(LIVE.key, LIVE.rows);
      toast(err.message || String(err), "bad");
    }
  });
}

/* ---------------------------------------------------------------- tick to add up (24 Sep 2026)
 * A box on every row of the sheet, and a bar above it that adds up the fabric metres of whatever
 * is ticked - the sum the team was doing on a calculator (user, 24 Sep 2026). It writes nothing:
 * the ticks are this device's, kept per sheet (day + filters) for the session, so a re-sort or the
 * server's repaint keeps them and another day starts empty. A viewer can use it too. */
const PICKS = new Map();                                 // sheet key -> Set of order ids
const picks = () => {
  if (!PICKS.has(LIVE.key)) PICKS.set(LIVE.key, new Set());
  return PICKS.get(LIVE.key);
};
const pickSum = (ids, k) => ids.reduce((a, id) => a + (Number((liveRow(id) || {})[k]) || 0), 0);
function pickBar() {
  const b = el(`<div class="selbar planpick" role="status" aria-live="polite"></div>`);
  b.addEventListener("click", (e) => {
    if (!e.target.closest("[data-pickclear]")) return;
    picks().clear();
    paintPicks();
  });
  return b;
}
/* The bar, the boxes and the row shading, from the set. Rows that are no longer on the sheet (the
 * server dropped an order since it was ticked) fall out of the sum rather than haunting it. */
function paintPicks() {
  const set = picks();
  [...set].forEach((id) => { if (!liveRow(id)) set.delete(id); });
  const ids = [...set];
  const bar = LIVE.table && LIVE.table.closest("#repbody")?.querySelector(".planpick");
  if (bar) {
    bar.innerHTML = ids.length
      ? `<span class="selcount"><b>${esc(tr("rep.picked", { n: ids.length }))}</b></span>
         <span class="picksum">${esc(tr("rep.pickFabric"))}: <b>${esc(num(pickSum(ids, "report_meters")))} m</b></span>
         <span class="picksum">${esc(tr("rep.pickRecv"))}: <b>${esc(num(pickSum(ids, "received_meters")))} m</b></span>
         <button type="button" class="btn sm" data-pickclear>${esc(tr("rep.pickClear"))}</button>`
      : `<span class="selcount">☐ ${esc(tr("rep.pickNone"))}</span>`;
  }
  if (!LIVE.table) return;
  LIVE.table.querySelectorAll("input[data-pick]").forEach((cb) => {
    cb.checked = set.has(cb.dataset.pick);
    cb.closest("tr").classList.toggle("selected", cb.checked);
  });
  const all = LIVE.table.querySelector("input[data-pickall]");
  if (all) {
    all.checked = ids.length > 0 && ids.length === LIVE.rows.length;
    all.indeterminate = ids.length > 0 && ids.length < LIVE.rows.length;
  }
}

/* The sheet scrolls inside its own box, so its column titles stay on screen (thead sticks to the
 * top of the box) and so do the subtotals (tfoot sticks to the bottom). A table that scrolls
 * sideways cannot pin its header to the WINDOW - overflow-x makes the box the scroll container -
 * which is why the titles used to scroll away (user, 24 Sep 2026). The box is sized to what is
 * left of the window under the app header, the tabs and the tick bar, all measured, because the
 * header wraps onto more lines on a narrow screen. */
const restsAt = (node) => {
  if (!node) return 0;
  const s = getComputedStyle(node);
  return s.position === "sticky" ? (parseFloat(s.top) || 0) + node.offsetHeight : 0;
};
function fitPlan() {
  const box = LIVE.table && LIVE.table.closest(".planscroll");
  if (!box || !box.isConnected) return;
  const chrome = Math.max(restsAt($("#hdr")), restsAt($("nav.tabs")));
  const bar = box.parentElement.querySelector(".planpick");
  if (bar) bar.style.top = chrome + "px";
  box.style.maxHeight = `calc(100vh - ${chrome + (bar ? bar.offsetHeight + 10 : 0) + 8}px)`;
  // the subtotal rows, stacked from the bottom up: each sits on the heights of the rows below it
  let under = 0;
  [...LIVE.table.querySelectorAll("tfoot tr")].reverse().forEach((tr) => {
    tr.querySelectorAll("th").forEach((th) => { th.style.bottom = under + "px"; });
    under += Math.floor(tr.getBoundingClientRect().height);   // down, never up: overlap a hair, no gap
  });
}
window.addEventListener("resize", fitPlan);

/* ---------------------------------------------------------------- one day at a time
 * Planning works ONE date at a time (user, 19 Sep 2026). The sheet is a sheet for a day, and the
 * workshop has several days' sheets in hand at once - today's, tomorrow's, the day after's - and
 * moves between them all shift. So the day is not a From / To with an Apply: it is a strip above
 * the bar - previous / next, the week ahead as chips, a date box for any other day - and every
 * control on it switches the sheet the moment it is touched. The day rides in the hash as ?date=,
 * the way the Schedule board's does, so a link still names a day and Back steps through the days
 * visited; the bar's own bucket row and From / To stay off this page (caps.singleDate).
 *
 * The day is also REMEMBERED on the device. Opening Planning with no day in the hash - the ribbon,
 * the launcher, the Home tile - lands on the day this phone was last working on, as long as that
 * day has not passed: a phone in the workshop is on the same sheet all afternoon, and making its
 * owner pick the day again on every visit is the Apply button back under another name. */
const PLAN_DATE_KEY = STORAGE_PREFIX + "plan_date";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/* Calendar arithmetic in UTC on purpose: `new Date("…T00:00:00")` is LOCAL midnight, which
 * toISOString() renders as 20:00 the day before anywhere east of Greenwich - Dubai included. */
const isoShift = (iso, days) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const dayChip = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", timeZone: "UTC" });
};
const DAYS_AHEAD = 7;                                  // chips: today and the six days after it

function planDate(state) {
  const q = state.params.get("date");
  if (q && ISO_DATE.test(q)) return q;
  let kept = "";
  try { kept = localStorage.getItem(PLAN_DATE_KEY) || ""; } catch (e) {}
  return ISO_DATE.test(kept) && kept >= today() ? kept : today();
}
const rememberDate = (date) => { try { localStorage.setItem(PLAN_DATE_KEY, date); } catch (e) {} };

/* Where the sheet was scrolled to, per day, for the session: coming back to a day lands on the
 * row that was being worked, not at the top of the list again. */
const SCROLL = new Map();

/* The strip. Every control writes the day into the hash and the router repaints - no Apply. The
 * other filters ride along untouched, as they do when a report sub-tab is clicked. */
function dateStrip(page, f, date) {
  const td = today();
  const chips = Array.from({ length: DAYS_AHEAD }, (_, i) => isoShift(td, i));
  const strip = el(`<div class="card plandate">
    <div class="schdate">
      <button type="button" class="btn ghost sm" data-shift="-1" title="${esc(tr("sch.prev"))}" aria-label="${esc(tr("sch.prev"))}">◀</button>
      <div class="schdateinner">
        <div class="schdatelabel">${esc(tr("rep.sheetFor"))}</div>
        <div class="schdatebig">${esc(fmtDate(date))}</div>
        <input type="date" name="plandate" value="${esc(date)}" aria-label="${esc(tr("rep.sheetFor"))}">
      </div>
      <button type="button" class="btn ghost sm" data-shift="1" title="${esc(tr("sch.next"))}" aria-label="${esc(tr("sch.next"))}">▶</button>
    </div>
    <div class="daychips" role="group" aria-label="${esc(tr("rep.sheetFor"))}">${chips.map((d, i) =>
      `<button type="button" class="${d === date ? "on" : ""}" data-date="${d}" aria-pressed="${d === date}">${
        i === 0 ? "● " + esc(tr("bucket.today")) : esc(dayChip(d))}</button>`).join("")}</div>
  </div>`);
  const go = (d) => {
    if (!ISO_DATE.test(d) || d === date) return;
    // the page AND the sheet's own box - the rows scroll inside the box now (see fitPlan)
    const inner = LIVE.table && LIVE.table.closest(".planscroll");
    SCROLL.set(date, { y: window.scrollY, t: inner ? inner.scrollTop : 0 });
    writeHash("reports", f, { rep: page.id, date: d });
  };
  strip.querySelectorAll("[data-shift]").forEach((b) =>
    b.addEventListener("click", () => go(isoShift(date, Number(b.dataset.shift)))));
  strip.querySelectorAll("[data-date]").forEach((b) => b.addEventListener("click", () => go(b.dataset.date)));
  strip.querySelector('[name="plandate"]').addEventListener("change", (e) => go(e.target.value));
  return strip;
}

/* ---------------------------------------------------------------- the sheet, kept on the device
 * Switching days must be instant, and it must work in the workshop, where the signal comes and
 * goes. So every sheet fetched is kept - in memory for the session and in localStorage across
 * reloads - under its day and the rest of the filters, and a day opens from that copy at once
 * while the server is asked again in the background (renderLive). The copy is updated by every
 * tick and comment as it is made, so coming back to a day shows the work done on it whatever the
 * network did in between. The last KEEP_SHEETS fetched stay on the device; older ones go. */
const SHEET_PREFIX = STORAGE_PREFIX + "plan_sheet_";
const SHEET_INDEX = STORAGE_PREFIX + "plan_sheets";      // key -> saved-at, for the pruning
const KEEP_SHEETS = 14;
const SHEETS = new Map();                                // key -> { rows, at }, this session
const sheetKey = (date, query) => date + (query || "");
const readIndex = () => { try { return JSON.parse(localStorage.getItem(SHEET_INDEX) || "{}") || {}; } catch (e) { return {}; } };
function readSheet(key) {
  if (SHEETS.has(key)) return SHEETS.get(key);
  try {
    const s = JSON.parse(localStorage.getItem(SHEET_PREFIX + key) || "null");
    // a copy from before a reload: whatever the queue still holds for it goes on top
    if (s && Array.isArray(s.rows)) { overlayQueue(s.rows); SHEETS.set(key, s); return s; }
  } catch (e) {}
  return null;
}
function keepSheet(key, rows) {
  if (!key) return;
  const s = { rows, at: Date.now() };
  SHEETS.set(key, s);
  try {
    localStorage.setItem(SHEET_PREFIX + key, JSON.stringify(s));
    const idx = readIndex();
    idx[key] = s.at;
    Object.entries(idx).sort((a, b) => b[1] - a[1]).slice(KEEP_SHEETS).forEach(([k]) => {
      delete idx[k];
      localStorage.removeItem(SHEET_PREFIX + k);
    });
    localStorage.setItem(SHEET_INDEX, JSON.stringify(idx));
  } catch (e) {}                                          // quota: the session copy still works
}
function forgetSheet(key) {
  SHEETS.delete(key);
  try {
    localStorage.removeItem(SHEET_PREFIX + key);
    const idx = readIndex(); delete idx[key];
    localStorage.setItem(SHEET_INDEX, JSON.stringify(idx));
  } catch (e) {}
}

/* Ticks and comments still waiting in the offline queue, laid over rows fresh from the server.
 * Without this a tick made in a lift LOOKS lost the moment the day is opened again: the server
 * has not seen it yet, so its rows say the box is empty. The queue is in order, so a later write
 * to the same box wins. */
const PLAN_FNS = ["fn_ops_planning_set", "fn_ops_planning_comment", "fn_ops_planning_priority"];
function overlayQueue(rows) {
  const waiting = pendingWrites().filter((w) => PLAN_FNS.includes(w.fn));
  if (!waiting.length) return rows;
  const byId = new Map(rows.map((r) => [String(r.order_id), r]));
  waiting.forEach((w) => {
    const r = byId.get(String(w.args && w.args.p_order_id));
    if (!r) return;
    if (w.fn === "fn_ops_planning_set") r["plan_" + w.args.p_stage] = !!w.args.p_on;
    else if (w.fn === "fn_ops_planning_priority") r.plan_priority = w.args.p_priority || null;
    else r.plan_comment = w.args.p_comment;
  });
  return rows;
}

/* The ticks this device made while a request was OUT, laid over the rows that request brought
 * back. The queue overlay above cannot cover them: a tick made a second after the fetch left and
 * sent a second before its answer arrived is in neither the queue nor the answer, and the answer
 * would blank the box. Every tick and comment stamps its row (_touched, in wireLive); a stamp
 * later than the request's start wins over what the server said for those fields. */
const PLAN_FIELDS = ["plan_receive", "plan_cut", "plan_hemming", "plan_iron", "plan_marking", "plan_taping", "plan_fold",
                     "plan_comment", "plan_priority"];
function overlayTouched(rows, kept, since) {
  if (!kept) return rows;
  const byId = new Map(rows.map((r) => [String(r.order_id), r]));
  kept.forEach((c) => {
    if (!(c._touched >= since)) return;
    const r = byId.get(String(c.order_id));
    if (!r) return;
    PLAN_FIELDS.forEach((k) => { r[k] = c[k]; });
    r._touched = c._touched;
  });
  return rows;
}
// the stamp is the device's, not the sheet's: two copies that differ only by it are the same sheet
const sheetJson = (rows) => JSON.stringify(rows, (k, v) => (k === "_touched" ? undefined : v));

/* Ad hoc orders for a date, appended after the sheet's own rows: a rework, a job the 3D sheet does
 * not carry. Kept in planning_extra and shown for the day being viewed (renderLive sets from and
 * to to that day). */
function planDateRange(f) {
  const from = f.from || today();
  return { from, to: f.to || from };
}
async function extraRows(page, f, have) {
  const { from, to } = planDateRange(f);
  let extras = [];
  try {
    extras = await apiAll(`/rest/v1/planning_extra?select=order_id,plan_date&plan_date=gte.${from}&plan_date=lte.${to}&order=plan_date.asc,order_id.asc`);
  } catch (e) { return []; }
  const want = extras.filter((x) => !have.has(String(x.order_id)));
  if (!want.length) return [];
  const ids = want.map((x) => `"${String(x.order_id).replace(/"/g, "")}"`).join(",");
  let rows = [];
  try {
    rows = await apiAll(`/rest/v1/${page.view}?select=*&order_id=in.(${encodeURIComponent(ids)})`);
  } catch (e) { return []; }
  return rows.map((r) => ({ ...r, _adhoc: (want.find((x) => String(x.order_id) === String(r.order_id)) || {}).plan_date }));
}

/* The bar under the sheet: pick an order by number or by name and add it to the date. */
function addBar(page, f, orders, reload) {
  const { from } = planDateRange(f);
  const bar = el(`<div class="card row" style="flex-wrap:wrap;gap:8px;align-items:flex-end">
    <div><label class="f">${esc(tr("rep.addOrder"))}</label>
      <input list="planorders" name="adhoc" placeholder="${esc(tr("rep.addOrderHint"))}" style="min-width:260px" autocomplete="off">
      <datalist id="planorders">${orders.map((o) =>
        `<option value="${esc(o.order_id)}">${esc(o.customer_name || "")}${o.city ? " · " + esc(o.city) : ""}</option>`).join("")}</datalist></div>
    <div><label class="f">${esc(tr("col.install"))}</label>
      <input type="date" name="adhocdate" value="${esc(from)}"></div>
    <button class="btn sm accent" data-add>+ ${esc(tr("rep.addOrderBtn"))}</button>
    <span class="muted" style="flex-basis:100%">${esc(tr("rep.addOrderNote"))}</span></div>`);
  bar.querySelector("[data-add]").addEventListener("click", async () => {
    const raw = bar.querySelector('[name="adhoc"]').value.trim();
    const id = (raw.match(/\b\d{5}\b/) || [""])[0];
    const date = bar.querySelector('[name="adhocdate"]').value;
    if (!id || !date) { toast(tr("rep.addOrderBad"), "bad"); return; }
    if (!orders.some((o) => String(o.order_id) === id)) { toast(tr("rep.addOrderUnknown", { id }), "bad"); return; }
    try {
      await submit("fn_ops_planning_add", { p_order_id: id, p_date: date, p_actor: currentActor() });
      toast(tr("t.saved"), "ok");
      reload();
    } catch (err) { toast(err.message || String(err), "bad"); }
  });
  return bar;
}

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

/* Filter options come from the roster once per session, like the dashboard. */
let OPTIONS = null;
let ORDERS = [];      // every order, for the ad hoc picker: id, customer, city
async function options() {
  if (OPTIONS) return OPTIONS;
  try {
    const all = await apiAll("/rest/v1/v_ops_order_roster?select=order_id,customer_name,city,sheet_status,stitching_types,commercial_names,window_refs,fabric_1_codes,fabric_2_codes");
    OPTIONS = deriveOptions(all);
    ORDERS = all.map((r) => ({ order_id: r.order_id, customer_name: r.customer_name, city: r.city }))
      .sort((a, b) => String(b.order_id).localeCompare(String(a.order_id)));
  } catch (e) { OPTIONS = deriveOptions([]); }
  return OPTIONS;
}

export async function render(mount, state, setFilters) {
  if (!isSignedIn()) return;

  // Management dashboard leads: it is the page management opens; the detail pages follow
  const pageId = state.params.get("rep") || "mgmt";
  const page = REPORT_PAGES.find((p) => p.id === pageId) || REPORT_PAGES[0];
  // the live sheet works one day at a time and carries its own date strip - see caps.singleDate
  const caps = page.live ? { ...CAPS, singleDate: true } : CAPS;

  mount.innerHTML = `
    <div class="sectionbar">
      <div class="subtabs" id="reptabs"></div>
      <span id="repsync"></span>
    </div>
    <div id="repdate"></div>
    <div id="repbar"></div>
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

  const opts = await options();
  const bar_ = $("#repbar", mount);
  /* Apply rebuilds the hash from the filter fields alone, and `rep` is not one of them - so the
   * router's plain setFilters dropped it and every Apply on Planning landed on the default page,
   * the Management dashboard (user, 18 Sep 2026). The page id rides along as an extra, the same
   * way the Installation board keeps its outcome filter and the dashboard its four status filters.
   * The live sheet's day rides the same way, so Apply and Clear keep the day on screen. */
  const date = page.live ? planDate(state) : null;
  const setF = (f) => writeHash("reports", f, { rep: page.id, date });
  const paintBar = () => renderFilterBar(bar_, state, opts, setF, caps);
  paintBar();

  const box = $("#repbody", mount);
  if (page.custom) {
    await renderMgmt(box, state, paintBar);
    return;
  }
  if (page.live) {
    await renderLive(mount, box, page, state, setFilters, date, caps, paintBar);
    return;
  }

  loading(true, tr("t.loading"));
  let rows = [];
  try {
    rows = await apiAll(
      `/rest/v1/${page.view}?select=*&order=${page.order}${page.extra || ""}${toQuery(state.filters, caps)}`,
      500);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  state.count = rows.length;
  paintBar();
  if (!rows.length) {
    box.innerHTML = `<div class="card"><span class="muted">${esc(tr("t.empty"))}</span></div>`;
    return;
  }
  paintTable(box, page, rows, state.filters);
}

/* The live sheet for one day. It paints TWICE when it can: first from the copy this device kept
 * of the day (instant, and the only paint there is when the workshop has no signal), then from the
 * server, repainted only if the two differ. Every fresh fetch is laid over with whatever the
 * offline queue still holds, and kept as the device's new copy. The day, the filters and the
 * scroll position all survive the trip to another day and back; a comment being typed survives a
 * repaint under it.
 *
 * With a copy on screen the server is asked in the BACKGROUND - not awaited - because the router
 * holds every navigation until a render resolves, and a request on a bad signal takes 20 seconds
 * to give up: awaiting it would make the next day's chip wait that long. A refresh that comes
 * back after the day was switched (LIVE_SEQ moved on, or its box left the page) paints nothing. */
let LIVE_SEQ = 0;
async function renderLive(mount, box, page, state, setFilters, date, caps, paintBar) {
  const seq = ++LIVE_SEQ;
  rememberDate(date);
  /* A visit that named no day (the ribbon, the launcher) now shows one: write it into the hash
   * without navigating, so a link copied from here names the day and Back steps through days. */
  if (state.params.get("date") !== date) {
    const q = new URLSearchParams(location.hash.split("?")[1] || "");
    q.set("date", date);
    history.replaceState(null, "", "#/reports?" + q.toString());
  }

  /* The day IS the date filter: `f` is what the query and the ad hoc bar read, with the day as
   * from and to; `rest` is what goes back into the hash, without it - a range or a bucket that
   * rode in on an old link applies to nothing here and is not carried on. */
  const rest = { ...state.filters };
  delete rest.from; delete rest.to; delete rest.bucket;
  const f = { ...rest, from: date, to: date };
  const strip = $("#repdate", mount);
  strip.innerHTML = "";
  strip.appendChild(dateStrip(page, rest, date));
  const note = el(`<div class="plannote" hidden></div>`);
  strip.appendChild(note);

  const query = toQuery(f, caps);
  const key = sheetKey(date, query);
  const reload = () => { forgetSheet(key); render(mount, state, setFilters); };

  const paint = (rows) => {
    /* A comment half-typed when the server's copy lands must not be wiped by the repaint: carry
     * the text and the caret across, and put the focus back where it was. */
    const a = document.activeElement;
    const typing = a && box.contains(a) && a.dataset.cmt
      ? { id: a.dataset.cmt, v: a.value, s: a.selectionStart, e: a.selectionEnd } : null;
    // the rows scroll inside their own box, which a repaint replaces - carry its position across
    const was = box.querySelector(".planscroll");
    const keepTop = was ? was.scrollTop : null, keepLeft = was ? was.scrollLeft : null;
    LIVE.key = key; LIVE.rows = rows; LIVE.byId = new Map(rows.map((r) => [String(r.order_id), r])); LIVE.table = null;
    state.count = rows.length;
    paintBar();
    box.innerHTML = "";
    if (!rows.length) {
      box.innerHTML = `<div class="card"><span class="muted">${esc(tr("t.empty"))}</span></div>`;
    } else {
      LIVE.table = paintTable(box, page, rows, f, reload);
      wireLive(LIVE.table);
      paintPicks();
      fitPlan();
      const now = box.querySelector(".planscroll");
      if (now && keepTop !== null) { now.scrollTop = keepTop; now.scrollLeft = keepLeft; }
    }
    if (!isViewer()) box.appendChild(addBar(page, f, ORDERS, reload));
    if (typing) {
      const i = box.querySelector(`[data-cmt="${CSS.escape(typing.id)}"]`);
      if (i) { i.value = typing.v; i.focus(); try { i.setSelectionRange(typing.s, typing.e); } catch (e) {} }
    }
  };

  const cached = readSheet(key);
  const restoreScroll = () => {
    const s = SCROLL.get(date);
    if (!s) return;
    window.scrollTo(0, s.y);
    const inner = LIVE.table && LIVE.table.closest(".planscroll");
    if (inner) inner.scrollTop = s.t;
  };
  const stale = () => seq !== LIVE_SEQ || !box.isConnected;

  const refresh = async () => {
    const since = Date.now();            // see overlayTouched
    let rows;
    try {
      rows = await apiAll(`/rest/v1/${page.view}?select=*&order=${page.order}${page.extra || ""}${query}`, 500);
      // the ad hoc orders for the day come after the sheet's own rows
      const have = new Set(rows.map((r) => String(r.order_id)));
      rows = rows.concat(await extraRows(page, f, have));
    } catch (e) {
      if (!cached) {
        loading(false);
        box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
        return;
      }
      if (stale()) return;
      // the device's copy stays up, and says so: work on it still saves through the queue
      note.textContent = "⚠ " + tr("rep.savedCopy", { t: fmtDateTime(new Date(cached.at).toISOString()) });
      note.hidden = false;
      return;
    }
    if (!cached) loading(false);
    const current = readSheet(key);      // holds the ticks made while the request was out
    rows = overlayTouched(overlayQueue(rows), current && current.rows, since);
    const same = !!current && sheetJson(current.rows) === sheetJson(rows);
    keepSheet(key, same ? current.rows : rows);
    if (stale() || same) return;
    paint(rows);
    if (!cached) restoreScroll();
  };

  if (cached) {
    paint(cached.rows);
    restoreScroll();
    refresh();                           // in the background - see the note above
  } else {
    loading(true, tr("t.loading"));
    await refresh();
  }
}

/* The table itself: totals row, heat shading, sortable headers, the CSV and PDF row under it.
 * Returns the table element so the live sheet can wire its ticks to it. */
function paintTable(box, page, rows, filters, reload) {
  const totals = {}, maxes = {};
  page.cols.forEach((c) => {
    if (c.total) totals[c.k] = rows.reduce((a, r) => a + (Number(r[c.k]) || 0), 0);
    if (c.heat)  maxes[c.k] = rows.reduce((a, r) => Math.max(a, Number(r[c.k]) || 0), 0);
  });

  const cell = (c, r) => {
    const v = r[c.k];
    if (c.sel) {
      const id = String(r.order_id);
      return `<input type="checkbox" class="pickbox" data-pick="${esc(id)}"${picks().has(id) ? " checked" : ""}
                aria-label="${esc(tr("rep.pick"))} ${esc(id)}">`;
    }
    // Planning's priority mark rides in the order cell instead of taking a column of its own
    const mark = page.live && c.k === "order_id" ? prioCell(r) : "";
    // an ad hoc row says so on its order number, with a way to take it off the day again
    if (c.k === "order_id" && r._adhoc) {
      return `${mark}${esc(String(v))} ${chip(tr("rep.adhoc"), "info")}${isViewer() ? "" :
        ` <button type="button" class="btn sm ghost" data-unadhoc="${esc(r.order_id)}" data-date="${esc(r._adhoc)}" title="${esc(tr("rep.removeAdhoc"))}">×</button>`}`;
    }
    if (c.fmt) return c.fmt(v, r);
    if (v === null || v === undefined || v === "") return `<span class="muted">—</span>`;
    if (c.date) return esc(fmtDate(v));
    if (c.money) return esc(aed(v));
    if (c.n) return esc(num(v));
    return mark + esc(String(v));
  };
  /* The priority as a colour down the row's left edge - see .prio-* in app.css. */
  const rowClass = (r) => {
    const p = page.live ? priorityOf(r.plan_priority) : null;
    const cls = [p ? "prio-" + p.tone : "", page.live && picks().has(String(r.order_id)) ? "selected" : ""].filter(Boolean);
    return cls.length ? ` class="${cls.join(" ")}"` : "";
  };
  const tdAttrs = (c, r) => {
    const cls = [c.wide ? "wide" : "", c.n || c.money ? "num" : "", c.tick ? "tickcol" : "", c.wrap ? "wrap" : "", c.sel ? "selcol" : ""].filter(Boolean).join(" ");
    return `${cls ? ` class="${cls}"` : ""}${c.heat ? heatStyle(r[c.k], maxes[c.k], c.heat) : ""}`;
  };

  if (page.summaryBy) {
    const by = new Map();
    rows.forEach((r) => {
      const k = r[page.summaryBy.k] || "—";
      by.set(k, (by.get(k) || 0) + (Number(r[page.summaryBy.sum]) || 0));
    });
    const parts = Array.from(by.entries()).sort((a, b) => b[1] - a[1]);
    box.appendChild(el(`<div class="card statrow" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">${parts.map(([k, v]) =>
      `<div class="stat"><span class="sn">${esc(num(v))} ${esc(page.summaryBy.unit || "")}</span><span class="sl">${esc(String(k))}</span></div>`).join("")}</div>`));
  }

  /* The foot: one Total row, or - where the page asks for it - a subtotal per city and one for
   * the cities together, the label spanning every column up to the first one that adds up. */
  const footRows = () => {
    if (!page.subtotals) {
      return `<tr>${page.cols.map((c, i) => {
        if (i === 0) return `<th>${esc(tr("rep.total"))} (${rows.length})</th>`;
        if (!c.total) return "<th></th>";
        return `<th class="num">${c.money ? esc(aed(totals[c.k])) : esc(num(totals[c.k]))}</th>`;
      }).join("")}</tr>`;
    }
    const { by, groups, skipFlag } = page.subtotals;
    const counted = rows.filter((r) => !skipFlag || r.issue_flag !== skipFlag);
    const lead = Math.max(1, page.cols.findIndex((c) => c.total));
    const line = (label, rs, note, cls) => `<tr${cls ? ` class="${cls}"` : ""}><th colspan="${lead}" data-lead class="footlabel">${esc(label)} (${rs.length})${
      note ? ` <span class="footnote">· ${esc(note)}</span>` : ""}</th>${page.cols.slice(lead).map((c) => {
        if (!c.total) return "<th></th>";
        const t = rs.reduce((a, r) => a + (Number(r[c.k]) || 0), 0);
        return `<th class="num">${c.money ? esc(aed(t)) : esc(num(t))}</th>`;
      }).join("")}</tr>`;
    return groups.map((g) => line(g, counted.filter((r) => r[by] === g))).join("")
      + line(tr("rep.bothCities"), counted.filter((r) => groups.includes(r[by])), skipFlag ? tr("rep.exclIsr") : "", "grand");
  };
  const headCell = (c) => c.sel
    ? `<th class="selcol" style="width:${c.w}px"><input type="checkbox" class="pickbox" data-pickall
         title="${esc(tr("rep.pickAll"))}" aria-label="${esc(tr("rep.pickAll"))}"></th>`
    : null;

  const wrap = el(page.live
    ? `<div class="card planscroll" style="padding:0"></div>`
    : `<div class="card scrollx" style="padding:0"></div>`);
  const table = el(`
    <table class="dense report">
      <thead><tr>${page.cols.map((c) => headCell(c) ||
        `<th data-sort="${esc(c.k)}" tabindex="0" aria-sort="${sortState(page, c.k)}" class="${c.wide ? "wide" : ""}${c.n || c.money ? " num" : ""}${c.tick ? " tickcol" : ""}${c.wrap ? " wrap" : ""}"${c.w ? ` style="width:${c.w}px"` : ""}>${esc(tr(c.key))}<span class="sarrow" aria-hidden="true">${sortGlyph(page, c.k)}</span></th>`).join("")}</tr></thead>
      <tbody></tbody>
      <tfoot>${footRows()}</tfoot>
    </table>`);
  const tb = table.querySelector("tbody");
  const fill = () => {
    tb.innerHTML = sortRows(page, rows).map((r) => `<tr${rowClass(r)}>${page.cols.map((c) =>
      `<td${tdAttrs(c, r)}>${c.bold ? "<b>" : ""}${cell(c, r)}${c.bold ? "</b>" : ""}</td>`
    ).join("")}</tr>`).join("");
    table.querySelectorAll("th[data-sort]").forEach((th) => {
      th.setAttribute("aria-sort", sortState(page, th.dataset.sort));
      th.querySelector(".sarrow").textContent = sortGlyph(page, th.dataset.sort);
    });
  };
  fill();
  // ascending, descending, then back to the page's default order
  const onSort = (k) => {
    const st = SORT[page.id];
    SORT[page.id] = !st || st.col !== k ? { col: k, dir: "asc" } : st.dir === "asc" ? { col: k, dir: "desc" } : null;
    fill();
  };
  table.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => onSort(th.dataset.sort));
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSort(th.dataset.sort); }
    });
  });
  wrap.appendChild(table);
  if (page.live) box.appendChild(pickBar());
  box.appendChild(wrap);

  if (page.live) {
    // tick to add up: one row, or every row on the sheet from the header box
    table.addEventListener("change", (e) => {
      const one = e.target.closest("input[data-pick]");
      const all = e.target.closest("input[data-pickall]");
      if (!one && !all) return;
      const set = picks();
      if (one) { if (one.checked) set.add(one.dataset.pick); else set.delete(one.dataset.pick); }
      else if (all.checked) LIVE.rows.forEach((r) => set.add(String(r.order_id)));
      else set.clear();
      paintPicks();
    });
    table.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-unadhoc]");
      if (!b) return;
      try {
        await submit("fn_ops_planning_remove", { p_order_id: b.dataset.unadhoc, p_date: b.dataset.date });
        reload();
      } catch (err) { toast(err.message || String(err), "bad"); }
    });
  }

  box.appendChild(downloadRow(page.id, tr(page.key), rows.length,
    () => sortRows(page, rows).map((r) => {
      const o = {};
      page.cols.forEach((c) => {
        if (c.tick) o[tr(c.key)] = c.fmt(null, r).includes("✓") ? "yes" : "";
        else if (!c.k.startsWith("_")) o[tr(c.key)] = r[c.k];
      });
      // the priority has no column on the sheet, so it is named here rather than left out of the file
      if (page.live) o[tr("rep.priority")] = r.plan_priority ? tr(priorityOf(r.plan_priority).key) : "";
      return o;
    }),
    () => printableTable(wrap.querySelector("table")),
    filters, page.print));
  return table;
}

/* The sheet as it prints: a comment box becomes its text, a tick button a plain box, the ad hoc
 * remove button disappears. The screen keeps its controls; the paper gets the state. */
function printableTable(table) {
  const t = table.cloneNode(true);
  t.querySelectorAll("input.plancmt").forEach((i) => {
    const span = document.createElement("span"); span.textContent = i.value; i.replaceWith(span);
  });
  t.querySelectorAll("button.tick,button.prio").forEach((b) => {
    const span = document.createElement("span"); span.className = b.className; span.textContent = b.textContent; b.replaceWith(span);
  });
  t.querySelectorAll("[data-unadhoc]").forEach((b) => b.remove());
  if (t.querySelector(".selcol")) {
    t.querySelectorAll(".selcol").forEach((c) => c.remove());
    t.querySelectorAll("th[data-lead]").forEach((th) => { th.colSpan = Math.max(1, th.colSpan - 1); });
  }
  t.querySelectorAll("tr.selected").forEach((r) => r.classList.remove("selected"));
  return t.outerHTML;
}

/* ---------------------------------------------------------------- Management dashboard
 *
 * Table 1 is the 3D sheets row by row (v_mgmt_schedule_rows), NOT the order roster: an order can
 * sit on a sheet twice - an installation and a later issue resolution - and only the row knows
 * which it is. Rows flagged Order (Material ordered / Order placed / Endorsement done, inside
 * 09:00-19:00) from today onwards, rolled up by date, with a city split under each date. ISR and
 * Odd Time never appear here; they are not filtered out, they were never counted (fn_issue_flag).
 * The shared bar narrows it further - a city, a customer, a window ref, a commercial name.
 *
 * Table 2 is order value on two bases, from fn_mgmt_order_value, the same function the 07:00
 * WhatsApp message is built from, so the two can never disagree. Year to date, month to date and
 * the run rate are by the date the order was RECEIVED (v_mgmt_order_received: the PO-YYYYMMDD date
 * in the PO number, else the July backfill's Order Received Date column), every order except
 * cancelled - a sales figure, so the Order flag (a 3D-sheet scheduling idea) does not apply. Today
 * and the next five days are by installation date, Order-flagged and not cancelled, like Table 1
 * (v_mgmt_order_value). One order per row either way (an order has one PO value however many sheet
 * rows it has), and none of it is narrowed by the bar: a year-to-date figure filtered to one window
 * ref is not a figure. There is no "recent 3 days" any more (user, 19 Sep 2026).
 *
 * Table 3 is fabric metres for the next 7 days, per date and city: total (the Planning sheet's
 * Fabric (m)), received, ready (orders packed) and still to do - from fn_mgmt_fabric, the same
 * function the fifth 07:00 message is built from (user, 24 Sep 2026). ISR and cancelled rows are
 * not counted; like Table 2 it is not narrowed by the bar.
 *
 * Under them: the five 07:00 messages exactly as they would go out now.
 */
const MGMT_COLS = [
  { k: "orders", key: "rep.orders", heat: 1 },
  { k: "windows", key: "col.windows", heat: 1 },
  { k: "owl_blinds", key: "col.owlBlinds", heat: 1 },
  { k: "owl_curtains", key: "col.owlCurtains", heat: 1 },
  { k: "owl_total", key: "col.owlTotal", heat: 1 },
  { k: "credits", key: "rep.credits", money: 1, heat: "money" },
];

async function renderMgmt(box, state, paintBar) {
  const td = today();
  loading(true, tr("t.loading"));
  let rows = [], ov = null, fab = [], previews = null;
  try {
    [rows, ov, fab] = await Promise.all([
      apiAll(`/rest/v1/v_mgmt_schedule_rows?select=install_date,city,order_id,issue_flag,window_count,owl_blinds,owl_curtains,owl_total,credits,sheet_windows,order_known`
        + `&issue_flag=eq.Order&install_date=gte.${td}&order=install_date.asc,city.asc,install_time.asc`
        + toQuery(state.filters, CAPS), 500),
      rpc("fn_mgmt_order_value", {}),
      rpc("fn_mgmt_fabric", {}).catch(() => []),      // a missing table 3 must not blank tables 1 and 2
    ]);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);
  state.count = rows.length;
  paintBar();

  /* ---- Table 1: by date, city split beneath */
  const byDate = new Map();
  const add = (bucket, r) => {
    bucket.orders += 1;
    bucket.windows += Number(r.window_count) || 0;
    bucket.owl_blinds += Number(r.owl_blinds) || 0;
    bucket.owl_curtains += Number(r.owl_curtains) || 0;
    bucket.owl_total += Number(r.owl_total) || 0;
    bucket.credits += Number(r.credits) || 0;
    if (!r.order_known) bucket.unknown += 1;
  };
  const fresh = () => ({ orders: 0, windows: 0, owl_blinds: 0, owl_curtains: 0, owl_total: 0, credits: 0, unknown: 0 });
  rows.forEach((r) => {
    if (!byDate.has(r.install_date)) byDate.set(r.install_date, { all: fresh(), cities: new Map() });
    const d = byDate.get(r.install_date);
    add(d.all, r);
    const c = r.city || tr("f.unknownCity");
    if (!d.cities.has(c)) d.cities.set(c, fresh());
    add(d.cities.get(c), r);
  });
  const grand = fresh();
  rows.forEach((r) => add(grand, r));
  const maxes = {};
  MGMT_COLS.forEach((c) => { maxes[c.k] = 0; byDate.forEach((d) => { maxes[c.k] = Math.max(maxes[c.k], d.all[c.k]); }); });

  const valCell = (c, b) => `<td class="num"${heatStyle(b[c.k], maxes[c.k], c.heat)}>${c.money ? esc(aed0(b[c.k])) : esc(num(b[c.k]))}</td>`;
  const dateRows = Array.from(byDate.entries()).map(([d, v]) => {
    const cities = Array.from(v.cities.entries()).sort(([a], [b]) => a.localeCompare(b));
    const split = cities.length > 1 ? cities.map(([c, b]) =>
      `<tr class="sub"><td class="muted">↳ ${esc(c)}</td>${MGMT_COLS.map((col) =>
        `<td class="num muted">${col.money ? esc(aed0(b[col.k])) : esc(num(b[col.k]))}</td>`).join("")}</tr>`).join("") : "";
    const one = cities.length === 1 ? ` <span class="muted">· ${esc(cities[0][0])}</span>` : "";
    const warn = v.all.unknown ? ` ${chip(tr("rep.notInDb", { n: v.all.unknown }), "warn", "!")}` : "";
    return `<tr><td><b>${esc(fmtDate(d))}</b>${one}${warn}</td>${MGMT_COLS.map((c) => valCell(c, v.all)).join("")}</tr>${split}`;
  }).join("");

  const t1 = el(`
    <div class="card" style="padding:0">
      <div class="cardhead">
        <h3>${esc(tr("rep.mgmtTable1"))}</h3>
        <span class="muted">${esc(tr("rep.mgmtNote1"))}</span>
      </div>
      <div class="scrollx">
      <table class="dense report">
        <thead><tr><th>${esc(tr("col.install"))}</th>${MGMT_COLS.map((c) => `<th class="num">${esc(tr(c.key))}</th>`).join("")}</tr></thead>
        <tbody>${dateRows || `<tr><td colspan="${MGMT_COLS.length + 1}" class="muted">${esc(tr("t.empty"))}</td></tr>`}</tbody>
        <tfoot><tr><th>${esc(tr("rep.total"))} (${byDate.size} ${esc(tr("rep.days"))})</th>${MGMT_COLS.map((c) =>
          `<th class="num">${c.money ? esc(aed0(grand[c.k])) : esc(num(grand[c.k]))}</th>`).join("")}</tr></tfoot>
      </table></div>
      <div class="row" style="justify-content:flex-end;padding:8px">
        <button class="btn sm" data-csv1>${esc(tr("dash.csv"))}</button></div>
    </div>`);
  t1.querySelector("[data-csv1]").addEventListener("click", () =>
    downloadCsv(`management_${td}.csv`, Array.from(byDate.entries()).flatMap(([d, v]) => [
      { date: d, city: "ALL", ...v.all },
      ...Array.from(v.cities.entries()).map(([c, b]) => ({ date: d, city: c, ...b })),
    ])));
  // both tables on one sheet: the second is appended once it exists, further down
  const pdfBtn = el(`<button class="btn sm" data-pdf>${esc(tr("dash.pdf"))}</button>`);
  t1.querySelector("[data-csv1]").after(pdfBtn);
  box.appendChild(t1);

  /* ---- Table 2: order value */
  if (ov) {
    const dayRow = (r, label) => `<tr${label ? ' class="today"' : ""}><td>${label ? `<b>${esc(label)}</b> ` : ""}${esc(fmtDate(r.date))}</td>
      <td class="num">${esc(num(r.orders))}</td><td class="num">${esc(aed0(r.value))}</td></tr>`;
    const t2 = el(`
      <div class="card" style="padding:0">
        <div class="cardhead">
          <h3>${esc(tr("rep.mgmtOrderValue"))}</h3>
          <span class="muted">${esc(tr("rep.mgmtNote2"))}</span>
        </div>
        <div class="statrow" style="padding:10px 12px">
          <div class="stat"><span class="sn">${esc(aed0(ov.ytd.value))}</span><span class="sl">${esc(tr("rep.ytd"))} · ${esc(num(ov.ytd.orders))} ${esc(tr("rep.orders"))}</span></div>
          <div class="stat"><span class="sn">${esc(aed0(ov.mtd.value))}</span><span class="sl">${esc(tr("rep.mtd"))} · ${esc(num(ov.mtd.orders))} ${esc(tr("rep.orders"))}</span></div>
          <div class="stat"><span class="sn">${esc(aed0(ov.mtd.per_day))}</span><span class="sl">${esc(tr("rep.perDay", { n: ov.mtd.days_elapsed }))}</span></div>
        </div>
        <div class="scrollx">
        <table class="dense report">
          <thead><tr><th>${esc(tr("col.install"))}</th><th class="num">${esc(tr("rep.orders"))}</th><th class="num">${esc(tr("rep.credits"))}</th></tr></thead>
          <tbody>
            ${dayRow(ov.today_row || { date: ov.today, orders: 0, value: 0 }, tr("bucket.today"))}
            <tr class="grp"><td colspan="3">${esc(tr("rep.next5"))}</td></tr>
            ${(ov.future || []).map((r) => dayRow(r)).join("")}
          </tbody>
        </table></div>
      </div>`);
    box.appendChild(t2);
  }
  /* ---- Table 3: fabric metres, by date, city split beneath - see the note at the top */
  const FAB_COLS = [
    { k: "total_m", key: "rep.fabTotal" }, { k: "received_m", key: "rep.fabRecv" },
    { k: "ready_m", key: "rep.fabReady" }, { k: "todo_m", key: "rep.fabTodo" },
  ];
  const fabBy = new Map();
  const fabZero = () => ({ orders: 0, total_m: 0, received_m: 0, ready_m: 0, todo_m: 0 });
  const fabAdd = (b, r) => { b.orders += Number(r.orders) || 0; FAB_COLS.forEach((c) => { b[c.k] += Number(r[c.k]) || 0; }); };
  const fabAll = fabZero();
  (fab || []).forEach((r) => {
    if (!fabBy.has(r.install_date)) fabBy.set(r.install_date, { all: fabZero(), cities: [] });
    const d = fabBy.get(r.install_date);
    fabAdd(d.all, r); d.cities.push(r); fabAdd(fabAll, r);
  });
  const mCell = (v, muted) => `<td class="num${muted ? " muted" : ""}">${esc(num(Math.round(Number(v) || 0)))}</td>`;
  const fabRows = Array.from(fabBy.entries()).map(([d, v]) => {
    const one = v.cities.length === 1 ? ` <span class="muted">· ${esc(v.cities[0].city)}</span>` : "";
    const split = v.cities.length > 1 ? v.cities.map((c) =>
      `<tr class="sub"><td class="muted">↳ ${esc(c.city)}</td><td class="num muted">${esc(num(c.orders))}</td>${
        FAB_COLS.map((col) => mCell(c[col.k], true)).join("")}</tr>`).join("") : "";
    return `<tr><td><b>${esc(fmtDate(d))}</b>${one}</td><td class="num">${esc(num(v.all.orders))}</td>${
      FAB_COLS.map((col) => mCell(v.all[col.k])).join("")}</tr>${split}`;
  }).join("");
  const t3 = el(`
    <div class="card" style="padding:0">
      <div class="cardhead">
        <h3>${esc(tr("rep.mgmtFabric"))}</h3>
        <span class="muted">${esc(tr("rep.mgmtNote3"))}</span>
      </div>
      <div class="scrollx">
      <table class="dense report">
        <thead><tr><th>${esc(tr("col.install"))}</th><th class="num">${esc(tr("rep.orders"))}</th>${
          FAB_COLS.map((c) => `<th class="num">${esc(tr(c.key))}</th>`).join("")}</tr></thead>
        <tbody>${fabRows || `<tr><td colspan="${FAB_COLS.length + 2}" class="muted">${esc(tr("t.empty"))}</td></tr>`}</tbody>
        <tfoot><tr><th>${esc(tr("rep.total"))} (${fabBy.size} ${esc(tr("rep.days"))})</th><th class="num">${esc(num(fabAll.orders))}</th>${
          FAB_COLS.map((c) => `<th class="num">${esc(num(Math.round(fabAll[c.k])))}</th>`).join("")}</tr></tfoot>
      </table></div>
    </div>`);
  box.appendChild(t3);

  pdfBtn.addEventListener("click", () => {
    const sub = `${filterSummary(state.filters)} · ${fmtDateTime(new Date().toISOString())}`;
    const html = Array.from(box.querySelectorAll(".card")).slice(0, 3).map((c) =>
      `<h2 style="font-size:14px;margin:12px 0 2px">${esc(c.querySelector("h3")?.textContent ?? "")}</h2>` +
      `<p class="muted" style="font-size:10px;margin:0 0 6px">${esc(c.querySelector(".cardhead .muted")?.textContent ?? "")}</p>` +
      (c.querySelector(".statrow")?.outerHTML ?? "").replace(/class="statrow"/, 'class="statrow" style="display:flex;gap:18px;margin:4px 0 8px"') +
      (c.querySelector("table")?.outerHTML ?? "")).join("");
    if (!printSheet(tr("rep.mgmt"), sub, html)) toast(tr("rep.pdfBlocked"), "bad");
  });

  /* ---- the four 07:00 messages, as they would read right now */
  const pv = el(`<div class="card"><details><summary><b>${esc(tr("rep.waPreview"))}</b>
      <span class="muted"> — ${esc(tr("rep.waPreviewHint"))}</span></summary><div class="wapreview" data-pv></div></details></div>`);
  pv.querySelector("details").addEventListener("toggle", async (e) => {
    if (!e.target.open || previews) return;
    const host = pv.querySelector("[data-pv]");
    host.innerHTML = `<span class="muted">${esc(tr("t.loading"))}</span>`;
    try {
      previews = await Promise.all([
        rpc("fn_mgmt_body_owl", {}), rpc("fn_mgmt_body_order_value", {}),
        rpc("fn_mgmt_body_install_status", {}), rpc("fn_mgmt_body_production_status", {}),
        rpc("fn_mgmt_body_fabric", {}),
      ]);
      host.innerHTML = previews.map((t) => `<pre class="wa">${esc(String(t || ""))}</pre>`).join("");
    } catch (err) {
      host.innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
  });
  box.appendChild(pv);
}
