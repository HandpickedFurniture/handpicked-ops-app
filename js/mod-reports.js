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
import { apiAll, rpc, isSignedIn } from "./api.js";
import { tr, tv } from "./i18n.js";
import { PREP_STAGES, ISSUE_FLAGS, flagOf } from "./config.js";
import {
  $, esc, el, num, aed, aed0, fmtDate, fmtDateTime, today, loading, chip, downloadCsv, printSheet, toast,
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
     * launcher, Home and the ribbon as its own target. It is the workshop's PRINTED sheet: portrait
     * A4, one page, the seven Looker stage columns - Receive, Cut, Hemming, Iron, Marking, Taping,
     * Fold - as tick boxes to mark by hand, with the ones the database already knows pre-ticked
     * (Receive = every fabric received, Cut = preparation started, Fold = packed). The four stages
     * between Cut and Fold were retired from the Preparation screen in Aug 2026, so on screen they
     * are always empty boxes; on paper they are what the sheet is for. Windows, Started, Packed
     * and Furthest stage left on the same day (user). Opens sorted by type (Order first), city,
     * order id; any header re-sorts it. */
    id: "production", key: "rep.production", view: "v_ops_report_orders",
    order: "installation_date.asc.nullslast",
    defaultSort: ["issue_flag", "city", "order_id"],
    print: { portrait: true, onePage: true },
    cols: [
      { k: "installation_date", key: "col.install", date: 1 },
      { k: "installation_time", key: "rep.instTime" },
      { k: "city", key: "col.city" },
      { k: "issue_flag", key: "rep.issueFlag", fmt: flagChip },
      { k: "order_id", key: "col.order", bold: true },
      { k: "customer_name", key: "col.customer" },
      { k: "_recv", key: "rep.receive", fmt: (_v, r) => bar(r.recv_fab_done, r.recv_fab_total) },
      { k: "_mat", key: "rep.materials", fmt: (_v, r) => bar(r.recv_mat_done, r.recv_mat_total) },
      { k: "_st_receive", key: "rep.stReceive", tick: 1, fmt: (_v, r) => tick(r.recv_fab_total > 0 && r.recv_fab_done >= r.recv_fab_total) },
      { k: "_st_cut",     key: "rep.stCut",     tick: 1, fmt: (_v, r) => tick(Number(r.prep_started) > 0) },
      { k: "_st_hem",     key: "rep.stHem",     tick: 1, fmt: () => tick(false) },
      { k: "_st_iron",    key: "rep.stIron",    tick: 1, fmt: () => tick(false) },
      { k: "_st_mark",    key: "rep.stMark",    tick: 1, fmt: () => tick(false) },
      { k: "_st_tape",    key: "rep.stTape",    tick: 1, fmt: () => tick(false) },
      { k: "_st_fold",    key: "rep.stFold",    tick: 1, fmt: (_v, r) => tick(Number(r.prep_done) > 0) },
      { k: "owl_curtains", key: "rep.curtains", n: 1, total: 1, heat: 1 },
      { k: "report_meters", key: "col.meters", n: 1, total: 1, heat: 1 },
      { k: "received_meters", key: "rep.recMeter", n: 1, total: 1, heat: 1 },
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
  _st_receive: (r) => (r.recv_fab_total > 0 && r.recv_fab_done >= r.recv_fab_total ? 1 : 0),
  _st_cut:     (r) => (Number(r.prep_started) > 0 ? 1 : 0),
  _st_fold:    (r) => (Number(r.prep_done) > 0 ? 1 : 0),
  _st_hem: () => 0, _st_iron: () => 0, _st_mark: () => 0, _st_tape: () => 0,
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

/* A tick box: ticked when the database already knows the stage happened, empty to be marked by hand
 * on the printed sheet. Never colour alone - the glyph is the state. */
const tick = (on) => `<span class="tick${on ? " on" : ""}" aria-label="${on ? "done" : ""}">${on ? "✓" : ""}</span>`;

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
async function options() {
  if (OPTIONS) return OPTIONS;
  try {
    const all = await apiAll("/rest/v1/v_ops_order_roster?select=city,sheet_status,stitching_types,commercial_names,window_refs,fabric_1_codes,fabric_2_codes");
    OPTIONS = deriveOptions(all);
  } catch (e) { OPTIONS = deriveOptions([]); }
  return OPTIONS;
}

export async function render(mount, state, setFilters) {
  if (!isSignedIn()) return;

  // Management dashboard leads: it is the page management opens; the detail pages follow
  const pageId = state.params.get("rep") || "mgmt";
  const page = REPORT_PAGES.find((p) => p.id === pageId) || REPORT_PAGES[0];

  mount.innerHTML = `
    <div class="sectionbar">
      <div class="subtabs" id="reptabs"></div>
      <span id="repsync"></span>
    </div>
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
   * way the Installation board keeps its outcome filter and the dashboard its four status filters. */
  const setF = (f) => writeHash("reports", f, { rep: page.id });
  const paintBar = () => renderFilterBar(bar_, state, opts, setF, CAPS);
  paintBar();

  const box = $("#repbody", mount);
  if (page.custom) {
    await renderMgmt(box, state, paintBar);
    return;
  }

  loading(true, tr("t.loading"));
  let rows = [];
  try {
    rows = await apiAll(
      `/rest/v1/${page.view}?select=*&order=${page.order}${page.extra || ""}${toQuery(state.filters, CAPS)}`,
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

  const totals = {}, maxes = {};
  page.cols.forEach((c) => {
    if (c.total) totals[c.k] = rows.reduce((a, r) => a + (Number(r[c.k]) || 0), 0);
    if (c.heat)  maxes[c.k] = rows.reduce((a, r) => Math.max(a, Number(r[c.k]) || 0), 0);
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
  const tdAttrs = (c, r) => {
    const cls = [c.wide ? "wide" : "", c.n || c.money ? "num" : "", c.tick ? "tickcol" : ""].filter(Boolean).join(" ");
    return `${cls ? ` class="${cls}"` : ""}${c.heat ? heatStyle(r[c.k], maxes[c.k], c.heat) : ""}`;
  };

  const wrap = el(`<div class="card scrollx" style="padding:0"></div>`);
  const table = el(`
    <table class="dense report">
      <thead><tr>${page.cols.map((c) =>
        `<th data-sort="${esc(c.k)}" tabindex="0" aria-sort="${sortState(page, c.k)}" class="${c.wide ? "wide" : ""}${c.n || c.money ? " num" : ""}${c.tick ? " tickcol" : ""}">${esc(tr(c.key))}<span class="sarrow" aria-hidden="true">${sortGlyph(page, c.k)}</span></th>`).join("")}</tr></thead>
      <tbody></tbody>
      <tfoot><tr>${page.cols.map((c, i) => {
        if (i === 0) return `<th>${esc(tr("rep.total"))} (${rows.length})</th>`;
        if (!c.total) return "<th></th>";
        return `<th class="num">${c.money ? esc(aed(totals[c.k])) : esc(num(totals[c.k]))}</th>`;
      }).join("")}</tr></tfoot>
    </table>`);
  const tb = table.querySelector("tbody");
  const fill = () => {
    tb.innerHTML = sortRows(page, rows).map((r) => `<tr>${page.cols.map((c) =>
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
  box.appendChild(wrap);

  box.appendChild(downloadRow(page.id, tr(page.key), rows.length,
    () => sortRows(page, rows).map((r) => {
      const o = {};
      page.cols.forEach((c) => {
        if (c.tick) o[tr(c.key)] = c.fmt(null, r).includes("✓") ? "yes" : "";
        else if (!c.k.startsWith("_")) o[tr(c.key)] = r[c.k];
      });
      return o;
    }),
    () => wrap.querySelector("table").outerHTML,
    state.filters, page.print));
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
 * Table 2 is order value by installation date - year to date, month to date, the run rate, the
 * last three days, today, the next five - from fn_mgmt_order_value, the same function the 07:00
 * WhatsApp message is built from, so the two can never disagree. It is one order per row (an order
 * has one PO value however many sheet rows it has), Order-flagged and not cancelled, and it is not
 * narrowed by the bar: a year-to-date figure filtered to one window ref is not a figure.
 *
 * Under both: the four 07:00 messages exactly as they would go out now.
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
  let rows = [], ov = null, previews = null;
  try {
    [rows, ov] = await Promise.all([
      apiAll(`/rest/v1/v_mgmt_schedule_rows?select=install_date,city,order_id,issue_flag,window_count,owl_blinds,owl_curtains,owl_total,credits,sheet_windows,order_known`
        + `&issue_flag=eq.Order&install_date=gte.${td}&order=install_date.asc,city.asc,install_time.asc`
        + toQuery(state.filters, CAPS), 500),
      rpc("fn_mgmt_order_value", {}),
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
            <tr class="grp"><td colspan="3">${esc(tr("rep.recent3"))}</td></tr>
            ${(ov.recent || []).map((r) => dayRow(r)).join("")}
            ${dayRow(ov.today_row || { date: ov.today, orders: 0, value: 0 }, tr("bucket.today"))}
            <tr class="grp"><td colspan="3">${esc(tr("rep.next5"))}</td></tr>
            ${(ov.future || []).map((r) => dayRow(r)).join("")}
          </tbody>
        </table></div>
      </div>`);
    box.appendChild(t2);
  }
  pdfBtn.addEventListener("click", () => {
    const sub = `${filterSummary(state.filters)} · ${fmtDateTime(new Date().toISOString())}`;
    const html = Array.from(box.querySelectorAll(".card")).slice(0, 2).map((c) =>
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
      ]);
      host.innerHTML = previews.map((t) => `<pre class="wa">${esc(String(t || ""))}</pre>`).join("");
    } catch (err) {
      host.innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
  });
  box.appendChild(pv);
}
