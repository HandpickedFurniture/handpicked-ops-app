/* Preparation - the workshop's own screen, and now a tab of its own rather than a sub-tab of
 * Production.
 *
 * It answers three questions and deliberately nothing else:
 *
 *   1. WHERE IS IT?          floor / rack / shelf / zone, per window and layer. An order does not
 *                            have to go to one place: pick some windows, give them a location, pick
 *                            the rest, give them another. That is why the location is written
 *                            against the unit rather than the order.
 *   2. HAS THE SPECIAL       the motors, remotes, roller blinds, cassettes and pull-cord tracks that
 *      STUFF ARRIVED?        arrive separately from the fabric. Ticking one here is the SAME write
 *                            the order drawer's Materials tab makes - one vocabulary, two doors.
 *   3. ARE THE RAILS DONE?   the cut list for this order, ticked line by line.
 *
 * It used to open the eight-tab order drawer, which is the production coordinator's tool, not the
 * floor's: somebody holding a folded curtain does not want Emails and Photo audit. The stage ladder
 * (Started / Packed / Stacking) stays, because the roster and the Production report are built on it,
 * but it is now the chip row at the top and a bulk action, not a thing to hunt for.
 */
import { api, apiAll, isSignedIn, submit, currentActor, queueDepth, isViewer } from "./api.js";
import { tr, tv } from "./i18n.js";
import {
  PREP_STAGES, PAGE_SIZE, STACK_FLOORS, STACK_RACKS, STACK_SHELVES, STACK_ZONES,
  RECV_STATUSES, bucketOf,
} from "./config.js";
import {
  $, esc, el, chip, num, fmtDate, toast, loading, progressBar, modal, selectHtml, confirmSheet,
} from "./ui.js";
import { renderFilterBar, toQuery, deriveOptions, activeCount } from "./filters.js";
import { syncBar } from "./sync.js";

const CAPS = { fabstatus: true, prodstate: true };

const COLS = [
  "order_id", "customer_name", "city", "installation_date", "date_bucket", "window_count",
  "report_meters", "meters_is_received", "prep_total", "prep_done", "prep_started",
  "prep_max_rank", "production_state", "recv_fab_done", "recv_fab_total", "sheet_status",
  "production_hold", "cancelled", "fabric_recv_state",
].join(",");

let OPTIONS = null;
/* The stage chip row's own selection. Not a shared filter - it is derived from prep_max_rank, which
 * lives on the roster but is not something the filter bar can express. */
let STAGE = "";

