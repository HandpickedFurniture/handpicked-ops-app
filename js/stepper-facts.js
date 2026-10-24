/* Day facts for the Step-by-step Scheduler.
 *
 * A line-for-line port of the Schedule skill's build_facts.py (~/.claude/skills/Schedule/scripts),
 * so the app and the skill time an order the same way: windows, layers, pelmets, bend rails, motors,
 * scaffolding and removals -> install minutes, using the rules in sched_settings 'stepper_rules'
 * (the skill's rules.json). Input is fn_sched_day_raw(date): the 3D-sheet rows with the resolver's
 * location, and the PO lines. Change a rule in the settings row, never here; change the counting
 * here AND in build_facts.py, or the two will disagree about how long a job takes.
 *
 * Travel is not built here: the scheduler measures it from the coordinates with the same speed bands.
 */
export const CITY_CENTRE = { "Dubai": [25.2048, 55.2708], "Abu Dhabi": [24.4539, 54.3773],
  "Sharjah": [25.3463, 55.4209], "Ajman": [25.4052, 55.5136], "Al Ain": [24.2075, 55.7447] };

const mins = (s) => { const [h, m] = String(s).slice(0, 5).split(":").map(Number); return h * 60 + m; };
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/* ---------- Google plus codes, short codes recovered against the city centre ---------- */
const OLC = "23456789CFGHJMPQRVWX";
const PLUS = /\b([23456789CFGHJMPQRVWX]{4,8})\+([23456789CFGHJMPQRVWX]{2,3})\b/i;
function olcDecode(code) {
  code = code.replace("+", "").toUpperCase();
  let lat = 0, lng = 0, res = 20, lastLat = 0, lastLng = 0;
  for (let i = 0; i < Math.min(code.length, 10); i += 2) {
    lat += OLC.indexOf(code[i]) * res; lng += OLC.indexOf(code[i + 1]) * res;
    lastLat = lastLng = res; res /= 20;
  }
  if (code.length > 10) {
    const v = OLC.indexOf(code[10]), row = Math.floor(v / 4), col = v % 4;
    lastLat /= 5; lastLng /= 4; lat += row * lastLat; lng += col * lastLng;
  }
  return [lat - 90 + lastLat / 2, lng - 180 + lastLng / 2];
}
function olcEncodePrefix(lat, lng, n) {
  lat += 90; lng += 180; let out = "", res = 20;
  while (out.length < n) {
    const dl = Math.floor(lat / res), dg = Math.floor(lng / res);
    out += OLC[dl] + OLC[dg]; lat -= dl * res; lng -= dg * res; res /= 20;
  }
  return out.slice(0, n);
}
function olcRecover(short, ref) {
  const [head, tail] = short.toUpperCase().split("+"), pad = 8 - head.length;
  if (pad <= 0) return olcDecode(head + tail);
  const resolution = 20 ** (2 - pad / 2);
  let [lat, lng] = olcDecode(olcEncodePrefix(ref[0], ref[1], pad) + head + tail);
  if (ref[0] + resolution / 2 < lat) lat -= resolution; else if (ref[0] - resolution / 2 > lat) lat += resolution;
  if (ref[1] + resolution / 2 < lng) lng -= resolution; else if (ref[1] - resolution / 2 > lng) lng += resolution;
  return [lat, lng];
}

