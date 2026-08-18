/* Module 3 - Schedule.
 *
 * Builds the next working day's installation plan: one column per team, cards in arrival order,
 * travel time and distance shown between them. A pg_cron job builds a draft at 18:30 Dubai every
 * day, so a coordinator normally arrives to a plan already made and only adjusts it.
 *
 * Everything numeric comes from the database. fn_sched_build assigns, fn_sched_retime computes every
 * time and travel leg, and this file never recalculates either - after a drag it calls the server
 * and repaints from the answer. A JS reimplementation of the travel maths would drift from the
 * engine within days, and then the board and the WhatsApp message would disagree about when a team
 * is due.
 *
 * The one place the app's re-render-everything convention bends is the board itself: a full
 * render() per drag is unusable on a phone, so edits mutate a module-level model and repaint only
 * #schboard. Any error falls back to the house toast + full reload.
 */
import { api, rpc, isSignedIn, isViewer, currentActor, accessToken } from "./api.js";
import { tr, getLang } from "./i18n.js";
import { UTIL_BANDS, STOP_TAGS, SB_URL, SB_KEY } from "./config.js";
import { $, esc, el, num, chip, fmtDate, toast, loading, modal, confirmSheet, orderLabel } from "./ui.js";
import { micField, wireMics } from "./voice.js";
import { syncBar, lastSync, syncBarHtml } from "./sync.js";
import { dragBoard } from "./board.js";

let MODEL = null;          // the board payload, mutated in place between repaints
let MOUNT = null;
let INSTRUCTION = { text: "", method: null };

/* Card chips. Emoji rather than SVG, matching the rest of the app. */
const TAG_ICON = { new: "🆕", issue: "🔧", alteration: "✂️", manual: "✍️" };
const WARN_ICON = {
  geo_anomaly: "⚠️", crew_short: "👥", scaffolding: "🧗",
  no_po_lines: "❓", no_eligible_team: "🚫", overruns_day: "🌙",
};

/* check_i18n.py scrapes translation keys with a regex over literal string arguments, so passing a
 * concatenated key inline would be read as the bare prefix and fail the parity check. Composing the
 * key here keeps the scraper honest; the suffixed keys then land in its "defined but never
 * referenced" note, which is a note rather than a failure. */
const trSuffix = (prefix, suffix) => tr(prefix + "." + suffix);

