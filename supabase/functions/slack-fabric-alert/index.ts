/* slack-fabric-alert - posts the "fabric not received" alerts into each order's Make.com Slack thread.
 *
 * Called by pg_cron through public.fn_fabric_alert_run(stage) at 11:00 / 14:00 / 17:00 Dubai, gated by
 * the fabric_alert_secret shared secret (?k=), the same pattern as wa-register. The SQL decides WHAT to
 * say (fn_fabric_alert_batch: next working day, Order-flagged rows only, fabric not received); this
 * function only decides WHERE:
 *
 *   1. order_slack_threads cache  ->  2. scan conversations.history of the configured channels for a
 *   TOP-LEVEL message posted by the Make.com bot whose text carries the order number (oldest wins -
 *   that is the thread Make created with the order)  ->  3. chat.postMessage with thread_ts.
 *
 * Only Make.com parents count: a thread a person started about the same order is never used.
 * Results go back to fn_fabric_alert_record, which logs them (one SENT per order/stage/day) and sends
 * Admin alerts a WhatsApp for any order with no Make thread or a Slack error.
 *
 * Body: {stage: "follow_up_1"|"follow_up_2"|"red_alert", dry_run?: bool, date?: "YYYY-MM-DD"}
 * dry_run finds the threads but posts nothing; without a Slack token it just returns the texts.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STAGES = ["follow_up_1", "follow_up_2", "red_alert"];

type Row = { install_date: string; order_id: string; city: string; customer_name: string; body: string };
type Thread = { channel: string; ts: string };
type Result = { order_id: string; status: string; channel?: string; thread_ts?: string;
                message_ts?: string; body: string; detail?: string };

async function rpc(fn: string, args: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function select(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// The SQL text is plain ("<Automated Alert> ..."); Slack's API treats < > as link syntax, so escape them.
const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

async function slack(token: string, method: string, params: Record<string, unknown>, post = false): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = post
      ? await fetch(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(params),
        })
      : await fetch(`https://slack.com/api/${method}?` +
          new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])),
          { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 429) { await sleep(1000 * Number(r.headers.get("Retry-After") ?? "2")); continue; }
    return r.json();
  }
  return { ok: false, error: "rate_limited" };
}

/** Everything a Make.com message can carry its text in: text, attachments, blocks. */
function messageText(m: any): string {
  const parts: string[] = [m.text ?? ""];
  for (const a of m.attachments ?? []) {
    parts.push(a.title ?? "", a.text ?? "", a.pretext ?? "", a.fallback ?? "");
    for (const f of a.fields ?? []) parts.push(f.title ?? "", f.value ?? "");
  }
  const walk = (b: any) => {
    if (!b || typeof b !== "object") return;
    if (typeof b.text === "string") parts.push(b.text);
    for (const v of Object.values(b)) if (typeof v === "object") walk(v);
  };
  for (const b of m.blocks ?? []) walk(b);
  return parts.join("\n");
}

function isMake(m: any, makeIds: string[]): boolean {
  if (!m.bot_id && !m.app_id) return false;
  if (makeIds.length) return makeIds.includes(m.bot_id) || makeIds.includes(m.app_id);
  const name = `${m.bot_profile?.name ?? ""} ${m.username ?? ""}`;
  return /\b(make|integromat)\b/i.test(name);
}

