/* Stage 4 of the Step scheduler (#/stepper): the LIVE day, 26 Oct 2026.
 *
 * Stage 3 publishes the plan (fn_live_publish). From then on the day lives in the database
 * (live_team / live_order / live_event / live_adjustment, SQL 20261026_stage4_live.sql), so every
 * signed-in user sees the same board and a refresh loses nothing. Every change goes through a
 * fn_live_* function; this file never writes a table directly.
 *
 *   status        pending -> in progress -> completed / partial / failed / rescheduled
 *   timing        move one order's start; later jobs of the team can follow by the same minutes
 *   orders        add (from the 3D sheet's held list or typed in), move to another team, remove
 *   notes         per order and per team
 *   adjustments   booked through fn_ops_add_adjustment (rate card, city visit price); the agent's
 *                 `sheet_sync.py --live` writes them to the partner Adjustments tab, one row per order
 *
 * The board polls every 20 s while the tab is open, so a status set on another phone shows up here.
 */
import { api, rpc, isViewer } from "./api.js";
import { toast } from "./ui.js";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const mins = s => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || "")); return m ? +m[1] * 60 + +m[2] : null; };
const hm = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(Math.round(m % 60)).padStart(2, "0");
const PALETTE = ["#1f6fb4","#d6392b","#2e9447","#8a4fc7","#e08a12","#138e9c","#9b5a34","#d64d9f","#5b6c7d","#8f9a1c","#3a4ec2","#c23a6a"];
const teamColor = n => PALETTE[(Number(n) - 1 + PALETTE.length * 10) % PALETTE.length];

const STATUS = {
  pending:     {label: "Not started", cls: ""},
  in_progress: {label: "In progress", cls: "warn"},
  completed:   {label: "Completed", cls: "good"},
  partial:     {label: "Partially completed", cls: "warn"},
  failed:      {label: "Failed", cls: "bad"},
  rescheduled: {label: "Rescheduled", cls: "bad"},
  removed:     {label: "Removed", cls: ""},
};
const DONE = new Set(["completed", "partial", "failed", "rescheduled", "removed"]);

let CX = null;                       // {root, day, city, held(), payload()}
let LV = {key: "", teams: [], orders: [], adjs: [], events: [], charges: null, at: null, err: "", busy: false, showLog: false, showOff: false};
let timer = null, ticker = null;

const $ = id => CX.root.querySelector("#stp-" + id);
const key = () => CX.day + "|" + CX.city;
const nowMin = () => { const d = new Date(Date.now() + (4 * 60 + new Date().getTimezoneOffset()) * 60000); return d.getHours() * 60 + d.getMinutes(); };   // Dubai
const isToday = () => CX.day === new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);

/* ---------------- data ---------------- */
async function fetchAll(){
  const q = `day=eq.${CX.day}&city=eq.${encodeURIComponent(CX.city)}`;
  const [teams, orders, adjs, events] = await Promise.all([
    api(`/rest/v1/live_team?select=*&${q}&order=team.asc`),
    api(`/rest/v1/live_order?select=*&${q}&order=team.asc.nullsfirst,seq.asc`),
    api(`/rest/v1/v_live_adjustments?select=*&${q}&order=created_at.asc`),
    api(`/rest/v1/live_event?select=*&${q}&order=at.desc&limit=40`),
  ]);
  return {teams: teams || [], orders: orders || [], adjs: adjs || [], events: events || []};
}
async function refresh(quiet){
  if (!CX || LV.busy) return;
  const k = key();
  try {
    const d = await fetchAll();
    if (k !== key()) return;                                  // the user changed day or city meanwhile
    Object.assign(LV, d, {key: k, at: new Date(), err: ""});
  } catch (e) { LV.err = (e && e.message) || "Could not load the live day"; }
  if (!quiet || document.activeElement === document.body || !CX.root.contains(document.activeElement)) paint();
  else paintCounts();
}
async function loadCharges(){
  if (LV.charges) return LV.charges;
  const rows = await api("/rest/v1/adjustment_rate_card?select=charge_type,label,unit,rate_aed,city,free_qty&active=eq.true&effective_to=is.null&order=charge_type.asc") || [];
  const by = {};
  rows.forEach(r => { (by[r.charge_type] = by[r.charge_type] || []).push(r); });
  LV.charges = by; return by;
}
async function call(fn, args, done){
  if (isViewer()){ toast("Your role can look but not change the live day", "bad"); return false; }
  LV.busy = true;
  try { const r = await rpc(fn, args); LV.busy = false; await refresh(); if (done) toast(done); return r === undefined ? true : r; }
  catch (e) { LV.busy = false; toast((e && e.message) || "That did not save", "bad"); return false; }
}

