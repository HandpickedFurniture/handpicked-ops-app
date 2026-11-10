/* The Step scheduler's plan, SHARED (user, 10 Nov 2026).
 *
 * Until now the plan for a date + city lived in one browser's localStorage, so a second coordinator
 * opening the stepper saw an empty board. It now lives in stepper_plan (one row per date + city) and
 * every edit is pushed there a second after it is made, with a line for the change log saying what
 * was done; stepper_change records it against the person's sign-in email.
 *
 * Saving is optimistic: a save names the revision it was based on, and fn_stepper_save refuses it
 * when somebody else has saved since, handing back their plan. The two are then MERGED here - per
 * order for times, ETAs, notes, ticks and pins, per team for assignments - and saved again, so two
 * people working on different orders never undo each other. Where both changed the same thing, the
 * person saving last wins (and the change log shows both).
 *
 * Every 15 s a ping says who else has the day open and whether the plan moved on; a newer plan is
 * taken in at once when this browser has nothing unsaved.
 *
 * What is one person's view rather than the plan (stage on screen, order in hand, map options, the
 * Undo history, column order) never leaves the browser - LOCAL_KEYS.
 */
import { rpc, api, isViewer } from "./api.js";
import { modal, toast } from "./ui.js";

export const LOCAL_KEYS = ["stage", "cur", "autoZoom", "showAll", "showRest", "colOrder", "colSort", "history"];
const J = (x) => JSON.stringify(x === undefined ? null : x);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const who = (e) => String(e || "?").split("@")[0];
const when = (t) => (t ? new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

export function shared(st) {
  const o = {};
  for (const k in st || {}) if (!LOCAL_KEYS.includes(k)) o[k] = st[k];
  return clone(o);
}

/* three-way merge of one value: unchanged on one side -> the other side's; changed on both -> go one
 * level down when both are objects, else the local (newest) edit wins */
function merge3(b, l, r, depth) {
  if (J(l) === J(b)) return clone(r);
  if (J(r) === J(b)) return clone(l);
  if (depth > 0 && isObj(l) && isObj(r)) {
    const out = {}, bb = isObj(b) ? b : {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(bb)])) {
      const v = merge3(bb[k], l[k], r[k], depth - 1);
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
  }
  return clone(l);
}
const DEPTH = { times: 1, eta: 1, isr: 1, emaarSet: 1, extra: 1, pins: 1, sheetGone: 1, assign: 1, notes: 2 };
const teamIn = (A, id) => { for (const t in A || {}) if ((A[t] || []).includes(id)) return t; return null; };

export function mergeState(base, local, remote) {
  const B = shared(base || {}), L = shared(local || {}), Rm = shared(remote || {}), out = {};
  for (const k of new Set([...Object.keys(B), ...Object.keys(L), ...Object.keys(Rm)])) {
    const v = merge3(B[k], L[k], Rm[k], DEPTH[k] || 0);
    if (v !== undefined) out[k] = v;
  }
  const both = (k) => J(L[k]) !== J(B[k]) && J(Rm[k]) !== J(B[k]);
  if (both("teams")) {
    const m = new Map();
    (Rm.teams || []).forEach((t) => m.set(t.team, t));
    (L.teams || []).forEach((t) => m.set(t.team, t));
    out.teams = [...m.values()].sort((a, b) => a.team - b.team);
  }
  for (const k of ["added", "removed", "waveIds"]) if (both(k)) out[k] = [...new Set([...(L[k] || []), ...(Rm[k] || [])])];
  // an order sits on ONE team: the side that moved it decides where
  out.assign = out.assign || {};
  const nums = new Set((out.teams || []).map((t) => String(t.team)));
  for (const t of Object.keys(out.assign)) if (!nums.has(String(t))) delete out.assign[t];
  nums.forEach((t) => { out.assign[t] = out.assign[t] || []; });
  // every order either side ever had on a team, so one that lost a whole-list merge is put back
  const ids = new Set([B.assign, L.assign, Rm.assign, out.assign].flatMap((A) => Object.values(A || {}).flat()));
  ids.forEach((id) => {
    const lt = teamIn(L.assign, id), bt = teamIn(B.assign, id), rt = teamIn(Rm.assign, id);
    const want = lt !== bt ? lt : rt;
    for (const t of Object.keys(out.assign)) if (String(t) !== String(want)) out.assign[t] = out.assign[t].filter((x) => x !== id);
    if (want != null && out.assign[want] && !out.assign[want].includes(id)) out.assign[want].push(id);
  });
  for (const k of LOCAL_KEYS) if (local && k in local) out[k] = clone(local[k]);
  return out;
}

/* ---------------------------------------------------------------- the controller */
export const S = { rev: 0, base: null, pending: [], timer: null, poll: null, saving: false, again: false, dirty: false,
  present: [], by: null, at: null, mode: "idle", err: "", readonly: false, scope: "" };
let H = null;      // hooks from mod-stepper: scope(), day(), city(), stage(), state(), adopt(state, who), hasLocal(), status(html)

