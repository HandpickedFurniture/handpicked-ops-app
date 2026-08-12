/* Auth-aware data layer.
 *
 * Modelled on pfc-order-app/index.html:646, with ONE critical difference. That app sends its anon key
 * as both `apikey` and the bearer, because its writes go through a SECURITY DEFINER RPC. Here every
 * table is RLS-locked to `authenticated` and `anon` has NO policy - so a request bearing the anon key
 * returns HTTP 200 with an empty array, forever, and never 401s. That silent failure already burned
 * tools/validate.py. Hence: api() refuses to run without an access token, and callers must treat
 * "no rows with no filters" as an error, not as empty.
 */
import { SB_URL, SB_KEY, STORAGE_PREFIX } from "./config.js";
import { tr } from "./i18n.js";   // i18n imports only config, so this cannot cycle back here

const SESSION_KEY = STORAGE_PREFIX + "session";
const QUEUE_KEY = STORAGE_PREFIX + "queue";
const FAILED_KEY = STORAGE_PREFIX + "queue_failed";

let session = null;
let refreshing = null;          // single-flight guard, see refresh()
const listeners = { session: [], queue: [] };

export function onSession(fn) { listeners.session.push(fn); }
export function onQueue(fn) { listeners.queue.push(fn); }
const emit = (k, v) => listeners[k].forEach((f) => { try { f(v); } catch (e) { console.error(e); } });

/* ---------------------------------------------------------------- session */
export function loadSession() {
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
  catch (e) { session = null; }
  return session;
}
export function getSession() { return session; }
export function isSignedIn() { return !!(session && session.access_token); }

export function currentActor() {
  if (!session || !session.user) return null;
  const m = session.user.user_metadata || {};
  return m.full_name || m.name || session.user.email || null;
}

/* ---------------------------------------------------------------- role
 * Cached per session for the UI only: it decides which buttons to draw. It is NOT the access
 * boundary - RLS is, because this app ships its publishable key and every signed-in person holds a
 * real bearer token they could point at PostgREST themselves. Treat a stale or spoofed value here
 * as cosmetic; the database refuses the write either way.
 * Unknown role means full access, matching fn_is_viewer()'s "no row = ops" default, so a failed
 * lookup never silently locks a coordinator out of their own job. */
let role = null;

export function currentRole() { return role || "ops"; }
export function isViewer() { return role === "viewer"; }

export async function loadRole() {
  role = null;
  if (!isSignedIn() || !session.user) return currentRole();
  try {
    const rows = await api(`/rest/v1/app_roles?select=role&user_id=eq.${session.user.id}`);
    if (rows && rows.length) role = rows[0].role;
  } catch (e) { /* leave it at ops - see above */ }
  return currentRole();
}

function setSession(s) {
  session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
  emit("session", s);
}

export function clearSession() { setSession(null); }

function stamp(raw) {
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    // expires_in is seconds from now; store an absolute ms deadline so a reload can still judge it
    expires_at: Date.now() + (raw.expires_in ? raw.expires_in * 1000 : 3600 * 1000),
    user: raw.user || (session && session.user) || null,
  };
}

export async function signIn(email, password) {
  const r = await fetch(SB_URL + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || j.message || "Sign in failed");
  setSession(stamp(j));
  return session;
}

export async function signOut() {
  if (session && session.access_token) {
    try {
      await fetch(SB_URL + "/auth/v1/logout", {
        method: "POST",
        headers: { apikey: SB_KEY, Authorization: "Bearer " + session.access_token },
      });
    } catch (e) { /* signing out locally matters more than telling the server */ }
  }
  clearSession();
}

/* Supabase ROTATES refresh tokens: two concurrent refreshes invalidate each other and log the user
 * out mid-shift. Six parallel GETs on page load would do exactly that, so all of them must await the
 * same in-flight promise. */
function refresh() {
  if (refreshing) return refreshing;
  if (!session || !session.refresh_token) return Promise.reject(new Error("No session"));

  refreshing = (async () => {
    const r = await fetch(SB_URL + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!r.ok) { clearSession(); throw new Error("Session expired"); }
    const j = await r.json();
    setSession(stamp(j));
    return session;
  })().finally(() => { refreshing = null; });

  return refreshing;
}

async function freshToken() {
  if (!session || !session.access_token) throw new Error("NOT_SIGNED_IN");
  if (session.expires_at && session.expires_at - Date.now() < 120000) {
    try { await refresh(); } catch (e) { throw new Error("NOT_SIGNED_IN"); }
  }
  return session.access_token;
}