/* ---------------- publishing (Stage 3's button) ---------------- */
export async function publish(P){
  const teams = P.teams.map(t => ({team: t.team, name: t.name, members: t.members, leave: t.leave, note: t.note}));
  const orders = [];
  P.teams.forEach(t => t.orders.forEach((o, i) => orders.push({order_id: o.order_id, team: t.team, seq: i, customer: o.customer, phone: o.phone,
    address: o.address, emaar: o.emaar, lat: o.lat, lng: o.lng, appt_time: o.time, plan_start: o.planned_start, plan_end: o.planned_end,
    est_min: o.est_min, scope: o.scope, note: o.note})));
  return rpc("fn_live_publish", {p_day: P.date, p_city: P.city, p_teams: teams, p_orders: orders});
}

/* ---------------- rendering ---------------- */
const byTeam = () => {
  const m = new Map();
  LV.teams.forEach(t => m.set(t.team, {t, os: []}));
  LV.orders.filter(o => o.status !== "removed").forEach(o => {
    const k = o.team == null ? 0 : o.team;
    if (!m.has(k)) m.set(k, {t: {team: k, name: k ? "Team " + k : "On no team", members: [], note: ""}, os: []});
    m.get(k).os.push(o);
  });
  return [...m.values()].filter(x => x.os.length || x.t.team);
};
function lateInfo(o){
  if (!isToday()) return "";
  const n = nowMin(), ps = mins(o.plan_start), pe = mins(o.plan_end);
  if (o.status === "pending" && ps != null && n > ps + 10) return `<span class="chip bad" title="planned start ${esc(o.plan_start)}">not started, ${n - ps} min past its start</span>`;
  if (o.status === "in_progress" && pe != null && n > pe + 10) return `<span class="chip warn" title="planned finish ${esc(o.plan_end)}">running ${n - pe} min over</span>`;
  return "";
}
function adjHtml(o){
  const a = LV.adjs.filter(x => x.order_id === o.order_id);
  if (!a.length) return "";
  return `<div class="ladj">${a.map(x => {
    const st = x.sheet_updated ? `<span class="chip good" title="${esc(x.sheet_row_ref || "")}">on the 3D sheet</span>`
      : x.sheet_hold_reason ? `<span class="chip bad" title="${esc(x.sheet_hold_reason)}">held: ${esc(x.sheet_hold_reason)}</span>`
      : x.chargeable ? `<span class="chip warn">queued for the sheet</span>` : `<span class="chip">not charged</span>`;
    return `<div>💰 <b>AED ${Number(x.amount_aed).toLocaleString("en-AE")}</b> ${esc(String(x.charge_type).replace(/_/g, " "))}${Number(x.quantity) !== 1 ? " ×" + Number(x.quantity) : ""} — ${esc(String(x.reason || "").split("\n").filter(Boolean).slice(-1)[0] || "")} ${st}</div>`;
  }).join("")}</div>`;
}
function orderHtml(o, off){
  const s = STATUS[o.status] || STATUS.pending, ro = isViewer() || off;
  const times = `${esc(o.plan_start || "—")}–${esc(o.plan_end || "—")}`;
  const apptNote = o.appt_time && o.appt_time !== o.plan_start ? ` <span class="muted" title="appointment on the 3D sheet">appt ${esc(o.appt_time)}</span>` : "";
  const btn = (act, label, extra) => `<button class="btn small ${extra || ""}" data-lv="${act}" data-id="${esc(o.order_id)}" ${ro ? "disabled" : ""}>${label}</button>`;
  return `<li class="lo st-${o.status}" data-oid="${esc(o.order_id)}">
    <div class="lo-top"><span class="lt">${times}</span><span class="lj"><b>${esc(o.order_id)}</b> ${esc(o.customer || "")}</span>
      ${o.emaar ? `<span class="chip emaar">E</span>` : ""}${o.added_live ? `<span class="chip hot">added live</span>` : ""}
      <span class="chip ${s.cls}">${s.label}</span>${lateInfo(o)}${apptNote}</div>
    <div class="ja">${esc(o.address || "")}${o.phone ? ` · <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>` : ""}</div>
    ${o.scope ? `<div class="jw">${esc(o.scope)}</div>` : ""}
    ${o.reason ? `<div class="lreason">${o.status === "removed" ? "Removed" : s.label}: ${esc(o.reason)}${o.resched_to ? ` → <b>${esc(o.resched_to)}</b>` : ""}</div>` : ""}
    ${adjHtml(o)}
    <div class="lnote"><input data-lnote="${esc(o.order_id)}" value="${esc(o.note || "")}" placeholder="Note" ${ro ? "disabled" : ""} aria-label="Note for ${esc(o.order_id)}"></div>
    ${off ? "" : `<div class="lacts">
      ${o.status === "pending" || o.status === "failed" ? btn("start", "▶ Start") : ""}
      ${o.status !== "completed" ? btn("done", "✓ Done", "okb") : ""}
      ${btn("partial", "½ Partial")}${btn("failed", "✕ Failed")}${btn("resched", "↻ Reschedule")}
      ${o.status !== "pending" && o.status !== "in_progress" ? btn("reopen", "↺ Reopen") : ""}
      <span class="sep"></span>${btn("time", "🕒 Time")}${btn("adj", "＋ Adjustment")}${btn("move", "↔ Team")}${btn("remove", "🗑")}
    </div>`}
  </li>`;
}
function countsHtml(){
  const c = {}; LV.orders.forEach(o => { c[o.status] = (c[o.status] || 0) + 1; });
  const live = LV.orders.filter(o => o.status !== "removed").length, done = LV.orders.filter(o => o.status === "completed").length;
  const chip = (k, cls) => c[k] ? `<span class="chip ${cls}">${c[k]} ${STATUS[k].label.toLowerCase()}</span>` : "";
  const money = LV.adjs.filter(a => a.chargeable).reduce((x, a) => x + Number(a.amount_aed || 0), 0);
  return `<b>${done}/${live} done</b> <span class="progress" style="width:120px;display:inline-block;margin:0 6px"><i style="width:${live ? Math.round(done / live * 100) : 0}%;background:var(--good)"></i></span>
    ${chip("pending", "")}${chip("in_progress", "warn")}${chip("completed", "good")}${chip("partial", "warn")}${chip("failed", "bad")}${chip("rescheduled", "bad")}
    ${LV.adjs.length ? `<span class="chip">💰 ${LV.adjs.length} adjustment${LV.adjs.length > 1 ? "s" : ""} · AED ${money.toLocaleString("en-AE")}</span>` : ""}`;
}
function paintCounts(){ const c = $("lcounts"); if (c) c.innerHTML = countsHtml(); const t = $("lstamp"); if (t) t.textContent = stamp(); }
const stamp = () => LV.at ? "updated " + LV.at.toLocaleTimeString("en-GB", {timeZone: "Asia/Dubai"}) + (isToday() ? " · refreshes every 20 s" : "") : "";

