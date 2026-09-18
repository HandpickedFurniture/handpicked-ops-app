/* wa-inbound - WhatsApp as a way in to Chotu.
 *
 * Whapi posts every message the business number receives to this function. For a sender on the
 * allowlist (whatsapp_sender / fn_wa_sender) it runs the SAME brain the app's voice screen uses -
 * the `chotu` function: grounded facts -> closed intents -> server-side validation - over their
 * text or voice note, replies with the proposed card, and commits ONLY when they answer YES.
 * Scoped with the user on 8 Sep 2026, built 18 Sep 2026.
 *
 * Five capabilities, each a separate boolean on the sender's row, all defaulting to false:
 *   can_receive_fabric    fabric_received     -> fn_ops_set_receiving
 *   can_receive_material  material_received   -> fn_ops_set_receiving
 *   can_order_status      order_status / add_visit / order_issue / order_edit -> fn_ops_save_visit
 *   can_adjustment        adjustment          -> fn_ops_add_adjustment (+ fn_ops_save_visit)
 *   can_track             answer              -> a reply, nothing written, no confirmation asked
 * Every other Chotu intent (stacking, prep stages, rails, tailors, stock, handovers) is refused
 * here with "use the app" - a phone in a van is not where those are done.
 *
 * THE ALLOWLIST IS THE AUTHORIZATION BOUNDARY. This function writes with the service role, which
 * bypasses RLS; in the app fn_is_viewer() is the gate, over WhatsApp nothing but whatsapp_sender
 * is. An unlisted number gets no reply at all - not even "you are not allowed" - so the business
 * number does not confirm to strangers that it listens.
 *
 * Which chats: a 1:1 chat with the business number, or a reply in one of our groups that QUOTES an
 * alert we sent (order_notifications.provider_message_id names the order). Ordinary group chatter
 * is ignored; a running conversation in "Installation alerts" is not a stream of instructions.
 *
 * Trust: verify_jwt is OFF (Whapi cannot sign a Supabase JWT), so the URL carries a shared secret
 * (?k=...) generated inside Vault and compared in constant time. The Whapi token comes from the
 * same Vault through fn_wa_secret, callable by the service role only.
 *
 * Deploy: through the Supabase MCP (deploy_edge_function, verify_jwt: false) - see README.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WHAPI = "https://gate.whapi.cloud";
const PENDING_MINUTES = 30;      // a YES to a card older than this is not a confirmation
const MAX_AGE_MINUTES = 20;      // a webhook delivery older than this is a retry of old news
const ORDER_RE = /\b\d{5}\b/;    // every order id is exactly five digits (see mod-chotu.js orderIn)

/* Same helper as chotu/sched-ask: the dashboard lets a secret be saved as "Gemini API Key". */
function envLike(...wanted: string[]): string {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  const want = wanted.map(norm);
  let all: Record<string, string> = {};
  try { all = Deno.env.toObject(); } catch { return ""; }
  for (const [k, v] of Object.entries(all)) if (v && want.includes(norm(k))) return v;
  return "";
}
const GEMINI_KEY = envLike("GEMINI_API_KEY", "LLM_API_KEY", "GOOGLE_API_KEY");
const MODEL = envLike("LLM_MODEL", "GEMINI_MODEL") || "gemini-3.7-flash";

