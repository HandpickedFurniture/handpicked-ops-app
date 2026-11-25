/* images.ts - the "Create images" and "Modify images" doors of ready-curtains (25 Nov 2026).
 *
 * createImage: one call = ONE picture. Gemini EDITS an approved "golden" picture (private Storage, _templates/golden_<style>_<shot>.jpg; the two
 * tie-back shots exist once per tie back: ..._velcro.jpg and ..._temu.jpg) so the heading, the tie back, the garden in the window, the folds,
 * floor and framing stay right and only the cloth and opacity change. USER RULE 25 Nov 2026: the colour comes ONLY from the photo of the fabric;
 * the typed colour name is never used. With `previous` + `feedback` it edits the picture the person saw instead of the golden one.
 * A vision check inspects the result next to the fabric photo; a failed picture is redrawn once and what is still wrong comes back as `faults`.
 *
 * understand: turns spoken (Hindi / English / mixed) or typed feedback into a list of changes per picture.
 *
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
  email: string | null;
};

const HOURLY_PER_PERSON = 150, DAILY_TOTAL = 400;        // pictures: the spending limit
const MAX_IMAGE_B64 = 2_200_000, MAX_AUDIO_B64 = 3_000_000;
const AUDIO = ["audio/wav", "audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg", "audio/aac"];
const cache = new Map<string, string>();

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function b64(bytes: Uint8Array): string {
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

function b64Arg(v: any, max: number, ctx: Ctx, what: string): string | null {
  if (!v || typeof v.data !== "string" || !v.data) return null;
  const d = v.data.replace(/^data:[^,]*,/, "");
  if (d.length > max || !/^[A-Za-z0-9+/=]+$/.test(d)) throw new ctx.Bad("That " + what + " cannot be used.");
  return d;
}

async function golden(ctx: Ctx, style: string, shot: any, tieback: string): Promise<string> {
  const name = `golden_${style}_${shot.id}${shot.needs_tieback ? "_" + tieback : ""}.jpg`;
  if (cache.has(name)) return cache.get(name)!;
  const r = await fetch(ctx.url + "/storage/v1/object/ready-curtains/_templates/" + name, { headers: ctx.H });
  if (!r.ok) { await r.body?.cancel(); throw new ctx.Bad("This picture type is not set up yet.", 503); }
  const v = b64(new Uint8Array(await r.arrayBuffer()));
  cache.set(name, v);
  return v;
}

const fill = (t: string, m: Record<string, string>) => Object.entries(m).reduce((s, [k, v]) => s.split("{" + k + "}").join(v), t);

const tiebackText = (tieback: string, shot: any): string =>
  shot.needs_tieback ? "TIE-BACK - " + RULES.tieback[tieback] : "The curtains hang WITHOUT any tie-back in this picture.";

const GEMINI = Deno.env.get("GEMINI_BASE") || "https://generativelanguage.googleapis.com";      // GEMINI_BASE: local tests only

async function ask(key: string, model: string, body: unknown, ms: number): Promise<any> {
  const r = await fetch(`${GEMINI}/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
  });
  const t = await r.text();
  if (!r.ok) { console.error("gemini", model, r.status, t.slice(0, 300)); const e: any = new Error("gemini " + r.status); e.busy = r.status === 429; throw e; }
  return JSON.parse(t);
}
const textOf = (d: any): string => (d.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("");
const BUSY = "Google's picture service is refusing requests right now (its limit is reached). Please try again later.";

async function draw(key: string, text: string, images: string[]): Promise<{ data: string; mime: string }> {
  const parts: any[] = [{ text }, ...images.map((data) => ({ inline_data: { mime_type: "image/jpeg", data } }))];
  const d = await ask(key, RULES.model, { contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1" } } }, 75_000);
  for (const c of d.candidates || []) for (const p of c.content?.parts || []) {
    const inl = p.inline_data || p.inlineData;
    if (inl?.data) return { data: inl.data, mime: inl.mime_type || inl.mimeType || "image/png" };
  }
  throw new Error("no image: " + (d.candidates?.[0]?.finishReason || "?"));
}

async function inspect(key: string, pic: { data: string; mime: string }, fabric: string, style: string, opacity: string, tieback: string, shot: any, change: string): Promise<string[]> {
  let r: any;
  try {
    const q = fill(RULES.qc.prompt, { style_label: RULES.styles[style].label, opacity, shot_label: shot.label, tieback: shot.needs_tieback ? tieback : "none expected",
      change_text: change ? ` Requested change: "${change}".` : "" });
    const d = await ask(key, RULES.qc.model, {
      contents: [{ parts: [{ text: q }, { inline_data: { mime_type: pic.mime, data: pic.data } }, { inline_data: { mime_type: "image/jpeg", data: fabric } }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    }, 30_000);
    r = JSON.parse(textOf(d));
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
  if (r.colour_ok === false) bad.push("the colour differs from your photo");
  if (r.view_ok === false) bad.push("this is not a " + shot.label.toLowerCase() + " picture");
  if (shot.needs_tieback && r.tieback_type_ok === false) bad.push("wrong kind of tie back");
  if (shot.needs_tieback && r.hourglass_ok === false) bad.push("the panel is not a straight hourglass");
  if (r.garden_sharp === false) bad.push("the garden is blurred or looks artificial");
  if (opacity !== "sheer" && r.even_cloth === false) bad.push("bright patch or dark half in the cloth");
  if (r.hardware_ok === false) bad.push("wrong track or pole");
  if (r.extra_window) bad.push("another window is visible");
  if (r.fully_closed === false) bad.push("gap between the closed panels");
  if (r.against_window_wall === false) bad.push("the curtain is not at a window wall");
  if (shot.needs_tieback && !r.tieback_seen) bad.push("the tie back is missing");
  if (r.people_or_text) bad.push("people or text in the picture");
  if (change && r.change_done === false) bad.push("the change you asked for is not visible");
  return bad;
}

async function geminiKey(ctx: Ctx): Promise<string> {
  const key = await ctx.secret("ready_curtains_gemini_key");
  if (!key) throw new ctx.Bad("Image creation is not set up yet.", 503);
  return key;
}

/** Spending limit. Returns a function that logs one paid drawing. */
async function budget(ctx: Ctx): Promise<(shot: string) => Promise<void>> {
  const who = ctx.email ? "email=eq." + encodeURIComponent(ctx.email) : "ip_hash=eq." + await sha256("rc|" + ctx.ip);
  const ipHash = await sha256("rc|" + ctx.ip);
  const since = (ms: number) => encodeURIComponent(new Date(Date.now() - ms).toISOString());
  const all = await ctx.rest("rc_image_log?select=id&at=gte." + since(86400_000) + "&limit=" + DAILY_TOTAL);
  if ((all || []).length >= DAILY_TOTAL) throw new ctx.Bad("The daily picture limit has been reached. Please try again tomorrow.", 429);
  const mine = await ctx.rest("rc_image_log?select=id&" + who + "&at=gte." + since(3600_000) + "&limit=" + HOURLY_PER_PERSON);
  if ((mine || []).length >= HOURLY_PER_PERSON) throw new ctx.Bad("The picture limit for this hour has been reached. Please try again later.", 429);
  return (shot) => ctx.rest("rc_image_log", { method: "POST", body: JSON.stringify({ ip_hash: ipHash, email: ctx.email, shot }), prefer: "return=minimal" });
}

