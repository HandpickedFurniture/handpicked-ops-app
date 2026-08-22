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
  ORDER_STATUSES, STATUS_TONE, CHARGE_TYPES, ADJ_STATUSES, TRANSFER_STATUSES, SPECIAL_COLS,
} from "./config.js";
import {
  $, esc, el, chip, aed, num, fmtDate, toast, loading, modal, selectHtml, orderLabel,
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
let MEMBERS = null;   // the installer name list behind the six per-visit dropdowns

async function loadMembers(force) {
  if (MEMBERS && !force) return MEMBERS;
  try {
    // sorted case-insensitively: the seed list mixes AJISH and Hafis, and a plain sort would put
    // every capitalised name above every mixed-case one
    const rows = await api("/rest/v1/team_members?select=id,name&active=is.true");
    MEMBERS = rows.map((r) => r.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  } catch (e) { MEMBERS = []; }
  return MEMBERS;
}

export async function render(mount, state, setFilters) {
  if (!isSignedIn()) return;
  mount.innerHTML = `<div class="sectionbar"><span></span><span id="stsync"></span></div>
                     <div id="fbar"></div><div id="extra"></div><div id="board"></div>`;
  $("#stsync", mount).appendChild(syncBar());

  await loadMembers();
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
  try {
    /* The readiness counts are NOT on v_ops_status_board - that view carries production_state and
     * the special-requirement columns but none of the receiving or prep tallies - so they are read
     * here, on expand, from the views that do have them. Five requests in one Promise.all is one
     * round trip, and only for the order somebody actually opened. */
    let rosterRows;
    [visits, adjustments, rosterRows, rails, units, stacked] = await Promise.all([
      api(`/rest/v1/order_visits?select=*&order_id=eq.${q}&order=visit_no`),
      api(`/rest/v1/v_ops_adjustments?select=*&order_id=eq.${q}&order=id`),
      api(`/rest/v1/v_ops_order_roster?select=recv_fab_done,recv_fab_total,recv_mat_done,recv_mat_total,prep_done,prep_total&order_id=eq.${q}`),
      api(`/rest/v1/v_ops_report_railing?select=line_id,rail_done&order_id=eq.${q}`),
      api(`/rest/v1/v_ops_prep_units?select=window_name,layer_no&order_id=eq.${q}`),
      api(`/rest/v1/v_ops_prep_locations?select=window_name,layer_no&order_id=eq.${q}`),
    ]);
    roster = (rosterRows || [])[0] || null;
  } catch (e) {
    host.innerHTML = `<div class="drawer"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }

  const wrap = el(`<div class="drawer"></div>`);

  /* ---- what is and is not ready, before anything else in the panel */
  wrap.appendChild(readinessSection(r, roster, rails, units, stacked));

  /* ---- order level */
  const orderBox = el(`
    <div class="dsec">
      <h4>${esc(tr("st.orderStatus"))}</h4>
      <div class="grid3">
        <div><label class="f">${esc(tr("col.status"))}</label>
          ${selectHtml("ostatus", ORDER_STATUSES, r.status || "", tr("f.any"))}</div>
        <!-- Yes/No rather than "—"/"Alteration": the old pair read as "unset" vs "set", so a
             deliberate No looked identical to never having been asked. -->
        <div><label class="f">${esc(tr("st.alteration"))}</label>
          <select name="oalteration">
            <option value="false"${!r.alteration ? " selected" : ""}>${esc(tr("t.no"))}</option>
            <option value="true"${r.alteration ? " selected" : ""}>${esc(tr("t.yes"))}</option>
          </select></div>
        <div><label class="f">${esc(tr("st.removalCount"))}</label>
          <input type="number" name="oremoval" min="0" step="1"
                 value="${esc(r.removal_curtain_count ?? "")}"></div>
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

  // Removal count drives the banded removal charge, so offer it right where it is entered.
  const remIn = orderBox.querySelector('[name="oremoval"]');
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
        status: orderBox.querySelector('[name="ostatus"]').value || null,
        alteration: orderBox.querySelector('[name="oalteration"]').value === "true",
        alteration_special_requirement: orderBox.querySelector('[name="oaltnote"]').value || null,
        removal_curtain_count: orderBox.querySelector('[name="oremoval"]').value || null,
        comment: orderBox.querySelector('[name="ocomment"]').value || null,
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

  const nextNo = (visits.length ? Math.max(...visits.map((v) => v.visit_no)) : 0) + 1;
  const addBtn = el(`<button class="btn sm" data-addvisit>+ ${esc(tr("st.addVisit"))}</button>`);
  addBtn.addEventListener("click", () => {
    // order_visits.visit_no is capped at 10 and v_order_status_wide pivots exactly 1..10, so block
    // it here with a clear message rather than letting Postgres throw
    if (nextNo > 10) { toast(tr("st.maxVisits"), "bad"); return; }
    openVisitSheet(r, { visit_no: nextNo }, reload);
  });
  vBox.appendChild(addBtn);
  wrap.appendChild(vBox);

  /* ---- adjustments */
  wrap.appendChild(adjustmentsSection(r, adjustments, reload));

  /* ---- links out to the modules that own the physical goods */
  wrap.appendChild(el(`
    <div class="dsec">
      <h4>${esc(tr("inv.linked"))}</h4>
      <div class="row">
        <a class="btn sm" href="#/transfer?order=${encodeURIComponent(r.order_id)}">
          ${esc(tr("tr.title"))}${r.transfer_status
            ? " — " + esc(tv(TRANSFER_STATUSES, r.transfer_status)) : ""}</a>
        <a class="btn sm" href="#/inventory">${esc(tr("inv.viewStock"))}</a>
        <a class="btn sm" href="#/audit?order=${encodeURIComponent(r.order_id)}">
          ${esc(tr("audit.title"))}${r.photo_count ? " (" + esc(r.photo_count) + ")" : ""}</a>
      </div>
    </div>`));

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
  row.querySelector("[data-edit]").addEventListener("click", () => openVisitSheet(r, v, reload));
  return row;
}

/* One of six slots. Dropdowns rather than free text so "IKBAL", "Ikbal" and "ikbal " do not become
 * three different installers; the "+ New name" option keeps a new hire from blocking the visit. */
function memberSelect(i, current) {
  const opts = (MEMBERS || []).map((n) =>
    `<option value="${esc(n)}"${n === current ? " selected" : ""}>${esc(n)}</option>`).join("");
  return `<select name="vm${i}" aria-label="${esc(tr("st.member", { n: i + 1 }))}">
    <option value="">${esc(tr("st.memberNone"))}</option>
    ${opts}
    <option value="__new__">${esc(tr("st.newMember"))}</option>
  </select>`;
}

/* Wires the "+ New name" sentinel on every member dropdown in a container. */
function wireMemberSelects(root) {
  root.querySelectorAll('select[name^="vm"]').forEach((sel) => {
    sel.addEventListener("change", async () => {
      if (sel.value !== "__new__") return;
      sel.value = "";
      const name = (prompt(tr("st.addMember")) || "").trim();
      if (!name) return;
      try {
        await api("/rest/v1/team_members", {
          method: "POST",
          body: JSON.stringify({ name, created_by: currentActor() }),
        });
      } catch (e) {
        // a duplicate is fine - the name already exists, just select it
        if (!/duplicate|unique/i.test(rawMessage(e))) { toast(e.message, "bad"); return; }
      }
      await loadMembers(true);
      root.querySelectorAll('select[name^="vm"]').forEach((s) => {
        const keep = s.value;
        s.innerHTML = memberSelect(0, keep).replace(/^<select[^>]*>|<\/select>$/g, "");
        s.value = keep;
      });
      sel.value = name;
      toast(tr("st.memberAdded"), "ok");
    });
  });
}

function openVisitSheet(r, v, reload) {
  const m = modal(`
    <h3>${esc(tr("st.visit", { n: v.visit_no }))} — ${esc(orderLabel(r))}</h3>
    <!-- Time and team are gone from here: the Schedule board owns both, and a second place to set
         them was a second answer to the same question. Neither key is sent, so what Schedule wrote
         survives - fn_ops_save_visit coalesces an absent key against the stored value. -->
    <div class="grid2" style="margin-top:12px">
      <div><label class="f">${esc(tr("st.visitDate"))}</label>
        <input type="date" name="vdate" value="${esc(v.visit_date || "")}"></div>
      <div><label class="f">${esc(tr("st.visitStatus"))}</label>
        ${selectHtml("vstatus", ORDER_STATUSES, v.status || "", tr("f.any"))}</div>
    </div>
    <div style="margin-top:12px">
      <label class="f">${esc(tr("st.members"))}</label>
      <div class="memgrid">
        ${[0, 1, 2, 3, 4, 5].map((i) => memberSelect(i, (v.member_names || [])[i])).join("")}
      </div>
    </div>
    <div style="margin-top:10px">
      <label class="f">${esc(tr("st.internal"))}</label>
      ${micField(`<textarea name="vcomment">${esc(v.comment || "")}</textarea>`, "vcomment")}
    </div>
    <div style="margin-top:10px">
      <label class="f">${esc(tr("st.slack"))}</label>
      ${micField(`<textarea name="vslack"></textarea>`, "vslack")}
      <div class="muted" style="margin-top:4px">${esc(tr("st.slackHint"))}</div>
    </div>
    <div data-photos style="margin-top:12px"></div>
    ${v.visit_no >= 2 ? `<div class="banner info" style="margin-top:12px">
       ${esc(tr("chg.visit"))} — ${esc(tr("adj.new"))}</div>` : ""}
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
    </div>`);

  let method = "typed";
  wireMics(m.sheet, (_t, mm) => { method = mm; });
  wireMemberSelects(m.sheet);

  // Site photos belong to the visit that produced them.
  m.sheet.querySelector("[data-photos]").appendChild(photoStrip({
    context: "visit", context_id: v.id || null, order_id: r.order_id,
    context_label: tr("st.visit", { n: v.visit_no }),
  }));

  m.sheet.querySelector("[data-no]").onclick = m.close;
  m.sheet.querySelector("[data-yes]").onclick = async () => {
    const g = (n) => m.sheet.querySelector(`[name="${n}"]`).value || null;
    m.close();
    await submit("fn_ops_save_visit", {
      p_order_id: r.order_id,
      p_visit_no: v.visit_no,
      p_payload: {
        visit_date: g("vdate"),
        visit_status: g("vstatus"),
        visit_comment: g("vcomment"), internal_comment: g("vcomment"),
        slack_comment: g("vslack"),
        // de-duplicated and blanks dropped, so six slots can be filled in any order
        member_names: Array.from(new Set([0, 1, 2, 3, 4, 5]
          .map((i) => m.sheet.querySelector(`[name="vm${i}"]`).value.trim())
          .filter((x) => x && x !== "__new__"))),
        input_method: method, lang: getLang(),
      },
      p_actor: currentActor(),
    });
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
  const actions = el(`
    <div class="row" style="margin-top:8px">
      <button class="btn sm accent" data-add>+ ${esc(tr("adj.add"))}</button>
    </div>`);

  actions.querySelector("[data-add]").addEventListener("click",
    () => openAdjustmentSheet(r, reload));

  box.appendChild(actions);
  return box;
}

function openAdjustmentSheet(r, reload) {
  const m = modal(`
    <h3>${esc(tr("adj.add"))} — ${esc(orderLabel(r))}</h3>
    <div class="grid2" style="margin-top:12px">
      <div><label class="f">${esc(tr("adj.type"))}</label>
        ${selectHtml("atype", CHARGE_TYPES.map((c) => ({ value: c.value, label: tr(c.key) })),
                     "additional_visit")}</div>
      <div><label class="f">${esc(tr("adj.qty"))}</label>
        <input type="number" name="aqty" value="1" min="1" step="1"></div>
      <div><label class="f">${esc(tr("adj.amount"))}</label>
        <input type="number" name="aamt" step="0.01" inputmode="decimal">
        <div class="muted" data-rate style="margin-top:4px"></div></div>
      <div><label class="f">${esc(tr("st.visit"), { n: "" })}</label>
        <input type="number" name="avisit" min="1" max="10" step="1"
               value="${esc(r.last_visit_no || 1)}"></div>
    </div>
    <div style="margin-top:10px">
      <label class="f">${esc(tr("adj.reason"))}</label>
      ${micField(`<textarea name="areason"></textarea>`, "areason")}
      <div class="muted" style="margin-top:4px">${esc(tr("adj.reasonRequired"))}</div>
    </div>
    <!-- The outcome of the trip, recorded WITH the charge rather than after it. An adjustment is
         almost always somebody reporting back from site, and what they report is two things: what
         happened, and what it cost. Making them save here and then scroll up to the order-status
         box was two saves for one visit, and the second one is the one that got forgotten. Blank
         leaves the status exactly as it is - see fn_ops_save_visit, which coalesces an absent
         key against the stored value. -->
    <div style="margin-top:10px">
      <label class="f">${esc(tr("st.orderStatus"))}</label>
      ${selectHtml("astatus", ORDER_STATUSES, "", tr("adj.statusKeep"))}
      ${r.status ? `<div class="muted" style="margin-top:4px">${
        esc(tr("col.status"))}: ${esc(r.status)}</div>` : ""}
    </div>
    <div id="aerr" class="err hidden" style="margin-top:10px"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
    </div>`);

  wireMics(m.sheet);
  const typeSel = m.sheet.querySelector('[name="atype"]');
  const qtyIn = m.sheet.querySelector('[name="aqty"]');
  const amtIn = m.sheet.querySelector('[name="aamt"]');
  const rateLbl = m.sheet.querySelector("[data-rate]");

  // Pre-fill from the rate card. Band-aware, so removing 4 curtains prices at 100 and 2 at 0.
  async function refreshRate() {
    try {
      const res = await rpc("fn_ops_rate_for", {
        p_charge_type: typeSel.value, p_qty: Number(qtyIn.value || 1),
      });
      const row = Array.isArray(res) ? res[0] : res;
      if (row) {
        amtIn.value = Number(row.amount_aed).toFixed(2);
        rateLbl.textContent = `${tr("adj.suggested")}: ${row.label} — ${aed(row.amount_aed)}`;
      } else {
        rateLbl.textContent = "";
      }
    } catch (e) { rateLbl.textContent = ""; }
  }
  typeSel.addEventListener("change", refreshRate);
  qtyIn.addEventListener("change", refreshRate);
  refreshRate();

  m.sheet.querySelector("[data-no]").onclick = m.close;
  m.sheet.querySelector("[data-yes]").onclick = async () => {
    const reason = m.sheet.querySelector('[name="areason"]').value.trim();
    const errBox = m.sheet.querySelector("#aerr");
    // invoice_lines.adjustment_needs_comment rejects a blank justification downstream; catching it
    // here is far better than discovering it at invoicing time
    if (!reason) {
      errBox.textContent = tr("adj.reasonRequired");
      errBox.classList.remove("hidden");
      return;
    }
    const newStatus = m.sheet.querySelector('[name="astatus"]').value;
    m.close();
    await submit("fn_ops_add_adjustment", {
      p_order_id: r.order_id,
      p_charge_type: typeSel.value,
      p_reason: reason,
      p_quantity: Number(qtyIn.value || 1),
      p_visit_no: Number(m.sheet.querySelector('[name="avisit"]').value) || null,
      // Every adjustment captured here is a charge. Whether it is actually billed is decided
      // afterwards, on the row itself, by Confirm or Do not charge - one decision in one place
      // rather than a dropdown at capture time that quietly disagreed with those two buttons.
      p_chargeable: true,
      p_amount: amtIn.value === "" ? null : Number(amtIn.value),
      p_actor: currentActor(),
      p_window_name: null,
      p_notes: null,
      p_status: "new",
    });

    /* The second half of the same report, queued behind the first so both survive a lift. The
     * visit number is the LAST RECORDED one, never the one typed against the charge: this write
     * upserts an order_visits row, and pointing it at a visit that has not happened yet would
     * invent one. skip_visit_charge for the same reason the order-level save sets it - the
     * charge is the one just captured, not a second auto-proposed revisit. */
    if (newStatus) {
      await submit("fn_ops_save_visit", {
        p_order_id: r.order_id,
        p_visit_no: Math.max(1, r.last_visit_no || 1),
        p_payload: {
          status: newStatus,
          input_method: "typed", lang: getLang(),
          skip_visit_charge: true,
        },
        p_actor: currentActor(),
      });
    }
    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
    reload();
  };
}
