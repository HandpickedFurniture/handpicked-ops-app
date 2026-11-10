/* ISR - issue resolution (#/isr), part of Production. 10 Nov 2026 (user).
 *
 * One card per issue. Two people feed it:
 *   the INSTALLATION coordinator writes the issue - order, type, source, what it is, what is coming
 *     back from site (curtain / blind / track) and what new has to arrive (fabric / blind / track /
 *     motor ...);
 *   the PRODUCTION coordinator ticks it off - received back, ready, and "return to the fabric
 *     supplier" when something has to go back.
 * Readiness (waiting -> received back -> ready) is what the installation coordinator filters on in
 * Stage 2 of the Step scheduler, where a card is dragged onto a team's day (fn_isr_schedule).
 *
 * Every write is a fn_isr_* function (SQL 20261110_live_isr_receipts_tailors.sql); the tables are
 * read-only to the browser. The history of a card (isr_event) names who did what.
 */
import { api, apiAll, rpc, isSignedIn, isViewer } from "./api.js";
import { esc, el, toast, loading, modal, fmtDate, fmtDateTime, today } from "./ui.js";

export const ISR_TYPES = [
  ["on_the_spot", "On the spot"], ["new_fabric", "New fabric"], ["planned_alteration", "Planned alteration"],
  ["unplanned_alteration", "Unplanned alteration"], ["others", "Others"]];
export const ISR_SOURCES = [
  ["production", "Production issue"], ["installation", "Installation issue"], ["consultation", "Consultation issue"],
  ["client_change_of_mind", "Client change of mind"], ["fabric", "Fabric issue"], ["others_kurtains", "Others - Kurtains"]];
const label = (list, v) => (list.find((x) => x[0] === v) || [v, v || "—"])[1];
const READY = { waiting: ["Waiting", "warn"], received: ["Received back", "info"], ready: ["Ready", "ok"] };
const STATUS = { open: ["Open", "warn"], scheduled: ["Scheduled", "info"], done: ["Done", "ok"], cancelled: ["Cancelled", "mute"] };
const chipH = (t, tone) => `<span class="chip ${tone || "mute"}">${esc(t)}</span>`;
const who = (e) => String(e || "").split("@")[0];

let F = { status: "active", readiness: "", city: "", type: "", source: "", q: "" };

export async function render(mount) {
  if (!isSignedIn()) return;
  mount.innerHTML = `<div class="sectionbar"><div class="subtabs"><a href="#/production">✂️ Production</a><button class="on">🔁 ISR · all orders</button></div></div>
    <div class="card isrhead"></div><div id="isrlist"></div>`;
  const head = mount.querySelector(".isrhead"), list = mount.querySelector("#isrlist");
  const sel = (name, opts, cur) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  head.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">ISR · issue resolution</h3>
      ${isViewer() ? "" : `<button class="btn primary" data-new>＋ New ISR</button>`}</div>
    <div class="fgrid" style="margin-top:8px">
      <div><label class="f">Status</label>${sel("status", [["active", "Open + scheduled"], ["open", "Open"], ["scheduled", "Scheduled"], ["done", "Done"], ["cancelled", "Cancelled"], ["", "All"]], F.status)}</div>
      <div><label class="f">Readiness</label>${sel("readiness", [["", "Any"], ["waiting", "Waiting"], ["received", "Received back"], ["ready", "Ready"], ["return", "To return to supplier"]], F.readiness)}</div>
      <div><label class="f">City</label>${sel("city", [["", "Both"], ["Dubai", "Dubai"], ["Abu Dhabi", "Abu Dhabi"]], F.city)}</div>
      <div><label class="f">Type</label>${sel("type", [["", "Any"], ...ISR_TYPES], F.type)}</div>
      <div><label class="f">Source</label>${sel("source", [["", "Any"], ...ISR_SOURCES], F.source)}</div>
      <div><label class="f">Search</label><input name="q" value="${esc(F.q)}" placeholder="order, customer, issue"></div>
    </div>`;
  head.querySelectorAll("select,input").forEach((i) => i.addEventListener(i.tagName === "INPUT" ? "input" : "change", () => {
    F[i.name] = i.value; paintList(list);
  }));
  const nb = head.querySelector("[data-new]");
  if (nb) nb.addEventListener("click", () => editCase(null, () => load(list)));
  await load(list);
}

let ROWS = [];
async function load(list) {
  loading(true, "Loading ISR…");
  try { ROWS = await apiAll("/rest/v1/v_isr_cases?select=*&order=id.desc"); }
  catch (e) { loading(false); list.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`; return; }
  loading(false);
  paintList(list);
}
function paintList(list) {
  const q = F.q.trim().toLowerCase();
  const rows = ROWS.filter((r) =>
    (F.status === "" || (F.status === "active" ? ["open", "scheduled"].includes(r.status) : r.status === F.status)) &&
    (!F.readiness || (F.readiness === "return" ? r.return_supplier : r.readiness === F.readiness)) &&
    (!F.city || r.city_any === F.city) && (!F.type || r.isr_type === F.type) && (!F.source || r.source === F.source) &&
    (!q || [r.order_id, r.customer_any, r.issue, r.expected_back, r.expected_new].join(" ").toLowerCase().includes(q)));
  const cnt = (k) => ROWS.filter((r) => ["open", "scheduled"].includes(r.status) && r.readiness === k).length;
  list.innerHTML = `<div class="muted" style="margin:4px 2px 8px">${rows.length} shown · open: ${cnt("waiting")} waiting, ${cnt("received")} received back, ${cnt("ready")} ready</div>`;
  if (!rows.length) { list.appendChild(el(`<div class="card"><span class="muted">No ISR matches.</span></div>`)); return; }
  rows.forEach((r) => list.appendChild(card(r, () => load(list))));
}

