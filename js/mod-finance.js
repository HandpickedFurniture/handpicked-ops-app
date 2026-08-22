/* Finance - where invoices get made from.
 *
 * Two grids behind one route: ORDERS is the PO lines, ADJUSTMENTS is the chargeable extras. Both
 * are read by the accounts team, corrected in place, selected in bulk and exported.
 *
 * WHAT THIS SCREEN IS FOR, and what it deliberately is not: it does not create invoices. It makes
 * the numbers checkable and marks what has been billed. `fn_ops_build_invoice` still exists and
 * still writes invoice_lines; nothing here calls it. The finance team's own system raises the
 * document, and this is where they get the figures and record that they did.
 *
 * THREE COLUMNS THAT LOOK THE SAME AND ARE NOT:
 *   price_per_unit - what the catalog charges for one of these
 *   unit_value     - what the system computed for this line (price x width or x quantity)
 *   credits_aed    - what will ACTUALLY be invoiced: the override if somebody typed one, else
 *                    unit_value, and always zero for an item on the never-credit list
 * Editing Credits is how a coordinator's agreement with a client reaches the invoice. Editing the
 * others changes what the line SAYS, not what it charges - which is why Unit value is read-only.
 *
 * EDITS DO NOT LIVE IN order_lines_final. fn_rebuild_order recomputes that table wholesale on every
 * PO revision, so anything typed here goes to finance_line_edit keyed by order + VERSION + line.
 * Including the version is the point: a revised PO is exactly the case where last week's agreed
 * figure should stop applying rather than silently carry over.
 *
 * The review rules are computed in v_ops_finance_lines, not here - see that view. This screen only
 * paints them and lets somebody filter to them.
 */
import { api, apiAll, rpc, submit, currentActor, queueDepth, isSignedIn, isViewer } from "./api.js";
import { ORDER_STATUSES, PAGE_SIZE } from "./config.js";
import { tr } from "./i18n.js";
import {
  $, esc, el, chip, aed, num, fmtDate, toast, loading, modal, downloadCsv, copyText, today,
} from "./ui.js";
import { syncBar } from "./sync.js";

/* Which grid is showing, and how each is sorted. Module-level so switching to another tab and back
 * does not throw away a sort somebody set up to work through. */
let TAB = "orders";
let SORT = { orders: { col: "order_id", dir: 1 }, adj: { col: "order_id", dir: 1 } };
let SEL = { orders: new Set(), adj: new Set() };
let FILTERS = { status: "", from: "", to: "", invoice: "", review: "" };
let ROWS = { orders: [], adj: [] };
let EXPANDED = new Set();

/* The six review rules, as they are named in v_ops_finance_lines. Kept in one list so the chips,
 * the filter and the row highlight can never disagree about what "needs review" means. */
const REVIEW_FLAGS = [
  { col: "rv_no_price",           key: "fin.rvNoPrice" },
  { col: "rv_removal_uncharged",  key: "fin.rvRemoval" },
  { col: "rv_scaffolding_missing",key: "fin.rvScaffold" },
  { col: "rv_pullcord",           key: "fin.rvPullcord" },
  { col: "rv_duplicate",          key: "fin.rvDuplicate" },
  { col: "rv_roman_no_supplier",  key: "fin.rvRoman" },
];

const ADJ_REVIEW_FLAGS = [
  { col: "rv_incomplete", key: "fin.rvIncomplete" },
  { col: "rv_rate_drift", key: "fin.rvDrift" },
];

/* What the finance team DOES with an adjustment once its figure is settled, in the order it happens.
 * One list so the three columns, the three writes and the three tooltips cannot drift apart, and so
 * a fourth step later is one entry here rather than a fourth copy of the same wiring.
 *
 * They are deliberately INDEPENDENT rather than one three-step status: an adjustment can be invoiced
 * without ever going on the 3D sheet, and paid work still has to be reconciled onto the sheet
 * afterwards. A single status column would force an order on them that the work does not have. */
const ADJ_FLAGS = [
  { col: "sheet_updated",   key: "fin.sheetUpdated" },
  { col: "invoice_created", key: "fin.invoiceCreated" },
  { col: "paid",            key: "fin.paid" },
];

/* A row needs review when any rule fires, unless a human has explicitly said otherwise.
 * review_override is three-state on purpose: null means "nobody has looked", which is not the same
 * as "somebody looked and said it is fine". */
function needsReview(r, flags = REVIEW_FLAGS) {
  if (r.review_override === true) return true;
  if (r.review_override === false) return false;
  return flags.some((f) => r[f.col]);
}

const rowKey = (r) => `${r.order_id}|${r.version_no}|${r.line_no}`;