/* ---------- lines ---------- */
const lower = (l) => (l.commercial_name || "").toLowerCase();
function isBlind(l) {
  const t = ["commercial_name", "product_name", "curtain_type"].map((k) => l[k] || "").join(" ").toLowerCase();
  return (l.ob || 0) > 0 || t.includes("roller") || t.includes("roman") || (t.includes("blind") && !t.includes("tie"));
}
const isCurtain = (l) => (l.oc || 0) > 0 && !isBlind(l);
const stem = (n) => (n || "").trim().replace(/\s*\((sheer|blackout)\)\s*$/i, "").toLowerCase();
const WHOLE = /\b(all|whole|entire|every|complete)\b/i;
const title = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function orderWork(ls, R) {
  const c = { blinds: 0, curt_1l: 0, curt_2l: 0, pelmet: 0, cassette: 0, flex: 0, motor_windows: 0, remote: 0, removal: 0,
              w_over_std: 0, h_over_tall: 0, h_over_scaffold: 0, max_w: 0, max_h: 0 };
  const wins = [], groups = new Map();
  for (const l of ls) if (isCurtain(l)) {
    const k = stem(l.window_name) + "|" + l.w;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  for (const g of groups.values()) {
    const split = g.length === 2 && g.every((x) => /\((sheer|blackout)\)/i.test(x.window_name || ""));
    for (const it of (split ? [g] : g.map((x) => [x]))) {
      const layers = split ? 2 : (it[0].lay || 1);
      const w = Math.max(...it.map((x) => x.w || 0)), h = Math.max(...it.map((x) => x.h || 0));
      const m = (layers >= 2 ? R.curtain_2layer_min : R.curtain_1layer_min) +
                R.width_step_min * Math.ceil(Math.max(w - R.standard_width_cm, 0) / R.width_step_cm);
      const sample = /just for (the|thr) client to see|\bsample\b/i.test(it[0].cmt || "");
      for (let q = 0; q < (split ? 1 : it[0].qty); q++) {
        wins.push({ kind: sample ? "sample" : "curtain", name: split ? title(stem(it[0].window_name)) : it[0].window_name,
                    layers, w, h, minutes: m,
                    note: split ? "split sheer+blackout lines = one 2-layer window" : sample ? "fabric sample on an existing window: hung, not counted as a window" : "" });
        if (sample) continue;
        c[layers >= 2 ? "curt_2l" : "curt_1l"] += 1;
        c.w_over_std += w > R.standard_width_cm; c.h_over_tall += h > R.tall_flag_cm; c.h_over_scaffold += h > R.scaffold_height_cm;
        c.max_w = Math.max(c.max_w, w); c.max_h = Math.max(c.max_h, h);
      }
    }
  }
  for (const l of ls) {
    if (!isBlind(l)) continue;
    for (let q = 0; q < l.qty; q++) {
      wins.push({ kind: "blind", name: l.window_name, layers: null, w: l.w || 0, h: l.h || 0, minutes: R.blind_min, note: l.commercial_name || "" });
      c.blinds += 1;
      c.h_over_tall += (l.h || 0) > R.tall_flag_cm; c.h_over_scaffold += (l.h || 0) > R.scaffold_height_cm;
      c.max_w = Math.max(c.max_w, l.w || 0); c.max_h = Math.max(c.max_h, l.h || 0);
    }
  }
  const curtainWindows = c.curt_1l + c.curt_2l;
  const sumQty = (pred) => ls.filter(pred).reduce((a, l) => a + l.qty, 0);
  c.cassette = sumQty((l) => lower(l).includes("cassette"));
  c.pelmet = ls.reduce((a, l) => a + (l.pelmet || 0) * l.qty, 0) || sumQty((l) => lower(l).includes("pelmet"));
  c.flex = sumQty((l) => (l.bend || 0) > 0 || lower(l).includes("bending track") || lower(l).includes("flexible"));
  const motorLines = ls.filter((l) => (l.motor || 0) > 0 || (lower(l).includes("motor") && !lower(l).includes("trunking")));
  c.motor_windows = new Set(motorLines.map((l) => stem(l.window_name))).size;
  c.remote = sumQty((l) => lower(l).includes("remote"));
  const rmNotes = [];
  for (const l of ls) {
    if (!l.rm) continue;
    const wn = (l.window_name || "").trim();
    const whole = WHOLE.test(l.cmt || "") || !wn || wn === "0";
    const n = whole ? Math.max(curtainWindows, 1) : l.qty;
    c.removal += n;
    rmNotes.push(`${n} removal${n > 1 ? "s" : ""} from '${(l.cmt || l.commercial_name || "").trim().slice(0, 60)}'`);
  }
  const existingMotor = ls.some((l) => /motori[sz]ed/i.test(l.cmt || "")) && !c.motor_windows;
  const poScaffold = ls.some((l) => (l.scaffolding || 0) > 0 || lower(l).includes("scaffold"));
  const scaf = c.h_over_scaffold > 0 || poScaffold;
  const extraTall = Math.max(c.h_over_scaffold - 1, 0);
  const bd = { windows: wins.reduce((a, w) => a + w.minutes, 0), flex_track: R.flex_track_min * c.flex, pelmet: R.pelmet_min * c.pelmet,
               cassette: R.cassette_min * c.cassette, motor: R.motor_per_window_min * c.motor_windows,
               scaffolding: scaf ? R.scaffold_order_min + R.scaffold_extra_window_min * extraTall : 0,
               removal: R.removal_min * c.removal };
  return { counts: c, windows: wins.filter((w) => w.kind !== "sample").length, window_detail: wins, breakdown: bd,
           minutes: Object.values(bd).reduce((a, b) => a + b, 0), scaffolding: scaf, po_scaffolding: poScaffold,
           motor: c.motor_windows > 0, existing_motor_track: existingMotor, removal_notes: rmNotes,
           extras: [...new Set(ls.filter((l) => !isCurtain(l) && !isBlind(l)).map((l) => l.commercial_name || ""))].sort(),
           comments: [...new Set(ls.map((l) => (l.cmt || "").trim()).filter(Boolean))].sort() };
}

const EMPTY_WORK = { counts: null, windows: 0, window_detail: [], breakdown: null, minutes: null, scaffolding: false,
                     po_scaffolding: false, motor: false, existing_motor_track: false, removal_notes: [], extras: [], comments: [] };
const FLAT = /\b(apt|apartment|unit|flat|tower|residences?|building|bldg|floor)\b|\bap\s?\d/i;
const MAPQ = /https?:\/\/\S*?[?&](?:q|query)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)\S*/i;

