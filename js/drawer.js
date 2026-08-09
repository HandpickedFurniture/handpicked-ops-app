/* The expandable per-order drawer.
 *
 * Everything comes from ONE call to fn_order_drawer(order_id), which assembles installation alerts,
 * procurement alerts, production alerts, chargeable extras, every optional comment, the AI-interpreted
 * comments, the email/PO history, the receiving rows, the production units and the dispatch state.
 *
 * Sub-tabs: Fabrics (stages 1-4) | Production (stages 5-10) | Dispatch (stages 11-14) |
 *           Alerts | Comments | Emails
 */
import { rpc, submit, currentActor, queueDepth } from "./api.js";
import { tr, tv, getLang } from "./i18n.js";
import {
  RECV_STATUSES, QC_RESULTS, PREP_STAGES, DISPATCH_CONTRACTORS, DISPATCH_SUBSTATES,
} from "./config.js";
import {
  esc, el, chip, aed, num, fmtDate, fmtDateTime, toast, modal, selectHtml, progressBar,
} from "./ui.js";
import { micField, wireMics } from "./voice.js";
import { photoStrip } from "./photos.js";

const cache = new Map();

export function invalidate(orderId) { cache.delete(orderId); }

export async function loadDrawer(orderId, force) {
  if (!force && cache.has(orderId)) return cache.get(orderId);
  const d = await rpc("fn_order_drawer", { p_order_id: orderId });
  cache.set(orderId, d);
  return d;
}

