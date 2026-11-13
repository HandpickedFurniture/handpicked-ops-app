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
 * The plan is SHARED since 10 Nov 2026 (stepper_plan, one row per date + city, see stepper-sync.js):
 * everybody who opens a day sees and edits the same plan, every change is logged against the person,
 * and versions can be saved and restored. localStorage keeps a copy so the screen opens at once and
 * works offline. Stage 3 only previews - window.STEPPER_HOOKS is where real senders plug in.
 */
import { rpc, api, isSignedIn, currentActor } from "./api.js";
import { STORAGE_PREFIX } from "./config.js";
import { el, loading, toast, downloadXlsx } from "./ui.js";
import { buildDay, CITY_CENTRE } from "./stepper-facts.js";
import * as live from "./mod-stepper-live.js";   // Stage 4: the live day
import * as sync from "./stepper-sync.js";       // the plan is shared between people (10 Nov 2026)
import { isrBoard, fabricState } from "./mod-isr.js";   // ISR list in Stage 4, Production's answer on Stage 2 cards (13 Nov 2026)

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
  LEG.clear();                                    // locations may have changed (pins, refreshed sheet)
  F = clone(DAY.facts);
  (state.added || []).forEach(i => { if (DAY.held[i]) { F[i] = clone(DAY.held[i]); F[i].hold = true; } });
  Object.entries(state.extra || {}).forEach(([i, f]) => { F[i] = clone(f); F[i].manual = true; });
  // on the plan but no longer on the 3D sheet: kept, flagged, until the user decides (see checkSheet)
  Object.entries(state.sheetGone || {}).forEach(([i, f]) => { if (!F[i]) { F[i] = clone(f); F[i].gone3d = true; } });
  Object.entries(state.isrMap || {}).forEach(([i, n]) => { if (F[i]) F[i].isr_id = n; });
  Object.keys(F).forEach(i => { F[i].sheet_slot = F[i].slot; });
  /* Location (user, 10 Nov 2026: "if you don't have location, say Unknown location and let me pick it on
   * the map"). The resolver falls back to the city centre when it knows nothing (confidence 'none') -
   * that point is NOT a location, so it is never drawn as one. A pin picked by hand wins (state.pins),
   * and is also remembered for the address in geo_place (fn_stepper_set_pin). */
  Object.entries(state.pins || {}).forEach(([i, p]) => { if (F[i]) { F[i].lat = p.lat; F[i].lng = p.lng; F[i].loc_confidence = "manual";
    F[i].loc_note = "Pin set by hand on the map" + (p.by ? " by " + p.by : ""); } });
  Object.keys(F).forEach(i => { const f = F[i];
    f.loc_unknown = f.lat == null || f.loc_confidence === "none";
    f.loc_doubt = !f.loc_unknown && (f.loc_confidence === "low" || /CHECK|km from/.test(f.loc_note || "")); });
  IDS = Object.keys(F).filter(i => F[i].city === UI.city && !(state.removed || []).includes(i));
  // a saved plan can name an order the refreshed 3D sheet no longer has; drop it instead of crashing on F[id]
  if (state.assign){
    for (const t in state.assign) state.assign[t] = state.assign[t].filter(i => F[i]);
    state.waveIds = (state.waveIds || []).filter(i => F[i]); state.history = (state.history || []).filter(h => h.bulk || F[h.id]);
  }
}
let hadLocal = false;
function enterScope(){
  DAY = DAYS[UI.date]; T = {}; KM = {};
  const saved = load(); hadLocal = !!saved;
  state = saved || {added: [], extra: {}, removed: []};
  state.added = state.added || []; state.extra = state.extra || {}; state.removed = state.removed || [];
  buildF();
  if (!saved) { state = fresh(); buildF(); }
  else if (!(state.teams || []).length){ state.teams = [{team: 1, name: "Team 1", members: []}]; state.assign[1] = state.assign[1] || []; }   // plan saved by the crashing build
  applyTimes(); fitKey = ""; hiddenTeams.clear(); hot = null; DIFF = null; picking = null;
  sync.open();
}
/* the shared plan came in (on opening, from somebody else's save, a merge, or a restored version):
 * take it, keeping what is this person's own view (stage, order in hand, map options, Undo) */
function normalise(){
  state.added = state.added || []; state.extra = state.extra || {}; state.removed = state.removed || [];
  state.times = state.times || {}; state.assign = state.assign || {}; state.history = state.history || [];
  if (!(state.teams || []).length){ state.teams = [{team: 1, name: "Team 1", members: []}]; }
  state.teams.forEach(t => { state.assign[t.team] = state.assign[t.team] || []; });
}
function adopt(remote, by){
  const keep = {};
  sync.LOCAL_KEYS.forEach(k => { if (state && k in state) keep[k] = state[k]; });
  state = Object.assign({stage: 1, history: []}, clone(remote), keep);
  normalise(); buildF(); applyTimes(); saveLocal();
  if (ROOT && ROOT.isConnected) paint();
  if (by) toast(`Plan updated by ${String(by).split("@")[0]}`);
}
sync.init({
  scope: () => scopeKey(), day: () => UI.date, city: () => UI.city, stage: () => state && state.stage,
  state: () => state, adopt, hasLocal: () => hadLocal, root: () => ROOT,
  status: (html) => { const x = $("sync"); if (x) x.innerHTML = html; },
});
function restart(wave, keepOrders){
  haltPlay();
  const keep = keepOrders ? {added: state.added, extra: state.extra, removed: state.removed} : {added: [], extra: {}, removed: []};
  state = keep; buildF();                        // the order list first, so the first wave is taken from it
  state = Object.assign(fresh(wave), keep); buildF(); applyTimes();
  hiddenTeams.clear(); hot = null; caption = ""; fitKey = ""; resetArmed = false; save("Started the plan again (cleared every assignment)"); paint();
}
// a two-press confirm on the button itself: the browser's confirm() box is blocked silently in some
// embedded views, which made the button look dead
let resetArmed = false, resetTimer = null;
function applyTimes(){
  IDS.forEach(i => F[i].slot = (state.times && state.times[i]) || F[i].sheet_slot);
  /* ISR tick box (28 Oct 2026): the user can tag any order ISR, or untag one. A tagged installation takes
   * the flat ISR time; untagging puts back what the order had. An order the sheet already calls ISR keeps
   * its (flat) minutes when untagged - the real install time is not known for it. */
  IDS.forEach(i => { const f = F[i];
    if (f.kind_base === undefined){ f.kind_base = f.kind || ""; f.minutes_base = f.minutes; }
    const want = state.isr && i in state.isr ? state.isr[i] : f.kind_base === "ISR";
    if (want){ f.kind = "ISR"; f.minutes = f.kind_base === "ISR" ? f.minutes_base : R.isr_flat_min; }
    else { f.kind = f.kind_base === "ISR" ? "" : f.kind_base; f.minutes = f.minutes_base; }
  });
  // Emaar: what the address says (emaar_auto), unless the user switched it for this order
  IDS.forEach(i => { if (F[i].emaar_auto === undefined) F[i].emaar_auto = !!F[i].emaar || !!F[i].emaar_maybe;
    F[i].emaar = state.emaarSet && i in state.emaarSet ? state.emaarSet[i] : F[i].emaar_auto;
    F[i].maybe = !!F[i].emaar_maybe && !(state.emaarSet && i in state.emaarSet); });
}

/* ---------------- state ---------------- */
// assign: team number -> order ids in visit order. history: [{id, team}] so Undo works one step at a time.
function fresh(wave){
  const slots = slotsNow(); wave = wave || (slots.includes("10:00") ? "10:00" : slots[0]);
  const first = IDS.filter(i => F[i].sheet_slot === wave)
    .sort((a, b) => (F[a].city === "Dubai" ? 0 : 1) - (F[b].city === "Dubai" ? 0 : 1) || a.localeCompare(b));
  const s = {stage: 1, wave, waveIds: first, times: {}, added: [], extra: {}, removed: [], teams: [], assign: {}, history: [], cur: null, allowEarly: false, autoZoom: true, showAll: false, showRest: false};
  first.forEach((id, i) => { s.teams.push({team: i + 1, name: "Team " + (i + 1), members: []}); s.assign[i + 1] = [id]; });
  // no order in the first wave (e.g. a day whose orders all start later): still open with one empty team,
  // otherwise candidates() is empty and the page crashes on best.team
  if (!s.teams.length){ s.teams.push({team: 1, name: "Team 1", members: []}); s.assign[1] = []; }
  return s;
}
function load(){ try{ const s = JSON.parse(localStorage.getItem(KEY()) || "null"); return s && s.assign ? s : null; }catch(e){ return null; } }
function saveLocal(){ try{ localStorage.setItem(KEY(), JSON.stringify(state)); }catch(e){} }
// every change to the plan: kept on this device and pushed to the shared plan; `summary` is the line the
// change log shows against the person's name ("" for a change that needs no line)
function save(summary, kind){ saveLocal(); if (state) sync.changed(summary || "", kind); }
let state = null;

const assignedIds = () => new Set(Object.values(state.assign).flat());
function queue(){
  const done = assignedIds();
  return IDS.filter(i => !done.has(i)).sort((a, b) => F[a].slot.localeCompare(F[b].slot) || (F[a].city === "Dubai" ? 0 : 1) - (F[b].city === "Dubai" ? 0 : 1) || a.localeCompare(b));
}
function curId(){ return IDS.includes(state.cur) ? state.cur : (queue()[0] || null); }
const teamOf = n => state.teams.find(t => t.team === Number(n));
const tname = n => (teamOf(n) || {}).name || ("Team " + n);

/* ---------------- travel: the day's matrix where it exists, else straight-line + the same speed bands ----------------
 * 13 Nov 2026 (user: "many times the distance between two locations is assumed to be just 5 minutes").
 * The 5 minutes was the same-place rule firing for points that are NOT one place:
 *   - every address the resolver could not place sits on the city centre, so two of them were 0 km apart.
 *     Now a leg to or from an UNKNOWN location is a typical city leg (travel.unknown_min, 35), flagged;
 *   - two different addresses resolved to the same community centre were also 0 km apart. Now that is a
 *     short drive inside the community (travel.same_community_min, 12); only the same address, or two exact
 *     pins under 300 m apart, is the same place (5);
 *   - rush hour (travel.peak, 07:00-09:30 and 16:30-19:30) makes the drive slower (travel.peak_factor 1.3).
 * drive() returns [minutes, km, note]; note says which assumption made the number. */
const tkOf = x => x === "BASE" ? "BASE" : (F[x].manual ? null : (F[x].hold ? "H" + x : x));
const ptOf = x => x === "BASE" ? [BASE.lat, BASE.lng] : (F[x].lat != null ? [F[x].lat, F[x].lng] : (CITY_CENTRE[F[x].city] || [BASE.lat, BASE.lng]));
const normAddr = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const EXACT = new Set(["manual", "link", "plus code", "low"]);       // a real pin, not a community centre
const LEG = new Map();                                                 // a -> b without rush hour; cleared by buildF
function baseLeg(a, b){
  const k = a + ">" + b; if (LEG.has(k)) return LEG.get(k);
  const tr = R.travel; let out;
  if (a === b) out = [0, 0, ""];
  else if ((a !== "BASE" && F[a].loc_unknown) || (b !== "BASE" && F[b].loc_unknown))
    out = [tr.unknown_min ?? 35, tr.unknown_km ?? 18, "location unknown"];
  else {
    const A = ptOf(a), B = ptOf(b), rad = Math.PI / 180, dl = (B[0] - A[0]) * rad, dg = (B[1] - A[1]) * rad;
    const h = Math.sin(dl / 2) ** 2 + Math.cos(A[0] * rad) * Math.cos(B[0] * rad) * Math.sin(dg / 2) ** 2;
    const d = 2 * 6371 * Math.asin(Math.sqrt(h));
    if (d < tr.same_place_km){
      const same = a !== "BASE" && b !== "BASE" && normAddr(F[a].address) && normAddr(F[a].address) === normAddr(F[b].address);
      const exact = (a === "BASE" || EXACT.has(F[a].loc_confidence)) && (b === "BASE" || EXACT.has(F[b].loc_confidence));
      out = same || exact ? [tr.same_place_min, 0, "same place"] : [tr.same_community_min ?? 12, 1, "same community"];
    } else {
      const band = tr.bands.find(x => x.max_km == null || d <= x.max_km), road = d * band.road_factor;
      out = [road / band.kmh * 60, Math.round(road * 10) / 10, ""];      // driving only; the buffer is added in drive()
    }
  }
  LEG.set(k, out); return out;
}
function inPeak(clock){
  return clock != null && (R.travel.peak || []).some(([s, e]) => clock >= mins(s) && clock < mins(e));
}
function drive(a, b, clock){
  const ka = tkOf(a), kb = tkOf(b);
  if (ka && kb && T[ka] && T[ka][kb] != null) return [T[ka][kb], (KM[ka] || {})[kb] || 0, ""];
  const [m, km, note] = baseLeg(a, b);
  if (note) return [m, km, note];                                      // flat assumptions: no buffer, no rush hour
  const pk = inPeak(clock) ? (R.travel.peak_factor || 1) : 1;
  return [Math.round(m * pk + R.travel.buffer_min), km, pk > 1 ? "rush hour" : ""];
}
const legNote = s => s.tnote ? ` · ${s.tnote === "location unknown" ? "location unknown, assumed" : s.tnote}` : "";

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
    const f = F[id], [tr, dkm, tnote] = drive(prev, id, clock); travel += tr; km += dkm;
    /* ETA typed by the user: the team is on site at that time, whatever the drive and appointment say */
    const eo = state.eta && state.eta[id], arrive0 = clock + tr;
    const start = eo ? mins(eo) : Math.max(arrive0, earliest(id)), arrive = eo ? start : arrive0;
    const delay = f.slot && !f.flex ? start - mins(f.slot) : 0;          // + = later than the appointment
    const late = delay > FREE_LATE ? delay : 0, minor = delay > 0 && !late ? delay : 0;
    const end = start + f.minutes, limit = f.villa ? mins(R.villa_work_end) : mins(R.work_end);
    stops.push({id, eta_set: !!eo, from: prev, travel: tr, km: dkm, tnote, arrive, start, end, wait: start - arrive, delay, late, minor, over: Math.max(0, end - limit)});
    clock = end; prev = id;
  }
  const back = seq.length ? drive(prev, "BASE", clock)[0] : 0;
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
    if (prevId) why.push(`${st.travel} min drive (${st.km} km${st.tnote ? ", " + st.tnote : ""}) from ${prevId}, free ${hm(prevStop.end)}`);
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
  state.history.push({id, team, was: was ? Number(was) : null}); state.cur = null; hot = null;
  save(team === "" ? `${id} taken off ${was ? tname(was) : "its team"}` : `${id} → ${tname(team)}`); paint();
}
function undo(){
  const h = state.history.pop(); if (!h) return;
  // a whole plan put in by the optimiser comes back out in one step
  if (h.bulk){ state.assign = h.bulk; state.teams.forEach(t => { state.assign[t.team] = (state.assign[t.team] || []).filter(i => F[i]); });
    state.cur = null; save("Undo: the optimised plan taken back out"); paint(); return; }
  for (const t in state.assign) state.assign[t] = state.assign[t].filter(i => i !== h.id);
  if (h.was) state.assign[h.was] = insertAt(state.assign[h.was] || [], h.id);
  state.cur = h.id; save(`Undo: ${h.id} back to ${h.was ? tname(h.was) : "no team"}`); paint();
}
function refreshOrders(then, summary){ buildF(); applyTimes(); state.cur = then || null; save(summary); paint(); }
function removeOrder(id){
  for (const t in state.assign) state.assign[t] = state.assign[t].filter(i => i !== id);
  state.history = state.history.filter(h => h.id !== id); delete state.times[id];
  if (state.extra[id]) delete state.extra[id];                       // a hand-made order is deleted outright
  else if (state.added.includes(id)) state.added = state.added.filter(i => i !== id);
  else state.removed.push(id);
  if (state.sheetGone && state.sheetGone[id]) delete state.sheetGone[id];
  const isrId = F[id] && F[id].isr_id;
  if (isrId) rpc("fn_isr_schedule", {p_id: isrId, p_day: null}).catch(() => {});
  refreshOrders(null, `Removed ${id} from the plan`);
}
function restoreOrder(id){ state.removed = state.removed.filter(i => i !== id); refreshOrders(id, `Restored ${id}`); }
function addHeld(id){ if (!state.added.includes(id)) state.added.push(id); refreshOrders(id, `Added ${id} from the held list (ISR / odd time)`); }
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
  if (!hasPin) state.extra[id].loc_confidence = "none";
  refreshOrders(id, `Added order ${id} by hand`); return "";
}
function addTeam(){
  const n = Math.max(0, ...state.teams.map(t => t.team)) + 1;
  // named after the first "Team K" no other team is called (crews keep their WhatsApp numbers in the name)
  let k = 1; while (state.teams.some(t => new RegExp("^team\\s*" + k + "(?!\\d)", "i").test(t.name))) k++;
  state.teams.push({team: n, name: "Team " + k, members: []}); state.assign[n] = []; save(`Added Team ${k}`); paint();
}
// its orders go back to "Not on a team"; the last team cannot go (Stage 1 needs one to suggest)
function deleteTeam(n){
  n = Number(n); if (state.teams.length <= 1) return;
  const gone = tname(n);
  state.teams = state.teams.filter(t => t.team !== n); delete state.assign[n];
  state.history.forEach(h => { if (Number(h.was) === n) h.was = null; });
  if (state.notes){ delete state.notes.team[n]; if (state.notes.scratch) delete state.notes.scratch[n]; }
  hiddenTeams.delete(n); delArmed = null; save(`Deleted ${gone}`); paint();
}
let delArmed = null, delTimer = null;            // same two-press confirm as Start again

