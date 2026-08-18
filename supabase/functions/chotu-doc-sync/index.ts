/* Push new chotu_log rows into the Google Doc.
 *
 * THE DOC IS A COPY, NOT THE RECORD. chotu_log is the source of truth: phones are offline in a
 * workshop and a webhook cannot be, so a capture is written to the database first - through the
 * offline queue, replay-safe on `op` - and pushed here afterwards. Everything about this function
 * follows from that:
 *
 *   - synced_at is the whole protocol. Null means not yet in the Doc. A row is only stamped AFTER
 *     the webhook says it wrote, so a failed push leaves the rows to go out next time rather than
 *     losing them quietly.
 *   - It is idempotent to re-run and safe to run on a schedule. Nothing here writes order data.
 *   - If the Doc is deleted, misconfigured or the script is broken, the log is unaffected. The
 *     worst case is that the Doc falls behind, which is visible: unsynced_remaining says by how
 *     much.
 *
 * WHY IT READS WITH THE SERVICE ROLE. There is no user on a cron run, and chotu_log's RLS is
 * written for people. The function is not public - it demands CHOTU_SYNC_SECRET before it does
 * anything - and it only ever reads chotu_log and stamps synced_at.
 *
 * Secrets:
 *   CHOTU_DOC_WEBHOOK  the Apps Script /exec URL
 *   CHOTU_DOC_TOKEN    the shared string in the Apps Script's TOKEN constant
 *   CHOTU_SYNC_SECRET  what a caller must present to trigger this function
 *
 * Deploy:
 *   supabase functions deploy chotu-doc-sync
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "";

function envLike(...wanted: string[]): string {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  const want = wanted.map(norm);
  let all: Record<string, string> = {};
  try { all = Deno.env.toObject(); } catch { return ""; }
  for (const [k, v] of Object.entries(all)) {
    if (v && want.includes(norm(k))) return v;
  }
  return "";
}

const WEBHOOK = envLike("CHOTU_DOC_WEBHOOK");
const DOC_TOKEN = envLike("CHOTU_DOC_TOKEN");
const SYNC_SECRET = envLike("CHOTU_SYNC_SECRET");

/* Apps Script web apps have a wall-clock execution limit and this writes into a document, which is
 * not fast. A hundred entries a run is comfortably inside it, and a backlog simply drains over
 * several runs rather than timing out forever on the first one. */
const BATCH = 100;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!SYNC_SECRET) return json({ error: "CHOTU_SYNC_SECRET is not set on this project" }, 500);
  const authz = req.headers.get("Authorization") ?? "";
  if (authz !== `Bearer ${SYNC_SECRET}`) return json({ error: "Not authorised" }, 401);

  if (!WEBHOOK || !DOC_TOKEN) {
    return json({ error: "CHOTU_DOC_WEBHOOK / CHOTU_DOC_TOKEN are not set" }, 500);
  }
  if (!SERVICE_KEY) return json({ error: "no service role key available" }, 500);

  const sb = (path: string, init: RequestInit = {}) =>
    fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  // oldest first, so the Doc reads in the order things actually happened
  let rows: Record<string, unknown>[];
  try {
    const r = await sb(
      "chotu_log?select=id,order_id,order_known,said,say,intent,committed,actor,speaker,created_at" +
      `&synced_at=is.null&order=created_at.asc&limit=${BATCH}`);
    if (!r.ok) throw new Error(`read ${r.status}: ${(await r.text()).slice(0, 200)}`);
    rows = await r.json();
  } catch (e) {
    return json({ error: String(e) }, 502);
  }

  if (!rows.length) return json({ ok: true, pushed: 0, unsynced_remaining: 0 });

  const dubai = (iso: string) => {
    // the people reading this Doc are in Dubai; UTC timestamps would need translating in their head
    const d = new Date(iso);
    const s = d.toLocaleString("sv-SE", { timeZone: "Asia/Dubai" });   // YYYY-MM-DD HH:MM:SS
    return s.slice(0, 16);
  };

  const entries = rows.map((r) => ({
    at: dubai(String(r.created_at)),
    who: (r.speaker as string) || (r.actor as string) || "unknown",
    order_id: r.order_id,
    matched: r.order_known,
    said: r.said,
    i_said: r.say,
    intent: r.intent,
    saved: r.committed,
  }));

  let wrote = 0;
  try {
    const r = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: DOC_TOKEN, entries }),
      redirect: "follow",              // Apps Script /exec answers via a redirect
    });
    const text = await r.text();
    let out: { ok?: boolean; written?: number; error?: string } = {};
    try { out = JSON.parse(text); } catch { /* HTML means the deployment is wrong, see below */ }

    if (!r.ok || out.ok !== true) {
      /* An HTML body here almost always means the web app is deployed as "Only myself" and Google
       * served a sign-in page instead of running the script. Say so rather than returning a wall
       * of markup. */
      const hint = text.trim().startsWith("<")
        ? "the webhook returned a login page - redeploy the Apps Script with access set to Anyone"
        : (out.error || text.slice(0, 200));
      return json({ error: `webhook refused: ${hint}`, pushed: 0 }, 502);
    }
    wrote = out.written ?? entries.length;
  } catch (e) {
    return json({ error: `webhook unreachable: ${String(e)}`, pushed: 0 }, 502);
  }

  /* Stamped only now. If this call fails the rows go out again next run and appear twice in the
   * Doc - which is a duplicate somebody can see and delete, where the other order of operations
   * loses the entry entirely and nobody ever knows. */
  try {
    const ids = rows.map((r) => r.id);
    const r = await sb("rpc/fn_chotu_log_mark_synced", {
      method: "POST",
      body: JSON.stringify({ p_ids: ids }),
    });
    if (!r.ok) throw new Error(`mark ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    return json({ ok: false, pushed: wrote, warning: `written to the Doc but not stamped: ${e}` });
  }

  let remaining = 0;
  try {
    const r = await sb("chotu_log?select=id&synced_at=is.null&limit=1000");
    if (r.ok) remaining = ((await r.json()) as unknown[]).length;
  } catch { /* the count is a courtesy, not the job */ }

  return json({ ok: true, pushed: wrote, unsynced_remaining: remaining });
});