/* ------------------------------------------------------------------ loading */
async function loadOrders() {
  /* po_row is EXCLUDED here and fetched one line at a time when somebody expands it. It is the
   * whole 93-column PO row as jsonb; pulling it for 4,500 lines is megabytes of payload to render
   * a grid that shows eight columns. */
  const cols = [
    "order_id", "version_no", "line_no", "sku_billing", "po_sku", "description", "quantity",
    "adjusted_width_cm", "price_per_unit", "unit_value", "credits_aed", "pricing_type",
    "no_credit", "edited", "finance_note", "customer_name", "city", "installation_date",
    "order_received_date", "order_status", "visits_done", "invoice_status", "adjustment_status",
    "review_override", "pullcord_expected_aed", "removal_count",
    ...REVIEW_FLAGS.map((f) => f.col),
  ].join(",");

  let q = `/rest/v1/v_ops_finance_lines?select=${cols}&order=order_id.asc,line_no.asc`;
  if (FILTERS.status === "(none)") q += "&order_status=is.null";
  else if (FILTERS.status) q += `&order_status=eq.${encodeURIComponent(FILTERS.status)}`;
  if (FILTERS.invoice) q += `&invoice_status=eq.${encodeURIComponent(FILTERS.invoice)}`;
  if (FILTERS.from) q += `&order_received_date=gte.${FILTERS.from}`;
  if (FILTERS.to) q += `&order_received_date=lte.${FILTERS.to}`;
  return apiAll(q, PAGE_SIZE);
}

async function loadAdjustments() {
  let q = "/rest/v1/v_ops_finance_adjustments?select=*&order=order_id.asc,id.asc";
  if (FILTERS.status === "(none)") q += "&order_status=is.null";
  else if (FILTERS.status) q += `&order_status=eq.${encodeURIComponent(FILTERS.status)}`;
  if (FILTERS.invoice) q += `&invoice_status=eq.${encodeURIComponent(FILTERS.invoice)}`;
  if (FILTERS.from) q += `&order_received_date=gte.${FILTERS.from}`;
  if (FILTERS.to) q += `&order_received_date=lte.${FILTERS.to}`;
  return apiAll(q, PAGE_SIZE);
}

/* The review filter runs HERE rather than in the query: it is an OR across six computed booleans
 * plus a three-state override, which PostgREST can express only as an unreadable or= chain that
 * would then have to be kept in step with REVIEW_FLAGS by hand. */
function applyReviewFilter(rows, flags) {
  if (!FILTERS.review) return rows;
  const want = FILTERS.review === "yes";
  return rows.filter((r) => needsReview(r, flags) === want);
}

function sortRows(rows, which) {
  const { col, dir } = SORT[which];
  return rows.slice().sort((a, b) => {
    const x = a[col], y = b[col];
    if (x == null && y == null) return 0;
    if (x == null) return 1;            // blanks last, whichever way the sort runs
    if (y == null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
    if (typeof x === "boolean") return ((x ? 1 : 0) - (y ? 1 : 0)) * dir;
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
  });
}

/* ------------------------------------------------------------------ screen */
export async function render(mount, state) {
  if (!isSignedIn()) return;

  mount.innerHTML = `
    <div class="sectionbar"><span></span><span id="finsync"></span></div>
    <div class="subtabs" id="fintabs">
      <button data-tab="orders" class="${TAB === "orders" ? "on" : ""}">${esc(tr("fin.orders"))}</button>
      <button data-tab="adj" class="${TAB === "adj" ? "on" : ""}">${esc(tr("fin.adjustments"))}</button>
    </div>
    <div id="finbar"></div>
    <div id="finactions"></div>
    <div id="fingrid"></div>`;
  $("#finsync", mount).appendChild(syncBar());

  mount.querySelectorAll("#fintabs button").forEach((b) =>
    b.addEventListener("click", () => {
      TAB = b.dataset.tab;
      EXPANDED.clear();
      render(mount, state);
    }));

  paintFilters(mount, state);
  await reload(mount, state);
}

function paintFilters(mount, state) {
  const bar = $("#finbar", mount);
  const opt = (v, label, cur) =>
    `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(label)}</option>`;

  bar.innerHTML = `
    <div class="card finfilters">
      <div class="fgrid">
        <div><label class="f">${esc(tr("fin.fInstall"))}</label>
          <select name="fstatus">
            ${opt("", tr("f.any"), FILTERS.status)}
            ${opt("(none)", tr("fin.noStatus"), FILTERS.status)}
            ${ORDER_STATUSES.map((s) => opt(s, s, FILTERS.status)).join("")}
          </select></div>
        <div><label class="f">${esc(tr("fin.fReceivedFrom"))}</label>
          <input type="date" name="ffrom" value="${esc(FILTERS.from)}"></div>
        <div><label class="f">${esc(tr("fin.fReceivedTo"))}</label>
          <input type="date" name="fto" value="${esc(FILTERS.to)}"></div>
        <div><label class="f">${esc(tr("fin.fInvoice"))}</label>
          <select name="finvoice">
            ${opt("", tr("f.any"), FILTERS.invoice)}
            ${["Pending", "Invoiced", "Revised"].map((s) => opt(s, s, FILTERS.invoice)).join("")}
          </select></div>
        <div><label class="f">${esc(tr("fin.fReview"))}</label>
          <select name="freview">
            ${opt("", tr("f.any"), FILTERS.review)}
            ${opt("yes", tr("t.yes"), FILTERS.review)}
            ${opt("no", tr("t.no"), FILTERS.review)}
          </select></div>
        <div style="display:flex;align-items:flex-end">
          <button class="btn sm ghost" data-clear>${esc(tr("f.clear"))}</button></div>
      </div>
    </div>`;

  const wire = (name, key) => bar.querySelector(`[name="${name}"]`)
    .addEventListener("change", (e) => { FILTERS[key] = e.target.value; reload(mount, state); });
  wire("fstatus", "status"); wire("ffrom", "from"); wire("fto", "to");
  wire("finvoice", "invoice"); wire("freview", "review");
  bar.querySelector("[data-clear]").addEventListener("click", () => {
    FILTERS = { status: "", from: "", to: "", invoice: "", review: "" };
    paintFilters(mount, state); reload(mount, state);
  });
}

async function reload(mount, state) {
  const grid = $("#fingrid", mount);
  loading(true, tr("t.loading"));
  try {
    if (TAB === "orders") ROWS.orders = await loadOrders();
    else ROWS.adj = await loadAdjustments();
  } catch (e) {
    loading(false);
    grid.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);
  if (TAB === "orders") paintOrders(mount, state); else paintAdjustments(mount, state);
}

/* ------------------------------------------------------------------ shared bits */
function actionBar(mount, state, which, extra = "") {
  const box = $("#finactions", mount);
  const n = SEL[which].size;
  box.innerHTML = `
    <div class="card finactions">
      <span class="muted">${esc(tr("act.selected", { n }))}</span>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button class="btn sm" data-selall>${esc(tr("fin.selectVisible"))}</button>
        <button class="btn sm ghost" data-selnone>${esc(tr("fin.selectNone"))}</button>
        <button class="btn sm" data-csv${n ? "" : " disabled"}>${esc(tr("dash.csv"))}</button>
        ${extra}
      </div>
    </div>`;
  return box;
}

function sortableTh(label, col, which) {
  const s = SORT[which];
  const arrow = s.col === col ? (s.dir === 1 ? " ▲" : " ▼") : "";
  return `<th data-sort="${esc(col)}" class="sortable">${esc(label)}${arrow}</th>`;
}

function wireSort(table, which, repaint) {
  table.querySelectorAll("th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      const s = SORT[which];
      if (s.col === col) s.dir = -s.dir; else { s.col = col; s.dir = 1; }
      repaint();
    }));
}

