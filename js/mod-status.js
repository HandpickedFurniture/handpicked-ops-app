/* Module 2 - Order status, visits and chargeable extras.
 *
 * An adjustment here is WORK DONE OVER AND ABOVE THE PURCHASE ORDER, and it is chargeable to the
 * client. It is captured with enough structure to invoice from later: charge type, quantity, the
 * agreed amount, who agreed it, which visit it arose on, and why. Amounts pre-fill from
 * adjustment_rate_card via fn_ops_rate_for - never hardcoded here - so removal's banding and any
 * future rate change live in exactly one place.
 *
 * A revisit is itself billable, so recording visit 2+ auto-proposes an additional_visit charge. It is
 * proposed, never billed silently: it lands as status 'new' for a human to confirm or drop.
 */
import { api, apiAll, rpc, submit, currentActor, queueDepth, isSignedIn, rawMessage } from "./api.js";
import { tr, tv, getLang } from "./i18n.js";
import {
  ORDER_STATUSES, STATUS_TONE, CHARGE_TYPES, ADJ_STATUSES, ADJ_REASONS, TRANSFER_STATUSES,
  SPECIAL_COLS,
} from "./config.js";
import {
  $, esc, el, chip, aed, num, fmtDate, toast, loading, modal, selectHtml, orderLabel, copyText,
  today,
} from "./ui.js";
import { renderFilterBar, toQuery, deriveOptions, activeCount, writeHash } from "./filters.js";
import { micField, wireMics } from "./voice.js";
import { photoStrip } from "./photos.js";
import { syncBar } from "./sync.js";

/* v_ops_status_board carries production_state but not the roster's fabric/tailor columns, so this
 * module opts into that one filter only - see OPTIONAL in filters.js. */
const CAPS = { prodstate: true };

const BOARD_COLS = [
  "order_id", "customer_name", "city", "city_source", "installation_date", "date_bucket",
  "sheet_status", "version_no", "window_count", "status", "ready", "comment",
  "alteration", "alteration_note", "alteration_special_requirement", "removal_curtain_count",
  "owl_total", "owl_curtains", "owl_blinds", "production_state",
  "optional_comments", "installation_notes", "production_comments",
  "n_roman", "n_roller", "n_zebra", "n_wooden", "n_venetian", "n_pelmet", "n_motor",
  "n_bend_rail", "n_scaffolding", "n_pull_cord", "n_eyelet", "n_baton_stick",
  "n_tieback_hooks", "n_tieback_velcro", "n_cassette", "n_trunking", "n_velcro_stitch",
  "n_pickup", "n_alteration", "n_removal",
  "has_adjustment", "adjustment_count", "adjustment_amount", "team_no", "team_name",
  "team_assigned", "visit_count", "last_visit_no", "last_visit_date", "last_visit_status",
  "last_visit_members", "adj_pending",
  "production_hold", "cancelled", "transfer_status", "transfer_location", "photo_count",
  "stitching_types", "commercial_names", "window_refs", "fabric_1_codes", "fabric_2_codes",
].join(",");

