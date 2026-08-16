/* Speech-to-text fallback for devices with no Web Speech API - in practice, every iPhone.
 *
 * The browser records audio, base64-encodes it and posts it here; Gemini transcribes it and the text
 * goes back. Android Chrome never reaches this function: it uses the on-device Web Speech API.
 *
 * Deployed with verify_jwt = true (the default), so only a signed-in user can call it. That is
 * stronger than the shared-secret header the PFC app uses, because this project has real auth and
 * there is no secret to leak.
 *
 * Deploy:
 *   supabase secrets set GEMINI_API_KEY=<key>     # the ingestion agent's key lives in GCP Secret
 *                                                 # Manager, which Supabase cannot read
 *   supabase functions deploy transcribe
 */

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash";

const LANG_NAME: Record<string, string> = {
  en: "English", hi: "Hindi", bn: "Bengali",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!GEMINI_KEY) return json({ error: "GEMINI_API_KEY is not set on this project" }, 500);

  let payload: { audio?: string; mime?: string; lang?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const { audio, mime, lang } = payload;
  if (!audio) return json({ error: "No audio supplied" }, 400);

  // ~10 MB of base64 is roughly 7.5 MB of audio - far more than any dictated comment
  if (audio.length > 10_000_000) return json({ error: "Recording is too long" }, 413);

  const spoken = LANG_NAME[lang ?? "en"] ?? "English";
  const prompt =
    `Transcribe this voice note from a curtain-installation coordinator in Dubai. ` +
    `The speaker is most likely using ${spoken}, but they routinely code-switch between English, ` +
    `Hindi and Bengali mid-sentence - transcribe each part in the language actually spoken, and do ` +
    `not translate. Keep order numbers, fabric codes (like fd523b-31) and measurements exactly as ` +
    `spoken. Return ONLY the transcript, with no preamble, quotes or commentary. ` +
    `If nothing intelligible was said, return an empty string.`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: (mime || "audio/webm").split(";")[0], data: audio } },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 1024 },
  };

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );

    const j = await r.json();
    if (!r.ok) {
      console.error("gemini error", r.status, JSON.stringify(j).slice(0, 500));
      return json({ error: j?.error?.message ?? `Transcription failed (${r.status})` }, 502);
    }

    const text = (j?.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "")
      .join("")
      .trim();

    return json({ text, model: MODEL });
  } catch (e) {
    console.error("transcribe failed", e);
    return json({ error: "Transcription service is unavailable" }, 502);
  }
});
