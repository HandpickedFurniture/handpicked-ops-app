/* wa-register - points Whapi's webhook at wa-inbound, from inside the project.
 *
 * Whapi's settings endpoint is PATCH, which pg_net cannot issue, and the Supabase CLI that could
 * set a function secret is not installed here - so this tiny function does the one PATCH, reading
 * both secrets from Vault through fn_wa_secret (service role only). It is gated by the same shared
 * secret as wa-inbound: call it as
 *
 *     select public.fn_wa_inbound_admin('{"action":"register"}');   -- or "show"
 *
 * "register" REPLACES Whapi's webhook list with wa-inbound alone (it was empty before 18 Sep 2026);
 * "show" returns the current settings so the result can be checked. Re-run "register" after
 * rotating wa_webhook_secret.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function secret(name: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fn_wa_secret`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_name: name }),
  });
  if (!r.ok) throw new Error(`fn_wa_secret ${r.status}`);
  return String((await r.json()) ?? "");
}
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const given = new URL(req.url).searchParams.get("k") ?? "";
  const want = await secret("wa_webhook_secret").catch(() => "");
  if (!sameSecret(given, want)) return new Response("no", { status: 401 });

  const body = await req.json().catch(() => ({}));
  const token = await secret("whapi_token");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };

  if (body.action === "register") {
    const r = await fetch("https://gate.whapi.cloud/settings", {
      method: "PATCH", headers,
      body: JSON.stringify({
        webhooks: [{
          url: `${SUPABASE_URL}/functions/v1/wa-inbound?k=${want}`,
          events: [{ type: "messages", method: "post" }],
          mode: "body",
        }],
      }),
    });
    const text = await r.text();
    // never echo the URL back: it carries the secret
    return new Response(JSON.stringify({ status: r.status, body: text.replace(want, "<secret>").slice(0, 600) }),
      { headers: { "Content-Type": "application/json" } });
  }
  const r = await fetch("https://gate.whapi.cloud/settings", { headers });
  const text = (await r.text()).replace(want, "<secret>");
  return new Response(JSON.stringify({ status: r.status, body: text.slice(0, 1200) }),
    { headers: { "Content-Type": "application/json" } });
});