/* ---------------- location: unknown / to confirm, and the pick-on-the-map button ---------------- */
function locHtml(id, short){
  const f = F[id]; if (!f) return "";
  const pick = `<button class="lnk pickpin" data-pickpin="${esc(id)}" draggable="false" title="Click, then click the map where the customer is">📍 ${f.loc_unknown || f.loc_doubt ? "pick on map" : short ? "" : "move pin"}</button>`;
  if (f.loc_unknown) return `<span class="chip bad locchip" title="${esc(f.loc_note || "")}">Unknown location</span>${pick}`;
  if (f.loc_doubt) return `<span class="chip warn locchip" title="${esc(f.loc_note || "")}">Location to confirm</span>${pick}`;
  return f.loc_confidence === "manual" ? `<span class="muted" style="font-size:11px" title="${esc(f.loc_note)}">📍 pinned by hand</span>${pick}` : pick;
}
let picking = null;
function startPick(id){
  picking = id; state.cur = state.stage === 1 ? id : state.cur;
  if (map){ map.getContainer().classList.add("picking"); if (ll(id)) map.panTo(ll(id), {animate: false}); }
  renderMapBar();
  toast(`Click the map where ${id} ${F[id] ? F[id].customer : ""} is`);
  const mw = $("mapwrap"); if (mw && mw.scrollIntoView) mw.scrollIntoView({block: "nearest"});
}
function endPick(){ picking = null; if (map) map.getContainer().classList.remove("picking"); renderMapBar(); }
async function setPin(id, lat, lng){
  if (!F[id]) { endPick(); return; }
  state.pins = state.pins || {};
  state.pins[id] = {lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, by: String(currentActor() || "").split("@")[0]};
  T = {}; KM = {};
  endPick(); buildF(); applyTimes(); save(`${id} pin set on the map`); paint();
  const f = F[id];
  if (f.address && !f.manual){
    try { await rpc("fn_stepper_set_pin", {p_address: f.address, p_city: f.city, p_lat: lat, p_lng: lng, p_order: String(id)});
          toast(`Pin saved for ${id} - remembered for this address from now on`); }
    catch (e) { toast((e && e.message) || "The pin is on this plan, but could not be remembered for the address", "bad"); }
  }
}

