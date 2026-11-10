/* Receiving fabric and materials BEFORE the PO email has arrived (user, 10 Nov 2026).
 *
 * The roll turns up, the PO is not in the inbox yet, so there is nothing in receiving_expectations to
 * tick. Here the production coordinator types the order (and the PO number if they have it) and what
 * arrived - fabric by name / code and metres, materials by description and pieces. It is kept in
 * manual_receipt, and the moment the PO is processed and its expectations are created, a trigger
 * (fn_trg_manual_receipt_match) matches each typed line to the PO's line - fabric by code ignoring case,
 * spaces and dashes, materials by description - and marks it received (partial when less arrived). Lines
 * that find no match stay listed below as "waiting for the PO" until they do, or are cancelled.
 */
import { api, rpc, isViewer } from "./api.js";
import { esc, el, toast, modal, fmtDateTime } from "./ui.js";

export function receiveBar() {
  const bar = el(`<div class="row prodtop" style="gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--line, #e3e6ea)">
    ${isViewer() ? "" : `<button class="btn sm accent" data-recv>📥 Receive without PO</button>`}
    <button class="btn sm ghost" data-wait>Received, waiting for the PO <span data-n></span></button>
    <div data-list hidden style="flex-basis:100%"></div></div>`);
  const list = bar.querySelector("[data-list]");
  const count = async () => {
    try {
      const rows = await api("/rest/v1/manual_receipt?select=id&matched_expectation_id=is.null&cancelled=is.false") || [];
      bar.querySelector("[data-n]").textContent = `(${rows.length})`;
    } catch (e) { /* the button still works */ }
  };
  const showList = async () => {
    list.hidden = false; list.innerHTML = `<span class="muted">Loading…</span>`;
    let rows = [];
    try { rows = await api("/rest/v1/manual_receipt?select=*&matched_expectation_id=is.null&cancelled=is.false&order=received_at.desc") || []; }
    catch (e) { list.innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }
    list.innerHTML = rows.length ? `<table class="dense report"><thead><tr><th>Order</th><th>PO typed</th><th>What</th><th class="num">Qty</th><th>Received</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><b>${esc(r.order_id)}</b></td><td>${esc(r.po_number || "")}</td>
        <td>${r.grain === "material" ? "🔩" : "🧵"} ${esc(r.fabric_code || "")}${r.description ? ` <span class="muted">${esc(r.description)}</span>` : ""}${r.note ? `<div class="muted" style="font-size:11px">${esc(r.note)}</div>` : ""}</td>
        <td class="num">${esc(r.qty ?? "")} ${esc(r.uom || "")}</td><td>${esc(fmtDateTime(r.received_at))} · ${esc(String(r.received_by || "").split("@")[0])}</td>
        <td>${isViewer() ? "" : `<button class="btn sm ghost" data-cancel="${r.id}">Cancel</button>`}</td></tr>`).join("")}</tbody></table>
      <div class="row" style="gap:8px;margin-top:6px"><button class="btn sm" data-match>↻ Match to POs now</button>
      <span class="muted" style="font-size:12px">They are matched by themselves the moment the order's PO is processed.</span></div>`
      : `<span class="muted">Nothing is waiting: every line received without a PO has been matched to its PO.</span>`;
    list.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Press again"; return; }
      try { await rpc("fn_manual_receipt_cancel", { p_id: Number(b.dataset.cancel) }); showList(); count(); } catch (e) { toast(e.message, "bad"); }
    }));
    const mb = list.querySelector("[data-match]");
    if (mb) mb.addEventListener("click", async () => {
      try { const n = await rpc("fn_manual_receipts_match", { p_order: null }); toast(n ? `${n} line(s) matched to their PO` : "No PO has arrived for them yet"); showList(); count(); }
      catch (e) { toast(e.message, "bad"); }
    });
  };
  bar.querySelector("[data-wait]").addEventListener("click", () => { if (list.hidden) showList(); else list.hidden = true; });
  const rb = bar.querySelector("[data-recv]");
  if (rb) rb.addEventListener("click", () => openReceive(() => { count(); if (!list.hidden) showList(); }));
  count();
  return bar;
}