/* ---------------------------------------------------------------- fetch */
/* Two calls a viewer must still be allowed to make: the rate card is a read dressed as an RPC, and
 * photo access logging has to record a viewer opening a photo - that is precisely the person the
 * audit trail exists to cover. Everything else that is not a GET is refused here.
 *
 * This is one choke point rather than a hunt through every module for buttons to hide, so a write
 * path added later is refused by default instead of being quietly forgotten. It is still only the
 * second line: RLS is the boundary, and it refuses these same calls independently. */
/* The fn_sched_* entries below are reads that PostgREST only exposes as POST /rpc. Without them a
 * viewer could not open the Schedule board at all. Each is `stable` and writes nothing; the mutating
 * schedule functions (build, move, finalize, ...) are deliberately absent and stay refused. */
const VIEWER_ALLOWED =
  /\/rpc\/(fn_ops_rate_for|fn_ops_log_photo_access|fn_sched_board|fn_sched_run_for|fn_sched_next_working_day|fn_sched_suggest_teams|fn_sched_eta_explain)$/;

export async function api(path, opts = {}, retry = true) {
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && isViewer() && !VIEWER_ALLOWED.test(path)) {
    throw new Error(tr("role.readOnly"));
  }
  const token = await freshToken();
  const r = await fetch(SB_URL + path, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: "Bearer " + token,   // the USER's token, never SB_KEY - see file header
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });

  if (r.status === 401 && retry) {
    try { await refresh(); } catch (e) { throw new Error("NOT_SIGNED_IN"); }
    return api(path, opts, false);
  }

  if (!r.ok) {
    let m = "Request failed (" + r.status + ")";
    try { const j = await r.json(); m = j.message || j.hint || j.details || j.error || m; } catch (e) {}
    const err = new Error(m);
    err.status = r.status;
    throw err;
  }

  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

/* PostgREST caps a response at 1000 rows. v_ops_prep_units alone is ~2,700. */
export async function apiAll(path, pageSize = 1000) {
  const rows = [];
  for (let off = 0; ; off += pageSize) {
    const page = await api(path, { headers: { Range: off + "-" + (off + pageSize - 1) } });
    if (!page || !page.length) break;
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

export function rpc(fn, args) {
  return api("/rest/v1/rpc/" + fn, { method: "POST", body: JSON.stringify(args || {}) });
}

/* ---------------------------------------------------------------- offline write queue
 * Installers are in vans and lifts. Every write goes through here.
 *
 * Safe to replay because every RPC is set-state rather than incremental, and fn_ops_apply_prep
 * derives a deterministic client_op_id per unit so a replayed bulk-apply collides row-for-row and
 * does nothing.
 */
function readQueue(key) {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { return []; }
}
function writeQueue(key, q) {
  try { localStorage.setItem(key, JSON.stringify(q)); } catch (e) {}
  if (key === QUEUE_KEY) emit("queue", q.length);
}

export function queueDepth() { return readQueue(QUEUE_KEY).length; }
export function failedWrites() { return readQueue(FAILED_KEY); }
export function clearFailed() { writeQueue(FAILED_KEY, []); }

export async function submit(fn, args) {
  const item = { id: crypto.randomUUID(), fn, args, ts: Date.now() };
  const q = readQueue(QUEUE_KEY);
  q.push(item);
  writeQueue(QUEUE_KEY, q);
  return flush();
}

/* Take one item out of the queue as it stands NOW, rather than out of a snapshot.
 *
 * submit() appends straight to localStorage and then calls flush(), which returns immediately while
 * an earlier flush is still running - and startQueueWatcher() means one can be in flight at any
 * moment. Writing a snapshot back after an await therefore erases everything queued during that
 * await. With bulk actions that is not one lost tap but a whole batch, and runBulk() would then
 * report success, because queueDepth() reads zero.
 *
 * Removing by id rather than by position keeps this correct however the queue moved underneath. */
function dropQueued(id) {
  const cur = readQueue(QUEUE_KEY).filter((x) => x.id !== id);
  writeQueue(QUEUE_KEY, cur);
  return cur;
}

let flushing = false;
export async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    let q = readQueue(QUEUE_KEY);
    while (q.length) {
      const item = q[0];
      try {
        await rpc(item.fn, item.args);
      } catch (e) {
        if (e.message === "NOT_SIGNED_IN") break;          // keep it queued for after sign-in
        if (e.status && e.status >= 400 && e.status < 500) {
          // a 4xx will never succeed on retry - park it where a human can see it
          const failed = readQueue(FAILED_KEY);
          failed.push({ ...item, error: e.message });
          writeQueue(FAILED_KEY, failed);
          q = dropQueued(item.id);
          continue;
        }
        break;                                              // network/5xx - try again later
      }
      // picks up anything queued while that request was in flight, and drains it too
      q = dropQueued(item.id);
    }
  } finally { flushing = false; }
}

export function startQueueWatcher() {
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) flush(); });
  setInterval(flush, 20000);
}