function paint(){
  const host = $("s4"); if (!host) return;
  if (LV.err){ host.innerHTML = `<div class="panel"><b>Could not load the live day.</b> ${esc(LV.err)}<br>
    <span class="muted">If this says a table is missing, the Stage 4 SQL (20261026_stage4_live.sql) has not been applied.</span> <button class="btn small" data-lv="reload">Try again</button></div>`; return; }
  if (!LV.teams.length && !LV.orders.length){
    const n = CX.payload ? CX.payload().teams.reduce((a, t) => a + t.orders.length, 0) : 0;
    host.innerHTML = `<div class="panel"><h2>No live schedule for ${esc(CX.city)} on ${esc(CX.day)} yet</h2>
      <p class="muted">Stage 4 shows the schedule you publish from Stage 3. ${n ? `Your Stage 3 plan has <b>${n}</b> jobs.` : "Your Stage 3 plan is empty - assign orders first."}</p>
      <button class="btn primary" data-lv="publish" ${n && !isViewer() ? "" : "disabled"}>📌 Publish the Stage 3 plan as the final schedule</button></div>`;
    return;
  }
  const teams = byTeam(), off = LV.orders.filter(o => o.status === "removed");
  host.innerHTML = `
    <div class="panel lbar">
      <span id="stp-lcounts">${countsHtml()}</span>
      <span class="lspacer"></span>
      <span class="muted" id="stp-lstamp">${esc(stamp())}</span>
      <button class="btn small" data-lv="reload" title="Reload now">↻</button>
      <button class="btn small" data-lv="addorder" ${isViewer() ? "disabled" : ""}>＋ Add order</button>
      <button class="btn small" data-lv="log">${LV.showLog ? "Hide" : "Show"} activity</button>
      <button class="btn small" data-lv="publish" title="Re-publish the Stage 3 plan: keeps every status and note already recorded" ${isViewer() ? "disabled" : ""}>📌 Re-publish plan</button>
    </div>
    ${LV.showLog ? `<div class="panel llog"><b>Activity</b><ul>${LV.events.map(e => `<li><span class="muted">${new Date(e.at).toLocaleTimeString("en-GB", {timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit"})}</span> ${esc((e.who || "").split("@")[0])} · ${esc(describe(e))}</li>`).join("") || "<li class='muted'>Nothing yet</li>"}</ul></div>` : ""}
    <div class="lteams">${teams.map(({t, os}) => `<div class="tcard lcard" style="--tc:${t.team ? teamColor(t.team) : "#8a94a3"}">
      <div class="th"><b>${esc(t.name)}</b>${(t.members || []).length && !t.members.every(m => String(t.name).includes(m)) ? ` <span class="muted">${esc(t.members.join(" & "))}</span>` : ""}
        <span class="lv">${t.leave_at ? "leave " + esc(t.leave_at) + " · " : ""}${os.filter(o => o.status === "completed").length}/${os.length} done</span></div>
      ${t.team ? `<input class="tnote" data-ltnote="${t.team}" value="${esc(t.note || "")}" placeholder="Note for the team" ${isViewer() ? "disabled" : ""}>` : ""}
      <ul class="ljobs">${os.map(o => orderHtml(o, false)).join("")}</ul></div>`).join("")}</div>
    ${off.length ? `<div class="panel" style="margin-top:8px"><button class="lnk" data-lv="showoff">${LV.showOff ? "▾" : "▸"} ${off.length} removed from the day</button>
      ${LV.showOff ? `<ul class="ljobs">${off.map(o => orderHtml(o, true)).join("")}</ul>` : ""}</div>` : ""}`;
}
function describe(e){
  const d = e.detail || {}, o = e.order_id ? e.order_id + " " : "";
  switch (e.kind){
    case "publish": return `published the plan (${d.new || 0} new, ${d.updated || 0} refreshed)`;
    case "status": return `${o}→ ${(STATUS[d.status] || {}).label || d.status}${d.reason ? " (" + d.reason + ")" : ""}${d.resched_to ? " to " + d.resched_to : ""}`;
    case "retime": return `${o}start ${d.from || "?"} → ${d.to}${d.cascade ? ` (${d.moved} job${d.moved > 1 ? "s" : ""} moved)` : ""}`;
    case "add": return `${o}added to Team ${e.team ?? "-"} at ${d.start}`;
    case "remove": return `${o}removed${d.reason ? " (" + d.reason + ")" : ""}`;
    case "move": return `${o}moved Team ${d.from ?? "-"} → Team ${d.to ?? "-"}`;
    case "note": return `${o}note: ${d.note || "(cleared)"}`;
    case "team_note": return `Team ${e.team} note: ${d.note || "(cleared)"}`;
    case "adjustment": return `${o}adjustment ${String(d.charge_type || "").replace(/_/g, " ")}${d.amount != null ? " AED " + d.amount : ""}: ${d.reason || ""}`;
    default: return e.kind;
  }
}

