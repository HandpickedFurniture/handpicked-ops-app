/* Step-by-step Scheduler (#/stepper), 24 Oct 2026.
 *
 * Plan ONE city's installation day by hand, order by order, with the map showing only each team's
 * latest job and a ranked suggestion (or Play, which places every order and says why out loud).
 * Stage 2 is the whole plan on the map with drag-and-drop between teams and crew names; Stage 3 is
 * the dispatch checklist with the WhatsApp text (appointment times from the 3D sheet, the user's
 * notes, and each order's installation alert from order_install_alerts).
 *
 * Built from the user-approved prototype (schedules/Step_Scheduler.html). It is deliberately NOT the
 * fn_sched_* engine behind #/schedule: this timing model is the Schedule skill's (rules.json ->
 * sched_settings 'stepper_rules', counting in stepper-facts.js), which is what the user plans with.
 * The plan lives in this browser (localStorage, per date + city); nothing is written to the database
 * and Stage 3 only previews - window.STEPPER_HOOKS is where real senders plug in.
 */
import { rpc, api, isSignedIn } from "./api.js";
import { STORAGE_PREFIX } from "./config.js";
import { el, loading, toast } from "./ui.js";
import { buildDay, CITY_CENTRE } from "./stepper-facts.js";

let R = null, BASE = null, ROSTER = null;                    // sched_settings stepper_rules / stepper_roster
const DAYS = {};                                              // date -> {facts, held, inst, date_label, synced_at}
let ROOT = null;                                              // this screen's element; every listener hangs off it
const HANDLERS = [];
const on = (type, fn) => HANDLERS.push([type, fn]);
let F = {}, T = {}, KM = {}, DAY = null, IDS = [];
const UIKEY = STORAGE_PREFIX + "stepper-ui";
let UI = {date: null, city: "Dubai", split: 42, sort: "time", voice: true, rate: 1};
try { Object.assign(UI, JSON.parse(localStorage.getItem(UIKEY) || "{}")); } catch(e){}
const saveUI = () => { try{ localStorage.setItem(UIKEY, JSON.stringify(UI)); }catch(e){} };
const scopeKey = () => UI.date + "|" + UI.city;
const KEY = () => STORAGE_PREFIX + "stepper-" + UI.date + "-" + UI.city;
const idOf = (x) => (x && x.id || "").replace(/^stp-/, "");
const PALETTE = ["#1f6fb4","#d6392b","#2e9447","#8a4fc7","#e08a12","#138e9c","#9b5a34","#d64d9f","#5b6c7d","#8f9a1c","#3a4ec2","#c23a6a"];
let FREE_LATE = 60, FREE_EARLY = 120;                      // set from the rules once they have loaded
const $ = id => ROOT ? ROOT.querySelector("#stp-" + id) : null;
const mins = s => { const [h, m] = String(s).slice(0, 5).split(":").map(Number); return h * 60 + m; };
const hm = m => { m = Math.round(m); return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const teamColor = n => PALETTE[(Number(n) - 1 + PALETTE.length * 10) % PALETTE.length];
const slotsNow = () => [...new Set(IDS.map(i => F[i].sheet_slot))].sort();
// F[i].sheet_slot is the 3D sheet's time; F[i].slot is the (editable) working time
function buildF(){
  F = clone(DAY.facts);
  (state.added || []).forEach(i => { if (DAY.held[i]) { F[i] = clone(DAY.held[i]); F[i].hold = true; } });
  Object.entries(state.extra || {}).forEach(([i, f]) => { F[i] = clone(f); F[i].manual = true; });
  Object.keys(F).forEach(i => { F[i].sheet_slot = F[i].slot; });
  IDS = Object.keys(F).filter(i => F[i].city === UI.city && !(state.removed || []).includes(i));
}
function enterScope(){
  DAY = DAYS[UI.date]; T = {}; KM = {};
  const saved = load();
  state = saved || {added: [], extra: {}, removed: []};
  state.added = state.added || []; state.extra = state.extra || {}; state.removed = state.removed || [];
  buildF();
  if (!saved) { state = fresh(); buildF(); }
  applyTimes(); fitKey = ""; hiddenTeams.clear(); hot = null;
}
function restart(wave, keepOrders){
  haltPlay();
  const keep = keepOrders ? {added: state.added, extra: state.extra, removed: state.removed} : {added: [], extra: {}, removed: []};
  state = keep; buildF();                        // the order list first, so the first wave is taken from it
  state = Object.assign(fresh(wave), keep); buildF(); applyTimes();
  hiddenTeams.clear(); hot = null; caption = ""; fitKey = ""; resetArmed = false; save(); paint();
}
// a two-press confirm on the button itself: the browser's confirm() box is blocked silently in some
// embedded views, which made the button look dead
let resetArmed = false, resetTimer = null;
function applyTimes(){
  IDS.forEach(i => F[i].slot = (state.times && state.times[i]) || F[i].sheet_slot);
  // Emaar: what the address says (emaar_auto), unless the user switched it for this order
  IDS.forEach(i => { if (F[i].emaar_auto === undefined) F[i].emaar_auto = !!F[i].emaar;
    F[i].emaar = state.emaarSet && i in state.emaarSet ? state.emaarSet[i] : F[i].emaar_auto; });
}

/* ---------------- state ---------------- */
// assign: team number -> order ids in visit order. history: [{id, team}] so Undo works one step at a time.
function fresh(wave){
  const slots = slotsNow(); wave = wave || (slots.includes("10:00") ? "10:00" : slots[0]);
  const first = IDS.filter(i => F[i].sheet_slot === wave)
    .sort((a, b) => (F[a].city === "Dubai" ? 0 : 1) - (F[b].city === "Dubai" ? 0 : 1) || a.localeCompare(b));
  const s = {stage: 1, wave, waveIds: first, times: {}, added: [], extra: {}, removed: [], teams: [], assign: {}, history: [], cur: null, allowEarly: false, autoZoom: true, showAll: false, showRest: false};
  first.forEach((id, i) => { s.teams.push({team: i + 1, name: "Team " + (i + 1), members: []}); s.assign[i + 1] = [id]; });
  return s;
}
function load(){ try{ const s = JSON.parse(localStorage.getItem(KEY()) || "null"); return s && s.assign ? s : null; }catch(e){ return null; } }
function save(){ try{ localStorage.setItem(KEY(), JSON.stringify(state)); }catch(e){} }
let state = null;

const assignedIds = () => new Set(Object.values(state.assign).flat());
function queue(){
  const done = assignedIds();
  return IDS.filter(i => !done.has(i)).sort((a, b) => F[a].slot.localeCompare(F[b].slot) || (F[a].city === "Dubai" ? 0 : 1) - (F[b].city === "Dubai" ? 0 : 1) || a.localeCompare(b));
}
function curId(){ return IDS.includes(state.cur) ? state.cur : (queue()[0] || null); }
const teamOf = n => state.teams.find(t => t.team === Number(n));
const tname = n => (teamOf(n) || {}).name || ("Team " + n);

/* ---------------- travel: the day's matrix where it exists, else straight-line + the same speed bands ---------------- */
const tkOf = x => x === "BASE" ? "BASE" : (F[x].manual ? null : (F[x].hold ? "H" + x : x));
const ptOf = x => x === "BASE" ? [BASE.lat, BASE.lng] : (F[x].lat != null ? [F[x].lat, F[x].lng] : (CITY_CENTRE[F[x].city] || [BASE.lat, BASE.lng]));
function drive(a, b){
  const ka = tkOf(a), kb = tkOf(b);
  if (ka && kb && T[ka] && T[ka][kb] != null) return [T[ka][kb], (KM[ka] || {})[kb] || 0];
  const A = ptOf(a), B = ptOf(b), rad = Math.PI / 180, dl = (B[0] - A[0]) * rad, dg = (B[1] - A[1]) * rad;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(A[0] * rad) * Math.cos(B[0] * rad) * Math.sin(dg / 2) ** 2;
  const d = 2 * 6371 * Math.asin(Math.sqrt(h)), tr = R.travel;
  if (d < tr.same_place_km) return [tr.same_place_min, 0];
  const band = tr.bands.find(x => x.max_km == null || d <= x.max_km), road = d * band.road_factor;
  return [Math.round(road / band.kmh * 60 + tr.buffer_min), Math.round(road * 10) / 10];
}

/* ---------------- timing (same model as the Team Board / sched_eval.py) ---------------- */
// Nothing is ever moved EARLIER than its appointment unless "allow earlier" is on, and the first-wave
// orders are never advanced at all (user rule, 24 Oct 2026).
function earliest(id){
  const f = F[id];
  if (f.flex || !f.slot) return mins(R.work_start);
  const early = state.allowEarly && !(state.waveIds || []).includes(id) ? FREE_EARLY : 0;
  return Math.max(mins(f.slot) - early, mins(R.work_start));
}
function simulate(seq){
  const stops = []; let prev = "BASE", clock = null, travel = 0, km = 0;
  if (seq.length) clock = Math.max(mins(BASE.depart_earliest || "07:00"), earliest(seq[0]) - drive("BASE", seq[0])[0]);
  const depart = clock;
  for (const id of seq){
    const f = F[id], [tr, dkm] = drive(prev, id); travel += tr; km += dkm;
    const arrive = clock + tr, start = Math.max(arrive, earliest(id));
    const delay = f.slot && !f.flex ? start - mins(f.slot) : 0;          // + = later than the appointment
    const late = delay > FREE_LATE ? delay : 0, minor = delay > 0 && !late ? delay : 0;
    const end = start + f.minutes, limit = f.villa ? mins(R.villa_work_end) : mins(R.work_end);
    stops.push({id, from: prev, travel: tr, km: dkm, arrive, start, end, wait: start - arrive, delay, late, minor, over: Math.max(0, end - limit)});
    clock = end; prev = id;
  }
  const back = seq.length ? drive(prev, "BASE")[0] : 0;
  return {stops, depart, home: seq.length ? clock + back : null, back, travel, km,
    orders: seq.length, windows: seq.reduce((a, i) => a + F[i].windows, 0), work: seq.reduce((a, i) => a + F[i].minutes, 0),
    free: seq.length ? clock : null, cities: [...new Set(seq.map(i => F[i].city))]};
}
const pen = s => s.stops.reduce((a, x) => a + x.late * 20 + x.minor * 2 + x.over * 50, 0);
const driveOut = s => s.stops.reduce((a, x) => a + x.travel, 0);
function insertAt(seq, id){                       // keep a team's day in appointment order
  const sl = F[id].slot; let i = seq.length;
  for (let k = 0; k < seq.length; k++) if (F[seq[k]].slot > sl){ i = k; break; }
  return seq.slice(0, i).concat([id], seq.slice(i));
}
function bestInsert(seq, id){
  let best = null, bc = Infinity;
  for (let i = 0; i <= seq.length; i++){
    const c2 = seq.slice(0, i).concat([id], seq.slice(i)), s = simulate(c2), c = pen(s) + driveOut(s);
    if (c < bc){ bc = c; best = c2; }
  }
  return best;
}

/* ---------------- Stage 1: ranking the teams for the order in hand ---------------- */
function candidates(id){
  const f = F[id], out = [];
  const emaarTeams = Object.keys(state.assign).filter(t => state.assign[t].some(i => F[i].emaar));
  const scafTeams = Object.keys(state.assign).filter(t => state.assign[t].some(i => F[i].scaffolding));
  for (const t of state.teams){
    const seq = (state.assign[t.team] || []).filter(i => i !== id), before = simulate(seq);
    const nseq = insertAt(seq, id), after = simulate(nseq), idx = nseq.indexOf(id), st = after.stops[idx];
    const prevId = idx > 0 ? nseq[idx - 1] : null, prevStop = idx > 0 ? after.stops[idx - 1] : null;
    let score = (driveOut(after) - driveOut(before)) + 0.5 * st.wait + (pen(after) - pen(before)) + 3 * seq.length;
    const why = [];
    if (prevId) why.push(`${st.travel} min drive (${st.km} km) from ${prevId}, free ${hm(prevStop.end)}`);
    else why.push(`first job of the day, leaves ${hm(after.depart)}`);
    why.push(`arrives ${hm(st.arrive)}`);
    let verdict = "good", vtxt = "on time";
    if (st.late){ verdict = "bad"; vtxt = `TIME CHANGE +${st.late} min`; }
    else if (st.minor){ verdict = "warn"; vtxt = `+${st.minor} min`; }
    else if (st.wait > 15){ vtxt = `waits ${Math.round(st.wait)} min`; if (st.wait > 45) verdict = "warn"; }
    else if (st.delay < 0){ vtxt = `${-st.delay} min early`; }
    if (st.over){ verdict = "bad"; why.push(`ends ${hm(st.end)}, ${Math.round(st.over)} min after the day limit`); }
    // downstream damage when the order is inserted before a later stop
    if (idx < nseq.length - 1){ const worse = after.stops.slice(idx + 1).filter((x, k) => x.late > before.stops[idx + k].late || x.over > before.stops[idx + k].over); if (worse.length){ verdict = "bad"; why.push(`pushes ${worse.length} later job(s) past their time`); } }
    if (f.emaar && emaarTeams.length){ const has = emaarTeams.includes(String(t.team)); score += has ? -20 : 20; why.push(has ? "already on an Emaar job (keeps Emaar on few crews)" : "would add another Emaar crew"); }
    if (f.scaffolding && scafTeams.length){ const has = scafTeams.includes(String(t.team)); score += has ? -10 : 10; why.push(has ? "already has scaffolding today" : "needs scaffolding kit too"); }
    if (seq.length >= 4) why.push(`already ${seq.length} jobs`);
    out.push({team: t.team, seq, after, st, prevId, score, why, verdict, vtxt, bad: verdict === "bad"});
  }
  out.sort((a, b) => (a.bad - b.bad) || (a.score - b.score));
  out.forEach((c, i) => c.rank = i + 1);
  return out;
}

function assignTo(id, team){
  const was = Object.keys(state.assign).find(t => state.assign[t].includes(id));
  for (const t in state.assign) state.assign[t] = state.assign[t].filter(i => i !== id);
  if (team !== "") state.assign[team] = insertAt(state.assign[team] || [], id);
  state.history.push({id, team, was: was ? Number(was) : null}); state.cur = null; hot = null; save(); paint();
}
function undo(){
  const h = state.history.pop(); if (!h) return;
  for (const t in state.assign) state.assign[t] = state.assign[t].filter(i => i !== h.id);
  if (h.was) state.assign[h.was] = insertAt(state.assign[h.was] || [], h.id);
  state.cur = h.id; save(); paint();
}
function refreshOrders(then){ buildF(); applyTimes(); state.cur = then || null; save(); paint(); }
function removeOrder(id){
  for (const t in state.assign) state.assign[t] = state.assign[t].filter(i => i !== id);
  state.history = state.history.filter(h => h.id !== id); delete state.times[id];
  if (state.extra[id]) delete state.extra[id];                       // a hand-made order is deleted outright
  else if (state.added.includes(id)) state.added = state.added.filter(i => i !== id);
  else state.removed.push(id);
  refreshOrders();
}
function restoreOrder(id){ state.removed = state.removed.filter(i => i !== id); refreshOrders(id); }
function addHeld(id){ if (!state.added.includes(id)) state.added.push(id); refreshOrders(id); }
function addManual(v){
  const id = String(v.id || "").trim();
  if (!id) return "Give the order a number.";
  if (F[id] || (DAY.held[id] && !state.added.includes(id)) || DAY.facts[id]) return `Order ${id} is already known for this date.`;
  const centre = CITY_CENTRE[UI.city];
  const lat = parseFloat(v.lat), lng = parseFloat(v.lng), hasPin = !isNaN(lat) && !isNaN(lng);
  state.extra[id] = {order_id: id, city: UI.city, slot: v.slot || "10:00", customer: v.customer || "Added order", phone: "", address: v.address || "",
    lat: hasPin ? lat : centre[0], lng: hasPin ? lng : centre[1], loc_note: hasPin ? "Pin typed in by hand" : "Location not set - using the city centre",
    emaar: !!v.emaar, villa: false, entry_type: "manual", status: "Added by hand", minutes: Math.max(5, parseInt(v.minutes, 10) || 60),
    windows: Math.max(0, parseInt(v.windows, 10) || 0), counts: {}, scaffolding: false, motor: false, comments: []};
  refreshOrders(id); return "";
}
function addTeam(){
  const n = Math.max(0, ...state.teams.map(t => t.team)) + 1;
  state.teams.push({team: n, name: "Team " + n, members: []}); state.assign[n] = []; save(); paint();
}

/* ---------------- render: stage 1 ---------------- */
let hot = null;                                   // team number under the mouse in the suggestion table
function chipsFor(f){
  const c = f.counts || {}, o = [];
  if (f.emaar) o.push(`<span class="chip emaar">EMAAR</span>`);
  if (f.villa) o.push(`<span class="chip">villa · to ${esc(R.villa_work_end)}</span>`);
  o.push(`<span class="chip">${f.windows} win</span>`);
  if (c.blinds) o.push(`<span class="chip">${c.blinds} blind${c.blinds > 1 ? "s" : ""}</span>`);
  if (c.curt_1l) o.push(`<span class="chip">${c.curt_1l}× 1-layer</span>`);
  if (c.curt_2l) o.push(`<span class="chip">${c.curt_2l}× 2-layer</span>`);
  if (c.pelmet) o.push(`<span class="chip hot">${c.pelmet} pelmet</span>`);
  if (c.flex) o.push(`<span class="chip hot">${c.flex} flex track</span>`);
  if (f.scaffolding) o.push(`<span class="chip bad">scaffolding</span>`);
  if (f.motor) o.push(`<span class="chip hot">motor ×${c.motor_windows}</span>`);
  if (c.removal) o.push(`<span class="chip hot">${c.removal} removal${c.removal > 1 ? "s" : ""}</span>`);
  if (c.w_over_std) o.push(`<span class="chip hot">W&gt;${R.standard_width_cm} (max ${Math.round(c.max_w)})</span>`);
  return o.join("");
}
const DAY0 = 7 * 60, DAY1 = 20 * 60;
const pct = m => Math.max(0, Math.min(100, (m - DAY0) / (DAY1 - DAY0) * 100));
const seg = (a, b, cls, tip, color) => b > a ? `<i class="seg ${cls}" title="${esc(tip)}" style="left:${pct(a)}%;width:${Math.max(0.8, pct(b) - pct(a))}%;${color ? "background:" + color : ""}"></i>` : "";
// one square per window (blinds hollow, curtains solid), with the count
function winViz(f){
  const n = f.windows || 0, c = f.counts || {};
  if (!n) return `<span class="muted" style="font-size:12px">visit only</span>`;
  const blinds = Math.min(n, c.blinds || 0), glyphs = Math.min(n, 12);
  let g = "";
  for (let k = 0; k < glyphs; k++) g += `<i class="wg ${k < blinds ? "bl" : ""}"></i>`;
  return `<div class="wins"><b>${n}</b><span class="wgs">${g}${n > 12 ? "+" : ""}</span></div>
    <div class="muted" style="font-size:11px">${[c.curt_2l ? c.curt_2l + "×2L" : "", c.curt_1l ? c.curt_1l + "×1L" : "", c.blinds ? c.blinds + " blind" : ""].filter(Boolean).join(" · ")}</div>`;
}
// day bar: grey = drive, hatched = waiting at the door, solid = on site (team colour), black tick = the appointment
function etaViz(oid, st, tn){
  const f = F[oid], a = mins(f.slot);
  let segs, label;
  if (st){
    segs = seg(st.arrive - st.travel, st.arrive, "drv", `drive ${st.travel} min`) + seg(st.arrive, st.start, "wait", `waits ${Math.round(st.wait)} min`) +
           seg(st.start, st.end, "work", `on site ${hm(st.start)}–${hm(st.end)}`, teamColor(tn));
    label = `<b>ETA ${hm(st.arrive)}</b> · on site ${hm(st.start)}–${hm(st.end)}`;
  } else {
    segs = seg(a, a + f.minutes, "work ghost", `${f.minutes} min if on time`);
    label = `${f.minutes} min · not on a team`;
  }
  return `<div class="trk">${segs}<i class="appt" title="appointment ${esc(f.slot)}" style="left:${pct(a)}%"></i></div><div class="etalab">${label}</div>`;
}
function renderStage1(){
  const tw0 = $("tw"), keep = tw0 ? tw0.scrollTop : 0;
  const q = queue(), id = curId(), total = IDS.length, done = total - q.length;
  const cands = id ? candidates(id) : [], best = cands[0];
  const teamOfId = {}, stopOf = {};
  state.teams.forEach(t => { const r = simulate(state.assign[t.team] || []); (state.assign[t.team] || []).forEach(i => teamOfId[i] = t.team); r.stops.forEach(x => stopOf[x.id] = x); });
  const rows = sortedIds(teamOfId, stopOf);
  const edited = Object.keys(state.times).filter(i => state.times[i] && state.times[i] !== F[i].sheet_slot).length;

  const head = `<div class="panel strip">
    <b>${done} of ${total}</b> assigned
    <span class="progress"><i style="width:${Math.round(done / total * 100)}%"></i></span>
    <button class="btn small" id="stp-b-undo" ${state.history.length ? "" : "disabled"}>↶ Undo</button>
    <button class="btn small" id="stp-b-addteam">+ Team</button>
    <button class="btn small" id="stp-b-addorder">+ Add order</button>
    <button class="btn small ${resetArmed ? "danger" : ""}" id="stp-b-reset" title="Clears every assignment, edited time, added or removed order and note for this date and city">${resetArmed ? "Press again to clear everything" : "Start again"}</button>
    <label class="muted">First wave <select id="stp-wave">${slotsNow().map(x => `<option ${x === state.wave ? "selected" : ""}>${x}</option>`).join("")}</select></label>
    <label class="muted"><input type="checkbox" id="stp-early" ${state.allowEarly ? "checked" : ""}> later orders may start 2 h early</label>
    ${sortSel()}
    ${playCtl()}
    <button class="btn small ${q.length ? "" : "primary"}" data-go="2" style="margin-left:auto">Stage 2 →</button></div>`;

  let focus = "";
  if (id){
    const f = F[id];
    focus = `<div class="panel focus"><div style="display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline">
      <span class="muted">${teamOfId[id] ? "Re-checking" : "Placing next"}:</span><b style="font-size:16px">${esc(id)}</b> ${esc(f.customer)}
      <span class="chip">${esc(f.city)}</span><b>${esc(f.slot)}</b><span class="muted">${f.minutes} min</span>${chipsFor(f)}</div>
      <div style="margin-top:4px">Suggested: <b style="color:var(--good)"><span class="sw" style="background:${teamColor(best.team)}"></span>${esc(tname(best.team))}</b> —
        ${esc(best.why.join("; "))}. <span class="chip ${best.verdict}">${esc(best.vtxt)}</span>
        <button class="btn small primary" data-assign="${best.team}">Assign to ${esc(tname(best.team))}</button></div>
      <div class="alts">Others: ${cands.slice(1, 5).map(c => `<button class="btn small" data-assign="${c.team}" data-hot="${c.team}"><span class="sw" style="background:${teamColor(c.team)}"></span>${esc(tname(c.team))} · ${c.st.travel} min · ${hm(c.st.start)} <span class="chip ${c.verdict}">${esc(c.vtxt)}</span></button>`).join(" ")}</div></div>`;
  } else focus = `<div class="panel focus">${IDS.length ? "<b>Every order is on a team.</b> Continue to Stage 2 to review them on the map." : `<b>No ${esc(UI.city)} orders on this date.</b> Use + Add order, or pick another date.`}</div>`;

  const optsFor = oid => {
    const cs = candidates(oid), by = {}; cs.forEach(c => by[c.team] = c);
    return `<option value="">Assign team…</option>` + state.teams.map(t => { const c = by[t.team];
      const star = c.rank === 1 ? "★ " : "", flag = c.verdict === "bad" ? " ⚠ " + c.vtxt : c.verdict === "warn" ? " (" + c.vtxt + ")" : "";
      return `<option value="${t.team}" ${teamOfId[oid] === t.team ? "selected" : ""}>${star}${esc(t.name)} · ${c.prevId ? c.st.travel + " min from " + c.prevId : "first job"} · starts ${hm(c.st.start)}${flag}</option>`; }).join("");
  };
  const table = `<div id="stp-tw"><table><thead><tr><th>Order</th><th>Customer · address</th><th>Start</th><th>Windows</th><th>ETA · day 07:00–20:00</th><th>Ends</th><th>Team</th></tr></thead><tbody>
    ${rows.map(oid => { const f = F[oid], st = stopOf[oid], tn = teamOfId[oid];
      const endTxt = st ? hm(st.end) : hm(mins(f.slot) + f.minutes);
      const note = st ? (st.late ? `<span class="chip bad">TIME CHANGE +${st.late}</span>` : st.minor ? `<span class="chip warn">starts ${hm(st.start)} (+${st.minor})</span>` : st.wait > 15 ? `<span class="chip">waits ${Math.round(st.wait)} min</span>` : "") + (st.over ? `<span class="chip bad">ends after limit</span>` : "") : "";
      return `<tr class="orow ${f.emaar ? "emaar" : ""} ${oid === id ? "focused" : ""}" data-focus="${oid}" style="${tn ? `border-left:6px solid ${teamColor(tn)}` : "border-left:6px solid transparent"}">
        <td><b>${esc(oid)}</b> <button class="lnk" data-remove="${oid}" title="Remove from this list" aria-label="Remove ${oid}">✕</button>${f.hold ? ' <span class="chip warn">ISR / odd time</span>' : f.manual ? ' <span class="chip">added</span>' : ""}<div class="muted" style="font-size:12px">${esc(f.city)} · <label class="etog ${f.emaar ? "on" : ""}" title="${f.emaar_auto ? "The address looks like Emaar" : "The address does not look like Emaar"}${state.emaarSet && oid in state.emaarSet ? " - you changed it" : ""}"><input type="checkbox" data-emaar="${oid}" ${f.emaar ? "checked" : ""}>Emaar${state.emaarSet && oid in state.emaarSet ? "*" : ""}</label>${f.scaffolding ? " · scaffolding" : ""}${f.motor ? " · motor" : ""}</div></td>
        <td>${esc(f.customer)}<div class="muted" style="font-size:12px">${esc(f.address)}</div></td>
        <td><input type="time" step="300" value="${esc(f.slot)}" data-time="${oid}" aria-label="Start time of ${oid}">${f.slot !== f.sheet_slot ? `<div class="muted" style="font-size:11.5px">sheet ${esc(f.sheet_slot)} <button class="lnk" data-treset="${oid}">reset</button></div>` : ""}</td>
        <td>${winViz(f)}</td>
        <td>${etaViz(oid, st, tn)}</td>
        <td><b>${endTxt}</b>${st ? "" : ' <span class="muted" style="font-size:11.5px">if on time</span>'}<div>${note}</div></td>
        <td><select data-team-for="${oid}" aria-label="Team for ${oid}">${optsFor(oid)}</select></td></tr>`; }).join("")}
    </tbody></table></div>`;
  const gone = state.removed.map(i => DAY.facts[i] || DAY.held[i]).filter(f => f && f.city === UI.city);
  $("s1").innerHTML = head + captionHtml() + focus + `<div class="panel" style="padding:0;margin-top:8px">${table}</div>
    ${gone.length ? `<div class="muted" style="font-size:12px;margin-top:6px">Removed from this list: ${gone.map(f => `<span class="chip">${esc(f.order_id)} ${esc(f.customer)} <button class="lnk" data-restore="${esc(f.order_id)}">restore</button></span>`).join(" ")}</div>` : ""}
    <div class="muted" style="font-size:12px;margin-top:6px">Start times come from the 3D sheet${DAY.synced_at ? " (synced " + String(DAY.synced_at).slice(0, 16).replace("T", " ") + " UTC)" : ""}${edited ? `; ${edited} edited here` : ""}. Edit a time and the end time and team options update. The first-wave (${state.wave}) orders are never moved earlier.</div>`;
  const tw = $("tw"); if (tw) tw.scrollTop = keep;
}

/* ---------------- people rules (stage 2, once crews are named) ---------------- */
const people = () => ROSTER.people;
function crewRules(t, seq){
  const mem = (t.members || []).map(n => people().find(p => p.name === n) || {name: n});
  const out = [];
  if (!mem.length){ if (seq.length) out.push(["soft", "Crew not named yet"]); return out; }
  const has = k => seq.some(i => F[i][k]);
  if (has("emaar") && !mem.some(m => m.emaar)) out.push(["bad", "Emaar order, but nobody here is Emaar-cleared"]);
  if (has("motor") && mem.some(m => m.no_motor)) out.push(["bad", `${mem.filter(m => m.no_motor).map(m => m.name).join(" & ")} should not get motor orders`]);
  if (has("scaffolding") && mem.some(m => m.no_scaffolding)) out.push(["bad", `${mem.filter(m => m.no_scaffolding).map(m => m.name).join(" & ")} should not get scaffolding`]);
  return out;
}

/* ---------------- Stage 2 ---------------- */
function crewLabel(c){ return `Team ${c.team} ${c.members.join(" & ")}`; }
function renderStage2(){
  const res = {}; state.teams.forEach(t => res[t.team] = simulate(state.assign[t.team] || []));
  const items = [];
  const q = queue();
  if (q.length) items.push(["bad", `${q.length} order${q.length > 1 ? "s are" : " is"} not on any team yet (tray below).`]);
  for (const t of state.teams){
    for (const s of res[t.team].stops){
      if (s.late) items.push(["bad", `TIME CHANGE: ${s.id} on ${t.name} starts ${hm(s.start)} for a ${F[s.id].slot} appointment (+${s.late} min).`]);
      if (s.over) items.push(["bad", `${s.id} on ${t.name} ends ${hm(s.end)}, ${Math.round(s.over)} min past the limit.`]);
    }
    for (const [lv, tx] of crewRules(t, state.assign[t.team] || [])) if (lv !== "soft") items.push([lv, `${t.name}: ${tx}`]);
  }
  const unnamed = state.teams.filter(t => (state.assign[t.team] || []).length && !(t.members || []).length).length;
  if (unnamed) items.push(["soft", `${unnamed} team${unnamed > 1 ? "s have" : " has"} no crew named yet. Type a name or pick a crew on each card; the Emaar / motor / scaffolding checks run once a crew is named.`]);
  const minor = state.teams.reduce((a, t) => a + res[t.team].stops.filter(s => s.minor).length, 0);
  if (!items.some(i => i[0] === "bad")) items.unshift(["ok", "No rule breaks and no appointment changes."]);
  if (minor) items.push(["soft", `${minor} start${minor > 1 ? "s are" : " is"} up to ${FREE_LATE} min after the appointment (inside the free window).`]);
  $("checks").innerHTML = items.map(([c, x]) => `<li class="${c}">${esc(x)}</li>`).join("");

  const gone2 = state.removed.map(i => DAY.facts[i] || DAY.held[i]).filter(f => f && f.city === UI.city);
  $("tray").innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0 0 4px">Not on a team</h2><span style="display:inline-flex;gap:8px;align-items:center"><button class="btn small" id="stp-b-addorder" title="Add an ISR / odd-time order or a new one; it lands here, then drag it onto a team">+ Add order</button>${sortSel()}</span></div>
    ${gone2.length ? `<div class="muted" style="font-size:11.5px">Removed: ${gone2.map(f => `<span class="chip">${esc(f.order_id)} ${esc(f.customer)} <button class="lnk" data-restore="${esc(f.order_id)}">restore</button></span>`).join(" ")}</div>` : ""}
    <div class="legend"><span class="kit motor">motor</span><span class="kit pelmet">pelmet box</span><span class="kit bend">bend rail</span><span class="kit scaf">scaffolding</span></div>` + (q.length
    ? `<div class="muted" style="font-size:12.5px">Drag onto a team below, or go back to Stage 1 to place them with suggestions.</div><div class="tray">${q.map(i => `<span class="chip" draggable="true" data-id="${i}">${F[i].slot} · ${i} · ${esc(F[i].customer)}</span>`).join("")}</div>`
    : `<span class="muted">✓ Every order is on a team.</span>`);

  $("crews").innerHTML = ROSTER.teams.filter(c => c.members.length).map(c => `<option value="${esc(crewLabel(c))}">`).join("") +
    people().map(p => `<option value="${esc(p.name)}">`).join("");

  const teamsHtml = sortedTeams(res).map(t => {
    const r = res[t.team], seq = state.assign[t.team] || [], tc = teamColor(t.team);
    const rules = crewRules(t, seq);
    let body = seq.length ? "" : `<div class="empty">No orders. Drag one here.</div>`;
    r.stops.forEach((s, i) => {
      const f = F[s.id];
      body += `<p class="drv">${i === 0 ? `leave ${hm(r.depart)} · ` : ""}🚐 ${s.travel} min · ${s.km} km</p>
      <div class="stop ${f.emaar ? "emaar" : ""}" draggable="true" data-id="${s.id}" data-team="${t.team}" style="--tc:${tc}">
        <div class="l1"><span class="sheett" title="Time on the 3D sheet"><span>3D</span><b>${esc(f.sheet_slot)}</b></span>${f.slot !== f.sheet_slot ? `<em class="youset" title="You changed the time">→ ${esc(f.slot)}</em>` : ""}<span class="who" title="${esc(s.id + " " + f.customer)}"><span class="oid">${s.id}</span> ${esc(f.customer)}</span><button class="lnk rmx" data-remove="${s.id}" title="Remove from this day's plan (you can restore it above)" aria-label="Remove ${s.id}">✕</button></div>
        <div class="pt">Planned <b>${hm(s.start)}–${hm(s.end)}</b> · arr ${hm(s.arrive)}${s.delay > 0 ? ` <span class="chip ${s.late ? "bad" : "warn"}">+${s.delay}</span>` : ""}${s.over ? ` <span class="chip bad">after limit</span>` : ""}</div>
        <div class="ad" title="${esc(f.address)}">${esc(f.address)}</div>
        <div class="jw2">${f.emaar ? `<span class="chip emaar">EMAAR</span> ` : ""}${workLineHtml(s.id)}</div>
        ${specialsHtml(s.id)}</div>`;
    });
    return `<article class="team" data-team="${t.team}" style="--tc:${tc}">
      <input class="nm" list="stp-crews" value="${esc(t.name)}" data-tname="${t.team}" aria-label="Name of team ${t.team}" placeholder="Type a name, or pick a crew">
      <input class="mem" list="stp-crews" value="${esc((t.members || []).join(" & "))}" data-tmem="${t.team}" aria-label="Members of team ${t.team}" placeholder="Members, e.g. Ikbal & Kaleem">
      <div class="metrics"><span><b>${r.orders}</b> jobs</span><span><b>${r.windows}</b> win</span><span><b>${(r.work / 60).toFixed(1)}</b> h</span>${r.orders ? `<span><b>${hm(r.depart)}</b>–<b>${hm(r.home)}</b></span>` : ""}</div>
      ${rules.map(([lv, tx]) => `<div><span class="chip ${lv === "bad" ? "bad" : "warn"}">${esc(tx)}</span></div>`).join("")}
      ${body}</article>`;
  }).join("");
  $("teams").innerHTML = teamsHtml;
}

/* actions on the schedule (stage 2) */
function removeAll(id){ for (const t in state.assign) state.assign[t] = state.assign[t].filter(i => i !== id); }
function moveOrder(id, team){
  removeAll(id);
  if (team !== "un") state.assign[team] = bestInsert(state.assign[team] || [], id);
  state.history = state.history.filter(h => h.id !== id); save(); paint();
}
function shift(team, idx, d){
  const s = state.assign[team], j = idx + d; if (j < 0 || j >= s.length) return;
  [s[idx], s[j]] = [s[j], s[idx]]; save(); paint();
}
function setName(team, v){
  const t = teamOf(team), crew = ROSTER.teams.find(c => c.members.length && crewLabel(c) === v);
  t.name = v.trim() || ("Team " + team);
  if (crew) t.members = crew.members.slice();
  save(); paint();
}
function setMembers(team, v){
  const crew = ROSTER.teams.find(c => c.members.length && crewLabel(c) === v);
  const t = teamOf(team);
  if (crew){ t.members = crew.members.slice(); t.name = crewLabel(crew); }
  else t.members = v.split(/&|,/).map(x => x.trim()).filter(Boolean);
  save(); paint();
}

/* ---------------- sorting (Stage 1 table, Stage 2 cards) ---------------- */
const natural = (a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: "base"});
function sortedIds(teamOfId, stopOf){
  const byTime = (a, b) => F[a].slot.localeCompare(F[b].slot) || a.localeCompare(b);
  if ((UI.sort || "time") === "time") return IDS.slice().sort(byTime);
  // by team name; within a team in visit order; orders not on a team last
  return IDS.slice().sort((a, b) => {
    const ta = teamOfId[a], tb = teamOfId[b];
    if (!ta !== !tb) return ta ? -1 : 1;
    if (ta && tb && ta !== tb) return natural(tname(ta), tname(tb));
    if (ta && tb) return (stopOf[a] ? stopOf[a].start : 0) - (stopOf[b] ? stopOf[b].start : 0);
    return byTime(a, b);
  });
}
function sortedTeams(res){
  const t = state.teams.slice();
  if ((UI.sort || "time") === "team") return t.sort((a, b) => natural(a.name, b.name));
  const first = x => res[x.team].stops.length ? res[x.team].stops[0].start : 1e9;
  return t.sort((a, b) => first(a) - first(b) || natural(a.name, b.name));
}
const sortSel = () => `<label class="muted">Sort <select id="stp-sortSel"><option value="time" ${UI.sort !== "team" ? "selected" : ""}>by time</option><option value="team" ${UI.sort === "team" ? "selected" : ""}>by team name</option></select></label>`;

/* ---------------- special requirements (Stage 2) ---------------- */
function specials(id){
  const f = F[id], c = f.counts || {}, out = [];
  const add = (lvl, txt, detail) => out.push({lvl, txt, detail});
  const extrasLike = re => (f.extras || []).filter(x => re.test(x));
  if (f.motor || c.motor_windows) add("hot", `Motor ×${c.motor_windows || 1}`, extrasLike(/motor|somfy|movelite|glydea|track|charger/i).join(" · "));
  if (c.remote) add("hot", `Remote ×${c.remote}`, extrasLike(/remote|situo|telis|channel/i).join(" · "));
  if (f.existing_motor_track) add("hot", "Client's existing motorised track");
  if (c.pelmet) add("hot", `Pelmet box ×${c.pelmet}`);
  if (c.flex) add("hot", `Bend / flexible rail ×${c.flex}`);
  if (c.cassette) add("", `Cassette ×${c.cassette}`);
  if (f.scaffolding) add("bad", "Scaffolding", c.max_h ? `tallest window ${Math.round(c.max_h)} cm` : "");
  else if (c.h_over_tall) add("", `Tall window ×${c.h_over_tall}`, `max ${Math.round(c.max_h)} cm`);
  if (c.w_over_std) add("", `Wide window ×${c.w_over_std}`, `max ${Math.round(c.max_w)} cm, extra time added`);
  if (c.removal) add("hot", `Remove existing ×${c.removal}`, (f.removal_notes || []).join(" · "));
  if (f.emaar) add("emaar", "Emaar permit needed");
  if (f.villa) add("", `Villa, may run to ${R.villa_work_end}`);
  if (f.loc_note && /unknown|confirm|wrong|centre|center|check|area only|not set/i.test(f.loc_note)) add("warn", "Location to confirm", f.loc_note);
  if (f.sheet_notes && !/not captured/i.test(f.sheet_notes)) add("", "Sheet note", f.sheet_notes);
  return out;
}
// shown on the Stage 2 card under the work line, so only what that line does not already say -
// motor / remote / removal / scaffolding appear here only when there is detail worth hovering for
const IN_WORKLINE = /^(Pelmet box|Bend \/ flexible rail|Villa)/;
function specialsHtml(id){
  const sp = specials(id).filter(x => !IN_WORKLINE.test(x.txt) && (!/^(Motor|Remote|Remove existing|Scaffolding)/.test(x.txt) || x.detail));
  const f = F[id], cm = [...new Set((f.comments || []).filter(Boolean))];
  if (!sp.length && !cm.length) return "";
  const short = t => t.replace(/^Tall window/, "tall").replace(/^Wide window/, "wide").replace(/^Location to confirm$/, "location?")
    .replace(/^Client's existing motorised track$/, "existing motor track").replace(/^Emaar permit needed$/, "Emaar permit").replace(/^Remove existing/, "remove")
    .replace(/^Sheet note$/, "sheet note").replace(/^Cassette/, "cassette").replace(/^Motor/, "motor").replace(/^Remote/, "remote");
  return `<div class="specs">${sp.length ? `<span class="spl">⚠ ${sp.map(x => `<span class="sp ${x.lvl}" title="${esc(x.detail || x.txt)}">${esc(short(x.txt))}${x.detail ? "ⓘ" : ""}</span>`).join(" · ")}</span>` : ""}
    ${cm.length ? `<details><summary>PO comments (${cm.length})</summary><ul class="cm">${cm.map(x => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}</div>`;
}

/* ---------------- Play: place every order on the suggested team, explained out loud ---------------- */
let playing = false, playTimer = null, caption = "", playGen = 0;
const sayId = id => String(id).split("").join(" ");
const canSpeak = () => "speechSynthesis" in window;
// spoken times: 13:00 -> "1 pm", 13:30 -> "1:30 pm", 12:00 -> "12 noon" (user, 25 Oct 2026)
const say12 = m => {
  m = Math.round(m); const h = Math.floor(m / 60) % 24, mm = m % 60;
  if (h === 12 && mm === 0) return "12 noon";
  if (h === 0 && mm === 0) return "midnight";
  const h12 = h % 12 || 12, ap = h < 12 ? "am" : "pm";
  return mm ? `${h12}:${String(mm).padStart(2, "0")} ${ap}` : `${h12} ${ap}`;
};
function narrate(id, cands){
  const f = F[id], b = cands[0], st = b.st, parts = [];
  parts.push(`Order ${sayId(id)}, ${f.customer}. Appointment ${say12(mins(f.slot))}, about ${f.minutes} minutes on site, ${f.windows} window${f.windows === 1 ? "" : "s"}.`);
  parts.push(`Best choice: ${tname(b.team)}.`);
  if (b.prevId){
    const prev = b.after.stops[b.after.stops.findIndex(s => s.id === b.prevId)];
    parts.push(`It finishes order ${sayId(b.prevId)} at ${say12(prev.end)}, then drives ${st.travel} minutes, ${st.km} kilometres.`);
  } else parts.push(`It has no job yet and leaves the depot at ${say12(b.after.depart)}.`);
  parts.push(`Arrives at ${say12(st.arrive)}, starts at ${say12(st.start)}` + (st.late ? `, which is ${st.late} minutes after the appointment, so the customer must be told.` : st.minor ? `, ${st.minor} minutes after the appointment, inside the free hour.` : st.wait > 15 ? `, after waiting ${Math.round(st.wait)} minutes for the appointment.` : ", on time.") + ` It ends at ${say12(st.end)}.`);
  if (st.over) parts.push(`Warning: that is after the end of the working day.`);
  if (f.emaar){
    const has = b.why.some(w => /already on an Emaar job/.test(w));
    parts.push(has ? `This is an Emaar order. ${tname(b.team)} already has an Emaar permit job, so the permits stay with fewer crews.` : `This is an Emaar order and needs an Emaar permit for this crew.`);
  }
  if (f.scaffolding) parts.push("Scaffolding is needed.");
  const alt = cands[1];
  if (alt) parts.push(`Next best is ${tname(alt.team)}, ${alt.st.travel} minutes away, starting at ${say12(alt.st.start)}${alt.st.late ? `, ${alt.st.late} minutes late` : ""}.`);
  return parts.join(" ");
}
function speak(text, done){
  if (!UI.voice || !canSpeak()){ playTimer = setTimeout(done, Math.max(2500, text.length * 30 / (UI.rate || 1))); return; }
  speechSynthesis.cancel();
  let fired = false;
  const once = () => { if (fired) return; fired = true; clearTimeout(watchdog); done(); };
  const watchdog = setTimeout(() => { speechSynthesis.cancel(); once(); }, text.length * 110 / (UI.rate || 1) + 5000);
  const u = new SpeechSynthesisUtterance(text);
  const v = speechSynthesis.getVoices().find(x => /^en(-|_)(GB|US|IN|AE)/i.test(x.lang)) || speechSynthesis.getVoices().find(x => /^en/i.test(x.lang));
  if (v) u.voice = v;
  u.lang = "en-GB"; u.rate = UI.rate || 1;
  u.onend = () => { playTimer = setTimeout(once, 600); };
  u.onerror = () => { playTimer = setTimeout(once, 1500); };
  speechSynthesis.speak(u);
}
function stepOnce(auto){
  const gen = playGen, q = queue();
  if (!q.length){ caption = "All orders are on a team."; stopPlay(); if (UI.voice && canSpeak()){ speechSynthesis.speak(new SpeechSynthesisUtterance(caption)); } paint(); return; }
  const id = q[0]; state.cur = id; const cands = candidates(id), best = cands[0];
  caption = narrate(id, cands); hot = best.team; paint();
  speak(caption, () => {
    if (gen !== playGen || (!playing && auto)) return;
    if (!queue().includes(id)) return;            // placed by hand meanwhile
    assignTo(id, best.team);
    if (playing) stepOnce(true);
  });
}
function startPlay(){ if (playing) return; playing = true; stepOnce(true); }
function haltPlay(){ playing = false; playGen++; clearTimeout(playTimer); if (canSpeak()) speechSynthesis.cancel(); }
function stopPlay(){ haltPlay(); paint(); }
const captionHtml = () => (playing || caption) ? `<div class="panel caption ${playing ? "live" : ""}"><span class="cl">${playing ? "▶ Playing" : "Last explanation"}</span> ${esc(caption)}</div>` : "";
function assignAllSuggested(){
  haltPlay(); caption = "";
  let n = 0;
  for (let id = queue()[0]; id && n < 500; id = queue()[0], n++){
    const best = candidates(id)[0];
    const was = null;
    state.assign[best.team] = insertAt(state.assign[best.team] || [], id);
    state.history.push({id, team: best.team, was});
  }
  state.cur = null; hot = null; save();
  go(2);
  return n;
}
const playCtl = () => `<span class="playctl">
    ${playing ? `<button class="btn small primary" id="stp-b-pause">⏸ Pause</button>` : `<button class="btn small primary" id="stp-b-play" ${queue().length ? "" : "disabled"}>▶ Play</button>`}
    <button class="btn small" id="stp-b-step" ${playing || !queue().length ? "disabled" : ""} title="Place just the next order, with the explanation">⏭ Step</button>
    <button class="btn small" id="stp-b-allgo" ${!queue().length ? "disabled" : ""} title="Put every remaining order on its suggested team, without the narration, and open Stage 2">⏩ Assign all suggested → Stage 2</button>
    <label class="muted" title="Read the reasoning out loud"><input type="checkbox" id="stp-voice" ${UI.voice ? "checked" : ""}> 🔊 voice</label>
    <select id="stp-rate" aria-label="Speed">${[0.8, 1, 1.2, 1.5].map(r => `<option value="${r}" ${Number(UI.rate || 1) === r ? "selected" : ""}>${r}×</option>`).join("")}</select></span>`;

/* ---------------- Stage 3 ---------------- */
// Messages and Tookan use the APPOINTMENT time: the 3D sheet's, or the one the user typed in Stage 1.
// A typed time is listed at the end of this stage so the customer and the sheet can be told.
const ACTIONS = [
  {id: "tookan",   title: "Assign orders on Tookan", about: "One task per order, assigned to the team's agent, at the appointment time."},
  {id: "groups",   title: "Create WhatsApp groups", about: "A group per team named like \"Team 3 Ikbal & Kaleem\"; skipped when the group already exists."},
  {id: "messages", title: "Send the schedule to WhatsApp", about: "Header, your note, one line per job with its installation alert and your job note."},
  {id: "checklist",title: "Send the checklist", about: "The checklist bucket PDFs for each team's jobs, posted after the schedule."},
  {id: "permits",  title: "Create Emaar permits", about: "One permit request for every Emaar order, using the crew's names.", needs: "emaar"},
  {id: "permitwa", title: "Send the Emaar permits to WhatsApp", about: "Each permit goes to the group of the team doing that order.", needs: "emaar"},
];
let picked = new Set();
const notes = () => (state.notes = state.notes || {team: {}, order: {}});
const instAlerts = id => ((DAY.inst && DAY.inst[id]) || []).map(x => String(x).replace(/^•\s*/, ""));
function teamPayload(t){
  const r = simulate(state.assign[t.team] || []);
  return {team: t.team, name: t.name, members: t.members, leave: hm(r.depart), note: notes().team[t.team] || "",
    orders: r.stops.map(s => { const f = F[s.id]; return {
      order_id: s.id, customer: f.customer, phone: f.phone, address: f.address, city: f.city,
      time: f.slot, sheet_time: f.sheet_slot, time_edited: f.slot !== f.sheet_slot,
      planned_start: hm(s.start), planned_end: hm(s.end), late_min: s.delay > 0 ? s.delay : 0, emaar: !!f.emaar,
      installation_alert: instAlerts(s.id), note: notes().order[s.id] || "", lat: f.lat, lng: f.lng}; })};
}
function payload(){
  return {date: UI.date, city: UI.city, teams: state.teams.filter(t => (state.assign[t.team] || []).length).map(teamPayload)};
}
function waText(t){
  const d = new Date(UI.date + "T00:00:00");
  const lines = [`*Installation schedule, ${d.toLocaleDateString("en-GB", {weekday: "short", day: "numeric", month: "short", year: "numeric"})}*`,
    // a crew picked from the list is already named "Team 3 Ikbal & Kaleem": don't repeat the people
    `*${t.name}*${t.members.length && !t.members.every(m => t.name.includes(m)) ? " (" + t.members.join(" & ") + ")" : ""}, leave ${t.leave}`];
  if (t.note) lines.push(`📝 ${t.note}`);
  t.orders.forEach(o => {
    lines.push("", `*${o.time}*  ${o.order_id}  ${o.customer}, ${o.address}${o.emaar ? "  (EMAAR)" : ""}`);
    if (o.installation_alert.length){ lines.push(`   ⚠ *Installation alert*`); o.installation_alert.forEach(a => lines.push(`   • ${a}`)); }
    if (o.note) lines.push(`   📝 ${o.note}`);
  });
  return lines.join("\n");
}
// one line of what the job is: windows by kind, then the things that need kit or time
function workLine(id){
  const f = F[id] || {}, c = f.counts || {}, p = [];
  if (f.windows) p.push(`${f.windows} win`); else if (f.kind) p.push(f.kind);
  if (c.curt_2l) p.push(`${c.curt_2l}×2L`);
  if (c.curt_1l) p.push(`${c.curt_1l}×1L`);
  if (c.blinds) p.push(`${c.blinds} blind${c.blinds > 1 ? "s" : ""}`);
  if (c.pelmet) p.push(`pelmet ×${c.pelmet}`);
  if (c.flex) p.push(`bend rail ×${c.flex}`);
  if (f.motor || c.motor_windows) p.push(`motor ×${c.motor_windows || 1}`);
  if (c.remote) p.push(`remote ×${c.remote}`);
  if (f.scaffolding) p.push("scaffolding");
  if (c.removal) p.push(`remove ×${c.removal}`);
  if (f.villa) p.push("villa");
  const m = Math.round(f.minutes || 0);
  p.push(`≈ ${m >= 60 ? Math.floor(m / 60) + " h " : ""}${m % 60 ? (m % 60) + " min" : ""}`.trim());
  return p.join(" · ");
}
function workLineHtml(id){
  const f = F[id] || {}, c = f.counts || {}, p = [];
  const tag = (cls, txt) => `<span class="kit ${cls}">${txt}</span>`;
  if (f.windows) p.push(`${f.windows} win`); else if (f.kind) p.push(esc(f.kind));
  if (c.curt_2l) p.push(`${c.curt_2l}×2L`);
  if (c.curt_1l) p.push(`${c.curt_1l}×1L`);
  if (c.blinds) p.push(`${c.blinds} blind${c.blinds > 1 ? "s" : ""}`);
  if (f.motor || c.motor_windows) p.push(tag("motor", `motor ×${c.motor_windows || 1}${c.remote ? ` · remote ×${c.remote}` : ""}`));
  else if (c.remote) p.push(tag("motor", `remote ×${c.remote}`));
  if (c.pelmet) p.push(tag("pelmet", `pelmet ×${c.pelmet}`));
  if (c.flex) p.push(tag("bend", `bend rail ×${c.flex}`));
  if (f.scaffolding) p.push(tag("scaf", "scaffolding"));
  if (c.removal) p.push(`remove ×${c.removal}`);
  if (f.villa) p.push("villa");
  const m = Math.round(f.minutes || 0);
  p.push(`≈ ${m >= 60 ? Math.floor(m / 60) + " h " : ""}${m % 60 ? (m % 60) + " min" : ""}`.trim());
  return p.join(" · ");
}
const ACT_SHORT = {tookan: "Tookan", groups: "WA groups", messages: "WA schedule", checklist: "Checklists", permits: "Emaar permits", permitwa: "Permits → WA"};
function renderStage3(){
  const P = payload(), emaarN = P.teams.reduce((a, t) => a + t.orders.filter(o => o.emaar).length, 0);
  const q = queue();
  const edited = P.teams.flatMap(t => t.orders.filter(o => o.time_edited).map(o => ({t, o})));
  const late = P.teams.flatMap(t => t.orders.filter(o => o.late_min > 0).map(o => ({t, o})));
  const jobs = P.teams.reduce((a, t) => a + t.orders.length, 0);
  $("s3").innerHTML = `
    <div class="panel s3bar">
      <b>${P.teams.length} teams · ${jobs} jobs</b>
      ${q.length ? `<span class="chip bad" title="${esc(q.join(", "))}">${q.length} not on a team — left out</span>` : ""}
      ${edited.length ? `<span class="chip bad">${edited.length} time${edited.length > 1 ? "s" : ""} changed from the 3D sheet ↓</span>` : ""}
      <span class="acts">${ACTIONS.map(a => { const off = a.needs === "emaar" && !emaarN;
        return `<label class="act ${off ? "off" : ""}" title="${esc(a.title + ": " + a.about)}"><input type="checkbox" data-act="${a.id}" ${off ? "disabled" : ""} ${picked.has(a.id) ? "checked" : ""}> ${esc(ACT_SHORT[a.id] || a.title)}${a.needs === "emaar" ? ` (${emaarN})` : ""}</label>`; }).join("")}</span>
      <button class="btn small primary" id="stp-b-run" ${picked.size ? "" : "disabled"}>Run ${picked.size || ""}</button>
      <button class="btn small" id="stp-b-dl" title="Download plan (JSON)">⬇ JSON</button>
      <span class="muted" style="font-size:11.5px">Preview only — nothing is sent.</span>
    </div>
    <div class="s3teams">${P.teams.map(t => `<div class="tcard" style="--tc:${teamColor(t.team)}">
      <div class="th"><b>${esc(t.name)}</b>${t.members.length && !t.members.every(m => t.name.includes(m)) ? ` <span class="muted">${esc(t.members.join(" & "))}</span>` : t.members.length ? "" : ` <span class="muted">crew not named</span>`}
        <span class="lv">leave ${t.leave} · ${t.orders.length} job${t.orders.length === 1 ? "" : "s"} · ${t.orders.reduce((a, o) => a + ((F[o.order_id] || {}).windows || 0), 0)} win · ${(t.orders.reduce((a, o) => a + ((F[o.order_id] || {}).minutes || 0), 0) / 60).toFixed(1)} h</span></div>
      <input class="tnote" data-tnote="${t.team}" value="${esc(t.note)}" placeholder="Note for the team (goes on WhatsApp)">
      <ul class="tjobs">${t.orders.map(o => `<li class="${o.emaar ? "emaar" : ""}">
        <span class="tt ${o.time_edited ? "ed" : ""}" title="${o.time_edited ? "3D sheet " + o.sheet_time : "3D sheet time"}">${o.time}</span>
        <span class="tj">${o.order_id} ${esc(o.customer)}</span>${o.emaar ? `<span class="chip emaar">E</span>` : ""}${o.late_min ? `<span class="chip warn" title="expected to start ${o.late_min} min after the appointment">+${o.late_min}</span>` : ""}
        <button class="lnk" data-noteopen="${o.order_id}" title="Add a note for this job">✎</button>
        <div class="jd"><div class="ja">${esc(o.address)}</div><div class="jw">${esc(workLine(o.order_id))}</div></div>
        <input class="onote" data-onote="${o.order_id}" data-team="${t.team}" value="${esc(o.note)}" placeholder="Note for this job" ${o.note ? "" : "hidden"}></li>`).join("")}</ul>
      <details><summary>WhatsApp preview</summary><pre class="wa" id="stp-wa-${t.team}">${esc(waText(t))}</pre></details>
    </div>`).join("")}</div>
    <div class="log" id="stp-log" ${picked.size ? "" : "hidden"} style="margin-top:8px">Tick what you want and press Run.</div>
    <div class="panel timealert ${edited.length ? "on" : ""}" style="margin-top:8px">
      <b>${edited.length ? `⚠ ${edited.length} appointment time${edited.length > 1 ? "s were" : " was"} changed from the 3D sheet` : "✓ Every appointment time is the 3D sheet's"}</b>
      ${edited.length ? `<div>${edited.map(({t, o}) => `<span class="chip">${o.order_id} ${esc(o.customer)} · ${esc(t.name)} · sheet ${o.sheet_time} → <b style="color:var(--bad)">${o.time}</b></span>`).join(" ")}</div>
        <div class="muted" style="font-size:12px">The messages and Tookan use your time. Confirm it with the customer and update the 3D sheet.</div>` : ""}
      ${late.length ? `<div class="muted" style="font-size:12px;margin-top:4px">Expected to start after the appointment: ${late.map(({t, o}) => `${o.order_id} (${esc(t.name)}, +${o.late_min} min)`).join(", ")}.</div>` : ""}
    </div>`;
}
function runPreview(){
  const P = payload(), L = [];
  const emaar = P.teams.flatMap(t => t.orders.filter(o => o.emaar).map(o => ({t, o})));
  const hooks = window.STEPPER_HOOKS;                  // the app plugs its real senders in here
  for (const a of ACTIONS) if (picked.has(a.id)){
    L.push(`> ${a.title}`);
    if (hooks && hooks[a.id]) { L.push("  calling the app hook…"); hooks[a.id](P); continue; }
    if (a.id === "tookan") P.teams.forEach(t => L.push(`  [preview] ${t.orders.length} task(s) for ${t.name}: ${t.orders.map(o => o.order_id + "@" + o.time).join(", ")}`));
    if (a.id === "groups") P.teams.forEach(t => L.push(`  [preview] create group "${t.name}"`));
    if (a.id === "messages") P.teams.forEach(t => L.push(`  [preview] post to "${t.name}":\n` + waText(t).split("\n").map(x => "      " + x).join("\n")));
    if (a.id === "checklist") P.teams.forEach(t => L.push(`  [preview] checklist PDFs for ${t.orders.map(o => o.order_id).join(", ")} → "${t.name}"`));
    if (a.id === "permits") emaar.forEach(({t, o}) => L.push(`  [preview] Emaar permit for ${o.order_id} (${o.customer}) at ${o.time}, crew ${t.members.join(" & ") || "NOT NAMED"}`));
    if (a.id === "permitwa") emaar.forEach(({t, o}) => L.push(`  [preview] permit ${o.order_id} → "${t.name}"`));
    L.push("");
  }
  const edited = P.teams.flatMap(t => t.orders.filter(o => o.time_edited));
  if (edited.length) L.push(`⚠ ${edited.length} time(s) differ from the 3D sheet: ${edited.map(o => `${o.order_id} ${o.sheet_time}→${o.time}`).join(", ")}. See the box at the bottom.`);
  $("log").hidden = false; $("log").textContent = L.join("\n");
}

/* ---------------- map ---------------- */
let map = null, layer = null, tiles = null, fitKey = "";
function initMap(){
  if (!window.L){ $("map").innerHTML = `<div class="empty">The map needs an internet connection.</div>`; return; }
  map = L.map($("map"), {scrollWheelZoom: true});
  layer = L.layerGroup().addTo(map);
  map.setView(CITY_CENTRE[UI.city] || [25.1, 55.2], 10);
  englishBase().then(ok => { if (!ok) rasterBase(); });
}
// every place label is rewritten to its English (or Latin-script) name, so no Arabic appears on the map
async function englishBase(){
  try{
    if (!L.maplibreGL) return false;
    const st = await (await fetch("https://tiles.openfreemap.org/styles/liberty")).json();
    const EN = ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ""];
    st.layers.forEach(l => { const tf = l.layout && l.layout["text-field"]; if (tf && JSON.stringify(tf).includes("name")) l.layout["text-field"] = EN; });
    tiles = L.maplibreGL({style: st, attribution: "&copy; OpenFreeMap &copy; OpenMapTiles &copy; OpenStreetMap contributors"}).addTo(map);
    return true;
  }catch(e){ return false; }
}
function rasterBase(){
  let fails = 0;
  tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19, attribution: "&copy; OpenStreetMap contributors (labels may include Arabic)"}).addTo(map);
  tiles.on("tileerror", () => { if (++fails === 6){ map.removeLayer(tiles); L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {maxZoom: 19, attribution: "Tiles &copy; Esri"}).addTo(map); } });
}
const plab = (id, start, extra) => `<b>${id}</b> · ${hm(start)} · ${F[id].windows}w${extra ? `<small>${extra}</small>` : ""}`;
const pinIcon = (text, color, cls, label) => L.divIcon({className: "", iconSize: [30, 30], iconAnchor: [15, 15],
  html: `<div class="pin ${cls || ""}" style="background:${color}">${esc(text)}${label ? `<span class="lab">${label}</span>` : ""}</div>`});
