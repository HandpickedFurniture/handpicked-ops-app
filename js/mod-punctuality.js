/* Punctuality (#/punctuality). 18 Nov 2026 (user).
 *
 * How early or late each installation team arrives against the time the job was scheduled for.
 *   Punctuality30 = % of jobs where the team arrived no later than 30 min after the scheduled time.
 *   Punctuality60 = the same with 60 min.            (arriving early counts as punctual)
 * Each is reported for ALL orders and for each team's FIRST order of the day, overall and split by
 * vertical (Kurtains / Floorz), city and team, as line charts and a table by date.
 *
 * Source: three Tookan-export tabs of one Google Sheet, copied into punctuality_job by the
 * punctuality-sync Edge Function (every 3 h, and the Refresh button). The rules (which tasks count,
 * what "first order" means, p30 / p60) are in the SQL view v_punctuality, not here: this screen only
 * counts what the view says. See supabase/sql/20261118_punctuality.sql.
 */
import { apiAll, rpc, isSignedIn, isViewer } from "./api.js";
import { esc, el, toast, loading, fmtDateTime, downloadXlsx } from "./ui.js";

/* The reference categorical palette, in its fixed order (slot 1 blue, slot 2 orange, ...). Colour follows
 * the entity: Kurtains / Dubai are always slot 1, Floorz / Abu Dhabi slot 2, and a team keeps the slot it was
 * given for as long as it stays on the chart. */
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const FIXED = { Kurtains: 0, Floorz: 1, Dubai: 0, "Abu Dhabi": 1 };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_TEAMS = 8;

