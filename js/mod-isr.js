/* ISR - issue resolution. 10 Nov 2026 (user); moved 13 Nov 2026 (user).
 *
 * One card per issue. Two people feed it:
 *   the INSTALLATION coordinator writes the issue - order, type, source, what it is, what is coming
 *     back from site (curtain / blind / track) and what new has to arrive (fabric / blind / track /
 *     motor ...);
 *   the PRODUCTION coordinator answers it - fabric received yes / no, which fabric, a picture, and
 *     "report ready" (and "return to the fabric supplier" when something has to go back).
 *
 * Where it is shown (13 Nov 2026, user):
 *   Installation module  #/status?view=isr - the full list, raise / edit / done (render, isrBoard)
 *   Step scheduler       Stage 2 tray cards (drag onto a team) and Stage 4 below the live teams
 *                        (isrBoard with the city fixed)
 *   Production           #/production?view=isr - the SIMPLE view: one card per open ISR with Yes / No,
 *                        which fabric, take a picture, Report ready (renderProduction)
 *   Installation panel   the order's own ISR cards (orderIsrPanel), also what Stage 4's
 *                        "Adjustment / status" opens
 * The old #/isr link redirects to the Installation view; the Production drawer no longer has the tab.
 *
 * Every write is a fn_isr_* function (SQL 20261110_live_isr_receipts_tailors.sql and
 * 20261113_isr_fabric_ready.sql); the tables are read-only to the browser. The history of a card
 * (isr_event) names who did what. Photos are order_photos rows, context 'isr', context_id = ISR id.
 */
import { api, apiAll, rpc, isSignedIn, isViewer } from "./api.js";
import { esc, el, toast, loading, modal, fmtDate, fmtDateTime, confirmSheet } from "./ui.js";
import { photoStrip } from "./photos.js";

export const ISR_TYPES = [
  ["on_the_spot", "On the spot"], ["new_fabric", "New fabric"], ["planned_alteration", "Planned alteration"],
  ["unplanned_alteration", "Unplanned alteration"], ["others", "Others"]];
export const ISR_SOURCES = [
  ["production", "Production issue"], ["installation", "Installation issue"], ["consultation", "Consultation issue"],
  ["client_change_of_mind", "Client change of mind"], ["fabric", "Fabric issue"], ["others_kurtains", "Others - Kurtains"]];
const label = (list, v) => (list.find((x) => x[0] === v) || [v, v || "—"])[1];
const READY = { waiting: ["Waiting", "warn"], received: ["Received back", "info"], ready: ["Ready", "ok"] };
const STATUS = { open: ["Open", "warn"], scheduled: ["Scheduled", "info"], done: ["Done", "ok"], cancelled: ["Cancelled", "mute"] };
const chipH = (t, tone, title) => `<span class="chip ${tone || "mute"}"${title ? ` title="${esc(title)}"` : ""}>${esc(t)}</span>`;
const who = (e) => String(e || "").split("@")[0];
const photoMeta = (r) => ({ context: "isr", context_id: r.id, order_id: r.order_id, context_label: `ISR #${r.id}` });

/* Production's answer in one line - shared by every place an ISR card is drawn. `tone` maps this
 * file's chip tones onto the step scheduler's (it calls the green one "good"). */
export function fabricState(r) {
  if (r.fabric_received === true) return { text: "Fabric received", tone: "ok" };
  if (r.fabric_received === false) return { text: "Fabric NOT received", tone: "bad" };
  return { text: "Fabric: not answered yet", tone: "mute" };
}
export function productionLine(r, tone = (t) => t) {
  const f = fabricState(r);
  const by = r.fabric_by ? `${who(r.fabric_by)} · ${fmtDateTime(r.fabric_at)}` : "";
  return [
    chipH(f.text, tone(f.tone), by),
    r.fabric_name ? `<b>${esc(r.fabric_name)}</b>` : "",
    Number(r.photo_count) ? chipH(`📷 ${r.photo_count}`, tone("info"), "Pictures from Production") : "",
    r.ready ? chipH(`✓ Ready${r.ready_by ? " · " + who(r.ready_by) : ""}`, tone("ok"), r.ready_at ? fmtDateTime(r.ready_at) : "")
            : chipH("Not reported ready", tone("warn")),
  ].filter(Boolean).join(" ");
}