const legLabel = (a, b, text, color) => L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], {interactive: false,
  icon: L.divIcon({className: "", iconSize: null, html: `<div class="leg-label" style="border-color:${color}">${esc(text)}</div>`})}).addTo(layer);
const ll = id => F[id].lat != null ? [F[id].lat, F[id].lng] : null;
function fit(points, key, force){
  if (!map || !points.length) return;
  if (!force && key === fitKey) return;
  fitKey = key; map.invalidateSize(); map.fitBounds(L.latLngBounds(points).pad(0.18), {maxZoom: 13, animate: false});
}
function drawMap(force){
  if (!map) return;
  layer.clearLayers();
  const stage = state.stage, noPin = [];
  if (stage === 1){
    const id = curId(), pts = [];
    if (state.showRest) for (const i of queue()){ if (i !== id && ll(i)) L.marker(ll(i), {icon: pinIcon("·", "#9aa5b3", "grey")}).addTo(layer).bindPopup(`<b>${i}</b> ${esc(F[i].customer)}<br>${F[i].slot}`); }
    const cands = id ? candidates(id) : [], rankOf = {}; cands.forEach(c => rankOf[c.team] = c);
    for (const t of state.teams){
      const seq = state.assign[t.team] || []; if (!seq.length) continue;
      const last = seq[seq.length - 1], p = ll(last); if (!p){ noPin.push(last); continue; }
      const r = simulate(seq), c = rankOf[t.team], isHot = hot === t.team;
      L.marker(p, {icon: pinIcon(t.team, teamColor(t.team), (F[last].emaar ? "emaar " : "") + (isHot ? "hot" : ""), plab(last, r.stops[r.stops.length - 1].start, "free " + hm(r.free))), zIndexOffset: isHot ? 900 : 300}).addTo(layer)
        .bindPopup(`<b>${esc(t.name)}</b> · last order <b>${last}</b><br>${esc(F[last].customer)}<br>${esc(F[last].address)}<br>Appointment ${F[last].slot} · finishes ${hm(r.free)} · ${seq.length} job(s)`);
      if (id && ll(id) && c){
        const best = c.rank === 1;
        L.polyline([p, ll(id)], {color: teamColor(t.team), weight: best || isHot ? 5 : 2.5, opacity: best || isHot ? 0.95 : 0.5, dashArray: best ? null : "6 7"}).addTo(layer);
        legLabel(p, ll(id), `${c.st.travel}m · ${c.st.km}km`, teamColor(t.team));
      }
      if (p) pts.push({p, rank: c ? c.rank : 99});
    }
    if (id && ll(id)){ L.marker(ll(id), {icon: pinIcon("★", "#14202e", "cur" + (F[id].emaar ? " emaar" : ""), plab(id, mins(F[id].slot))), zIndexOffset: 1000}).addTo(layer)
      .bindPopup(`<b>${id}</b> ${esc(F[id].customer)}<br>${esc(F[id].address)}<br>Appointment ${F[id].slot}`); }
    // frame the city once (and on "Fit to view"); after that only pan, and only when the order in hand is off screen
    const focusPt = id && ll(id) ? ll(id) : null, allPts = pts.map(x => x.p).concat(focusPt ? [focusPt] : []);
    if (force || fitKey !== scopeKey() + "|1"){
      if (allPts.length) fit(allPts, scopeKey() + "|1", true); else { fitKey = scopeKey() + "|1"; map.setView(CITY_CENTRE[UI.city], 10); }
    } else if (state.autoZoom && focusPt && !map.getBounds().pad(-0.08).contains(focusPt)) map.panTo(focusPt, {animate: false});
  } else {
    const all = [];
    for (const t of state.teams){
      if (hiddenTeams.has(t.team)) continue;
      const seq = state.assign[t.team] || [], r = simulate(seq), line = []; let last = null;
      r.stops.forEach((s, i) => {
        const p = ll(s.id); if (!p){ noPin.push(s.id); return; }
        line.push(p); all.push(p);
        if (last) legLabel(last, p, `${s.travel}m · ${s.km}km`, teamColor(t.team));
        last = p;
        L.marker(p, {icon: pinIcon(i + 1, teamColor(t.team), F[s.id].emaar ? "emaar" : "", plab(s.id, s.start)), zIndexOffset: 400}).addTo(layer)
          .bindPopup(`<b>${esc(t.name)} · stop ${i + 1}</b><br><b>${s.id}</b> ${esc(F[s.id].customer)}<br>${esc(F[s.id].address)}<br>${F[s.id].slot} → ${hm(s.start)}–${hm(s.end)}<br>
            <select onchange="moveOrder('${s.id}', this.value==='un'?'un':Number(this.value))"><option value="">Move to team…</option>${state.teams.filter(x => x.team !== t.team).map(x => `<option value="${x.team}">${esc(x.name)}</option>`).join("")}<option value="un">Take off the schedule</option></select>`);
      });
      if (line.length > 1) L.polyline(line, {color: teamColor(t.team), weight: 4, opacity: .85}).addTo(layer);
    }
    for (const i of queue()) if (ll(i)) { L.marker(ll(i), {icon: pinIcon("?", "#fff", "grey")}).addTo(layer).bindPopup(`<b>${i}</b> not on a team`); all.push(ll(i)); }
    fit(all, scopeKey() + "|s2|" + state.teams.length + "|" + [...hiddenTeams].join(","), !!force);
  }
  $("map-nopin").textContent = noPin.length ? `Not on the map (no location): ${noPin.join(", ")}.` : "";
}
const hiddenTeams = new Set();