export async function render(mount, state, setFilters) {
  if (!isSignedIn()) return;

  mount.innerHTML = `
    <div class="sectionbar"><span></span><span id="psync"></span></div>
    <div id="pstages"></div><div id="pfbar"></div><div id="pbody"></div>`;
  $("#psync", mount).appendChild(syncBar());

  if (!OPTIONS) {
    try {
      const all = await apiAll("/rest/v1/v_ops_order_roster?select=city,sheet_status,stitching_types,commercial_names,window_refs,fabric_1_codes,fabric_2_codes");
      OPTIONS = deriveOptions(all);
    } catch (e) { OPTIONS = deriveOptions([]); }
  }

  const bar = $("#pfbar", mount);
  const stageRow = $("#pstages", mount);
  const box = $("#pbody", mount);
  const paintBar = () => renderFilterBar(bar, state, OPTIONS, (f) => setFilters(f), CAPS);
  paintBar();

  loading(true, tr("t.loading"));
  let all = [];
  try {
    all = await apiAll(
      `/rest/v1/v_ops_order_roster?select=${COLS}&order=installation_date.asc.nullslast,order_id.asc`
      + toQuery(state.filters, CAPS), PAGE_SIZE);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  /* An order with no panels to prepare - no PO lines yet - cannot be at any stage, and putting it
   * on this screen only makes the counts lie. */
  all = all.filter((r) => Number(r.prep_total) > 0 && !r.cancelled);

  /* ---- the stage row. "Not started" is rank 0, which is where everything begins. */
  const atStage = (r, s) => {
    const rank = Number(r.prep_max_rank || 0);
    if (s === "none") return rank === 0;
    return PREP_STAGES[rank - 1] && PREP_STAGES[rank - 1].value === s;
  };
  const buckets = [
    { value: "", label: tr("f.any"), n: all.length },
    { value: "none", label: tr("ps.awaiting"), n: all.filter((r) => atStage(r, "none")).length },
    ...PREP_STAGES.map((s) => ({
      value: s.value, label: tr(s.key), n: all.filter((r) => atStage(r, s.value)).length,
    })),
  ];
  stageRow.innerHTML = "";
  const chipsCard = el(`<div class="card"><div class="bucketrow" style="margin:0"></div></div>`);
  const row = chipsCard.querySelector(".bucketrow");
  buckets.forEach((b) => {
    const btn = el(`<button class="${STAGE === b.value ? "on" : ""}">${esc(b.label)} ${b.n}</button>`);
    btn.addEventListener("click", () => {
      STAGE = STAGE === b.value ? "" : b.value;
      window.dispatchEvent(new CustomEvent("ops:rerender"));
    });
    row.appendChild(btn);
  });
  stageRow.appendChild(chipsCard);

  const rows = STAGE ? all.filter((r) => atStage(r, STAGE)) : all;
  state.count = rows.length;
  paintBar();

  if (!rows.length) {
    box.innerHTML = `<div class="card"><span class="muted">${
      esc(activeCount(state.filters, CAPS) || STAGE ? tr("t.empty") : tr("t.emptyUnfiltered"))}</span></div>`;
    return;
  }

  const selected = new Set();
  const list = el(`<div class="olist"></div>`);
  const bulk = bulkBar(rows, selected, list);
  box.appendChild(bulk.root);
  box.appendChild(list);

  rows.forEach((r) => list.appendChild(orderCard(r, selected, bulk)));
  bulk.update();
}

function orderCard(r, selected, bulk) {
  const rank = Number(r.prep_max_rank || 0);
  const stage = rank ? PREP_STAGES[rank - 1] : null;
  const b = bucketOf(r.date_bucket);
  const card = el(`
    <div class="ocard b-${esc(r.date_bucket)}">
      <div class="ohead">
        ${isViewer() ? "" : `<input type="checkbox" class="oselect" data-sel value="${esc(r.order_id)}"
               aria-label="${esc(r.order_id)}">`}
        <div class="ometa">
          <div class="row" style="gap:6px">
            <span class="oid">${esc(r.order_id)}</span>
            ${chip(tr(b.key), b.tone, b.glyph)}
            ${stage ? chip(tr(stage.key), rank >= 2 ? "ok" : "info", rank >= 2 ? "✓" : "›")
                    : chip(tr("ps.awaiting"), "mute", "·")}
            ${r.production_hold ? chip("HOLD", "bad", "!") : ""}
          </div>
          <div class="oname">${esc(r.customer_name || "—")}</div>
          <div class="osub">${esc(r.city || tr("t.cityUnknown"))} · ${esc(fmtDate(r.installation_date))}
            · ${esc(r.window_count)} ${esc(tr("col.windows").toLowerCase())}
            · ${esc(num(r.report_meters))} m</div>
          <div class="ochips" style="gap:10px">
            <span class="muted">${esc(tr("col.recvFabric"))}</span>
              ${progressBar(r.recv_fab_done, r.recv_fab_total)}
            <span class="muted">${esc(tr("col.prep"))}</span>
              ${progressBar(r.prep_done, r.prep_total)}
          </div>
        </div>
        <span class="ocaret">▾</span>
      </div>
      <div class="dhost"></div>
    </div>`);

  const boxEl = card.querySelector("input[data-sel]");
  if (boxEl) {
    boxEl.addEventListener("click", (e) => e.stopPropagation());
    boxEl.addEventListener("change", () => {
      if (boxEl.checked) selected.add(r.order_id); else selected.delete(r.order_id);
      bulk.update();
    });
  }

  const head = card.querySelector(".ohead");
  const host = card.querySelector(".dhost");
  head.addEventListener("click", async () => {
    if (host.innerHTML) { host.innerHTML = ""; card.querySelector(".ocaret").textContent = "▾"; return; }
    card.querySelector(".ocaret").textContent = "▴";
    await prepPanel(host, r.order_id);
  });
  return card;
}

/* ---------------------------------------------------------------- the three panels */

/* Everything the floor needs about one order, in one round of four parallel reads. Parallel because
 * this runs on a tap: four sequential round trips on workshop wifi is a visible stall. */
async function loadOrder(orderId) {
  const id = encodeURIComponent(orderId);
  const [units, locations, special, rails] = await Promise.all([
    api(`/rest/v1/v_ops_prep_units?order_id=eq.${id}` +
        `&select=window_name,layer_no,window_ref,window_no,fabric_code,cut_width_cm,cut_height_cm,pieces_label` +
        `&order=window_no.asc.nullslast,window_name.asc,layer_no.asc`),
    api(`/rest/v1/v_ops_prep_locations?order_id=eq.${id}&select=*`),
    api(`/rest/v1/receiving_expectations?order_id=eq.${id}&grain=neq.order_fabric` +
        `&select=id,grain,window_name,item_description,qty_expected,uom,status,qc_result&order=item_description.asc`),
    api(`/rest/v1/v_ops_report_railing?order_id=eq.${id}` +
        `&select=line_id,window_ref,window_name,stitching_type,number_of_layers,railing_length,` +
        `railing_length_num,num_railings,drilling_type,brackets,car_max_length_cm,rail_done,rail_done_by` +
        `&order=window_ref.asc,line_id.asc`),
  ]);
  return { units: units || [], locations: locations || [], special: special || [], rails: rails || [] };
}

async function prepPanel(host, orderId) {
  host.innerHTML = `<div class="drawer"><span class="muted">${esc(tr("t.loading"))}</span></div>`;
  let d;
  try {
    d = await loadOrder(orderId);
  } catch (e) {
    host.innerHTML = `<div class="drawer"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }

  const reload = () => prepPanel(host, orderId);
  const wrap = el(`<div class="drawer"></div>`);
  wrap.appendChild(locationSection(d, orderId, reload));
  wrap.appendChild(specialSection(d, orderId, reload));
  wrap.appendChild(railSection(d, orderId, reload));
  host.innerHTML = "";
  host.appendChild(wrap);
}

/* ---- 1. where it is stacked */
function locationSection(d, orderId, reload) {
  const byUnit = new Map();
  d.locations.forEach((l) => byUnit.set(l.window_name + "|" + l.layer_no, l));

  const placed = d.units.filter((u) => byUnit.has(u.window_name + "|" + u.layer_no)).length;
  const box = el(`
    <div class="dsec">
      <h4>${esc(tr("stack.title"))} ${progressBar(placed, d.units.length)}</h4>
    </div>`);

  if (!d.units.length) {
    box.appendChild(el(`<div class="dnone">${esc(tr("d.none"))}</div>`));
    return box;
  }

  /* Distinct places this order is in. An order split over two racks is normal - a big job is packed
   * in the order it was cut and goes wherever there was room - and somebody sent to collect it needs
   * to be told both, not an average. */
  const distinct = Array.from(new Set(d.locations.map((l) => l.location_label))).filter(Boolean);
  if (distinct.length) {
    box.appendChild(el(`<div class="row" style="gap:6px;margin-bottom:9px">
      ${distinct.map((p) => chip(p, "ok", "📍")).join("")}</div>`));
  }

  const list = el(`<div class="unitpick"></div>`);
  d.units.forEach((u) => {
    const key = u.window_name + "|" + u.layer_no;
    const at = byUnit.get(key);
    list.appendChild(el(`
      <label class="unitrow${at ? " placed" : ""}">
        ${isViewer() ? "" : `<input type="checkbox" data-unit="${esc(key)}">`}
        <span class="uname">${esc(u.window_ref || u.window_name)} · L${esc(u.layer_no)}
          <span class="usub">${esc(u.fabric_code || "")}
            ${u.pieces_label ? "· " + esc(u.pieces_label) : ""}</span>
        </span>
        <span>${at ? chip(at.location_label, "ok", "📍") : chip("—", "mute")}</span>
      </label>`));
  });
  box.appendChild(list);

  if (isViewer()) return box;

  const form = el(`
    <div class="stackform">
      <div class="row" style="gap:6px;margin-bottom:9px">
        <button class="btn sm ghost" data-all>${esc(tr("prep.allWindows"))}</button>
        <button class="btn sm ghost" data-none>${esc(tr("bulk.clear"))}</button>
        <span class="muted" data-count></span>
      </div>
      <div class="grid2">
        <div><label class="f">${esc(tr("stack.floor"))}</label>
          ${selectHtml("floor", STACK_FLOORS.map((f) => ({ value: f.value, label: tr(f.key) })), "G")}</div>
        <div><label class="f">${esc(tr("stack.rack"))}</label>
          ${selectHtml("rack", STACK_RACKS, "R1")}</div>
        <div><label class="f">${esc(tr("stack.shelf"))}</label>
          ${selectHtml("shelf", STACK_SHELVES, "S1")}</div>
        <div><label class="f">${esc(tr("stack.zone"))}</label>
          ${selectHtml("zone", STACK_ZONES, "A")}</div>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:10px">
        <button class="btn primary sm" data-apply>${esc(tr("prep.applyLocation"))}</button>
      </div>
    </div>`);
  box.appendChild(form);

  const ticks = () => Array.from(list.querySelectorAll("input[data-unit]:checked"));
  const refreshCount = () => {
    const n = ticks().length;
    form.querySelector("[data-count]").textContent =
      n ? tr("act.selected", { n }) : tr("prep.pickWindows");
  };
  list.addEventListener("change", (e) => {
    if (!e.target.matches("input[data-unit]")) return;
    e.target.closest(".unitrow").classList.toggle("on", e.target.checked);
    refreshCount();
  });
  const setAll = (on) => {
    list.querySelectorAll("input[data-unit]").forEach((cb) => {
      cb.checked = on;
      cb.closest(".unitrow").classList.toggle("on", on);
    });
    refreshCount();
  };
  form.querySelector("[data-all]").addEventListener("click", () => setAll(true));
  form.querySelector("[data-none]").addEventListener("click", () => setAll(false));
  refreshCount();

  form.querySelector("[data-apply]").addEventListener("click", async () => {
    const chosen = ticks();
    if (!chosen.length) { toast(tr("prep.pickWindows"), "bad"); return; }
    const g = (n) => form.querySelector(`[name="${n}"]`).value;
    const loc = { p_floor: g("floor"), p_rack: g("rack"), p_shelf: g("shelf"), p_zone: g("zone") };
    if (Object.values(loc).some((v) => !v)) { toast(tr("stack.required"), "bad"); return; }

    const units = chosen.map((cb) => {
      const [w, l] = cb.dataset.unit.split("|");
      return { w, l: Number(l) };
    });

    /* Stacking IS the location: fn_ops_apply_prep only carries the four columns on that stage, and
     * the database CHECK says the same. A fresh op id per apply is what lets the SECOND location on
     * the same order land as a new event instead of colliding with the first - the client_op_id is
     * md5(op | window | layer), so re-sending THIS apply from the queue is still a no-op. */
    await submit("fn_ops_apply_prep", {
      p_order_id: orderId, p_stage: "stacking", p_units: units, p_qc: null,
      p_actor: currentActor(), p_note: "Location from Preparation",
      p_op: crypto.randomUUID(), ...loc,
    });
    toast(queueDepth() ? tr("t.queued")
                       : tr("prep.located", { n: units.length, at: Object.values(loc).join("-") }), "ok");
    reload();
  });

  return box;
}

/* ---- 2. the special items, ticked as they arrive */
function specialSection(d, orderId, reload) {
  const done = d.special.filter((r) => r.status === "received" || r.status === "cancelled").length;
  const box = el(`
    <div class="dsec">
      <div class="spread" style="margin-bottom:9px">
        <h4>${esc(tr("col.special"))} ${progressBar(done, d.special.length)}</h4>
        ${isViewer() || !d.special.length ? "" :
          `<button class="btn accent sm" data-allmat>${esc(tr("act.receiveAllMat"))}</button>`}
      </div>
    </div>`);

  if (!d.special.length) {
    box.appendChild(el(`<div class="dnone">${esc(tr("d.none"))}</div>`));
    return box;
  }

  d.special.forEach((r) => {
    const got = r.status === "received";
    const st = RECV_STATUSES.find((s) => s.value === r.status) || { tone: "mute" };
    const row = el(`
      <label class="unitrow${got ? " placed" : ""}">
        ${isViewer() ? "" : `<input type="checkbox" data-recv="${esc(r.id)}"${got ? " checked" : ""}>`}
        <span class="uname">${esc(r.item_description || "—")}
          <span class="usub">${esc(num(r.qty_expected))} ${esc(r.uom || "pc")}${
            r.window_name ? " · " + esc(r.window_name) : ""}</span>
        </span>
        <span>${chip(tv(RECV_STATUSES, r.status), st.tone)}</span>
      </label>`);
    box.appendChild(row);
  });

  if (isViewer()) return box;

  /* The same RPC the order drawer's Materials tab calls. Ticking here and ticking there must be the
   * same event, or the two screens start disagreeing about what has arrived. */
  box.addEventListener("change", async (e) => {
    if (!e.target.matches("input[data-recv]")) return;
    const id = Number(e.target.dataset.recv);
    const on = e.target.checked;
    e.target.closest(".unitrow").classList.toggle("placed", on);
    await submit("fn_ops_set_receiving", {
      p_ids: [id], p_status: on ? "received" : "pending", p_qc: null,
      p_actor: currentActor(), p_note: null,
    });
    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
  });

  const allBtn = box.querySelector("[data-allmat]");
  if (allBtn) allBtn.addEventListener("click", async () => {
    // p_exclude_fabric keeps "all materials arrived" from also ticking off rolls of cloth
    await submit("fn_ops_receive_all", {
      p_order_id: orderId, p_actor: currentActor(), p_note: null,
      p_grain: null, p_exclude_fabric: true,
    });
    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
    reload();
  });

  return box;
}

/* ---- 3. the rail cut list */
function railSection(d, orderId, reload) {
  const done = d.rails.filter((r) => r.rail_done).length;
  const box = el(`
    <div class="dsec">
      <div class="spread" style="margin-bottom:9px">
        <h4>${esc(tr("rep.railing"))} ${progressBar(done, d.rails.length)}</h4>
        ${isViewer() || !d.rails.length ? "" :
          `<button class="btn accent sm" data-allrail>${esc(tr("prep.allRails"))}</button>`}
      </div>
    </div>`);

  if (!d.rails.length) {
    box.appendChild(el(`<div class="dnone">${esc(tr("d.none"))}</div>`));
    return box;
  }

  d.rails.forEach((r) => {
    /* A rail longer than the car it travels in has to be cut into pieces, and that is the one number
     * on this list somebody gets wrong. Flag it where the tick is. */
    const over = Number(r.railing_length_num) > Number(r.car_max_length_cm || 1e6);
    box.appendChild(el(`
      <label class="unitrow${r.rail_done ? " placed" : ""}">
        ${isViewer() ? "" : `<input type="checkbox" data-rail="${esc(r.line_id)}"${
          r.rail_done ? " checked" : ""}>`}
        <span class="uname">${esc(r.window_ref || r.window_name || "—")}
          <span class="usub">${esc(r.stitching_type || "")}
            ${r.number_of_layers ? "· " + esc(r.number_of_layers) + "L" : ""}
            ${r.drilling_type ? "· " + esc(r.drilling_type) : ""}
            ${r.brackets ? "· " + esc(r.brackets) : ""}</span>
        </span>
        <span class="row" style="gap:5px">
          ${chip(String(r.railing_length ?? "—"), over ? "warn" : "info", over ? "✂" : "")}
          ${r.num_railings ? chip("×" + r.num_railings, "mute") : ""}
        </span>
      </label>`));
  });

  if (isViewer()) return box;

  const send = (lineId, on) => submit("fn_ops_set_rail_mark", {
    p_line_id: Number(lineId), p_on: on, p_actor: currentActor(), p_op: crypto.randomUUID(),
  });

  box.addEventListener("change", async (e) => {
    if (!e.target.matches("input[data-rail]")) return;
    const on = e.target.checked;
    e.target.closest(".unitrow").classList.toggle("placed", on);
    await send(e.target.dataset.rail, on);
    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
  });

  const allBtn = box.querySelector("[data-allrail]");
  if (allBtn) allBtn.addEventListener("click", async () => {
    const todo = d.rails.filter((r) => !r.rail_done);
    if (!todo.length) return;
    for (const r of todo) await send(r.line_id, true);
    toast(queueDepth() ? tr("t.queued") : tr("bulk.done", { n: todo.length }), "ok");
    reload();
  });

  return box;
}

/* ---------------------------------------------------------------- bulk stage apply */
function bulkBar(rows, selected, list) {
  const root = el(`
    <div class="selbar" hidden>
      <b class="selcount"></b>
      <button class="btn sm primary" data-act="stage">${esc(tr("bulk.prep"))}</button>
      <button class="btn ghost sm" data-act="none">${esc(tr("bulk.clear"))}</button>
    </div>`);

  const restsAt = (node) => {
    if (!node) return 0;
    const s = getComputedStyle(node);
    return s.position === "sticky" ? (parseFloat(s.top) || 0) + node.offsetHeight : 0;
  };

  const update = () => {
    root.hidden = selected.size === 0 || isViewer();
    root.querySelector(".selcount").textContent = tr("act.selected", { n: selected.size });
    root.style.top = Math.max(restsAt($("#hdr")), restsAt($("nav.tabs"))) + "px";
    list.querySelectorAll("input[data-sel]").forEach((cb) => {
      cb.closest(".ocard").classList.toggle("selected", cb.checked);
    });
  };

  const clear = () => {
    selected.clear();
    list.querySelectorAll("input[data-sel]").forEach((cb) => { cb.checked = false; });
    update();
  };

  root.querySelector('[data-act="none"]').addEventListener("click", clear);
  root.querySelector('[data-act="stage"]').addEventListener("click", () => stageModal(selected, clear));
  return { root, update };
}

const BULK_CONFIRM_OVER = 25;

/* Stage across many orders at once. Stacking is NOT offered here any more: a location belongs to
 * particular windows in a particular order, and a single floor/rack/shelf/zone smeared over thirty
 * selected orders would be a lie in twenty-nine of them. Open the order and place it. */
function stageModal(selected, clear) {
  const ids = Array.from(selected);
  const stages = PREP_STAGES.filter((s) => s.value !== "stacking");
  const m = modal(`
    <h3>${esc(tr("bulk.prep"))}</h3>
    <p class="muted" style="margin:4px 0 14px">${esc(tr("act.selected", { n: ids.length }))}
      · ${esc(tr("bulk.prepNote"))}</p>
    <div style="margin-bottom:10px"><label class="f">${esc(tr("col.prep"))}</label>
      ${selectHtml("stage", stages.map((s) => ({ value: s.value, label: tr(s.key) })), "cutting")}</div>
    <p class="muted" style="margin:0 0 12px">${esc(tr("prep.stackHint"))}</p>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
    </div>`);

  const q = (s) => m.sheet.querySelector(s);
  q("[data-no]").onclick = m.close;
  q("[data-yes]").onclick = async () => {
    const stage = q('[name="stage"]').value;
    m.close();
    if (ids.length > BULK_CONFIRM_OVER
        && !await confirmSheet(tr("bulk.confirmMany", { n: ids.length }), tr("bulk.confirmManyBody"))) {
      return;
    }
    clear();

    loading(true, tr("bulk.working", { n: ids.length }));
    try {
      for (const id of ids) {
        // op id fixed HERE, not inside the RPC, so a queued write replays onto the same rows
        await submit("fn_ops_apply_prep", {
          p_order_id: id, p_stage: stage, p_units: null, p_qc: null,
          p_actor: currentActor(), p_note: "Applied from Preparation",
          p_op: crypto.randomUUID(),
          p_floor: null, p_rack: null, p_shelf: null, p_zone: null,
        });
      }
    } finally { loading(false); }
    toast(queueDepth() ? tr("t.queued") : tr("bulk.done", { n: ids.length }), "ok");
    window.dispatchEvent(new CustomEvent("ops:rerender"));
  };
}
