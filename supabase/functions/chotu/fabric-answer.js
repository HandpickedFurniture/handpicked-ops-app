/* Chotu answers a fabric question: "how much fabric for 350 by 260, roll 280?", "fd533-3, 4 metre wide,
 * 2.7 high, wave - kitna kapda?". 20 Nov 2026 (user: the fabricCalculation skill, on Chotu).
 *
 * THE MODEL DOES NO ARITHMETIC AND WRITES NO NUMBERS. It only copies what was said into fields (sizes AS
 * SAID with their units, the fabric code, the style...). Everything after that is code, here:
 *   - units become cm (a bare small number like "3.5" is taken as metres, and the answer says so);
 *   - a fabric code's roll width is looked up as the caller (lookupRoll, injected by index.ts);
 *   - the metres come from fabric-calc-core.js - a byte-for-byte copy of ops-app/js/fabric-calc-core.js,
 *     the same rules as the Fabric calculation screen and the chat skill;
 *   - the reply is built from templates in English, Hindi or Bengali.
 * Nothing is saved. It goes back to the phone (and to WhatsApp) as a plain "answer".
 *
 * Plain JS rather than TS so it runs in Node too: the skill's test (fabricCalculation/chotu_test.mjs)
 * imports this file directly with a stub lookup.
 */
import { calc, STYLES, fmtM, fmtCm } from "./fabric-calc-core.js";

/* "350", "350 cm", "3.5 m", "3.5 metre", "2700 mm", 350 -> cm. A bare number under 20 is metres. */
export function toCm(v) {
  if (v == null || v === "") return { cm: null };
  if (typeof v === "number") return v > 0 ? (v < 20 ? { cm: Math.round(v * 10000) / 100, assumed: v } : { cm: v }) : { cm: null };
  const s = String(v).toLowerCase().replace(",", ".").trim();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(cm|centi\S*|सेंटी\S*|সেন্টি\S*|mm|m\b|met\S*|mtr\S*|मीटर|মিটার)?/);
  if (!m || !(Number(m[1]) > 0)) return { cm: null };
  const x = Number(m[1]), u = m[2] || "";
  if (/^(cm|centi|सेंटी|সেন্টি)/.test(u)) return { cm: x };
  if (u === "mm") return { cm: x / 10 };
  if (u) return { cm: Math.round(x * 10000) / 100 };
  return x < 20 ? { cm: Math.round(x * 10000) / 100, assumed: x } : { cm: x };
}

const STYLE_WORDS = [
  [/pinch/, "pinch_pleat"], [/ripple/, "ripplefold"], [/wave|वेव|ওয়েভ/, "wave"], [/eyelet|आईलेट|আইলেট/, "eyelet"],
  [/ring|रिंग|রিং/, "ring"], [/roman|रोमन|রোমান/, "roman"], [/americ|अमेरिक|আমেরিক/, "american"],
];
export function styleFrom(v) {
  const s = String(v ?? "").toLowerCase();
  const hit = STYLE_WORDS.find(([re]) => re.test(s));
  const st = STYLES.find((x) => x.value === (hit ? hit[1] : "american")) || STYLES[0];
  return { ...st, assumed: !hit };
}
export function bottomFrom(v) {
  const s = String(v ?? "").toLowerCase();
  if (!s) return null;
  if (/hem|हेम|হেম|no lead|without lead|बिना/.test(s)) return "hemming";
  if (/lead|लेड|লেড/.test(s)) return "lead_band";
  return null;
}
/* Answer in the script they wrote in; otherwise the app's language; otherwise English. */
export const langOf = (said, ui) =>
  /[ঀ-৿]/.test(said || "") ? "bn" : /[ऀ-ॿ]/.test(said || "") ? "hi" : (["hi", "bn"].includes(ui) ? ui : "en");