function renderMapBar(){
  setTimeout(() => { const a = $("maptoggleall"); if (a) a.indeterminate = state.teams.some(t => hiddenTeams.has(t.team)) && !state.teams.every(t => hiddenTeams.has(t.team)); }, 0);
  if (state.stage === 1){
    $("mapbar").innerHTML = `<b style="color:var(--ink)">Latest order of each team</b>
      <label title="Pans to the order you click if it is off screen. It never changes your zoom."><input type="checkbox" id="stp-autozoom" ${state.autoZoom ? "checked" : ""}>follow the order in hand</label>
      <label><input type="checkbox" id="stp-showrest" ${state.showRest ? "checked" : ""}>show orders still to place</label>
      <button class="btn small" id="stp-b-fit">Fit ${esc(UI.city)}</button>`;
  } else {
    // one box to show or hide every team on the map (user, 25 Oct 2026); half-ticked when some are hidden
    const allOn = !state.teams.some(t => hiddenTeams.has(t.team));
    $("mapbar").innerHTML = `<label class="allteams"><input type="checkbox" id="stp-maptoggleall" ${allOn ? "checked" : ""}><b>All teams</b></label>` +
      state.teams.map(t => `<label><input type="checkbox" data-maptoggle="${t.team}" ${hiddenTeams.has(t.team) ? "" : "checked"}><span class="sw" style="background:${teamColor(t.team)}"></span>${esc(t.name)}</label>`).join("") +
      `<button class="btn small" id="stp-b-fit">Fit ${esc(UI.city)}</button>`;
  }
}