const short = (d) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;
const isoShift = (iso, d) => { const [y, m, x] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, x + d)).toISOString().slice(0, 10); };
const monday = (iso) => isoShift(iso, -((new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7));
const pc = (k, n, dec = 0) => (n ? (100 * k / n).toFixed(dec) + "%" : "–");
const pv = (k, n) => (n ? 100 * k / n : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let F = { preset: "all", from: "", to: "", vertical: "", city: "", by: "overall", pop: "all", measure: 30, gran: "day", teams: null, outcomes: null, sort: { col: "n", dir: -1 } };
let ROWS = [], RUN = null, SRCS = [], FIRST = "", LAST = "";
const SLOT = new Map();          // team id -> palette slot

export async function render(mount) {
  if (!isSignedIn()) return;
  mount.innerHTML = `<div class="sectionbar"><div class="subtabs"><a href="#/home">🏠 Home</a><button class="on">⏱ Punctuality</button></div></div><div id="pu"></div>`;
  await load();
  paint(mount.querySelector("#pu"));
}

async function load() {
  loading(true, "Loading punctuality…");
  try {
    const [rows, runs, srcs] = await Promise.all([
      apiAll("/rest/v1/v_punctuality?select=source,vertical,city,day,week,fleet_id,team,job_id,outcome,minutes_late,counted,p30,p60,first_order&order=day.asc,job_id.asc"),
      apiAll("/rest/v1/punctuality_sync_run?select=at,trigger,error&order=at.desc&limit=1"),
      apiAll("/rest/v1/punctuality_source?select=source,vertical,city,last_read_at,last_rows,last_error&order=source.asc"),
    ]);
    ROWS = rows || []; RUN = (runs || [])[0] || null; SRCS = srcs || [];
    FIRST = ROWS.length ? ROWS[0].day : ""; LAST = ROWS.length ? ROWS[ROWS.length - 1].day : "";
    applyPreset();
  } catch (e) { toast(e.message || String(e), "bad"); }
  loading(false);
}

/* Presets run back from the LAST day the sheets have, not from today: the sheets lag by a day. */
function applyPreset() {
  if (F.preset === "custom" && F.from) return;
  const n = F.preset === "7" ? 7 : F.preset === "30" ? 30 : 0;
  F.to = LAST;
  F.from = n && LAST ? (isoShift(LAST, -(n - 1)) < FIRST ? FIRST : isoShift(LAST, -(n - 1))) : FIRST;
}

const inScope = (r) => (!F.from || r.day >= F.from) && (!F.to || r.day <= F.to) && (!F.vertical || r.vertical === F.vertical) && (!F.city || r.city === F.city);
/* Outcome filter (user, 19 Nov 2026). Only outcomes that are COUNTED can be picked: Successful, Failed and
 * Arrived have a real arrival time, the rest are left out by the view whatever is ticked. F.outcomes is null
 * for "all"; otherwise the ticked ones. It narrows the counted jobs only, so the "left out" note is unchanged. */
const OUTCOME_ORDER = ["Successful", "Failed", "Arrived"];
const outcomeOptions = () => [...new Set(ROWS.filter((r) => r.counted && r.outcome).map((r) => r.outcome))]
  .sort((a, b) => ((OUTCOME_ORDER.indexOf(a) + 1) || 99) - ((OUTCOME_ORDER.indexOf(b) + 1) || 99) || a.localeCompare(b));
const outcomeOk = (r) => !F.outcomes || F.outcomes.includes(r.outcome);
const outcomeText = () => (F.outcomes ? F.outcomes.join(" + ") : "All");
const bucketOf = (r) => (F.gran === "week" ? (r.week || monday(r.day)) : r.day);
const bucketLabel = (b) => (F.gran === "week" ? "Wk " + short(b) : short(b));
const partWeek = (b) => F.gran === "week" && LAST && isoShift(b, 6) > LAST;     // the sheets stop before the week ends

function agg(rows) {
  const a = { n: 0, a30: 0, a60: 0, n1: 0, b30: 0, b60: 0 };
  for (const r of rows) {
    a.n++; if (r.p30) a.a30++; if (r.p60) a.a60++;
    if (r.first_order) { a.n1++; if (r.p30) a.b30++; if (r.p60) a.b60++; }
  }
  return a;
}

function paint(box) {
  const scoped = ROWS.filter(inScope);
  const counted = scoped.filter((r) => r.counted && outcomeOk(r));
  box.innerHTML = "";
  box.appendChild(filterCard(box));
  if (!ROWS.length) {
    box.appendChild(el(`<div class="card"><h4>No data yet</h4><div class="muted">${isViewer() ? "The sheets have not been read yet." : "The sheets have not been read yet - press “Refresh from sheets” above."}</div></div>`));
    return;
  }
  box.appendChild(statCard(counted));
  box.appendChild(viewCard(box, counted));
  const groups = groupsOf(counted);
  const chartRows = F.by === "overall" ? counted : popRows(counted);
  const buckets = [...new Set(chartRows.map(bucketOf))].sort();
  // The table by date comes first (user, 19 Nov 2026): straight after the Overall / By vertical / By city /
  // By team picker, then the charts, then the summary over the period.
  box.appendChild(dateCard(box, groups, counted, buckets));
  // The chart is drawn at the width it will be shown at, so its 11px labels stay 11px: scaling a fixed
  // 720-wide drawing down to a phone left them about 6px. Side by side only when there is room.
  const room = box.clientWidth || 800, two = room >= 1100;
  const W = Math.max(300, Math.min(900, Math.floor((two ? (room - 10) / 2 : room) - 36)));
  const charts = el(`<div class="pu-charts" style="display:grid;grid-template-columns:${two ? "1fr 1fr" : "1fr"};gap:10px"></div>`);
  for (const m of [30, 60]) {
    const series = chartSeries(groups, counted, buckets, m);
    charts.appendChild(lineChart(m, buckets, series, W));
  }
  box.appendChild(charts);
  box.appendChild(summaryCard(box, groups, counted));
  box.appendChild(notesCard(scoped));
}

/* ------------------------------------------------------------------ filters */
function filterCard(box) {
  const verticals = [...new Set(ROWS.map((r) => r.vertical))].sort();
  const cities = [...new Set(ROWS.map((r) => r.city))].sort();
  const bad = SRCS.filter((s) => s.last_error);
  const read = SRCS.map((s) => s.last_read_at).filter(Boolean).sort().pop();
  const opts = outcomeOptions();
  const inRange = ROWS.filter((r) => inScope(r) && r.counted);
  const nOf = (o) => inRange.filter((r) => r.outcome === o).length;
  const card = el(`<div class="card"><div class="fgrid">
    <div><label class="f">From</label><input type="date" name="from" value="${esc(F.from)}" min="${esc(FIRST)}" max="${esc(LAST)}"></div>
    <div><label class="f">to</label><input type="date" name="to" value="${esc(F.to)}" min="${esc(FIRST)}" max="${esc(LAST)}"></div>
    <div><label class="f">Vertical</label><select name="vertical"><option value="">All</option>${verticals.map((v) => `<option ${v === F.vertical ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></div>
    <div><label class="f">City</label><select name="city"><option value="">All</option>${cities.map((c) => `<option ${c === F.city ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
    <div><label class="f">Chart and table by</label><div class="seg" data-gran>
      <button data-g="day" class="${F.gran === "day" ? "on" : ""}">Day</button><button data-g="week" class="${F.gran === "week" ? "on" : ""}">Week</button></div></div></div>
    <div style="margin-top:8px"><label class="f">Outcome <span class="muted" style="font-weight:400">(tick one or more)</span></label><div class="seg" data-out>
      <button data-o="" class="${F.outcomes ? "" : "on"}">All <span style="opacity:.7">${inRange.length}</span></button>
      ${opts.map((o) => `<button data-o="${esc(o)}" class="${F.outcomes && F.outcomes.includes(o) ? "on" : ""}" title="Jobs with outcome ${esc(o)} that have an arrival time">${esc(o)} <span style="opacity:.7">${nOf(o)}</span></button>`).join("")}</div></div>
    <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center">
      <button class="btn sm ${F.preset === "7" ? "accent" : ""}" data-p="7">Last 7 days</button>
      <button class="btn sm ${F.preset === "30" ? "accent" : ""}" data-p="30">Last 30 days</button>
      <button class="btn sm ${F.preset === "all" ? "accent" : ""}" data-p="all">All data</button>
      <span class="muted" style="font-size:12px;margin-left:auto">${LAST ? `Sheets run to ${esc(short(LAST))} · ` : ""}${read ? `read ${esc(fmtDateTime(read))}` : "not read yet"} · every 3 h</span>
      ${isViewer() ? "" : `<button class="btn sm" data-refresh>↻ Refresh from sheets</button>`}</div>
    ${bad.length ? `<div style="font-size:12px;color:#9a5b00;margin-top:6px">⚠ ${bad.map((s) => esc(`${s.vertical} ${s.city}: ${s.last_error}`)).join(" · ")}</div>` : ""}</div>`);
  card.querySelectorAll("input[type=date]").forEach((i) => i.addEventListener("change", () => { F[i.name] = i.value; F.preset = "custom"; paint(box); }));
  card.querySelectorAll("select").forEach((s) => s.addEventListener("change", () => { F[s.name] = s.value; paint(box); }));
  // Nothing ticked = all. Ticking narrows to the ticked ones, so a first click on "Failed" means "only Failed",
  // a second on "Arrived" means "Failed and Arrived", and un-ticking the last one goes back to all.
  card.querySelectorAll("[data-o]").forEach((b) => b.addEventListener("click", () => {
    const o = b.dataset.o;
    if (!o) F.outcomes = null;
    else {
      const cur = F.outcomes || [];
      const next = cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o];
      F.outcomes = !next.length || next.length === opts.length ? null : opts.filter((x) => next.includes(x));
    }
    paint(box);
  }));
  card.querySelectorAll("[data-g]").forEach((b) => b.addEventListener("click", () => { F.gran = b.dataset.g; paint(box); }));
  card.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => { F.preset = b.dataset.p; applyPreset(); paint(box); }));
  const rf = card.querySelector("[data-refresh]");
  if (rf) rf.addEventListener("click", () => refresh(rf, box));
  return card;
}

/* The sync runs in the cloud and answers a few seconds later: ask, then wait for a new run row. */
async function refresh(btn, box) {
  const before = RUN ? RUN.at : null;
  btn.disabled = true; btn.textContent = "Reading the sheets…";
  try {
    await rpc("fn_punct_run_sync", { p_trigger: "button" });
    for (let i = 0; i < 16; i++) {
      await sleep(3000);
      const runs = await apiAll("/rest/v1/punctuality_sync_run?select=at,trigger,error&order=at.desc&limit=1");
      if (runs[0] && runs[0].at !== before) {
        await load(); paint(box);
        toast(runs[0].error ? "Read with a problem: " + String(runs[0].error).slice(0, 120) : "Sheets read - up to date", runs[0].error ? "bad" : "ok");
        return;
      }
    }
    toast("The sheets are still being read - try again in a minute", "bad");
  } catch (e) { toast(e.message || String(e), "bad"); }
  btn.disabled = false; btn.textContent = "↻ Refresh from sheets";
}

/* ------------------------------------------------------------------ headline numbers */
function statCard(counted) {
  const a = agg(counted);
  const tile = (n, l, sub) => `<div class="stat"><span class="sn">${n}</span><span class="sl">${l}</span>${sub ? `<div class="muted" style="font-size:11px;margin-top:2px">${sub}</div>` : ""}</div>`;
  return el(`<div class="card statrow" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
    ${tile(a.n.toLocaleString("en-GB"), "jobs counted", `${a.n1.toLocaleString("en-GB")} of them a first order${F.outcomes ? ` · only ${esc(outcomeText())}` : ""}`)}
    ${tile(pc(a.a30, a.n, 1), "Punctuality30 · all orders", `${a.a30} of ${a.n} within 30 min`)}
    ${tile(pc(a.b30, a.n1, 1), "Punctuality30 · first order", `${a.b30} of ${a.n1} · ${delta(pv(a.b30, a.n1), pv(a.a30, a.n))}`)}
    ${tile(pc(a.a60, a.n, 1), "Punctuality60 · all orders", `${a.a60} of ${a.n} within 60 min`)}
    ${tile(pc(a.b60, a.n1, 1), "Punctuality60 · first order", `${a.b60} of ${a.n1} · ${delta(pv(a.b60, a.n1), pv(a.a60, a.n))}`)}</div>`);
}
function delta(first, all) {
  if (first == null || all == null) return "";
  const d = Math.round((first - all) * 10) / 10;
  return d === 0 ? "same as all orders" : `${d > 0 ? "+" : "−"}${Math.abs(d)} pts vs all orders`;
}

/* ------------------------------------------------------------------ breakdown picker */
const BYS = [["overall", "Overall"], ["vertical", "By vertical"], ["city", "By city"], ["team", "By team"]];

function viewCard(box, counted) {
  const card = el(`<div class="card"><div class="row" style="gap:12px;flex-wrap:wrap;align-items:center">
    <div class="seg" data-by>${BYS.map(([k, l]) => `<button data-k="${k}" class="${F.by === k ? "on" : ""}">${l}</button>`).join("")}</div>
    ${F.by === "overall" ? `<span class="muted" style="font-size:12px">Each chart compares all orders with each team's first order of the day.</span>` : `
    <div class="row" style="gap:6px;align-items:center"><span class="muted" style="font-size:12px">Orders:</span><div class="seg" data-pop>
      <button data-k="all" class="${F.pop === "all" ? "on" : ""}">All orders</button><button data-k="first" class="${F.pop === "first" ? "on" : ""}">First order of the day</button></div></div>`}</div>
    ${F.by === "team" ? `<div data-chips style="margin-top:10px"></div>` : ""}</div>`);
  // Every view keeps the Day / Week choice as it is. (Teams used to open by week on their own, because one
  // team does only 1-4 jobs a day and its daily line jumps; the user wanted by date, 20 Nov 2026.)
  card.querySelectorAll("[data-by] button").forEach((b) => b.addEventListener("click", () => { F.by = b.dataset.k; paint(box); }));
  card.querySelectorAll("[data-pop] button").forEach((b) => b.addEventListener("click", () => { F.pop = b.dataset.k; paint(box); }));
  const chips = card.querySelector("[data-chips]");
  if (chips) {
    const groups = groupsOf(counted);
    const sel = selectedTeams(groups);
    chips.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:6px">On the chart (up to ${MAX_TEAMS}) - the tables below always list every team.${F.gran === "day" ? " A team does only 1-4 jobs a day, so a daily line can jump between 0% and 100%; Week (top) shows the trend." : ""}</div>
      <div class="seg">${groups.map((g) => {
        const on = sel.includes(g.id), c = on ? PALETTE[SLOT.get(g.id)] : "transparent";
        return `<button data-team="${esc(g.id)}" class="${on ? "on" : ""}" title="${g.n} jobs counted"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};border:1.5px solid ${on ? "#fff" : "#8aa0ab"};margin-right:6px"></span>${esc(g.name)} <span style="opacity:.7">${g.n}</span></button>`;
      }).join("")}</div>`;
    chips.querySelectorAll("[data-team]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.team, cur = selectedTeams(groups);
      if (cur.includes(id)) { F.teams = cur.filter((x) => x !== id); SLOT.delete(id); }
      else if (cur.length >= MAX_TEAMS) { toast(`Up to ${MAX_TEAMS} teams on the chart - take one off first`, "bad"); return; }
      else F.teams = [...cur, id];
      paint(box);
    }));
  }
  return card;
}

/* ------------------------------------------------------------------ grouping */
const popRows = (rows) => (F.pop === "first" ? rows.filter((r) => r.first_order) : rows);

function groupsOf(counted) {
  if (F.by === "overall") return [{ id: "all", name: "All teams", n: counted.length, rows: counted }];
  const key = F.by === "vertical" ? (r) => r.vertical : F.by === "city" ? (r) => r.city : (r) => r.fleet_id;
  const label = F.by === "team" ? (r) => `${r.team || r.fleet_id} · ${r.city}` : (r) => key(r);
  const m = new Map();
  for (const r of counted) {
    const k = key(r);
    if (k == null || k === "") continue;
    if (!m.has(k)) m.set(k, { id: String(k), name: label(r), n: 0, rows: [] });
    const g = m.get(k); g.rows.push(r); g.n++;
  }
  const gs = [...m.values()];
  if (F.by === "team") gs.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  else gs.sort((a, b) => (FIXED[a.name] ?? 9) - (FIXED[b.name] ?? 9) || a.name.localeCompare(b.name));
  return gs;
}

/* The teams drawn on the chart: the ones picked, else the five busiest. A team keeps its colour while it
 * stays selected; a newcomer takes the first colour nobody else on the chart is using. */
function selectedTeams(groups) {
  const ids = new Set(groups.map((g) => g.id));
  // never touched, or every team picked earlier is out of the current filters: the five busiest.
  // Picked and then all taken off by hand (an empty list) is respected: an empty chart.
  const stale = F.teams === null || (F.teams.length > 0 && !F.teams.some((id) => ids.has(id)));
  const sel = stale ? groups.slice(0, 5).map((g) => g.id) : F.teams.filter((id) => ids.has(id)).slice(0, MAX_TEAMS);
  const taken = new Set();
  sel.forEach((id) => { const s = SLOT.get(id); if (s != null && !taken.has(s)) taken.add(s); else SLOT.delete(id); });
  sel.forEach((id) => {
    if (SLOT.get(id) != null) return;
    let s = 0; while (taken.has(s)) s++;
    SLOT.set(id, s); taken.add(s);
  });
  return sel;
}

function colourOf(g) {
  if (F.by === "team") return PALETTE[SLOT.get(g.id)];
  return PALETTE[FIXED[g.name] ?? 0];
}

/* ------------------------------------------------------------------ chart */
function mkSeries(name, color, dash, rows, buckets, measure) {
  const by = new Map();
  for (const r of rows) {
    const b = bucketOf(r);
    let a = by.get(b); if (!a) by.set(b, (a = { n: 0, k: 0 }));
    a.n++; if (measure === 30 ? r.p30 : r.p60) a.k++;
  }
  return { name, color, dash, pts: buckets.map((b) => { const a = by.get(b); return a ? { n: a.n, k: a.k, v: 100 * a.k / a.n } : { n: 0, k: 0, v: null }; }) };
}

function chartSeries(groups, counted, buckets, measure) {
  if (F.by === "overall") {
    return [mkSeries("All orders", PALETTE[0], "", counted, buckets, measure),
            mkSeries("First order", PALETTE[1], "6 4", counted.filter((r) => r.first_order), buckets, measure)];
  }
  const sel = F.by === "team" ? selectedTeams(groups) : null;
  const use = sel ? groups.filter((g) => sel.includes(g.id)) : groups;
  return use.map((g) => mkSeries(g.name, colourOf(g), "", popRows(g.rows), buckets, measure));
}

function lineChart(measure, buckets, series, W) {
  const direct = series.length >= 2 && series.length <= 4 && W >= 520;   // too narrow for names at the line ends: legend only
  const H = W < 500 ? 220 : 250, L = 40, R = direct ? 112 : 16, T = 14, B = 30;
  const m = buckets.length;
  const x = (i) => L + (m < 2 ? (W - L - R) / 2 : (i * (W - L - R)) / (m - 1));
  const y = (v) => T + (H - T - B) * (1 - v / 100);
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e6ecef" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="lbl">${v}%</text>`).join("");
  const every = Math.max(1, Math.ceil(m / (W < 500 ? 5 : 8)));      // fewer date labels on a phone so they do not touch
  const xl = buckets.map((b, i) => ((i % every === 0 && (m - 1 - i >= every * 0.6 || i === m - 1)) || i === m - 1)
    ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="lbl">${esc(bucketLabel(b))}</text>` : "").join("");

  let paths = "", dots = "";
  for (const s of series) {
    let seg = [];
    const flush = () => {
      if (seg.length >= 2) paths += `<path d="${seg.map((p, j) => `${j ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join("")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
      seg = [];
    };
    s.pts.forEach((p, i) => {
      if (p.v == null) { flush(); return; }
      seg.push({ i, v: p.v });
      // a day with fewer than 3 jobs is a thin sample: hollow marker. A lone point has no line, so it always gets one.
      if (p.n < 3) dots += `<circle cx="${x(i)}" cy="${y(p.v)}" r="3.5" fill="#fff" stroke="${s.color}" stroke-width="1.8"/>`;
    });
    flush();
    s.pts.forEach((p, i) => {
      if (p.v != null && p.n >= 3 && (s.pts[i - 1]?.v == null) && (s.pts[i + 1]?.v == null)) dots += `<circle cx="${x(i)}" cy="${y(p.v)}" r="3.5" fill="${s.color}" stroke="#fff" stroke-width="2"/>`;
    });
  }

  // names at the line ends (4 series or fewer), pushed apart so they never overprint
  let ends = "";
  if (direct) {
    const lab = series.map((s) => { let li = -1; s.pts.forEach((p, i) => { if (p.v != null) li = i; }); return li >= m - 3 && li >= 0 ? { s, y: y(s.pts[li].v) } : null; }).filter(Boolean).sort((a, b) => a.y - b.y);
    for (let i = 1; i < lab.length; i++) if (lab[i].y - lab[i - 1].y < 14) lab[i].y = lab[i - 1].y + 14;
    ends = lab.map((q) => `<line x1="${W - R + 6}" x2="${W - R + 18}" y1="${q.y}" y2="${q.y}" stroke="${q.s.color}" stroke-width="2"${q.s.dash ? ` stroke-dasharray="${q.s.dash}"` : ""}/>
      <text x="${W - R + 22}" y="${q.y + 4}" class="lbl" style="fill:#2b3a42">${esc(q.s.name.length > 14 ? q.s.name.slice(0, 13) + "…" : q.s.name)}</text>`).join("");
  }

  const legend = series.length >= 2 ? `<div class="row" style="gap:14px;flex-wrap:wrap;font-size:12px;margin:2px 0 4px">${series.map((s) =>
    `<span style="display:inline-flex;align-items:center;gap:6px"><svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" stroke="${s.color}" stroke-width="2.5"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/></svg>${esc(s.name)}</span>`).join("")}</div>` : "";
  const popTxt = F.by === "overall" ? "all orders vs first order of the day" : F.pop === "first" ? "first order of the day" : "all orders";
  const card = el(`<div class="card"><div class="spread" style="margin-bottom:2px;flex-wrap:wrap;gap:4px"><h4>Punctuality${measure}</h4>
      <span class="muted" style="font-size:12px">% of jobs arriving within ${measure} min · ${esc(popTxt)}</span></div>${legend}
    <div style="position:relative">
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Punctuality${measure} by ${F.gran}" xmlns="http://www.w3.org/2000/svg" style="touch-action:pan-y">
        ${grid}${xl}${paths}${dots}${ends}
        <line data-cx y1="${T}" y2="${H - B}" stroke="#8aa0ab" stroke-width="1" visibility="hidden"/>
        <g data-hover></g>
        <rect data-hit x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
      </svg>
      <div data-tip class="card" style="position:absolute;pointer-events:none;display:none;padding:7px 10px;font-size:12px;white-space:nowrap;margin:0;box-shadow:0 2px 8px rgba(0,0,0,.12);z-index:3"></div>
    </div>
    <div class="muted" style="font-size:11px">Hollow dot = fewer than 3 jobs in that ${F.gran}. Lines break where a group had no jobs. The table below has every value.</div></div>`);
  const svg = card.querySelector("svg.chart"), tip =card.querySelector("[data-tip]"), cx = card.querySelector("[data-cx]"), hov = card.querySelector("[data-hover]");
  const move = (ev) => {
    const b = svg.getBoundingClientRect(), px = ((ev.clientX - b.left) / b.width) * W;
    const i = Math.max(0, Math.min(m - 1, Math.round(((px - L) / (W - L - R)) * (m - 1))));
    cx.setAttribute("x1", x(i)); cx.setAttribute("x2", x(i)); cx.setAttribute("visibility", "visible");
    hov.innerHTML = series.map((s) => (s.pts[i].v == null ? "" : `<circle cx="${x(i)}" cy="${y(s.pts[i].v)}" r="5" fill="${s.color}" stroke="#fff" stroke-width="2"/>`)).join("");
    const rowsHtml = series.map((s) => {
      const p = s.pts[i];
      return `<div style="display:flex;align-items:center;gap:7px;margin-top:3px"><svg width="14" height="6" aria-hidden="true"><line x1="0" x2="14" y1="3" y2="3" stroke="${s.color}" stroke-width="2.5"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/></svg>
        <b style="min-width:34px">${p.v == null ? "–" : Math.round(p.v) + "%"}</b><span class="muted">${esc(s.name)}${p.n ? ` · ${p.k} of ${p.n}` : " · no jobs"}</span></div>`;
    }).join("");
    tip.innerHTML = `<b>${esc(F.gran === "week" ? "Week of " + short(buckets[i]) + (partWeek(buckets[i]) ? " (so far)" : "") : short(buckets[i]))}</b>${rowsHtml}`;
    tip.style.display = "block";
    const left = (x(i) / W) * b.width;
    tip.style.left = Math.min(Math.max(0, left + 12), Math.max(0, b.width - tip.offsetWidth)) + "px";
    tip.style.top = "6px";
  };
  const hide = () => { tip.style.display = "none"; cx.setAttribute("visibility", "hidden"); hov.innerHTML = ""; };
  const hit = card.querySelector("[data-hit]");
  if (m) { hit.addEventListener("pointermove", move); hit.addEventListener("pointerleave", hide); }
  return card;
}

/* ------------------------------------------------------------------ summary over the period */
function summaryRows(groups, counted) {
  const row = (name, rows) => {
    const a = agg(rows);
    return { name, n: a.n, p30: pv(a.a30, a.n), p60: pv(a.a60, a.n), n1: a.n1, f30: pv(a.b30, a.n1), f60: pv(a.b60, a.n1), a, d30: pv(a.b30, a.n1) != null && pv(a.a30, a.n) != null ? pv(a.b30, a.n1) - pv(a.a30, a.n) : null };
  };
  return { rows: groups.map((g) => row(g.name, g.rows)), total: row(F.by === "overall" ? "All teams" : "All in view", counted) };
}

function summaryCard(box, groups, counted) {
  const { rows, total } = summaryRows(groups, counted);
  const col = F.sort.col, dir = F.sort.dir;
  if (F.by !== "overall") rows.sort((a, b) => {
    if (col === "name") return dir * a.name.localeCompare(b.name);
    const x = a[col], y = b[col];
    if (x == null && y == null) return 0;
    if (x == null) return 1; if (y == null) return -1;      // nothing to rank always sinks to the bottom
    return dir * (x - y);
  });
  const bar = (v) => (v == null ? "" : `background:linear-gradient(90deg,rgba(62,125,150,.20) ${v.toFixed(1)}%,transparent ${v.toFixed(1)}%)`);
  const pcell = (v, k, n) => `<td class="num" style="text-align:left;${bar(v)}" title="${n ? `${k} of ${n}` : "no jobs"}">${v == null ? "–" : v.toFixed(1) + "%"}</td>`;
  const dcell = (d) => `<td class="num">${d == null ? "–" : `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d).toFixed(1)}`}</td>`;
  const th = (k, l, cls = "num") => `<th class="${cls}" ${F.by === "overall" ? "" : `data-sort="${k}" style="cursor:pointer;white-space:nowrap"`}>${l}${col === k && F.by !== "overall" ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`;
  const line = (r) => `<td><b>${esc(r.name)}</b></td><td class="num">${r.n}</td>${pcell(r.p30, r.a.a30, r.n)}${pcell(r.p60, r.a.a60, r.n)}<td class="num">${r.n1}</td>${pcell(r.f30, r.a.b30, r.n1)}${pcell(r.f60, r.a.b60, r.n1)}${dcell(r.d30)}`;
  const title = { overall: "Overall", vertical: "By vertical", city: "By city", team: "By team" }[F.by];
  const card = el(`<div class="card"><div class="spread" style="margin-bottom:6px"><h4>${title}, ${esc(short(F.from))} – ${esc(short(F.to))}</h4>
      <button class="btn sm" data-xlsx>⬇ Excel (everything)</button></div>
    <div class="scrollx"><table class="dense report"><thead>
      <tr><th rowspan="2">${F.by === "team" ? "Team" : F.by === "overall" ? "" : F.by === "vertical" ? "Vertical" : "City"}</th><th class="num" rowspan="2" ${F.by === "overall" ? "" : `data-sort="n" style="cursor:pointer"`}>Jobs${col === "n" && F.by !== "overall" ? (dir > 0 ? " ▲" : " ▼") : ""}</th>
        <th class="num" colspan="2" style="text-align:center">All orders</th><th class="num" colspan="4" style="text-align:center">First order of the day</th></tr>
      <tr>${th("p30", "Punctuality30")}${th("p60", "Punctuality60")}${th("n1", "Jobs")}${th("f30", "Punctuality30")}${th("f60", "Punctuality60")}${th("d30", "30-min gap, pts")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${line(r)}</tr>`).join("") || `<tr><td colspan="8" class="muted">No counted jobs in this range.</td></tr>`}</tbody>
    ${F.by === "overall" ? "" : `<tfoot><tr>${line(total).replace(/<td class="num" style="[^"]*"/g, '<td class="num" style="text-align:left"')}</tr></tfoot>`}</table></div>
    <div class="muted" style="font-size:12px;margin-top:6px">“30-min gap” = first-order Punctuality30 minus all-orders Punctuality30: negative means a team's first job of the day is the less punctual one. Hover a figure for the counts behind it.</div></div>`);
  card.querySelectorAll("[data-sort]").forEach((h) => h.addEventListener("click", () => {
    const k = h.dataset.sort;
    F.sort = { col: k, dir: F.sort.col === k ? -F.sort.dir : (k === "name" ? 1 : -1) };
    paint(box);
  }));
  card.querySelector("[data-xlsx]").addEventListener("click", () => exportXlsx(groups, counted));
  return card;
}

