/* images.ts - the "Create images" door of ready-curtains (25 Nov 2026).
 * One call = ONE picture. Gemini EDITS an approved "golden" picture (private Storage, _templates/golden_<style>_<shot>.jpg) so the heading,
 * folds, floor and framing stay right and only the cloth, opacity and tie-back change. A vision check then inspects the result; a failed
 * picture is redrawn once and whatever is still wrong is returned as `faults` for the page to show.
 * Rules: rules.json -> rules.ts (tools/build_curtain_rules.py), shared with the CurtainsImages skill. Fabric close-ups are NOT made here:
 * the page cleans the user's own photo, because AI changed colour and weave.
 */
import RULES from "./rules.ts";

// deno-lint-ignore-file no-explicit-any
export type Ctx = {
  rest: (path: string, init?: any) => Promise<any>;
  secret: (name: string) => Promise<string | null>;
  url: string;
  H: Record<string, string>;
  Bad: new (m: string, s?: number) => Error;
  ip: string;
};

const HOURLY_PER_IP = 150, DAILY_TOTAL = 400;        // pictures; the page has no login, so this is the spending limit
const MAX_PHOTO_B64 = 2_200_000;
const cache = new Map<string, string>();

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function b64(bytes: Uint8Array): string {
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

async function golden(ctx: Ctx, style: string, shot: string): Promise<string> {
  const name = `golden_${style}_${shot}.jpg`;
  if (cache.has(name)) return cache.get(name)!;
  const r = await fetch(ctx.url + "/storage/v1/object/ready-curtains/_templates/" + name, { headers: ctx.H });
  if (!r.ok) { await r.body?.cancel(); throw new ctx.Bad("This picture type is not set up yet.", 503); }
  const v = b64(new Uint8Array(await r.arrayBuffer()));
  cache.set(name, v);
  return v;
}

const fill = (t: string, m: Record<string, string>) => Object.entries(m).reduce((s, [k, v]) => s.split("{" + k + "}").join(v), t);

async function tiebackText(tieback: string, shot: any, seed: string): Promise<string> {
  if (!shot.needs_tieback) return "The curtains hang WITHOUT any tie-back in this picture.";
  if (tieback === "velcro" || tieback === "hook") return "TIE-BACK - " + RULES.tieback[tieback];
  const ch: string[] = RULES.tieback.none_choices;
  return "TIE-BACK - " + ch[parseInt((await sha256(seed)).slice(0, 8), 16) % ch.length];
}

async function ask(key: string, model: string, body: unknown, ms: number): Promise<any> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
  });
  const t = await r.text();
  if (!r.ok) { console.error("gemini", model, r.status, t.slice(0, 300)); throw new Error("gemini " + r.status); }
  return JSON.parse(t);
}