/* ---------------- header (date, city), add-order panel, map/table splitter ---------------- */
function renderHeader(){
  const d = $("dateSel"); if (d && d.value !== UI.date) d.value = UI.date;
  const cnt = c => Object.values(DAY.facts).filter(f => f.city === c).length;
  $("citySeg").innerHTML = ["Dubai", "Abu Dhabi"].map(c => `<button class="${c === UI.city ? "on" : ""}" data-setcity="${c}">${c} <span class="n2">${cnt(c)}</span></button>`).join("");
}
async function loadDay(date){
  if (DAYS[date]) return DAYS[date];
  loading(true, "Loading the 3D sheet for " + date + "…");
  try {
    const raw = await rpc("fn_sched_day_raw", {p_date: date});
    const day = buildDay(raw || {}, R);
    const ids = [...new Set(Object.values(day.facts).concat(Object.values(day.held)).map(f => f.order_id))];
    day.inst = {};
    if (ids.length){
      const rows = await api(`/rest/v1/order_install_alerts?select=order_id,lines&order_id=in.(${ids.map(encodeURIComponent).join(",")})`) || [];
      rows.forEach(r => { day.inst[r.order_id] = r.lines || []; });
      Object.values(day.held).forEach(h => { if (day.inst[h.order_id] && h.key !== h.order_id) day.inst[h.key] = day.inst[h.order_id]; });
    }
    day.date_label = new Date(date + "T00:00:00").toLocaleDateString("en-GB", {weekday: "short", day: "2-digit", month: "short", year: "numeric"});
    DAYS[date] = day;
    return day;
  } finally { loading(false); }
}
async function switchDate(date){
  if (!date) return;
  haltPlay(); caption = "";
  UI.date = date; saveUI();
  try { await loadDay(date); } catch (e) { toast((e && e.message) || "Could not load that day", "bad"); return; }
  enterScope(); paint();
}
const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function openAdd(){
  const held = Object.values(DAY.held).filter(h => h.city === UI.city && !state.added.includes(h.key));
  $("addbody").innerHTML = `
    <h2 style="margin:0 0 6px">Add an order to ${esc(UI.city)}</h2>
    <h3>From the held list (ISR / odd time)</h3>
    ${held.length ? held.map(h => `<div class="heldrow"><div><b>${esc(h.order_id)}</b> <span class="chip warn">${esc(h.entry_type === "issue_resolution" ? "ISR" : "odd time")}</span> ${esc(h.customer)} · sheet ${esc(h.slot)} · ${h.minutes} min
        <div class="muted" style="font-size:12px">${esc(h.address)}</div></div><button class="btn small" data-addheld="${esc(h.key)}">Add</button></div>`).join("") : `<div class="muted">Nothing held back for ${esc(UI.city)} on this date.</div>`}
    <h3>A new order</h3>
    <div class="formgrid">
      <label>Order no.<input id="stp-na-id" placeholder="e.g. 79500"></label><label>Customer<input id="stp-na-cust"></label>
      <label class="wide">Address<input id="stp-na-addr"></label>
      <label>Start<input id="stp-na-slot" type="time" value="10:00"></label><label>Minutes on site<input id="stp-na-min" type="number" min="5" value="60"></label>
      <label>Windows<input id="stp-na-win" type="number" min="0" value="1"></label><label class="chk"><input id="stp-na-emaar" type="checkbox"> Emaar</label>
      <label>Latitude (optional)<input id="stp-na-lat" placeholder="25.20"></label><label>Longitude (optional)<input id="stp-na-lng" placeholder="55.27"></label>
    </div>
    <div class="muted" style="font-size:12px">Without a pin the order sits at the ${esc(UI.city)} centre, so drive times are rough until you give coordinates.</div>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center"><button class="btn primary" id="stp-b-addmanual">Add order</button><button class="btn" id="stp-b-addclose">Close</button><span id="stp-na-msg" style="color:var(--bad)"></span></div>`;
  $("addpanel").hidden = false;
}
const closeAdd = () => { $("addpanel").hidden = true; };
function setSplit(v, persist){
  UI.split = Math.max(20, Math.min(75, v)); $("main").style.setProperty("--mapw", UI.split + "%");
  if (map) map.invalidateSize(); if (persist) saveUI();
}
function wireSplit(){
  const sp = $("split"); let drag = false;
  sp.addEventListener("pointerdown", e => { drag = true; sp.setPointerCapture(e.pointerId); e.preventDefault(); });
  sp.addEventListener("pointermove", e => { if (!drag) return; const r = $("main").getBoundingClientRect(); setSplit((e.clientX - r.left) / r.width * 100, false); });
  sp.addEventListener("pointerup", () => { if (drag){ drag = false; saveUI(); } });
  sp.addEventListener("dblclick", () => setSplit(42, true));
  sp.addEventListener("keydown", e => { if (e.key === "ArrowLeft") setSplit(UI.split - 3, true); if (e.key === "ArrowRight") setSplit(UI.split + 3, true); });
}