function reviewChips(r, flags) {
  const on = flags.filter((f) => r[f.col]);
  if (r.review_override === false) return chip(tr("fin.reviewCleared"), "mute", "✓");
  if (!on.length && r.review_override !== true) return "";
  return (r.review_override === true ? chip(tr("fin.reviewManual"), "bad", "!") : "")
       + on.map((f) => chip(tr(f.key), "bad", "!")).join(" ");
}

/* ------------------------------------------------------------------ ORDERS grid */
function paintOrders(mount, state) {
  const grid = $("#fingrid", mount);
  const rows = sortRows(applyReviewFilter(ROWS.orders, REVIEW_FLAGS), "orders");
  const repaint = () => paintOrders(mount, state);

  const box = actionBar(mount, state, "orders",
    isViewer() ? "" : `<button class="btn sm primary" data-invoiced>${esc(tr("fin.markInvoiced"))}</button>`);

  if (!rows.length) {
    grid.innerHTML = `<div class="card"><span class="muted">${esc(tr("t.empty"))}</span></div>`;
    return;
  }

  const totals = rows.reduce((a, r) => {
    a.credits += Number(r.credits_aed || 0);
    a.unit += Number(r.unit_value || 0);
    if (needsReview(r)) a.review++;
    return a;
  }, { credits: 0, unit: 0, review: 0 });

  /* Order-level selection is a checkbox on the FIRST line of each order rather than a group header
   * row: a header row doubles the row count of a 4,500-line grid to carry one control. */
  let lastOrder = null;

  grid.innerHTML = `
    <div class="card fintotals">
      ${chip(`${tr("fin.lines")} ${num(rows.length)}`, "info")}
      ${chip(`${tr("rep.credits")} ${aed(totals.credits)}`, "ok")}
      ${chip(`${tr("fin.unitTotal")} ${aed(totals.unit)}`, "mute")}
      ${totals.review ? chip(`${tr("fin.needsReview")} ${num(totals.review)}`, "bad", "!") : ""}
    </div>
    <div class="fintablewrap">
      <table class="fintable">
        <thead><tr>
          <th class="tick"><input type="checkbox" data-all></th>
          ${sortableTh(tr("col.order"), "order_id", "orders")}
          ${sortableTh(tr("fin.skuBilling"), "sku_billing", "orders")}
          ${sortableTh(tr("fin.poSku"), "po_sku", "orders")}
          ${sortableTh(tr("fin.description"), "description", "orders")}
          ${sortableTh(tr("fin.qty"), "quantity", "orders")}
          ${sortableTh(tr("fin.width"), "adjusted_width_cm", "orders")}
          ${sortableTh(tr("fin.pricePerUnit"), "price_per_unit", "orders")}
          ${sortableTh(tr("fin.unitValue"), "unit_value", "orders")}
          ${sortableTh(tr("rep.credits"), "credits_aed", "orders")}
          ${sortableTh(tr("fin.invoiceStatus"), "invoice_status", "orders")}
          ${sortableTh(tr("fin.adjStatus"), "adjustment_status", "orders")}
          <th>${esc(tr("fin.review"))}</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => {
            const k = rowKey(r);
            const firstOfOrder = r.order_id !== lastOrder;
            lastOrder = r.order_id;
            const ro = isViewer() || r.no_credit;
            const cell = (name, val, type = "text") =>
              `<td><input class="fincell" type="${type}" data-k="${esc(k)}" data-f="${name}"
                 value="${esc(val ?? "")}"${ro ? " disabled" : ""}></td>`;
            return `
              <tr class="finrow${r.no_credit ? " nocredit" : ""}${needsReview(r) ? " review" : ""}"
                  data-k="${esc(k)}">
                <td class="tick"><input type="checkbox" data-pick="${esc(k)}"${
                  SEL.orders.has(k) ? " checked" : ""}></td>
                <td class="oid">${esc(r.order_id)}${firstOfOrder
                  ? ` <button class="linkish" data-order="${esc(r.order_id)}"
                        title="${esc(tr("fin.selectOrder"))}">⊞</button>` : ""}
                  ${r.no_credit ? chip(tr("fin.noCredit"), "mute") : ""}</td>
                ${cell("sku_billing", r.sku_billing)}
                <td class="muted">${esc(r.po_sku || "—")}</td>
                ${cell("description", r.description)}
                ${cell("quantity", r.quantity, "number")}
                ${cell("adjusted_width_cm", r.adjusted_width_cm, "number")}
                ${cell("price_per_unit", r.price_per_unit, "number")}
                <td class="ro">${r.unit_value == null ? "—" : aed(r.unit_value)}</td>
                ${cell("credits_aed", r.credits_aed, "number")}
                <td>${chip(r.invoice_status, r.invoice_status === "Invoiced" ? "ok"
                        : r.invoice_status === "Revised" ? "warn" : "mute")}</td>
                <td>${chip(r.adjustment_status, r.adjustment_status === "Invoiced" ? "ok" : "mute")}</td>
                <td class="rv">${reviewChips(r, REVIEW_FLAGS)}
                  ${r.pullcord_expected_aed != null
                    ? chip(`${tr("fin.pullcordShould")} ${aed(r.pullcord_expected_aed)}`, "warn") : ""}</td>
                <td><button class="btn sm ghost" data-expand="${esc(k)}">${
                  EXPANDED.has(k) ? "▴" : "▾"}</button></td>
              </tr>
              ${EXPANDED.has(k) ? `<tr class="finpo"><td colspan="14" data-po="${esc(k)}">
                 <span class="muted">${esc(tr("t.loading"))}</span></td></tr>` : ""}`;
          }).join("")}
        </tbody>
      </table>
    </div>`;

  const table = grid.querySelector(".fintable");
  wireSort(table, "orders", repaint);

  // selection
  table.querySelectorAll("[data-pick]").forEach((cb) =>
    cb.addEventListener("change", () => {
      cb.checked ? SEL.orders.add(cb.dataset.pick) : SEL.orders.delete(cb.dataset.pick);
      actionBarWire(mount, state, "orders", rows, repaint);
    }));
  table.querySelector("[data-all]").addEventListener("change", (e) => {
    rows.forEach((r) => e.target.checked ? SEL.orders.add(rowKey(r)) : SEL.orders.delete(rowKey(r)));
    repaint();
  });
  table.querySelectorAll("[data-order]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.order;
      const mine = rows.filter((r) => r.order_id === id).map(rowKey);
      const allOn = mine.every((k) => SEL.orders.has(k));
      mine.forEach((k) => allOn ? SEL.orders.delete(k) : SEL.orders.add(k));
      repaint();
    }));

  // inline edit - one line saved per change, through the same queue as every other write
  table.querySelectorAll(".fincell").forEach((inp) =>
    inp.addEventListener("change", () => saveCell(inp, rows, repaint)));

  // expand: the 93-column PO row, fetched only for the line somebody actually opened
  table.querySelectorAll("[data-expand]").forEach((b) =>
    b.addEventListener("click", async () => {
      const k = b.dataset.expand;
      if (EXPANDED.has(k)) EXPANDED.delete(k); else EXPANDED.add(k);
      repaint();
      if (EXPANDED.has(k)) await fillPoRow(grid, k);
    }));
  EXPANDED.forEach((k) => fillPoRow(grid, k));

  actionBarWire(mount, state, "orders", rows, repaint);
}