async function draw(key: string, text: string, images: string[]): Promise<{ data: string; mime: string }> {
  const parts: any[] = [{ text }, ...images.map((data) => ({ inline_data: { mime_type: "image/jpeg", data } }))];
  const d = await ask(key, RULES.model, { contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1" } } }, 75_000);
  for (const c of d.candidates || []) for (const p of c.content?.parts || []) {
    const inl = p.inline_data || p.inlineData;
    if (inl?.data) return { data: inl.data, mime: inl.mime_type || inl.mimeType || "image/png" };
  }
  throw new Error("no image: " + (d.candidates?.[0]?.finishReason || "?"));
}

async function inspect(key: string, pic: { data: string; mime: string }, style: string, opacity: string, colour: string, tieback: string, shot: any): Promise<string[]> {
  let r: any;
  try {
    const q = fill(RULES.qc.prompt, { style_label: RULES.styles[style].label, opacity, colour, shot_label: shot.label, tieback: shot.needs_tieback ? tieback : "none expected" });
    const d = await ask(key, RULES.qc.model, {
      contents: [{ parts: [{ text: q }, { inline_data: { mime_type: pic.mime, data: pic.data } }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    }, 30_000);
    r = JSON.parse((d.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join(""));
  } catch (e) { console.error("check", String(e)); return ["not checked automatically"]; }
  const bad: string[] = [], want = ({ american: "triple_pinch", wave: "wave", eyelet: "eyelet" } as Record<string, string>)[style];
  if (r.second_layer) bad.push("a second curtain or layer is visible");
  if (r.hem === "dragging") bad.push("the curtain drags on the floor");
  if (r.hem === "gap") bad.push("gap between hem and floor");
  if (r.heading_style && r.heading_style !== want && r.heading_style !== "not_visible") bad.push("heading does not look like " + want.replace("_", " "));
  if (style === "american" && r.knotted_pleats) bad.push("pleats look stitched together");
  if (r.light_matches_opacity === false) bad.push("light does not match " + opacity);
  if (r.dark_scene) bad.push("the room or window is dark, it must be bright daytime");
  if (r.light_leaks) bad.push("glowing light lines at the hem, track or edges");
  if (r.colour_ok === false) bad.push("the cloth is not " + colour);
  if (r.view_ok === false) bad.push("this is not a " + shot.label.toLowerCase() + " picture");
  if (shot.needs_tieback && r.tieback_type_ok === false) bad.push("wrong kind of tie back");
  if (opacity !== "sheer" && r.even_cloth === false) bad.push("bright patch or dark half in the cloth");
  if (r.hardware_ok === false) bad.push("wrong track or pole");
  if (r.extra_window) bad.push("another window is visible");
  if (r.fully_closed === false) bad.push("gap between the closed panels");
  if (r.against_window_wall === false) bad.push("the curtain is not at a window wall");
  if (shot.needs_tieback && !r.tieback_seen) bad.push("the tie back is missing");
  if (r.people_or_text) bad.push("people or text in the picture");
  return bad;
}

export async function createImage(b: any, ctx: Ctx): Promise<{ image: string; mime: string; shot: string; label: string; faults: string[] }> {
  const style = clean(b.style, 20).toLowerCase();
  if (!RULES.styles[style]) throw new ctx.Bad("Images can be created for American, Wave and Eyelet curtains.");
  const opacity = clean(b.opacity, 20).toLowerCase();
  if (!RULES.opacity[opacity]) throw new ctx.Bad("Please choose Blackout, Semi-blackout or Sheer.");
  const colour = clean(b.colour, 40);
  if (!colour) throw new ctx.Bad("Please enter the colour.");
  const tieback = ({ velcro: "velcro", hook: "hook" } as Record<string, string>)[clean(b.tieback, 10).toLowerCase()] || "none";
  const shot = (RULES.shots as any[]).find((s) => s.id === clean(b.shot, 30));
  if (!shot) throw new ctx.Bad("Unknown picture type.");
  let photo: string | null = null;
  if (b.photo && typeof b.photo.data === "string") {
    photo = b.photo.data.replace(/^data:[^,]*,/, "");
    if (photo!.length > MAX_PHOTO_B64 || !/^[A-Za-z0-9+/=]+$/.test(photo!)) throw new ctx.Bad("That photo cannot be used.");
  }
  const key = await ctx.secret("ready_curtains_gemini_key");
  if (!key) throw new ctx.Bad("Image creation is not set up yet.", 503);

  const ipHash = await sha256("rc|" + ctx.ip);
  const since = (ms: number) => encodeURIComponent(new Date(Date.now() - ms).toISOString());
  const all = await ctx.rest("rc_image_log?select=id&at=gte." + since(86400_000) + "&limit=" + DAILY_TOTAL);
  if ((all || []).length >= DAILY_TOTAL) throw new ctx.Bad("The daily picture limit has been reached. Please try again tomorrow.", 429);
  const mine = await ctx.rest("rc_image_log?select=id&ip_hash=eq." + ipHash + "&at=gte." + since(3600_000) + "&limit=" + HOURLY_PER_IP);
  if ((mine || []).length >= HOURLY_PER_IP) throw new ctx.Bad("The picture limit for this hour has been reached. Please try again later.", 429);

  const base = await golden(ctx, style, shot.id);
  const text = fill(RULES.golden_prompt, {
    colour, opacity_text: RULES.opacity[opacity],
    swatch_text: photo ? "Use exactly the colour and weave of the LAST attached photo, which is the real fabric." : "",
    tieback_text: await tiebackText(tieback, shot, clean(b.seed, 40) || colour),
  });
  let best: { data: string; mime: string } | null = null, faults: string[] = [], last = "";
  for (let i = 0; i < 2; i++) {
    await ctx.rest("rc_image_log", { method: "POST", body: JSON.stringify({ ip_hash: ipHash, shot: shot.id }), prefer: "return=minimal" });   // every paid drawing counts
    try {
      const pic = await draw(key, text + (faults.length ? "\nYOUR PREVIOUS PICTURE WAS REJECTED BY QUALITY CONTROL because: " + faults.join("; ") + ". Fix exactly this." : ""), [base, ...(photo ? [photo] : [])]);
      const f = await inspect(key, pic, style, opacity, colour, tieback, shot);
      if (!best || f.length < faults.length) { best = pic; faults = f; }
      if (!f.length || f[0] === "not checked automatically") break;
    } catch (e) { last = String((e as Error)?.message || e); console.error("draw", shot.id, last); }
  }
  if (!best) throw new ctx.Bad("The picture could not be created just now. Please try again.", 502);
  return { image: best.data, mime: best.mime, shot: shot.id, label: shot.label, faults };
}