/* ------------------------------------------------------------------ table by date */
function dateCard(box, groups, counted, buckets) {
  const desc = [...buckets].reverse();
  const bucketTitle = (b) => (F.gran === "week" ? "Week of " + short(b) + (partWeek(b) ? " (so far)" : "") : short(b));
  let head, body;
  if (F.by === "overall") {
    const by = new Map();
    counted.forEach((r) => { const b = bucketOf(r); if (!by.has(b)) by.set(b, []); by.get(b).push(r); });
    head = `<tr><th rowspan="2">${F.gran === "week" ? "Week" : "Date"}</th><th class="num" rowspan="2">Jobs</th><th class="num" colspan="2" style="text-align:center">All orders</th><th class="num" colspan="3" style="text-align:center">First order of the day</th></tr>
      <tr><th class="num">Punctuality30</th><th class="num">Punctuality60</th><th class="num">Jobs</th><th class="num">Punctuality30</th><th class="num">Punctuality60</th></tr>`;
    body = desc.map((b) => {
      const a = agg(by.get(b) || []);
      const c = (k, n) => `<td class="num" title="${n ? `${k} of ${n}` : "no jobs"}">${pc(k, n)}</td>`;
      return `<tr><td style="white-space:nowrap"><b>${esc(bucketTitle(b))}</b></td><td class="num">${a.n}</td>${c(a.a30, a.n)}${c(a.a60, a.n)}<td class="num">${a.n1 || ""}</td>${c(a.b30, a.n1)}${c(a.b60, a.n1)}</tr>`;
    }).join("");
  } else {
    const cols = [{ name: "All", rows: counted }, ...groups.map((g) => ({ name: g.name, rows: g.rows }))].map((c) => {
      const rows = popRows(c.rows), by = new Map();
      rows.forEach((r) => { const b = bucketOf(r); if (!by.has(b)) by.set(b, { n: 0, k: 0 }); const a = by.get(b); a.n++; if (F.measure === 30 ? r.p30 : r.p60) a.k++; });
      return { name: c.name, by };
    });
    head = `<tr><th style="position:sticky;left:0;background:#fff;z-index:1">${F.gran === "week" ? "Week" : "Date"}</th>${cols.map((c) => `<th class="num" style="white-space:nowrap">${esc(c.name)}</th>`).join("")}</tr>`;
    body = desc.map((b) => `<tr><td style="white-space:nowrap;position:sticky;left:0;background:#fff;z-index:1"><b>${esc(bucketTitle(b))}</b></td>${cols.map((c) => {
      const a = c.by.get(b);
      return a ? `<td class="num" title="${a.k} of ${a.n}"><b>${pc(a.k, a.n)}</b><div class="muted" style="font-size:10px">${a.k}/${a.n}</div></td>` : `<td class="num muted">·</td>`;
    }).join("")}</tr>`).join("");
  }
  const card = el(`<div class="card"><div class="spread" style="margin-bottom:6px;flex-wrap:wrap;gap:8px"><h4>By ${F.gran === "week" ? "week" : "date"}</h4>
      ${F.by === "overall" ? "" : `<div class="row" style="gap:6px;align-items:center"><span class="muted" style="font-size:12px">Show:</span><div class="seg" data-m>
        <button data-k="30" class="${F.measure === 30 ? "on" : ""}">Punctuality30</button><button data-k="60" class="${F.measure === 60 ? "on" : ""}">Punctuality60</button></div>
        <span class="muted" style="font-size:12px">· ${F.pop === "first" ? "first order of the day" : "all orders"}</span></div>`}</div>
    <div class="scrollx"><table class="dense report"><thead>${head}</thead><tbody>${body || `<tr><td colspan="8" class="muted">No counted jobs in this range.</td></tr>`}</tbody></table></div>
    <div class="muted" style="font-size:12px;margin-top:6px">Newest first. Each % is jobs on time ÷ jobs counted; “·” = that group had no counted job.</div></div>`);
  card.querySelectorAll("[data-m] button").forEach((b) => b.addEventListener("click", () => { F.measure = Number(b.dataset.k); paint(box); }));
  return card;
}