let OPTIONS = null;
export async function render(mount, state, setFilters) {
  if (!isSignedIn()) return;
  mount.innerHTML = `<div class="sectionbar"><span></span><span id="stsync"></span></div>
                     <div id="fbar"></div><div id="extra"></div><div id="board"></div>`;
  $("#stsync", mount).appendChild(syncBar());

  if (!OPTIONS) {
    try {
      const all = await apiAll("/rest/v1/v_ops_order_roster?select=city,sheet_status,stitching_types,commercial_names,window_refs,fabric_1_codes,fabric_2_codes");
      OPTIONS = deriveOptions(all);
    } catch (e) { OPTIONS = deriveOptions([]); }
  }

  const bar = $("#fbar", mount);
  const box = $("#board", mount);

  /* THE OUTCOME FILTER, and the one thing this board could not be narrowed by until now: which of
   * the ten statuses an order is sitting on. It rides OUTSIDE the shared bar on its own `status`
   * param, exactly as the management dashboard's does and under the same key - so a link filtered
   * on one screen opens filtered on the other, which is the whole reason the filters live in the
   * hash. Everything else this module filters by is a property of the ORDER; this is the property
   * of the visit that the module exists to record, so it sits on its own line above the list. */
  const fStatus = state.params.get("status") || "";
  /* Apply on the shared bar carries the status with it. Without this the bar would rebuild the
   * whole query string from the filter fields alone and silently drop it - see writeHash, which
   * writes exactly the keys it is given. */
  const applyFilters = (f) => writeHash("status", f, { status: fStatus });
  const paintBar = () => renderFilterBar(bar, state, OPTIONS, applyFilters, CAPS);
  paintBar();

  const ex = el(`
    <div class="card">
      <div class="fgrid" style="margin:0">
        <div><label class="f">${esc(tr("col.status"))}</label>
          ${selectHtml("ststatus", ORDER_STATUSES, fStatus, tr("f.any"))}</div>
      </div>
    </div>`);
  // filters on pick rather than on Apply: it is one control with one value, and there is nothing
  // else on this line to wait for
  ex.querySelector('[name="ststatus"]').addEventListener("change", (e) => {
    writeHash("status", state.filters, { status: e.target.value });
  });
  $("#extra", mount).appendChild(ex);

  loading(true, tr("t.loading"));
  let rows = [];
  try {
    rows = await apiAll(
      `/rest/v1/v_ops_status_board?select=${BOARD_COLS}&order=installation_date.asc.nullslast${
        toQuery(state.filters, CAPS)}${
        fStatus ? `&status=eq.${encodeURIComponent(fStatus)}` : ""}`,
      200);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  state.count = rows.length;
  paintBar();

  if (!rows.length) {
    box.innerHTML = `<div class="card"><span class="muted">${
      esc(activeCount(state.filters, CAPS) || fStatus
            ? tr("t.empty") : tr("t.emptyUnfiltered"))}</span></div>`;
    return;
  }

  const reload = () => render(mount, state, setFilters);
  const list = el(`<div class="olist"></div>`);
  rows.forEach((r) => list.appendChild(orderCard(r, reload)));
  box.appendChild(list);
}

/* The special requirements that actually apply to this order - what the installers need to have on
 * the van before they leave. */
function specialChips(r) {
  const on = SPECIAL_COLS.filter((s) => Number(r[s.col]) > 0);
  if (!on.length) return "";
  return on.map((s) => chip(`${tr(s.key)} ${num(r[s.col])}`, "info")).join(" ");
}

/* ---------------------------------------------------------------- readiness
 * The questions asked before a van leaves, answered in one strip at the top of the panel: has the
 * fabric landed, have the materials landed, is it stacked, are the rails done, and what special work
 * does this order carry.
 *
 * Every line is done-of-total rather than a tick. "3 of 5" and "none of 5" are different
 * conversations and a single tick collapses them into the same non-answer; a total of zero is a
 * third thing again - nothing to do - and reads as a dash rather than a red nought.
 */
function readyChip(done, total) {
  const d = Number(done || 0), t = Number(total || 0);
  if (!t) return chip("—", "mute");
  return chip(`${num(d)}/${num(t)}`, d >= t ? "ok" : (d ? "warn" : "bad"), d >= t ? "✓" : "");
}

function readinessSection(r, roster, rails, units, stacked) {
  // a prep unit is window x layer, and a location row is one of those units having been put down
  const unitKey = (x) => `${x.window_name}|${x.layer_no}`;
  const stackedCount = new Set((stacked || []).map(unitKey)).size;
  const unitCount = new Set((units || []).map(unitKey)).size;
  const rows = rails || [];
  const special = specialChips(r);

  const line = (label, content) =>
    `<div class="unit"><div class="uname">${esc(label)}</div><div>${content}</div></div>`;

  return el(`
    <div class="dsec">
      <h4>${esc(tr("st.summary"))}</h4>
      ${line(tr("col.fabrics"),
             readyChip(roster && roster.recv_fab_done, roster && roster.recv_fab_total))}
      ${line(tr("st.materialsRecv"),
             readyChip(roster && roster.recv_mat_done, roster && roster.recv_mat_total))}
      ${line(tr("prep.stacking"), readyChip(stackedCount, unitCount))}
      ${line(tr("rep.railing"), readyChip(rows.filter((x) => x.rail_done).length, rows.length))}
      <div class="unit">
        <div class="uname">${esc(tr("col.special"))}</div>
        <div class="ochips" style="margin-top:0">${special || chip("—", "mute")}</div>
      </div>
    </div>`);
}

function orderCard(r, reload) {
  const st = r.status ? chip(r.status, STATUS_TONE[r.status] || "mute") : "";
  const card = el(`
    <div class="ocard b-${esc(r.date_bucket)}">
      <div class="ohead">
        <div class="ometa">
          <div class="row" style="gap:6px">
            <span class="oid">${esc(r.order_id)}</span>
            ${r.ready ? chip(tr("st.ready"), "ok", "✓") : ""}
            ${r.team_assigned ? chip(r.team_name || tr("dash.team", { n: r.team_no }), "info")
                              : chip(tr("dash.unassigned"), "mute")}
            ${st}
          </div>
          <div class="oname">${esc(r.customer_name || "—")}</div>
          <div class="osub">${esc(r.city || tr("t.cityUnknown"))} · ${esc(fmtDate(r.installation_date))}
            · ${esc(r.visit_count)} ${esc(tr("col.visits").toLowerCase())}
            ${r.last_visit_members && r.last_visit_members.length
              ? " · " + esc(r.last_visit_members.join(", ")) : ""}</div>
          <div class="ochips">
            ${chip(`${tr("col.owlTotal")} ${num(r.owl_total)}`, "info")}
            ${Number(r.owl_curtains) ? chip(`${tr("col.owlCurtains")} ${num(r.owl_curtains)}`, "mute") : ""}
            ${Number(r.owl_blinds) ? chip(`${tr("col.owlBlinds")} ${num(r.owl_blinds)}`, "mute") : ""}
            ${chip(`${tr("col.windows")} ${num(r.window_count)}`, "mute")}
          </div>
          <div class="ochips">
            ${r.alteration ? chip(tr("st.alteration"), "warn", "!") : ""}
            ${Number(r.removal_curtain_count)
              ? chip(`${tr("st.removalCount")} ${r.removal_curtain_count}`, "info") : ""}
            ${r.transfer_status
              ? chip(tv(TRANSFER_STATUSES, r.transfer_status),
                     (TRANSFER_STATUSES.find((s) => s.value === r.transfer_status) || {}).tone) : ""}
            ${r.adj_pending ? chip(`${tr("adj.new")} ${r.adj_pending}`, "warn", "!") : ""}
            ${r.photo_count ? chip(String(r.photo_count), "mute", "📷") : ""}
          </div>
          <div class="ochips">${specialChips(r)}</div>
          ${r.optional_comments || r.installation_notes ? `<div class="osub" style="margin-top:6px">
            ${r.optional_comments ? esc(String(r.optional_comments).slice(0, 140)) : ""}
            ${r.installation_notes ? " · <i>" + esc(String(r.installation_notes).slice(0, 140)) + "</i>" : ""}
          </div>` : ""}
        </div>
        <span class="ocaret">▾</span>
      </div>
      <div class="dhost"></div>
    </div>`);

  const head = card.querySelector(".ohead");
  const host = card.querySelector(".dhost");
  head.addEventListener("click", async () => {
    if (host.innerHTML) { host.innerHTML = ""; card.querySelector(".ocaret").textContent = "▾"; return; }
    card.querySelector(".ocaret").textContent = "▴";
    await renderStatusPanel(host, r, reload);
  });
  return card;
}

async function renderStatusPanel(host, r, reload) {
  host.innerHTML = `<div class="drawer"><span class="muted">${esc(tr("t.loading"))}</span></div>`;
  const q = encodeURIComponent(r.order_id);
  let visits = [], adjustments = [], roster = null, rails = [], units = [], stacked = [];
  let ostat = null;
  try {
    /* The readiness counts are NOT on v_ops_status_board - that view carries production_state and
     * the special-requirement columns but none of the receiving or prep tallies - so they are read
     * here, on expand, from the views that do have them. Six requests in one Promise.all is one
     * round trip, and only for the order somebody actually opened.
     *
     * order_status is read straight from the table for the four alteration counts. They could have
     * been added to v_ops_status_board instead, but that view is fetched for every row on the board
     * and these four numbers are wanted for exactly one order at a time. */
    let rosterRows, statRows;
    [visits, adjustments, rosterRows, rails, units, stacked, statRows] = await Promise.all([
      api(`/rest/v1/order_visits?select=*&order_id=eq.${q}&order=visit_no`),
      api(`/rest/v1/v_ops_adjustments?select=*&order_id=eq.${q}&order=id`),
      api(`/rest/v1/v_ops_order_roster?select=recv_fab_done,recv_fab_total,recv_mat_done,recv_mat_total,prep_done,prep_total&order_id=eq.${q}`),
      api(`/rest/v1/v_ops_report_railing?select=line_id,rail_done&order_id=eq.${q}`),
      api(`/rest/v1/v_ops_prep_units?select=window_name,layer_no&order_id=eq.${q}`),
      api(`/rest/v1/v_ops_prep_locations?select=window_name,layer_no&order_id=eq.${q}`),
      api(`/rest/v1/order_status?select=alteration_planned_1l,alteration_planned_2l,alteration_adj_1l,alteration_adj_2l&order_id=eq.${q}`),
    ]);
    roster = (rosterRows || [])[0] || null;
    ostat = (statRows || [])[0] || null;
  } catch (e) {
    host.innerHTML = `<div class="drawer"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }

  const wrap = el(`<div class="drawer"></div>`);

  /* ---- what is and is not ready, before anything else in the panel */
  wrap.appendChild(readinessSection(r, roster, rails, units, stacked));

  /* ---- order level */
  /* THE STATUS PILL beside the dropdown. A select shows the current value only if you read it, and
   * the same order in the list above is already colour-coded - so the panel and the list disagreed
   * at a glance. Same chip(), same STATUS_TONE, so they now say the same thing the same way. */
  const statusPill = (v) => (v ? chip(v, STATUS_TONE[v] || "mute") : chip(tr("st.noStatus"), "mute"));

  /* COUNTS, NOT A BOOLEAN, and split by who pays.
   *
   * "Was there an alteration" cannot price anything. What prices an alteration is HOW MANY CURTAINS
   * were altered, and a 2 layer window is TWO curtains - the single most expensive mistake in this
   * business, per the charge rules. So each group is entered as windows-by-layer-count and the
   * curtain total is derived beside it, where it can be read back and checked.
   *
   * Planned is what the purchase order already covers. Adjustment is what arose on site and is
   * chargeable - and it is the number the visit calculator starts from. */
  const cnt = (name, val) => `
    <select name="${esc(name)}">
      ${Array.from({ length: 21 }, (_, i) =>
        `<option value="${i}"${Number(val || 0) === i ? " selected" : ""}>${i}</option>`).join("")}
    </select>`;
  /* PLANNED ONLY. Adjustment alteration used to sit beside this and has moved to the sheet that
   * actually charges for it - the counts and the money were being entered in two places, a day
   * apart, by the same person. Planned belongs here because it describes the order as sold. */
  const altGroup = (p1, p2) => `
    <div class="altgrp">
      <div class="altgrph"><b>${esc(tr("st.altPlanned"))}</b>
        <span class="chip mute" data-curtains></span></div>
      <div class="grid2">
        <div><label class="f">${esc(tr("st.alt1L"))}</label>${cnt("op1", p1)}</div>
        <div><label class="f">${esc(tr("st.alt2L"))}</label>${cnt("op2", p2)}</div>
      </div>
    </div>`;

  const orderBox = el(`
    <div class="dsec">
      <h4>${esc(tr("st.orderStatus"))}</h4>
      <div class="grid2">
        <div><label class="f">${esc(tr("col.status"))}</label>
          <div class="statusrow">
            ${selectHtml("ostatus", ORDER_STATUSES, r.status || "", tr("f.any"))}
            <span data-pill>${statusPill(r.status)}</span>
          </div></div>
        <div><label class="f">${esc(tr("st.removalCount"))}</label>
          <input type="number" name="oremoval" min="0" step="1"
                 value="${esc(r.removal_curtain_count ?? "")}"></div>
      </div>
      <div class="altsplit">
        ${altGroup((ostat || {}).alteration_planned_1l, (ostat || {}).alteration_planned_2l)}
      </div>
      <div style="margin-top:10px">
        <label class="f">${esc(tr("st.alterationNote"))}</label>
        <input type="text" name="oaltnote"
               value="${esc(r.alteration_special_requirement || "")}">
      </div>
      <div style="margin-top:10px">
        <label class="f">${esc(tr("st.internal"))}</label>
        ${micField(`<textarea name="ocomment">${esc(r.comment || "")}</textarea>`, "ocomment")}
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:8px">
        <button class="btn primary sm" data-saveorder>${esc(tr("act.save"))}</button>
      </div>
    </div>`);

  const oq = (n) => orderBox.querySelector(`[name="${n}"]`);
  const numOf = (n) => Number(oq(n).value || 0);
  // curtains = single-layer windows + twice the two-layer ones, shown live so the doubling is
  // visible rather than something the reader has to do in their head
  const curtainsOf = (a, b) => numOf(a) + 2 * numOf(b);
  const paintCurtains = () => {
    orderBox.querySelector("[data-curtains]").textContent =
      tr("st.altCurtains", { n: curtainsOf("op1", "op2") });
  };
  ["op1", "op2"].forEach((n) => oq(n).addEventListener("change", paintCurtains));
  paintCurtains();

  // the pill follows the dropdown before anything is saved, so the choice is legible immediately
  oq("ostatus").addEventListener("change", (e) => {
    orderBox.querySelector("[data-pill]").innerHTML = statusPill(e.target.value);
  });

  // Removal count drives the banded removal charge, so offer it right where it is entered.
  const remIn = oq("oremoval");
  remIn.addEventListener("change", () => {
    const n = Number(remIn.value || 0);
    if (n > 2) toast(tr("chg.removal") + " — " + tr("adj.add"), "ok");
  });

  orderBox.appendChild(photoStrip({
    context: "order_status", order_id: r.order_id, context_label: tr("st.orderStatus"),
  }));
  let method = "typed";
  wireMics(orderBox, (_t, m) => { method = m; });
  orderBox.querySelector("[data-saveorder]").addEventListener("click", async () => {
    await submit("fn_ops_save_visit", {
      p_order_id: r.order_id,
      p_visit_no: Math.max(1, r.last_visit_no || 1),
      /* team_no and ready are deliberately ABSENT rather than null: fn_ops_save_visit coalesces
       * every field against what is already stored, so omitting a key leaves it alone. Sending
       * null would be the same thing here, but sending `false` for ready - which is what a
       * removed dropdown would have read as - would silently un-ready every order saved. */
      p_payload: {
        status: oq("ostatus").value || null,
        /* The four counts, not the boolean. fn_ops_save_visit derives `alteration` from them when
         * they are present - it is still read by the filter bar, the dashboard, the production
         * chips and the schedule tags, so it has to stay true to what is entered here. */
        /* Only the PLANNED pair. The adjustment pair is absent, not zero - fn_ops_save_visit
         * coalesces an absent key against the stored value, so saving here cannot wipe what the
         * charge sheet recorded. */
        alteration_planned_1l: numOf("op1"), alteration_planned_2l: numOf("op2"),
        alteration_special_requirement: oq("oaltnote").value || null,
        removal_curtain_count: oq("oremoval").value || null,
        comment: oq("ocomment").value || null,
        input_method: method, lang: getLang(),
        skip_visit_charge: true,   // editing order-level fields must not invent a visit charge
      },
      p_actor: currentActor(),
    });
    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
    reload();
  });
  wrap.appendChild(orderBox);

  /* ---- visits */
  const vBox = el(`<div class="dsec"><h4>${esc(tr("col.visits"))} <span class="chip mute">${visits.length}</span></h4></div>`);
  visits.forEach((v) => vBox.appendChild(visitRow(r, v, reload)));

  wrap.appendChild(vBox);

  /* ---- adjustments */
  wrap.appendChild(adjustmentsSection(r, adjustments, reload));

  /* ---- the one button that adds to either list
   *
   * There used to be two, one at the foot of each section, and they were two halves of a single
   * event: the team went back, and while they were there they did work that is chargeable. Two
   * buttons made that two sheets and two saves, and the second save is the one people did not come
   * back for - which is how an order ends up with a revisit recorded and no charge against it, or a
   * charge with no visit to explain it. One sheet, one Save, either half or both. */
  const nextNo = (visits.length ? Math.max(...visits.map((v) => v.visit_no)) : 0) + 1;
  const addRow = el(`
    <div class="row" style="margin:-4px 0 14px">
      <button class="btn accent" data-addwork>+ ${esc(tr("st.addWork"))}</button>
    </div>`);
  addRow.querySelector("[data-addwork]").addEventListener("click", () => {
    // order_visits.visit_no is capped at 10 and v_order_status_wide pivots exactly 1..10, so block
    // it here with a clear message rather than letting Postgres throw
    openWorkSheet(r, { visit_no: nextNo }, reload, { visitFull: nextNo > 10 });
  });
  wrap.appendChild(addRow);

  /* The links out to Transfers, Stock and Photo audit used to sit here. They were three ways to
   * leave the screen somebody had just opened to record what happened on site, and all three
   * screens are one tap away from Home. Every route they pointed at still exists and is still
   * linkable; the panel simply stopped advertising them. */

  host.innerHTML = "";
  host.appendChild(wrap);
}

function visitRow(r, v, reload) {
  const row = el(`
    <div class="unit">
      <div class="uname">${esc(tr("st.visit", { n: v.visit_no }))}
        <div class="usub">${esc(fmtDate(v.visit_date))}${v.visit_time ? " · " + esc(v.visit_time) : ""}
          ${v.member_names && v.member_names.length ? " · " + esc(v.member_names.join(", ")) : ""}
          ${v.comment ? " · " + esc(v.comment) : ""}</div>
      </div>
      <div>${v.status ? chip(v.status, STATUS_TONE[v.status] || "mute") : chip("—", "mute")}
        ${v.has_adjustment ? chip(aed(v.adjustment_amount), "warn") : ""}</div>
      <div><button class="btn sm" data-edit>${esc(tr("d.open"))}</button></div>
    </div>`);
  row.querySelector("[data-edit]").addEventListener("click", () => openWorkSheet(r, v, reload));
  return row;
}

/* ---------------------------------------------------------------- visit + charge, ONE sheet
 *
 * WHAT CAME BACK FROM SITE, AND WHAT IT COST, in one place with one Save.
 *
 * The old sheet asked for a visit date, an outcome and six installer names, and got none of them:
 * 0 of 120 visits carry a status. Meanwhile the thing this screen is actually for - working out
 * what a return trip cost and writing it up - was being done on paper. So the fields nobody filled
 * in are gone and a CALCULATOR takes their place.
 *
 * THE CALCULATOR NEVER INVENTS A RATE. Visits and alterations come from adjustment_rate_card
 * through fn_ops_rate_for, remakes from remake_rate_card through v_ops_order_curtains, and the two
 * free lines - materials and transport - are typed because nobody has a rate for them (vehicle hire
 * goes by distance and only the office sets that figure). Every part is shown with its own working,
 * so the total can be checked rather than trusted.
 *
 * IT PRODUCES A SENTENCE, NOT JUST A NUMBER. The breakdown is written out in words into the comment
 * box, ready to paste into Slack, and the same text becomes the adjustment's reason - which is what
 * invoice_lines.adjustment_needs_comment demands and what an accountant reads three weeks later.
 *
 * Opened from a visit row it is that visit's editor and the visit half cannot be switched off.
 */
async function openWorkSheet(r, v, reload, opts = {}) {
  const editing = !!v.id;
  /* Ten is the ceiling: order_visits.visit_no is capped there and v_order_status_wide pivots
   * exactly 1..10. Rather than refusing the whole sheet - which would also refuse the charge, and
   * an order on its eleventh problem is exactly the one with money on it - the visit half is
   * switched off and locked, and the charge half still works. */
  const visitFull = !!opts.visitFull;
  const chargeVisitNo = Math.min(10, (visitFull ? (r.last_visit_no || 1) : v.visit_no) || 1);

  /* Everything the calculator prices with, fetched before the sheet is drawn rather than after -
   * a rate arriving late would mean a total that changes under somebody's hand. */
  loading(true, tr("t.loading"));
  const q = encodeURIComponent(r.order_id);
  let curtains = [], remakeRates = [], visitRate = 0, altRate = 0, adjAlt = null, card = [];
  try {
    const d = today();
    const [cur, rates, vr, ar, stat, cardRows] = await Promise.all([
      api(`/rest/v1/v_ops_order_windows?select=window_name,first_line_no,line_no,description,style,layers,width_m,po_rate,remake_rate_per_layer,curtain_lines,priceable&order_id=eq.${q}&order=first_line_no`),
      api("/rest/v1/remake_rate_card?select=style,rate_aed_per_layer,label&order=style"),
      rpc("fn_ops_rate_for", { p_charge_type: "additional_visit", p_qty: 1 }),
      rpc("fn_ops_rate_for", { p_charge_type: "alteration", p_qty: 1 }),
      api(`/rest/v1/order_status?select=alteration_adj_1l,alteration_adj_2l&order_id=eq.${q}`),
      /* The card is read once for LABELS, UNITS and the figure shown beside an unticked box. The
       * money that reaches the total still comes from fn_ops_rate_for - see chargeAmount below.
       * Same split Finance's Propose amount uses: the card previews, the function decides. */
      api(`/rest/v1/adjustment_rate_card?select=charge_type,min_qty,max_qty,rate_aed,free_qty,unit,label`
        + `&active=is.true&effective_from=lte.${d}`
        + `&or=${encodeURIComponent(`(effective_to.is.null,effective_to.gte.${d})`)}`
        + `&order=charge_type,min_qty`),
    ]);
    curtains = cur || [];
    remakeRates = rates || [];
    /* rate_aed, NOT amount_aed. additional_visit is priced 'per visit', and fn_ops_rate_for returns
     * the flat rate for that unit whatever quantity it is asked about - so multiplying has to
     * happen here, against the unit rate, or three visits would price as one. */
    visitRate = Number(((Array.isArray(vr) ? vr[0] : vr) || {}).rate_aed || 0);
    altRate = Number(((Array.isArray(ar) ? ar[0] : ar) || {}).rate_aed || 0);
    adjAlt = (stat || [])[0] || null;
    card = cardRows || [];
  } catch (e) {
    loading(false);
    toast(e.message, "bad");
    return;
  }
  loading(false);

  const RATE_BY_STYLE = {};
  remakeRates.forEach((x) => { RATE_BY_STYLE[x.style] = x; });
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  /* EVERY WINDOW ON THE ORDER, not only the ones carrying a curtain that can be priced by width.
   * 100 windows in the book have no priceable line at all - they hold a tie back, a remote, a
   * velcro job - and leaving them out of the picker meant a window that had genuinely been reworked
   * could not be ticked. One with no width simply starts blank and asks for one.
   *
   * Style, layers and width all stay editable: a window can be remade in a different style from the
   * one it was sold in, and the width that matters for a remake is the width actually cut. */
  const rework = curtains.map((c) => ({
    line_no: c.line_no,
    window: c.window_name || c.description || `#${c.first_line_no}`,
    description: c.description || "",
    po_rate: Number(c.po_rate || 0),
    style: c.style || "other",
    layers: Number(c.layers || 1),
    width: Number(c.width_m || 0),
    priceable: c.priceable !== false,
    curtainLines: Number(c.curtain_lines || 0),
    on: false,
  }));

  /* THE TEN CHARGE TYPES AS TICK BOXES, and their shape derived from the card rather than from a
   * list somebody has to keep in step with it.
   *
   * additional_visit and alteration are deliberately absent: both already have a richer line above,
   * and a tick box cannot express a visit count or the 1-layer/2-layer split that does the doubling.
   * Two ways to add the same charge is two answers to one question.
   *
   * THREE SHAPES, because six of the ten cannot price from a bare tick:
   *   flat   - one band, per order/visit, rate above zero. Pickup, drop-off, scaffolding, tie backs.
   *   qty    - banded or per-metre. Removal prices 0 for 1-2 curtains and 300 for 8+; wire and
   *            trunking have three free metres. Ticking without a number would bill nothing, or
   *            bill ten metres as one.
   *   amount - the card carries rate 0 (furniture moving, other chargeable work), so there is no
   *            rate to apply and the figure has to be typed.
   */
  const CARD_BY_TYPE = {};
  card.forEach((c) => { (CARD_BY_TYPE[c.charge_type] = CARD_BY_TYPE[c.charge_type] || []).push(c); });

  const shapeOf = (type) => {
    const bands = CARD_BY_TYPE[type] || [];
    if (!bands.length) return { kind: "amount" };
    const maxRate = Math.max(...bands.map((b) => Number(b.rate_aed || 0)));
    if (maxRate === 0) return { kind: "amount", unit: bands[0].unit };
    // one band on a per-order/per-visit unit is the only genuinely flat case; removal has four
    // bands on 'per order' and is not flat at all
    if (bands.length === 1 && ["per order", "per visit"].includes(bands[0].unit)) {
      return { kind: "flat", rate: Number(bands[0].rate_aed), unit: bands[0].unit };
    }
    /* A BANDED type carries its rates as a RANGE, not as bands[0]. Removal's first band is 1-2
     * curtains at zero, and printing that beside the box reads as "removal is free" when it runs
     * to 300 at eight. The range says what it actually is: it depends on the number. */
    const rates = bands.map((b) => Number(b.rate_aed || 0));
    return { kind: "qty", unit: bands[0].unit, rate: Number(bands[0].rate_aed),
             banded: bands.length > 1, lo: Math.min(...rates), hi: Math.max(...rates),
             free: Number(bands[0].free_qty || 0) };
  };

  const charges = CHARGE_TYPES
    .filter((c) => c.value !== "additional_visit" && c.value !== "alteration")
    .map((c) => ({ type: c.value, key: c.key, shape: shapeOf(c.value), on: false, qty: 1, amount: 0 }));

  /* The amount a ticked row contributes. Asked of fn_ops_rate_for, never worked out here, so the
   * banding and the free-metre allowance stay in the one place that owns them. Cached per
   * (type, quantity) because ticking and re-ticking the same row should not re-ask. */
  const RATE_CACHE = {};
  async function chargeAmount(row) {
    if (row.shape.kind === "amount") return r2(row.qty);   // qty IS the typed amount here
    const k = `${row.type}|${row.qty}`;
    if (RATE_CACHE[k] === undefined) {
      try {
        const res = await rpc("fn_ops_rate_for", { p_charge_type: row.type, p_qty: row.qty || 1 });
        const got = Array.isArray(res) ? res[0] : res;
        RATE_CACHE[k] = got ? Number(got.amount_aed || 0) : 0;
      } catch (e) { RATE_CACHE[k] = 0; }
    }
    return RATE_CACHE[k];
  }

  const perLayer = (row) => (row.style === "other"
    ? row.po_rate
    : Number((RATE_BY_STYLE[row.style] || {}).rate_aed_per_layer || 0));
  const rowAmount = (row) => r2(perLayer(row) * row.layers * row.width);

  const styleOptions = (row) => {
    const opts = remakeRates.map((x) =>
      `<option value="${esc(x.style)}"${row.style === x.style ? " selected" : ""}>${esc(x.label)}</option>`);
    // a line that is not one of the three named styles keeps its own catalog rate as an option,
    // because a roller blind has no agreed remake figure and inventing one would be worse
    if (row.style === "other") {
      opts.unshift(`<option value="other" selected>${esc(tr("calc.fromOrder"))}</option>`);
    }
    return opts.join("");
  };

  const m = modal(`
    <h3>${esc(editing ? tr("st.visit", { n: v.visit_no }) : tr("st.addWork"))} — ${esc(orderLabel(r))}</h3>

    ${editing ? "" : `
      <label class="cbrow wtoggle">
        <input type="checkbox" name="dovisit"${visitFull ? " disabled" : " checked"}>
        <b>${esc(tr("st.recordVisit"))}</b>
        <span class="muted">${esc(tr("st.visit", { n: v.visit_no }))}</span>
      </label>
      ${visitFull ? `<div class="banner warn">${esc(tr("st.maxVisits"))}</div>` : ""}`}

    <div data-block="visit"${!editing && visitFull ? ' class="hidden"' : ""}>
      <div data-photos style="margin-top:12px"></div>
      ${v.visit_no >= 2 ? `<div class="banner info" style="margin-top:12px">
         ${esc(tr("chg.visit"))} — ${esc(tr("adj.new"))}</div>` : ""}
    </div>

    <div class="calcbox">
      <h4>${esc(tr("calc.title"))}</h4>

      <div class="calcrow">
        <label class="f">${esc(tr("calc.visits"))}</label>
        <input type="number" name="cvisits" min="0" step="1" value="0">
        <span class="muted">× ${esc(aed(visitRate))}</span>
        <b data-sub="visits">${esc(aed(0))}</b>
      </div>

      <!-- Entered as WINDOWS BY LAYER COUNT, not as a curtain total, so the doubling a two layer
           window carries happens here rather than in whoever is typing. The curtain count is shown
           between the inputs and the money, where it can be read back. These two are the ORDER's
           adjustment counts - they used to sit on the panel as well, which meant the same numbers
           were entered twice, a day apart, by the same person. -->
      <div class="calcrow calcalt">
        <label class="f">${esc(tr("st.altAdjustment"))}</label>
        <div class="altpair">
          <label>${esc(tr("calc.alt1L"))}
            <input type="number" name="calt1" min="0" step="1"
                   value="${esc(Number((adjAlt || {}).alteration_adj_1l || 0))}"></label>
          <label>${esc(tr("calc.alt2L"))}
            <input type="number" name="calt2" min="0" step="1"
                   value="${esc(Number((adjAlt || {}).alteration_adj_2l || 0))}"></label>
        </div>
        <span class="muted" data-altc></span>
        <b data-sub="alts"></b>
      </div>

      <!-- Below the alteration line, as asked. Each tick adds its own figure to the total; the
           ones that need a number reveal a box when ticked rather than carrying one all the time. -->
      <div class="calcsec">
        <div class="calcsech">${esc(tr("calc.extras"))}
          <b data-sub="charges">${esc(aed(0))}</b></div>
        ${charges.map((c, i) => `
          <div class="chrow" data-ch="${i}">
            <label class="chname"><input type="checkbox" data-chon="${i}">
              <span>${esc(tr(c.key))}</span></label>
            <span class="muted chhint">${
              c.shape.kind === "flat" ? esc(aed(c.shape.rate))
              : c.shape.kind === "qty"
                ? (c.shape.banded
                    ? esc(`${aed(c.shape.lo)} – ${aed(c.shape.hi)}`)
                    : esc(`${aed(c.shape.rate)} ${c.shape.unit}`))
                  + (c.shape.free ? esc(` · ${tr("calc.freeQty", { n: c.shape.free })}`) : "")
              : esc(tr("calc.typeAmount"))}</span>
            <input type="number" data-chqty="${i}" class="hidden" min="0" step="0.01"
                   inputmode="decimal" value="${c.shape.kind === "amount" ? "" : 1}"
                   aria-label="${esc(tr(c.key))}">
            <b data-chamt="${i}">${esc(aed(0))}</b>
          </div>`).join("")}
      </div>

      <div class="calcsec">
        <div class="calcsech">${esc(tr("calc.rework"))}
          <b data-sub="rework">${esc(aed(0))}</b></div>
        ${rework.length ? rework.map((row, i) => `
          <div class="rwrow${row.priceable ? "" : " nowidth"}" data-rw="${i}">
            <label class="rwname"><input type="checkbox" data-rwon="${i}">
              <span>${esc(row.window)}</span>
              ${!row.priceable ? `<i class="muted">${esc(tr("calc.notPriceable"))}</i>`
                : row.curtainLines > 1
                  ? `<i class="muted">${esc(tr("calc.manyCurtains", { n: row.curtainLines }))}</i>`
                  : ""}</label>
            <select data-rwstyle="${i}" aria-label="${esc(tr("calc.style"))}">${styleOptions(row)}</select>
            <select data-rwlayers="${i}" aria-label="${esc(tr("calc.layers"))}">
              <option value="1"${row.layers === 1 ? " selected" : ""}>1</option>
              <option value="2"${row.layers === 2 ? " selected" : ""}>2</option>
            </select>
            <input type="number" data-rwwidth="${i}" step="0.01" min="0" value="${esc(row.width)}"
                   aria-label="${esc(tr("calc.width"))}">
            <b data-rwamt="${i}">${esc(aed(rowAmount(row)))}</b>
          </div>`).join("")
        : `<div class="dnone">${esc(tr("calc.noWindows"))}</div>`}
      </div>

      <div class="calcrow">
        <label class="f">${esc(tr("calc.materials"))}</label>
        <input type="number" name="cmat" step="0.01" min="0" inputmode="decimal" placeholder="0">
        <span></span><b data-sub="mat">${esc(aed(0))}</b>
      </div>
      <div class="calcrow">
        <label class="f">${esc(tr("calc.transport"))}</label>
        <input type="number" name="ctrans" step="0.01" min="0" inputmode="decimal" placeholder="0">
        <span></span><b data-sub="trans">${esc(aed(0))}</b>
      </div>

      <!-- THE TOTAL IS THE CHARGE. There is no separate "Add a charge" form any more: it asked
           for the amount, the charge type and the visit all over again, in a different shape, next
           to a calculator that had already worked them out. Anything above zero is written as one
           adjustment on Save; zero writes none. -->
      <div class="calctotal">
        <label class="f">${esc(tr("calc.total"))}</label>
        <input type="number" name="ctotal" step="0.01" inputmode="decimal" value="0">
        <span class="muted hidden" data-edited>${esc(tr("calc.totalEdited"))}</span>
        <span class="muted" data-willcharge></span>
      </div>

    </div>

    <!-- ONE BOX. There were three, and all three held the same text: a Summary for Slack, a Reason
         on the charge, and a Kurtains comment, each auto-filled from the same calculation. Three
         copies of one sentence is three chances for them to disagree, and two of them to be edited
         by somebody who did not realise the other two existed. This is built from the calculation
         above, it can be edited or dictated, it is what Copy puts on the clipboard, it is saved
         with the order, and it is the charge's reason. -->
    <div class="commentbox">
      <div class="spread">
        <label class="f">${esc(tr("st.slack"))}</label>
        <div class="row" style="gap:6px">
          <button type="button" class="btn sm ghost hidden" data-regen>${esc(tr("calc.regen"))}</button>
          <button type="button" class="btn sm ghost" data-copy>${esc(tr("calc.copy"))}</button>
        </div>
      </div>
      ${micField(`<textarea name="wcomment" rows="6" class="summarybox"></textarea>`, "wcomment")}
      <div class="muted" style="margin-top:4px">${esc(tr("st.slackHint"))}</div>
    </div>

    <!-- WHY, several at once. One charge rarely has one cause - the client changed their mind AND
         the site was not ready - and picking the one that felt biggest lost the rest. What is
         ticked here is written to the charge AND spelled out in the comment below. -->
    <div class="rsnbox">
      <label class="f">${esc(tr("adj.reasonCode"))}</label>
      <div class="rsngrid">
        ${ADJ_REASONS.map((x) => `
          <label class="cbrow rsnpick"><input type="checkbox" data-rsn="${esc(x.value)}">
            <span>${esc(tr(x.key))}</span></label>`).join("")}
      </div>
      <div class="banner warn hidden" data-absorb style="margin-top:6px">${
        esc(tr("adj.absorbed"))}</div>
    </div>

    <!-- Where the ORDER now stands, which is not the same question as what this trip cost. -->
    <div style="margin-top:14px">
      <label class="f">${esc(tr("st.orderStatus"))}</label>
      ${selectHtml("wstatus", ORDER_STATUSES, "", tr("adj.statusKeep"))}
      ${r.status ? `<div class="muted" style="margin-top:4px">${
        esc(tr("col.status"))}: ${esc(r.status)}</div>` : ""}
    </div>

    <div id="werr" class="err hidden" style="margin-top:10px"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
    </div>`);

  const qs = (n) => m.sheet.querySelector(`[name="${n}"]`);
  const block = (n) => m.sheet.querySelector(`[data-block="${n}"]`);
  const errBox = m.sheet.querySelector("#werr");
  const doVisit = qs("dovisit");
  const visitOn = () => editing || (!!doVisit && doVisit.checked && !visitFull);

  let method = "typed";
  wireMics(m.sheet, (_t, mm) => { method = mm; });

  // Site photos belong to the visit that produced them.
  m.sheet.querySelector("[data-photos]").appendChild(photoStrip({
    context: "visit", context_id: v.id || null, order_id: r.order_id,
    context_label: tr("st.visit", { n: v.visit_no }),
  }));

  // a charge follows the visit it arose on, and there is no such visit if none is being recorded
  const chargeVisit = () => (visitOn() ? v.visit_no : (r.last_visit_no || 1)) || chargeVisitNo;
  if (doVisit) doVisit.addEventListener("change", () => {
    block("visit").classList.toggle("hidden", !doVisit.checked);
  });

  /* ---- the arithmetic, in one place, recomputed from the controls on every change */
  let totalEdited = false;      // typing in the Total box takes it off the calculator
  /* ...and touching the comment - typed OR dictated, since attachMic fires an input event - stops
   * it being rebuilt underneath them. The Rebuild button is how they ask for it back, so nothing
   * they wrote is ever silently replaced and nothing is ever stuck stale without a way out. */
  let commentEdited = false;
  // the alteration counts belong to the ORDER; they are only written back if somebody moved them
  let altTouched = false;

  const numOf = (n) => Number(qs(n).value || 0);
  // a 2 layer window is two curtains - the doubling lives here and nowhere else
  const altCurtains = () => numOf("calt1") + 2 * numOf("calt2");
  const parts = () => {
    const visits = r2(numOf("cvisits") * visitRate);
    const alts = r2(altCurtains() * altRate);
    const rw = rework.filter((x) => x.on).map((x) => ({ row: x, amount: rowAmount(x) }));
    const reworkTotal = r2(rw.reduce((a, x) => a + x.amount, 0));
    const ch = charges.filter((x) => x.on);
    const chargeTotal = r2(ch.reduce((a, x) => a + Number(x.amount || 0), 0));
    return { visits, alts, rw, reworkTotal, ch, chargeTotal,
             mat: r2(numOf("cmat")), trans: r2(numOf("ctrans")) };
  };
  const computed = () => {
    const p = parts();
    return r2(p.visits + p.alts + p.chargeTotal + p.reworkTotal + p.mat + p.trans);
  };
  const pickedReasons = () =>
    Array.from(m.sheet.querySelectorAll("[data-rsn]:checked")).map((c) => c.dataset.rsn);

  /* The whole sum in words, in the order it was worked out, so a coordinator can read it back to a
   * client and an accountant can check it later. This is the text that goes to Slack AND becomes
   * the adjustment's reason - one sentence, written once. */
  const buildSummary = () => {
    const p = parts();
    const out = [`${orderLabel(r)}`];
    if (p.visits) out.push(`${tr("calc.visits")}: ${num(numOf("cvisits"))} × ${aed(visitRate)} = ${aed(p.visits)}`);
    if (p.alts) out.push(`${tr("st.altAdjustment")}: ${num(altCurtains())} × ${aed(altRate)} = ${aed(p.alts)}`);
    p.ch.forEach((c) => {
      /* The quantity is only worth printing when it means something - a flat charge has none - and
       * the card's UNIT is not the quantity's unit: removal is priced "per order" but counted in
       * curtains, so "(6 per order)" reads as nonsense. Metres get an m; everything else is just
       * the number, which the charge name already qualifies. */
      const qtyPart = c.shape.kind === "qty"
        ? ` (${num(c.qty)}${c.shape.unit === "per metre" ? " m" : ""})` : "";
      out.push(`${tr(c.key)}${qtyPart}: ${aed(c.amount)}`);
    });
    p.rw.forEach(({ row, amount }) => {
      const label = (RATE_BY_STYLE[row.style] || {}).label || tr("calc.fromOrder");
      /* The rate printed here is the per-layer rate TIMES THE LAYERS, not the per-layer rate on its
       * own, so the line multiplies out to the amount beside it. Printing 51 against an amount of
       * 187.68 invites the reader to check 1.84 x 51, get 93.84, and conclude the total is wrong.
       * Width keeps two decimals for the same reason - num() rounds to one, and 1.84 m shown as
       * 1.8 m does not reproduce the figure either. */
      out.push(`${tr("calc.rework")}: ${row.window} (${label} L${row.layers}) `
             + `${row.width.toFixed(2)} m × ${aed(perLayer(row) * row.layers)} ${tr("calc.perM")}`
             + ` = ${aed(amount)}`);
    });
    if (p.mat) out.push(`${tr("calc.materials")}: ${aed(p.mat)}`);
    if (p.trans) out.push(`${tr("calc.transport")}: ${aed(p.trans)}`);
    out.push(`${tr("calc.total")}: ${aed(totalEdited ? numOf("ctotal") : computed())}`);
    const why = pickedReasons();
    if (why.length) {
      out.push(`${tr("adj.reasonCode")}: ${why
        .map((x) => tr((ADJ_REASONS.find((y) => y.value === x) || {}).key || "rsn.other"))
        .join(", ")}`);
    }
    return out.join("\n");
  };

  const paintCalc = () => {
    const p = parts();
    const set = (k, val) => { m.sheet.querySelector(`[data-sub="${k}"]`).textContent = aed(val); };
    set("visits", p.visits); set("alts", p.alts); set("rework", p.reworkTotal);
    set("mat", p.mat); set("trans", p.trans); set("charges", p.chargeTotal);
    charges.forEach((c, i) => {
      m.sheet.querySelector(`[data-chamt="${i}"]`).textContent = aed(c.on ? c.amount : 0);
    });
    m.sheet.querySelector("[data-altc]").textContent =
      `${tr("st.altCurtains", { n: altCurtains() })} × ${aed(altRate)}`;
    rework.forEach((row, i) => {
      m.sheet.querySelector(`[data-rwamt="${i}"]`).textContent = aed(rowAmount(row));
    });
    if (!totalEdited) qs("ctotal").value = computed().toFixed(2);
    m.sheet.querySelector("[data-edited]").classList.toggle("hidden", !totalEdited);
    if (!commentEdited) qs("wcomment").value = buildSummary();
    m.sheet.querySelector("[data-regen]").classList.toggle("hidden", !commentEdited);
    // said out loud, because a total above zero now writes a charge with no further tick
    const t = Number(qs("ctotal").value || 0);
    m.sheet.querySelector("[data-willcharge]").textContent =
      t > 0 ? tr("calc.willCharge", { n: aed(t) }) : tr("calc.noCharge");
  };

  ["cvisits", "calt1", "calt2", "cmat", "ctrans"].forEach((n) =>
    qs(n).addEventListener("input", paintCalc));
  ["calt1", "calt2"].forEach((n) => qs(n).addEventListener("input", () => { altTouched = true; }));
  qs("ctotal").addEventListener("input", () => { totalEdited = true; paintCalc(); });
  qs("wcomment").addEventListener("input", () => {
    commentEdited = true;
    m.sheet.querySelector("[data-regen]").classList.remove("hidden");
  });
  /* Three of the eleven causes mean the work is ours to put right and is normally absorbed at zero.
   * The banner shows if ANY ticked cause is one of them. Said, not enforced: a coordinator who has
   * agreed a figure with a client outranks a rule of thumb. */
  m.sheet.querySelectorAll("[data-rsn]").forEach((cb) => cb.addEventListener("change", () => {
    const ours = pickedReasons()
      .some((x) => (ADJ_REASONS.find((y) => y.value === x) || {}).charged === false);
    m.sheet.querySelector("[data-absorb]").classList.toggle("hidden", !ours);
    paintCalc();          // the causes are part of the sentence the comment is built from
  }));

  /* Ticking asks the rate card what it costs; the quantity box only appears for the rows that
   * need one, and for a rate-0 type the box IS the amount. */
  charges.forEach((c, i) => {
    const box = m.sheet.querySelector(`[data-ch="${i}"]`);
    const qty = m.sheet.querySelector(`[data-chqty="${i}"]`);
    const refresh = async () => {
      c.amount = c.on ? await chargeAmount(c) : 0;
      paintCalc();
    };
    m.sheet.querySelector(`[data-chon="${i}"]`).addEventListener("change", async (e) => {
      c.on = e.target.checked;
      box.classList.toggle("on", c.on);
      qty.classList.toggle("hidden", !c.on || c.shape.kind === "flat");
      await refresh();
    });
    qty.addEventListener("change", async () => {
      c.qty = Number(qty.value || 0);
      await refresh();
    });
  });
  m.sheet.querySelector("[data-regen]").addEventListener("click", () => {
    commentEdited = false;
    paintCalc();
  });

  rework.forEach((row, i) => {
    m.sheet.querySelector(`[data-rwon="${i}"]`).addEventListener("change", (e) => {
      row.on = e.target.checked;
      m.sheet.querySelector(`[data-rw="${i}"]`).classList.toggle("on", row.on);
      paintCalc();
    });
    m.sheet.querySelector(`[data-rwstyle="${i}"]`).addEventListener("change", (e) => {
      row.style = e.target.value; paintCalc();
    });
    m.sheet.querySelector(`[data-rwlayers="${i}"]`).addEventListener("change", (e) => {
      row.layers = Number(e.target.value) || 1; paintCalc();
    });
    m.sheet.querySelector(`[data-rwwidth="${i}"]`).addEventListener("input", (e) => {
      row.width = Number(e.target.value) || 0; paintCalc();
    });
  });

  m.sheet.querySelector("[data-copy]").addEventListener("click", () => {
    copyText(qs("wcomment").value);
    toast(tr("calc.copied"), "ok");
  });

  /* Which charge type the single adjustment carries: whichever part was biggest - the same rule
   * Chotu is given for an adjustment made of several parts. Now that the ten types are tick boxes
   * this can name the actual one rather than falling back to 'other' for everything that was not a
   * visit or an alteration. */
  const biggestType = () => {
    const p = parts();
    const cands = [
      { t: "additional_visit", v: p.visits },
      { t: "alteration", v: p.alts },
      { t: "other", v: p.reworkTotal + p.mat + p.trans },
      ...p.ch.map((c) => ({ t: c.type, v: Number(c.amount || 0) })),
    ].sort((a, b) => b.v - a.v)[0];
    return cands && cands.v > 0 ? cands.t : "other";
  };

  paintCalc();

  const wStatus = qs("wstatus");

  m.sheet.querySelector("[data-no]").onclick = m.close;
  m.sheet.querySelector("[data-yes]").onclick = async () => {
    const wantVisit = visitOn();
    // the calculator IS the charge - anything above zero is written, nothing below it
    const wantCharge = Number(qs("ctotal").value || 0) > 0;
    const newStatus = wStatus.value || null;
    const comment = qs("wcomment").value.trim() || null;
    const fail = (msg) => {
      errBox.textContent = msg;
      errBox.classList.remove("hidden");
    };

    /* The alteration counts belong to the ORDER, not to the charge, so they are written whether or
     * not a charge is captured - and only when somebody moved them. Sending them unchanged would
     * still count as "counts were sent" to fn_ops_save_visit, which re-derives the alteration flag
     * off values nobody touched. */
    const altPayload = () => (altTouched
      ? { alteration_adj_1l: numOf("calt1"), alteration_adj_2l: numOf("calt2") } : {});

    if (!wantVisit && !wantCharge && !newStatus && !comment && !altTouched) {
      fail(tr("st.nothingToSave")); return;
    }

    /* The comment IS the reason. invoice_lines.adjustment_needs_comment rejects a blank
     * justification downstream, so an empty box with a charge on it is stopped here rather than
     * discovered at invoicing time. */
    if (wantCharge && !comment) { fail(tr("adj.reasonRequired")); return; }
    m.close();

    /* THE CHARGE GOES FIRST, and the order is load-bearing. fn_ops_save_visit auto-proposes an
     * additional_visit charge on visit 2 and later, and it skips that only when a charge of that
     * type already exists for the visit. Writing an explicit revisit charge first is what stops a
     * hand-entered one and an auto-proposed one both landing on the same visit. */
    if (wantCharge) {
      const why = pickedReasons();
      await submit("fn_ops_add_adjustment", {
        p_order_id: r.order_id,
        p_charge_type: biggestType(),
        p_reason: comment,
        p_quantity: 1,
        p_visit_no: chargeVisit(),
        // Every adjustment captured here is a charge. Whether it is actually billed is decided
        // afterwards, on the row itself, by Confirm or Do not charge.
        p_chargeable: true,
        p_amount: Number(qs("ctotal").value || 0),
        p_actor: currentActor(),
        p_window_name: null,
        p_notes: null,
        p_status: "new",
        // an empty pick is nobody having said, which fn_ops_add_adjustment stores as null
        p_reason_codes: why.length ? why : null,
      });
    }

    if (wantVisit) {
      await submit("fn_ops_save_visit", {
        p_order_id: r.order_id,
        p_visit_no: v.visit_no,
        p_payload: {
          // one comment box now, and it goes to the Kurtains channel
          ...(comment ? { slack_comment: comment } : {}),
          ...altPayload(),
          // absent rather than null when nothing was picked - see fn_ops_save_visit, which coalesces
          // an absent key against the stored value
          ...(newStatus ? { status: newStatus } : {}),
          input_method: method, lang: getLang(),
        },
        p_actor: currentActor(),
      });
    } else if (newStatus || comment) {
      /* No visit being recorded, so this is written against the LAST one - fn_ops_save_visit
       * upserts an order_visits row, and pointing it at a visit that has not happened would invent
       * one. skip_visit_charge because the only charge here is the one just captured, if any. */
      await submit("fn_ops_save_visit", {
        p_order_id: r.order_id,
        p_visit_no: Math.max(1, r.last_visit_no || 1),
        p_payload: {
          ...(comment ? { slack_comment: comment } : {}),
          ...(newStatus ? { status: newStatus } : {}),
          ...altPayload(),
          input_method: method, lang: getLang(), skip_visit_charge: true,
        },
        p_actor: currentActor(),
      });
    }

    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
    reload();
  };
}