/** One scan per run, only for orders the cache doesn't know. Oldest Make parent per order wins. */
async function scanThreads(token: string, channels: string[], makeIds: string[], lookbackDays: number,
                           wanted: string[]): Promise<Map<string, Thread>> {
  const found = new Map<string, Thread>();
  const oldest = String(Math.floor(Date.now() / 1000) - lookbackDays * 86400);
  const patterns = wanted.map((id) => [id, new RegExp(`(^|\\D)${id}(\\D|$)`)] as const);
  for (const channel of channels) {
    let cursor = "";
    do {
      const page = await slack(token, "conversations.history",
        { channel, oldest, limit: 200, ...(cursor ? { cursor } : {}) });
      if (!page.ok) throw new Error(`conversations.history ${channel}: ${page.error}`);
      for (const m of page.messages ?? []) {
        if (m.thread_ts && m.thread_ts !== m.ts) continue; // a reply, not a parent
        if (!isMake(m, makeIds)) continue;
        const text = messageText(m);
        for (const [id, re] of patterns) {
          if (!re.test(text)) continue;
          const prev = found.get(id);
          if (!prev || Number(m.ts) < Number(prev.ts)) found.set(id, { channel, ts: m.ts });
        }
      }
      cursor = page.response_metadata?.next_cursor ?? "";
    } while (cursor);
  }
  return found;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const want = String(await rpc("fn_slack_secret", { p_name: "fabric_alert_secret" }).catch(() => "") ?? "");
  if (!sameSecret(new URL(req.url).searchParams.get("k") ?? "", want)) return new Response("no", { status: 401 });

  const body = await req.json().catch(() => ({}));
  const stage = String(body.stage ?? "");
  const dryRun = body.dry_run === true;
  if (!STAGES.includes(stage)) return new Response(`bad stage ${stage}`, { status: 400 });

  const rows: Row[] = await rpc("fn_fabric_alert_batch",
    { p_stage: stage, p_install_date: body.date ?? null, p_force: dryRun });
  const json = (o: unknown) => new Response(JSON.stringify(o, null, 1), { headers: { "Content-Type": "application/json" } });
  if (!rows.length) return json({ stage, orders: 0, note: "nothing pending" });
  const installDate = rows[0].install_date;

  const token = String(await rpc("fn_slack_secret", { p_name: "slack_bot_token" }).catch(() => "") ?? "");
  const cfg = Object.fromEntries((await select("slack_config?select=k,v")).map((r: any) => [r.k, r.v]));
  const channels = list(cfg.fabric_alert_channels);
  if (!token || !channels.length) {
    const why = !token ? "slack_bot_token is not in Vault" : "slack_config.fabric_alert_channels is empty";
    if (dryRun) return json({ stage, install_date: installDate, not_configured: why, texts: rows });
    const results: Result[] = rows.map((r) => ({ order_id: r.order_id, status: "error", body: r.body, detail: why }));
    await rpc("fn_fabric_alert_record", { p_stage: stage, p_install_date: installDate, p_results: results });
    return json({ stage, error: why });
  }

  // 1. cache, 2. scan for the rest
  const ids = rows.map((r) => r.order_id);
  const cached = await select(`order_slack_threads?select=order_id,channel,thread_ts&order_id=in.(${ids.join(",")})`);
  const threads = new Map<string, Thread>(cached.map((c: any) => [c.order_id, { channel: c.channel, ts: c.thread_ts }]));
  const missing = ids.filter((id) => !threads.has(id));
  if (missing.length) {
    try {
      const found = await scanThreads(token, channels, list(cfg.make_bot_ids),
                                      Number(cfg.thread_lookback_days || 75), missing);
      for (const [id, t] of found) threads.set(id, t);
    } catch (e) {
      const results: Result[] = rows.map((r) => ({ order_id: r.order_id, status: "error", body: r.body,
                                                   detail: String((e as Error).message) }));
      if (!dryRun) await rpc("fn_fabric_alert_record", { p_stage: stage, p_install_date: installDate, p_results: results });
      return json({ stage, error: String((e as Error).message) });
    }
  }

  // 3. post
  const results: Result[] = [];
  for (const r of rows) {
    const t = threads.get(r.order_id);
    if (!t) { results.push({ order_id: r.order_id, status: "no_thread", body: r.body }); continue; }
    if (dryRun) {
      results.push({ order_id: r.order_id, status: "dry_run", channel: t.channel, thread_ts: t.ts, body: r.body });
      continue;
    }
    const res = await slack(token, "chat.postMessage",
      { channel: t.channel, thread_ts: t.ts, text: slackEscape(r.body), unfurl_links: false, unfurl_media: false }, true);
    results.push(res.ok
      ? { order_id: r.order_id, status: "sent", channel: t.channel, thread_ts: t.ts, message_ts: res.ts, body: r.body }
      : { order_id: r.order_id, status: "error", channel: t.channel, thread_ts: t.ts, body: r.body,
          detail: `chat.postMessage: ${res.error}` });
    await sleep(1100); // chat.postMessage is ~1/s per channel
  }

  // a dry run logs only the threads it found (worth caching) - its misses must not page Admin alerts
  const recorded = await rpc("fn_fabric_alert_record", { p_stage: stage, p_install_date: installDate,
    p_results: dryRun ? results.filter((x) => x.status === "dry_run") : results });
  return json({ stage, install_date: installDate, dry_run: dryRun, recorded, results });
});