/* ------------------------------------------------------------------ Excel: everything, long format */
function exportXlsx(groups, counted) {
  const buckets = [...new Set(counted.map(bucketOf))].sort();
  const num = (k, n) => (n ? Math.round(1000 * k / n) / 10 : "");
  const sets = [{ name: "All", rows: counted }, ...(F.by === "overall" ? [] : groups.map((g) => ({ name: g.name, rows: g.rows })))];
  const by = { overall: "Overall", vertical: "Vertical", city: "City", team: "Team" }[F.by];
  const long = [];
  for (const b of buckets) for (const s of sets) {
    const a = agg(s.rows.filter((r) => bucketOf(r) === b));
    if (!a.n) continue;
    long.push({ [F.gran === "week" ? "Week starting" : "Date"]: b, [by === "Overall" ? "Group" : by]: s.name, "Jobs": a.n, "Punctuality30 %": num(a.a30, a.n), "Punctuality60 %": num(a.a60, a.n),
      "First-order jobs": a.n1, "First-order Punctuality30 %": num(a.b30, a.n1), "First-order Punctuality60 %": num(a.b60, a.n1) });
  }
  const sum = sets.map((s) => { const a = agg(s.rows); return { [by === "Overall" ? "Group" : by]: s.name, "Outcomes counted": outcomeText(), "Jobs": a.n, "Punctuality30 %": num(a.a30, a.n), "Punctuality60 %": num(a.a60, a.n),
    "First-order jobs": a.n1, "First-order Punctuality30 %": num(a.b30, a.n1), "First-order Punctuality60 %": num(a.b60, a.n1) }; });
  downloadXlsx(`punctuality_${F.by}_${F.from}_to_${F.to}.xlsx`, [{ name: "Summary", rows: sum }, { name: F.gran === "week" ? "By week" : "By date", rows: long.length ? long : [{ note: "No counted jobs in this range" }] }])
    .catch((e) => toast(e.message || String(e), "bad"));
}