/* ------------------------------------------------------------------ Supabase, as the service role */
const sbHeaders = () => ({
  apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json",
});
async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init, headers: { ...sbHeaders(), ...(init.headers as Record<string, string> ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path.split("?")[0]} ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const rpc = (fn: string, args: Record<string, unknown>) =>
  sb(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const secrets: Record<string, string> = {};
async function secret(name: string): Promise<string> {
  if (!secrets[name]) secrets[name] = String((await rpc("fn_wa_secret", { p_name: name })) ?? "");
  return secrets[name];
}

/* Constant-time string compare, so the secret cannot be guessed a byte at a time. */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ Whapi */
async function whapi(path: string, init: RequestInit = {}) {
  const tok = await secret("whapi_token");
  return fetch(`${WHAPI}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/json",
               ...(init.body ? { "Content-Type": "application/json" } : {}),
               ...(init.headers as Record<string, string> ?? {}) },
  });
}
async function sendText(to: string, body: string, quoted?: string) {
  const r = await whapi("/messages/text", {
    method: "POST", body: JSON.stringify({ to, body, ...(quoted ? { quoted } : {}) }),
  });
  if (!r.ok) throw new Error(`whapi text ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json().catch(() => ({}));
  return j?.message?.id ?? "";
}
async function mediaBytes(id: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const r = await whapi(`/media/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`whapi media ${r.status}`);
  const mime = (r.headers.get("content-type") ?? "audio/ogg").split(";")[0].trim();
  return { bytes: new Uint8Array(await r.arrayBuffer()), mime };
}

/* ------------------------------------------------------------------ Gemini: the voice note */
async function transcribe(bytes: Uint8Array, mime: string): Promise<string> {
  if (!GEMINI_KEY) throw new Error("no Gemini key for transcription");
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { inline_data: { mime_type: mime || "audio/ogg", data: encodeBase64(bytes) } },
          { text: "Transcribe this WhatsApp voice note from a curtain workshop exactly as spoken. It is " +
                  "English, Hindi or Bengali, often mixed in one sentence: keep each language as spoken, " +
                  "Hindi in Devanagari, Bengali in Bengali script, English in Latin. Write every number as " +
                  "digits (order numbers are five digits; fabric codes look like fd523b-31). Return only " +
                  "the transcript, nothing else." },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 400 },
      }),
    });
  if (!r.ok) throw new Error(`transcribe ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return String(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
}

/* ------------------------------------------------------------------ Chotu's brain */
type Proposal = {
  say: string; intent: string; order_id: string | null; order_known?: boolean;
  fields: Record<string, unknown>; need: string[]; facts?: Record<string, unknown>;
  unmatched_order?: boolean; llm?: boolean; note?: string;
};
async function chotu(said: string, orderId: string | null, speaker: string,
                     history: { who: string; text: string }[]): Promise<Proposal> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/chotu`, {
    method: "POST",
    headers: { ...sbHeaders(), Origin: "https://handpickedfurniture.github.io" },
    body: JSON.stringify({ said, order_id: orderId, topic: "general", speaker, history }),
  });
  if (!r.ok) throw new Error(`chotu ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

/* ------------------------------------------------------------------ vocabulary */
const YES = new Set(["yes", "y", "ok", "okay", "confirm", "confirmed", "save", "done", "sure", "1",
  "haan", "han", "ha", "ji", "ji haan", "theek hai", "thik hai", "thik", "hyan", "hya", "hoi",
  "✅", "👍", "हाँ", "हां", "जी", "जी हाँ", "ठीक है", "ठीक", "হ্যাঁ", "হা", "হ্যা", "ঠিক আছে", "ঠিক"]);
const NO = new Set(["no", "n", "cancel", "stop", "wrong", "galat", "nahi", "nahin", "na", "nope", "0", "2",
  "❌", "👎", "नहीं", "नही", "गलत", "না", "ভুল", "বাতিল"]);
const norm = (s: string) => s.trim().toLowerCase().replace(/[.!।,]+$/g, "").trim();

const CAP: Record<string, string> = {
  fabric_received: "can_receive_fabric", material_received: "can_receive_material",
  order_status: "can_order_status", add_visit: "can_order_status",
  order_issue: "can_order_status", order_edit: "can_order_status",
  adjustment: "can_adjustment", answer: "can_track", log_note: "can_track",
};
const CAP_WORD: Record<string, string> = {
  can_receive_fabric: "mark fabric received", can_receive_material: "mark materials received",
  can_order_status: "update order status", can_adjustment: "record adjustments", can_track: "ask about orders",
};
const ASK = "\n\n_Reply *YES* / *हाँ* / *হ্যাঁ* to save · *NO* to cancel_";

/* ------------------------------------------------------------------ the card, as text */
type Row = Record<string, unknown>;
function rows(facts: Record<string, unknown> | undefined, k: string): Row[] {
  return (Array.isArray(facts?.[k]) ? facts![k] : []) as Row[];
}
function card(p: Proposal, orderLabel: string): string {
  const f = p.fields ?? {};
  const head = orderLabel ? `📋 *${orderLabel}*\n` : "";
  const idsToText = (key: string, ids: unknown) => {
    const list = rows(p.facts, key);
    return (Array.isArray(ids) ? ids : []).map((id) => {
      const r = list.find((x) => Number(x.id) === Number(id));
      // fn_chotu_context rows: fabrics {id, fabric_code, qty, uom, status, description, window},
      // materials {id, description, qty, ...}
      const label = r ? String(r.fabric_code ?? r.description ?? r.name ?? id) : `#${id}`;
      const qty = r && r.qty != null ? ` (${r.qty}${r.uom ? ` ${r.uom}` : ""})` : "";
      const win = r && r.window ? ` — ${r.window}` : "";
      return `• ${label}${qty}${win}`;
    }).join("\n");
  };
  switch (p.intent) {
    case "fabric_received":
      return `${head}*Fabric received*\n${idsToText("fabrics", f.ids)}`;
    case "material_received":
      return `${head}*Materials received*\n${idsToText("materials", f.ids)}`;
    case "order_status":
      return `${head}*Order status* → ${f.status}${f.note ? `\nNote: ${f.note}` : ""}`;
    case "add_visit":
      return `${head}*Visit ${f.visit_no}* on ${f.visit_date} → ${f.status}` +
        `${Array.isArray(f.members) && f.members.length ? `\nTeam: ${(f.members as string[]).join(", ")}` : ""}` +
        `${f.comment ? `\n${f.comment}` : ""}`;
    case "adjustment":
      return `${head}*Adjustment* — ${f.charge_type}${Number(f.qty) > 1 ? ` ×${f.qty}` : ""}` +
        `${f.amount != null ? `\nAmount: AED ${Number(f.amount).toFixed(2)}` : "\nAmount: from the rate card"}` +
        `\nReason: ${f.reason ?? ""}${f.status ? `\nOrder status → ${f.status}` : ""}`;
    case "order_edit":
      return `${head}*Order details*` +
        `${typeof f.alteration === "boolean" ? `\nAlteration: ${f.alteration ? "yes" : "no"}` : ""}` +
        `${f.removal_count != null ? `\nCurtains to remove: ${f.removal_count}` : ""}` +
        `${f.alteration_note ? `\n${f.alteration_note}` : ""}${f.comment ? `\n${f.comment}` : ""}`;
    case "order_issue":
      return `${head}*Note on the order*\n${f.note ?? ""}${f.mark ? ` [${f.mark}]` : ""}`;
    case "log_note":
      return `${head}*Note*\n${f.note ?? ""}`;
    default:
      return `${head}${p.say}`;
  }
}

/* ------------------------------------------------------------------ the writes - mirror of mod-chotu.js commitAction */
async function commit(p: Proposal, actor: string, lang: string): Promise<string> {
  const f = p.fields ?? {};
  const oid = p.order_id;
  const note = `via WhatsApp (${actor})`;
  switch (p.intent) {
    case "fabric_received":
    case "material_received":
      await rpc("fn_ops_set_receiving", { p_ids: f.ids, p_status: "received", p_qc: null, p_actor: actor, p_note: note });
      return `✅ Marked received on order ${oid}.`;
    case "order_status":
      await rpc("fn_ops_save_visit", {
        p_order_id: oid, p_visit_no: 1,
        p_payload: { status: f.status, comment: [f.note, note].filter(Boolean).join(" — "),
                     input_method: "whatsapp", lang, skip_visit_charge: true },
        p_actor: actor,
      });
      return `✅ Order ${oid} is now *${f.status}*.`;
    case "order_issue":
      await rpc("fn_ops_save_visit", {
        p_order_id: oid, p_visit_no: 1,
        p_payload: { internal_comment: `${f.note}${f.mark ? ` [${f.mark}]` : ""} — ${note}`,
                     input_method: "whatsapp", lang, skip_visit_charge: true },
        p_actor: actor,
      });
      return `✅ Note saved on order ${oid}.`;
    case "add_visit":
      await rpc("fn_ops_save_visit", {
        p_order_id: oid, p_visit_no: Number(f.visit_no) || 1,
        p_payload: { visit_date: f.visit_date || null, visit_status: f.status || null,
                     visit_comment: f.comment || null,
                     internal_comment: [f.comment, note].filter(Boolean).join(" — "),
                     member_names: f.members || [], input_method: "whatsapp", lang },
        p_actor: actor,
      });
      return `✅ Visit ${f.visit_no} recorded on order ${oid} (${f.status}).`;
    case "adjustment":
      await rpc("fn_ops_add_adjustment", {
        p_order_id: oid, p_charge_type: f.charge_type, p_reason: f.reason,
        p_quantity: Number(f.qty) || 1, p_visit_no: Number(f.visit_no) || null,
        p_chargeable: true,
        p_amount: (f.amount === null || f.amount === undefined || f.amount === "") ? null : Number(f.amount),
        p_actor: actor, p_window_name: null, p_notes: note, p_status: "new",
      });
      if (f.status) {
        await rpc("fn_ops_save_visit", {
          p_order_id: oid, p_visit_no: 1,
          p_payload: { status: f.status, input_method: "whatsapp", lang, skip_visit_charge: true },
          p_actor: actor,
        });
      }
      return `✅ Adjustment recorded on order ${oid}${f.amount != null ? ` — AED ${Number(f.amount).toFixed(2)}` : ""}. It arrives as *new* for the office to confirm.`;
    case "order_edit":
      await rpc("fn_ops_save_visit", {
        p_order_id: oid, p_visit_no: 1,
        p_payload: {
          ...(typeof f.alteration === "boolean" ? { alteration: f.alteration } : {}),
          ...(f.removal_count != null ? { removal_curtain_count: f.removal_count } : {}),
          ...(f.alteration_note ? { alteration_special_requirement: f.alteration_note } : {}),
          comment: [f.comment, note].filter(Boolean).join(" — "),
          input_method: "whatsapp", lang, skip_visit_charge: true,
        },
        p_actor: actor,
      });
      return `✅ Order ${oid} updated.`;
    case "log_note":
      return `✅ Noted${oid ? ` against ${oid}` : ""}.`;   // chotu_log below IS the write
    default:
      throw new Error(`intent ${p.intent} is not committed over WhatsApp`);
  }
}

async function chotuLog(p: Proposal, said: string, committed: boolean, actor: string, speaker: string, lang: string) {
  try {
    await rpc("fn_chotu_log", {
      p_said: said, p_order_id: p.order_id ?? null, p_order_known: p.order_known !== false,
      p_say: p.say ?? null, p_intent: p.intent ?? null, p_fields: p.fields ?? {},
      p_committed: committed, p_actor: actor, p_speaker: speaker, p_lang: lang, p_op: crypto.randomUUID(),
    });
  } catch (e) { console.error("chotu_log", String(e)); }
}

/* ------------------------------------------------------------------ the log */
type LogRow = {
  message_id: string; phone: string; chat_id?: string; sender_name?: string; kind: string;
  said?: string; order_id?: string | null; intent?: string | null; outcome: string; reply?: string;
  error?: string; received_at?: string;
};
async function log(row: LogRow) {
  try {
    await sb("wa_inbound_log?on_conflict=message_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
  } catch (e) { console.error("wa_inbound_log", String(e)); }
}
async function seen(messageId: string): Promise<boolean> {
  const r = await sb(`wa_inbound_log?select=id&message_id=eq.${encodeURIComponent(messageId)}&limit=1`);
  return Array.isArray(r) && r.length > 0;
}

/* ------------------------------------------------------------------ one message */
type Msg = Record<string, any>;
async function handle(m: Msg, test: boolean) {
  const messageId = String(m.id ?? "");
  if (!messageId || m.from_me) return;
  const chat = String(m.chat_id ?? "");
  const phone = String(m.from ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");
  const name = String(m.from_name ?? "").trim();
  const ts = Number(m.timestamp) || 0;
  const base = { message_id: messageId, phone, chat_id: chat, sender_name: name,
                 received_at: ts ? new Date(ts * 1000).toISOString() : undefined };
  const kind = m.type === "text" ? "text"
             : (m.type === "voice" || m.type === "audio" || m.type === "ptt") ? "voice" : "other";

  if (await seen(messageId)) return;                           // Whapi retried a delivery
  if (ts && Date.now() / 1000 - ts > MAX_AGE_MINUTES * 60) {
    return log({ ...base, kind, outcome: "expired" });
  }

  // the gate: the sender must be on the allowlist, or nothing happens - not even a reply
  const sr = await rpc("fn_wa_sender", { p_phone: m.from ?? phone }).catch(() => null);
  const sender = (Array.isArray(sr) ? sr[0] : sr) as Row | null;
  if (!sender || !sender.phone) return log({ ...base, kind, outcome: "ignored_unlisted" });
  const speaker = String(sender.display_name || name || phone);
  const actor = `${speaker} (WhatsApp ${phone})`;

  // which chats we listen in: a 1:1 chat, or a group reply that quotes one of our own alerts
  let quotedOrder: string | null = null;
  if (chat.endsWith("@g.us")) {
    const q = String(m.context?.quoted_id ?? "");
    if (q) {
      const hit = await sb(`order_notifications?select=order_id&provider_message_id=eq.${encodeURIComponent(q)}&limit=1`).catch(() => []);
      quotedOrder = Array.isArray(hit) && hit[0]?.order_id ? String(hit[0].order_id) : null;
    }
    if (!quotedOrder) return log({ ...base, kind, outcome: "ignored_chat" });
  }
  const reply = async (body: string) => {
    if (test) return "test";
    return await sendText(chat, body, chat.endsWith("@g.us") ? messageId : undefined);
  };

  // what was said
  let said = "";
  try {
    if (kind === "text") said = String(m.text?.body ?? "").trim();
    else if (kind === "voice") {
      const mediaId = String(m.voice?.id ?? m.audio?.id ?? m.ptt?.id ?? "");
      if (!mediaId) throw new Error("voice note without a media id");
      const { bytes, mime } = await mediaBytes(mediaId);
      said = await transcribe(bytes, m.voice?.mime_type?.split(";")[0] || mime);
    } else {
      const r = await reply("Send me a text or a voice note - a photo or file on its own I cannot act on.");
      return log({ ...base, kind, outcome: "ignored_kind", reply: r });
    }
  } catch (e) {
    const r = await reply("I could not hear that one - please send it again, or type it.").catch(() => "");
    return log({ ...base, kind, outcome: "error", error: String(e).slice(0, 400), reply: r });
  }
  if (!said) return log({ ...base, kind, outcome: "ignored_empty" });

  // an open card for this sender?
  const pend = (await sb(`wa_pending?select=*&phone=eq.${phone}&limit=1`).catch(() => []))?.[0] as Row | undefined;
  const pendingFresh = pend && (Date.now() - new Date(String(pend.created_at)).getTime()) < PENDING_MINUTES * 60_000;
  const dropPending = () => sb(`wa_pending?phone=eq.${phone}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => null);
  const word = norm(said);

  const pendNeed = Array.isArray((pend?.proposal as Row | undefined)?.need)
    ? ((pend!.proposal as Row).need as unknown[]).length : 0;
  // a complete card is waiting: YES commits it, NO drops it, anything else replaces it below
  if (pend && pendingFresh && pendNeed === 0) {
    if (YES.has(word)) {
      const p = pend.proposal as Proposal;
      let out = "";
      let committed = false;
      try {
        out = await commit(p, actor, "en");
        committed = true;
      } catch (e) {
        out = `❌ Could not save: ${String(e).slice(0, 200)}`;
      }
      await chotuLog(p, String(pend.said ?? said), committed, actor, speaker, "en");
      await dropPending();
      const r = await reply(out);
      return log({ ...base, kind, said, order_id: p.order_id, intent: p.intent,
                   outcome: committed ? "committed" : "error", reply: r, error: committed ? undefined : out });
    }
    if (NO.has(word)) {
      await dropPending();
      const r = await reply("Cancelled - nothing was saved.");
      return log({ ...base, kind, said, order_id: String(pend.order_id ?? ""), intent: String((pend.proposal as Row).intent ?? ""), outcome: "cancelled", reply: r });
    }
  } else if ((YES.has(word) || NO.has(word)) && !(pend && pendingFresh)) {
    if (pend) await dropPending();
    const r = await reply("Nothing is waiting for a yes or no. Tell me what happened - for example \"fabric fd523b-31 received for order 74137\".");
    return log({ ...base, kind, said, outcome: pend ? "expired" : "ignored_empty", reply: r });
  }

  // a new utterance - or the answer to a question the last card asked
  const history: { who: string; text: string }[] = [];
  let orderId = (said.match(ORDER_RE) ?? [null])[0] as string | null;
  if (pend && pendingFresh) {
    history.push({ who: "me", text: String(pend.said ?? "") }, { who: "chotu", text: String((pend.proposal as Row).say ?? "") });
    if (!orderId && pend.order_id) orderId = String(pend.order_id);
  }
  if (!orderId && quotedOrder) orderId = quotedOrder;

  let p: Proposal;
  try {
    p = await chotu(said, orderId, speaker, history);
  } catch (e) {
    const r = await reply("Chotu is not available right now - please use the app, or try again in a minute.").catch(() => "");
    return log({ ...base, kind, said, order_id: orderId, outcome: "error", error: String(e).slice(0, 400), reply: r });
  }
  if (!p.llm) {
    const r = await reply("I could not work that out right now - please try again, or use the app.");
    return log({ ...base, kind, said, order_id: orderId, intent: p.intent, outcome: "error", error: p.note ?? "no_llm", reply: r });
  }

  // capability
  const cap = CAP[p.intent];
  if (!cap) {
    await dropPending();
    const r = await reply(`That one is done in the app, not over WhatsApp (${p.intent.replace(/_/g, " ")}).`);
    return log({ ...base, kind, said, order_id: p.order_id, intent: p.intent, outcome: "refused_capability", reply: r });
  }
  if (!sender[cap]) {
    await dropPending();
    const r = await reply(`Your number is not set up to ${CAP_WORD[cap]} over WhatsApp. Ask the office to enable it.`);
    return log({ ...base, kind, said, order_id: p.order_id, intent: p.intent, outcome: "refused_capability", reply: r });
  }

  // a question: answer, nothing to confirm
  if (p.intent === "answer") {
    await dropPending();
    await chotuLog(p, said, false, actor, speaker, "en");
    const r = await reply(p.say || "I have nothing on that.");
    return log({ ...base, kind, said, order_id: p.order_id, intent: p.intent, outcome: "answered", reply: r });
  }

  // something is missing: ask, and keep the half-filled card so the next message completes it
  const orderRow = (p.facts as Row | undefined)?.order as Row | undefined;
  const orderLabel = p.order_id ? `Order ${p.order_id}${orderRow?.customer_name ? ` · ${orderRow.customer_name}` : ""}` : "";
  const need = Array.isArray(p.need) ? p.need : [];
  const text = need.length
    ? (p.say || `I still need: ${need.join(", ")}.`)
    : `${p.unmatched_order ? `⚠️ I cannot find order ${p.order_id} - I will keep this as a note.\n` : ""}${card(p, orderLabel)}${p.say ? `\n\n_${p.say}_` : ""}${ASK}`;
  await sb("wa_pending?on_conflict=phone", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ phone, message_id: messageId, said, order_id: p.order_id,
                           proposal: { ...p, facts: undefined, need }, card: text, created_at: new Date().toISOString() }),
  });
  const r = await reply(text);
  return log({ ...base, kind, said, order_id: p.order_id, intent: p.intent,
               outcome: need.length ? "asked" : "proposed", reply: r });
}

/* ------------------------------------------------------------------ the webhook */
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const url = new URL(req.url);
  const given = url.searchParams.get("k") ?? req.headers.get("x-webhook-secret") ?? "";
  let want = "";
  try { want = await secret("wa_webhook_secret"); } catch { want = ""; }
  if (!sameSecret(given, want)) return new Response("no", { status: 401 });

  let payload: Record<string, any> | null = null;
  try { payload = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
  const msgs: Msg[] = Array.isArray(payload?.messages) ? payload!.messages : [];
  const test = payload?._test === true;    // a simulated delivery: everything runs, no WhatsApp reply is sent

  /* Acknowledge at once - Whapi retries slow webhooks - and do the work (a voice note is a
   * download, a transcription and a model call) in the background. */
  const work = (async () => {
    for (const m of msgs) {
      try { await handle(m, test); }
      catch (e) {
        console.error("wa-inbound", String(e));
        await log({ message_id: String(m?.id ?? crypto.randomUUID()), phone: String(m?.from ?? "").replace(/\D/g, ""),
                    chat_id: String(m?.chat_id ?? ""), kind: String(m?.type ?? "other"), outcome: "error",
                    error: String(e).slice(0, 400) });
      }
    }
  })();
  if (test) { await work; return new Response(JSON.stringify({ ok: true, handled: msgs.length }), { headers: { "Content-Type": "application/json" } }); }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil ? (globalThis as any).EdgeRuntime.waitUntil(work) : await work;
  return new Response(JSON.stringify({ ok: true, queued: msgs.length }), { headers: { "Content-Type": "application/json" } });
});