export function init(hooks) { H = hooks; }

export async function open() {
  // re-opening the same day (the 3D sheet re-read): save what is waiting first, or it would be dropped
  if (S.scope === H.scope() && S.dirty) await flush();
  stop();
  const scope = H.scope();
  Object.assign(S, { rev: 0, base: null, pending: [], dirty: false, saving: false, again: false, present: [], by: null, at: null,
    mode: "loading", err: "", readonly: isViewer(), scope });
  status();
  try {
    const r = await rpc("fn_stepper_get", { p_day: H.day(), p_city: H.city() });
    if (scope !== H.scope()) return;
    if (r && r.state) {
      Object.assign(S, { rev: r.rev, base: shared(r.state), by: r.updated_by, at: r.updated_at, mode: "synced" });
      H.adopt(r.state, null);
    } else {
      S.rev = 0; S.base = {}; S.mode = "synced";
      // a plan made before plans were shared: this browser's copy becomes the shared one
      if (H.hasLocal() && !S.readonly) changed("Shared the plan saved on this device", "create", 0);
    }
  } catch (e) { S.mode = "offline"; S.err = (e && e.message) || "offline"; }
  status();
  S.poll = setInterval(ping, 15000);
  ping();
}
export function stop() { clearInterval(S.poll); clearTimeout(S.timer); S.poll = null; }

/* call after every change to the plan; summary is the change-log line ("" = no line) */
export function changed(summary, kind, ms) {
  if (S.readonly) return;
  if (summary) {
    const last = S.pending[S.pending.length - 1];
    // typing a note fires on every key: keep one line per field, the latest
    if (last && kind === "note" && last.kind === "note" && last.key === summary.split(":")[0]) last.summary = summary;
    else S.pending.push({ kind: kind || "edit", summary: String(summary).slice(0, 480), key: summary.split(":")[0] });
  }
  S.dirty = true;
  clearTimeout(S.timer);
  S.timer = setTimeout(push, ms == null ? 1200 : ms);
  status();
}
export async function flush() { clearTimeout(S.timer); if (S.dirty) await push(); }

async function push() {
  if (S.readonly || !S.dirty || !H) return;
  // never save over the shared plan before it has been read: a stale local copy would win the merge
  if (S.mode === "loading") { clearTimeout(S.timer); S.timer = setTimeout(push, 500); return; }
  if (S.saving) { S.again = true; return; }
  const st = shared(H.state());
  // a repaint that only touched this person's view (column order, map options) is not a change
  // and looking at a day nobody has changed yet (switching stage, sorting) does not create its shared plan
  if (!S.pending.length && (!S.rev || J(st) === J(S.base))) { S.dirty = false; status(); return; }
  S.saving = true; S.dirty = false;
  const changes = S.pending.splice(0).map(({ kind, summary }) => ({ kind, summary }));
  const scope = H.scope();
  status();
  let retry = false;
  try {
    const r = await rpc("fn_stepper_save", { p_day: H.day(), p_city: H.city(), p_state: st, p_base_rev: S.rev, p_changes: changes });
    if (scope !== H.scope()) return;
    if (r && r.ok) {
      Object.assign(S, { rev: r.rev, base: st, by: "you", at: new Date().toISOString(), mode: "synced", err: "" });
    } else if (r && r.state) {
      // somebody saved first: merge theirs with ours and save again
      const merged = mergeState(S.base, H.state(), r.state);
      Object.assign(S, { rev: r.rev, base: shared(r.state), by: r.updated_by });
      H.adopt(merged, r.updated_by);
      S.pending.unshift(...changes); S.dirty = true; retry = true;
      toast(`${who(r.updated_by)} changed the plan at the same time - both changes kept`);
    }
  } catch (e) {
    const m = (e && e.message) || "";
    if (/look but not change|view-only|read.?only/i.test(m)) { S.readonly = true; S.mode = "readonly"; }
    else { S.mode = "offline"; S.err = m; S.pending.unshift(...changes); S.dirty = true; clearTimeout(S.timer); S.timer = setTimeout(push, 15000); }
  } finally {
    S.saving = false; status();
    if (retry) push();
    else if (S.again) { S.again = false; if (S.dirty) { clearTimeout(S.timer); S.timer = setTimeout(push, 300); } }
  }
}

async function ping() {
  if (!H || !H.root || !H.root()) { stop(); return; }
  if (!H.root().isConnected) { stop(); return; }
  const scope = H.scope();
  try {
    const r = await rpc("fn_stepper_ping", { p_day: H.day(), p_city: H.city(), p_stage: H.stage() });
    if (scope !== H.scope()) return;
    S.present = (r && r.present) || [];
    if (S.mode === "offline" && S.dirty) push();
    if (r && r.rev && r.rev > S.rev && !S.dirty && !S.saving) {
      const g = await rpc("fn_stepper_get", { p_day: H.day(), p_city: H.city() });
      if (scope !== H.scope() || S.dirty || S.saving || !g || !g.state) return;
      Object.assign(S, { rev: g.rev, base: shared(g.state), by: g.updated_by, at: g.updated_at, mode: "synced" });
      H.adopt(g.state, g.updated_by);
    } else if (S.mode === "offline") S.mode = "synced";
  } catch (e) { /* the plan still works on this device; the next ping tries again */ }
  status();
}