/* ---------------- dialogs ---------------- */
function dialog(html){
  const box = $("addbody"); box.innerHTML = html; $("addpanel").hidden = false;
  const close = () => { $("addpanel").hidden = true; box.innerHTML = ""; };
  box.querySelectorAll("[data-lvclose]").forEach(b => b.addEventListener("click", close));
  return {box, close};
}
const order = id => LV.orders.find(o => o.order_id === id);
function ask(id, status){
  const o = order(id), need = status !== "completed" && status !== "in_progress" && status !== "pending";
  const tom = new Date(Date.now() + 28 * 3600e3).toISOString().slice(0, 10);
  const d = dialog(`<h2 style="margin:0 0 6px">${esc(STATUS[status].label)}: ${esc(id)} ${esc(o.customer || "")}</h2>
    ${need ? `<label class="lf">Why? <input id="lv-reason" placeholder="${status === "rescheduled" ? "e.g. customer not home, wants Thursday" : status === "failed" ? "e.g. wrong size delivered, access refused" : "e.g. 2 windows left, fabric short"}"></label>` : ""}
    ${status === "rescheduled" ? `<label class="lf">New date <input id="lv-date" type="date" value="${tom}" min="${CX.day}"></label>` : ""}
    <div class="muted" style="font-size:12px;margin:6px 0">${status === "failed" || status === "partial" || status === "rescheduled" ? "You can add an adjustment (extra visit, alteration…) from the order afterwards." : ""}</div>
    <div class="lbtns"><button class="btn primary" id="lv-ok">Save</button><button class="btn" data-lvclose>Cancel</button></div>`);
  d.box.querySelector("#lv-ok").addEventListener("click", async () => {
    const reason = need ? d.box.querySelector("#lv-reason").value.trim() : null, date = status === "rescheduled" ? d.box.querySelector("#lv-date").value : null;
    if (need && !reason) { d.box.querySelector("#lv-reason").focus(); return; }
    const ok = await call("fn_live_set_status", {p_day: CX.day, p_city: CX.city, p_order: id, p_status: status, p_reason: reason, p_resched_to: date});
    if (ok){ d.close(); if (status !== "completed") offerAdjustment(id, status); }
  });
  setTimeout(() => { const f = d.box.querySelector("input"); if (f) f.focus(); }, 0);
}
// a failed visit or a rescheduled job usually costs something: ask once, never charge on our own
function offerAdjustment(id, status){
  if (!["failed", "rescheduled", "partial"].includes(status)) return;
  const d = dialog(`<h2 style="margin:0 0 6px">Charge anything for ${esc(id)}?</h2>
    <p class="muted" style="margin:0 0 8px">Production or installation defects are absorbed (AED 0). Customer no-show, change of mind or an extra visit can be charged.</p>
    <div class="lbtns"><button class="btn primary" id="lv-yes">＋ Add an adjustment</button><button class="btn" data-lvclose>No, nothing to charge</button></div>`);
  d.box.querySelector("#lv-yes").addEventListener("click", () => { d.close(); adjustment(id); });
}
function retime(id){
  const o = order(id), later = LV.orders.filter(x => x.team === o.team && x.seq > o.seq && ["pending", "in_progress"].includes(x.status)).length;
  const d = dialog(`<h2 style="margin:0 0 6px">Change the time: ${esc(id)} ${esc(o.customer || "")}</h2>
    <div class="muted">Planned ${esc(o.plan_start)}–${esc(o.plan_end)} · appointment ${esc(o.appt_time || "—")}</div>
    <div class="lquick">${[-30, -15, 15, 30, 60].map(m => `<button class="btn small" data-lvd="${m}">${m > 0 ? "+" : ""}${m} min</button>`).join("")}</div>
    <label class="lf">New start <input id="lv-start" type="time" value="${esc(o.plan_start || "")}"></label>
    <label class="lchk"><input type="checkbox" id="lv-casc" checked> Move the ${later} later job${later === 1 ? "" : "s"} of this team by the same minutes</label>
    <div class="muted" style="font-size:12px">The customer's appointment on the 3D sheet is not changed here; tell the customer and the sheet owner if they were promised a time.</div>
    <div class="lbtns"><button class="btn primary" id="lv-ok">Save</button><button class="btn" data-lvclose>Cancel</button></div>`);
  d.box.querySelectorAll("[data-lvd]").forEach(b => b.addEventListener("click", () => { const s = mins(d.box.querySelector("#lv-start").value); if (s != null) d.box.querySelector("#lv-start").value = hm(Math.max(0, s + Number(b.dataset.lvd))); }));
  d.box.querySelector("#lv-ok").addEventListener("click", async () => {
    const v = d.box.querySelector("#lv-start").value; if (!v) return;
    if (await call("fn_live_retime", {p_day: CX.day, p_city: CX.city, p_order: id, p_start: v, p_cascade: d.box.querySelector("#lv-casc").checked}, "Time changed")) d.close();
  });
}
async function adjustment(id){
  let ch; try { ch = await loadCharges(); } catch (e) { toast("Could not load the rate card", "bad"); return; }
  const types = Object.keys(ch);
  const opt = t => { const r = ch[t].find(x => x.city === CX.city) || ch[t].find(x => !x.city) || ch[t][0]; return `<option value="${esc(t)}">${esc(String(r.label).replace(/\s*\((Dubai|Abu Dhabi)\)$/, ""))}</option>`; };
  const d = dialog(`<h2 style="margin:0 0 6px">Adjustment: ${esc(id)} ${esc((order(id) || {}).customer || "")}</h2>
    <label class="lf">Type <select id="lv-type">${types.map(opt).join("")}</select></label>
    <div class="formgrid"><label>Quantity <input id="lv-qty" type="number" min="0" step="0.5" value="1"></label>
      <label>Amount AED <input id="lv-amt" type="number" min="0" step="1" placeholder="rate card"></label></div>
    <div id="lv-rate" class="muted" style="font-size:12.5px;margin:4px 0"></div>
    <label class="lf">What happened? <input id="lv-why" placeholder="e.g. customer not home at 10:00, 2nd visit needed"></label>
    <label class="lchk"><input type="checkbox" id="lv-chg" checked> Chargeable (untick to record it at AED 0 / not billed)</label>
    <div class="muted" style="font-size:12px">It is booked in the app now and written to the ${esc(CX.city)} partner "Adjustments" tab automatically - one row per order.</div>
    <div class="lbtns"><button class="btn primary" id="lv-ok">Add adjustment</button><button class="btn" data-lvclose>Cancel</button></div>`);
  const b = d.box, rate = async () => {
    try { const r = await rpc("fn_ops_rate_for", {p_charge_type: b.querySelector("#lv-type").value, p_qty: Number(b.querySelector("#lv-qty").value) || 1, p_order_id: id});
      const x = Array.isArray(r) ? r[0] : r; if (x) b.querySelector("#lv-rate").textContent = `Rate card: AED ${Number(x.amount_aed).toLocaleString("en-AE")}${x.label ? " (" + x.label + ")" : ""} - leave Amount empty to use it.`; } catch (e) {}
  };
  b.querySelector("#lv-type").addEventListener("change", rate); b.querySelector("#lv-qty").addEventListener("change", rate); rate();
  b.querySelector("#lv-ok").addEventListener("click", async () => {
    const why = b.querySelector("#lv-why").value.trim(); if (!why){ b.querySelector("#lv-why").focus(); return; }
    const amt = b.querySelector("#lv-amt").value;
    if (await call("fn_live_add_adjustment", {p_day: CX.day, p_city: CX.city, p_order: id, p_charge_type: b.querySelector("#lv-type").value,
        p_quantity: Number(b.querySelector("#lv-qty").value) || 1, p_amount: amt === "" ? null : Number(amt), p_reason: why, p_chargeable: b.querySelector("#lv-chg").checked},
        "Adjustment booked - it goes to the 3D sheet automatically")) d.close();
  });
}
function moveDlg(id){
  const o = order(id);
  const d = dialog(`<h2 style="margin:0 0 6px">Move ${esc(id)} to another team</h2>
    <label class="lf">Team <select id="lv-team">${LV.teams.filter(t => t.team !== o.team).map(t => `<option value="${t.team}">${esc(t.name)} ${esc((t.members || []).join(" & "))}</option>`).join("")}</select></label>
    <div class="muted" style="font-size:12px">It keeps its planned time and slots into that team's day in time order.</div>
    <div class="lbtns"><button class="btn primary" id="lv-ok">Move</button><button class="btn" data-lvclose>Cancel</button></div>`);
  d.box.querySelector("#lv-ok").addEventListener("click", async () => { if (await call("fn_live_move_order", {p_day: CX.day, p_city: CX.city, p_order: id, p_team: Number(d.box.querySelector("#lv-team").value)}, "Moved")) d.close(); });
}
function removeDlg(id){
  const d = dialog(`<h2 style="margin:0 0 6px">Remove ${esc(id)} from the day?</h2>
    <label class="lf">Reason <input id="lv-reason" placeholder="e.g. cancelled by the customer"></label>
    <div class="muted" style="font-size:12px">Use <b>Reschedule</b> instead if the job moves to another day. Removed orders stay listed at the bottom and can be re-added.</div>
    <div class="lbtns"><button class="btn danger" id="lv-ok">Remove</button><button class="btn" data-lvclose>Cancel</button></div>`);
  d.box.querySelector("#lv-ok").addEventListener("click", async () => { if (await call("fn_live_remove_order", {p_day: CX.day, p_city: CX.city, p_order: id, p_reason: d.box.querySelector("#lv-reason").value}, "Removed")) d.close(); });
}
function addDlg(){
  const held = (CX.held ? CX.held() : []).filter(h => !LV.orders.some(o => o.order_id === h.order_id && o.status !== "removed"));
  const gone = LV.orders.filter(o => o.status === "removed");
  const teamOpt = LV.teams.map(t => `<option value="${t.team}">${esc(t.name)} ${esc((t.members || []).join(" & "))}</option>`).join("");
  const d = dialog(`<h2 style="margin:0 0 6px">Add an order to ${esc(CX.city)} today</h2>
    ${held.length || gone.length ? `<h3>Suggested</h3>${held.map(h => `<div class="heldrow"><div><b>${esc(h.order_id)}</b> <span class="chip warn">${esc(h.entry_type === "issue_resolution" ? "ISR" : "held")}</span> ${esc(h.customer)} · sheet ${esc(h.slot)} · ${h.minutes} min
        <div class="muted" style="font-size:12px">${esc(h.address)}</div></div><button class="btn small" data-fill='${esc(JSON.stringify({id: h.order_id, c: h.customer, a: h.address, s: h.slot, m: Math.round(h.minutes || 60), e: !!h.emaar, p: h.phone || ""}))}'>Fill in</button></div>`).join("")}
      ${gone.map(o => `<div class="heldrow"><div><b>${esc(o.order_id)}</b> <span class="chip">removed earlier</span> ${esc(o.customer || "")}</div><button class="btn small" data-fill='${esc(JSON.stringify({id: o.order_id, c: o.customer || "", a: o.address || "", s: o.plan_start || "10:00", m: o.est_min || 60, e: !!o.emaar, p: o.phone || ""}))}'>Fill in</button></div>`).join("")}` : ""}
    <h3>Details</h3>
    <div class="formgrid">
      <label>Order no.<input id="lv-id"></label><label>Customer<input id="lv-cust"></label>
      <label class="wide">Address<input id="lv-addr"></label>
      <label>Phone<input id="lv-phone"></label><label>Team<select id="lv-team">${teamOpt}</select></label>
      <label>Start<input id="lv-s" type="time" value="${hm(Math.max(nowMin() + 30, 9 * 60))}"></label><label>Minutes on site<input id="lv-m" type="number" min="5" value="60"></label>
      <label class="chk"><input id="lv-em" type="checkbox"> Emaar</label>
    </div>
    <label class="lf">Note <input id="lv-note" placeholder="optional"></label>
    <div class="lbtns"><button class="btn primary" id="lv-ok">Add to the day</button><button class="btn" data-lvclose>Cancel</button><span id="lv-msg" style="color:var(--bad)"></span></div>`);
  const b = d.box, g = k => b.querySelector("#lv-" + k);
  b.querySelectorAll("[data-fill]").forEach(x => x.addEventListener("click", () => { const f = JSON.parse(x.dataset.fill); g("id").value = f.id; g("cust").value = f.c || ""; g("addr").value = f.a || "";
    g("phone").value = f.p || ""; if (f.s) g("s").value = String(f.s).slice(0, 5); g("m").value = f.m || 60; g("em").checked = !!f.e; }));
  g("ok").addEventListener("click", async () => {
    if (!g("id").value.trim()){ g("msg").textContent = "Order number is needed"; return; }
    const ok = await call("fn_live_add_order", {p_day: CX.day, p_city: CX.city, p_order: g("id").value.trim(), p_team: g("team").value ? Number(g("team").value) : null,
      p_start: g("s").value, p_minutes: Number(g("m").value) || 60, p_customer: g("cust").value || null, p_phone: g("phone").value || null,
      p_address: g("addr").value || null, p_emaar: g("em").checked, p_scope: null, p_note: g("note").value || null}, "Order added");
    if (ok) d.close();
  });
}