/* ---------------- main ---------------- */
function paint(){
  ROOT.dataset.stage = state.stage;
  ROOT.querySelectorAll(".steps button").forEach(b => b.classList.toggle("on", Number(b.dataset.stage) === state.stage));
  const heldN = Object.values(DAY.held).filter(h => h.city === UI.city && !state.added.includes(h.key)).length;
  $("sub").textContent = `${DAY.date_label} · ${UI.city} · ${IDS.length} orders · ${heldN} ISR / odd-time held back · leave ${BASE.name} from ${BASE.depart_earliest}`;
  renderHeader();
  renderMapBar();
  if (state.stage === 1) renderStage1();
  if (state.stage === 2) renderStage2();
  if (state.stage === 3) renderStage3();
  drawMap();
  if (map) setTimeout(() => map.invalidateSize(), 0);
}
function go(n){ state.stage = n; fitKey = ""; save(); paint(); window.scrollTo({top: 0}); setTimeout(() => { if (map){ map.invalidateSize(); drawMap(true); } }, 60); }

on("click", e => {
  const row = e.target.closest ? e.target.closest("tr[data-focus]") : null;
  if (row && !e.target.closest("select,input,button") && state.stage === 1){ state.cur = row.dataset.focus; hot = null; save(); paint(); return; }
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.stage) go(Number(b.dataset.stage));
  if (b.dataset.go) go(Number(b.dataset.go));
  if (b.dataset.assign) assignTo(curId(), Number(b.dataset.assign));
  if (b.dataset.treset){ delete state.times[b.dataset.treset]; applyTimes(); save(); paint(); }
  if (b.dataset.shift) shift(b.dataset.team, Number(b.dataset.idx), Number(b.dataset.shift));
  if (idOf(b) === "b-undo") undo();
  if (idOf(b) === "b-addteam") addTeam();
  if (idOf(b) === "b-reset"){
    if (!resetArmed){ resetArmed = true; clearTimeout(resetTimer); resetTimer = setTimeout(() => { resetArmed = false; paint(); }, 4000); paint(); }
    else { clearTimeout(resetTimer); restart(state.wave); }
  }
  if (idOf(b) === "b-fit") drawMap(true);
  if (b.dataset.dshift) switchDate(addDays(UI.date, Number(b.dataset.dshift)));
  if (b.dataset.setcity){ haltPlay(); caption = ""; UI.city = b.dataset.setcity; saveUI(); enterScope(); paint(); }
  if (b.dataset.remove) removeOrder(b.dataset.remove);
  if (b.dataset.restore) restoreOrder(b.dataset.restore);
  if (b.dataset.addheld) { addHeld(b.dataset.addheld); closeAdd(); }
  if (idOf(b) === "b-addorder") openAdd();
  if (idOf(b) === "b-addclose") closeAdd();
  if (idOf(b) === "b-addmanual"){ const g = k => $(k).value; const msg = addManual({id: g("na-id"), customer: g("na-cust"), address: g("na-addr"), slot: g("na-slot"), minutes: g("na-min"), windows: g("na-win"), emaar: $("na-emaar").checked, lat: g("na-lat"), lng: g("na-lng")}); if (msg) $("na-msg").textContent = msg; else closeAdd(); }
  if (idOf(b) === "b-run") runPreview();
  if (b.dataset.noteopen){ const i = b.parentNode.querySelector("input[data-onote]"); if (i){ i.hidden = !i.hidden || false; if (!i.hidden) i.focus(); } }
  if (idOf(b) === "b-play") startPlay();
  if (idOf(b) === "b-pause") stopPlay();
  if (idOf(b) === "b-step"){ haltPlay(); stepOnce(false); }
  if (idOf(b) === "b-allgo") assignAllSuggested();
  if (idOf(b) === "b-dl"){
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(payload(), null, 1)], {type: "application/json"}));
    a.download = `schedule_plan_${UI.date}_${UI.city.replace(/ /g, "")}.json`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }
});
on("change", e => {
  const el = e.target;
  if (el.matches("input[data-emaar]")){
    const id = el.dataset.emaar; state.emaarSet = state.emaarSet || {};
    if (el.checked === F[id].emaar_auto) delete state.emaarSet[id]; else state.emaarSet[id] = el.checked;
    applyTimes(); save(); paint();
  }
  if (el.matches("input[data-time]")){ if (el.value) state.times[el.dataset.time] = el.value; else delete state.times[el.dataset.time]; applyTimes(); state.cur = el.dataset.time; save(); paint(); }
  if (el.matches("select[data-team-for]")){ if (playing) stopPlay(); assignTo(el.dataset.teamFor, el.value === "" ? "" : Number(el.value)); }
  if (idOf(el) === "wave") restart(el.value, true);
  if (idOf(el) === "sortSel"){ UI.sort = el.value; saveUI(); paint(); }
  if (idOf(el) === "voice"){ UI.voice = el.checked; saveUI(); if (!el.checked && canSpeak()) speechSynthesis.cancel(); }
  if (idOf(el) === "rate"){ UI.rate = Number(el.value); saveUI(); }
  if (idOf(el) === "dateSel") switchDate(el.value);
  if (idOf(el) === "early"){ state.allowEarly = el.checked; save(); paint(); }
  if (idOf(el) === "autozoom"){ state.autoZoom = el.checked; fitKey = ""; save(); paint(); }
  if (idOf(el) === "showrest"){ state.showRest = el.checked; save(); paint(); }
  if (el.matches("select[data-move]") && el.value) moveOrder(el.dataset.move, el.value === "un" ? "un" : Number(el.value));
  if (el.matches("input[data-tname]")) setName(el.dataset.tname, el.value);
  if (el.matches("input[data-tmem]")) setMembers(el.dataset.tmem, el.value);
  if (el.matches("input[data-maptoggle]")){ const n = Number(el.dataset.maptoggle); el.checked ? hiddenTeams.delete(n) : hiddenTeams.add(n); fitKey = ""; renderMapBar(); drawMap(); }
  if (idOf(el) === "maptoggleall"){ if (el.checked) hiddenTeams.clear(); else state.teams.forEach(t => hiddenTeams.add(t.team)); fitKey = ""; renderMapBar(); drawMap(); }
  if (el.matches("input[data-act]")){ el.checked ? picked.add(el.dataset.act) : picked.delete(el.dataset.act); renderStage3(); }
});
// Stage 3 notes: saved as you type and shown in the message preview, without redrawing the page
on("input", e => {
  const el = e.target, n = notes();
  if (el.matches("[data-tnote]")) n.team[el.dataset.tnote] = el.value;
  else if (el.matches("input[data-onote]")) n.order[el.dataset.onote] = el.value;
  else return;
  save();
  const team = el.dataset.tnote || el.dataset.team, t = teamOf(team), pre = $("wa-" + team);
  if (t && pre) pre.textContent = waText(teamPayload(t));
});
// hovering a row in the suggestion table highlights that team on the map
on("mouseover", e => {
  const r = e.target.closest ? e.target.closest("[data-hot]") : null, n = r ? Number(r.dataset.hot) : null;
  if (n !== hot){ hot = n; if (state.stage === 1) drawMap(); }
});
// drag and drop between teams (stage 2)
let dragFrom = null;
on("dragstart", e => {
  const s = e.target.closest ? e.target.closest("[data-id][draggable]") : null; if (!s) return;
  dragFrom = s.dataset.team || null; e.dataTransfer.setData("text/plain", s.dataset.id); e.dataTransfer.effectAllowed = "move"; s.classList.add("dragging");
});
on("dragend", () => { dragFrom = null; ROOT.querySelectorAll(".dragging").forEach(x => x.classList.remove("dragging")); ROOT.querySelectorAll(".team.drop").forEach(x => x.classList.remove("drop")); });
on("dragover", e => {
  const t = e.target.closest ? e.target.closest(".team") : null; if (!t || (dragFrom && t.dataset.team === dragFrom)) return;
  e.preventDefault(); ROOT.querySelectorAll(".team.drop").forEach(x => x !== t && x.classList.remove("drop")); t.classList.add("drop");
});
on("dragleave", e => { const t = e.target.closest ? e.target.closest(".team") : null; if (t && !t.contains(e.relatedTarget)) t.classList.remove("drop"); });
on("drop", e => {
  const t = e.target.closest ? e.target.closest(".team") : null; if (!t) return;
  e.preventDefault(); t.classList.remove("drop");
  const id = e.dataTransfer.getData("text/plain");
  if (id && F[id] && t.dataset.team !== dragFrom) moveOrder(id, Number(t.dataset.team));
});