/* ---------------------------------------------------------------- adjustments */
function adjustmentsSection(r, rows, reload) {
  const box = el(`
    <div class="dsec">
      <h4>${esc(tr("adj.title"))} <span class="chip mute">${rows.length}</span></h4>
    </div>`);

  if (!rows.length) box.appendChild(el(`<div class="dnone">${esc(tr("d.none"))}</div>`));

  rows.forEach((a) => {
    const stat = ADJ_STATUSES.find((s) => s.value === a.status) || { tone: "mute" };
    const amt = a.agreed_amount_aed ?? a.suggested_amount_aed;
    const row = el(`
      <div class="unit">
        <div class="uname">${esc(tv(CHARGE_TYPES, a.charge_type))}
          ${a.source === "auto" ? chip(tr("adj.auto"), "mute") : ""}
          ${!a.chargeable ? chip(tr("adj.dropped"), "mute") : ""}
          <div class="usub">${esc(a.reason || "")}
            ${a.visit_no ? " · " + esc(tr("st.visit", { n: a.visit_no })) : ""}
            ${Number(a.quantity) > 1 ? " · ×" + esc(num(a.quantity)) : ""}
            ${a.rate_drift ? " · " + esc(tr("adj.drift", { n: num(a.card_rate_aed) })) : ""}</div>
        </div>
        <div><b>${esc(aed(amt))}</b> ${chip(tv(ADJ_STATUSES, a.status), stat.tone)}</div>
        <!-- per-adjustment amounts stay: they are the charge itself, not an order-level money total -->
        <div class="cell-actions row">
          ${a.status === "new" ? `<button class="btn sm primary" data-ok>${esc(tr("adj.confirm"))}</button>
             <button class="btn sm ghost" data-drop>${esc(tr("adj.drop"))}</button>` : ""}
        </div>
      </div>`);

    // A photo of the extra work is the evidence behind the charge when the client queries the invoice.
    row.appendChild(photoStrip({
      context: "adjustment", context_id: a.id, order_id: r.order_id,
      context_label: `${a.charge_type} — ${a.reason || ""}`.trim(),
    }));

    const ok = row.querySelector("[data-ok]");
    if (ok) ok.addEventListener("click", async () => {
      await api(`/rest/v1/accounting_alerts?id=eq.${a.id}`, {
        method: "PATCH", body: JSON.stringify({ status: "reviewed" }),
      });
      await rpc("fn_ops_recalc_adjustments", { p_order_id: r.order_id });
      toast(tr("t.saved"), "ok"); reload();
    });
    const drop = row.querySelector("[data-drop]");
    if (drop) drop.addEventListener("click", async () => {
      await api(`/rest/v1/accounting_alerts?id=eq.${a.id}`, {
        method: "PATCH", body: JSON.stringify({ status: "dropped", chargeable: false }),
      });
      await rpc("fn_ops_recalc_adjustments", { p_order_id: r.order_id });
      toast(tr("t.saved"), "ok"); reload();
    });
    box.appendChild(row);
  });

  // Money totals were removed from this module - they belong in the management view - and so is
  // Build draft invoice: invoicing is an accounts decision made over a whole order, not something
  // to trigger from the middle of a coordinator's status panel. fn_ops_build_invoice still exists.
  //
  // The Add button that used to sit here has moved below the section, because it now adds a visit
  // as readily as a charge and belonged to neither list - see the one that follows both.
  return box;
}