/* ---------------- events ---------------- */
async function publishNow(){
  if (!CX.payload) return;
  const P = CX.payload();
  if (!P.teams.length){ toast("Stage 3 has no teams with jobs yet", "bad"); return; }
  LV.busy = true;
  try { const r = await publish(P); LV.busy = false; await refresh(); toast(`Published: ${r && r.new || 0} new, ${r && r.updated || 0} refreshed`); }
  catch (e) { LV.busy = false; toast((e && e.message) || "Could not publish", "bad"); }
}
export function onClick(e){
  const b = e.target.closest ? e.target.closest("button[data-lv]") : null; if (!b) return false;
  const id = b.dataset.id, act = b.dataset.lv;
  const set = (st) => call("fn_live_set_status", {p_day: CX.day, p_city: CX.city, p_order: id, p_status: st});
  if (act === "reload") refresh();
  else if (act === "publish") publishNow();
  else if (act === "log"){ LV.showLog = !LV.showLog; paint(); }
  else if (act === "showoff"){ LV.showOff = !LV.showOff; paint(); }
  else if (act === "addorder") addDlg();
  else if (act === "start") set("in_progress");
  else if (act === "done") set("completed");
  else if (act === "reopen") set("pending");
  else if (act === "partial" || act === "failed") ask(id, act);
  else if (act === "resched") ask(id, "rescheduled");
  else if (act === "time") retime(id);
  else if (act === "adj") adjustment(id);
  else if (act === "move") moveDlg(id);
  else if (act === "remove") removeDlg(id);
  return true;
}
export function onChange(e){
  const el = e.target;
  if (el.matches && el.matches("input[data-lnote]")){ call("fn_live_note", {p_day: CX.day, p_city: CX.city, p_order: el.dataset.lnote, p_note: el.value}); return true; }
  if (el.matches && el.matches("input[data-ltnote]")){ call("fn_live_team_note", {p_day: CX.day, p_city: CX.city, p_team: Number(el.dataset.ltnote), p_note: el.value}); return true; }
  return false;
}

/* ---------------- entry points ---------------- */
export function render(ctx){
  CX = ctx;
  if (LV.key !== key()) LV = Object.assign(LV, {key: key(), teams: [], orders: [], adjs: [], events: [], at: null, err: ""});
  paint();
  refresh();
  clearInterval(timer); clearInterval(ticker);
  timer = setInterval(() => { if (CX && CX.root.isConnected && CX.active()) refresh(true); else stop(); }, 20000);
  ticker = setInterval(() => { if (CX && CX.active() && !LV.busy && CX.root.querySelector(".ljobs") && !CX.root.contains(document.activeElement && document.activeElement.matches("input,select") ? document.activeElement : null)) paint(); }, 60000);
}
export function stop(){ clearInterval(timer); clearInterval(ticker); timer = ticker = null; }