/* ---------------- render: stage 1 ---------------- */
let hot = null;                                   // team number under the mouse in the suggestion table
function chipsFor(f){
  const c = f.counts || {}, o = [];
  if (f.emaar) o.push(f.maybe ? `<span class="chip emaar maybe" title="The address might be Emaar">EMAAR?</span>` : `<span class="chip emaar">EMAAR</span>`);
  if (f.villa) o.push(`<span class="chip">villa · to ${esc(R.villa_work_end)}</span>`);
  o.push(`<span class="chip">${f.windows} win</span>`);
  if (c.blinds) o.push(`<span class="chip">${c.blinds} blind${c.blinds > 1 ? "s" : ""}</span>`);
  if (c.curt_1l) o.push(`<span class="chip">${c.curt_1l}× 1-layer</span>`);
  if (c.curt_2l) o.push(`<span class="chip">${c.curt_2l}× 2-layer</span>`);
  if (c.pelmet) o.push(`<span class="chip hot">${c.pelmet} pelmet</span>`);
  if (c.flex) o.push(`<span class="chip hot">${c.flex} flex track</span>`);
  if (f.scaffolding) o.push(`<span class="chip bad">scaffolding</span>`);
  if (c.h_over_tall) o.push(`<span class="chip ladder" title="${c.h_over_tall} window(s) taller than ${R.tall_flag_cm / 100} m, tallest ${Math.round(c.max_h)} cm">🪜 TALL LADDER ×${c.h_over_tall}</span>`);
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
  return `<div class="wins"><b class="nwin">${n}</b><span class="wgs">${g}${n > 12 ? "+" : ""}</span></div>
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
  if (id && !best) focus = `<div class="panel focus"><b>No team yet.</b> Press + Team, then place the orders.</div>`;
  else if (id){
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
      return `<tr class="orow ${f.emaar ? (f.maybe ? "emaar maybe" : "emaar") : ""} ${f.kind === "ISR" ? "isr" : ""} ${oid === id ? "focused" : ""}" data-focus="${oid}" style="${tn ? `border-left:6px solid ${teamColor(tn)}` : "border-left:6px solid transparent"}">
        <td><b>${esc(oid)}</b> <button class="lnk" data-remove="${oid}" title="Remove from this list" aria-label="Remove ${oid}">✕</button>${f.hold ? ' <span class="chip warn">ISR / odd time</span>' : f.manual ? ' <span class="chip">added</span>' : ""}<div class="muted" style="font-size:12px">${esc(f.city)} · <label class="etog ${f.emaar ? "on" : ""}" title="${f.maybe ? "The address MIGHT be Emaar: tick or untick to decide" : f.emaar_auto ? "The address looks like Emaar" : "The address does not look like Emaar"}${state.emaarSet && oid in state.emaarSet ? " - you changed it" : ""}"><input type="checkbox" data-emaar="${oid}" ${f.emaar ? "checked" : ""}>Emaar${state.emaarSet && oid in state.emaarSet ? "*" : ""}</label> · <label class="etog ${f.kind === "ISR" ? "on" : ""}" title="Tag this order as an ISR (issue resolution): flat ${R.isr_flat_min} min, dotted border"><input type="checkbox" data-isr="${oid}" ${f.kind === "ISR" ? "checked" : ""}>ISR</label>${f.scaffolding ? " · scaffolding" : ""}${f.motor ? " · motor" : ""}</div></td>
        <td>${esc(f.customer)}<div class="muted" style="font-size:12px">${esc(f.address)}</div><div>${locHtml(oid)}${f.gone3d ? ' <span class="chip bad" title="It was on the 3D sheet when it was planned">not on the 3D sheet now</span>' : ""}</div></td>
        <td><input type="time" step="300" value="${esc(f.slot)}" data-time="${oid}" aria-label="Start time of ${oid}">${st ? `<div class="muted" style="font-size:11px;white-space:nowrap">ETA <input type="time" step="300" class="tin" value="${hm(st.arrive)}" data-eta="${oid}" aria-label="ETA of ${oid}" title="Change when the team arrives and starts">${st.eta_set ? ` <button class="lnk" data-etareset="${oid}">reset</button>` : ""}</div>` : ""}${f.slot !== f.sheet_slot ? `<div class="muted" style="font-size:11.5px">sheet ${esc(f.sheet_slot)} <button class="lnk" data-treset="${oid}">reset</button></div>` : ""}</td>
        <td>${winViz(f)}</td>
        <td>${etaViz(oid, st, tn)}</td>
        <td><b>${endTxt}</b>${st ? "" : ' <span class="muted" style="font-size:11.5px">if on time</span>'}<div>${note}</div></td>
        <td><select data-team-for="${oid}" aria-label="Team for ${oid}">${optsFor(oid)}</select></td></tr>`; }).join("")}
    </tbody></table></div>`;
  const gone = state.removed.map(i => DAY.facts[i] || DAY.held[i]).filter(f => f && f.city === UI.city);
  $("s1").innerHTML = head + captionHtml() + `<div id="stp-optbox">${optHtml()}</div>` + focus + nextHtml() + `<div class="panel" style="padding:0;margin-top:8px">${table}</div>
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
  if (q.length) items.push(["bad", `${q.length} order${q.length > 1 ? "s are" : " is"} not on any team yet (see Not on a team).`]);
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
  $("tray").classList.toggle("waiting", q.length > 0);
  $("tray").innerHTML = `<div class="trh"><h2>Not on a team${q.length ? ` (${q.length})` : ""}</h2>
      <span class="trb"><button class="btn small" id="stp-b-addteam" title="A new, empty team on the end; drag orders onto it">+ Team</button><button class="btn small" id="stp-b-addorder" title="Add an ISR / odd-time order or a new one; it lands here, then drag it onto a team">+ Add order</button>${sortSel()}</span></div>
    ${gone2.length ? `<div class="muted" style="font-size:11.5px">Removed: ${gone2.map(f => `<span class="chip">${esc(f.order_id)} ${esc(f.customer)} <button class="lnk" data-restore="${esc(f.order_id)}">restore</button></span>`).join(" ")}</div>` : ""}
    <div class="trr">` + (q.length
    ? `<div class="tray">${q.map(i => `<span class="qcard ${F[i].emaar ? (F[i].maybe ? "emaar maybe" : "emaar") : ""} ${F[i].kind === "ISR" ? "isr" : ""}" draggable="true" data-id="${i}" title="Drag onto a team">${esc(F[i].slot)} · <b>${i}</b> ${esc(F[i].customer)} <span class="muted">· ${F[i].windows} win</span> <label class="etog ${F[i].emaar ? "on" : ""}" draggable="false"><input type="checkbox" data-emaar="${i}" draggable="false" ${F[i].emaar ? "checked" : ""}>E</label>${F[i].loc_unknown ? ` <button class="lnk pickpin" data-pickpin="${esc(i)}" draggable="false" title="Unknown location: pick it on the map">📍?</button>` : ""}</span>`).join("")}<span class="muted" style="font-size:11px">drag onto a team</span></div>`
    : `<span class="muted">✓ Every order is on a team.</span>`) +
    `<div class="legend"><span class="kit motor">motor</span><span class="kit pelmet">pelmet box</span><span class="kit bend">bend rail</span><span class="kit scaf">scaffolding (&gt;4 m)</span><span class="kit ladder">tall ladder (&gt;3.5 m)</span><span class="kit isrkey">ISR</span></div></div>`;

  $("crews").innerHTML = ROSTER.teams.filter(c => c.members.length).map(c => `<option value="${esc(crewLabel(c))}">`).join("") +
    people().map(p => `<option value="${esc(p.name)}">`).join("");

  const teamsHtml = sortedTeams(res).map(t => {
    const r = res[t.team], seq = state.assign[t.team] || [], tc = teamColor(t.team);
    const rules = crewRules(t, seq);
    let body = seq.length ? "" : `<div class="empty">No orders. Drag one here.</div>`;
    r.stops.forEach((s, i) => {
      const f = F[s.id];
      body += `<p class="drv">${i === 0 ? `leave ${hm(r.depart)} · ` : ""}🚐 ${s.travel} min · ${s.km} km${legNote(s)}</p>
      <div class="stop ${f.emaar ? (f.maybe ? "emaar maybe" : "emaar") : ""} ${f.kind === "ISR" ? "isr" : ""}" draggable="true" data-id="${s.id}" data-team="${t.team}" style="--tc:${tc}">
        <div class="l1"><span class="sheett" title="Time on the 3D sheet"><span>3D</span><b>${esc(f.sheet_slot)}</b></span>${f.slot !== f.sheet_slot ? `<em class="youset" title="You changed the time">→ ${esc(f.slot)}</em>` : ""}<span class="who" title="${esc(s.id + " " + f.customer)}"><span class="oid">${s.id}</span> ${esc(f.customer)}</span><button class="lnk rmx" data-remove="${s.id}" title="Remove from this day's plan (you can restore it above)" aria-label="Remove ${s.id}">✕</button></div>
        <div class="pt">Appt <input type="time" step="300" class="tin" value="${esc(f.slot)}" data-time="${s.id}" draggable="false" title="Change the appointment time" aria-label="Start time of ${s.id}"> · Planned <b>${hm(s.start)}–${hm(s.end)}</b> · ETA <input type="time" step="300" class="tin" value="${hm(s.arrive)}" data-eta="${s.id}" draggable="false" title="Change when the team arrives and starts" aria-label="ETA of ${s.id}">${s.eta_set ? ` <button class="lnk" data-etareset="${s.id}" draggable="false">reset</button>` : ""} <label class="isrtog"><input type="checkbox" data-isr="${s.id}" draggable="false" ${f.kind === "ISR" ? "checked" : ""}>ISR</label>${s.delay > 0 ? ` <span class="chip ${s.late ? "bad" : "warn"}">+${s.delay}</span>` : ""}${s.over ? ` <span class="chip bad">after limit</span>` : ""}</div>
        <div class="ad" title="${esc(f.address)}">${esc(f.address)}</div>
        <div class="locl">${locHtml(s.id, true)}${f.gone3d ? ' <span class="chip bad">not on the 3D sheet now</span>' : ""}${f.isr_id ? ` ${isrChip(f.isr_id)}` : ""}</div>
        <div class="jw2"><label class="etog ${f.emaar ? "on" : ""}" draggable="false" title="${f.maybe ? "The address MIGHT be Emaar: tick or untick to decide" : "Tick if this is an Emaar property (the card turns yellow; remembered for the address)"}"><input type="checkbox" data-emaar="${s.id}" draggable="false" ${f.emaar ? "checked" : ""}>${f.maybe ? "Emaar?" : "Emaar"}</label> · ${workLineHtml(s.id)}</div>
        ${specialsHtml(s.id)}
        <input class="onote2" data-onote="${s.id}" data-team="${t.team}" draggable="false" value="${esc(notes().order[s.id] || "")}" placeholder="Note (goes on WhatsApp)" aria-label="Note for ${s.id}"></div>`;
    });
    const armed = delArmed === t.team;
    return `<article class="team" data-team="${t.team}" style="--tc:${tc}">
      <div class="th"><input class="nm" list="stp-crews" value="${esc(t.name)}" data-tname="${t.team}" aria-label="Name of team ${t.team}" placeholder="Type a name, or pick a crew">${state.teams.length > 1 ? `<button class="lnk tdel ${armed ? "armed" : ""}" data-delteam="${t.team}" title="Delete this team${seq.length ? "; its orders go back to Not on a team" : ""}" aria-label="Delete ${esc(t.name)}">${armed ? `Delete? ${seq.length} order${seq.length > 1 ? "s" : ""} go back` : "✕"}</button>` : ""}</div>
      <input class="mem" list="stp-crews" value="${esc((t.members || []).join(" & "))}" data-tmem="${t.team}" aria-label="Members of team ${t.team}" placeholder="Members, e.g. Ikbal & Kaleem">
      <textarea class="scratch" data-tscratch="${t.team}" rows="2" draggable="false" placeholder="Internal scratch notes (only here - never sent to the team)" aria-label="Internal scratch notes for team ${t.team}">${esc((notes().scratch || {})[t.team] || "")}</textarea>
      <div class="metrics"><span><b>${r.orders}</b> jobs</span><span><b class="nwin">${r.windows}</b> win</span><span><b>${(r.work / 60).toFixed(1)}</b> h</span>${r.orders ? `<span><b>${hm(r.depart)}</b>–<b>${hm(r.home)}</b></span>` : ""}</div>
      ${rules.map(([lv, tx]) => `<div><span class="chip ${lv === "bad" ? "bad" : "warn"}">${esc(tx)}</span></div>`).join("")}
      ${body}</article>`;
  }).join("");
  $("teams").innerHTML = teamsHtml;
  renderIsrTray();
  // the team cards' "ISR #n · ready" chips need the rows too: redraw once they land, unless somebody is typing there
  if (!ISRC.rows || Date.now() - ISRC.at > 60000) loadIsr().then(() => {
    if (state.stage !== 2) return;
    const tm = $("teams");
    if (tm && !tm.contains(document.activeElement) && Object.values(F).some(f => f.isr_id)) renderStage2(); else renderIsrTray();
  });
}

/* ---------------- ISR cards (Production > ISR), in Stage 2 (user, 10 Nov 2026) ----------------
 * Every open ISR of this city, filtered by how ready it is, with what the 3D sheet says about the order on
 * this day. Drag a card onto a team: it joins the plan (the 3D sheet's own ISR row when there is one, else
 * a new ISR job) and the case is marked scheduled for this day. */
const ISRC = {rows: null, at: 0, err: "", filter: "all"};
const ISR_TYPE = {on_the_spot: "On the spot", new_fabric: "New fabric", planned_alteration: "Planned alteration", unplanned_alteration: "Unplanned alteration", others: "Others"};
const ISR_SRC = {production: "Production issue", installation: "Installation issue", consultation: "Consultation issue", client_change_of_mind: "Client change of mind", fabric: "Fabric issue", others_kurtains: "Others - Kurtains"};
async function loadIsr(){
  try {
    ISRC.rows = await api(`/rest/v1/v_isr_cases?select=id,order_id,customer_any,city_any,address,isr_type,source,issue,expected_back,expected_new,readiness,return_supplier,status,sched_day,sched_city,sched_team,ready,ready_by,ready_at,fabric_received,fabric_name,fabric_by,fabric_at,photo_count&status=in.(open,scheduled)&order=id.desc`) || [];
    ISRC.at = Date.now(); ISRC.err = "";
  } catch (e) { ISRC.err = (e && e.message) || "Could not load the ISR cards"; ISRC.rows = ISRC.rows || []; }
}
/* Production's answer (Production > ISR · fabric & ready): fabric yes / no, which fabric, pictures, ready */
const who1 = e => String(e || "").split("@")[0];
function isrProdHtml(r){
  const f = fabricState(r), tone = {ok: "good", bad: "bad", mute: "", info: "", warn: "warn"};
  return `<div class="isrprod"><span class="chip ${tone[f.tone]}" title="${esc(r.fabric_by ? who1(r.fabric_by) + " " + String(r.fabric_at || "").slice(0, 16).replace("T", " ") : "Production has not answered yet")}">${esc(f.text)}</span>${r.fabric_name ? ` <b>${esc(r.fabric_name)}</b>` : ""}${Number(r.photo_count) ? ` <span class="chip" title="Pictures from Production - open the ISR list to see them">📷 ${r.photo_count}</span>` : ""} ${r.ready ? `<span class="chip good" title="${esc(String(r.ready_at || "").slice(0, 16).replace("T", " "))}">✓ ready · ${esc(who1(r.ready_by))}</span>` : `<span class="chip warn">not reported ready</span>`}</div>`;
}
function isrChip(id){
  const r = (ISRC.rows || []).find(x => x.id === id);
  if (!r) return `<span class="chip">ISR #${id}</span>`;
  const f = fabricState(r);
  return `<span class="chip ${r.ready ? "good" : f.tone === "bad" ? "bad" : "warn"}" title="${esc(f.text + (r.fabric_name ? ": " + r.fabric_name : "") + (r.ready ? " · reported ready" : " · not reported ready"))}">ISR #${id} · ${r.ready ? "ready" : f.tone === "ok" ? "fabric in" : f.tone === "bad" ? "no fabric" : "waiting"}</span>`;
}
function isrOnPlan(id){ return Object.keys(F).find(i => F[i].isr_id === id) || null; }
function renderIsrTray(){
  const box = $("isrtray"); if (!box) return;
  if (!ISRC.rows){ box.innerHTML = `<div class="trh"><h2>ISR cards</h2><span class="muted">loading…</span></div>`; return; }
  const mine = ISRC.rows.filter(r => !r.city_any || r.city_any === UI.city);
  const f = ISRC.filter, show = mine.filter(r => f === "all" || (f === "return" ? r.return_supplier : r.readiness === f));
  const cnt = k => mine.filter(r => k === "return" ? r.return_supplier : r.readiness === k).length;
  const on3d = r => {
    const h = Object.values(DAY.held).find(x => x.order_id === r.order_id && x.city === UI.city);
    if (h) return `<span class="chip good" title="${esc(h.note || "")}">on the 3D sheet ${esc(h.slot || "")} (${esc(h.kind || "held")})</span>`;
    if (DAY.facts[r.order_id]) return `<span class="chip good">installation on the 3D sheet ${esc(DAY.facts[r.order_id].slot || "")}</span>`;
    return `<span class="chip warn">not on the 3D sheet for this day</span>`;
  };
  const RD = {waiting: ["waiting", "warn"], received: ["received back", ""], ready: ["ready", "good"]};
  box.innerHTML = `<div class="trh"><h2>ISR cards (${show.length}${show.length !== mine.length ? " of " + mine.length : ""})</h2>
      <span class="trb"><label class="muted">Readiness <select id="stp-isrfilter">
        ${[["all", "All"], ["waiting", "Waiting"], ["received", "Received back"], ["ready", "Ready"], ["return", "To return to supplier"]].map(([v, l]) => `<option value="${v}" ${f === v ? "selected" : ""}>${l}${v === "all" ? "" : " (" + cnt(v) + ")"}</option>`).join("")}</select></label>
      <button class="btn small" data-isrreload="1">↻</button> <a class="btn small" href="#/status?view=isr" target="_blank" rel="noopener">Open ISR list ↗</a></span></div>
    ${ISRC.err ? `<div class="chip bad">${esc(ISRC.err)}</div>` : ""}
    <div class="isrcards">${show.length ? show.map(r => { const on = isrOnPlan(r.id), rd = RD[r.readiness] || RD.waiting;
      return `<div class="isrcard ${on ? "onplan" : ""}" draggable="${on ? "false" : "true"}" data-id="isr:${r.id}" title="${on ? "Already on the plan" : "Drag onto a team"}">
        <div><b>ISR #${r.id} · ${esc(r.order_id)}</b> ${esc(r.customer_any || "")} <span class="chip ${rd[1]}">${rd[0]}</span>${r.return_supplier ? ' <span class="chip bad">return to supplier</span>' : ""}</div>
        <div class="muted" style="font-size:11.5px">${esc(ISR_TYPE[r.isr_type] || r.isr_type)} · ${esc(ISR_SRC[r.source] || r.source)}${r.sched_day ? ` · scheduled ${esc(r.sched_day)}${r.sched_city ? " " + esc(r.sched_city) : ""}` : ""}</div>
        <div class="isrissue">${esc(r.issue)}</div>
        ${r.expected_back || r.expected_new ? `<div class="muted" style="font-size:11.5px">${r.expected_back ? "Back from site: " + esc(r.expected_back) : ""}${r.expected_back && r.expected_new ? " · " : ""}${r.expected_new ? "New: " + esc(r.expected_new) : ""}</div>` : ""}
        ${isrProdHtml(r)}
        <div>${on3d(r)}${on ? ` <span class="chip good">on the plan (${esc(on)})</span>` : ""}</div></div>`; }).join("")
      : `<span class="muted">No ${f === "all" ? "" : "such "}open ISR for ${esc(UI.city)}.</span>`}</div>`;
}
async function addIsrToTeam(isrId, team){
  const r = (ISRC.rows || []).find(x => x.id === isrId); if (!r) return;
  if (isrOnPlan(isrId)){ toast(`ISR #${isrId} is already on the plan`); return; }
  const h = Object.values(DAY.held).find(x => x.order_id === r.order_id && x.city === UI.city);
  let id;
  if (h && !Object.values(state.isrMap || {}).includes(isrId) && !Object.keys(state.isrMap || {}).includes(h.key)){
    id = h.key; if (!state.added.includes(id)) state.added.push(id);
  } else {
    id = F[r.order_id] ? `${r.order_id}-ISR${r.id}` : r.order_id;
    let lat = null, lng = null, conf = "none", note = "ISR card - location not known yet";
    if (r.address){ try { const g = await rpc("fn_sched_resolve_location", {p_address: r.address, p_city: UI.city}); const x0 = Array.isArray(g) ? g[0] : g;
      if (x0 && x0.confidence && x0.confidence !== "none"){ lat = Number(x0.lat); lng = Number(x0.lng); conf = x0.confidence; note = x0.community || x0.anomaly_reason || ""; } } catch (e) {} }
    state.extra[id] = {order_id: r.order_id, city: UI.city, slot: "10:00", customer: r.customer_any || "ISR", phone: "", address: r.address || "",
      lat, lng, loc_note: note, loc_confidence: conf, emaar: false, villa: false, entry_type: "issue_resolution", status: "ISR", kind: "ISR",
      minutes: R.isr_flat_min, windows: 0, counts: {}, scaffolding: false, motor: false, comments: [r.issue]};
  }
  state.isrMap = state.isrMap || {}; state.isrMap[id] = isrId;
  buildF(); applyTimes();
  for (const t in state.assign) state.assign[t] = state.assign[t].filter(i => i !== id);
  state.assign[team] = bestInsert(state.assign[team] || [], id);
  save(`ISR #${isrId} (${r.order_id}) → ${tname(team)}`); paint();
  try { await rpc("fn_isr_schedule", {p_id: isrId, p_day: UI.date, p_city: UI.city, p_team: team}); await loadIsr(); if (state.stage === 2) renderIsrTray(); }
  catch (e) { toast((e && e.message) || "On the plan, but the ISR case could not be marked scheduled", "bad"); }
}