const T = {
  en: {
    m: "metres", by: "by", roll: "roll", fromList: " from the fabric list",
    lead: "a lead band", sheerOnly: "",
    method: { straight_lead: "straight cut with lead band", straight_hem: "straight cut, hemmed",
              straight_hem_reduced: "straight cut with a reduced hem", inverted: (p, L) => `inverted, ${p} panel${p === 1 ? "" : "s"} of ${L} cm` },
    qty: (q, t) => ` For ${q} curtains, ${t} metres.`,
    assumed: (parts) => ` I assumed ${parts.join(" and ")}.`,
    asMetres: (xs) => ` I took ${xs.join(" and ")} as metres.`,
    listSays: (code, cm) => ` The fabric list says ${cm} cm for ${code}.`,
    noSpare: " Exactly at the limit, so no spare fabric: check the roll's real width before cutting.",
    leadNotPossible: " A lead band is not possible at this height, so it is hemmed.",
    reducedHem: " That uses a reduced hem, an exceptional case.",
    hemForced: { roman: " Roman blinds are always hemmed.", blackout: " Blackout is always hemmed." },
    wouldFitReduced: (s) => ` With a reduced hem it would fit straight: ${s} metres.`,
    invertedLess: (i) => ` Inverted would need only ${i} metres.`,
    need: (list) => `To work out the fabric I need the ${list}.`,
    names: { width: "adjusted width", height: "adjusted height", roll: "roll width or the fabric code", rollOnly: "roll width" },
    and: " and ",
    notFound: (c) => `I could not find fabric ${c} in the list. `,
    noWidth: (c) => `Fabric ${c} has no roll width on file. `,
    cantCheck: (c) => `I could not check fabric ${c} just now. `,
    cant: (e) => `I can't work that out: ${e}`,
    sep: ".",
  },
  hi: {
    m: "मीटर", by: "×", roll: "रोल", fromList: " (लिस्ट से)", lead: "लेड बैंड",
    method: { straight_lead: "सीधा कट, लेड बैंड", straight_hem: "सीधा कट, हेम",
              straight_hem_reduced: "सीधा कट, छोटा हेम", inverted: (p, L) => `उल्टा कट, ${p} पैनल, हर एक ${L} cm` },
    qty: (q, t) => ` ${q} पर्दों के लिए ${t} मीटर।`,
    assumed: (parts) => ` मैंने ${parts.join(" और ")} माना।`,
    asMetres: (xs) => ` मैंने ${xs.join(" और ")} को मीटर माना।`,
    listSays: (code, cm) => ` लिस्ट में ${code} का रोल ${cm} cm है।`,
    noSpare: " यह ठीक सीमा पर है, कोई अतिरिक्त कपड़ा नहीं: काटने से पहले रोल की असली चौड़ाई जाँच लें।",
    leadNotPossible: " इस ऊँचाई पर लेड बैंड नहीं हो सकता, इसलिए हेम।",
    reducedHem: " इसमें छोटा हेम है, यह खास मामला है।",
    hemForced: { roman: " रोमन ब्लाइंड में हमेशा हेम होता है।", blackout: " ब्लैकआउट में हमेशा हेम होता है।" },
    wouldFitReduced: (s) => ` छोटे हेम के साथ सीधा कट हो सकता है: ${s} मीटर।`,
    invertedLess: (i) => ` उल्टा कट में सिर्फ़ ${i} मीटर लगेगा।`,
    need: (list) => `कपड़ा निकालने के लिए ${list} बताइए।`,
    names: { width: "चौड़ाई (adjusted width)", height: "ऊँचाई (adjusted height)", roll: "रोल की चौड़ाई या फ़ैब्रिक कोड", rollOnly: "रोल की चौड़ाई" },
    and: " और ",
    notFound: (c) => `फ़ैब्रिक ${c} लिस्ट में नहीं मिला। `,
    noWidth: (c) => `फ़ैब्रिक ${c} की रोल चौड़ाई दर्ज नहीं है। `,
    cantCheck: (c) => `फ़ैब्रिक ${c} अभी जाँच नहीं पाया। `,
    cant: (e) => `यह नहीं निकाल पाया: ${e}`,
    sep: "।",
  },
  bn: {
    m: "মিটার", by: "×", roll: "রোল", fromList: " (তালিকা থেকে)", lead: "লেড ব্যান্ড",
    method: { straight_lead: "সোজা কাট, লেড ব্যান্ড", straight_hem: "সোজা কাট, হেম",
              straight_hem_reduced: "সোজা কাট, ছোট হেম", inverted: (p, L) => `উল্টো কাট, ${p}টি প্যানেল, প্রতিটি ${L} cm` },
    qty: (q, t) => ` ${q}টি পর্দার জন্য ${t} মিটার।`,
    assumed: (parts) => ` আমি ${parts.join(" আর ")} ধরে নিয়েছি।`,
    asMetres: (xs) => ` আমি ${xs.join(" আর ")} মিটার ধরে নিয়েছি।`,
    listSays: (code, cm) => ` তালিকায় ${code}-এর রোল ${cm} cm।`,
    noSpare: " এটা ঠিক সীমায়, বাড়তি কাপড় নেই: কাটার আগে রোলের আসল প্রস্থ দেখে নিন।",
    leadNotPossible: " এই উচ্চতায় লেড ব্যান্ড সম্ভব নয়, তাই হেম।",
    reducedHem: " এতে ছোট হেম, এটা বিশেষ ক্ষেত্র।",
    hemForced: { roman: " রোমান ব্লাইন্ডে সবসময় হেম হয়।", blackout: " ব্ল্যাকআউটে সবসময় হেম হয়।" },
    wouldFitReduced: (s) => ` ছোট হেম দিলে সোজা কাট হয়: ${s} মিটার।`,
    invertedLess: (i) => ` উল্টো কাটে মাত্র ${i} মিটার লাগবে।`,
    need: (list) => `কাপড় হিসাব করতে ${list} বলুন।`,
    names: { width: "প্রস্থ (adjusted width)", height: "উচ্চতা (adjusted height)", roll: "রোলের প্রস্থ বা ফ্যাব্রিক কোড", rollOnly: "রোলের প্রস্থ" },
    and: " আর ",
    notFound: (c) => `ফ্যাব্রিক ${c} তালিকায় পাইনি। `,
    noWidth: (c) => `ফ্যাব্রিক ${c}-এর রোলের প্রস্থ লেখা নেই। `,
    cantCheck: (c) => `ফ্যাব্রিক ${c} এখন দেখতে পারলাম না। `,
    cant: (e) => `হিসাব করতে পারলাম না: ${e}`,
    sep: "।",
  },
};