function lineRow() {
  return `<tr class="mrline">
    <td><select name="grain"><option value="order_fabric">Fabric</option><option value="material">Material</option></select></td>
    <td><input name="fabric_code" placeholder="fabric name / code, or item" style="width:100%"></td>
    <td><input name="description" placeholder="material description (optional)" style="width:100%"></td>
    <td><input name="qty" type="number" step="0.1" min="0" style="width:80px"></td>
    <td><select name="uom"><option>m</option><option>pc</option><option>roll</option><option>set</option></select></td>
    <td><button class="btn sm ghost" data-del title="Remove this line">✕</button></td></tr>`;
}

export function openReceive(onDone) {
  const m = modal(`<h3>Receive without a PO</h3>
    <p class="muted" style="margin:4px 0 10px">For fabric or material that arrived before the PO email. When the PO comes in, each line is matched to it and marked received there by itself.</p>
    <div class="grid2"><div><label class="f">Order no.</label><input name="order" placeholder="e.g. 79500"></div>
      <div><label class="f">Purchase order (if you have it)</label><input name="po" placeholder="PO-2026…"></div></div>
    <div class="scrollx" style="margin-top:8px"><table class="dense"><thead><tr><th>Type</th><th>Fabric / item</th><th>Description</th><th>Qty</th><th>Unit</th><th></th></tr></thead>
      <tbody data-lines>${lineRow()}</tbody></table></div>
    <button class="btn sm" data-addline style="margin-top:6px">＋ Another line</button>
    <div data-known class="muted" style="font-size:12px;margin-top:6px"></div>
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:10px"><button class="btn ghost" data-no>Cancel</button><button class="btn primary" data-yes>📥 Receive</button></div>`);
  m.sheet.classList.add("wide");
  const tb = m.sheet.querySelector("[data-lines]");
  const wire = () => tb.querySelectorAll("tr.mrline").forEach((tr) => {
    tr.querySelector("[data-del]").onclick = () => { if (tb.children.length > 1) tr.remove(); };
    tr.querySelector("[name=grain]").onchange = (e) => { tr.querySelector("[name=uom]").value = e.target.value === "material" ? "pc" : "m"; };
  });
  wire();
  m.sheet.querySelector("[data-addline]").onclick = () => { tb.insertAdjacentHTML("beforeend", lineRow()); wire(); };
  // if the PO is already in the app, say so: the normal receiving screen is the right place then
  m.sheet.querySelector("[name=order]").addEventListener("change", async (e) => {
    const id = e.target.value.trim(), k = m.sheet.querySelector("[data-known]");
    if (!id) { k.textContent = ""; return; }
    try {
      const ex = await api(`/rest/v1/receiving_expectations?select=id,grain,fabric_code,item_description,status&order_id=eq.${encodeURIComponent(id)}`) || [];
      k.textContent = ex.length ? `This order's PO is already in the app (${ex.length} line${ex.length > 1 ? "s" : ""} to receive). Lines typed here are matched to it straight away.` : "No PO for this order in the app yet - the lines will wait for it.";
    } catch (err) { k.textContent = ""; }
  });
  m.sheet.querySelector("[data-no]").onclick = m.close;
  m.sheet.querySelector("[data-yes]").onclick = async () => {
    const order = m.sheet.querySelector("[name=order]").value.trim();
    if (!order) { m.sheet.querySelector("[name=order]").focus(); return; }
    const items = [...tb.querySelectorAll("tr.mrline")].map((tr) => {
      const g = (n) => tr.querySelector(`[name=${n}]`).value;
      return { grain: g("grain") === "material" ? "material" : "order_fabric", fabric_code: g("fabric_code"), description: g("description"), qty: g("qty"), uom: g("uom") };
    }).filter((x) => x.fabric_code.trim() || x.description.trim());
    if (!items.length) { toast("Type at least one fabric or material", "bad"); return; }
    try {
      const r = await rpc("fn_manual_receive", { p_order: order, p_po: m.sheet.querySelector("[name=po]").value, p_items: items });
      toast(`${r.saved} line(s) received for ${order}${r.matched ? ` · ${r.matched} matched to the PO already` : " · waiting for the PO"}`, "ok");
      m.close(); if (onDone) onDone();
    } catch (e) { toast(e.message || String(e), "bad"); }
  };
}