function status() {
  if (!H) return;
  const m = S.readonly ? `<span class="chip" title="Your role can look but not change the plan">👁 view only</span>`
    : S.saving || S.dirty ? `<span class="chip warn">☁ saving…</span>`
    : S.mode === "offline" ? `<span class="chip bad" title="${esc(S.err)}">☁ offline - kept on this device, retrying</span>`
    : S.mode === "loading" ? `<span class="chip">☁ loading…</span>`
    : !S.rev ? `<span class="chip" title="Nobody has changed this day yet. Your first change saves it for everybody.">☁ new plan, not shared yet</span>`
    : `<span class="chip good" title="${S.by ? "last saved by " + esc(S.by) + " " + esc(when(S.at)) : ""}">☁ saved${S.rev ? " · v" + S.rev : ""}${S.by && S.by !== "you" ? " · " + esc(who(S.by)) : ""}</span>`;
  const p = S.present.length ? `<span class="chip hot" title="${esc(S.present.map((x) => x.who + (x.stage ? " (stage " + x.stage + ")" : "")).join(", "))}">👥 ${esc(S.present.map((x) => who(x.who)).join(", "))}</span>` : "";
  H.status(`${m}${p}<button class="btn small" id="stp-b-history" title="Versions and the change log (who did what)">🕘 History</button>`);
}

/* ---------------------------------------------------------------- versions + change log */
export async function openHistory() {
  await flush();
  const d = H.day(), c = H.city(), q = `day=eq.${d}&city=eq.${encodeURIComponent(c)}`;
  let versions = [], changes = [];
  try {
    [versions, changes] = await Promise.all([
      api(`/rest/v1/stepper_plan_version?select=id,label,rev,created_at,created_by&${q}&order=created_at.desc&limit=60`),
      api(`/rest/v1/stepper_change?select=at,who,kind,summary,rev&${q}&order=at.desc&limit=300`),
    ]);
  } catch (e) { toast((e && e.message) || "Could not load the history", "bad"); return; }
  const m = modal(`<div class="stphist">
    <div class="spread"><h3>${esc(c)} · ${esc(d)} - versions and changes</h3><button class="btn ghost sm" data-x>✕</button></div>
    ${S.readonly ? "" : `<div class="row" style="gap:6px;margin:8px 0"><input id="stp-vlabel" placeholder="Name this version, e.g. sent to teams" style="flex:1;min-width:180px">
      <button class="btn primary sm" data-savev>💾 Save version</button></div>`}
    <h4 style="margin:10px 0 4px">Saved versions (${versions.length})</h4>
    ${versions.length ? `<table class="stpvt"><tbody>${versions.map((v) => `<tr><td><b>${esc(v.label || "Version #" + v.id)}</b><div class="muted" style="font-size:12px">plan v${v.rev || "?"} · ${esc(who(v.created_by))} · ${esc(when(v.created_at))}</div></td>
      <td style="text-align:right">${S.readonly ? "" : `<button class="btn sm" data-restore="${v.id}">↺ Restore</button>`}</td></tr>`).join("")}</tbody></table>`
      : `<div class="muted">None yet. Save one before you send the schedule, so you can always come back to it.</div>`}
    <h4 style="margin:12px 0 4px">Change log</h4>
    <div class="stplog">${changes.length ? changes.map((x) => `<div><span class="muted">${esc(when(x.at))}</span> <b>${esc(who(x.who))}</b> · ${esc(x.summary || x.kind)}</div>`).join("")
      : `<div class="muted">No changes recorded yet.</div>`}</div></div>`);
  m.sheet.classList.add("wide");
  m.sheet.querySelector("[data-x]").onclick = m.close;
  const sv = m.sheet.querySelector("[data-savev]");
  if (sv) sv.onclick = async () => {
    try {
      if (!S.rev) { changed("Saved the plan", "edit", 0); await flush(); }
      await rpc("fn_stepper_save_version", { p_day: d, p_city: c, p_label: m.sheet.querySelector("#stp-vlabel").value || null });
      toast("Version saved"); m.close(); openHistory();
    } catch (e) { toast((e && e.message) || "Could not save the version", "bad"); }
  };
  m.sheet.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Press again to restore"; b.classList.add("danger"); return; }
    try {
      const r = await rpc("fn_stepper_restore_version", { p_id: Number(b.dataset.restore) });
      Object.assign(S, { rev: r.rev, base: shared(r.state), by: "you", at: new Date().toISOString(), dirty: false, pending: [] });
      H.adopt(r.state, null); toast("Version restored for everyone"); m.close(); status();
    } catch (e) { toast((e && e.message) || "Could not restore", "bad"); }
  }));
}