export async function renderDrawer(host, orderId, onDirty) {
  host.innerHTML = `<div class="drawer"><span class="muted">${esc(tr("t.loading"))}</span></div>`;
  let d;
  try {
    d = await loadDrawer(orderId);
  } catch (e) {
    host.innerHTML = `<div class="drawer"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }

  const wrap = el(`<div class="drawer"></div>`);
  const tabs = el(`<div class="subtabs"></div>`);
  const body = el(`<div></div>`);

  const TABS = [
    { id: "fab",  label: tr("col.fabrics"),   render: () => receivingTab(d, orderId, refresh, "order_fabric") },
    { id: "mat",  label: tr("col.recvMaterials"), render: () => receivingTab(d, orderId, refresh, "materials") },
    // "Status" rather than "Production": inside an order's details, this tab is the per-panel stage,
    // and the module it sits in is already called Production
    { id: "prod", label: tr("d.statusTab"),   render: () => prepTab(d, orderId, refresh) },
    { id: "disp", label: tr("disp.title"),    render: () => dispatchTab(d, orderId, refresh) },
    { id: "alert",label: tr("d.prodAlerts"),  render: () => alertsTab(d) },
    { id: "note", label: tr("d.comments"),    render: () => commentsTab(d, orderId, refresh) },
    { id: "mail", label: tr("d.emails"),      render: () => emailsTab(d) },
  ];

  let current = "fab";
  function paint() {
    tabs.innerHTML = TABS.map((t) =>
      `<button data-tab="${t.id}" class="${t.id === current ? "on" : ""}">${esc(t.label)}</button>`).join("");
    tabs.querySelectorAll("[data-tab]").forEach((b) =>
      b.addEventListener("click", () => { current = b.dataset.tab; paint(); }));
    body.innerHTML = "";
    body.appendChild(TABS.find((t) => t.id === current).render());
  }

  async function refresh() {
    try { d = await loadDrawer(orderId, true); } catch (e) { toast(e.message, "bad"); }
    paint();
    if (onDirty) onDirty();
  }

  if (d.flags && (d.flags.production_hold || d.flags.cancelled)) {
    wrap.appendChild(el(`<div class="banner bad">${d.flags.cancelled ? "CANCELLED" : "ON HOLD"}${
      d.flags.hold_reason ? " — " + esc(d.flags.hold_reason) : ""}</div>`));
  }

  wrap.appendChild(tabs);
  wrap.appendChild(body);
  host.innerHTML = "";
  host.appendChild(wrap);
  paint();
}

/* ---------------------------------------------------------------- stages 1-4 */
/* which = 'order_fabric' (rolls of cloth) or 'materials' (motors, remotes, ready-made tracks,
 * blinds, sticks). They come from different suppliers on different lead times and are chased by
 * different people, so one combined list hid which half was actually late. */
function receivingTab(d, orderId, refresh, which) {
  const all = d.receiving || [];
  const rows = which === "order_fabric"
    ? all.filter((r) => r.grain === "order_fabric")
    : all.filter((r) => r.grain !== "order_fabric");
  const box = el(`<div class="dsec"></div>`);
  if (!rows.length) { box.innerHTML = `<div class="dnone">${esc(tr("d.none"))}</div>`; return box; }

  const done = rows.filter((r) => r.status === "received" || r.status === "cancelled").length;

  box.appendChild(el(`
    <div class="spread" style="margin-bottom:10px">
      <div>${progressBar(done, rows.length)}</div>
      <button class="btn accent sm" data-all>${esc(
        which === "order_fabric" ? tr("act.receiveAll") : tr("act.receiveAllMat"))}</button>
    </div>`));

  rows.forEach((r) => {
    const st = RECV_STATUSES.find((s) => s.value === r.status) || { tone: "mute" };
    const warn = [];
    if (r.is_stale)   warn.push(chip(tr("t.staleRow"), "warn", "!"));
    if (r.is_drifted) warn.push(chip(tr("t.drift", { a: num(r.po_meters), b: num(r.qty_expected) }), "warn", "!"));
    if (r.qc_result && r.qc_result !== "ok_fabric") warn.push(chip(tv(QC_RESULTS, r.qc_result), "bad", "!"));
    else if (r.qc_result) warn.push(chip(tv(QC_RESULTS, r.qc_result), "ok", "✓"));

    const label = r.fabric_code || r.item_description || "—";
    const unit = r.grain === "order_fabric" ? "m" : "pc";

    const row = el(`
      <div class="unit">
        <div class="uname">${esc(label)}
          <div class="usub">${esc(r.item_description || "")}${r.window_name ? " · " + esc(r.window_name) : ""}
            · ${esc(num(r.qty_expected))} ${esc(unit)}</div>
        </div>
        <div>${chip(tv(RECV_STATUSES, r.status), st.tone)} ${warn.join(" ")}</div>
        <div class="cell-actions row">
          ${selectHtml("st_" + r.id, RECV_STATUSES.map((s) => ({ value: s.value, label: tr(s.key) })), r.status)}
          ${selectHtml("qc_" + r.id, QC_RESULTS.map((s) => ({ value: s.value, label: tr(s.key) })),
                       r.qc_result || "", tr("qc.title"))}
        </div>
      </div>`);

    // Photo evidence on this expectation. Most valuable on a failed QC - a damaged or wrong fabric
    // photographed on arrival is what settles it with the supplier weeks later.
    row.appendChild(photoStrip({
      context: "receiving", context_id: r.id, order_id: orderId,
      context_label: `${label} — ${r.item_description || ""}`.trim(),
    }));

    const stSel = row.querySelector(`[name="st_${r.id}"]`);
    const qcSel = row.querySelector(`[name="qc_${r.id}"]`);
    const push = async () => {
      row.classList.add("pending");
      await submit("fn_ops_set_receiving", {
        p_ids: [r.id],
        p_status: stSel.value || null,
        p_qc: qcSel.value || null,
        p_actor: currentActor(),
        p_note: null,
      });
      toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
      refresh();
    };
    stSel.addEventListener("change", push);
    qcSel.addEventListener("change", push);
    box.appendChild(row);
  });

  box.querySelector("[data-all]").addEventListener("click", async () => {
    // only the half currently on screen - "mark all fabrics received" must not also tick off motors
    // that have not arrived
    await submit("fn_ops_receive_all", {
      p_order_id: orderId, p_actor: currentActor(), p_note: null,
      p_grain: which === "order_fabric" ? "order_fabric" : null,
      p_exclude_fabric: which !== "order_fabric",
    });
    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
    refresh();
  });

  return box;
}

/* ---------------------------------------------------------------- stages 5-10 */
function prepTab(d, orderId, refresh) {
  const units = d.prep_units || [];
  const box = el(`<div class="dsec"></div>`);
  if (!units.length) { box.innerHTML = `<div class="dnone">${esc(tr("d.none"))}</div>`; return box; }

  const packed = units.filter((u) => u.stage === "folding_packing").length;

  // Bulk apply: 33 units x 6 stages would be 198 taps without it
  const head = el(`
    <div class="spread" style="margin-bottom:10px">
      <div>${progressBar(packed, units.length)}</div>
      <div class="row">
        ${selectHtml("bulkstage", PREP_STAGES.map((s) => ({ value: s.value, label: tr(s.key) })), "",
                     tr("act.markStage"))}
        <button class="btn accent sm" data-applyall>${esc(tr("act.applyAll"))}</button>
      </div>
    </div>`);
  box.appendChild(head);

  // One strip for the whole order rather than per panel: production photos are taken of the batch,
  // and a camera button on all 33 units of a big order would be noise.
  box.appendChild(photoStrip({ context: "prep", order_id: orderId, context_label: "Production" }));

  head.querySelector("[data-applyall]").addEventListener("click", async () => {
    const stage = head.querySelector('[name="bulkstage"]').value;
    if (!stage) { toast(tr("act.markStage"), "bad"); return; }
    await submit("fn_ops_apply_prep", {
      p_order_id: orderId, p_stage: stage, p_units: null, p_qc: null,
      p_actor: currentActor(), p_note: null, p_op: crypto.randomUUID(),
    });
    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
    refresh();
  });

  units.forEach((u) => {
    const idx = PREP_STAGES.findIndex((s) => s.value === u.stage);
    const row = el(`
      <div class="unit">
        <div class="uname">${esc(u.window_ref || u.window_name)} · L${esc(u.layer_no)}
          <div class="usub">${esc(u.fabric_code || "")}
            ${u.cut_width_cm ? "· W" + esc(num(u.cut_width_cm)) : ""}
            ${u.cut_height_cm ? "· H" + esc(num(u.cut_height_cm)) : ""}
            ${u.pieces_label ? "· " + esc(u.pieces_label) : ""}</div>
        </div>
        <div>${u.stage
          ? chip(tv(PREP_STAGES, u.stage) || u.stage, idx === PREP_STAGES.length - 1 ? "ok" : "info",
                 idx === PREP_STAGES.length - 1 ? "✓" : "›")
          : chip("—", "mute")}</div>
        <div class="cell-actions">
          ${selectHtml("u_" + u.window_name + "_" + u.layer_no,
                       PREP_STAGES.map((s) => ({ value: s.value, label: tr(s.key) })),
                       u.stage || "", tr("act.markStage"))}
        </div>
      </div>`);

    row.querySelector("select").addEventListener("change", async (e) => {
      if (!e.target.value) return;
      row.classList.add("pending");
      await submit("fn_ops_apply_prep", {
        p_order_id: orderId, p_stage: e.target.value,
        p_units: [{ w: u.window_name, l: u.layer_no }],
        p_qc: null, p_actor: currentActor(), p_note: null, p_op: crypto.randomUUID(),
      });
      toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
      refresh();
    });
    box.appendChild(row);
  });

  return box;
}

/* ---------------------------------------------------------------- stages 11-14 */
function dispatchTab(d, orderId, refresh) {
  const rows = d.dispatch || [];
  const box = el(`<div class="dsec"></div>`);

  DISPATCH_CONTRACTORS.filter((c) => c.value !== "other").forEach((c) => {
    const hit = rows.find((r) => r.contractor === c.value);
    box.appendChild(contractorRow(c.value, null, tr(c.key), hit, orderId, refresh));
  });

  rows.filter((r) => r.contractor === "other").forEach((r) => {
    box.appendChild(contractorRow("other", r.other_name, r.other_name, r, orderId, refresh));
  });

  const add = el(`<button class="btn sm" data-addother>+ ${esc(tr("disp.other"))}</button>`);
  add.addEventListener("click", () => {
    const m = modal(`
      <h3>${esc(tr("disp.other"))}</h3>
      <div style="margin:12px 0">
        <label class="f">${esc(tr("disp.otherName"))}</label>
        <input type="text" name="oname" autofocus>
      </div>
      <div class="row" style="justify-content:flex-end">
        <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
        <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
      </div>`);
    m.sheet.querySelector("[data-no]").onclick = m.close;
    m.sheet.querySelector("[data-yes]").onclick = async () => {
      const name = m.sheet.querySelector('[name="oname"]').value.trim();
      if (!name) return;
      m.close();
      await submit("fn_ops_set_dispatch", {
        p_order_id: orderId, p_contractor: "other", p_substate: "planned",
        p_other_name: name, p_actor: currentActor(), p_note: null, p_items: null,
      });
      toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
      refresh();
    };
  });
  box.appendChild(add);
  return box;
}

function contractorRow(contractor, otherName, label, hit, orderId, refresh) {
  const failed = hit && hit.substate === "qc_failed";
  const row = el(`
    <div class="unit${failed ? " qcfail" : ""}">
      <div class="uname">${esc(label)}
        ${failed ? chip(tr("disp.qcFail"), "bad", "!") : ""}
        ${hit && hit.substate === "qc_passed" ? chip(tr("disp.qcPass"), "ok", "✓") : ""}
        <!-- the current state, spelled out under the name: the highlighted button alone was easy to
             miss on a phone, and this row is read far more often than it is clicked -->
        <div class="dispstate">${hit
          ? chip(tv(DISPATCH_SUBSTATES, hit.substate),
                 (DISPATCH_SUBSTATES.find((s) => s.value === hit.substate) || {}).tone || "info")
          : chip(tr("disp.notSent"), "mute", "—")}</div>
        <div class="usub">${hit && hit.sent_at ? esc(tr("disp.sent")) + " " + esc(fmtDateTime(hit.sent_at)) : ""}
          ${hit && hit.received_back_at ? " · " + esc(tr("disp.back")) + " " + esc(fmtDateTime(hit.received_back_at)) : ""}
          ${hit && hit.qc_at ? " · " + esc(tr("qc.title")) + " " + esc(fmtDateTime(hit.qc_at)) : ""}
          ${hit && hit.items_count ? " · " + esc(hit.items_count) + " " + esc(tr("disp.items")) : ""}</div>
        ${failed && hit.qc_note ? `<div class="err" style="margin-top:4px">${esc(hit.qc_note)}</div>` : ""}
      </div>
      <div class="cell-actions row">
        ${DISPATCH_SUBSTATES.map((s) => `<button class="btn sm ${
          hit && hit.substate === s.value ? "primary" : ""}" data-sub="${s.value}">${esc(tr(s.key))}</button>`).join("")}
      </div>
    </div>`);

  // Photographing what went out to a contractor, and what came back, is what settles a dispute over
  // a missing or damaged panel.
  row.appendChild(photoStrip({
    context: "dispatch", context_id: hit ? hit.id : null, order_id: orderId,
    context_label: label,
  }));

  row.querySelectorAll("[data-sub]").forEach((b) => {
    b.addEventListener("click", async () => {
      const sub = b.dataset.sub;

      // A failure must say what went wrong; the database rejects a blank one anyway, and asking here
      // explains why instead of surfacing a constraint error.
      let qcNote = null;
      if (sub === "qc_failed") {
        qcNote = (prompt(tr("disp.qcFailWhat")) || "").trim();
        if (!qcNote) { toast(tr("disp.qcFailRequired"), "bad"); return; }
      }

      row.classList.add("pending");
      // Passing QC closes the production loop server-side, so this cannot go through the offline
      // queue blind - we want the result back to tell the user whether production was marked.
      try {
        const res = await rpc("fn_ops_set_dispatch", {
          p_order_id: orderId, p_contractor: contractor, p_substate: sub,
          p_other_name: otherName, p_actor: currentActor(),
          p_note: null, p_items: null, p_qc_note: qcNote,
        });
        if (sub === "qc_passed") {
          toast(res && res.all_passed
            ? `${tr("disp.packedAuto")} (${res.units_marked_packed || 0})`
            : tr("disp.qcPartial"), res && res.all_passed ? "ok" : "");
        } else {
          toast(tr("t.saved"), "ok");
        }
      } catch (e) {
        toast(e.message, "bad");
      }
      refresh();
    });
  });
  return row;
}

/* ---------------------------------------------------------------- alerts */
function alertsTab(d) {
  const box = el(`<div></div>`);
  const list = (title, items, fmt) => {
    const s = el(`<div class="dsec"><h4>${esc(title)} <span class="chip mute">${items.length}</span></h4></div>`);
    if (!items.length) s.appendChild(el(`<div class="dnone">${esc(tr("d.none"))}</div>`));
    else s.appendChild(el(`<ul>${items.map((i) => `<li>${fmt(i)}</li>`).join("")}</ul>`));
    return s;
  };

  box.appendChild(list(tr("d.installAlerts"), d.installation_alerts || [],
    (a) => `<b>${esc(a.type)}</b>${a.window ? " · " + esc(a.window) : ""}${a.message ? " — " + esc(a.message) : ""}`));

  box.appendChild(list(tr("d.procureAlerts"), d.procurement_alerts || [], (a) => {
    const bits = [`<b>${esc(a.label)}</b>`];
    if (a.qty) bits.push(esc(num(a.qty)) + " " + esc(a.uom || ""));
    if (a.status) bits.push(esc(a.status));
    if (a.stale) bits.push(`<span class="chip warn">! ${esc(tr("t.staleRow"))}</span>`);
    if (a.drifted) bits.push(`<span class="chip warn">! ${esc(tr("t.drift", { a: num(a.po_meters), b: num(a.qty) }))}</span>`);
    if (a.message) bits.push(esc(a.message));
    return bits.join(" · ");
  }));

  box.appendChild(list(tr("d.prodAlerts"), d.production_alerts || [],
    (a) => `<b>${esc(a.type)}</b>${a.window ? " · " + esc(a.window) : ""}${a.message ? " — " + esc(a.message) : ""}`));

  box.appendChild(list(tr("d.acctAlerts"), d.accounting_alerts || [], (a) => {
    const amt = a.agreed ?? a.suggested;
    return `<b>${esc(a.charge_type)}</b> · ${esc(aed(amt))}
      ${a.source === "auto" ? `<span class="chip mute">${esc(tr("adj.auto"))}</span>` : ""}
      ${a.rate_drift ? `<span class="chip warn">!</span>` : ""}
      — ${esc(a.reason || "")} <span class="chip ${a.status === "new" ? "warn" : "mute"}">${esc(a.status)}</span>`;
  }));

  return box;
}

/* ---------------------------------------------------------------- comments */
function commentsTab(d, orderId, refresh) {
  const box = el(`<div></div>`);

  const add = el(`
    <div class="dsec">
      <h4>${esc(tr("act.comment"))}</h4>
      ${micField(`<textarea name="newcomment" placeholder="${esc(tr("act.comment"))}"></textarea>`, "newcomment")}
      <div class="row" style="justify-content:flex-end;margin-top:8px">
        <button class="btn primary sm" data-save>${esc(tr("act.save"))}</button>
      </div>
    </div>`);
  let method = "typed";
  wireMics(add, (_t, m) => { method = m; });
  add.querySelector("[data-save]").addEventListener("click", async () => {
    const ta = add.querySelector('[name="newcomment"]');
    const body = ta.value.trim();
    if (!body) return;
    // order_comments, never order_lines_final: fn_rebuild_order recomputes that table wholesale on
    // every PO revision and any note written there disappears silently
    await submit("fn_ops_save_visit", {
      p_order_id: orderId, p_visit_no: 1,
      p_payload: { internal_comment: body, input_method: method, lang: getLang(), skip_visit_charge: true },
      p_actor: currentActor(),
    });
    ta.value = "";
    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
    refresh();
  });
  box.appendChild(add);

  const ops = d.ops_comments || [];
  const s1 = el(`<div class="dsec"><h4>${esc(tr("d.opsComments"))} <span class="chip mute">${ops.length}</span></h4></div>`);
  if (!ops.length) s1.appendChild(el(`<div class="dnone">${esc(tr("d.none"))}</div>`));
  else s1.appendChild(el(`<ul>${ops.map((c) =>
    `<li>${esc(c.body)} <span class="muted">— ${esc(c.author || "")} ${esc(fmtDateTime(c.at))}
      ${c.channel === "slack" ? '<span class="chip info">slack</span>' : ""}
      ${c.input_method && c.input_method !== "typed" ? '<span class="chip mute">🎤</span>' : ""}</span></li>`).join("")}</ul>`));
  box.appendChild(s1);

  const oc = d.optional_comments || [];
  const s2 = el(`<div class="dsec"><h4>${esc(tr("d.comments"))} <span class="chip mute">${oc.length}</span></h4></div>`);
  if (!oc.length) s2.appendChild(el(`<div class="dnone">${esc(tr("d.none"))}</div>`));
  else s2.appendChild(el(`<ul>${oc.map((c) => {
    const bits = [];
    if (c.optional_comment)   bits.push(esc(c.optional_comment));
    if (c.installation_notes) bits.push("<i>" + esc(c.installation_notes) + "</i>");
    if (c.production_comment) bits.push("<b>" + esc(c.production_comment) + "</b>");
    return `<li><b>${esc(c.window || c.window_name || "")}</b> — ${bits.join(" · ")}</li>`;
  }).join("")}</ul>`));
  box.appendChild(s2);

  const ic = d.interpreted_comments || [];
  const s3 = el(`<div class="dsec"><h4>${esc(tr("d.interpreted"))} <span class="chip mute">${ic.length}</span></h4></div>`);
  if (!ic.length) s3.appendChild(el(`<div class="dnone">${esc(tr("d.none"))}</div>`));
  else s3.appendChild(el(`<ul>${ic.map((c) =>
    `<li><b>${esc(c.window || "")}</b> — ${esc(c.raw_text || "")}
      ${c.special_instructions ? "<br><i>" + esc(c.special_instructions) + "</i>" : ""}
      <span class="chip ${c.review_tier === "auto" ? "mute" : "warn"}">${esc(c.review_tier || "")}</span></li>`).join("")}</ul>`));
  box.appendChild(s3);

  return box;
}

/* ---------------------------------------------------------------- emails */
function emailsTab(d) {
  const items = d.emails || [];
  const box = el(`<div class="dsec"><h4>${esc(tr("d.emails"))} <span class="chip mute">${items.length}</span></h4></div>`);
  if (!items.length) { box.appendChild(el(`<div class="dnone">${esc(tr("d.none"))}</div>`)); return box; }

  box.appendChild(el(`<ul>${items.map((m) => {
    const det = m.details || {};
    let extra = "";
    if (m.kind === "version_diff") {
      extra = ` ${esc(det.field_name || "")}: ${esc(det.old_value || "—")} → ${esc(det.new_value || "—")}`;
    } else if (m.kind === "notification") {
      extra = ` ${esc(det.team || "")} · ${esc(det.status || "")}${det.error ? " · " + esc(det.error) : ""}`;
    } else if (det.body_excerpt) {
      extra = " " + esc(String(det.body_excerpt).slice(0, 200));
    }
    return `<li><b>${esc(m.type || m.kind)}</b> <span class="muted">${esc(fmtDateTime(m.at))}</span>${extra}</li>`;
  }).join("")}</ul>`));
  return box;
}
