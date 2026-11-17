/* fabric-stock: public API behind fabric-stock.html (17 Nov 2026).
 *
 * Suppliers and staff mark each fabric available yes/no and/or the metres in stock, by hand or by
 * uploading a file. There is NO login yet (access control comes later), so this function is deployed
 * with verify_jwt off and is the only door: it calls three SQL functions with the service role and
 * nothing else. The SQL decides what is a known fabric (v_fabric_master) and skips the rest, caps the
 * row count and text lengths, and logs every save to fabric_stock_status_log so a bad write can be undone.
 *
 *   GET  ?action=suppliers                 -> [{code, fabrics, updated, last_update}]
 *   GET  ?action=list&supplier=FD          -> [{code, roll_width_cm, available, qty_m, note, updated_by, updated_at, ...}]
 *   POST {action:"save", by, source, rows:[{code, available, qty_m, note}]} -> {saved, skipped:[codes]}
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_BODY = 2_000_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<Response> {
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = "Server error";
    try { const e = JSON.parse(text); if (e.code === "P0001" && e.message) msg = e.message; } catch { /* keep generic */ }
    console.error(fn, r.status, text.slice(0, 500));
    return json({ error: msg }, r.status >= 500 ? 502 : 400);
  }
  return new Response(text, { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);

  if (req.method === "GET") {
    const action = url.searchParams.get("action") || "suppliers";
    if (action === "suppliers") return rpc("fn_fabric_stock_suppliers", {});
    if (action === "list") {
      const supplier = (url.searchParams.get("supplier") || "").trim().toUpperCase();
      if (!/^[A-Z]{1,20}$/.test(supplier)) return json({ error: "Pick a supplier" }, 400);
      return rpc("fn_fabric_stock_list", { p_supplier: supplier });
    }
    return json({ error: "Unknown action" }, 400);
  }

  if (req.method === "POST") {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ error: "File too large - split it into smaller files" }, 413);
    let body: { action?: string; by?: string; source?: string; rows?: unknown };
    try { body = JSON.parse(raw); } catch { return json({ error: "Bad request" }, 400); }
    if (body.action !== "save") return json({ error: "Unknown action" }, 400);
    if (!Array.isArray(body.rows)) return json({ error: "Nothing to save" }, 400);
    return rpc("fn_fabric_stock_save", {
      p_rows: body.rows,
      p_by: typeof body.by === "string" ? body.by : "",
      p_source: body.source === "upload" ? "upload" : "app",
    });
  }

  return json({ error: "Method not allowed" }, 405);
});