/* ================================================================ Installation: the full list */
export async function render(mount) {
  if (!isSignedIn()) return;
  mount.innerHTML = `<div class="sectionbar"><div class="subtabs"><a class="btn sm" href="#/status">🚚 Installation board</a><button class="on">🔁 ISR · issue resolution</button></div></div>`;
  mount.appendChild(isrBoard());
}

/* The list with its filters, as one element. opts.city fixes the city (Stage 4 shows only the day's
 * city); opts.title replaces the heading. Each board keeps its own filters. */
export function isrBoard(opts = {}) {
  const F = { status: "active", readiness: "", city: opts.city || "", type: "", source: "", q: "" };
  let ROWS = [];
  const box = el(`<div class="isrboard"><div class="card isrhead"></div><div class="isrlist"></div></div>`);
  const head = box.querySelector(".isrhead"), list = box.querySelector(".isrlist");
  const sel = (name, o, cur) => `<select name="${name}">${o.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  head.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">${esc(opts.title || "ISR · issue resolution")}</h3>
      <span class="row" style="gap:6px"><button class="btn sm ghost" data-reload title="Reload">↻</button>
      ${isViewer() ? "" : `<button class="btn primary" data-new>＋ New ISR</button>`}</span></div>
    <div class="fgrid" style="margin-top:8px">
      <div><label class="f">Status</label>${sel("status", [["active", "Open + scheduled"], ["open", "Open"], ["scheduled", "Scheduled"], ["done", "Done"], ["cancelled", "Cancelled"], ["", "All"]], F.status)}</div>
      <div><label class="f">Readiness</label>${sel("readiness", [["", "Any"], ["waiting", "Waiting"], ["received", "Received back"], ["ready", "Ready"], ["fab_yes", "Fabric received"], ["fab_no", "Fabric not received"], ["fab_none", "Fabric not answered"], ["return", "To return to supplier"]], F.readiness)}</div>
      ${opts.city ? "" : `<div><label class="f">City</label>${sel("city", [["", "Both"], ["Dubai", "Dubai"], ["Abu Dhabi", "Abu Dhabi"]], F.city)}</div>`}
      <div><label class="f">Type</label>${sel("type", [["", "Any"], ...ISR_TYPES], F.type)}</div>
      <div><label class="f">Source</label>${sel("source", [["", "Any"], ...ISR_SOURCES], F.source)}</div>
      <div><label class="f">Search</label><input name="q" value="${esc(F.q)}" placeholder="order, customer, issue, fabric"></div>
    </div>`;
  head.querySelectorAll("select,input").forEach((i) => i.addEventListener(i.tagName === "INPUT" ? "input" : "change", () => {
    F[i.name] = i.value; paint();
  }));
  const load = async () => {
    list.innerHTML = `<span class="muted">Loading…</span>`;
    try { ROWS = await apiAll("/rest/v1/v_isr_cases?select=*&order=id.desc"); }
    catch (e) { list.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`; return; }
    paint();
  };
  const readyOk = (r) => {
    switch (F.readiness) {
      case "": return true;
      case "return": return r.return_supplier;
      case "fab_yes": return r.fabric_received === true;
      case "fab_no": return r.fabric_received === false;
      case "fab_none": return r.fabric_received == null;
      default: return r.readiness === F.readiness;
    }
  };
  function paint() {
    const q = F.q.trim().toLowerCase();
    const mine = ROWS.filter((r) => !F.city || r.city_any === F.city);
    const rows = mine.filter((r) =>
      (F.status === "" || (F.status === "active" ? ["open", "scheduled"].includes(r.status) : r.status === F.status)) &&
      readyOk(r) && (!F.type || r.isr_type === F.type) && (!F.source || r.source === F.source) &&
      (!q || [r.order_id, r.customer_any, r.issue, r.expected_back, r.expected_new, r.fabric_name].join(" ").toLowerCase().includes(q)));
    const act = mine.filter((r) => ["open", "scheduled"].includes(r.status));
    const cnt = (k) => act.filter((r) => r.readiness === k).length;
    list.innerHTML = `<div class="muted" style="margin:4px 2px 8px">${rows.length} shown · open: ${cnt("waiting")} waiting, ${cnt("received")} received back, ${cnt("ready")} ready · fabric received on ${act.filter((r) => r.fabric_received === true).length} of ${act.length}</div>`;
    if (!rows.length) { list.appendChild(el(`<div class="card"><span class="muted">No ISR matches.</span></div>`)); return; }
    rows.forEach((r) => list.appendChild(card(r, load)));
  }
  head.querySelector("[data-reload]").addEventListener("click", load);
  const nb = head.querySelector("[data-new]");
  if (nb) nb.addEventListener("click", () => editCase(null, load, opts.city ? { city: opts.city } : null));
  box.reload = load;
  load();
  return box;
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
    <div class="isrprodline"><span class="muted" style="font-size:12px">Production says:</span> ${productionLine(r)}</div>
    <div data-photos></div>
    ${r.return_supplier && r.return_note ? `<div class="banner warn" style="margin-top:6px">Return to supplier: ${esc(r.return_note)}</div>` : ""}
    <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
      <span class="muted" style="font-size:12px">Ticks:</span>
      ${tick("received", r.received, "Received back", r.received_by, r.received_at)}
      ${tick("ready", r.ready, "Ready", r.ready_by, r.ready_at)}
      ${tick("return_supplier", r.return_supplier, "Return to supplier", r.return_by, r.return_at)}
      <span style="flex:1"></span>
      <a class="btn sm" href="#/stepper?date=${esc(r.sched_day || "")}&city=${esc(r.city_any || "Dubai")}" title="Open the Step scheduler; in Stage 2 drag the ISR card onto a team">🧭 Plan in scheduler</a>
      ${ro ? "" : `<button class="btn sm" data-edit>Edit</button>
      ${["open", "scheduled"].includes(r.status) ? `<button class="btn sm" data-flag="done" data-on="1">✓ Done</button><button class="btn sm ghost" data-flag="cancelled" data-on="1">Cancel</button>`
        : `<button class="btn sm" data-flag="reopen" data-on="1">↺ Reopen</button>`}`}
      <button class="btn sm ghost" data-hist>History</button>
    </div><div class="isrhist" hidden></div></div>`);
  // pictures Production took (and anybody else's), viewable here; the camera follows the role
  if (Number(r.photo_count) || !ro) c.querySelector("[data-photos]").appendChild(photoStrip(photoMeta(r), { label: "Photo" }));
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
  c.querySelector("[data-hist]").addEventListener("click", () => toggleHistory(c.querySelector(".isrhist"), r.id));
  return c;
}
async function toggleHistory(h, id) {
  if (!h.hidden) { h.hidden = true; return; }
  h.hidden = false; h.innerHTML = `<span class="muted">Loading…</span>`;
  try {
    const ev = await api(`/rest/v1/isr_event?select=at,who,kind,detail&isr_id=eq.${id}&order=at.desc`) || [];
    h.innerHTML = ev.map((e) => `<div><span class="muted">${esc(fmtDateTime(e.at))}</span> <b>${esc(who(e.who))}</b> · ${esc(evText(e))}</div>`).join("") || `<span class="muted">Nothing yet</span>`;
  } catch (e) { h.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}
function evText(e) {
  const d = e.detail || {}, on = d.on ? "ticked" : "unticked";
  switch (e.kind) {
    case "created": return "raised the ISR";
    case "edited": return "edited the details";
    case "received": return `${on} received back`;
    case "ready": return d.on ? "reported it ready" : "took back 'ready'";
    case "fabric": return d.received === true ? `fabric received${d.fabric ? ": " + d.fabric : ""}`
      : d.received === false ? `fabric NOT received${d.fabric ? " (" + d.fabric + ")" : ""}` : `fabric answer cleared${d.fabric ? " (" + d.fabric + ")" : ""}`;
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

/* ================================================================ Production: the simple view
 * One card per open ISR and four things to do on it: fabric received Yes / No, which fabric, take a
 * picture, Report ready. Nothing else - raising and editing an ISR is the Installation coordinator's,
 * in the Installation module. */
const PF = { show: "todo", city: "", q: "" };
export async function renderProduction(mount) {
  if (!isSignedIn()) return;
  mount.innerHTML = `<div class="sectionbar"><div class="subtabs"><a class="btn sm" href="#/production">✂️ Orders</a><button class="on">🔁 ISR · fabric &amp; ready</button></div></div>
    <div class="card isrphead"></div><div class="isrplist"></div>`;
  const head = mount.querySelector(".isrphead"), list = mount.querySelector(".isrplist");
  const seg = (name, opts) => `<div class="isrseg" data-seg="${name}">${opts.map(([v, l]) =>
    `<button class="btn sm ${PF[name] === v ? "accent" : ""}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</div>`;
  let ROWS = [];
  const paintHead = () => {
    head.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center">
        <h3 style="margin:0">ISR · fabric &amp; ready</h3>
        <button class="btn sm ghost" data-reload>↻ Reload</button></div>
      <div class="muted" style="font-size:12.5px;margin:4px 0 8px">For each issue: has the fabric come? Which fabric? Take a picture, then press <b>Report ready</b>. Installation sees it at once on the ISR cards (Step scheduler Stage 2 and Stage 4, and the Installation module).</div>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
        ${seg("show", [["todo", "To do"], ["ready", "Reported ready"], ["all", "All open"]])}
        ${seg("city", [["", "Both cities"], ["Dubai", "Dubai"], ["Abu Dhabi", "Abu Dhabi"]])}
        <input name="q" value="${esc(PF.q)}" placeholder="Search order, customer, fabric" style="max-width:260px">
      </div>`;
    head.querySelectorAll("[data-seg] button").forEach((b) => b.addEventListener("click", () => {
      PF[b.closest("[data-seg]").dataset.seg] = b.dataset.v; paintHead(); paint();
    }));
    head.querySelector("[name=q]").addEventListener("input", (e) => { PF.q = e.target.value; paint(); });
    head.querySelector("[data-reload]").addEventListener("click", load);
  };
  const paint = () => {
    const q = PF.q.trim().toLowerCase();
    const open = ROWS.filter((r) => (!PF.city || r.city_any === PF.city));
    const rows = open.filter((r) => (PF.show === "all" || (PF.show === "ready" ? r.ready : !r.ready)) &&
      (!q || [r.order_id, r.customer_any, r.issue, r.expected_new, r.fabric_name].join(" ").toLowerCase().includes(q)));
    list.innerHTML = `<div class="muted" style="margin:4px 2px 8px">${rows.length} shown · ${open.filter((r) => !r.ready).length} to do, ${open.filter((r) => r.ready).length} reported ready</div>`;
    if (!rows.length) { list.appendChild(el(`<div class="card"><span class="muted">${PF.show === "todo" ? "Nothing waiting on Production." : "No ISR matches."}</span></div>`)); return; }
    rows.forEach((r) => list.appendChild(prodCard(r, load)));
  };
  const load = async () => {
    loading(true, "Loading ISR…");
    try { ROWS = await apiAll("/rest/v1/v_isr_cases?select=*&status=in.(open,scheduled)&order=id.desc"); }
    catch (e) { loading(false); list.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`; return; }
    loading(false);
    paint();
  };
  paintHead();
  await load();
}

function prodCard(r, reload) {
  const ro = isViewer(), fr = r.fabric_received;
  const c = el(`<div class="card isrpcard ${r.ready ? "isready" : ""}">
    <div class="spread"><div><b>ISR #${r.id} · ${esc(r.order_id)}</b> ${esc(r.customer_any || "")} <span class="muted">${esc(r.city_any || "")}</span></div>
      <div>${r.sched_day ? chipH(`scheduled ${fmtDate(r.sched_day)}${r.sched_team ? ", Team " + r.sched_team : ""}`, "info") : chipH("not scheduled yet", "mute")}</div></div>
    <div class="isrtext">${esc(r.issue)}</div>
    ${r.expected_new ? `<div style="font-size:13px;margin-top:4px"><span class="muted">New to arrive:</span> ${esc(r.expected_new)}</div>` : ""}
    ${r.expected_back ? `<div style="font-size:13px"><span class="muted">Coming back from site:</span> ${esc(r.expected_back)}</div>` : ""}
    <div class="isrpq">
      <div class="isrpstep"><span class="isrpn">1</span><span class="isrpl">Fabric received?</span>
        <button class="btn ${fr === true ? "accent" : ""}" data-fab="yes" ${ro ? "disabled" : ""} aria-pressed="${fr === true}">✓ Yes</button>
        <button class="btn ${fr === false ? "danger" : ""}" data-fab="no" ${ro ? "disabled" : ""} aria-pressed="${fr === false}">✕ No</button>
        ${r.fabric_by ? `<span class="muted" style="font-size:12px">${esc(who(r.fabric_by))} · ${esc(fmtDateTime(r.fabric_at))}</span>` : ""}</div>
      <div class="isrpstep"><span class="isrpn">2</span><span class="isrpl">Which fabric</span>
        <input data-fname value="${esc(r.fabric_name || "")}" placeholder="Fabric name / code" ${ro ? "disabled" : ""} style="flex:1;min-width:160px"></div>
      <div class="isrpstep"><span class="isrpn">3</span><span class="isrpl">Picture</span><span data-photos style="flex:1"></span></div>
      <div class="isrpstep"><span class="isrpn">4</span><span class="isrpl">Ready</span>
        ${r.ready ? `${chipH(`✓ Reported ready · ${who(r.ready_by)} · ${fmtDateTime(r.ready_at)}`, "ok")} ${ro ? "" : `<button class="btn sm ghost" data-unready>Undo</button>`}`
          : `<button class="btn primary" data-ready ${ro ? "disabled" : ""}>✓ Report ready</button>`}</div>
    </div></div>`);
  c.querySelector("[data-photos]").appendChild(photoStrip(photoMeta(r), { label: "Take a picture", onChange: () => { r.photo_count = Number(r.photo_count || 0) + 1; } }));
  const nameIn = c.querySelector("[data-fname]");
  /* Saves run ONE AFTER ANOTHER. Typing a fabric and then tapping Yes fires the field's change (on
   * blur) and the click together; sent side by side, the blur's "keep the answer as it is" landed
   * after the Yes and wiped it (seen 13 Nov 2026). Queued, the Yes is always the last word. */
  let chain = Promise.resolve(), pending = 0;
  const saveFabric = (received) => {
    pending++;
    chain = chain.then(async () => {
      try {
        await rpc("fn_isr_fabric", { p_id: r.id, p_received: received, p_fabric: nameIn.value });
        r.fabric_received = received;
        toast(received === true ? "Fabric received" : received === false ? "Fabric not received" : "Saved", "ok");
      } catch (e) { toast(e.message || String(e), "bad"); }
      if (--pending === 0) reload();
    });
  };
  c.querySelectorAll("[data-fab]").forEach((b) => b.addEventListener("click", () => saveFabric(b.dataset.fab === "yes")));
  // the fabric name saves when the field is left, keeping whatever Yes / No is already set
  nameIn.addEventListener("change", () => { if (nameIn.value.trim() !== (r.fabric_name || "")) saveFabric(r.fabric_received ?? null); });
  const rb = c.querySelector("[data-ready]");
  if (rb) rb.addEventListener("click", async () => {
    if (r.fabric_received !== true &&
        !await confirmSheet("Report ready without the fabric?", "The fabric is not marked received on this ISR. Report it ready anyway?")) return;
    try { await rpc("fn_isr_flag", { p_id: r.id, p_flag: "ready", p_on: true, p_note: null }); toast("Reported ready", "ok"); reload(); }
    catch (e) { toast(e.message || String(e), "bad"); }
  });
  const ub = c.querySelector("[data-unready]");
  if (ub) ub.addEventListener("click", async () => {
    try { await rpc("fn_isr_flag", { p_id: r.id, p_flag: "ready", p_on: false, p_note: null }); toast("Ready taken back", "ok"); reload(); }
    catch (e) { toast(e.message || String(e), "bad"); }
  });
  return c;
}

/* ================================================================ one order's ISR
 * For the Installation panel of an order (which Stage 4's "Adjustment / status" also opens). Same
 * cards and controls as the full list; "+ New ISR" starts with this order filled in. */
export function orderIsrPanel(orderId) {
  const box = el(`<div class="dsec"><div class="spread"><h4>🔁 ISR · issue resolution</h4>
      ${isViewer() ? "" : `<button class="btn sm primary" data-new>＋ New ISR for ${esc(orderId)}</button>`}</div>
    <div data-list><span class="muted">Loading…</span></div>
    <div class="muted" style="font-size:12px;margin-top:6px">Every open ISR is also in Stage 2 of the Step scheduler, to drag onto a team, and Production answers it under Production › ISR.</div></div>`);
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