/* actions on the schedule (stage 2) */
function removeAll(id){ for (const t in state.assign) state.assign[t] = state.assign[t].filter(i => i !== id); }
function moveOrder(id, team){
  removeAll(id);
  if (team !== "un") state.assign[team] = bestInsert(state.assign[team] || [], id);
  state.history = state.history.filter(h => h.id !== id); save(team === "un" ? `${id} taken off the schedule` : `${id} → ${tname(team)}`); paint();
}
function shift(team, idx, d){
  const s = state.assign[team], j = idx + d; if (j < 0 || j >= s.length) return;
  [s[idx], s[j]] = [s[j], s[idx]]; save(`Changed the order of ${tname(team)}'s jobs`); paint();
}
function setName(team, v){
  const t = teamOf(team), crew = ROSTER.teams.find(c => c.members.length && crewLabel(c) === v);
  t.name = v.trim() || ("Team " + team);
  if (crew) t.members = crew.members.slice();
  save(`Team ${team} named "${t.name}"`); paint();
}
function setMembers(team, v){
  const crew = ROSTER.teams.find(c => c.members.length && crewLabel(c) === v);
  const t = teamOf(team);
  if (crew){ t.members = crew.members.slice(); t.name = crewLabel(crew); }
  else t.members = v.split(/&|,/).map(x => x.trim()).filter(Boolean);
  save(`${t.name} crew: ${t.members.join(" & ") || "none"}`); paint();
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
// The column order is worked out when Stage 2 opens or the Sort box changes, then kept: naming a team or
// moving an order must not make the columns jump (user, 25 Oct 2026). New teams go on the end.
function sortedTeams(res){
  const sort = UI.sort || "time", nums = state.teams.map(t => t.team);
  if (!state.colOrder || state.colSort !== sort){
    const t = state.teams.slice(), first = x => res[x.team].stops.length ? res[x.team].stops[0].start : 1e9;
    if (sort === "team") t.sort((a, b) => natural(a.name, b.name));
    else t.sort((a, b) => first(a) - first(b) || natural(a.name, b.name));
    state.colOrder = t.map(x => x.team); state.colSort = sort; save();
  }
  return state.colOrder.filter(n => nums.includes(n)).concat(nums.filter(n => !state.colOrder.includes(n))).map(teamOf);
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
  if (f.scaffold_missing) add("bad", "Scaffolding not in PO", "tagged Follow up accounts: Scaffolding suggested");
  if (c.h_over_tall) add("hot", `Tall ladder ×${c.h_over_tall}`, `windows over ${R.tall_flag_cm / 100} m, tallest ${Math.round(c.max_h)} cm`);
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
/* ---------------- next order for each team (user, 13 Nov 2026) ----------------
 * "Look at the end time of the previous order, calculate the travel time, and match the closest order."
 * For every team: where its last job ends and when, the drive from there (rush hour included) to each order
 * still on no team, and the nearest one it can reach in time - no time change, inside the working day.
 * Teams are served in the order they come free, so two teams never get the same order. An order nobody can
 * reach in time is offered only when nothing else fits, and is marked. */
function nextForTeams(){
  const left = new Set(queue()), out = [];
  const teams = state.teams.map(t => { const seq = state.assign[t.team] || [], r = simulate(seq);
    return {t, seq, free: seq.length ? r.free : null, last: seq.length ? seq[seq.length - 1] : null}; })
    .sort((a, b) => (a.free ?? -1) - (b.free ?? -1) || a.t.team - b.t.team);
  for (const x of teams){
    let best = null;
    for (const id of left){
      const r = simulate(x.seq.concat([id])), st = r.stops[r.stops.length - 1];
      const ok = !st.late && !st.over;
      // nearest first; idle time at the door counts a quarter, so a close order four hours away does not win
      const cost = st.travel + 0.25 * Math.max(0, st.wait) + (ok ? 0 : 1000 + st.late * 20 + st.over * 50);
      if (!best || cost < best.cost) best = {id, st, ok, cost};
    }
    if (!best) break;
    left.delete(best.id);
    out.push({team: x.t.team, from: x.last, free: x.free, ...best});
  }
  return out.sort((a, b) => a.team - b.team);
}
function nextHtml(){
  if (!queue().length || !state.teams.length) return "";
  const nx = nextForTeams();
  if (!nx.length) return "";
  return `<div class="panel nextpanel"><div class="nph"><b>Next order for each team</b> <span class="muted">where its last job ends → drive → the nearest order it can reach in time</span>
      <button class="btn small" id="stp-b-nextall" title="Give every team its next order below, in one go">Assign all ${nx.length}</button></div>
    <div class="nprows">${nx.map(n => { const f = F[n.id], st = n.st;
      return `<div class="nprow" data-hot="${n.team}"><span class="sw" style="background:${teamColor(n.team)}"></span><b>${esc(tname(n.team))}</b>
        <span class="muted">${n.from ? `free ${hm(n.free)} at ${esc(n.from)}` : `no job yet, leaves ${hm(st.arrive - st.travel)}`}</span> →
        <b>${esc(n.id)}</b> ${esc(f.customer)} <span class="muted">appt ${esc(f.slot)}</span>
        · 🚐 ${st.travel} min${st.tnote ? ` <span class="muted">(${esc(st.tnote)})</span>` : ""} · arrives ${hm(st.arrive)}${st.wait > 15 ? `, waits ${Math.round(st.wait)} min` : ""}
        ${n.ok ? (st.minor ? `<span class="chip warn">+${st.minor} min</span>` : `<span class="chip good">on time</span>`) : `<span class="chip bad">${st.late ? "TIME CHANGE +" + st.late : "after the day limit"}</span>`}
        <button class="btn small" data-assignnext="${esc(n.id)}" data-team="${n.team}">Assign</button></div>`; }).join("")}</div></div>`;
}
function assignNextAll(){
  const nx = nextForTeams(); if (!nx.length) return;
  nx.forEach(n => { state.assign[n.team] = (state.assign[n.team] || []).concat([n.id]); state.history.push({id: n.id, team: n.team, was: null}); });
  state.cur = null; save(`Gave ${nx.length} team${nx.length > 1 ? "s" : ""} their next order`); paint();
}

/* ---------------- optimiser: many plans, the best one recommended (user, 13 Nov 2026) ----------------
 * "Make multiple permutations and iterations, and then recommend an optimum plan."
 * Several hundred starting plans are built - the plan on screen, appointment-order greedy, nearest-next per
 * team (the rule above), shuffled orders with random tie-breaks - and each is improved by local search: move
 * one order to its best place on any team, swap two orders between teams, until nothing improves. Then the
 * best few are shaken (a few random moves) and improved again. It runs for about 4 seconds, seeded by
 * date + city so the same day gives the same answer. Same number of teams as the plan on screen; a team
 * can end up empty.
 *
 * Cost of a plan, in minutes (lower is better), summed per team so a move only re-costs two teams:
 *   time change (start > 1 h after the appointment) x20 per minute, a start inside the free hour x2,
 *   past the end of the working day x50, driving x1 (the drive home x0.5), waiting at a door x0.3,
 *   each crew carrying an Emaar job 25, scaffolding 10, a named crew's people rule broken 200. */
const OPT = {busy: false, res: null, progress: "", show: null};
function rng(seed){ let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hashStr(s){ let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
async function optimise(budgetMs = 4000){
  if (OPT.busy) return; OPT.busy = true; OPT.res = null; OPT.show = null; paintOpt();
  const ids = IDS.slice(), teams = state.teams.map(t => t.team), rand = rng(hashStr(UI.date + UI.city));
  const SIM = new Map(), TC = new Map();
  const sim = seq => { const k = seq.join(","); let r = SIM.get(k); if (!r){ r = simulate(seq); SIM.set(k, r); } return r; };
  const teamCost = (tn, seq) => {
    if (!seq.length) return 0;
    const k = tn + "|" + seq.join(","); let c = TC.get(k); if (c != null) return c;
    const r = sim(seq);
    c = r.stops.reduce((a, x) => a + x.late * 20 + x.minor * 2 + x.over * 50 + x.travel + 0.3 * Math.max(0, x.wait), 0) + 0.5 * r.back;
    if (seq.some(i => F[i].emaar)) c += 25;
    if (seq.some(i => F[i].scaffolding)) c += 10;
    c += crewRules(teamOf(tn), seq).filter(x => x[0] === "bad").length * 200;
    TC.set(k, c); return c;
  };
  const total = P => teams.reduce((a, t) => a + teamCost(t, P[t]), 0);
  const bestPos = (tn, seq, id) => { let bp = null, bc = Infinity;
    for (let i = 0; i <= seq.length; i++){ const s2 = seq.slice(0, i).concat([id], seq.slice(i)), c = teamCost(tn, s2); if (c < bc){ bc = c; bp = s2; } }
    return [bp, bc]; };
  const insertAll = (P, order, noise) => { for (const id of order){ let bt = null, bs = null, bd = Infinity;
      for (const t of teams){ const [s2, c] = bestPos(t, P[t], id), d = c - teamCost(t, P[t]) + (noise ? noise * rand() * 30 : 0); if (d < bd){ bd = d; bt = t; bs = s2; } }
      P[bt] = bs; } return P; };
  const empty = () => Object.fromEntries(teams.map(t => [t, []]));
  const bySlot = () => ids.slice().sort((a, b) => F[a].slot.localeCompare(F[b].slot) || rand() - 0.5);
  const nearestNext = noise => {                 // the "next order for each team" rule, run to the end
    const P = empty(), left = new Set(ids);
    while (left.size){
      const tf = teams.map(t => [t, P[t].length ? sim(P[t]).free : -1]).sort((a, b) => a[1] - b[1]);
      let placed = false;
      for (const [t] of tf){ let best = null, bc = Infinity;
        for (const id of left){ const r = sim(P[t].concat([id])), st = r.stops[r.stops.length - 1];
          const c = st.travel + 0.25 * Math.max(0, st.wait) + (st.late || st.over ? 1000 + st.late * 20 + st.over * 50 : 0) + noise * rand() * 20;
          if (c < bc){ bc = c; best = id; } }
        if (best && bc < 1000){ P[t] = P[t].concat([best]); left.delete(best); placed = true; break; }
      }
      if (!placed){ insertAll(P, [...left], 0); break; }   // nobody reaches the rest in time: cheapest insertion
    }
    return P;
  };
  const improve = P => {                          // relocate + swap until no move helps
    let better = true, guard = 0;
    while (better && guard++ < 60){
      better = false;
      for (const id of ids.slice().sort(() => rand() - 0.5)){
        const from = teams.find(t => P[t].includes(id)); if (from == null) continue;
        const rest = P[from].filter(i => i !== id), saved = teamCost(from, P[from]) - teamCost(from, rest);
        let bt = null, bs = null, gain = 0.01;
        for (const t of teams){ const cur = t === from ? rest : P[t], [s2, c] = bestPos(t, cur, id), add = c - teamCost(t, cur);
          if (saved - add > gain){ gain = saved - add; bt = t; bs = s2; } }
        if (bt != null){ P[from] = rest; P[bt] = bs; better = true; }
      }
      for (let a = 0; a < teams.length; a++) for (let b = a + 1; b < teams.length; b++){
        const ta = teams[a], tb = teams[b];
        for (const x of P[ta].slice()) for (const y of P[tb].slice()){
          if (!P[ta].includes(x) || !P[tb].includes(y)) continue;
          const ra = P[ta].filter(i => i !== x), rb = P[tb].filter(i => i !== y);
          const [na, ca] = bestPos(ta, ra, y), [nb, cb] = bestPos(tb, rb, x);
          if (ca + cb < teamCost(ta, P[ta]) + teamCost(tb, P[tb]) - 0.01){ P[ta] = na; P[tb] = nb; better = true; }
        }
      }
    }
    return P;
  };
  const shake = (P, k) => { const Q = Object.fromEntries(teams.map(t => [t, P[t].slice()]));
    for (let i = 0; i < k; i++){ const id = ids[Math.floor(rand() * ids.length)], from = teams.find(t => Q[t].includes(id)), to = teams[Math.floor(rand() * teams.length)];
      if (from == null || to === from) continue; Q[from] = Q[from].filter(x => x !== id); Q[to] = bestPos(to, Q[to], id)[0]; }
    return Q; };
  const sig = P => teams.map(t => P[t].slice().sort().join(",")).filter(Boolean).sort().join(" | ");
  const pool = new Map();                         // signature (who is with whom) -> best version of that plan
  const keep = P => { const c = total(P), s = sig(P), o = pool.get(s); if (!o || c < o.cost) pool.set(s, {P: Object.fromEntries(teams.map(t => [t, P[t].slice()])), cost: c}); };

  const t0 = performance.now(); let tries = 0;
  const current = Object.fromEntries(teams.map(t => [t, (state.assign[t] || []).filter(i => ids.includes(i))]));
  const placedNow = new Set(Object.values(current).flat());
  // the plan on screen is compared even when some orders are not on a team yet (it then looks cheaper than it is)
  const unplaced = ids.filter(i => !placedNow.has(i)).length, curCost = placedNow.size ? total(current) : null;
  const starts = [
    () => insertAll(Object.fromEntries(teams.map(t => [t, current[t].slice()])), ids.filter(i => !placedNow.has(i)), 0),
    () => insertAll(empty(), bySlot(), 0),
    () => nearestNext(0),
  ];
  try {
    while (ids.length && performance.now() - t0 < budgetMs * 0.7 && tries < 600){
      const k = tries++;
      const P = k < starts.length ? starts[k]()
        : k % 3 === 0 ? nearestNext(1) : k % 3 === 1 ? insertAll(empty(), bySlot(), 1) : insertAll(empty(), ids.slice().sort(() => rand() - 0.5), 0.5);
      keep(improve(P));
      if (k % 4 === 3){ OPT.progress = `Tried ${tries} plans…`; paintOpt(); await new Promise(r => setTimeout(r, 0)); }
    }
    let elite = [...pool.values()].sort((a, b) => a.cost - b.cost).slice(0, 5);
    while (performance.now() - t0 < budgetMs && elite.length){        // shake the best ones and improve again
      const e = elite[Math.floor(rand() * elite.length)];
      keep(improve(shake(e.P, 2 + Math.floor(rand() * 3)))); tries++;
      if (tries % 4 === 0){ elite = [...pool.values()].sort((a, b) => a.cost - b.cost).slice(0, 5); OPT.progress = `Tried ${tries} plans…`; paintOpt(); await new Promise(r => setTimeout(r, 0)); }
    }
    const top = [...pool.values()].sort((a, b) => a.cost - b.cost).slice(0, 3);
    OPT.res = {tries, ms: Math.round(performance.now() - t0), top: top.map(x => ({...x, m: planMetrics(x.P)})),
      cur: curCost != null ? {cost: curCost, m: planMetrics(current), unplaced} : null, unknown: ids.filter(i => F[i].loc_unknown), key: scopeKey()};
  } catch (e) { OPT.res = {err: (e && e.message) || String(e), key: scopeKey()}; }
  OPT.busy = false; OPT.progress = ""; paint();
}
function planMetrics(P){
  const m = {teams: 0, late: 0, lateMin: 0, minor: 0, over: 0, drive: 0, km: 0, wait: 0, emaar: 0, home: 0};
  for (const t of state.teams){ const seq = P[t.team] || []; if (!seq.length) continue;
    const r = simulate(seq); m.teams++;
    r.stops.forEach(x => { if (x.late){ m.late++; m.lateMin += x.late; } if (x.minor) m.minor++; m.over += x.over; m.wait += Math.max(0, x.wait); });
    m.drive += r.travel; m.km += r.km; m.home = Math.max(m.home, r.home || 0);
    if (seq.some(i => F[i].emaar)) m.emaar++;
  }
  m.km = Math.round(m.km); m.wait = Math.round(m.wait); m.over = Math.round(m.over);
  return m;
}
function useOptPlan(n){
  const o = OPT.res && OPT.res.top[n]; if (!o) return;
  state.history.push({bulk: clone(state.assign)});
  state.teams.forEach(t => { state.assign[t.team] = (o.P[t.team] || []).slice(); });
  state.cur = null; hot = null; OPT.res = null;
  save(`Used optimised plan ${n + 1} (${o.m.teams} teams, ${o.m.late} time change${o.m.late === 1 ? "" : "s"}, ${o.m.drive} min driving)`);
  go(2);
}
function optHtml(){
  if (OPT.busy) return `<div class="panel optpanel"><b>🧠 Finding the best plan…</b> <span class="muted">${esc(OPT.progress)}</span></div>`;
  const r = OPT.res; if (!r || r.key !== scopeKey()) return "";
  if (r.err) return `<div class="panel optpanel"><b>The optimiser stopped:</b> ${esc(r.err)} <button class="lnk" data-optclose="1">close</button></div>`;
  if (!r.top.length) return `<div class="panel optpanel">No ${esc(UI.city)} orders to plan. <button class="lnk" data-optclose="1">close</button></div>`;
  const cols = [...(r.cur ? [{label: r.cur.unplaced ? `Plan on screen (${r.cur.unplaced} not on a team)` : "Plan on screen", m: r.cur.m, cost: r.cur.cost}] : []),
    ...r.top.map((x, i) => ({label: i ? `Option ${i + 1}` : "★ Recommended", m: x.m, cost: x.cost, n: i}))];
  const row = (lbl, f, good) => `<tr><th>${lbl}</th>${cols.map(c => `<td class="${good && good(c.m) ? "good" : ""}">${f(c.m)}</td>`).join("")}</tr>`;
  const sh = OPT.show, U = r.unknown;
  return `<div class="panel optpanel"><div class="nph"><b>🧠 Best plan from ${r.tries} plans tried</b> <span class="muted">${(r.ms / 1000).toFixed(1)} s · each plan improved by moving and swapping orders between teams</span>
      <button class="lnk" data-optclose="1" style="margin-left:auto">close</button></div>
    ${U.length ? `<div class="optwarn">⚠ ${U.length} order${U.length > 1 ? "s have" : " has"} no known location (${U.map(esc).join(", ")}): every drive to or from ${U.length > 1 ? "them" : "it"} is assumed ${R.travel.unknown_min ?? 35} min. Pick ${U.length > 1 ? "them" : "it"} on the map (📍) and run again for a better plan.</div>` : ""}
    <div class="optscroll"><table class="opttab"><thead><tr><th></th>${cols.map(c => `<th>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>
      ${row("Teams used", m => m.teams)}
      ${row("Time changes (more than 1 h late)", m => m.late ? `${m.late} (${m.lateMin} min)` : "0", m => !m.late)}
      ${row("Starts inside the free hour", m => m.minor)}
      ${row("Past the end of the day", m => m.over ? m.over + " min" : "0", m => !m.over)}
      ${row("Driving", m => `${m.drive} min · ${m.km} km`)}
      ${row("Waiting at doors", m => m.wait + " min")}
      ${row("Emaar crews", m => m.emaar)}
      ${row("Last team home", m => m.home ? hm(m.home) : "—")}
    </tbody></table></div>
    <div class="optacts">${r.top.map((x, i) => `<span><b>${i ? "Option " + (i + 1) : "★ Recommended"}</b> score ${Math.round(x.cost)}${r.cur && !r.cur.unplaced ? ` (plan on screen ${Math.round(r.cur.cost)})` : ""}
      <button class="btn small ${i === 0 ? "primary" : ""}" data-optuse="${i}">Use this plan</button> <button class="lnk" data-optshow="${i}">${sh === i ? "hide" : "see"} teams</button></span>`).join("")}</div>
    ${sh != null && r.top[sh] ? `<div class="optteams">${state.teams.filter(t => (r.top[sh].P[t.team] || []).length).map(t => { const seq = r.top[sh].P[t.team], s = simulate(seq);
      return `<div><span class="sw" style="background:${teamColor(t.team)}"></span><b>${esc(t.name)}</b> <span class="muted">leave ${hm(s.depart)}, home ${hm(s.home)}</span> ${s.stops.map(x => `<span class="chip ${x.late ? "bad" : x.minor ? "warn" : ""}" title="${esc(F[x.id].customer + " · " + F[x.id].address)}">${esc(F[x.id].slot)} ${esc(x.id)} · 🚐${x.travel}${x.tnote === "location unknown" ? "?" : ""}</span>`).join(" → ")}</div>`; }).join("")}</div>` : ""}
    <div class="muted" style="font-size:11.5px;margin-top:4px">"Use this plan" replaces this day's team assignments and opens Stage 2; Undo puts the old plan back. Crew names stay on their team numbers.</div></div>`;
}
function paintOpt(){ const x = $("optbox"); if (x) x.innerHTML = optHtml(); }

const playCtl = () => `<span class="playctl">
    ${playing ? `<button class="btn small primary" id="stp-b-pause">⏸ Pause</button>` : `<button class="btn small primary" id="stp-b-play" ${queue().length ? "" : "disabled"}>▶ Play</button>`}
    <button class="btn small" id="stp-b-step" ${playing || !queue().length ? "disabled" : ""} title="Place just the next order, with the explanation">⏭ Step</button>
    <button class="btn small" id="stp-b-allgo" ${!queue().length ? "disabled" : ""} title="Put every remaining order on its suggested team, without the narration, and open Stage 2">⏩ Assign all suggested → Stage 2</button>
    <button class="btn small primary" id="stp-b-opt" ${OPT.busy || !IDS.length ? "disabled" : ""} title="Try hundreds of plans (moving and swapping orders between the teams) and recommend the best one">🧠 Best plan</button>
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
  {id: "pdf",      title: "Generate the one-page schedule PDF", about: "A single A4 landscape page with every team's jobs, times, addresses and scope; ISR jobs have a dotted border. Runs last."},
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
      eta: hm(s.arrive), planned_start: hm(s.start), planned_end: hm(s.end), late_min: s.delay > 0 ? s.delay : 0, emaar: !!f.emaar,
      installation_alert: instAlerts(s.id), note: notes().order[s.id] || "", lat: f.lat, lng: f.lng, est_min: Math.round(f.minutes || 0), scope: workLine(s.id)}; })};
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
    lines.push("", `*${o.time}*  ${o.order_id}  ${o.customer}, ${o.address}${o.emaar ? ((F[o.order_id] || {}).maybe ? "  (EMAAR?)" : "  (EMAAR)") : ""}`);
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
  if (c.h_over_tall) p.push(`TALL LADDER ×${c.h_over_tall}`);
  if (c.removal) p.push(`remove ×${c.removal}`);
  if (f.villa) p.push("villa");
  const m = Math.round(f.minutes || 0);
  p.push(`≈ ${m >= 60 ? Math.floor(m / 60) + " h " : ""}${m % 60 ? (m % 60) + " min" : ""}`.trim());
  return p.join(" · ");
}
function workLineHtml(id){
  const f = F[id] || {}, c = f.counts || {}, p = [];
  const tag = (cls, txt) => `<span class="kit ${cls}">${txt}</span>`;
  if (f.windows) p.push(`<span class="nwin">${f.windows} win</span>`); else if (f.kind) p.push(esc(f.kind));
  if (c.curt_2l) p.push(`${c.curt_2l}×2L`);
  if (c.curt_1l) p.push(`${c.curt_1l}×1L`);
  if (c.blinds) p.push(`${c.blinds} blind${c.blinds > 1 ? "s" : ""}`);
  if (f.motor || c.motor_windows) p.push(tag("motor", `motor ×${c.motor_windows || 1}${c.remote ? ` · remote ×${c.remote}` : ""}`));
  else if (c.remote) p.push(tag("motor", `remote ×${c.remote}`));
  if (c.pelmet) p.push(tag("pelmet", `pelmet ×${c.pelmet}`));
  if (c.flex) p.push(tag("bend", `bend rail ×${c.flex}`));
  if (f.scaffolding) p.push(tag("scaf", "scaffolding"));
  if (c.h_over_tall) p.push(tag("ladder", `🪜 tall ladder ×${c.h_over_tall}`));
  if (c.removal) p.push(`remove ×${c.removal}`);
  if (f.villa) p.push("villa");
  const m = Math.round(f.minutes || 0);
  p.push(`≈ ${m >= 60 ? Math.floor(m / 60) + " h " : ""}${m % 60 ? (m % 60) + " min" : ""}`.trim());
  return p.join(" · ");
}
const ACT_SHORT = {tookan: "Tookan", groups: "WA groups", messages: "WA schedule", checklist: "Checklists", permits: "Emaar permits", permitwa: "Permits → WA", pdf: "One-page PDF"};
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
      <button class="btn small" id="stp-b-pdf" title="One A4 page: every team's jobs, times, addresses and scope">📄 One-page PDF</button>
      <button class="btn small primary" id="stp-b-publish" title="Save this plan as the final schedule and open Stage 4 (live tracking)">📌 Publish → Stage 4</button>
      <span class="muted" style="font-size:11.5px">Senders below only preview; Publish saves the schedule for live tracking.</span>
    </div>
    <div class="s3teams">${P.teams.map(t => `<div class="tcard" style="--tc:${teamColor(t.team)}">
      <div class="th"><b>${esc(t.name)}</b>${t.members.length && !t.members.every(m => t.name.includes(m)) ? ` <span class="muted">${esc(t.members.join(" & "))}</span>` : t.members.length ? "" : ` <span class="muted">crew not named</span>`}
        <span class="lv">leave ${t.leave} · ${t.orders.length} job${t.orders.length === 1 ? "" : "s"} · <span class="nwin">${t.orders.reduce((a, o) => a + ((F[o.order_id] || {}).windows || 0), 0)} win</span> · ${(t.orders.reduce((a, o) => a + ((F[o.order_id] || {}).minutes || 0), 0) / 60).toFixed(1)} h</span></div>
      <input class="tnote" data-tnote="${t.team}" value="${esc(t.note)}" placeholder="Note for the team (goes on WhatsApp)">
      <ul class="tjobs">${t.orders.map(o => `<li class="${o.emaar ? ((F[o.order_id] || {}).maybe ? "emaar maybe" : "emaar") : ""} ${(F[o.order_id] || {}).kind === "ISR" ? "isr" : ""}">
        <span class="tt ${o.time_edited ? "ed" : ""}" title="${o.time_edited ? "3D sheet " + o.sheet_time : "3D sheet time"}"><input type="time" step="300" class="tin" value="${esc(o.time)}" data-time="${o.order_id}" aria-label="Start time of ${o.order_id}"></span>
        <span class="tj">${o.order_id} ${esc(o.customer)}</span>${o.emaar ? ((F[o.order_id] || {}).maybe ? `<span class="chip emaar maybe">E?</span>` : `<span class="chip emaar">E</span>`) : ""}${o.late_min ? `<span class="chip warn" title="expected to start ${o.late_min} min after the appointment">+${o.late_min}</span>` : ""}
        <div class="jd"><div class="ja">${esc(o.address)}</div><div class="jw">${workLineHtml(o.order_id)}</div></div>
        <input class="onote" data-onote="${o.order_id}" data-team="${t.team}" value="${esc(o.note)}" placeholder="Note (goes on WhatsApp)" aria-label="Note for ${o.order_id}"></li>`).join("")}</ul>
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
    if (a.id === "pdf") { L.push("  generating the one-page PDF…"); pdfOnePager(); L.push(""); continue; }
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

/* ---------------- downloads: Excel (every stage) and the one-page PDF (end of Stage 3) ---------------- */
const kindOf = id => (F[id] || {}).kind === "ISR" ? "ISR" : (F[id] || {}).hold ? ((F[id] || {}).kind || "Odd time") : "";

function xlsxPlan(){
  const P = payload(), stops = [];
  P.teams.forEach(t => t.orders.forEach((o, i) => { const f = F[o.order_id] || {}; stops.push({
    "Team": t.name, "Crew": (t.members || []).join(" & "), "Leave": t.leave, "Stop": i + 1, "Order": o.order_id, "Type": kindOf(o.order_id) || "Installation",
    "Customer": o.customer, "Phone": o.phone || "", "City": o.city, "Address": o.address, "Appointment": o.time, "3D sheet time": o.sheet_time,
    "ETA": o.eta, "Planned start": o.planned_start, "Planned end": o.planned_end, "Late (min)": o.late_min || 0, "Windows": f.windows || 0, "Scope": o.scope,
    "Emaar": o.emaar ? "Yes" : "", "Scaffolding (>4 m)": f.scaffolding ? "Yes" : "", "Tall ladder (>3.5 m)": f.tall_ladder ? "Yes" : "",
    "Installation alert": (o.installation_alert || []).join(" | "), "Note": o.note || "", "Team note": t.note || ""}); }));
  const unassigned = queue().map(id => { const f = F[id] || {}; return {"Order": id, "Type": kindOf(id) || "Installation", "Customer": f.customer, "City": f.city,
    "Address": f.address, "Appointment": f.slot, "Windows": f.windows || 0, "Scope": workLine(id)}; });
  const teams = P.teams.map(t => { const r = simulate(state.assign[t.team] || []); return {"Team": t.name, "Crew": (t.members || []).join(" & "),
    "Jobs": t.orders.length, "Windows": r.windows, "Work hours": Number((r.work / 60).toFixed(1)), "Leave": t.leave, "Back": r.orders ? hm(r.home) : ""}; });
  const sheets = [{name: "Schedule", rows: stops}, {name: "Not on a team", rows: unassigned}, {name: "Teams", rows: teams}].filter(s => s.rows.length);
  if (!sheets.length){ toast("Nothing to export yet - no orders on this day.", ""); return; }
  downloadXlsx(`schedule_${UI.date}_${UI.city.replace(/ /g, "")}_stage${state.stage}.xlsx`, sheets)
    .catch(e => toast("Excel export failed: " + e.message, "bad"));
}

/* Order details as icons for the one-pager (user, 6 Nov 26: "convert the order details into icons"). One chip per fact: icon + count.
 * Blackout / sheer counts are NOT shown (the layer counts replace them); the title attribute carries the plain words. */
const ICON_LEGEND = [["🪟", "windows"], ["▌", "single layer"], ["▌▌", "double layer"], ["↪", "bend rail"], ["⚡", "motor"], ["🎛", "remote"], ["▤", "blinds"],
  ["🔗", "tie belts Velcro"], ["🪝", "tie belts hook"], ["⛓", "pull cord track"], ["🪜", "tall ladder"], ["🏗", "scaffolding"], ["🏠", "villa"], ["🔁", "ISR / hanging"], ["⏩", "express"]];
function detailIcons(o){
  const f = F[o.order_id] || {}, sc = String(o.scope || ""), alerts = (o.installation_alert || []).map(String), chips = [], rest = [];
  const chip = (ic, n, words, cls) => chips.push(`<span class="ic ${cls || ""}" title="${esc(words)}${n ? ": " + n : ""}"><i>${ic}</i>${n ? "<b>" + esc(String(n)) + "</b>" : ""}</span>`);
  const num = (re, txt) => { const m = re.exec(txt); return m ? Number(m[1]) : 0; };
  const win = num(/^(\d+)\s*win/, sc); if (win) chip("🪟", win, "Windows");
  const one = num(/(\d+)×1L/, sc), two = num(/(\d+)×2L/, sc);
  if (one) chip("▌", one, "Single-layer windows"); if (two) chip("▌▌", two, "Double-layer windows");
  let bend = 0, motor = 0, remote = 0, blinds = 0, velcro = 0, hook = 0, pull = 0, baton = 0; const pullTxt = [];
  alerts.forEach(a => { let m;
    if ((m = /^Bend rail:\s*(\d+)/i.exec(a))) bend += +m[1];
    else if ((m = /^Motors?:\s*(\d+)/i.exec(a))) motor += +m[1];
    else if ((m = /^Remotes?:\s*(\d+)/i.exec(a))) remote += +m[1];
    else if ((m = /^Blinds[^:]*:\s*(\d+)/i.exec(a))) blinds += +m[1];
    else if ((m = /^Tie belts Velcro:\s*(\d+)/i.exec(a))) velcro += +m[1];
    else if ((m = /^Tie belts Hook:\s*(\d+)/i.exec(a))) hook += +m[1];
    else if ((m = /^Pull cord tracks?:\s*(\d+)\s*(\(([^)]*)\))?/i.exec(a))) { pull += +m[1]; if (m[3]) pullTxt.push(m[3]); }
    else if ((m = /^Hand baton[^:]*:\s*(\d+)/i.exec(a))) baton += +m[1];
    else if (/^(Blackout|Sheer)\s*:/i.test(a)) { /* replaced by the layer counts */ }
    else if (/express/i.test(a)) chip("⏩", 0, "2-day express");
    else rest.push(a); });
  bend = bend || num(/bend rail ×(\d+)/i, sc); motor = motor || num(/motor ×(\d+)/i, sc); remote = remote || num(/remote ×(\d+)/i, sc);
  blinds = blinds || num(/(\d+) blinds?/i, sc);
  if (bend) chip("↪", bend, "Bend rail"); if (motor) chip("⚡", motor, "Motor"); if (remote) chip("🎛", remote, "Remote"); if (blinds) chip("▤", blinds, "Blinds");
  if (velcro) chip("🔗", velcro, "Tie belts Velcro"); if (hook) chip("🪝", hook, "Tie belts hook");
  if (pull) chip("⛓", pull, "Pull cord track" + (pullTxt.length ? " (" + pullTxt.join("; ") + ")" : ""));
  if (baton) chip("🥢", baton, "Hand baton");
  const lad = num(/TALL LADDER ×(\d+)/i, sc) || (f.tall_ladder ? 1 : 0); if (lad) chip("🪜", lad, "Tall ladder");
  if (/SCAFFOLD/i.test(sc) || f.scaffolding) chip("🏗", 0, "Scaffolding", "warn");
  if (/villa/i.test(sc)) chip("🏠", 0, "Villa");
  if (/ISR/.test(sc) || f.kind === "ISR") chip("🔁", 0, "ISR / hanging");
  const text = rest.map(r => `<div class="dn">${esc(r)}</div>`).join("");
  return chips.join("") + text;
}

/* The one-page PDF uses the browser's print engine like every other PDF in this app (see printSheet in
 * ui.js): it lays out Arabic customer names and addresses, which an embedded-font PDF library cannot
 * without shipping fonts. A script shrinks the type until everything fits ONE landscape A4 page, then
 * calls print(); the person picks "Save as PDF". ISR jobs get a dotted border. */
function pdfOnePager(){
  const P = payload();
  if (!P.teams.length){ toast("No team has any orders yet.", ""); return; }
  const w = window.open("", "_blank");
  if (!w){ toast("The browser blocked the pop-up. Allow pop-ups for this site and try again.", "bad"); return; }
  const d = new Date(UI.date + "T00:00:00"), jobs = P.teams.reduce((a, t) => a + t.orders.length, 0);
  /* Layout: ONE table, a row per job, grouped by team (the format the user picked from Team_Schedule_2026-11-04_v2.pdf):
   * Team | Time (start big, end small, "est N min") | Order | Job pill | Scope | Customer | Address (map link) | Notes */
  const JOB = {New: "j-new", Visit: "j-visit", Hanging: "j-hang", Partial: "j-part"};
  // the stepper has no job-type field, so read it from what the coordinator wrote, then from the order itself
  const jobType = (o) => { const txt = ((o.note || "") + " " + (o.installation_alert || []).join(" ")).toLowerCase(), f = F[o.order_id] || {};
    if (/\bvisit\b/.test(txt)) return "Visit";
    if (/\bpartial\b/.test(txt)) return "Partial"; if (/\bhanging\b/.test(txt) || f.kind === "ISR") return "Hanging";
    if (!/^\d+$/.test(String(o.order_id))) return "Visit"; return "New"; };
  const hmOnly = (s) => String(s || "").slice(0, 5);
  const row = (o, first, span, t) => {
    const f = F[o.order_id] || {}, est = o.est_min || 0, jt = jobType(o), st = hmOnly(o.planned_start) || String(o.time || "").split(/\s*[-–]\s*/)[0];
    const timeCell = `<span class="t1">${esc(st)}</span>${est ? `<span class="t2"> – ${esc(hmOnly(o.planned_end))}</span><div class="t3">est ${est} min</div>` : ""}`;
    const pin = o.lat != null && o.lng != null, addr = esc(o.address || "");
    const addrCell = pin ? `<a href="https://www.google.com/maps?q=${o.lat},${o.lng}">${addr}</a>` : `${addr} <span class="np">(no pin)</span>`;
    const notes = [o.note, o.emaar ? (f.maybe ? "EMAAR?" : "EMAAR") : "", o.late_min > 0 ? `plan ETA ${hmOnly(o.eta)} (+${o.late_min} min)` : ""].filter(Boolean).map(esc).join(" · ");
    const mem = t.members.length ? t.members.join(" & ") : "";
    let label = t.name; t.members.forEach(m => { label = label.split(m).join(""); }); label = label.replace(/\s*&\s*/g, " ").replace(/\s{2,}/g, " ").trim() || t.name;
    const teamCell = first ? `<td class="tm" rowspan="${span}"><b>${esc(label)}</b><div>${esc(mem)}</div><span class="city">${esc(UI.city)}</span></td>` : "";
    return `<tr class="${first ? "first" : ""}">${teamCell}<td class="tc">${timeCell}</td><td class="oid">${esc(o.order_id)}</td><td><span class="pill ${JOB[jt] || "j-new"}">${jt}</span></td>
      <td class="sc">${o.scope ? esc(o.scope) : ""}</td><td class="dt">${detailIcons(o)}</td><td>${esc(o.customer || "")}${o.phone ? " " + esc(o.phone) : ""}</td><td>${addrCell}</td><td>${notes}</td></tr>`; };
  const rows = P.teams.map(t => t.orders.map((o, i) => row(o, i === 0, t.orders.length, t)).join("")).join("");
  const planDate = d.toLocaleDateString("en-GB", {day: "numeric", month: "short", year: "2-digit"});
  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Schedule ${esc(UI.date)} ${esc(UI.city)}</title><style>
    @page{size:A4 landscape;margin:6mm}
    *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    html,body{margin:0}
    body{font:11px/1.25 "Noto Sans","Segoe UI",-apple-system,Roboto,"Noto Sans Arabic",Arial,sans-serif;color:#14202e;width:285mm}
    .hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #14202e;padding-bottom:4px;margin-bottom:4px}
    h1{font-size:1.7em;margin:0}.sub{color:#5f7480;font-size:.85em;text-align:right}
    table{width:100%;border-collapse:collapse}
    th{background:#14181c;color:#fff;text-align:left;font-size:.85em;padding:4px 5px;font-weight:600}
    td{padding:3px 5px;border-bottom:1px solid #cfd4da;vertical-align:middle;overflow-wrap:anywhere}
    tr.first td{border-top:2px solid #14181c}
    td.tm{background:#f1eee8;border-right:1px solid #cfd4da;vertical-align:top;width:11%}
    td.tm b{font-size:1em}.city{display:inline-block;background:#2e6f9e;color:#fff;border-radius:3px;font-size:.75em;padding:0 5px;margin-top:2px}
    td.tc{width:12%;white-space:nowrap}.t1{font-size:1.9em;font-weight:800}.t2{font-size:.85em;font-weight:700}.t3{color:#5f7480;font-size:1.05em}
    td.oid{font-weight:700;width:5%}td.sc{color:#33414f;font-size:.85em}
    .pill{display:inline-block;border-radius:3px;font-size:.85em;padding:0 6px;white-space:nowrap}
    .j-new{background:#d7efdb;color:#1f5130}.j-visit{background:#fbe7c0;color:#6b4a0c}.j-hang{background:#dcdcf2;color:#33337a}.j-part{background:#e4d6f3;color:#5a2a86}
    td.sc{font-weight:700;width:12%}td.dt{width:20%}
    .ic{display:inline-flex;align-items:center;gap:2px;border:1px solid #b9c2cc;border-radius:4px;padding:0 4px;margin:1px 2px 1px 0;background:#f7f8fa;white-space:nowrap}
    .ic i{font-style:normal;font-size:1.15em}.ic b{font-size:1.05em}.ic.warn{background:#fde2e0;border-color:#c0392b}
    .dn{font-size:.8em;color:#33414f}.lg{margin-top:4px;font-size:.8em;color:#33414f}.lg .ic{background:#fff}
    td a{color:#14202e}.np{color:#c0392b}
  </style></head><body>
    <div class="hd"><h1>Installation schedule · ${esc(d.toLocaleDateString("en-GB", {weekday: "long", day: "2-digit", month: "long", year: "numeric"}))}</h1>
      <div class="sub">${P.teams.length} teams · ${jobs} jobs<br>Team Board plan ${esc(planDate)} (${esc(UI.city)}) + 3D sheet details; end times are estimates</div></div>
    <table id="g"><thead><tr><th>Team</th><th>Time</th><th>Order</th><th>Job</th><th>Scope of work</th><th>Order details</th><th>Customer</th><th>Address</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="lg">${ICON_LEGEND.map(([ic, w]) => `<span class="ic"><i>${ic}</i> ${w}</span>`).join("")}</div>
    <script>
      var fs = 12, max = 190 * 3.7795; // 190 mm of usable height, in CSS px
      function fit(){ document.body.style.fontSize = fs + "px";
        if (document.documentElement.scrollHeight > max && fs > 4){ fs -= 0.25; fit(); } }
      fit(); setTimeout(function(){ window.print(); }, 350);
    <\/script></body></html>`);
  w.document.close();
}

/* ---------------- map ---------------- */
let map = null, layer = null, tiles = null, fitKey = "";
function initMap(){
  if (!window.L){ $("map").innerHTML = `<div class="empty">The map needs an internet connection.</div>`; return; }
  map = L.map($("map"), {scrollWheelZoom: true});
  layer = L.layerGroup().addTo(map);
  map.setView(CITY_CENTRE[UI.city] || [25.1, 55.2], 10);
  map.on("click", e => { if (picking) setPin(picking, e.latlng.lat, e.latlng.lng); });
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
const ll = id => F[id].lat != null && !F[id].loc_unknown ? [F[id].lat, F[id].lng] : null;
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
      L.marker(p, {icon: pinIcon(t.team, teamColor(t.team), (F[last].emaar ? (F[last].maybe ? "emaar maybe " : "emaar ") : "") + (isHot ? "hot" : ""), plab(last, r.stops[r.stops.length - 1].start, "free " + hm(r.free))), zIndexOffset: isHot ? 900 : 300}).addTo(layer)
        .bindPopup(`<b>${esc(t.name)}</b> · last order <b>${last}</b><br>${esc(F[last].customer)}<br>${esc(F[last].address)}<br>Appointment ${F[last].slot} · finishes ${hm(r.free)} · ${seq.length} job(s)`);
      if (id && ll(id) && c){
        const best = c.rank === 1;
        L.polyline([p, ll(id)], {color: teamColor(t.team), weight: best || isHot ? 5 : 2.5, opacity: best || isHot ? 0.95 : 0.5, dashArray: best ? null : "6 7"}).addTo(layer);
        legLabel(p, ll(id), `${c.st.travel}m${c.st.tnote === "location unknown" ? "?" : ""} · ${c.st.km}km`, teamColor(t.team));
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
        if (last) legLabel(last, p, `${s.travel}m${s.tnote === "location unknown" ? "?" : ""} · ${s.km}km`, teamColor(t.team));
        last = p;
        L.marker(p, {icon: pinIcon(i + 1, teamColor(t.team), F[s.id].emaar ? (F[s.id].maybe ? "emaar maybe" : "emaar") : "", plab(s.id, s.start)), zIndexOffset: 400}).addTo(layer)
          .bindPopup(`<b>${esc(t.name)} · stop ${i + 1}</b><br><b>${s.id}</b> ${esc(F[s.id].customer)}<br>${esc(F[s.id].address)}<br>${F[s.id].slot} → ${hm(s.start)}–${hm(s.end)}<br>
            <select onchange="moveOrder('${s.id}', this.value==='un'?'un':Number(this.value))"><option value="">Move to team…</option>${state.teams.filter(x => x.team !== t.team).map(x => `<option value="${x.team}">${esc(x.name)}</option>`).join("")}<option value="un">Take off the schedule</option></select>`);
      });
      if (line.length > 1) L.polyline(line, {color: teamColor(t.team), weight: 4, opacity: .85}).addTo(layer);
    }
    for (const i of queue()) if (ll(i)) { L.marker(ll(i), {icon: pinIcon("?", "#fff", "grey")}).addTo(layer).bindPopup(`<b>${i}</b> not on a team`); all.push(ll(i)); }
    fit(all, scopeKey() + "|s2|" + state.teams.length + "|" + [...hiddenTeams].join(","), !!force);
  }
  const unknown = IDS.filter(i => F[i].loc_unknown);
  $("map-nopin").innerHTML = unknown.length ? `<b style="color:var(--bad)">Unknown location (${unknown.length}):</b> ${unknown.map(i => `<span class="chip">${esc(i)} ${esc(F[i].customer)} <button class="lnk" data-pickpin="${esc(i)}">📍 pick on map</button></span>`).join(" ")}` : "";
}
const hiddenTeams = new Set();

function renderMapBar(){
  if (picking && F[picking]){
    $("mapbar").innerHTML = `<b class="pickbar">📍 Click the map where <u>${esc(picking)}</u> ${esc(F[picking].customer)} is</b> <span class="muted" style="font-size:11.5px">${esc(F[picking].address || "")}</span> <button class="btn small" id="stp-b-pickcancel">Cancel</button>`;
    return;
  }
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
    // tall-motor / tall-window-without-scaffolding orders get "Follow up accounts" in the PO module;
    // the 10-minute cron does it too, this just makes it immediate. A failure must never block planning.
    rpc("fn_auto_accounts_followups", {}).catch(() => {});
    return day;
  } finally { loading(false); }
}
async function switchDate(date){
  if (!date) return;
  haltPlay(); caption = "";
  await sync.flush();
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

/* ---------------- "Check the 3D sheet again": what differs, with a button per order (user, 10 Nov 2026) ----------------
 * The sheet is read again and compared with the plan, three ways:
 *   time    - the appointment on the sheet is not the plan's time. The plan keeps its time until the user
 *             picks: "Use 3D time" or "Keep plan time" (nothing changes silently any more).
 *   gone    - on the plan, no longer on the sheet. Kept on the plan (state.sheetGone) and flagged, until
 *             "Remove from plan" or "Keep on plan".
 *   fresh   - on the sheet, not on the plan: new orders (already waiting under Not on a team), held ISR /
 *             odd-time rows, orders removed here, and hand-made orders the sheet now carries. */
let DIFF = null;
function factSnap(f){ const g = clone(f); g.slot = f.sheet_slot || f.slot; ["kind_base", "minutes_base", "emaar_auto", "maybe", "gone3d", "manual", "loc_unknown", "loc_doubt"].forEach(k => delete g[k]); return g; }
async function checkSheet(){
  await sync.flush();
  const before = {}; IDS.forEach(i => { before[i] = clone(F[i]); });
  delete DAYS[UI.date];
  try { await loadDay(UI.date); } catch (e) { toast((e && e.message) || "Could not read the 3D sheet", "bad"); return; }
  DAY = DAYS[UI.date];
  const sheetIds = new Set(Object.keys(DAY.facts).filter(i => DAY.facts[i].city === UI.city));
  const heldKeys = new Set(Object.keys(DAY.held));
  const D = {at: new Date(), time: [], gone: [], fresh: [], manual: []};
  state.sheetGone = state.sheetGone || {};
  for (const i of Object.keys(before)){
    const f = before[i];
    if (f.manual){ if (sheetIds.has(i)) D.manual.push(i); continue; }
    if (f.gone3d){ if (sheetIds.has(i) || heldKeys.has(i)) delete state.sheetGone[i]; else D.gone.push(i); continue; }
    const still = f.hold ? heldKeys.has(i) : sheetIds.has(i);
    if (!still){ state.sheetGone[i] = factSnap(f); D.gone.push(i); continue; }
    const nf = f.hold ? DAY.held[i] : DAY.facts[i];
    if (nf && nf.slot && f.slot && nf.slot !== f.slot){
      if (!state.times[i]) state.times[i] = f.slot;     // keep the plan's time until the user picks
      D.time.push({id: i, sheet: nf.slot, plan: f.slot});
    }
  }
  for (const i of sheetIds) if (!before[i] && !state.removed.includes(i)) D.fresh.push(i);
  DIFF = D; T = {}; KM = {};
  buildF(); applyTimes();
  const n = D.time.length + D.gone.length + D.fresh.length + D.manual.length;
  save(n ? `Checked the 3D sheet: ${D.time.length} time difference(s), ${D.gone.length} not on the sheet any more, ${D.fresh.length} new on the sheet` : "Checked the 3D sheet: it agrees with the plan");
  paint();
}
const dfRow = (id, body, btns) => `<div class="dfr"><span><b>${esc(id)}</b> ${body}</span><span class="dfb">${btns}</span></div>`;
function renderDiff(){
  const box = $("diff"); if (!box) return;
  if (!DIFF){ box.innerHTML = ""; return; }
  const D = DIFF, cust = i => esc((F[i] || DAY.facts[i] || DAY.held[i] || {}).customer || "");
  const teamOfId = i => { const t = Object.keys(state.assign).find(t => state.assign[t].includes(i)); return t ? tname(t) : "not on a team"; };
  const held = Object.values(DAY.held).filter(h => h.city === UI.city && !state.added.includes(h.key));
  const gone = state.removed.map(i => DAY.facts[i] || DAY.held[i]).filter(f => f && f.city === UI.city);
  const n = D.time.length + D.gone.length + D.fresh.length + D.manual.length + held.length + gone.length;
  box.innerHTML = `<div class="panel diffp">
    <div class="spread"><b>3D sheet check · ${D.at.toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"})}</b>
      <span><button class="lnk" data-refresh="1">↻ check again</button> <button class="lnk" data-diffclose="1" title="Hide">✕</button></span></div>
    ${!n ? `<div class="good">✓ The plan and the 3D sheet agree: same orders, same times.</div>` : ""}
    ${D.time.length ? `<h4>Time differs (${D.time.length}) <button class="btn small" data-dall="time">Use the 3D time for all</button></h4>
      ${D.time.map(d => dfRow(d.id, `${cust(d.id)} · 3D sheet <b>${esc(d.sheet)}</b> · plan <b>${esc(d.plan)}</b>`,
        `<button class="btn small primary" data-dsheet="${esc(d.id)}">Use 3D time ${esc(d.sheet)}</button><button class="btn small" data-dkeep="${esc(d.id)}">Keep plan time ${esc(d.plan)}</button>`)).join("")}` : ""}
    ${D.gone.length ? `<h4>On the plan, not on the 3D sheet (${D.gone.length})</h4>
      ${D.gone.map(i => dfRow(i, `${cust(i)} · ${esc(teamOfId(i))}`,
        `<button class="btn small danger" data-dgonerm="${esc(i)}">Remove from plan</button><button class="btn small" data-dgonekeep="${esc(i)}">Keep on plan</button>`)).join("")}` : ""}
    ${D.manual.length ? `<h4>Added by hand, now on the 3D sheet (${D.manual.length})</h4>
      ${D.manual.map(i => dfRow(i, cust(i), `<button class="btn small primary" data-dmanual="${esc(i)}">Use the 3D sheet's row</button>`)).join("")}` : ""}
    ${D.fresh.length || held.length || gone.length ? `<h4>On the 3D sheet, not on the plan (${D.fresh.length + held.length + gone.length})</h4>
      ${D.fresh.map(i => dfRow(i, `${cust(i)} · new on the sheet, ${esc(DAY.facts[i].slot || "")} - waiting under Not on a team`,
        `<button class="btn small" data-dfreshok="${esc(i)}">OK, plan it</button><button class="btn small" data-dfreshrm="${esc(i)}">Don't plan it</button>`)).join("")}
      ${held.map(h => dfRow(h.order_id, `${esc(h.customer)} · ${esc(h.kind || "held")} ${esc(h.slot || "")}`, `<button class="btn small primary" data-addheld="${esc(h.key)}">+ Add to plan</button>`)).join("")}
      ${gone.map(f => dfRow(f.order_id, `${esc(f.customer)} · removed from this plan earlier`, `<button class="btn small primary" data-restore="${esc(f.order_id)}">Restore</button>`)).join("")}` : ""}
  </div>`;
}
function diffDrop(kind, id){ if (!DIFF) return; if (kind === "time") DIFF.time = DIFF.time.filter(d => d.id !== id); else DIFF[kind] = DIFF[kind].filter(i => i !== id); }
function diffClick(b){
  const d = b.dataset;
  if (d.diffclose){ DIFF = null; renderDiff(); return true; }
  if (d.dsheet){ const r = DIFF.time.find(x => x.id === d.dsheet); delete state.times[d.dsheet]; diffDrop("time", d.dsheet); applyTimes();
    save(`${d.dsheet} time synced to the 3D sheet${r ? " (" + r.plan + " → " + r.sheet + ")" : ""}`); paint(); return true; }
  if (d.dkeep){ const r = DIFF.time.find(x => x.id === d.dkeep); diffDrop("time", d.dkeep);
    save(`${d.dkeep} keeps the plan time${r ? " " + r.plan + " (3D sheet says " + r.sheet + ")" : ""}`); paint(); return true; }
  if (d.dall === "time"){ DIFF.time.forEach(r => delete state.times[r.id]); const n = DIFF.time.length; DIFF.time = []; applyTimes();
    save(`${n} time(s) synced to the 3D sheet`); paint(); return true; }
  if (d.dgonerm){ diffDrop("gone", d.dgonerm); removeOrder(d.dgonerm); return true; }
  if (d.dgonekeep){ const i = d.dgonekeep; if (state.sheetGone && state.sheetGone[i]){ state.extra[i] = state.sheetGone[i]; delete state.sheetGone[i]; }
    diffDrop("gone", i); buildF(); applyTimes(); save(`${i} kept on the plan although it is not on the 3D sheet`); paint(); return true; }
  if (d.dmanual){ delete state.extra[d.dmanual]; diffDrop("manual", d.dmanual); buildF(); applyTimes(); save(`${d.dmanual} now follows the 3D sheet's row`); paint(); return true; }
  if (d.dfreshok){ diffDrop("fresh", d.dfreshok); state.cur = d.dfreshok; renderDiff(); return true; }
  if (d.dfreshrm){ diffDrop("fresh", d.dfreshrm); removeOrder(d.dfreshrm); return true; }
  return false;
}

/* ---------------- main ---------------- */
// everything the 3D sheet has for this date + city that the plan does not: held ISR / odd-time rows and
// orders removed here. One click puts it back; it then waits under "Not on a team" / in the table.
function renderRibbon(){
  const rb = $("ribbon"); if (!rb) return;
  const held = Object.values(DAY.held).filter(h => h.city === UI.city && !state.added.includes(h.key || h.order_id));
  const gone = state.removed.map(i => DAY.facts[i] || DAY.held[i]).filter(f => f && f.city === UI.city);
  const canRefresh = typeof loadDay === "function";
  if (!held.length && !gone.length){
    rb.innerHTML = `<span class="rbt">✓ Every ${esc(UI.city)} order on the 3D sheet for this day is in the plan.</span>${canRefresh ? ` <button class="lnk" data-refresh="1">↻ Check the 3D sheet again</button>` : ""}`;
    return;
  }
  const item = (f, act, key, kind) => `<span class="rbi" title="${esc((f.address || "") + (f.note ? " — " + f.note : ""))}"><b>${esc(f.order_id)}</b> <span class="muted">${esc(kind)} · sheet ${esc(f.slot || "—")}</span> ${esc(f.customer)} <button class="btn small" ${act}="${esc(key)}">+ Add</button></span>`;
  rb.innerHTML = `<span class="rbt">On the 3D sheet, not in this plan (${held.length + gone.length}):</span>` +
    held.map(h => item(h, "data-addheld", h.key || h.order_id, h.kind || "held")).join("") +
    gone.map(f => item(f, "data-restore", f.order_id, "removed here")).join("") +
    (canRefresh ? ` <button class="lnk" data-refresh="1">↻ Check the 3D sheet again</button>` : "");
}
/* Stage 4 ISR list (13 Nov 2026, user): the same list as Installation > ISR, this city only, under the
 * live teams. Its own element, made once per day + city, so the 20-second live repaint never touches it. */
let s4IsrKey = "";
function renderStage4Isr(){
  const host = $("s4isr"); if (!host) return;
  const k = UI.date + "|" + UI.city;
  if (s4IsrKey === k && host.firstChild){ return; }
  s4IsrKey = k; host.innerHTML = "";
  host.appendChild(isrBoard({city: UI.city, title: `ISR · issue resolution · ${UI.city}`}));
}
function renderStage4(){
  renderStage4Isr();
  live.render({root: ROOT, day: UI.date, city: UI.city, payload,
    held: () => Object.values(DAY.held).filter(h => h.city === UI.city),
    active: () => !!state && state.stage === 4 && /^#\/stepper/.test(location.hash)});
}
async function publishAndOpen(){
  try { const r = await live.publish(payload()); toast(`Published: ${r && r.new || 0} new, ${r && r.updated || 0} refreshed`); go(4); }
  catch (e) { toast((e && e.message) || "Could not publish the schedule", "bad"); }
}
function paint(){
  ROOT.dataset.stage = state.stage;
  ROOT.querySelectorAll(".steps button").forEach(b => b.classList.toggle("on", Number(b.dataset.stage) === state.stage));
  const heldN = Object.values(DAY.held).filter(h => h.city === UI.city && !state.added.includes(h.key)).length;
  $("sub").textContent = `${DAY.date_label} · ${UI.city} · ${IDS.length} orders · ${heldN} ISR / odd-time held back · leave ${BASE.name} from ${BASE.depart_earliest}`;
  renderHeader();
  renderRibbon();
  renderDiff();
  renderMapBar();
  if (state.stage === 1) renderStage1();
  if (state.stage === 2) renderStage2();
  if (state.stage === 3) renderStage3();
  if (state.stage === 4) renderStage4(); else live.stop();
  drawMap();
  if (map) setTimeout(() => map.invalidateSize(), 0);
}
function go(n){ if (n === 2 && state.stage !== 2) state.colOrder = null; state.stage = n; fitKey = ""; save(); paint(); window.scrollTo({top: 0}); setTimeout(() => { if (map){ map.invalidateSize(); drawMap(true); } }, 60); }

on("click", e => {
  if (state && state.stage === 4 && live.onClick(e)) return;
  const row = e.target.closest ? e.target.closest("tr[data-focus]") : null;
  if (row && !e.target.closest("select,input,button") && state.stage === 1){ state.cur = row.dataset.focus; hot = null; save(); paint(); return; }
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.stage) go(Number(b.dataset.stage));
  if (b.dataset.go) go(Number(b.dataset.go));
  if (b.dataset.assign) assignTo(curId(), Number(b.dataset.assign));
  if (b.dataset.treset){ delete state.times[b.dataset.treset]; applyTimes(); save(`${b.dataset.treset} back to the 3D sheet time`); paint(); }
  if (b.dataset.etareset){ delete (state.eta || {})[b.dataset.etareset]; save(`${b.dataset.etareset} ETA reset`); paint(); }
  if (b.dataset.shift) shift(b.dataset.team, Number(b.dataset.idx), Number(b.dataset.shift));
  if (idOf(b) === "b-undo") undo();
  if (idOf(b) === "b-addteam") addTeam();
  if (b.dataset.delteam){
    const n = Number(b.dataset.delteam);
    if (!(state.assign[n] || []).length || delArmed === n){ clearTimeout(delTimer); deleteTeam(n); }
    else { delArmed = n; clearTimeout(delTimer); delTimer = setTimeout(() => { delArmed = null; paint(); }, 4000); paint(); }
  }
  if (idOf(b) === "b-reset"){
    if (!resetArmed){ resetArmed = true; clearTimeout(resetTimer); resetTimer = setTimeout(() => { resetArmed = false; paint(); }, 4000); paint(); }
    else { clearTimeout(resetTimer); restart(state.wave); }
  }
  if (idOf(b) === "b-fit") drawMap(true);
  if (b.dataset.dshift) switchDate(addDays(UI.date, Number(b.dataset.dshift)));
  if (b.dataset.setcity){ const c = b.dataset.setcity; haltPlay(); caption = ""; sync.flush().then(() => { UI.city = c; saveUI(); enterScope(); paint(); }); }
  if (idOf(b) === "b-history") sync.openHistory();
  if (b.dataset.remove) removeOrder(b.dataset.remove);
  if (b.dataset.restore) restoreOrder(b.dataset.restore);
  if (b.dataset.addheld) { addHeld(b.dataset.addheld); closeAdd(); toast && typeof toast === "function" && toast(`Added ${b.dataset.addheld} - it is in the plan, not on a team yet`); }
  if (b.dataset.refresh && typeof loadDay === "function"){ checkSheet(); return; }
  if (diffClick(b)) return;
  if (b.dataset.pickpin){ picking === b.dataset.pickpin ? endPick() : startPick(b.dataset.pickpin); return; }
  if (idOf(b) === "b-pickcancel"){ endPick(); return; }
  if (b.dataset.isrreload){ loadIsr().then(renderIsrTray); return; }
  if (idOf(b) === "b-addorder") openAdd();
  if (idOf(b) === "b-addclose") closeAdd();
  if (idOf(b) === "b-addmanual"){ const g = k => $(k).value; const msg = addManual({id: g("na-id"), customer: g("na-cust"), address: g("na-addr"), slot: g("na-slot"), minutes: g("na-min"), windows: g("na-win"), emaar: $("na-emaar").checked, lat: g("na-lat"), lng: g("na-lng")}); if (msg) $("na-msg").textContent = msg; else closeAdd(); }
  if (idOf(b) === "b-run") runPreview();
  if (idOf(b) === "b-publish") publishAndOpen();
  if (b.dataset.noteopen){ const i = b.parentNode.querySelector("input[data-onote]"); if (i){ i.hidden = !i.hidden || false; if (!i.hidden) i.focus(); } }
  if (idOf(b) === "b-play") startPlay();
  if (idOf(b) === "b-pause") stopPlay();
  if (idOf(b) === "b-step"){ haltPlay(); stepOnce(false); }
  if (idOf(b) === "b-allgo") assignAllSuggested();
  // 13 Nov 2026: next order per team, and the optimiser
  if (idOf(b) === "b-opt"){ haltPlay(); optimise(); return; }
  if (idOf(b) === "b-nextall"){ assignNextAll(); return; }
  if (b.dataset.assignnext){ const id = b.dataset.assignnext, tn = Number(b.dataset.team);
    state.assign[tn] = (state.assign[tn] || []).filter(i => i !== id).concat([id]); state.history.push({id, team: tn, was: null});
    state.cur = null; save(`${id} → ${tname(tn)} (next for the team)`); paint(); return; }
  if (b.dataset.optuse != null){ useOptPlan(Number(b.dataset.optuse)); return; }
  if (b.dataset.optshow != null){ const n = Number(b.dataset.optshow); OPT.show = OPT.show === n ? null : n; paintOpt(); return; }
  if (b.dataset.optclose){ OPT.res = null; paintOpt(); return; }
  if (idOf(b) === "b-xlsx") xlsxPlan();
  if (idOf(b) === "b-pdf") pdfOnePager();
  if (idOf(b) === "b-dl"){
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(payload(), null, 1)], {type: "application/json"}));
    a.download = `schedule_plan_${UI.date}_${UI.city.replace(/ /g, "")}.json`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }
});
on("change", e => {
  const el = e.target;
  if (state && state.stage === 4 && live.onChange(e)) return;
  if (el.matches("input[data-emaar]")){
    const id = el.dataset.emaar; state.emaarSet = state.emaarSet || {};
    if (el.checked === F[id].emaar_auto) delete state.emaarSet[id]; else state.emaarSet[id] = el.checked;
    // remembered for the address, so the next order there is tagged by itself (fn_sched_is_emaar)
    if (F[id].address) rpc("fn_stepper_mark_emaar", {p_address: F[id].address, p_emaar: el.checked}).catch(() => {});
    applyTimes(); save(`${id} ${el.checked ? "tagged" : "untagged"} Emaar`); paint();
  }
  if (el.matches("input[data-isr]")){
    const id = el.dataset.isr; state.isr = state.isr || {};
    if (el.checked === (F[id].kind_base === "ISR")) delete state.isr[id]; else state.isr[id] = el.checked;
    applyTimes(); save(`${id} ${el.checked ? "tagged" : "untagged"} ISR`); paint();
  }
  if (el.matches("input[data-eta]")){
    const id = el.dataset.eta; state.eta = state.eta || {};
    if (el.value) state.eta[id] = el.value; else delete state.eta[id];
    save(`${id} ETA ${el.value || "reset"}`); paint();
  }
  if (el.matches("input[data-time]")){ if (el.value) state.times[el.dataset.time] = el.value; else delete state.times[el.dataset.time]; applyTimes(); state.cur = el.dataset.time; save(`${el.dataset.time} appointment time ${el.value || "back to the 3D sheet's"}`); paint(); }
  if (el.matches("select[data-team-for]")){ if (playing) stopPlay(); assignTo(el.dataset.teamFor, el.value === "" ? "" : Number(el.value)); }
  if (idOf(el) === "wave") restart(el.value, true);
  if (idOf(el) === "sortSel"){ UI.sort = el.value; saveUI(); paint(); }
  if (idOf(el) === "voice"){ UI.voice = el.checked; saveUI(); if (!el.checked && canSpeak()) speechSynthesis.cancel(); }
  if (idOf(el) === "rate"){ UI.rate = Number(el.value); saveUI(); }
  if (idOf(el) === "dateSel") switchDate(el.value);
  if (idOf(el) === "early"){ state.allowEarly = el.checked; save(`Later orders ${el.checked ? "may" : "may not"} start 2 h early`); paint(); }
  if (idOf(el) === "autozoom"){ state.autoZoom = el.checked; fitKey = ""; save(); paint(); }
  if (idOf(el) === "showrest"){ state.showRest = el.checked; save(); paint(); }
  if (el.matches("select[data-move]") && el.value) moveOrder(el.dataset.move, el.value === "un" ? "un" : Number(el.value));
  if (el.matches("input[data-tname]")) setName(el.dataset.tname, el.value);
  if (el.matches("input[data-tmem]")) setMembers(el.dataset.tmem, el.value);
  if (el.matches("input[data-maptoggle]")){ const n = Number(el.dataset.maptoggle); el.checked ? hiddenTeams.delete(n) : hiddenTeams.add(n); fitKey = ""; renderMapBar(); drawMap(); }
  if (idOf(el) === "isrfilter"){ ISRC.filter = el.value; renderIsrTray(); }
  if (idOf(el) === "maptoggleall"){ if (el.checked) hiddenTeams.clear(); else state.teams.forEach(t => hiddenTeams.add(t.team)); fitKey = ""; renderMapBar(); drawMap(); }
  if (el.matches("input[data-act]")){ el.checked ? picked.add(el.dataset.act) : picked.delete(el.dataset.act); renderStage3(); }
});
// Stage 3 notes: saved as you type and shown in the message preview, without redrawing the page
on("input", e => {
  const el = e.target, n = notes();
  let line = "";
  // Stage 2 scratch notes (13 Nov 2026, user): internal, shared with whoever opens the day, never on WhatsApp
  if (el.matches("textarea[data-tscratch]")){ (n.scratch = n.scratch || {})[el.dataset.tscratch] = el.value; save(`Scratch note for ${tname(el.dataset.tscratch)}`, "note"); return; }
  if (el.matches("[data-tnote]")){ n.team[el.dataset.tnote] = el.value; line = `Note for ${tname(el.dataset.tnote)}: ${el.value}`; }
  else if (el.matches("input[data-onote]")){ n.order[el.dataset.onote] = el.value; line = `Note ${el.dataset.onote}: ${el.value}`; }
  else return;
  save(line, "note");
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
  if (id && id.startsWith("isr:")){ addIsrToTeam(Number(id.slice(4)), Number(t.dataset.team)); return; }
  if (id && F[id] && t.dataset.team !== dragFrom) moveOrder(id, Number(t.dataset.team));
});



/* ---------------- route entry ---------------- */
const SKELETON = `<div class="stp" data-stage="1">
<div class="stp-hdr">
  <h1>Step-by-step Scheduler</h1>
  <span class="datebox"><button class="dbtn" data-dshift="-1" aria-label="Previous day">◀</button><input type="date" id="stp-dateSel" class="hsel" aria-label="Date"><button class="dbtn" data-dshift="1" aria-label="Next day">▶</button></span>
  <div class="cityseg" id="stp-citySeg" role="group" aria-label="City"></div>
  <span class="sub" id="stp-sub"></span>
  <span class="stpsync" id="stp-sync"></span>
  <button class="btn small" id="stp-b-xlsx" title="Download this day's plan as an Excel workbook (works in every stage)">⬇ Excel</button>
  <nav class="steps" aria-label="Stages">
    <button data-stage="1"><span class="n">1</span>Assign orders</button>
    <button data-stage="2"><span class="n">2</span>Review &amp; adjust</button>
    <button data-stage="3"><span class="n">3</span>Dispatch</button>
    <button data-stage="4"><span class="n">4</span>Live</button>
  </nav>
</div>
<div id="stp-ribbon" class="ribbon"></div>
<div id="stp-diff"></div>
<div class="stp-main" id="stp-main">
  <div id="stp-mapwrap">
    <div class="mapbar" id="stp-mapbar"></div>
    <div id="stp-map"></div>
    <div class="muted" id="stp-map-nopin" style="font-size:12px;margin-top:4px"></div>
  </div>
  <div id="stp-split" role="separator" aria-orientation="vertical" tabindex="0" title="Drag to resize the map and the table (double-click to reset)"></div>
  <section class="s1"><div id="stp-s1"></div></section>
  <section class="s2">
    <!-- order (user, 10 Nov 2026): Not on a team, the teams, the ISR cards, then the Checks at the very bottom -->
    <div class="panel" id="stp-tray" style="margin-top:10px"></div>
    <div class="teams" id="stp-teams"></div>
    <div class="panel isrtray" id="stp-isrtray" style="margin-top:10px"></div>
    <div class="panel checkspanel" style="margin-top:10px"><h2>Checks</h2><ul class="checks" id="stp-checks"></ul></div>
    <datalist id="stp-crews"></datalist>
  </section>
  <section class="s3" id="stp-s3" style="margin-top:12px"></section>
  <section class="s4" id="stp-s4" style="margin-top:12px"></section>
  <section class="s4 s4isr" id="stp-s4isr" style="margin-top:12px"></section>
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
window.addEventListener("hashchange", () => { if (!/^#\/stepper/.test(location.hash)){ haltPlay(); live.stop(); sync.flush().finally(() => sync.stop()); } });

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
