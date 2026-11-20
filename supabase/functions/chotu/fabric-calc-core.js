/* fabricCalculation - THE one place the fabric rules live. 19-20 Nov 2026 (user).
 *
 * Pure ES module: no imports, no DOM, no network. It runs unchanged in the browser, in Deno and in Node.
 *
 * Used by
 *   ops-app   js/mod-fabcalc.js               the Fabric calculation screen (#/fabcalc)
 *   Chotu     supabase/functions/chotu/        a BYTE-FOR-BYTE copy of this file, deployed with the function
 *                                              (tools/check_fabric_core.py fails if the two differ)
 *   chat      ~/.claude/skills/fabricCalculation/calc.mjs imports THIS file by path
 *   PFC app   keeps its own fabricPlan() (index.html) and SQL fabric_plan(); they are checked against the
 *             same worked cases (skill cases.json) rather than importing this
 * Change a rule here, copy the file to the Chotu folder, redeploy Chotu, mirror it in PFC, run the cases.
 *
 * The rules, as the user gave them:
 *   Gathering   American / Pinch pleat / Eyelet / Ring 2.1, Wave / Ripplefold 2.3, Roman 1 (× adjusted width)
 *   Hemming     bottom 8 cm, sides 4 cm. Lead band is for sheers only: Roman and blackout are always hemmed.
 *   Round up    to the next whole metre - straight AND inverted (user, 20 Nov 2026)
 *   STRAIGHT: the roll's width runs along the top and bottom of the curtain, so the curtain's height has
 *   to fit inside the roll width. INVERTED: the roll runs top to bottom; the curtain is panels side by side.
 *   Straight, lead band     only if height <= roll width - 14 cm (14 cm tape at the top)
 *   Straight, hemming       only if height <= roll width - 30 cm (16 cm hemming + 14 cm tape);
 *                           relaxed to - 25 cm by reducing the hem, exceptional cases only
 *                           fabric (both) = round up (adjusted width x gathering)
 *   Inverted                no lead band; panels = round up (width x gathering / roll width);
 *                           each panel = adjusted height + 30 cm; fabric = round up (panels x panel length)
 *   A height EXACTLY on a limit fits, with a "no spare fabric" warning (user, 20 Nov 2026).
 *   Direction Auto = straight when it fits, otherwise inverted.
 * "Adjusted height" is the finished drop (PFC: height + pooling / dragging). Every number is in cm in, metres out.
 */
export const RULES = {
  tapeTopCm: 14,           // heading tape at the top of a straight-cut curtain
  hemBottomCm: 8,          // bottom hem (doubled = 16 cm of fabric)
  hemSideCm: 4,            // side hems - listed as a term; not added separately by any formula
  straightLeadCm: 14,      // straight + lead band: height must be at most roll width - this
  straightHemCm: 30,       // straight + hemming: 16 cm hemming + 14 cm tape
  straightHemReducedCm: 25,// ...relaxed to this by reducing the hem, exceptional cases only
  invertedExtraCm: 30,     // added to the adjusted height for each inverted panel
  roundStepM: 1,           // "round up" = up to the next whole metre, straight and inverted (user, 20 Nov 2026)
};

export const STYLES = [
  { value: "american",    label: "American",    mult: 2.1 },
  { value: "pinch_pleat", label: "Pinch pleat", mult: 2.1 },
  { value: "eyelet",      label: "Eyelet",      mult: 2.1 },
  { value: "ring",        label: "Ring",        mult: 2.1 },
  { value: "wave",        label: "Wave",        mult: 2.3 },
  { value: "ripplefold",  label: "Ripplefold",  mult: 2.3 },
  { value: "roman",       label: "Roman blind", mult: 1, hemOnly: true },   // flat; always hemmed (PFC rules, 19 Nov 2026)
];
export const styleOf = (v) => STYLES.find((s) => s.value === v) || STYLES[0];

export const BOTTOMS = [
  { value: "lead_band", label: "Lead band" },
  { value: "hemming",   label: "Hemming" },      // = no lead band; "(no lead band)" was cut off in the select on a phone
];
export const DIRS = [
  { value: "auto",     label: "Auto" },
  { value: "straight", label: "Straight" },
  { value: "inverted", label: "Inverted" },
];

export const METHOD = {
  straight_lead:        { label: "Straight · lead band",          tone: "ok" },
  straight_hem:         { label: "Straight · hemming",            tone: "ok" },
  straight_hem_reduced: { label: "Straight · reduced hemming",    tone: "warn" },
  inverted:             { label: "Inverted · hemming",            tone: "info" },
};