function setting(b: any, ctx: Ctx): { style: string; opacity: string; tieback: string } {
  const style = clean(b.style, 20).toLowerCase();
  if (!RULES.styles[style]) throw new ctx.Bad("Images can be created for American, Wave and Eyelet curtains.");
  const opacity = clean(b.opacity, 20).toLowerCase();
  if (!RULES.opacity[opacity]) throw new ctx.Bad("Please choose Blackout, Semi-blackout or Sheer.");
  return { style, opacity, tieback: clean(b.tieback, 10).toLowerCase() === "velcro" ? "velcro" : "temu" };   // USER RULE: pictures show only these two
}

export async function createImage(b: any, ctx: Ctx): Promise<{ image: string; mime: string; shot: string; label: string; faults: string[] }> {
  const { style, opacity, tieback } = setting(b, ctx);
  const shot = (RULES.shots as any[]).find((s) => s.id === clean(b.shot, 30));
  if (!shot) throw new ctx.Bad("Unknown picture type.");
  const fabric = b64Arg(b.photo, MAX_IMAGE_B64, ctx, "photo");
  if (!fabric) throw new ctx.Bad("Add a photo of the fabric first. The colour is taken only from your photo.");
  const change = clean(b.feedback, 400).replace(/["{}]/g, "'"), previous = change ? b64Arg(b.previous, MAX_IMAGE_B64, ctx, "picture") : null;
  const key = await geminiKey(ctx), spend = await budget(ctx);

  let base: string, text: string;
  if (previous) {
    base = previous;
    text = fill(RULES.modify_prompt, { feedback: change, house: RULES.house_rules.all + " " + RULES.house_rules[style] });
  } else {
    base = await golden(ctx, style, shot, tieback);
    text = fill(RULES.golden_prompt, {
      opacity_text: opacity === "sheer" && RULES.sheer_wall_shots[style].includes(shot.id) ? RULES.sheer_wall_text : RULES.opacity[opacity],
      tieback_text: tiebackText(tieback, shot),
      view_text: RULES.view_text[RULES.window_shots[style].includes(shot.id) ? "window" : "none"],
    }) + (change ? ` The shop also asks for this, do it as well: "${change}".` : "");
  }
  let best: { data: string; mime: string } | null = null, faults: string[] = [], busy = false;
  for (let i = 0; i < 2; i++) {
    await spend(shot.id);                                                                         // every paid drawing counts
    try {
      const pic = await draw(key, text + (faults.length ? "\nYOUR PREVIOUS PICTURE WAS REJECTED BY QUALITY CONTROL because: " + faults.join("; ") + ". Fix exactly this." : ""), [base, fabric]);
      const f = await inspect(key, pic, fabric, style, opacity, tieback, shot, change);
      if (!best || f.length < faults.length) { best = pic; faults = f; }
      if (!f.length || f[0] === "not checked automatically") break;
    } catch (e: any) { busy = busy || !!e?.busy; console.error("draw", shot.id, String(e?.message || e)); if (e?.busy) break; }
  }
  if (!best) throw new ctx.Bad(busy ? BUSY : "The picture could not be created just now. Please try again.", busy ? 503 : 502);
  return { image: best.data, mime: best.mime, shot: shot.id, label: shot.label, faults };
}

const step = (v: unknown) => Math.max(-3, Math.min(3, Math.round(Number(v) || 0)));

/** Spoken or typed feedback -> what to change in which picture. Nothing is drawn here: the person sees and confirms the list first. */
export async function understand(b: any, ctx: Ctx): Promise<any> {
  const { style, opacity, tieback } = setting(b, ctx);
  const pics = (Array.isArray(b.pictures) ? b.pictures : []).slice(0, 12)
    .map((p: any, i: number) => ({ n: i + 1, id: clean(p?.id, 30), label: clean(p?.label, 60), kind: p?.kind === "photo" ? "photo" : "ai" })).filter((p: any) => p.id);
  if (!pics.length) throw new ctx.Bad("There are no pictures yet.");
  const said = clean(b.text, 600), audio = b64Arg(b.audio, MAX_AUDIO_B64, ctx, "recording");
  const mime = clean(b.audio?.mime, 40).split(";")[0].toLowerCase();
  if (audio && !AUDIO.includes(mime)) throw new ctx.Bad("That recording format is not supported.");
  if (!audio && !said) throw new ctx.Bad("Say or type what should change.");
  const key = await geminiKey(ctx), spend = await budget(ctx);
  await spend("feedback");
  const parts: any[] = [{ text: fill(RULES.feedback_prompt, { pictures: pics.map((p: any) => `${p.n}. id=${p.id}, "${p.label}", kind=${p.kind}`).join("; "), style: RULES.styles[style].label, opacity, tieback }) }];
  if (audio) parts.push({ inline_data: { mime_type: mime, data: audio } });
  else parts.push({ text: "TYPED FEEDBACK: " + said });
  let r: any;
  try {
    r = JSON.parse(textOf(await ask(key, RULES.qc.model, { contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0 } }, 45_000)));
  } catch (e: any) {
    console.error("understand", String(e?.message || e));
    throw new ctx.Bad(e?.busy ? BUSY : "The feedback could not be understood just now. Please try again.", e?.busy ? 503 : 502);
  }
  const seen = new Set<string>(), changes: any[] = [];
  for (const c of Array.isArray(r.changes) ? r.changes : []) {
    const p = pics.find((x: any) => x.id === clean(c?.id, 30));
    if (!p || seen.has(p.id)) continue;
    const ins = clean(c.instruction, 300), tone = { brightness: step(c.brightness), warmth: step(c.warmth), contrast: step(c.contrast) };
    if (p.kind === "photo") { if (!tone.brightness && !tone.warmth && !tone.contrast) continue; changes.push({ id: p.id, n: p.n, label: p.label, kind: "photo", instruction: ins, ...tone }); }
    else { if (!ins && !c.redraw) continue; changes.push({ id: p.id, n: p.n, label: p.label, kind: "ai", instruction: ins, redraw: !!c.redraw }); }
    seen.add(p.id);
  }
  const out = {
    language: clean(r.language, 20), transcript: audio ? clean(r.transcript, 800) : said, english: clean(r.english, 500),
    tieback: r.tieback === "velcro" || r.tieback === "temu" ? r.tieback : null,
    cloth: { brightness: step(r.cloth?.brightness), warmth: step(r.cloth?.warmth) },              // the whole cloth: the page corrects the fabric reference and redraws all
    changes,
  };
  await ctx.rest("rc_image_feedback", { method: "POST", prefer: "return=minimal",
    body: JSON.stringify({ email: ctx.email, ref: clean(b.ref, 40) || null, spoken: !!audio, language: out.language, transcript: out.transcript, english: out.english, changes: { tieback: out.tieback, cloth: out.cloth, list: changes } }) })
    .catch((e: any) => console.error("feedback log", e?.message));
  return out;
}