const cleanCode = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-./]/g, "");
const truthy = (v) => v === true || /^(true|yes|1)$/i.test(String(v ?? ""));

/* lookupRoll(code) -> { roll: number|null } when the code is known (roll null = no width on file),
 * null when it is not a known fabric. It may throw (network): treated as "could not check". */
export async function fabricAnswer(fields, { said = "", lang, lookupRoll } = {}) {
  const f = fields || {};
  const L = T[langOf(said, lang)];
  const w = toCm(f.width ?? f.width_cm), h = toCm(f.height ?? f.height_cm), saidRoll = toCm(f.roll ?? f.roll_cm);
  const code = cleanCode(f.fabric_code ?? f.fabric);
  const style = styleFrom(f.style);
  const layer = /black/i.test(String(f.layer ?? "")) ? "blackout" : (/sheer/i.test(String(f.layer ?? "")) ? "sheer" : undefined);
  const askedBottom = bottomFrom(f.bottom);
  const dir = ["straight", "inverted"].includes(String(f.direction ?? f.dir ?? "")) ? String(f.direction ?? f.dir) : "auto";
  const qty = Math.max(1, Math.round(Number(f.qty)) || 1);

  let roll = saidRoll.cm, rollSource = roll ? "said" : null, listed, lookupFailed = false;
  if (code && lookupRoll) {
    try { listed = await lookupRoll(code); } catch (_e) { lookupFailed = true; }
    if (!roll && listed && listed.roll) { roll = listed.roll; rollSource = "list"; }
  }

  const base = { intent: "answer", order_id: null, need: [] };
  const missing = [];
  if (!w.cm) missing.push("width");
  if (!h.cm) missing.push("height");
  if (!roll) missing.push("roll");
  if (missing.length) {
    let pre = "";
    if (!roll && code) pre = lookupFailed ? L.cantCheck(code.toUpperCase()) : listed === null ? L.notFound(code.toUpperCase()) : listed && !listed.roll ? L.noWidth(code.toUpperCase()) : "";
    // with a code already given, only the roll width can help now
    const name = (k) => (k === "roll" && code ? L.names.rollOnly : L.names[k]);
    return { ...base, say: pre + L.need(missing.map(name).join(L.and)), need: missing,
             fields: { fabric: { asked: f, missing } } };
  }

  const r = calc({ width: w.cm, height: h.cm, roll, mult: style.mult, style: style.value,
                   bottom: askedBottom || "lead_band", layer, dir, allowReduced: truthy(f.allow_reduced), qty });
  const detail = {
    width_cm: w.cm, height_cm: h.cm, roll_cm: roll, roll_source: rollSource, fabric_code: code ? code.toUpperCase() : null,
    listed_roll_cm: listed && listed.roll ? listed.roll : null, style: style.value, gathering: style.mult,
    bottom: askedBottom || "lead_band", layer: layer || null, direction: dir, qty,
    method: r.method, metres: r.metres, total: r.total, panels: r.method === "inverted" ? r.panels : null,
    panel_length_cm: r.method === "inverted" ? r.panelLen : null, flags: r.flags, working: r.working || null,
  };
  if (!r.ready) {
    return { ...base, say: L.cant(r.errors[0] || (r.missing || []).join(", ")), fields: { fabric: detail } };
  }

  const meth = r.method === "inverted" ? L.method.inverted(r.panels, fmtCm(r.panelLen)) : L.method[r.method];
  let say = `${code ? code.toUpperCase() + ", " : ""}${fmtCm(w.cm)} ${L.by} ${fmtCm(h.cm)} cm, ${L.roll} ${fmtCm(roll)} cm`
          + `${rollSource === "list" ? L.fromList : ""}: ${fmtM(r.metres)} ${L.m}, ${meth}${L.sep}`;
  if (qty > 1) say += L.qty(qty, fmtM(r.total));
  const fl = r.flags || {};
  if (fl.noSpare) say += L.noSpare;
  if (fl.leadNotPossible && askedBottom !== "hemming") say += L.leadNotPossible;
  if (fl.reducedHem) say += L.reducedHem;
  if (fl.hemForced) say += L.hemForced[fl.hemForced] || "";
  if (fl.wouldFitReduced) say += L.wouldFitReduced(fmtM(r.straightM));
  if (fl.invertedLess) say += L.invertedLess(fmtM(r.invertedM));
  const assumed = [];
  if (style.assumed) assumed.push(`${style.label} ×${style.mult}`);
  if (!askedBottom && !fl.hemForced && r.method === "straight_lead") assumed.push(L.lead);
  if (assumed.length) say += L.assumed(assumed);
  const asM = [w, h, saidRoll].filter((x) => x.assumed != null).map((x) => String(x.assumed));
  if (asM.length) say += L.asMetres(asM);
  if (rollSource === "said" && listed && listed.roll && Math.abs(listed.roll - roll) > 0.01) say += L.listSays(code.toUpperCase(), fmtCm(listed.roll));
  if (L === T.en && r.working) say += ` ${r.working}.`;
  return { ...base, say, fields: { fabric: detail } };
}