async function fillPoRow(grid, k) {
  const cell = grid.querySelector(`[data-po="${CSS.escape(k)}"]`);
  if (!cell) return;
  const [order_id, version_no, line_no] = k.split("|");
  try {
    const rows = await api(`/rest/v1/v_ops_finance_lines?select=po_row&order_id=eq.${
      encodeURIComponent(order_id)}&version_no=eq.${version_no}&line_no=eq.${line_no}&limit=1`);
    const po = (rows || [])[0] && rows[0].po_row;
    if (!po) { cell.innerHTML = `<span class="muted">${esc(tr("d.none"))}</span>`; return; }
    cell.innerHTML = `<div class="pogrid">${Object.keys(po).sort().map((key) => {
      const v = po[key];
      if (v === null || v === "" ) return "";
      return `<div class="pokv"><b>${esc(key)}</b><span>${esc(String(v))}</span></div>`;
    }).join("")}</div>`;
  } catch (e) {
    cell.innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
}

/* Save one line's overrides. Every editable box on the row is read, not just the one that changed,
 * so the RPC always receives the full picture - and a row emptied back to blanks deletes its
 * override rather than storing zeros. */
async function saveCell(inp, rows, repaint) {
  const k = inp.dataset.k;
  const tr_ = inp.closest("tr");
  const get = (f) => {
    const e = tr_.querySelector(`[data-f="${f}"]`);
    if (!e) return null;
    const v = e.value.trim();
    return v === "" ? null : v;
  };
  const numOrNull = (v) => (v == null ? null : Number(v));
  const [order_id, version_no, line_no] = k.split("|");
  const row = rows.find((r) => rowKey(r) === k);

  try {
    await submit("fn_finance_save_line", {
      p_order_id: order_id,
      p_version_no: Number(version_no),
      p_line_no: Number(line_no),
      p_sku: get("sku_billing"),
      p_description: get("description"),
      p_quantity: numOrNull(get("quantity")),
      p_width: numOrNull(get("adjusted_width_cm")),
      p_price: numOrNull(get("price_per_unit")),
      p_credits: numOrNull(get("credits_aed")),
      p_note: null,
      p_actor: currentActor(),
    });
    if (row) {
      row.sku_billing = get("sku_billing");
      row.description = get("description");
      row.quantity = numOrNull(get("quantity"));
      row.adjusted_width_cm = numOrNull(get("adjusted_width_cm"));
      row.price_per_unit = numOrNull(get("price_per_unit"));
      row.credits_aed = numOrNull(get("credits_aed"));
      row.edited = true;
    }
    inp.classList.add("saved");
    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
  } catch (e) {
    inp.classList.add("bad");
    toast(e.message, "bad");
  }
}

function actionBarWire(mount, state, which, rows, repaint) {
  const box = actionBar(mount, state, which,
    which === "orders"
      ? (isViewer() ? "" : `<button class="btn sm primary" data-invoiced>${esc(tr("fin.markInvoiced"))}</button>`)
      : (isViewer() ? "" : `<button class="btn sm accent" data-propose>${esc(tr("fin.proposeAmount"))}</button>`
                         + `<button class="btn sm primary" data-applied>${esc(tr("fin.markApplied"))}</button>`)
        + `<button class="btn sm" data-copy>${esc(tr("fin.copySheet"))}</button>`);

  box.querySelector("[data-selall]").addEventListener("click", () => {
    rows.forEach((r) => SEL[which].add(which === "orders" ? rowKey(r) : String(r.id)));
    repaint();
  });
  box.querySelector("[data-selnone]").addEventListener("click", () => {
    SEL[which].clear(); repaint();
  });

  const csv = box.querySelector("[data-csv]");
  if (csv) csv.addEventListener("click", () => exportCsv(which, rows));

  const inv = box.querySelector("[data-invoiced]");
  if (inv) inv.addEventListener("click", () => markInvoiced(rows, repaint));

  const app = box.querySelector("[data-applied]");
  if (app) app.addEventListener("click", () => markApplied(rows, repaint));

  const prop = box.querySelector("[data-propose]");
  if (prop) prop.addEventListener("click", () => proposeAmounts(rows, repaint));

  const cp = box.querySelector("[data-copy]");
  if (cp) cp.addEventListener("click", () => copyForSheet(rows));
}

function selectedRows(which, rows) {
  const keyOf = which === "orders" ? rowKey : (r) => String(r.id);
  return rows.filter((r) => SEL[which].has(keyOf(r)));
}

function exportCsv(which, rows) {
  const sel = selectedRows(which, rows);
  if (!sel.length) { toast(tr("fin.nothingSelected"), "bad"); return; }
  if (which === "orders") {
    downloadCsv(`finance_orders_${today()}.csv`, sel.map((r) => ({
      "Order Number": r.order_id,
      "SKU for billing": r.sku_billing || "",
      "PO SKU": r.po_sku || "",
      "Description": r.description || "",
      "Quantity for billing": r.quantity ?? "",
      "Adjusted Width for billing": r.adjusted_width_cm ?? "",
      "Price per unit": r.price_per_unit ?? "",
      "Unit value": r.unit_value ?? "",
      "Credits": r.credits_aed ?? "",
      "Invoice status": r.invoice_status,
      "Adjustment status": r.adjustment_status,
      "Review": needsReview(r) ? "Yes" : "No",
    })));
  } else {
    downloadCsv(`finance_adjustments_${today()}.csv`, sel.map(adjExportRow));
  }
  toast(tr("fin.exported", { n: sel.length }), "ok");
}

/* Exactly the column order the finance team pastes into their sheet. Do not reorder. */
const adjExportRow = (r) => ({
  "City": r.city || "",
  "Comment from Installation": r.installation_comment || "",
  "Order name": r.order_name || r.order_id,
  "Customer name": r.customer_name || "",
  "Amount": r.amount_aed ?? "",
  "Reason": r.reason || "",
});

/* Tab-separated, which is what a spreadsheet expects off the clipboard - a comma-separated paste
 * lands in one column and has to be run through Text to Columns by hand. */
function copyForSheet(rows) {
  const sel = selectedRows("adj", rows);
  const use = sel.length ? sel : rows;
  const cols = ["City", "Comment from Installation", "Order name", "Customer name", "Amount", "Reason"];
  const body = use.map((r) => {
    const o = adjExportRow(r);
    // a tab or newline inside a comment would break the grid the paste lands in
    return cols.map((c) => String(o[c] ?? "").replace(/[\t\r\n]+/g, " ")).join("\t");
  });
  copyText([cols.join("\t"), ...body].join("\n"));
  toast(tr("fin.copied", { n: use.length }), "ok");
}

async function markInvoiced(rows, repaint) {
  const sel = selectedRows("orders", rows);
  if (!sel.length) { toast(tr("fin.nothingSelected"), "bad"); return; }
  const ids = Array.from(new Set(sel.map((r) => r.order_id)));
  try {
    await submit("fn_finance_set_invoice_status", {
      p_order_ids: ids, p_status: "Invoiced", p_actor: currentActor(),
    });
    rows.forEach((r) => { if (ids.includes(r.order_id)) r.invoice_status = "Invoiced"; });
    SEL.orders.clear();
    toast(queueDepth() ? tr("t.queued") : tr("fin.markedOrders", { n: ids.length }), "ok");
    repaint();
  } catch (e) { toast(e.message, "bad"); }
}

async function markApplied(rows, repaint) {
  const sel = selectedRows("adj", rows);
  if (!sel.length) { toast(tr("fin.nothingSelected"), "bad"); return; }
  const ids = Array.from(new Set(sel.map((r) => r.order_id)));
  try {
    await submit("fn_finance_set_adjustment_status", {
      p_order_ids: ids, p_status: "Invoiced", p_actor: currentActor(),
    });
    rows.forEach((r) => { if (ids.includes(r.order_id)) r.adjustment_status = "Invoiced"; });
    SEL.adj.clear();
    toast(queueDepth() ? tr("t.queued") : tr("fin.markedOrders", { n: ids.length }), "ok");
    repaint();
  } catch (e) { toast(e.message, "bad"); }
}

/* ------------------------------------------------------------------ ADJUSTMENTS grid */
function paintAdjustments(mount, state) {
  const grid = $("#fingrid", mount);
  const rows = sortRows(applyReviewFilter(ROWS.adj, ADJ_REVIEW_FLAGS), "adj");
  const repaint = () => paintAdjustments(mount, state);

  if (!rows.length) {
    actionBarWire(mount, state, "adj", rows, repaint);
    grid.innerHTML = `<div class="card"><span class="muted">${esc(tr("t.empty"))}</span></div>`;
    return;
  }

  const total = rows.reduce((a, r) => a + Number(r.amount_aed || 0), 0);

  grid.innerHTML = `
    <div class="card fintotals">
      ${chip(`${tr("adj.title")} ${num(rows.length)}`, "info")}
      ${chip(`${tr("adj.amount")} ${aed(total)}`, "ok")}
    </div>
    <div class="fintablewrap">
      <table class="fintable">
        <thead><tr>
          <th class="tick"><input type="checkbox" data-all></th>
          ${sortableTh(tr("col.city"), "city", "adj")}
          ${sortableTh(tr("fin.installComment"), "installation_comment", "adj")}
          ${sortableTh(tr("fin.orderName"), "order_name", "adj")}
          ${sortableTh(tr("col.customer"), "customer_name", "adj")}
          ${sortableTh(tr("adj.amount"), "amount_aed", "adj")}
          ${sortableTh(tr("adj.reason"), "reason", "adj")}
          ${ADJ_FLAGS.map((f) => sortableTh(tr(f.key), f.col, "adj")).join("")}
          ${sortableTh(tr("fin.invoiceStatus"), "invoice_status", "adj")}
          ${sortableTh(tr("fin.adjStatus"), "adjustment_status", "adj")}
          <th>${esc(tr("fin.review"))}</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => {
            const ro = isViewer();
            /* The rate card's figure for this charge type at this quantity, shown only when it is
             * NOT what the row already holds. Printing it beside an identical number is noise on
             * every row; printing it when they differ is the whole reason to look. */
            const cardHint = r.card_amount_aed != null
              && Number(r.card_amount_aed) !== Number(r.amount_aed ?? NaN)
              ? `<div class="muted amthint">${esc(tr("adj.suggested"))}: ${esc(aed(r.card_amount_aed))}</div>`
              : "";
            return `
            <tr class="finrow${needsReview(r, ADJ_REVIEW_FLAGS) ? " review" : ""}">
              <td class="tick"><input type="checkbox" data-pick="${esc(r.id)}"${
                SEL.adj.has(String(r.id)) ? " checked" : ""}></td>
              <td>${esc(r.city || "—")}</td>
              <td class="wide">${esc(r.installation_comment || "—")}</td>
              <td class="oid">${esc(r.order_name || r.order_id)}</td>
              <td>${esc(r.customer_name || "—")}</td>
              <!-- Editable, and labelled with where the number came from. A figure the rate card
                   produced and a figure somebody agreed with a client look identical in a column of
                   money, and they are not the same thing when the client queries the invoice. -->
              <td class="amt">
                <input class="fincell" type="number" step="0.01" inputmode="decimal"
                       data-id="${esc(r.id)}" data-amt value="${esc(r.amount_aed ?? "")}"${
                  ro ? " disabled" : ""}>
                ${r.amount_is_system ? chip(tr("fin.systemCalc"), "info", "∑") : ""}
                ${cardHint}
              </td>
              <td class="wide">${esc(r.reason || "—")}</td>
              ${ADJ_FLAGS.map((f) => {
                const at = r[`${f.col}_at`], by = r[`${f.col}_by`];
                // who and when, on hover - the columns exist so that question has an answer
                const title = r[f.col] && (at || by)
                  ? `${tr(f.key)} — ${[by, at ? fmtDate(at) : ""].filter(Boolean).join(" · ")}`
                  : tr(f.key);
                return `<td class="tick"><input type="checkbox" data-flag="${esc(f.col)}"
                          data-id="${esc(r.id)}" title="${esc(title)}" aria-label="${esc(title)}"${
                  r[f.col] ? " checked" : ""}${ro ? " disabled" : ""}></td>`;
              }).join("")}
              <td>${chip(r.invoice_status, r.invoice_status === "Invoiced" ? "ok" : "mute")}</td>
              <td>${chip(r.adjustment_status, r.adjustment_status === "Invoiced" ? "ok" : "mute")}</td>
              <td class="rv">${reviewChips(r, ADJ_REVIEW_FLAGS)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;

  const table = grid.querySelector(".fintable");
  wireSort(table, "adj", repaint);
  table.querySelectorAll("[data-pick]").forEach((cb) =>
    cb.addEventListener("change", () => {
      cb.checked ? SEL.adj.add(cb.dataset.pick) : SEL.adj.delete(cb.dataset.pick);
      actionBarWire(mount, state, "adj", rows, repaint);
    }));
  table.querySelector("[data-all]").addEventListener("change", (e) => {
    rows.forEach((r) => e.target.checked ? SEL.adj.add(String(r.id)) : SEL.adj.delete(String(r.id)));
    repaint();
  });

  // one amount saved per change, through the same queue as every other write on this screen
  table.querySelectorAll("[data-amt]").forEach((inp) =>
    inp.addEventListener("change", () => saveAdjAmount(inp, rows, repaint)));

  /* The three tick boxes. No repaint on toggle: redrawing the grid under somebody working down a
   * column of checkboxes moves the next box out from under their finger. The row object is updated
   * in place instead, so a later sort or filter still sees the new value. */
  table.querySelectorAll("[data-flag]").forEach((cb) =>
    cb.addEventListener("change", () => setAdjFlag(cb, rows)));

  actionBarWire(mount, state, "adj", rows, repaint);
}

/* One adjustment's amount, typed over whatever was proposed.
 *
 * Blank does NOT mean zero - it hands the row back to the rate card, which is the only way to undo
 * an override without knowing what the figure used to be. fn_finance_set_adjustment_amount is what
 * decides the replacement, from the card as it stands today. */
async function saveAdjAmount(inp, rows, repaint) {
  const id = Number(inp.dataset.id);
  const raw = inp.value.trim();
  const row = rows.find((r) => Number(r.id) === id);
  try {
    const res = await rpc("fn_finance_set_adjustment_amount", {
      p_id: id,
      p_amount: raw === "" ? null : Number(raw),
      p_actor: currentActor(),
    });
    const out = Array.isArray(res) ? res[0] : res;
    if (row) {
      row.amount_aed = out && out.amount_aed != null ? Number(out.amount_aed) : null;
      row.amount_source = (out && out.amount_source) || (raw === "" ? "system" : "manual");
      row.amount_is_system = row.amount_source === "system";
      row.rv_incomplete = !row.reason || row.amount_aed == null;
    }
    inp.classList.add("saved");
    toast(tr("t.saved"), "ok");
    repaint();          // the System calculated chip and the rate-card hint both just changed
  } catch (e) {
    inp.classList.add("bad");
    toast(e.message, "bad");
  }
}

/* Updated on 3D sheet / Invoice created / Paid. submit() rather than rpc() because unlike the
 * amount there is nothing to read back - the tick is the whole write, and it should survive a lift
 * the same way marking an order invoiced does. */
async function setAdjFlag(cb, rows) {
  const id = Number(cb.dataset.id);
  const flag = cb.dataset.flag;
  const on = cb.checked;
  const row = rows.find((r) => Number(r.id) === id);
  try {
    await submit("fn_finance_set_adjustment_flag", {
      p_ids: [id], p_flag: flag, p_on: on, p_actor: currentActor(),
    });
    if (row) {
      row[flag] = on;
      row[`${flag}_at`] = on ? new Date().toISOString() : null;
      row[`${flag}_by`] = on ? currentActor() : null;
    }
    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
  } catch (e) {
    cb.checked = !on;            // the box must never show a state the database does not hold
    toast(e.message, "bad");
  }
}

/* ---------------------------------------------------------------- propose amounts
 * What the rate card says these adjustments should cost, written onto them.
 *
 * The arithmetic is NOT done here. fn_finance_propose_adjustment_amount looks every row up through
 * fn_ops_rate_for, the same function the Installation module's capture sheet and Chotu both call,
 * so three screens can never quote different money for the same work. What this shows is
 * card_amount_aed, which the view computes through that same function - so the preview and the
 * write cannot disagree either.
 *
 * IT IS SHOWN BEFORE IT IS WRITTEN. This changes money on rows somebody else captured, in bulk, and
 * a bulk money write with no preview is one mis-click away from restating a whole day's charges. */
function proposeAmounts(rows, repaint) {
  const sel = selectedRows("adj", rows);
  if (!sel.length) { toast(tr("fin.nothingSelected"), "bad"); return; }

  const rated = sel.filter((r) => r.card_amount_aed != null);
  const norate = sel.filter((r) => r.card_amount_aed == null);
  const manual = rated.filter((r) => r.amount_source === "manual");
  const auto = rated.filter((r) => r.amount_source !== "manual");

  if (!auto.length && !manual.length) {
    toast(norate.length ? tr("fin.noRate") : tr("fin.proposeNone"), "bad");
    return;
  }

  const line = (r) => `
    <div class="tline">
      <div><b>${esc(r.order_name || r.order_id)}</b>
        <div class="muted">${esc(r.reason || r.charge_type || "")}${
          r.quantity != null && Number(r.quantity) !== 1 ? " · ×" + esc(num(r.quantity)) : ""}</div></div>
      <div>${r.amount_source === "manual" ? chip(tr("fin.proposeOverwrite"), "warn", "!") : ""}
        <span class="muted">${esc(tr("fin.wasAmount"))} ${esc(aed(r.amount_aed ?? 0))}</span>
        → <b>${esc(aed(r.card_amount_aed))}</b></div>
    </div>`;

  const m = modal(`
    <h3>${esc(tr("fin.proposeTitle"))}</h3>
    <p class="muted" style="margin:8px 0 12px">${esc(tr("fin.proposeBody"))}</p>
    <div class="failedlist">${auto.map(line).join("")}${manual.map(line).join("")}</div>
    ${manual.length ? `<label class="cbrow" style="margin-top:12px">
       <input type="checkbox" data-over> ${esc(tr("fin.proposeOverwrite"))}
         (${esc(num(manual.length))})</label>
     <div class="muted" style="margin-top:4px">${esc(tr("fin.proposeOverwriteHint"))}</div>` : ""}
    ${norate.length ? `<div class="banner warn" style="margin-top:12px">${
      esc(tr("fin.noRate"))} — ${esc(num(norate.length))}</div>` : ""}
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-yes>${esc(tr("fin.proposeAmount"))}</button>
    </div>`);

  m.sheet.querySelector("[data-no]").onclick = m.close;
  m.sheet.querySelector("[data-yes]").onclick = async () => {
    const over = m.sheet.querySelector("[data-over]");
    const overwrite = !!(over && over.checked);
    m.close();
    try {
      const res = await rpc("fn_finance_propose_adjustment_amount", {
        p_ids: sel.map((r) => Number(r.id)),
        p_overwrite_manual: overwrite,
        p_actor: currentActor(),
      });
      const out = Array.isArray(res) ? res[0] : res;
      // repainted from the server's own numbers rather than from what we guessed it would do
      const touched = new Set((overwrite ? rated : auto).map((r) => Number(r.id)));
      rows.forEach((r) => {
        if (!touched.has(Number(r.id))) return;
        r.amount_aed = Number(r.card_amount_aed);
        r.amount_source = "system";
        r.amount_is_system = true;
        r.rv_incomplete = !r.reason || r.amount_aed == null;
      });
      const n = out ? Number(out.updated || 0) : touched.size;
      const skipped = out ? Number(out.skipped_manual || 0) + Number(out.skipped_no_rate || 0) : 0;
      toast(tr("fin.proposeDone", { n }) + (skipped ? " " + tr("fin.proposeSkipped", { n: skipped }) : ""),
            "ok");
      repaint();
    } catch (e) { toast(e.message, "bad"); }
  };
}