const setParam = (k, v) => {
  const [path, q] = String(location.hash || "#/schedule").split("?");
  const p = new URLSearchParams(q || "");
  if (v === null || v === undefined || v === "") p.delete(k); else p.set(k, v);
  location.hash = path.replace(/^#/, "") + (p.toString() ? "?" + p.toString() : "");
};

const mins = (m) => {
  const n = Math.round(Number(m) || 0);
  return n >= 60 ? `${Math.floor(n / 60)}h ${n % 60 ? (n % 60) + "m" : ""}`.trim() : `${n}m`;
};
const hhmm = (t) => (t ? String(t).slice(0, 5) : "—");

/* ------------------------------------------------------------------ render */

export async function render(mount, state) {
  if (!isSignedIn()) return;
  MOUNT = mount;

  let date = state.params.get("date");
  if (!date) {
    try { date = await rpc("fn_sched_next_working_day", {}); } catch (e) { date = null; }
    if (!date) date = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
  }

  mount.innerHTML = `
    <div class="sectionbar"><span></span><span id="schsync"></span></div>
    <div class="card schhead">
      <div class="schdate">
        <button class="btn ghost sm" id="schprev" title="${esc(tr("sch.prev"))}">◀</button>
        <div class="schdateinner">
          <div class="schdatelabel">${esc(tr("sch.for"))}</div>
          <div class="schdatebig" id="schbig">${esc(fmtDate(date))}</div>
          <input type="date" id="schpick" value="${esc(date)}">
        </div>
        <button class="btn ghost sm" id="schnext" title="${esc(tr("sch.next"))}">▶</button>
      </div>
      <div id="schver" class="schver"></div>
    </div>
    <div id="schactions"></div>
    <div id="schsummary"></div>
    <div id="schkit"></div>
    <div id="schfloatwrap"></div>
    <div id="schboard" class="schboard"></div>`;

  $("#schsync", mount).appendChild(syncBar());
  $("#schprev", mount).addEventListener("click", () => shiftDate(date, -1));
  $("#schnext", mount).addEventListener("click", () => shiftDate(date, 1));
  $("#schpick", mount).addEventListener("change", (e) => setParam("date", e.target.value));

  loading(true, tr("t.loading"));
  let runId = state.params.get("run");
  try {
    if (!runId) runId = await rpc("fn_sched_run_for", { p_date: date });
    MODEL = runId ? await rpc("fn_sched_board", { p_run_id: Number(runId) }) : null;
  } catch (e) {
    loading(false);
    $("#schboard", mount).innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  paintActions(date);
  paintVersions(date);
  paintSummary();
  paintKit(date);
  paintFloating();
  paintBoard();
}

/* Bend rail, motors and scaffolding for THIS date's orders.
 *
 * Singled out from the twenty special requirements because these three are the ones that stop an
 * installation dead if nobody noticed them the day before: a bent rail is ordered days ahead, a
 * motor has to be in the van, scaffolding has to be booked. The rest can be dealt with on site.
 *
 * It lives here rather than on Production because the question it answers is "what do we need for
 * tomorrow" - which is a question about a DATE, and Production lists every open order regardless of
 * when it installs. There, the same panel counted 43 bend rails across months of work, which is not
 * a number anybody can act on. */
const KIT_COLS = [
  { col: "n_bend_rail",   key: "sp.bend" },
  { col: "n_motor",       key: "sp.motor" },
  { col: "n_scaffolding", key: "sp.scaffolding" },
];

async function paintKit(date) {
  const host = $("#schkit", MOUNT);
  if (!host) return;
  let rows = [];
  try {
    rows = await api("/rest/v1/v_ops_order_roster"
      + `?select=order_id,customer_name,city,${KIT_COLS.map((k) => k.col).join(",")}`
      + `&installation_date=eq.${encodeURIComponent(date)}`
      + `&or=(${KIT_COLS.map((k) => `${k.col}.gt.0`).join(",")})`);
  } catch (e) { return; }        // the board matters more than this strip
  if (!rows.length) return;

  const groups = KIT_COLS.map((k) => ({
    ...k,
    orders: rows.filter((r) => Number(r[k.col]) > 0),
    total: rows.reduce((a, r) => a + (Number(r[k.col]) || 0), 0),
  })).filter((g) => g.orders.length);
  if (!groups.length) return;

  host.appendChild(el(`
    <div class="card kitbar">
      <div class="muted sm" style="margin-bottom:6px">${esc(tr("sch.kitFor", { d: fmtDate(date) }))}</div>
      ${groups.map((g) => `
        <div class="kitrow">
          <span class="kitname"><span class="chip warn">! ${esc(tr(g.key))} ${esc(num(g.total))}</span></span>
          <span class="kitids">${g.orders.map((r) =>
            `<span title="${esc([r.customer_name, r.city].filter(Boolean).join(" · "))}"
             >${esc(r.order_id)}${Number(r[g.col]) > 1 ? ` ×${esc(num(r[g.col]))}` : ""}</span>`).join(" ")}</span>
        </div>`).join("")}
    </div>`));
}

function shiftDate(date, dir) {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + dir);
  if (d.getDay() === 0) d.setDate(d.getDate() + dir);   // Sunday is the only day off
  setParam("date", d.toISOString().slice(0, 10));
}

const reload = () => window.dispatchEvent(new Event("ops:rerender"));

/* ------------------------------------------------------------------ actions */

function paintActions(date) {
  const box = $("#schactions", MOUNT);
  const ro = isViewer();
  const run = MODEL && MODEL.run;
  const conflicts = MODEL ? Number(MODEL.rule_conflicts || 0) : 0;

  box.innerHTML = `
    <div class="card">
      <div class="row schbtns">
        <button class="btn" id="schsyncbtn">🕒 ${esc(tr("sch.sync3d"))}</button>
        <button class="btn" id="schsuggest">👥 ${esc(tr("sch.suggest"))}</button>
        ${ro ? "" : `<button class="btn primary schbig" id="schcreate">🗓️ ${esc(tr("sch.create"))}</button>`}
        ${ro || !run || run.status === "finalized" ? ""
          : `<button class="btn accent" id="schfinal">✅ ${esc(tr("sch.finalize"))}</button>`}
        <span class="spacer"></span>
        <button class="btn ghost sm" id="schrules">⚙️ ${esc(tr("sch.rules"))}${
          conflicts ? ` <span class="chip bad">${conflicts}</span>` : ""}</button>
        <button class="btn ghost sm" id="schmem">🧠 ${esc(tr("sch.memory"))}</button>
      </div>
      ${ro ? "" : `<div class="schinstr">
        ${micField(`<textarea name="schinstr" rows="2" placeholder="${esc(tr("sch.instructionHint"))}"></textarea>`, "schinstr")}
        <div class="muted sm">${esc(tr("sch.instructionNote"))}</div>
      </div>`}
      ${run ? statsStrip(run) : `<div class="muted">${esc(tr("sch.noRun"))}</div>`}
    </div>
    ${run ? `<div class="card askbox" id="schask">
      <div class="row" style="gap:6px;align-items:center;margin-bottom:8px">
        <b>💬 ${esc(tr("sch.ask"))}</b>
        <span class="muted sm">${esc(tr("sch.askNote"))}</span>
      </div>
      <div class="asklog" id="asklog"></div>
      <div class="row" style="gap:6px">
        ${micField(`<input type="text" name="askq" placeholder="${esc(tr("sch.askHint"))}">`, "askq")}
        <button class="btn primary" id="asksend">${esc(tr("sch.askSend"))}</button>
      </div>
      <div class="row askquick">
        ${[["sch.qProblems", "What is wrong with this run?"],
           ["sch.qLoad", "How loaded is each team?"],
           ["sch.qRules", "Which rules are active?"]]
          .map(([k, v]) => `<button class="btn ghost sm" data-q="${esc(v)}">${esc(tr(k))}</button>`).join("")}
      </div>
    </div>` : ""}`;

  if (!ro) {
    const ta = box.querySelector('[name="schinstr"]');
    ta.addEventListener("input", () => { INSTRUCTION.text = ta.value; });
    /* Scoped to this field's own container, not to `box`. wireMics wires every [data-mic] under the
     * root it is given, and there are two dictation targets on this card now - passing `box` would
     * point the question box's mic at the build instruction. */
    wireMics(box.querySelector(".schinstr"),
             (text, method) => { INSTRUCTION.text = text; INSTRUCTION.method = method; });
    $("#schcreate", box).addEventListener("click", () => build(date));
    const fin = $("#schfinal", box);
    if (fin) fin.addEventListener("click", () => finalize());
  }

  $("#schsyncbtn", box).addEventListener("click", async () => {
    const ts = await lastSync(true);
    toast(ts ? tr("sch.syncedAt", { t: new Date(ts).toLocaleTimeString("en-GB",
      { hour: "2-digit", minute: "2-digit" }) }) : tr("sync.never"), ts ? "ok" : "bad");
    reload();
  });

  $("#schsuggest", box).addEventListener("click", async () => {
    try {
      const r = await rpc("fn_sched_suggest_teams", { p_date: date });
      const s = Array.isArray(r) ? r[0] : r;
      if (!s || !s.n) { toast(tr("sch.noWork"), "warn"); return; }
      suggestSheet(s, date);
    } catch (e) { toast(e.message, "bad"); }
  });

  $("#schrules", box).addEventListener("click", rulesSheet);
  $("#schmem", box).addEventListener("click", memorySheet);

  if (run) wireAsk(box, run, reload);
}

/* ------------------------------------------------------------------ the question box
 *
 * Answers come from fn_sched_ask, which reads the run rather than guessing at it - so "why is this
 * stop on team 3" gets the actual reason, not a plausible one. That matters more here than fluency:
 * this output routes vans.
 *
 * An instruction is never acted on silently. The box shows which rule it recognised and waits to be
 * confirmed, and when it recognises nothing it says so instead of storing a note that would sit in
 * the list looking active - the exact trap that made "separate Dubai and Abu Dhabi" appear to work
 * for two days while changing nothing.
 */
/* Call the sched-ask edge function with the signed-in user's own token, so it reads exactly what
 * that person is allowed to read. Short timeout: the deterministic answer behind it is already
 * correct, so waiting a long time for nicer wording is a bad trade for someone mid-shift. */
const ASK_TIMEOUT_MS = 9000;

async function askEdge(runId, question) {
  const tok = await accessToken();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ASK_TIMEOUT_MS);
  try {
    const r = await fetch(SB_URL + "/functions/v1/sched-ask", {
      method: "POST",
      signal: ctl.signal,
      headers: {
        apikey: SB_KEY,
        Authorization: "Bearer " + tok,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ run_id: runId, question }),
    });
    if (!r.ok) throw new Error("sched-ask " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function wireAsk(box, run, reload) {
  const panel = $("#schask", box);
  if (!panel) return;
  const log = $("#asklog", panel);
  const input = panel.querySelector('[name="askq"]');
  let method = "typed";

  const say = (who, title, lines, extra) => {
    log.appendChild(el(`
      <div class="askmsg ${who}">
        ${title ? `<b>${esc(title)}</b>` : ""}
        ${(lines || []).map((l) => `<div>${esc(l)}</div>`).join("")}
        ${extra || ""}
      </div>`));
    log.scrollTop = log.scrollHeight;
  };

  const ask = async (text) => {
    const q = (text || "").trim();
    if (!q) return;
    say("me", null, [q]);
    input.value = "";
    /* The edge function phrases the answer, but it is a convenience rather than the source: it
     * grounds itself on the same fn_sched_ask facts, and if it is missing, slow or has no API key
     * we fall back to those facts directly. The box must keep working without a model. */
    let a;
    try {
      a = await askEdge(run.id, q);
    } catch (e) {
      try { a = await rpc("fn_sched_ask", { p_run_id: run.id, p_question: q }); }
      catch (e2) { say("bot", null, [e2.message]); return; }
    }
    if (!a.answer) a.answer = [a.title, ...(a.lines || [])].filter(Boolean).join(" ");

    const rules = a.proposed_rules || [];
    if (!a.is_instruction) {
      // one line when a model phrased it, the fact list when it did not
      say("bot", a.llm ? null : a.title, a.llm ? [a.answer] : a.lines);
      return;
    }

    // an instruction: show what was understood and wait for a yes
    const wrap = el(`<div class="askmsg bot"><b>${esc(a.title)}</b>
      ${(a.llm ? [a.answer] : (a.lines || [])).map((l) => `<div>${esc(l)}</div>`).join("")}
      ${a.rule_source === "suggested"
        ? `<div class="muted sm">${esc(tr("sch.askRuleGuess"))}</div>` : ""}
      <div class="row" style="gap:6px;margin-top:7px">
        <button class="btn sm primary" data-save>${esc(
          rules.length ? tr("sch.askSaveRule") : tr("sch.askSaveNote"))}</button>
        <button class="btn ghost sm" data-drop>${esc(tr("act.cancel"))}</button>
      </div></div>`);
    wrap.querySelector("[data-drop]").addEventListener("click", () => wrap.remove());
    wrap.querySelector("[data-save]").addEventListener("click", async () => {
      try {
        await rpc("fn_sched_memory_add", {
          p_body: q, p_kind: "tip", p_scope: "global", p_run: run.id,
          p_method: method, p_lang: getLang(), p_actor: currentActor(),
        });
        wrap.remove();
        say("bot", null, [rules.length
          ? tr("sch.askSavedRule", { r: rules.join(", ") })
          : tr("sch.askSavedNote")]);
        // a stored rule only reaches the schedule on the next build - say so rather than imply it landed
        if (rules.length) say("bot", null, [tr("sch.askRebuild")]);
      } catch (e) { say("bot", null, [e.message]); }
    });
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
  };

  $("#asksend", panel).addEventListener("click", () => ask(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(input.value); });
  panel.querySelectorAll("[data-q]").forEach((b) =>
    b.addEventListener("click", () => ask(b.dataset.q)));
  wireMics(panel, (text, m) => { input.value = text; method = m; });
}

function statsStrip(run) {
  const s = run.stats || {};
  const tone = run.status === "finalized" ? "ok" : run.status === "draft" ? "info" : "mute";
  return `<div class="tline">
    <span class="chip ${tone}">${esc(trSuffix("sch.status", run.status))}</span>
    <span>${esc(tr("sch.stops"))}: <b>${num(s.stops || 0)}</b></span>
    <span>${esc(tr("sch.work"))}: <b>${mins(s.work_min)}</b></span>
    <span>${esc(tr("sch.travel"))}: <b>${mins(s.travel_min)} · ${num(s.travel_km)} km</b></span>
    ${s.late_stops ? `<span class="err">${esc(tr("sch.late"))}: <b>${num(s.late_stops)}</b></span>` : ""}
    ${s.anomalies ? `<span class="warnbit">⚠️ ${num(s.anomalies)}</span>` : ""}
    ${s.crew_short ? `<span class="warnbit">👥 ${num(s.crew_short)}</span>` : ""}
    ${s.emaar ? `<span class="chip info">⭐ ${num(s.emaar)}</span>` : ""}
    ${run.suggest_reason ? `<span class="muted sm">${esc(run.suggest_reason)}</span>` : ""}
  </div>`;
}

async function build(date, teamCount) {
  loading(true, tr("sch.building"));
  try {
    const id = await rpc("fn_sched_build_full", {
      p_date: date, p_team_count: teamCount || null, p_trigger: "manual",
      p_actor: currentActor(), p_instruction: INSTRUCTION.text || null,
      p_instruction_method: INSTRUCTION.method,
    });
    INSTRUCTION = { text: "", method: null };
    loading(false);
    toast(tr("sch.built"), "ok");
    setParam("run", id);
    reload();
  } catch (e) { loading(false); toast(e.message, "bad"); }
}

async function finalize() {
  const run = MODEL.run;
  const ok = await confirmSheet(tr("sch.finalize"),
    tr("sch.finalizeBody", { n: (run.stats || {}).stops || 0, d: fmtDate(run.sched_date) }));
  if (!ok) return;
  try {
    await rpc("fn_sched_finalize", { p_run_id: run.id, p_actor: currentActor() });
    toast(tr("sch.finalized"), "ok");
    reload();
  } catch (e) { toast(e.message, "bad"); }
}

function suggestSheet(s, date) {
  const d = s.detail || {};
  const m = modal(`
    <h3>${esc(tr("sch.suggest"))}</h3>
    <p class="schsuggest">${esc(s.reason)}</p>
    <table class="dense"><tbody>
      <tr><td>${esc(tr("sch.bWorkload"))}</td><td><b>${num(d.workload)}</b></td></tr>
      <tr><td>${esc(tr("sch.bSlots"))}</td><td><b>${num(d.fixed_slots)}</b></td></tr>
      <tr><td>${esc(tr("sch.bGeo"))}</td><td><b>${num(d.geography)}</b></td></tr>
      <tr><td>${esc(tr("sch.bCrew"))}</td><td><b>${num(d.crew_required)} / ${num(d.crew_available)}</b>${
        d.crew_short ? ` <span class="chip bad">${esc(tr("sch.crewShort"))}</span>` : ""}</td></tr>
    </tbody></table>
    <label class="f">${esc(tr("sch.teamCount"))}
      <input type="number" name="tc" min="1" max="${num(d.teams_available)}" value="${num(s.n)}"></label>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      ${isViewer() ? "" : `<button class="btn primary" data-yes>${esc(tr("sch.rebuild"))}</button>`}
    </div>`);
  m.sheet.querySelector("[data-no]").onclick = m.close;
  const yes = m.sheet.querySelector("[data-yes]");
  if (yes) yes.onclick = () => {
    const n = Number(m.sheet.querySelector('[name="tc"]').value) || s.n;
    m.close(); build(date, n);
  };
}

/* ------------------------------------------------------------------ summary
 *
 * What this schedule contains, and WHY it came out this way.
 *
 * A schedule is the output of an optimiser, and an optimiser nobody can interrogate is one nobody
 * trusts - the reaction to a board that looks wrong is to drag things about rather than to ask what
 * it was solving for. Everything here is read back from the run itself: the counts it recorded, the
 * team count it was given against the one it wanted, and the sentence it wrote explaining the
 * difference. None of it is recomputed in the browser, so the summary cannot drift from the board.
 */
function paintSummary() {
  const box = $("#schsummary", MOUNT);
  if (!box) return;
  if (!MODEL) { box.innerHTML = ""; return; }

  const run = MODEL.run || {};
  const s = run.stats || {};
  const stops = MODEL.stops || [];
  const placed = stops.filter((x) => x.team_no !== null);

  // totals across the stops actually on the board, from the counts the engine stored per stop
  const sum = (k) => stops.reduce((a, x) => a + (Number((x.counts || {})[k]) || 0), 0);
  const owl = sum("owl_total");
  const curtains = sum("curtains_1layer") + sum("curtains_2layer");
  const blinds = sum("blinds");
  const revisits = stops.filter((x) => x.entry_type === "issue_resolution").length;

  const cities = {};
  stops.forEach((x) => { if (x.city) cities[x.city] = (cities[x.city] || 0) + 1; });

  const hours = (m) => (Number(m) || 0) >= 60
    ? `${Math.floor(Number(m) / 60)}h ${Math.round(Number(m) % 60)}m` : `${Math.round(Number(m) || 0)}m`;

  /* Only the things somebody would act on tonight. A count of zero is not news, so it is not shown -
   * a warning row that is always there stops being read. */
  const watch = [
    { n: s.floating,   key: "sch.sumFloating",  tone: "warn" },
    { n: s.late_stops, key: "sch.sumLate",      tone: "warn" },
    { n: s.overruns,   key: "sch.sumOverruns",  tone: "bad" },
    { n: s.crew_short, key: "sch.sumCrewShort", tone: "bad" },
    { n: s.anomalies,  key: "sch.sumAnomalies", tone: "warn" },
    { n: s.emaar,      key: "sch.sumEmaar",     tone: "info" },
  ].filter((x) => Number(x.n) > 0);

  box.innerHTML = `
    <div class="card schsummary">
      <div class="spread" style="margin-bottom:8px">
        <h4>${esc(tr("sch.sumTitle"))}</h4>
        <span class="muted sm">${esc(tr("sch.sumVersion", { n: run.version_no || 1 }))}${
          run.trigger === "cron" ? " · " + esc(tr("sch.auto")) : ""}${
          run.created_by ? " · " + esc(run.created_by) : ""}</span>
      </div>

      <div class="sumgrid">
        <div><b>${num(stops.length)}</b><span>${esc(tr("sch.sumStops"))}</span></div>
        <div><b>${num(placed.length)}</b><span>${esc(tr("sch.sumPlaced"))}</span></div>
        <div><b>${num((MODEL.teams || []).length)}</b><span>${esc(tr("sch.team"))}</span></div>
        <div><b>${num(owl)}</b><span>${esc(tr("sch.owl"))}</span></div>
        <div><b>${num(curtains)}</b><span>${esc(tr("rep.curtains"))}</span></div>
        <div><b>${num(blinds)}</b><span>${esc(tr("col.owlBlinds"))}</span></div>
        <div><b>${hours(s.work_min)}</b><span>${esc(tr("sch.sumWork"))}</span></div>
        <div><b>${hours(s.travel_min)}</b><span>${esc(tr("sch.sumTravel"))}</span></div>
        <div><b>${num(s.travel_km)} km</b><span>${esc(tr("sch.sumDistance"))}</span></div>
      </div>

      <div class="row" style="gap:6px;margin-top:9px;flex-wrap:wrap">
        ${Object.entries(cities).map(([c, n]) => chip(`${c} ${n}`, "info", "📍")).join("")}
        ${revisits ? chip(tr("sch.sumRevisits", { n: revisits }), "mute", "↺") : ""}
        ${watch.map((w) => chip(tr(w.key, { n: w.n }), w.tone, "!")).join("")}
      </div>

      ${/* the one sentence that explains the shape of the whole board */ ""}
      <div class="sumwhy">
        <b>${esc(tr("sch.sumWhy"))}</b>
        <div>${esc(tr("sch.sumTeams", {
          used: run.team_count || (MODEL.teams || []).length,
          want: run.suggested_team_count || run.team_count || 0 }))}</div>
        ${run.suggest_reason ? `<div class="muted">${esc(run.suggest_reason)}</div>` : ""}
        ${run.instruction ? `<div>${esc(tr("sch.sumInstruction", { t: run.instruction }))}</div>` : ""}
      </div>

      <button class="btn ghost sm" data-how style="margin-top:9px">${esc(tr("sch.sumHow"))}</button>
      <div data-howbody hidden style="margin-top:8px"></div>
    </div>`;

  /* The timing rules, fetched only if somebody asks. They are the arithmetic behind every ETA on the
   * board, and "why is this stop 95 minutes" is the second question after "why this many teams". */
  const btn = box.querySelector("[data-how]");
  const body = box.querySelector("[data-howbody]");
  btn.addEventListener("click", async () => {
    body.hidden = !body.hidden;
    if (body.hidden || body.dataset.loaded) return;
    body.innerHTML = `<span class="muted">${esc(tr("t.loading"))}</span>`;
    try {
      const rules = await api("/rest/v1/sched_rule?select=code,label,minutes,threshold_cm,step_cm,enabled&order=sort_no");
      const on = (rules || []).filter((r) => r.enabled);
      body.innerHTML = `
        <div class="muted" style="margin-bottom:6px">${esc(tr("sch.sumHowBody"))}</div>
        <table class="dense"><tbody>
          ${on.map((r) => `<tr><td>${esc(r.label)}</td><td style="white-space:nowrap"><b>${
            esc(num(r.minutes))} ${esc(tr("sch.min"))}</b></td></tr>`).join("")}
        </tbody></table>`;
      body.dataset.loaded = "1";
    } catch (e) {
      body.innerHTML = `<span class="err">${esc(e.message)}</span>`;
    }
  });
}

/* ------------------------------------------------------------------ versions */

function paintVersions(date) {
  const box = $("#schver", MOUNT);
  if (!MODEL) { box.innerHTML = ""; return; }
  const vs = MODEL.versions || [];
  box.innerHTML = `
    <select id="schvsel">${vs.map((v) => `<option value="${v.id}"${
      v.id === MODEL.run.id ? " selected" : ""}>v${v.version_no} · ${esc(trSuffix("sch.status", v.status))}${
      v.trigger === "cron" ? " · " + esc(tr("sch.auto")) : ""}</option>`).join("")}</select>
    ${MODEL.run.status === "finalized" && !isViewer()
      ? `<button class="btn ghost sm" id="schcopy">${esc(tr("sch.copyDraft"))}</button>` : ""}`;
  $("#schvsel", box).addEventListener("change", (e) => setParam("run", e.target.value));
  const cp = $("#schcopy", box);
  if (cp) cp.addEventListener("click", () => build(date, MODEL.run.team_count));
}

/* ------------------------------------------------------------------ floating row */

function paintFloating() {
  const box = $("#schfloatwrap", MOUNT);
  if (!MODEL) { box.innerHTML = ""; return; }
  const stops = (MODEL.stops || []).filter((s) => s.team_no === null);
  box.innerHTML = `
    <div class="card schfloatcard">
      <div class="row spread">
        <b>${esc(tr("sch.floating"))} <span class="chip ${stops.length ? "warn" : "mute"}">${stops.length}</span></b>
        ${stops.length && !isViewer()
          ? `<button class="btn sm" id="schfill">${esc(tr("sch.fillGaps"))}</button>` : ""}
      </div>
      <div class="schfloat" data-drop="float">
        ${stops.length ? stops.map(stopCard).join("")
          : `<span class="muted">${esc(tr("sch.noFloating"))}</span>`}
      </div>
    </div>`;
  const f = $("#schfill", box);
  if (f) f.addEventListener("click", async () => {
    try {
      const n = await rpc("fn_sched_fill_gaps", { p_run_id: MODEL.run.id });
      toast(tr("sch.filled", { n: n || 0 }), n ? "ok" : "warn");
      reload();
    } catch (e) { toast(e.message, "bad"); }
  });
}

/* ------------------------------------------------------------------ board */

function paintBoard() {
  const box = $("#schboard", MOUNT);
  if (!MODEL) {
    box.innerHTML = `<div class="card"><span class="muted">${esc(tr("sch.noRunBody"))}</span></div>`;
    return;
  }
  const byTeam = new Map();
  (MODEL.stops || []).forEach((s) => {
    if (s.team_no === null) return;
    if (!byTeam.has(s.team_no)) byTeam.set(s.team_no, []);
    byTeam.get(s.team_no).push(s);
  });

  /* Columns run BY CITY, not by team number.
   *
   * Team 2 in Dubai next to team 3 in Abu Dhabi next to team 4 in Dubai is a board you have to read
   * twice to answer "who is in Abu Dhabi tomorrow" - and that is the question somebody asks while
   * loading vans. Team number is only an identifier; the city is the thing the day is organised
   * around, so it orders the board and the number just breaks ties within a city.
   *
   * Empty teams sink to the end: a column with no stops has no city, and guessing one would put it
   * under a heading it does not belong to. A team split across both emirates sorts under the first
   * city it is working, and says so in red - see cityLabel(). */
  const ordered = (MODEL.teams || []).map((t) => {
    const stops = byTeam.get(t.team_no) || [];
    return { t, stops, city: citiesOf(stops)[0] || "" };
  }).sort((a, b) => {
    if (!a.city !== !b.city) return a.city ? -1 : 1;      // teams with no work last
    if (a.city !== b.city) return a.city.localeCompare(b.city);
    return (a.t.team_no || 0) - (b.t.team_no || 0);
  });

  box.innerHTML = ordered.map((x) => teamColumn(x.t, x.stops)).join("");

  box.querySelectorAll("[data-stop]").forEach((c) => {
    c.querySelector("[data-menu]").addEventListener("click", (e) => {
      e.stopPropagation(); stopMenu(Number(c.dataset.stop));
    });
    const eta = c.querySelector("[data-eta]");
    if (eta) eta.addEventListener("click", (e) => { e.stopPropagation(); etaSheet(Number(c.dataset.stop)); });
  });

  if (isViewer() || MODEL.run.status === "finalized") return;

  dragBoard(box, {
    handleSel: "[data-grip]", itemSel: ".schcard", zoneSel: "[data-drop]",
    itemKey: (n) => Number(n.dataset.stop),
    zoneKey: (z) => (z.dataset.drop === "float" ? null : Number(z.dataset.drop)),
    onDrop: moveStop,
  });
  dragBoard(box, {
    handleSel: "[data-memgrip]", itemSel: ".schmem", zoneSel: "[data-memdrop]",
    itemKey: (n) => n.dataset.member,
    zoneKey: (z) => Number(z.dataset.memdrop),
    onDrop: moveMember,
  });
}

function teamColumn(t, stops) {
  const band = UTIL_BANDS.find((b) => b.value === t.util_band) || UTIL_BANDS[0];
  const pct = Math.round((t.util || 0) * 100);
  const cards = [];
  stops.forEach((s, i) => {
    if (i > 0 || s.travel_min_in) cards.push(travelRow(s));
    cards.push(stopCard(s));
  });
  return `
    <div class="schcol b-${esc(t.util_band)}">
      <div class="schcolhead">
        <div class="row spread">
          <b>${esc(tr("sch.team"))} ${t.team_no}</b>
          <span class="chip ${esc(band.tone)}" title="${esc(tr("sch.util"))}">${pct}%</span>
        </div>
        <div class="schmembers" data-memdrop="${t.team_no}">
          ${(t.member_names || []).map((n) => `
            <span class="schmem" data-member="${esc(n)}">
              <i data-memgrip class="grip">⠿</i>${esc(n)}${
                n === t.driver_name ? ` <em title="${esc(tr("sch.driver"))}">🚐</em>` : ""}${
                (MODEL.roster || []).some((r) => r.name === n && r.emaar) ? " ⭐" : ""}
            </span>`).join("")}
        </div>
        ${/* Where this team is actually going. Derived from the stops on the column rather than
            stored, so it follows a card being dragged between teams - and a team split across both
            emirates says so in red, because that is a 90-minute drive somebody should see before
            the van leaves rather than at 11am. */ ""}
        <div class="schcity">${cityLabel(stops)}</div>
        <div class="schcolmeta muted sm">
          ${stops.length} · ${mins(t.busy_min)} + ${mins(t.travel_min)} · ${num(t.travel_km)} km
          ${t.max_rail_cm ? ` · ${esc(tr("sch.maxRail"))} ${num(t.max_rail_cm)}` : ""}
        </div>
      </div>
      <div class="schstops" data-drop="${t.team_no}">${cards.join("")}</div>
    </div>`;
}

/* The city (or cities) a team's day is in, in the order it meets them. Empty when it has no stops -
 * a column with nothing on it is not "in Dubai", it is unused, and labelling it would be a guess.
 *
 * ONE definition, used by both the label and the column order in paintBoard(). Two of these would
 * eventually disagree, and a board sorted under a heading that contradicts the tag beneath it is
 * worse than one that was never sorted. */
function citiesOf(stops) {
  const seen = [];
  (stops || []).forEach((s) => { if (s.city && !seen.includes(s.city)) seen.push(s.city); });
  return seen;
}

function cityLabel(stops) {
  const seen = citiesOf(stops);
  if (!seen.length) return `<span class="muted sm">${esc(tr("sch.cityNone"))}</span>`;
  const split = seen.length > 1;
  return `<span class="schcitytag ${split ? "split" : ""}"
    title="${esc(split ? tr("sch.citySplitWhy") : "")}">📍 ${esc(seen.join(" + "))}${
    split ? " ⚠" : ""}</span>`;
}

function travelRow(s) {
  return `<div class="schtravel">↓ ${mins(s.travel_min_in)} · ${num(s.travel_km_in)} km</div>`;
}

function stopCard(s) {
  const c = s.counts || {};
  const tag = c.tag || "new";
  const late = s.lateness_min > 30 ? "late-bad" : s.lateness_min > 0 ? "late-warn" : "";
  const bits = [];
  const add = (n, label, icon) => { if (Number(n) > 0) bits.push(`<span title="${esc(label)}">${icon}${num(n)}</span>`); };
  add(c.curtains_1layer, tr("sch.l1"), "1L·");
  add(c.curtains_2layer, tr("sch.l2"), "2L·");
  add(c.blinds, tr("sch.blinds"), "🪟");
  add(c.pelmet, tr("sch.pelmet"), "📦");
  add(c.bend_rail, tr("sch.bend"), "↩️");
  add(c.flex_track, tr("sch.flex"), "〰️");
  add(c.motor, tr("sch.motor"), "⚡");
  add(c.cassette, tr("sch.cassette"), "🎞️");
  add(c.tall_windows, tr("sch.tall"), "🪜");
  add(c.removals, tr("sch.removals"), "🗑️");
  add(c.scaffolding, tr("sch.scaffolding"), "🧗");

  return `
    <div class="schcard ${esc(s.is_emaar ? "emaar" : "")} ${late}" data-stop="${s.id}">
      <div class="schcardtop">
        <i data-grip class="grip">⠿</i>
        <span class="schtime">${hhmm(s.planned_start)}</span>
        ${s.sheet_time && s.lateness_min > 0
          ? `<span class="schlate" title="${esc(tr("sch.sheetTime"))} ${hhmm(s.sheet_time)}">+${s.lateness_min}m</span>` : ""}
        <span class="schtag" title="${esc(trSuffix("sch.tag", tag))}">${TAG_ICON[tag] || "🆕"}</span>
        ${s.is_emaar ? `<span title="${esc(tr("sch.emaar"))}">⭐</span>` : ""}
        <button class="schmenu" data-menu title="${esc(tr("sch.actions"))}">⋮</button>
      </div>
      <div class="schoid">${esc(orderLabel(s))}</div>
      <div class="schsub muted">${esc(s.community || s.city || "")}${
        c.owl_total ? ` · ${esc(tr("sch.owl"))} ${num(c.owl_total)}` : ""}</div>
      <div class="schbits">${bits.join("")}</div>
      <div class="schfoot">
        <button class="schetabtn" data-eta title="${esc(tr("sch.etaEdit"))}">⏱ ${mins(s.eta_override || s.eta_min)}${
          s.eta_override ? " *" : ""}</button>
        ${(s.warnings || []).map((w) => `<span title="${esc(trSuffix("sch.warn", w))}">${WARN_ICON[w] || "⚠️"}</span>`).join("")}
        ${c.partial_only ? `<span title="${esc(tr("sch.partial"))}">🧩</span>` : ""}
        ${c.hanging_only ? `<span title="${esc(tr("sch.hangingOnly"))}">🪝</span>` : ""}
        ${s.last_visit_date ? `<span class="muted sm" title="${esc(tr("sch.lastVisit"))}">${esc(fmtDate(s.last_visit_date))}</span>` : ""}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ mutations */

async function moveStop(stopId, teamNo, index) {
  try {
    await rpc("fn_sched_move_stop", {
      p_stop_id: stopId, p_team_no: teamNo, p_after_seq: teamNo === null ? null : index + 1,
    });
    await refresh();
  } catch (e) { toast(e.message, "bad"); reload(); }
}

async function moveMember(name, teamNo) {
  const teams = MODEL.teams || [];
  const from = teams.find((t) => (t.member_names || []).includes(name));
  const to = teams.find((t) => t.team_no === teamNo);
  if (!to || (from && from.team_no === teamNo)) return;
  try {
    if (from) {
      await rpc("fn_sched_set_members", {
        p_run_id: MODEL.run.id, p_team_no: from.team_no,
        p_members: from.member_names.filter((n) => n !== name),
      });
    }
    await rpc("fn_sched_set_members", {
      p_run_id: MODEL.run.id, p_team_no: teamNo,
      p_members: (to.member_names || []).concat([name]),
    });
    await refresh();
  } catch (e) { toast(e.message, "bad"); reload(); }
}

/* Repaint only the board and floating row; a full render() per drag is unusable on a phone. */
async function refresh() {
  try {
    MODEL = await rpc("fn_sched_board", { p_run_id: MODEL.run.id });
    paintFloating();
    paintSummary();          // moving a stop can change a team's city and every total on it
    paintBoard();
    const st = $("#schactions .tline", MOUNT);
    if (st) st.outerHTML = statsStrip(MODEL.run);
  } catch (e) { toast(e.message, "bad"); reload(); }
}

function stopMenu(stopId) {
  const s = (MODEL.stops || []).find((x) => x.id === stopId);
  if (!s) return;
  const ro = isViewer() || MODEL.run.status === "finalized";
  const teams = (MODEL.teams || []).filter((t) => t.team_no !== s.team_no);
  const m = modal(`
    <h3>${esc(orderLabel(s))}</h3>
    <div class="muted" style="margin-bottom:10px">${esc(s.address || s.community || "")}</div>
    <table class="dense"><tbody>
      <tr><td>${esc(tr("sch.sheetTime"))}</td><td>${hhmm(s.sheet_time)}</td></tr>
      <tr><td>${esc(tr("sch.planned"))}</td><td>${hhmm(s.planned_start)} – ${hhmm(s.planned_end)}</td></tr>
      <tr><td>${esc(tr("sch.eta"))}</td><td>${mins(s.eta_override || s.eta_min)}</td></tr>
      <tr><td>${esc(tr("sch.location"))}</td><td>${esc(s.community || "—")} <span class="chip ${
        s.geo_confidence === "high" ? "ok" : s.geo_confidence === "none" ? "bad" : "warn"
      }">${esc(trSuffix("sch.conf", s.geo_confidence))}</span></td></tr>
      ${s.geo_note ? `<tr><td>⚠️</td><td>${esc(s.geo_note)}</td></tr>` : ""}
      <tr><td>${esc(tr("sch.crew"))}</td><td>${s.required_crew}${
        s.crew_short ? ` <span class="chip bad">${esc(tr("sch.crewShort"))}</span>` : ""}</td></tr>
      ${s.phone ? `<tr><td>${esc(tr("sch.phone"))}</td><td>${esc(s.phone)}</td></tr>` : ""}
    </tbody></table>
    ${ro ? "" : `
    <label class="f">${esc(tr("sch.moveTo"))}
      <select name="mv"><option value="">—</option>
        <option value="float">${esc(tr("sch.floating"))}</option>
        ${teams.map((t) => `<option value="${t.team_no}">${esc(tr("sch.team"))} ${t.team_no} · ${esc(t.team_name || "")}</option>`).join("")}
      </select></label>
    <div class="row" style="justify-content:space-between">
      <button class="btn ghost sm" data-drop>🗑 ${esc(tr("sch.remove"))}</button>
      <button class="btn primary" data-ok>${esc(tr("act.save"))}</button>
    </div>`}`);

  if (ro) return;
  m.sheet.querySelector("[data-ok]").onclick = async () => {
    const v = m.sheet.querySelector('[name="mv"]').value;
    m.close();
    if (v === "") return;
    await moveStop(stopId, v === "float" ? null : Number(v), 999);
  };
  m.sheet.querySelector("[data-drop]").onclick = async () => {
    m.close();
    if (!(await confirmSheet(tr("sch.remove"), tr("sch.removeBody", { o: orderLabel(s) })))) return;
    try { await rpc("fn_sched_remove_stop", { p_stop_id: stopId }); await refresh(); }
    catch (e) { toast(e.message, "bad"); }
  };
}

async function etaSheet(stopId) {
  const s = (MODEL.stops || []).find((x) => x.id === stopId);
  if (!s) return;
  let rows = [];
  try {
    rows = await rpc("fn_sched_eta_explain", {
      p_order_id: s.order_id, p_entry_type: s.entry_type, p_rule_set: MODEL.run.rule_set_id,
    }) || [];
  } catch (e) { /* the breakdown is a nicety; the override still works without it */ }

  const ro = isViewer() || MODEL.run.status === "finalized";
  const m = modal(`
    <h3>${esc(tr("sch.eta"))} — ${esc(orderLabel(s))}</h3>
    <table class="dense"><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="mono">×${num(r.qty)}</td>
        <td class="mono">${num(r.minutes)}m</td></tr>`).join("")}
      <tr><td><b>${esc(tr("sch.calculated"))}</b></td><td></td><td class="mono"><b>${mins(s.eta_min)}</b></td></tr>
    </tbody></table>
    ${ro ? "" : `
    <label class="f">${esc(tr("sch.etaOverride"))}
      <input type="number" name="eta" min="0" step="5" value="${s.eta_override || ""}"
             placeholder="${num(s.eta_min)}"></label>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-ok>${esc(tr("act.save"))}</button>
    </div>`}`);
  if (ro) return;
  m.sheet.querySelector("[data-no]").onclick = m.close;
  m.sheet.querySelector("[data-ok]").onclick = async () => {
    const v = Number(m.sheet.querySelector('[name="eta"]').value) || 0;
    m.close();
    try { await rpc("fn_sched_set_eta", { p_stop_id: stopId, p_minutes: v }); await refresh(); }
    catch (e) { toast(e.message, "bad"); }
  };
}

