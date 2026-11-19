/* punctuality-sync: copies the Tookan arrival sheets into punctuality_job (Punctuality module, #/punctuality).
 * 18 Nov 2026.
 *
 * One Google Sheet, one tab per vertical + city (listed in punctuality_source, so a new tab is an insert,
 * not a deploy). Each tab is a Tookan export, one row per task: date, week, fleet_id, agent, job_id,
 * order_id, slot, arrived, minutes_late, on_time, outcome, first_visit. The tabs are shared "anyone with
 * the link", so the public CSV export is read with no credentials.
 *
 * Called every 3 hours by pg_cron through fn_punct_run_sync(), and by the Refresh button on the same
 * path. The anon key is public, so the real gate is the x-sync-key header, a Vault secret only
 * fn_punct_run_sync() holds. The sheet is untrusted text: every value is parsed to a fixed type, and a
 * tab whose header is not the expected one is refused untouched rather than half-read.
 *
 * Rows that have left the sheet are removed, but never on a thin read: if the tab came back with less than
 * half the rows already stored, nothing is deleted and the run says so.
 */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sbHeaders = { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" };
async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    ...init, headers: { ...sbHeaders, ...(init.headers as Record<string, string> ?? {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error("db " + r.status + " " + path.slice(0, 40) + ": " + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
const rpc = (fn: string, args: unknown = {}) => sb("rpc/" + fn, { method: "POST", body: JSON.stringify(args) });

const sameSecret = (a: string, b: string) => {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

const NEEDED = ["date", "fleet_id", "agent", "job_id", "slot", "minutes_late", "outcome", "first_visit"];

/* RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

const tidy = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();
const isoDay = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(tidy(s)) ? tidy(s) : null);

/* "Handpicked  T1", "handpicked t10", "Handpicked 11", "Handpicked Floorz1" -> T1, T10, T11, Floorz1. */
function labelOf(agent: string): string | null {
  const a = tidy(agent).replace(/^handpicked[\s-]*/i, "");
  let m = a.match(/^t\s*(\d+)$/i);
  if (m) return "T" + Number(m[1]);
  m = a.match(/^(\d+)$/);
  if (m) return "T" + Number(m[1]);
  m = a.match(/^floorz\s*(\d+)$/i);
  if (m) return "Floorz" + Number(m[1]);
  return null;
}

type Src = { source: string; vertical: string; city: string; sheet_id: string; gid: string };

async function readTab(s: Src) {
  const url = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(s.sheet_id) +
    "/export?format=csv&gid=" + encodeURIComponent(s.gid);
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error("sheet " + r.status + " (is it still shared with anyone who has the link?)");
  const grid = parseCsv(await r.text());
  const head = (grid[0] ?? []).map((h) => tidy(h).toLowerCase());
  const missing = NEEDED.filter((h) => !head.includes(h));
  if (missing.length) throw new Error("unexpected header, missing: " + missing.join(", "));
  const col = (name: string) => head.indexOf(name);
  const g = (r: string[], name: string) => { const i = col(name); return i < 0 ? "" : tidy(r[i] ?? ""); };

  // fleet_id -> the T-label / Floorz-label most of its rows carry (so "Ejaz Ahmad" becomes T5)
  const votes = new Map<string, Map<string, number>>();
  const lastAgent = new Map<string, string>();
  for (const r of grid.slice(1)) {
    const f = g(r, "fleet_id"), a = g(r, "agent");
    if (!f) continue;
    lastAgent.set(f, a);
    const l = labelOf(a);
    if (l) { const m = votes.get(f) ?? new Map(); m.set(l, (m.get(l) ?? 0) + 1); votes.set(f, m); }
  }
  const teamOf = new Map<string, string>();
  for (const [f, a] of lastAgent) {
    const m = votes.get(f);
    teamOf.set(f, m ? [...m.entries()].sort((x, y) => y[1] - x[1])[0][0] : (labelOf(a) ?? a));
  }

  const out: Record<string, unknown>[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const r of grid.slice(1)) {
    const job = g(r, "job_id"), day = isoDay(g(r, "date"));
    if (!job || !day || seen.has(job)) { skipped++; continue; }
    seen.add(job);
    const ml = g(r, "minutes_late");
    const fv = g(r, "first_visit").toLowerCase();
    const fleet = g(r, "fleet_id");
    out.push({
      source: s.source, job_id: job, day, week: isoDay(g(r, "week")),
      fleet_id: fleet || null, agent_raw: g(r, "agent") || null, team: teamOf.get(fleet) ?? (g(r, "agent") || null),
      order_id: g(r, "order_id") || null, slot: g(r, "slot") || null, arrived: g(r, "arrived") || null,
      minutes_late: /^-?\d+$/.test(ml) ? Number(ml) : null,
      outcome: g(r, "outcome") || null, first_visit: ["yes", "no", "n/a"].includes(fv) ? fv : null,
    });
  }
  return { rows: out, skipped };
}

Deno.serve(async (req) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty is fine */ }
  try {
    const want = String(await rpc("fn_wa_secret", { p_name: "punctuality_sync_secret" }) ?? "");
    if (!sameSecret(req.headers.get("x-sync-key") ?? "", want)) return new Response("forbidden", { status: 403 });
  } catch (e) {
    return new Response("could not check the key: " + String(e), { status: 500 });
  }

  const started = new Date().toISOString();
  const stats: Record<string, unknown> = {};
  const errors: string[] = [];
  const sources: Src[] = await sb("punctuality_source?active=eq.true&select=source,vertical,city,sheet_id,gid");

  for (const s of sources) {
    try {
      const { rows, skipped } = await readTab(s);
      if (!rows.length) throw new Error("the tab came back with no usable rows");
      const stamp = new Date().toISOString();
      for (const r of rows) r.synced_at = stamp;
      for (let i = 0; i < rows.length; i += 500) {
        await sb("punctuality_job?on_conflict=source,job_id", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(rows.slice(i, i + 500)),
        });
      }
      // rows that have left the sheet (every row just upserted carries `stamp`, so older ones are gone)
      const had = await sb("punctuality_job?source=eq." + encodeURIComponent(s.source) + "&select=job_id&synced_at=lt." + encodeURIComponent(stamp) + "&limit=5000");
      let removed = 0;
      if ((had ?? []).length) {
        // `had` = stored rows the sheet no longer has. More gone than present means the read is thin.
        if ((had ?? []).length > rows.length) {
          stats[s.source + "_warning"] = "thin read, " + (had ?? []).length + " old rows kept";
        } else {
          await sb("punctuality_job?source=eq." + encodeURIComponent(s.source) + "&synced_at=lt." + encodeURIComponent(stamp), { method: "DELETE" });
          removed = (had ?? []).length;
        }
      }
      stats[s.source] = { rows: rows.length, skipped, removed };
      await sb("punctuality_source?source=eq." + encodeURIComponent(s.source), {
        method: "PATCH", body: JSON.stringify({ last_read_at: stamp, last_rows: rows.length, last_error: null }),
      });
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 300);
      errors.push(s.source + ": " + msg);
      stats[s.source] = { error: msg };
      try {
        await sb("punctuality_source?source=eq." + encodeURIComponent(s.source), {
          method: "PATCH", body: JSON.stringify({ last_error: msg }),
        });
      } catch { /* the run row below still records it */ }
    }
  }

  await sb("punctuality_sync_run", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ at: new Date().toISOString(), trigger: String(body.trigger ?? "manual"), stats, error: errors.join(" | ") || null }),
  });
  return new Response(JSON.stringify({ started, stats, errors }), { status: errors.length ? 207 : 200, headers: { "Content-Type": "application/json" } });
});