function card(r, reload) {
  const rd = READY[r.readiness] || READY.waiting, st = STATUS[r.status] || STATUS.open, ro = isViewer();
  const tick = (flag, on, text, by, at) => `<button class="btn sm ${on ? "accent" : ""}" data-flag="${flag}" data-on="${on ? 0 : 1}" ${ro ? "disabled" : ""}
      title="${on && by ? esc(who(by) + " · " + fmtDateTime(at)) : ""}">${on ? "✓ " : "☐ "}${text}</button>`;
  const c = el(`<div class="card isrcase">
    <div class="spread"><div><b>ISR #${r.id} · ${esc(r.order_id)}</b> ${esc(r.customer_any || "")} <span class="muted">${esc(r.city_any || "")}</span></div>
      <div>${chipH(rd[0], rd[1])} ${chipH(st[0], st[1])}${r.return_supplier ? " " + chipH("Return to supplier", "bad") : ""}</div></div>
    <div class="muted" style="font-size:12.5px;margin:2px 0">${esc(label(ISR_TYPES, r.isr_type))} · ${esc(label(ISR_SOURCES, r.source))}
      · raised by ${esc(who(r.created_by))} ${esc(fmtDate(r.created_at))}${r.sched_day ? ` · <b>scheduled ${esc(fmtDate(r.sched_day))}${r.sched_city ? " " + esc(r.sched_city) : ""}${r.sched_team ? ", Team " + r.sched_team : ""}</b>` : ""}</div>
    <div class="isrtext">${esc(r.issue)}</div>
    <div class="grid2" style="margin-top:6px">
      <div><label class="f">Coming back from site</label><div>${r.expected_back ? esc(r.expected_back) : `<span class="muted">—</span>`}</div></div>
      <div><label class="f">New to arrive</label><div>${r.expected_new ? esc(r.expected_new) : `<span class="muted">—</span>`}</div></div></div>
    ${r.return_supplier && r.return_note ? `<div class="banner warn" style="margin-top:6px">Return to supplier: ${esc(r.return_note)}</div>` : ""}
    <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
      <span class="muted" style="font-size:12px">Production:</span>
      ${tick("received", r.received, "Received", r.received_by, r.received_at)}
      ${tick("ready", r.ready, "Ready", r.ready_by, r.ready_at)}
      ${tick("return_supplier", r.return_supplier, "Return to supplier", r.return_by, r.return_at)}
      <span style="flex:1"></span>
      <a class="btn sm" href="#/stepper?date=${esc(r.sched_day || "")}&city=${esc(r.city_any || "Dubai")}" title="Open the Step scheduler; in Stage 2 drag the ISR card onto a team">🧭 Plan in scheduler</a>
      ${ro ? "" : `<button class="btn sm" data-edit>Edit</button>
      ${["open", "scheduled"].includes(r.status) ? `<button class="btn sm" data-flag="done" data-on="1">✓ Done</button><button class="btn sm ghost" data-flag="cancelled" data-on="1">Cancel</button>`
        : `<button class="btn sm" data-flag="reopen" data-on="1">↺ Reopen</button>`}`}
      <button class="btn sm ghost" data-hist>History</button>
    </div><div class="isrhist" hidden></div></div>`);
  c.querySelectorAll("[data-flag]").forEach((b) => b.addEventListener("click", async () => {
    const flag = b.dataset.flag, on = b.dataset.on === "1";
    let note = null;
    if (flag === "return_supplier" && on) {
      note = await ask("What goes back to the supplier, and why?", r.return_note || "");
      if (note === null) return;
    }
    try { await rpc("fn_isr_flag", { p_id: r.id, p_flag: flag, p_on: on, p_note: note }); toast("Saved", "ok"); reload(); }
    catch (e) { toast(e.message || String(e), "bad"); }
  }));
  const eb = c.querySelector("[data-edit]");
  if (eb) eb.addEventListener("click", () => editCase(r, reload));
  c.querySelector("[data-hist]").addEventListener("click", async () => {
    const h = c.querySelector(".isrhist");
    if (!h.hidden) { h.hidden = true; return; }
    h.hidden = false; h.innerHTML = `<span class="muted">Loading…</span>`;
    try {
      const ev = await api(`/rest/v1/isr_event?select=at,who,kind,detail&isr_id=eq.${r.id}&order=at.desc`) || [];
      h.innerHTML = ev.map((e) => `<div><span class="muted">${esc(fmtDateTime(e.at))}</span> <b>${esc(who(e.who))}</b> · ${esc(evText(e))}</div>`).join("") || `<span class="muted">Nothing yet</span>`;
    } catch (e) { h.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  });
  return c;
}
function evText(e) {
  const d = e.detail || {}, on = d.on ? "ticked" : "unticked";
  switch (e.kind) {
    case "created": return "raised the ISR";
    case "edited": return "edited the details";
    case "received": return `${on} received back`;
    case "ready": return `${on} ready`;
    case "return_supplier": return `${on} return to supplier${d.note ? ": " + d.note : ""}`;
    case "done": return d.on ? "marked done" : "reopened";
    case "cancelled": return d.on ? "cancelled" : "reopened";
    case "reopen": return "reopened";
    case "scheduled": return `scheduled ${d.day || ""} ${d.city || ""}${d.team ? ", Team " + d.team : ""}`;
    case "unscheduled": return "taken off the schedule";
    default: return e.kind;
  }
}
function ask(title, val) {
  return new Promise((resolve) => {
    const m = modal(`<h3>${esc(title)}</h3><textarea name="t" rows="3" style="width:100%;margin:10px 0">${esc(val || "")}</textarea>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>Cancel</button><button class="btn primary" data-yes>Save</button></div>`);
    m.sheet.querySelector("[data-no]").onclick = () => { m.close(); resolve(null); };
    m.sheet.querySelector("[data-yes]").onclick = () => { const v = m.sheet.querySelector("[name=t]").value; m.close(); resolve(v); };
  });
}

/* One order's ISR cases, for the ISR tab inside the order's details (Production). Same cards and the
 * same controls as the full list; "+ New ISR" starts with this order filled in. */
export function orderIsrPanel(orderId) {
  const box = el(`<div class="dsec"><div class="spread"><h4>ISR · issue resolution</h4>
      ${isViewer() ? "" : `<button class="btn sm primary" data-new>＋ New ISR for ${esc(orderId)}</button>`}</div>
    <div data-list><span class="muted">Loading…</span></div>
    <div class="muted" style="font-size:12px;margin-top:6px">Every open ISR is also in Stage 2 of the Step scheduler, to drag onto a team.</div></div>`);
  const list = box.querySelector("[data-list]");
  const load1 = async () => {
    let rows = [];
    try { rows = await api(`/rest/v1/v_isr_cases?select=*&order_id=eq.${encodeURIComponent(orderId)}&order=id.desc`) || []; }
    catch (e) { list.innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }
    list.innerHTML = rows.length ? "" : `<span class="muted">No ISR for this order.</span>`;
    rows.forEach((r) => list.appendChild(card(r, load1)));
  };
  const nb = box.querySelector("[data-new]");
  if (nb) nb.addEventListener("click", async () => {
    const preset = { order_id: orderId };
    try {
      const s = (await api(`/rest/v1/v_installation_schedule_live?select=customer_name,city,address&order_id=eq.${encodeURIComponent(orderId)}&order=install_date.desc&limit=1`) || [])[0];
      if (s) Object.assign(preset, { customer: s.customer_name, city: s.city, address: s.address });
    } catch (e) { /* typed by hand then */ }
    editCase(null, load1, preset);
  });
  load1();
  return box;
}

/* New / edit. The order number fills customer, city and address from the latest 3D sheet row (else the
 * order roster), so the installation coordinator types the issue, not the address book. */
function editCase(r, reload, preset) {
  const v = r || Object.assign({ isr_type: "on_the_spot", source: "installation" }, preset || {});
  const opt = (list, cur) => list.map(([k, l]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(l)}</option>`).join("");
  const m = modal(`<h3>${r ? `Edit ISR #${r.id}` : "New ISR"}</h3>
    <div class="grid2" style="margin-top:8px">
      <div><label class="f">Order no.</label><input name="order_id" value="${esc(v.order_id || "")}" placeholder="e.g. 79500"></div>
      <div><label class="f">Customer</label><input name="customer" value="${esc(v.customer || v.customer_any || "")}"></div>
      <div><label class="f">City</label><select name="city"><option value="">—</option>${["Dubai", "Abu Dhabi"].map((c) => `<option ${c === (v.city || v.city_any) ? "selected" : ""}>${c}</option>`).join("")}</select></div>
      <div><label class="f">Address</label><input name="address" value="${esc(v.address || "")}"></div>
      <div><label class="f">Type of ISR</label><select name="isr_type">${opt(ISR_TYPES, v.isr_type)}</select></div>
      <div><label class="f">Source of the issue</label><select name="source">${opt(ISR_SOURCES, v.source)}</select></div>
    </div>
    <label class="f" style="margin-top:8px">The issue</label><textarea name="issue" rows="3" style="width:100%">${esc(v.issue || "")}</textarea>
    <div class="grid2">
      <div><label class="f">Coming back from site (curtain / blind / track)</label><textarea name="expected_back" rows="2" style="width:100%">${esc(v.expected_back || "")}</textarea></div>
      <div><label class="f">New to arrive (fabric / blind / track / motor ...)</label><textarea name="expected_new" rows="2" style="width:100%">${esc(v.expected_new || "")}</textarea></div>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:10px;gap:8px"><span class="muted" data-msg style="margin-right:auto"></span>
      <button class="btn ghost" data-no>Cancel</button><button class="btn primary" data-yes>Save</button></div>`);
  m.sheet.classList.add("wide", "isrform");
  const g = (n) => m.sheet.querySelector(`[name="${n}"]`);
  g("order_id").addEventListener("change", async () => {
    const id = g("order_id").value.trim(); if (!id || (g("customer").value && g("address").value)) return;
    try {
      const s = (await api(`/rest/v1/v_installation_schedule_live?select=customer_name,city,address,install_date&order_id=eq.${encodeURIComponent(id)}&order=install_date.desc&limit=1`) || [])[0];
      const o = s || (await api(`/rest/v1/v_ops_order_roster?select=customer_name,city&order_id=eq.${encodeURIComponent(id)}`) || [])[0];
      if (!o) { m.sheet.querySelector("[data-msg]").textContent = "Order not found in the app - fill the details in"; return; }
      if (!g("customer").value) g("customer").value = o.customer_name || "";
      if (!g("city").value && o.city) g("city").value = o.city;
      if (!g("address").value && o.address) g("address").value = o.address;
      m.sheet.querySelector("[data-msg]").textContent = s ? `From the 3D sheet (${s.install_date})` : "From the order";
    } catch (e) { /* typed by hand then */ }
  });
  // opened from an order: fill what is still blank from the 3D sheet, else the order itself
  if (!r && v.order_id) g("order_id").dispatchEvent(new Event("change"));
  m.sheet.querySelector("[data-no]").onclick = m.close;
  m.sheet.querySelector("[data-yes]").onclick = async () => {
    const p = { id: r ? r.id : null };
    ["order_id", "customer", "city", "address", "isr_type", "source", "issue", "expected_back", "expected_new"].forEach((k) => { p[k] = g(k).value; });
    if (!p.order_id.trim()) { g("order_id").focus(); return; }
    if (!p.issue.trim()) { g("issue").focus(); return; }
    try { await rpc("fn_isr_save", { p }); toast("ISR saved", "ok"); m.close(); reload(); }
    catch (e) { toast(e.message || String(e), "bad"); }
  };
}