/* ------------------------------------------------------------------ rules & memory */

async function rulesSheet() {
  let rules = [];
  try {
    rules = await api("/rest/v1/sched_rule?select=*&order=sort_no") || [];
  } catch (e) { toast(e.message, "bad"); return; }

  const enabled = new Set(rules.filter((r) => r.enabled).map((r) => r.code));
  const isConflict = (r) => r.enabled && (r.conflicts_with || []).some((c) => enabled.has(c));
  const n = rules.filter(isConflict).length;

  const m = modal(`
    <h3>${esc(tr("sch.rules"))}</h3>
    ${n ? `<div class="banner warn">${esc(tr("sch.conflictsBody", { n }))}</div>` : ""}
    <div class="scrollx"><table class="dense"><thead><tr>
      <th>${esc(tr("sch.rule"))}</th><th>${esc(tr("sch.minutes"))}</th><th></th></tr></thead><tbody>
      ${rules.map((r) => `<tr class="${isConflict(r) ? "pending" : ""}">
        <td>${esc(r.label)}${r.note ? `<div class="muted sm">${esc(r.note)}</div>` : ""}</td>
        <td><input type="number" class="rmin" data-id="${r.id}" value="${r.minutes}" step="5"
              ${isViewer() ? "disabled" : ""}></td>
        <td><label class="rchk"><input type="checkbox" data-en="${r.id}" ${r.enabled ? "checked" : ""}
              ${isViewer() ? "disabled" : ""}></label></td></tr>`).join("")}
    </tbody></table></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      ${isViewer() ? "" : `<button class="btn primary" data-ok>${esc(tr("act.save"))}</button>`}
    </div>`);
  m.sheet.querySelector("[data-no]").onclick = m.close;
  const ok = m.sheet.querySelector("[data-ok]");
  if (ok) ok.onclick = async () => {
    const changes = rules.map((r) => {
      const min = Number(m.sheet.querySelector(`.rmin[data-id="${r.id}"]`).value);
      const en = m.sheet.querySelector(`[data-en="${r.id}"]`).checked;
      return (min !== Number(r.minutes) || en !== r.enabled) ? { id: r.id, minutes: min, enabled: en } : null;
    }).filter(Boolean);
    m.close();
    if (!changes.length) return;
    try {
      for (const c of changes) {
        await api(`/rest/v1/sched_rule?id=eq.${c.id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ minutes: c.minutes, enabled: c.enabled }),
        });
      }
      toast(tr("sch.rulesSaved", { n: changes.length }), "ok");
      reload();
    } catch (e) { toast(e.message, "bad"); }
  };
}

function memorySheet() {
  const mem = (MODEL && MODEL.memory) || [];
  const m = modal(`
    <h3>🧠 ${esc(tr("sch.memory"))}</h3>
    <p class="muted sm">${esc(tr("sch.memoryNote"))}</p>
    ${mem.length ? `<div class="scrollx"><table class="dense"><tbody>
      ${mem.map((x) => `<tr><td>${esc(x.body)}<div class="muted sm">${esc(x.scope)} · ${esc(fmtDate(x.created_at))}</div></td>
        <td>${isViewer() ? "" : `<button class="btn ghost sm" data-del="${x.id}">🗑</button>`}</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="muted">${esc(tr("sch.memoryEmpty"))}</div>`}
    ${isViewer() ? "" : `
    ${micField(`<textarea name="newmem" rows="2" placeholder="${esc(tr("sch.memoryAdd"))}"></textarea>`, "newmem")}
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-ok>${esc(tr("act.save"))}</button>
    </div>`}`);
  m.sheet.querySelector("[data-no]") && (m.sheet.querySelector("[data-no]").onclick = m.close);
  if (isViewer()) return;

  let method = null;
  wireMics(m.sheet, (t, meth) => { method = meth; });
  m.sheet.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/rest/v1/sched_memory?id=eq.${b.dataset.del}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ active: false }),
        });
        m.close(); reload();
      } catch (e) { toast(e.message, "bad"); }
    };
  });
  m.sheet.querySelector("[data-ok]").onclick = async () => {
    const body = m.sheet.querySelector('[name="newmem"]').value.trim();
    m.close();
    if (!body) return;
    try {
      await rpc("fn_sched_memory_add", {
        p_body: body, p_kind: "tip", p_scope: "global",
        p_method: method, p_actor: currentActor(),
      });
      toast(tr("sch.saved"), "ok");
      reload();
    } catch (e) { toast(e.message, "bad"); }
  };
}