/* ------------------------------------------------------------------ definitions + what was left out */
function notesCard(scoped) {
  const skipped = new Map();
  scoped.filter((r) => !r.counted).forEach((r) => skipped.set(r.outcome || "no outcome", (skipped.get(r.outcome || "no outcome") || 0) + 1));
  const left = [...skipped.entries()].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${n} ${o.toLowerCase()}`).join(", ");
  return el(`<div class="card"><details><summary style="cursor:pointer"><b>How this is counted</b></summary>
    <ul style="margin:8px 0 0 18px;padding:0;font-size:13px;line-height:1.5">
      <li><b>A job counts</b> when the team reached site: outcome <i>Successful</i>, <i>Failed</i> or <i>Arrived</i>, with an arrival time.</li>
      <li><b>Left out${left ? " in this range" : ""}:</b> ${esc(left || "nothing")}. Declined, assigned, accepted and started have no arrival time yet; cancelled jobs carry an “arrived” time that is not a site arrival (many are hours off), and the sheet itself does not treat them as visits.</li>
      <li><b>Outcome filter:</b> only Successful, Failed and Arrived can be picked, because only they have a real arrival time. Tick one or more to narrow every tile, chart and table to those outcomes; nothing ticked means all three.</li>
      <li><b>Punctuality30 / Punctuality60</b> = jobs where the arrival was no more than 30 / 60 minutes after the scheduled time, ÷ jobs counted. Arriving early counts as on time. The minutes come from the sheet's <i>minutes_late</i>, which compares full date-times (so a task marked arrived days later is correctly very late).</li>
      <li><b>First order</b> = the team's first job of the day (the sheet's <i>first_visit</i>; jobs booked at the same earliest time all count). It measures whether a team starts its day on time, free of delays carried over from earlier jobs.</li>
      <li><b>Teams</b> are Tookan agents tidied to T1, T2…: “Ejaz Ahmad” is Team 5. Dubai T1 and Abu Dhabi T1 are different agents, so they are different teams.</li>
      <li><b>Small numbers:</b> one team's single day is often 1-4 jobs, so a daily line can jump between 0% and 100%; use Week for a steadier picture.</li>
    </ul>
    <div class="muted" style="font-size:12px;margin-top:8px">Data: ${SRCS.map((s) => `${esc(s.vertical)} ${esc(s.city)} ${s.last_rows != null ? Number(s.last_rows).toLocaleString("en-GB") + " tasks" : "not read"}`).join(" · ")}</div></details></div>`);
}
