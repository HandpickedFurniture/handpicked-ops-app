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
const listeners = { session: [], queue: [], failed: [] };

export function onSession(fn) { listeners.session.push(fn); }
export function onQueue(fn) { listeners.queue.push(fn); }
/* Fires the moment a write is given up on. A parked write is the ONE case where somebody's input is
 * genuinely gone unless a human does something, so it is announced rather than left in a list
 * nobody opens. */
export function onFailed(fn) { listeners.failed.push(fn); }
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

/* "May not write", not "is the viewer role" - the same test fn_is_viewer() makes in the database, so
 * the two can never disagree about who is read-only. A role added later is read-only by default.
 *
 * An UNKNOWN role (null - lookup failed, or no app_roles row) is treated as ops, matching
 * fn_is_viewer()'s own default. Reversing that would lock a coordinator out of their own job because
 * one request failed on a lift's worth of signal. */
export function isViewer() { return role !== null && role !== "ops"; }

/* Read-only AND pointed at Production alone - see ROLE_ROUTES in app.js. */
export function isProdViewer() { return role === "prod_viewer"; }

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

/* The access token, refreshed if it is within two minutes of expiring - for the calls that do NOT
 * go through api(): the three Edge Functions and the storage endpoints, which PostgREST does not
 * serve and which therefore never saw freshToken().
 *
 * Those call sites read getSession().access_token straight off the module, which is the token as it
 * was when the tab loaded. api() has always refreshed proactively AND retried a 401 once; they did
 * neither. So about an hour into a shift Chotu began answering "unavailable (401)" while every
 * other screen carried on working - because every other screen was refreshing and these were not.
 */
export async function accessToken() { return freshToken(); }

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
/* fn_chotu_context is the same case: a `stable` read that PostgREST only exposes as POST /rpc, and
 * asking Chotu questions is precisely what a viewer should be able to do. Every RPC Chotu COMMITS
 * with is deliberately absent, so a viewer's Commit button is refused here and again by RLS.
 *
 * fn_order_drawer belongs here for a blunter reason: without it a read-only account cannot open a
 * single order. It assembles the whole drawer - receiving, production units, dispatch, alerts,
 * comments, emails - in one `stable` call with no DML in it, and it is reached by POST purely
 * because that is the only verb PostgREST gives an RPC. Leaving it out made "view only" mean "view
 * the list and nothing in it", which is not a role anybody wanted. */
const VIEWER_ALLOWED =
  /\/rpc\/(fn_order_drawer|fn_ops_rate_for|fn_ops_log_photo_access|fn_chotu_context|fn_sched_board|fn_sched_run_for|fn_sched_next_working_day|fn_sched_suggest_teams|fn_sched_eta_explain)$/;

/* NOTHING may hang forever.
 *
 * fetch() has no default timeout, and a request that hangs neither resolves nor rejects - a captive
 * portal, a lift, a proxy that accepts the connection and then says nothing. That is not a slow
 * write, it is a FROZEN one, and it takes the whole queue with it: drain() waits on it, so the
 * in-flight flush promise never settles, so every later flush - including the Sync now button -
 * waits on that same dead promise and does nothing at all, forever. Tapping Sync repeatedly is the
 * symptom.
 *
 * An abort surfaces with no HTTP status, which the queue already reads as "no signal, try later" -
 * exactly right. Every write here is set-state and replay-safe, so giving up early costs nothing;
 * hanging costs everything. */
const REQUEST_TIMEOUT_MS = 20000;