/* A self-test for the probe after a deploy. Chotu is deployed by pasting these files into the Supabase
 * MCP tool, not built from git, so this proves the deployed rules give the repo's answers. */
const SELF = [
  [{ width: "350 cm", height: 260, roll: 280 }, 8],
  [{ width: 350, height: 266, roll: 280 }, 8],                       // exactly on the lead-band limit: fits
  [{ width: 350, height: 260, roll: 280, bottom: "hemming" }, 9],
  [{ width: 300, height: 270, roll: 300, style: "wave", bottom: "hemming" }, 7],
  [{ width: 500, height: 200, roll: 300 }, 11],
  [{ width: 200, height: 260, roll: 280, layer: "blackout" }, 6],
  [{ width: 120, height: 150, roll: 280, style: "roman" }, 2],
  [{ fabric_code: "fd533-3", width: "4 m", height: "2.7 m", style: "wave" }, 10],
];
export async function fabricSelfTest() {
  const lookupRoll = async (c) => (c === "fd533-3" ? { roll: 320 } : null);
  let passed = 0;
  const failed = [];
  for (const [f, want] of SELF) {
    const a = await fabricAnswer(f, { lookupRoll });
    const got = a.fields && a.fields.fabric ? a.fields.fabric.metres : null;
    if (got === want) passed++; else failed.push(`${JSON.stringify(f)} -> ${got}`);
  }
  return { passed, of: SELF.length, failed };
}
