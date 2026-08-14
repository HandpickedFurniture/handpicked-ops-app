/* Preparation - where the floor marks what stage an order's panels have reached.
 *
 * The stage ladder already existed, buried three taps deep inside the production drawer's Status
 * tab. That is the wrong place for the one thing the workshop does dozens of times a day, so this
 * is the same write with the stage brought to the front: pick the stage, tick the orders, apply.
 *
 * Production status is the primary filter and sits ABOVE the shared filter bar as a row of chips,
 * because "show me everything still at Started" is the question this screen opens with.
 *
 * Stacking is the last stage and the only one that asks for anything more: where the packed order
 * physically went. Floor, rack, shelf and zone are constrained here and again in the database, so a
 * typo is refused rather than stored - a wrong shelf code is worse than no shelf code, because
 * somebody will go and look there.
 */
import { apiAll, isSignedIn, submit, currentActor, queueDepth, isViewer } from "./api.js";
import { tr, tv } from "./i18n.js";
import {
  PREP_STAGES, PRODUCTION_STATES, PAGE_SIZE, STACK_FLOORS, STACK_RACKS, STACK_SHELVES, STACK_ZONES,
  bucketOf,
} from "./config.js";
import {
  $, esc, el, chip, num, fmtDate, toast, loading, progressBar, modal, selectHtml, confirmSheet,
} from "./ui.js";
import { renderFilterBar, toQuery, deriveOptions, activeCount } from "./filters.js";
import { syncBar } from "./sync.js";
import { renderDrawer, invalidate } from "./drawer.js";

const CAPS = { fabstatus: true, prodstate: true };

const COLS = [
  "order_id", "customer_name", "city", "installation_date", "date_bucket", "window_count",
  "meters_sent_total", "fabric_meters_total", "prep_total", "prep_done", "prep_started",
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
            · ${esc(num(r.meters_sent_total))} m</div>
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
    await renderDrawer(host, r.order_id, () => invalidate(r.order_id));
  });
  return card;
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

function stageModal(selected, clear) {
  const ids = Array.from(selected);
  const m = modal(`
    <h3>${esc(tr("bulk.prep"))}</h3>
    <p class="muted" style="margin:4px 0 14px">${esc(tr("act.selected", { n: ids.length }))}
      · ${esc(tr("bulk.prepNote"))}</p>
    <div style="margin-bottom:10px"><label class="f">${esc(tr("col.prep"))}</label>
      ${selectHtml("stage", PREP_STAGES.map((s) => ({ value: s.value, label: tr(s.key) })), "cutting")}</div>
    <div data-stackwrap hidden>
      <div class="f" style="margin-bottom:6px">${esc(tr("stack.title"))}</div>
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
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
    </div>`);

  const q = (s) => m.sheet.querySelector(s);
  const stageSel = q('[name="stage"]');
  // the location only exists for stacking, and asking for it anywhere else invites a wrong answer
  const sync = () => { q("[data-stackwrap]").hidden = stageSel.value !== "stacking"; };
  stageSel.addEventListener("change", sync);
  sync();

  q("[data-no]").onclick = m.close;
  q("[data-yes]").onclick = async () => {
    const stage = stageSel.value;
    const stacking = stage === "stacking";
    const loc = stacking ? {
      p_floor: q('[name="floor"]').value, p_rack: q('[name="rack"]').value,
      p_shelf: q('[name="shelf"]').value, p_zone: q('[name="zone"]').value,
    } : { p_floor: null, p_rack: null, p_shelf: null, p_zone: null };
    if (stacking && Object.values(loc).some((v) => !v)) { toast(tr("stack.required"), "bad"); return; }

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
          p_op: crypto.randomUUID(), ...loc,
        });
        invalidate(id);
      }
    } finally { loading(false); }
    toast(queueDepth() ? tr("t.queued") : tr("bulk.done", { n: ids.length }), "ok");
    window.dispatchEvent(new CustomEvent("ops:rerender"));
  };
}