/* ---------------------------------------------------------------- arithmetic */
const EPS = 1e-9;
const n = (v) => { const x = Number(String(v ?? "").replace(",", ".").trim()); return Number.isFinite(x) ? x : NaN; };
const r2 = (x) => Math.round(x * 100) / 100;
/* "Round up" = up to the next whole metre (RULES.roundStepM). Computed in cm, with r2 first, so a float like
 * 1000.0000000000002 cm (500 × 2.0 can land there) stays 10 m instead of becoming 11 m. */
const roundUpM = (cm) => Math.ceil(r2(cm) / (RULES.roundStepM * 100) - EPS) * RULES.roundStepM;
/* "= 8.46 m → rounded up to 9 m", or just "= 9 m" when nothing was rounded. */
const upTo = (cm, m) => (r2(cm / 100) === m ? `${fmtM(m)} m` : `${fmtM(cm / 100)} m → rounded up to ${fmtM(m)} m`);
export const fmtM = (m) => (Number.isFinite(m) ? r2(m).toLocaleString("en-GB", { maximumFractionDigits: 2 }) : "–");
const fmtCm = (c) => r2(c).toLocaleString("en-GB", { maximumFractionDigits: 2 });

/* One curtain in, everything about it out. Pure, so it can be checked without a page. */
export function calc(l) {
  const w = n(l.width), h = n(l.height), R = n(l.roll), m = n(l.mult);
  const qty = Math.max(1, Math.round(n(l.qty)) || 1);
  /* flags = the same warnings and notes as data, so a caller can say them in its own words and language
   * (Chotu speaks Hindi and Bengali too). warnings / notes stay the English text the screen shows. */
  const out = { ready: false, qty, errors: [], warnings: [], notes: [], flags: {}, metres: null, total: null, method: null };

  const missing = [];
  if (!(w > 0)) missing.push("adjusted width");
  if (!(h > 0)) missing.push("adjusted height");
  if (!(R > 0)) missing.push("roll width");
  if (!(m > 0)) missing.push("gathering");
  if (missing.length) { out.missing = missing; return out; }

  // a figure in metres where cm was asked for is the likeliest typing mistake on this screen
  if (R < 50) out.errors.push(`Roll width ${fmtCm(R)} looks like metres - enter it in cm (e.g. 280).`);
  if (w < 20) out.errors.push(`Width ${fmtCm(w)} looks like metres - enter it in cm.`);
  if (h < 20) out.errors.push(`Height ${fmtCm(h)} looks like metres - enter it in cm.`);
  if (out.errors.length) return out;
  if (R > 600) out.warnings.push(`Roll width ${fmtCm(R)} cm is unusually wide - check it.`);
  if (h > 800) out.warnings.push(`Height ${fmtCm(h)} cm is unusually tall - check it.`);
  if (m < 1 || m > 4) out.warnings.push(`Gathering × ${m} is outside the usual 2.1 / 2.3 - check it.`);

  const gathered = r2(w * m);                       // cm of fabric across the curtain
  const straightM = roundUpM(gathered);
  const ratio = gathered / R;
  const panels = Math.max(1, Math.ceil(ratio - EPS));
  const panelLen = r2(h + RULES.invertedExtraCm);
  const invertedCm = r2(panels * panelLen);
  const invertedM = roundUpM(invertedCm);

  const lim = {
    lead: r2(R - RULES.straightLeadCm),
    hem: r2(R - RULES.straightHemCm),
    hemReduced: r2(R - RULES.straightHemReducedCm),
  };
  // equal fits (user, 20 Nov 2026); `exact` marks a height ON the limit, which gets a no-spare warning
  const fits = { lead: h <= lim.lead + EPS, hem: h <= lim.hem + EPS, hemReduced: h <= lim.hemReduced + EPS };
  const on = (x) => Math.abs(h - x) < 0.005;
  const exact = { lead: on(lim.lead), hem: on(lim.hem), hemReduced: on(lim.hemReduced) };
  Object.assign(out, { w, h, R, m, gathered, straightM, ratio, panels, panelLen, invertedCm, invertedM, lim, fits, exact });

  /* Lead band is for sheers only: a Roman blind and a blackout layer are always hemmed (PFC rules, user,
   * 19 Nov 2026). Asked for a lead band on one of those, it is worked out hemmed and says so. */
  const st = STYLES.find((x) => x.value === l.style);
  let wantLead = l.bottom !== "hemming";
  if (wantLead && st && st.hemOnly) { wantLead = false; out.flags.hemForced = st.value; out.notes.push(`${st.label}s are always hemmed - worked out with hemming.`); }
  else if (wantLead && l.layer === "blackout") { wantLead = false; out.flags.hemForced = "blackout"; out.notes.push("Blackout is always hemmed (lead band is for sheers only) - worked out with hemming."); }
  const dir = l.dir || "auto";
  const allowReduced = !!l.allowReduced;
  let pick = null;

  if (dir === "inverted") {
    pick = "inverted";
    if (wantLead) { out.flags.leadNotPossible = true; out.warnings.push("Lead band is not possible in inverted cutting - worked out with hemming."); }
  } else if (dir === "straight") {
    if (wantLead) {
      if (fits.lead) pick = "straight_lead";
      else out.errors.push(`Straight with lead band needs the height at most roll width − ${RULES.straightLeadCm} = ${fmtCm(lim.lead)} cm; height is ${fmtCm(h)} cm.`);
    } else if (fits.hem) pick = "straight_hem";
    else if (fits.hemReduced && allowReduced) pick = "straight_hem_reduced";
    else if (fits.hemReduced) out.errors.push(`Straight with hemming needs the height at most ${fmtCm(lim.hem)} cm (roll − ${RULES.straightHemCm}). It fits only with reduced hemming (up to ${fmtCm(lim.hemReduced)} cm) - tick "Allow reduced hemming" if this is an exceptional case.`);
    else out.errors.push(`Straight with hemming needs the height at most roll width − ${RULES.straightHemCm} = ${fmtCm(lim.hem)} cm; height is ${fmtCm(h)} cm.`);
  } else if (wantLead) {
    if (fits.lead) pick = "straight_lead";
    else {
      pick = "inverted";
      out.flags.leadNotPossible = true;
      out.warnings.push(`Lead band not possible: height ${fmtCm(h)} cm is over roll width − ${RULES.straightLeadCm} = ${fmtCm(lim.lead)} cm, and inverted cutting cannot take a lead band. Worked out with hemming, inverted.`);
    }
  } else if (fits.hem) pick = "straight_hem";
  else if (fits.hemReduced && allowReduced) pick = "straight_hem_reduced";
  else {
    pick = "inverted";
    if (fits.hemReduced) out.flags.wouldFitReduced = true;
    if (fits.hemReduced) out.notes.push(`Would fit straight with reduced hemming (exceptional): ${fmtM(straightM)} m instead of ${fmtM(invertedM)} m. Tick "Allow reduced hemming" to use it.`);
  }

  if (pick === "straight_hem_reduced") out.flags.reducedHem = true;
  if (pick === "straight_hem_reduced") out.warnings.push(`Exceptional: the hem is reduced so the curtain fits straight (height up to roll − ${RULES.straightHemReducedCm} = ${fmtCm(lim.hemReduced)} cm).`);
  const limitKey = { straight_lead: "lead", straight_hem: "hem", straight_hem_reduced: "hemReduced" }[pick];
  if (limitKey && exact[limitKey]) out.flags.noSpare = true;
  if (limitKey && exact[limitKey]) out.warnings.push(`Exactly at the limit (${fmtCm(lim[limitKey])} cm): no spare fabric. Check the roll's real width before cutting.`);

  if (pick && pick.startsWith("straight") && !wantLead && invertedM < straightM) {
    out.flags.invertedLess = true;
    out.notes.push(`Inverted would need ${fmtM(invertedM)} m (${panels} × ${fmtCm(panelLen)} cm), ${fmtM(straightM - invertedM)} m less. Set Direction to Inverted to use it.`);
  }

  if (!pick) return out;
  out.ready = true;
  out.method = pick;
  out.metres = pick === "inverted" ? invertedM : straightM;
  out.total = r2(out.metres * qty);
  out.working = pick === "inverted"
    ? `${fmtCm(w)} × ${m} = ${fmtCm(gathered)} cm ÷ roll ${fmtCm(R)} = ${r2(ratio)} → ${panels} panel${panels === 1 ? "" : "s"}; each ${fmtCm(h)} + ${RULES.invertedExtraCm} = ${fmtCm(panelLen)} cm; ${panels} × ${fmtCm(panelLen)} = ${fmtCm(invertedCm)} cm = ${upTo(invertedCm, invertedM)}`
    : `${fmtCm(w)} × ${m} = ${fmtCm(gathered)} cm = ${upTo(gathered, straightM)}`;
  return out;
}

export { n as toNum, r2, fmtCm };