/* ---------------- route entry ---------------- */
const SKELETON = `<div class="stp" data-stage="1">
<div class="stp-hdr">
  <h1>Step-by-step Scheduler</h1>
  <span class="datebox"><button class="dbtn" data-dshift="-1" aria-label="Previous day">◀</button><input type="date" id="stp-dateSel" class="hsel" aria-label="Date"><button class="dbtn" data-dshift="1" aria-label="Next day">▶</button></span>
  <div class="cityseg" id="stp-citySeg" role="group" aria-label="City"></div>
  <span class="sub" id="stp-sub"></span>
  <nav class="steps" aria-label="Stages">
    <button data-stage="1"><span class="n">1</span>Assign orders</button>
    <button data-stage="2"><span class="n">2</span>Review &amp; adjust</button>
    <button data-stage="3"><span class="n">3</span>Dispatch</button>
  </nav>
</div>
<div class="stp-main" id="stp-main">
  <div id="stp-mapwrap">
    <div class="mapbar" id="stp-mapbar"></div>
    <div id="stp-map"></div>
    <div class="muted" id="stp-map-nopin" style="font-size:12px;margin-top:4px"></div>
  </div>
  <div id="stp-split" role="separator" aria-orientation="vertical" tabindex="0" title="Drag to resize the map and the table (double-click to reset)"></div>
  <section class="s1"><div id="stp-s1"></div></section>
  <section class="s2">
    <div class="panel" style="margin-top:12px"><h2>Checks</h2><ul class="checks" id="stp-checks"></ul></div>
    <div class="panel" id="stp-tray" style="margin-top:10px"></div>
    <div class="teams" id="stp-teams"></div>
    <datalist id="stp-crews"></datalist>
  </section>
  <section class="s3" id="stp-s3" style="margin-top:12px"></section>
</div>
<div id="stp-addpanel" class="smodal" hidden><div class="modalbox" id="stp-addbody"></div></div>
</div>`;