/* raw = fn_sched_day_raw(date). Returns {facts, held, synced_at}: facts are the jobs to place, held are
 * ISR / odd-time rows (kept aside, addable by hand), keyed by order id, or "<id>-<Kind>" when the same
 * order is also being installed that day. */
export function buildDay(raw, R) {
  const lines = new Map();
  for (const l0 of raw.lines || []) {
    const l = { ...l0 };
    for (const k of ["w", "h"]) l[k] = num(l[k]);
    for (const k of ["lay", "pelmet", "bend", "motor", "scaffolding", "oc", "ob", "wc", "line_no"]) l[k] = l[k] == null ? null : Math.trunc(Number(l[k]));
    l.qty = Math.max(1, Math.trunc(Number(l.quantity)) || 1);
    if (!lines.has(l.order_id)) lines.set(l.order_id, []);
    lines.get(l.order_id).push(l);
  }
  const facts = {}, heldList = [], seen = new Set();
  const oddLo = mins(R.odd_time_before), oddHi = mins(R.odd_time_after);
  let synced = "";
  for (const row of raw.rows || []) {
    if ((row.synced_at || "") > synced) synced = row.synced_at;
    const oid = row.order_id, et = row.entry_type || "installation";
    if (seen.has(oid + "|" + et)) continue;
    seen.add(oid + "|" + et);
    let addr = row.address || "";
    let lat = num(row.lat), lng = num(row.lng), conf = row.confidence;
    let locNote = row.anomaly_reason || (row.community ? `${row.community} (${conf})` : "");
    if (row.anomaly_reason && /Pin is \d+ km from/.test(row.anomaly_reason) && row.pin_lat)
      locNote += ` | sheet pin ${Number(row.pin_lat).toFixed(4)},${Number(row.pin_lng).toFixed(4)} - CHECK which is right`;
    const mq = addr.match(MAPQ), pc = addr.match(PLUS);
    if (mq) {
      lat = Number(mq[1]); lng = Number(mq[2]); locNote = "pin from the maps link in the address"; conf = "link";
      addr = addr.replace(MAPQ, "").trim().replace(/^[ ,]+|[ ,]+$/g, "");
    } else if (pc) {
      const ref = CITY_CENTRE[(row.city || "Dubai").trim()] || CITY_CENTRE.Dubai;
      const [plat, plng] = olcRecover(pc[0], ref);
      const off = lat != null ? Math.hypot(plat - lat, plng - lng) * 111 : 0;
      locNote = off > 2 ? `plus code ${pc[0]} used (resolver said ${row.community || "pin"}, ${Math.round(off)} km away)` : `plus code ${pc[0]}`;
      lat = Math.round(plat * 1e6) / 1e6; lng = Math.round(plng * 1e6) / 1e6; conf = "plus code";
    }
    const villa = (/\bvilla\b|townhouse|town house/i.test(addr) && !/\bapartment\b|\bapt\b/i.test(addr)) ||
                  (row.property_type === "villa" && ["high", "medium"].includes(row.confidence) && !FLAT.test(addr));
    const slot = (row.install_time || "").slice(0, 5) || null, t = slot ? mins(slot) : null;
    const ls = lines.get(oid) || [];
    const w = ls.length ? orderWork(ls, R) : { ...EMPTY_WORK };
    const rec = { order_id: oid, city: row.city, slot, customer: (row.customer_name || "").trim(), phone: row.phone,
                  address: addr, lat, lng, loc_note: locNote, loc_confidence: conf, emaar: !!row.emaar_db, villa,
                  entry_type: et, status: row.status, sheet_notes: row.notes, sheet_duration: row.sheet_duration_min, ...w };
    const odd = row.time_unscheduled || t === null || t < oddLo || t >= oddHi;
    if (et !== "installation" || odd) {
      rec.kind = et === "issue_resolution" ? "ISR" : (et !== "installation" ? et.replace(/_/g, " ").replace(/\b\w/g, (x) => x.toUpperCase()) : "Odd time");
      if (et !== "installation") {
        // a visit installs nothing: keep the PO numbers for reference only
        Object.assign(rec, { po_windows: rec.windows, po_counts: rec.counts, windows: 0, counts: null, breakdown: null, window_detail: [],
                             motor: false, scaffolding: false, existing_motor_track: false, minutes: R.isr_flat_min });
      } else if (rec.minutes == null) rec.minutes = R.isr_flat_min;
      rec.note = (row.notes || "").trim().split("\n")[0].slice(0, 220);
      heldList.push(rec);
    } else {
      if (rec.minutes == null) { rec.minutes = R.isr_flat_min; rec.note = "No PO lines found: flat estimate used."; }
      facts[oid] = rec;
    }
  }
  const held = {};
  for (const h of heldList) {
    const k = facts[h.order_id] ? `${h.order_id}-${h.kind.replace(/ /g, "")}` : h.order_id;
    h.key = k; held[k] = h;
  }
  return { facts, held, synced_at: synced };
}