export async function api(path, opts = {}, retry = true) {
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && isViewer() && !VIEWER_ALLOWED.test(path)) {
    /* `permanent` matters when this comes back to the queue: retrying a refusal forever would block
     * every write behind it. Marked rather than inferred, because a refusal thrown BEFORE any fetch
     * looks exactly like a network failure from the outside - neither carries an HTTP status. */
    const err = new Error(tr("role.readOnly"));
    err.permanent = true;
    throw err;
  }
  const token = await freshToken();

  // AbortController rather than AbortSignal.timeout(): the workshop has iPhones older than Safari 16
  const ctl = new AbortController();
  const bell = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(SB_URL + path, {
      /* PostgREST sends NO Cache-Control and no ETag, which leaves a GET open to the browser's
       * heuristic caching. That is how a stock level updated on a phone can still read the old number
       * on a laptop that had the page open earlier: the laptop never asked. A data API must never be
       * heuristically cacheable, so say so explicitly rather than hoping. */
      cache: "no-store",
      signal: ctl.signal,
      ...opts,
      headers: {
        apikey: SB_KEY,
        Authorization: "Bearer " + token,   // the USER's token, never SB_KEY - see file header
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
  } catch (e) {
    // say which it was, because "timed out" and "no signal" send somebody to different places
    const err = new Error(e && e.name === "AbortError" ? tr("t.timedOut") : tr("t.noNetwork"));
    err.offline = true;                 // no HTTP status: the queue retries these forever
    throw err;
  } finally {
    clearTimeout(bell);
  }

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
  // both lists drive the header badge, so both have to announce themselves
  emit("queue", readQueue(QUEUE_KEY).length);
}

export function queueDepth() { return readQueue(QUEUE_KEY).length; }
/* What is still waiting, so the queue tray can show WHAT is stuck rather than only how many. */
export function pendingWrites() { return readQueue(QUEUE_KEY); }
export function failedWrites() { return readQueue(FAILED_KEY); }
export function clearFailed() { writeQueue(FAILED_KEY, []); }

/* Put every parked write back in the queue and try again. What the failed-writes tray calls. */
export function retryFailed() {
  const failed = readQueue(FAILED_KEY);
  if (failed.length) {
    writeQueue(QUEUE_KEY,
      readQueue(QUEUE_KEY).concat(failed.map((f) => ({ ...f, tries: 0, error: undefined }))));
    writeQueue(FAILED_KEY, []);
  }
  return flush();
}

/* Queue a write and WAIT for it to actually go, reporting what happened to THIS item.
 *
 * It used to `return flush()`, and flush() returned undefined the moment another flush was already
 * running. So `await submit(...)` resolved immediately, and the caller - every caller - then read
 * queueDepth() to decide what to say. Two consequences, both of which people were seeing:
 *
 *   * the toast said "Saved - will sync when back online" WHILE ONLINE, because the item genuinely
 *     was still sitting in the queue at the instant it looked;
 *   * the caller's reload() re-read the server before the write landed, so the row came back with
 *     its old value and the tick appeared to bounce off.
 *
 * Nothing was usually lost - the queue drained a moment later - but it looked exactly like lost
 * input, and the faster somebody ticked down a list the more often it happened. flush() now hands
 * back its in-flight promise, so awaiting this genuinely waits, and the answer below is about this
 * item rather than about a global counter that anything could have moved.
 */
export async function submit(fn, args) {
  const item = { id: crypto.randomUUID(), fn, args, ts: Date.now(), tries: 0 };
  writeQueue(QUEUE_KEY, readQueue(QUEUE_KEY).concat([item]));

  await flush();

  if (readQueue(QUEUE_KEY).some((x) => x.id === item.id)) return { status: "queued", id: item.id };
  const bad = readQueue(FAILED_KEY).find((x) => x.id === item.id);
  return bad ? { status: "failed", id: item.id, error: bad.error } : { status: "sent", id: item.id };
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

/* A server error that keeps happening must not hold the queue hostage. Five attempts across five
 * flushes is about a hundred seconds of trying; after that the item is parked so everything behind
 * it can go. A genuinely OFFLINE item is never counted against this - see below. */
const MAX_TRIES = 5;

function park(item, message) {
  writeQueue(FAILED_KEY, readQueue(FAILED_KEY).concat([{ ...item, error: message }]));
  emit("failed", message);
}

/* ONE flush at a time, and everyone waits on the same one.
 *
 * Returning the in-flight promise rather than undefined is what makes `await submit(...)` mean
 * something. The loop re-reads the queue on every pass, so an item appended by a caller that joined
 * a run already in progress is still picked up by that run. */
let flushing = null;

export function flush() {
  if (flushing) return flushing;
  flushing = drain().finally(() => { flushing = null; });
  return flushing;
}

/* Walks the queue by INDEX, not by always retrying the head.
 *
 * The head-of-line problem is the one that strands people: eighteen good writes sitting behind one
 * the server keeps rejecting, none of them going anywhere. A write that fails for a reason SPECIFIC
 * to it now steps aside and lets everything behind it through. Only a genuine network failure stops
 * the run, and it should - if there is no signal, the next seventeen will not go either. */
async function drain() {
  let q = readQueue(QUEUE_KEY);
  let i = 0;
  while (i < q.length) {
    const item = q[i];
    try {
      await rpc(item.fn, item.args);
    } catch (e) {
      if (e.message === "NOT_SIGNED_IN") break;          // keep it queued for after sign-in

      /* THE ONLY reason to keep an item at the head and stop is that the network is gone. Everything
       * else is about this one write and must let the rest through.
       *
       * That distinction was drawn too narrowly once already and it cost days: only 4xx was treated
       * as permanent, so a PGRST203 - HTTP 300, "could not choose the best candidate function",
       * caused by a duplicated RPC overload - fell through to the offline branch. It was retried
       * forever at the head of the queue and stranded 33 real writes behind it. Any answer the
       * server actually gave that is not a 5xx will say the same thing next time. */
      if (e.offline) {
        /* No signal, or the request timed out. RECORD WHY before stopping: a queue that says
         * "18 waiting" and cannot say what it is waiting on is a queue nobody can diagnose. */
        writeQueue(QUEUE_KEY, readQueue(QUEUE_KEY)
          .map((x) => (x.id === item.id ? { ...x, lastError: e.message, lastTry: Date.now() } : x)));
        break;
      }
      if (e.status >= 500) {
        // the server broke. Worth retrying, but not forever, and not at everyone else's expense
        const tries = (item.tries || 0) + 1;
        if (tries >= MAX_TRIES) { park(item, e.message); q = dropQueued(item.id); continue; }
        // persist the count, or every flush would start again from one and this would never park
        writeQueue(QUEUE_KEY, readQueue(QUEUE_KEY)
          .map((x) => (x.id === item.id ? { ...x, tries, lastError: e.message } : x)));
        q = readQueue(QUEUE_KEY);
        i++;                       // leave it queued, but do not let it hold up the rest
        continue;
      }
      // refused before it left the browser, or any 3xx/4xx: it will never succeed. Park it.
      park(item, e.message);
      q = dropQueued(item.id);     // the next item slides into this index
      continue;
    }
    // picks up anything queued while that request was in flight, and drains it too
    q = dropQueued(item.id);
  }
}

/* Try often while something is waiting, rarely when there is nothing to do.
 *
 * It used to be a flat 20-second interval, so a phone that came out of a lift with six ticks queued
 * sat for up to another twenty seconds before anything moved - and that wait is exactly when
 * somebody is standing there watching the number and concluding it is broken. Five seconds while the
 * queue has anything in it, thirty when it is empty, plus every event that means "the network might
 * be back": coming online, returning to the tab, refocusing the window, and page restore from the
 * back/forward cache, which fires no other event on iOS. */
const POLL_BUSY = 5000;
const POLL_IDLE = 30000;

export function startQueueWatcher() {
  const now = () => { flush(); };
  window.addEventListener("online", now);
  window.addEventListener("focus", now);
  window.addEventListener("pageshow", now);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) flush(); });

  const tick = async () => {
    try { await flush(); } catch (e) { /* the next tick tries again */ }
    setTimeout(tick, queueDepth() ? POLL_BUSY : POLL_IDLE);
  };
  setTimeout(tick, POLL_BUSY);
}