const LIBS = [
  ["css", "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css"],
  ["css", "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"],
  ["js", "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"],
  ["js", "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js"],
  ["js", "https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@0.0.22/leaflet-maplibre-gl.js"],
];
let libsReady = null;
function ensureLibs(){
  // loaded on first visit only, in order (the plugin needs both Leaflet and MapLibre); the rest of the
  // app never pays for a map library it does not use
  if (libsReady) return libsReady;
  libsReady = LIBS.reduce((p, [kind, url]) => p.then(() => new Promise(res => {
    if (document.querySelector(`[data-stplib="${url}"]`)) return res();
    const n = kind === "css" ? Object.assign(document.createElement("link"), {rel: "stylesheet", href: url})
                             : Object.assign(document.createElement("script"), {src: url});
    n.dataset.stplib = url; n.onload = res; n.onerror = res;           // offline: the screen still works without a map
    document.head.appendChild(n);
  })), Promise.resolve());
  return libsReady;
}
window.addEventListener("hashchange", () => { if (!/^#\/stepper/.test(location.hash)) haltPlay(); });

export async function render(mount, state){
  if (!isSignedIn()) return;
  haltPlay(); caption = "";
  ROOT = el(SKELETON);
  mount.innerHTML = ""; mount.appendChild(ROOT);
  HANDLERS.forEach(([type, fn]) => ROOT.addEventListener(type, fn));
  wireSplit();
  try {
    await ensureLibs();
    if (!R){
      const rows = await api("/rest/v1/sched_settings?select=key,value&key=in.(stepper_rules,stepper_roster)") || [];
      const v = Object.fromEntries(rows.map(r => [r.key, r.value]));
      if (!v.stepper_rules || !v.stepper_roster) throw new Error("The scheduler's settings are missing (sched_settings stepper_rules / stepper_roster).");
      R = v.stepper_rules; ROSTER = v.stepper_roster; BASE = ROSTER.base;
      FREE_LATE = R.free_shift_later_min || 60; FREE_EARLY = R.free_shift_earlier_min || 120;
    }
    const pd = state && state.params && state.params.get("date");
    if (pd) UI.date = pd;
    if (!UI.date || UI.date < new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10)){
      try { UI.date = await rpc("fn_sched_next_working_day", {}); } catch (e) { UI.date = null; }
      if (!UI.date) UI.date = addDays(new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10), 1);
    }
    const pc = state && state.params && state.params.get("city");
    if (pc === "Dubai" || pc === "Abu Dhabi") UI.city = pc;
    saveUI();
    await loadDay(UI.date);
  } catch (e) {
    ROOT.querySelector("#stp-s1").innerHTML = `<div class="panel"><b>Could not open the scheduler.</b> ${esc((e && e.message) || e)}</div>`;
    return;
  }
  enterScope();
  setSplit(UI.split, false);
  map = null; initMap();
  paint();
}
