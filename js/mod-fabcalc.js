/* Fabric calculation (#/fabcalc). 19 Nov 2026 (user).
 *
 * A calculator, not a report: every figure is typed in (adjusted width, adjusted height, roll width,
 * curtain style, lead band or hemming), nothing is read from or written to the database. One card per
 * curtain, a total across them (and per fabric code when one is given), Copy for WhatsApp and Excel.
 * The curtains typed in are kept in this browser only (localStorage), so a reload does not lose them.
 *
 * The rules, as the user gave them:
 *   Gathering   American / Pinch pleat / Eyelet / Ring 2.1, Wave / Ripplefold 2.3 (× adjusted width)
 *   Hemming     bottom 8 cm, sides 4 cm
 *   Round up    to the next whole metre - straight AND inverted (user, 20 Nov 2026; was 0.5 m for a day)
 *   Two directions. STRAIGHT: the roll's width runs along the top and bottom of the curtain, so the
 *   curtain's height has to fit inside the roll width. INVERTED: the roll runs top to bottom, so the
 *   curtain is made of panels (drops) joined side by side.
 *   Straight, lead band     only if height ≤ roll width - 14 cm (14 cm tape at the top);
 *                           fabric = round up (adjusted width × gathering)
 *   Straight, hemming       only if height ≤ roll width - 30 cm (16 cm hemming + 14 cm tape);
 *   (no lead band)          relaxed to - 25 cm by reducing the hem, in exceptional cases only;
 *                           fabric = the same formula. This is why hemming needs more fabric at times:
 *                           the stricter height limit pushes the curtain to inverted sooner.
 *   Inverted                no lead band possible;
 *                           panels = round up (adjusted width × gathering / roll width)
 *                           each panel = adjusted height + 30 cm
 *                           fabric = panels × panel length, rounded up to the whole metre
 *
 * A height EXACTLY on a limit fits, with a "no spare fabric" warning (user, 20 Nov 2026: equal fits, with warning).
 * The rule was written "less than"; about 1 curtain layer in 130 on file sits exactly on the lead-band limit.
 *
 * Choice when Direction is Auto: straight when it fits, otherwise inverted. The other option's metres
 * are always shown beside it, and a hint appears when inverted would actually use less.
 *
 * Every rule lives in RULES in js/fabric-calc-core.js and nowhere else - the screen's "How it is worked out"
 * card is written from it - so a change of rule is a change of one number (then copy the file to Chotu).
 */
import { STORAGE_PREFIX } from "./config.js";
import { esc, el, toast, modal, copyText, downloadXlsx, today, fmtDateTime } from "./ui.js";
import { apiAll } from "./api.js";

import { RULES, STYLES, styleOf, BOTTOMS, DIRS, METHOD, calc, fmtM, fmtCm, toNum as n, r2 }
  from "./fabric-calc-core.js";   // the rules + calc() live there, shared with Chotu and the chat skill

/* ---------------------------------------------------------------- state (this browser only) */
const KEY = STORAGE_PREFIX + "fabcalc_v1";
let LINES = [];
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const blank = (from) => ({
  id: newId(), label: "",
  style: from?.style || "american", mult: from?.mult ?? styleOf(from?.style).mult,
  width: "", height: "", roll: from?.roll ?? "",
  bottom: from?.bottom || "lead_band", dir: "auto", allowReduced: false,
  qty: 1, fabric: from?.fabric || "",
});
function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    if (Array.isArray(v) && v.length) return v.map((x) => ({ ...blank(), ...x }));
  } catch (e) { /* private window or blocked storage: start empty */ }
  return [blank()];
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(LINES)); } catch (e) { /* not fatal */ } }

/* ---------------------------------------------------------------- fabric list (read from the database, cached here)
 * Every fabric code with its roll width: v_fabric_master (codes with a supplier prefix, plus how many order lines use
 * each, which puts the most-used first) merged with fabric_roll_widths, because 138 roll widths have a code without a
 * supplier prefix (e.g. "304-39") and the view leaves those out.
 *
 * READ-ONLY, on purpose. A code typed that is not in the list stays on this card, and an edited roll width never goes
 * back to the database: fabric_roll_widths feeds the cut sheets and panel plans on the next order rebuild, so a typo
 * here would reach production.
 *
 * The list is kept in this browser so the dropdown works at once (and with no signal), then re-read on every visit. */
const FKEY = STORAGE_PREFIX + "fabcalc_fabrics_v1";
const FAB = { rows: [], map: new Map(), at: null, state: "loading", error: "" };
const SHOW = 40;                                                      // options drawn at a time
const norm = (s) => String(s || "").toUpperCase().replace(/[\s\-_./]/g, "");   // "fd533 3" finds "FD533-3"
const codeOf = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, " ");

function setFabrics(rows, at) {
  FAB.rows = rows.map(([code, roll, uses]) => ({ code, roll: Number(roll) > 0 ? Number(roll) : null, uses: uses || 0, n: norm(code) }));
  FAB.map = new Map(FAB.rows.map((x) => [x.code, x]));
  FAB.at = at;
}
function cachedFabrics() {
  try {
    const v = JSON.parse(localStorage.getItem(FKEY) || "null");
    if (v && Array.isArray(v.rows) && v.rows.length) { setFabrics(v.rows, v.at); FAB.state = "cached"; }
  } catch (e) { /* no copy yet: the fetch fills it */ }
}
async function fetchFabrics() {
  const [master, widths] = await Promise.all([
    apiAll("/rest/v1/v_fabric_master?select=fabric_code,roll_width_cm,order_lines&order=fabric_code"),
    apiAll("/rest/v1/fabric_roll_widths?select=fabric_code,roll_width_cm&order=fabric_code"),
  ]);
  const m = new Map();
  const put = (code, roll, uses) => {
    const c = codeOf(code);
    if (!c) return;
    const cur = m.get(c) || [c, null, 0];
    if (Number(roll) > 0) cur[1] = Math.max(cur[1] || 0, Number(roll));
    cur[2] = Math.max(cur[2], Number(uses) || 0);
    m.set(c, cur);
  };
  (master || []).forEach((x) => put(x.fabric_code, x.roll_width_cm, x.order_lines));
  (widths || []).forEach((x) => put(x.fabric_code, x.roll_width_cm, 0));
  const rows = [...m.values()].sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));
  if (!rows.length) throw new Error("the fabric list came back empty");
  const at = new Date().toISOString();
  setFabrics(rows, at);
  FAB.state = "fresh";
  try { localStorage.setItem(FKEY, JSON.stringify({ at, rows })); } catch (e) { /* storage full or blocked: just slower next time */ }
}
const findFabric = (raw) => {
  const c = codeOf(raw);
  if (!c) return null;
  return FAB.map.get(c) || FAB.rows.find((x) => x.n === norm(c)) || null;
};

/* Starts-with first, then contains; the exact code on top; most-used first within each. */
function searchFabrics(q) {
  const k = norm(q);
  if (!k) return { list: FAB.rows.slice(0, SHOW), more: Math.max(0, FAB.rows.length - SHOW) };
  const starts = [], has = [];
  for (const x of FAB.rows) {
    const i = x.n.indexOf(k);
    if (i === 0) starts.push(x); else if (i > 0) has.push(x);
  }
  starts.sort((a, b) => (b.n === k) - (a.n === k));
  const all = starts.concat(has);
  return { list: all.slice(0, SHOW), more: Math.max(0, all.length - SHOW) };
}

function fabStatus() {
  const cnt = FAB.rows.length, w = FAB.rows.filter((x) => x.roll).length;
  if (FAB.state === "loading") return "Loading the fabric list…";
  if (!cnt) return `The fabric list could not load${FAB.error ? ` (${FAB.error})` : ""} - type the fabric code and roll width by hand.`;
  const base = `Fabric list: ${cnt.toLocaleString("en-GB")} codes, ${w.toLocaleString("en-GB")} with a roll width`;
  if (FAB.state === "stale") return `${base} · could not refresh, showing the copy from ${fmtDateTime(FAB.at)}`;
  return `${base} · ${FAB.state === "cached" ? "refreshing…" : "updated " + fmtDateTime(FAB.at)}`;
}

/* ---------------------------------------------------------------- the fabric code dropdown */
const lineOf = (card) => card && LINES.find((x) => x.id === card.dataset.id);

function openList(card, q) {
  const drop = card.querySelector("[data-drop]");
  const inp = card.querySelector("[name=fabric]");
  const typed = codeOf(q);
  const { list, more } = searchFabrics(q);
  const known = typed && findFabric(typed);
  const items = [];
  // "feed": whatever is typed can be used as it is, on this card
  if (typed && !known) items.push(`<div class="fcopt fcnew" role="option" data-code="${esc(typed)}"><span>Use “${esc(typed)}”</span><span class="muted">${FAB.rows.length ? "not in the list" : ""}</span></div>`);
  list.forEach((x) => items.push(`<div class="fcopt" role="option" data-code="${esc(x.code)}"><b>${esc(x.code)}</b><span class="${x.roll ? "" : "muted"}">${x.roll ? fmtCm(x.roll) + " cm" : "no roll width"}</span></div>`));
  if (!FAB.rows.length) items.push(`<div class="fcdnote">${esc(fabStatus())}</div>`);
  else if (more) items.push(`<div class="fcdnote">${more.toLocaleString("en-GB")} more - keep typing</div>`);
  else if (typed && !list.length) items.push(`<div class="fcdnote">No fabric in the list matches “${esc(typed)}”.</div>`);
  drop.innerHTML = items.join("");
  drop.hidden = !items.length;
  inp.setAttribute("aria-expanded", String(!drop.hidden));
  card._hi = -1;
}
function closeList(card) {
  const drop = card && card.querySelector("[data-drop]");
  if (!drop) return;
  drop.hidden = true;
  card.querySelector("[name=fabric]").setAttribute("aria-expanded", "false");
}
function moveHi(card, step) {
  const opts = [...card.querySelectorAll("[data-drop] .fcopt")];
  if (!opts.length) return;
  card._hi = card._hi < 0 ? (step > 0 ? 0 : opts.length - 1) : (card._hi + step + opts.length) % opts.length;
  opts.forEach((o, i) => o.classList.toggle("hi", i === card._hi));
  opts[card._hi].scrollIntoView({ block: "nearest" });
}

/* A code is committed on pick, Enter, or leaving the field. A DIFFERENT code from the list brings its roll width;
 * the same code again leaves a hand-edited roll width alone. */
function commitFabric(card, mount, raw) {
  const line = lineOf(card);
  if (!line) return;
  const hit = findFabric(raw);
  const code = hit ? hit.code : codeOf(raw);
  card.querySelector("[name=fabric]").value = code;
  if (code === line.fabric) { paintResult(card, line); return; }
  line.fabric = code;
  if (hit && hit.roll) {
    line.roll = String(hit.roll);
    card.querySelector("[name=roll]").value = line.roll;
  }
  save();
  paintResult(card, line);
  paintTotal(mount);
}
function pickFabric(card, mount, code) {
  commitFabric(card, mount, code);
  closeList(card);
  // straight on to the first empty size, so a curtain is: pick fabric, type width, type height
  const next = ["roll", "width", "height"].map((nm) => card.querySelector(`[name=${nm}]`)).find((i) => i && !i.value);
  if (next) next.focus();
}

function paintRollHint(card, l) {
  const h = card.querySelector("[data-rollhint]");
  if (!h) return;
  const hit = l.fabric && findFabric(l.fabric);
  let html = "", tone = "";
  if (!l.fabric || !FAB.rows.length) html = "";
  else if (!hit) html = "New code - not in the fabric list";
  else if (!hit.roll) html = "No roll width on file for this fabric";
  else if (n(l.roll) === hit.roll) html = "✓ From the fabric list";
  else { html = `Fabric list says ${esc(fmtCm(hit.roll))} cm <button type="button" data-useroll>Use it</button>`; tone = "warn"; }
  h.className = "fchint " + tone;
  h.innerHTML = html;
}

/* When the list arrives: hints everywhere, and a roll width for any card that has a known code but none yet. */
function afterFabrics(mount) {
  const st = mount.querySelector("[data-fabstatus]");
  if (!st) return;                                    // the screen was left while the list loaded
  st.textContent = fabStatus();
  let filled = false;
  mount.querySelectorAll(".fcline").forEach((card) => {
    const line = lineOf(card);
    if (!line) return;
    const hit = line.fabric && findFabric(line.fabric);
    if (hit && hit.roll && !String(line.roll || "").trim()) {
      line.roll = String(hit.roll);
      card.querySelector("[name=roll]").value = line.roll;
      filled = true;
    }
    paintResult(card, line);
  });
  if (filled) { save(); paintTotal(mount); }
  const open = document.activeElement;
  if (open && open.name === "fabric" && mount.contains(open)) openList(open.closest(".fcline"), open.value);
}

/* ---------------------------------------------------------------- screen */
export async function render(mount) {
  LINES = load();
  mount.innerHTML = `
    <div class="sectionbar"><div class="subtabs"><a class="btn sm" href="#/home">🏠 Home</a><button class="on">📐 Fabric calculation</button></div></div>
    <div class="card">
      <div class="spread">
        <div><h3>Fabric calculation</h3>
          <div class="muted">One card per curtain, all sizes in cm. Fabric comes out in metres, straight or inverted, lead band or hemming.</div>
          <div class="muted fcstatus" data-fabstatus></div></div>
        <button class="btn primary" data-add>+ Add curtain</button>
      </div>
    </div>
    <div id="fclines"></div>
    <div class="card" id="fctotal"></div>
    <div class="card" id="fcrules"></div>`;

  cachedFabrics();
  const box = mount.querySelector("#fclines");
  paintLines(box);
  paintTotal(mount);
  paintRules(mount);
  mount.querySelector("[data-fabstatus]").textContent = fabStatus();
  // not awaited: the cards work at once (from the cached copy, or typed by hand) while the list is read
  fetchFabrics()
    .catch((e) => { FAB.error = String((e && e.message) || e).slice(0, 80); FAB.state = FAB.rows.length ? "stale" : "failed"; })
    .finally(() => afterFabrics(mount));

  mount.querySelector("[data-add]").addEventListener("click", () => addLine(mount, LINES[LINES.length - 1]));

  box.addEventListener("input", (e) => onField(e, mount));
  box.addEventListener("change", (e) => onField(e, mount));
  /* The fabric dropdown. Committing on focusout is delayed so a tap on an option (which takes the focus first) lands
   * before the half-typed text would be committed; the delayed commit then reads the picked code and does nothing. */
  box.addEventListener("focusin", (e) => { if (e.target.name === "fabric") openList(e.target.closest(".fcline"), e.target.value); });
  box.addEventListener("focusout", (e) => {
    if (e.target.name !== "fabric") return;
    const inp = e.target, card = inp.closest(".fcline");
    setTimeout(() => {
      if (document.activeElement === inp) return;
      closeList(card);
      commitFabric(card, mount, inp.value);
    }, 180);
  });
  box.addEventListener("keydown", (e) => {
    if (e.target.name !== "fabric") return;
    const card = e.target.closest(".fcline");
    const drop = card.querySelector("[data-drop]");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (drop.hidden) openList(card, e.target.value);
      moveHi(card, e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hi = card.querySelector("[data-drop] .fcopt.hi");
      pickFabric(card, mount, hi ? hi.dataset.code : e.target.value);
    } else if (e.key === "Escape") closeList(card);
  });

  box.addEventListener("click", (e) => {
    const card = e.target.closest(".fcline");
    if (!card) return;
    const i = LINES.findIndex((x) => x.id === card.dataset.id);
    if (i < 0) return;
    const opt = e.target.closest("[data-drop] .fcopt");
    if (opt) { pickFabric(card, mount, opt.dataset.code); return; }
    if (e.target.closest("[data-useroll]")) {
      const hit = findFabric(LINES[i].fabric);
      if (hit && hit.roll) {
        LINES[i].roll = String(hit.roll);
        card.querySelector("[name=roll]").value = LINES[i].roll;
        save(); paintResult(card, LINES[i]); paintTotal(mount);
      }
      return;
    }
    if (e.target.closest("[data-dup]")) {
      LINES.splice(i + 1, 0, { ...LINES[i], id: newId() });
      save(); paintLines(box); paintTotal(mount);
      toast("Curtain duplicated", "ok");
    } else if (e.target.closest("[data-del]")) {
      LINES.splice(i, 1);
      if (!LINES.length) LINES.push(blank());
      save(); paintLines(box); paintTotal(mount);
    }
  });
}

function addLine(mount, from) {
  LINES.push(blank(from));
  save();
  const box = mount.querySelector("#fclines");
  paintLines(box);
  paintTotal(mount);
  // a copied fabric and roll width mean the width is next; otherwise start at the fabric
  const lastCard = box.querySelector(".fcline:last-child");
  const first = lastCard && lastCard.querySelector(from && from.fabric ? "[name=width]" : "[name=fabric]");
  if (first) { first.focus(); lastCard.scrollIntoView({ block: "center", behavior: "smooth" }); }
}

function onField(e, mount) {
  const f = e.target;
  if (!f.name) return;
  // the fabric code is committed by the dropdown (pick, Enter, leaving the field), not on every keystroke
  if (f.name === "fabric") { if (e.type === "input") openList(f.closest(".fcline"), f.value); return; }
  const card = f.closest(".fcline");
  const line = card && LINES.find((x) => x.id === card.dataset.id);
  if (!line) return;
  const val = f.type === "checkbox" ? f.checked : f.value;
  if (line[f.name] === val) return;
  line[f.name] = val;
  // a new style brings its own gathering; a gathering typed by hand stays until the style changes
  if (f.name === "style") {
    line.mult = styleOf(val).mult;
    card.querySelector("[name=mult]").value = line.mult;
  }
  if (f.name === "bottom") card.querySelector(".fccheck").hidden = val !== "hemming";
  save();
  paintResult(card, line);
  paintTotal(mount);
}

const opt = (list, cur) => list.map((o) => `<option value="${esc(o.value)}"${o.value === cur ? " selected" : ""}>${esc(o.label)}${o.mult ? ` (×${o.mult})` : ""}</option>`).join("");
const numIn = (name, v, ph) => `<input type="number" inputmode="decimal" step="any" min="0" name="${name}" value="${esc(v)}" placeholder="${esc(ph || "")}">`;

function paintLines(box) {
  box.innerHTML = "";
  LINES.forEach((l, i) => {
    const card = el(`
      <div class="card fcline" data-id="${esc(l.id)}">
        <div class="fchead">
          <b class="fcno">Curtain ${i + 1}</b>
          <input type="text" name="label" value="${esc(l.label)}" placeholder="Window / room (optional)">
          <span class="row">
            <button class="btn sm ghost" data-dup title="Add a copy of this curtain">Duplicate</button>
            ${LINES.length > 1 ? `<button class="btn sm ghost" data-del title="Remove this curtain">Remove</button>` : ""}
          </span>
        </div>
        <div class="fcgrid">
          <div class="fccombo"><label class="f">Fabric code</label>
            <input type="text" name="fabric" value="${esc(l.fabric)}" placeholder="Search or type" autocomplete="off"
              autocapitalize="characters" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false">
            <div class="fcdrop" data-drop role="listbox" hidden></div></div>
          <div><label class="f">Roll width (cm)</label>${numIn("roll", l.roll, "e.g. 280")}<div class="fchint" data-rollhint></div></div>
          <div><label class="f">Adj. width (cm)</label>${numIn("width", l.width, "e.g. 350")}</div>
          <div><label class="f">Adj. height (cm)</label>${numIn("height", l.height, "e.g. 260")}</div>
          <div><label class="f">Style</label><select name="style">${opt(STYLES, l.style)}</select></div>
          <div><label class="f">Gathering ×</label>${numIn("mult", l.mult)}</div>
          <div><label class="f">Bottom</label><select name="bottom">${opt(BOTTOMS, l.bottom)}</select></div>
          <div><label class="f">Direction</label><select name="dir">${opt(DIRS, l.dir)}</select></div>
          <div><label class="f">Quantity (curtains)</label><input type="number" inputmode="numeric" step="1" min="1" name="qty" value="${esc(l.qty)}"></div>
        </div>
        <label class="fccheck"${l.bottom === "hemming" ? "" : " hidden"}><input type="checkbox" name="allowReduced"${l.allowReduced ? " checked" : ""}>
          Allow reduced hemming (exceptional: height up to roll width − ${RULES.straightHemReducedCm} cm)</label>
        <div class="fcres" data-res></div>
      </div>`);
    box.appendChild(card);
    paintResult(card, l);
  });
}

function paintResult(card, l) {
  paintRollHint(card, l);
  const r = calc(l);
  const res = card.querySelector("[data-res]");
  if (r.missing) {
    res.className = "fcres wait";
    res.innerHTML = `<span class="muted">Enter the ${esc(r.missing.join(", "))}.</span>`;
    return;
  }
  const tone = r.errors.length ? "bad" : r.warnings.length ? "warn" : "";
  res.className = "fcres " + tone;
  const msgs = [
    ...r.errors.map((t) => `<div class="fcmsg bad">✕ ${esc(t)}</div>`),
    ...r.warnings.map((t) => `<div class="fcmsg warn">⚠ ${esc(t)}</div>`),
    ...r.notes.map((t) => `<div class="fcmsg note">ℹ ${esc(t)}</div>`),
  ].join("");
  if (!r.gathered) { res.innerHTML = msgs; return; }   // figures that look like metres: nothing to compare yet

  const head = r.ready ? `
    <div class="fcbig">
      <span class="fcm">${fmtM(r.metres)} m</span>
      <span class="chip ${METHOD[r.method].tone}">${esc(METHOD[r.method].label)}</span>
      ${r.qty > 1 ? `<span>× ${r.qty} curtains = <b>${fmtM(r.total)} m</b></span>` : `<span class="muted">per curtain</span>`}
    </div>
    <div class="fcwork">${esc(r.working)}</div>` : "";

  const yes = (ok, edge) => (!ok ? `<span class="fcno2">✕ too tall</span>`
    : edge ? `<span class="fcedge">⚠ fits, no spare</span>` : `<span class="fcyes">✓ fits</span>`);
  const reducedRow = l.bottom === "hemming" && !r.fits.hem && r.fits.hemReduced;
  const row = (key, name, limit, fitsCell, metres) => `
    <tr class="${r.method === key ? "pick" : ""}"><td>${name}</td><td>${limit}</td><td>${fitsCell}</td><td class="n">${metres}</td></tr>`;
  res.innerHTML = head + msgs + `
    <div class="tablewrap"><table class="fcopts">
      <thead><tr><th>Option</th><th>Height up to</th><th>At ${esc(fmtCm(r.h))} cm</th><th class="n">Fabric</th></tr></thead>
      <tbody>
        ${row("straight_lead", "Straight · lead band", `${fmtCm(r.lim.lead)} cm`, yes(r.fits.lead, r.exact.lead), r.fits.lead ? `${fmtM(r.straightM)} m` : "–")}
        ${row("straight_hem", "Straight · hemming", `${fmtCm(r.lim.hem)} cm`, yes(r.fits.hem, r.exact.hem), r.fits.hem ? `${fmtM(r.straightM)} m` : "–")}
        ${reducedRow ? row("straight_hem_reduced", "Straight · reduced hem (exceptional)", `${fmtCm(r.lim.hemReduced)} cm`, yes(true, r.exact.hemReduced), `${fmtM(r.straightM)} m`) : ""}
        ${row("inverted", `Inverted · hemming <span class="muted">(${r.panels} × ${esc(fmtCm(r.panelLen))} cm)</span>`, "any height", `<span class="fcyes">✓</span>`, `${fmtM(r.invertedM)} m`)}
      </tbody>
    </table></div>`;
}

function summary() {
  const rows = LINES.map((l, i) => ({ l, i, r: calc(l) }));
  const done = rows.filter((x) => x.r.ready);
  const total = r2(done.reduce((s, x) => s + x.r.total, 0));
  const byFabric = new Map();
  done.forEach((x) => {
    const k = String(x.l.fabric || "").trim();
    if (k) byFabric.set(k, r2((byFabric.get(k) || 0) + x.r.total));
  });
  return { rows, done, total, byFabric, curtains: done.reduce((s, x) => s + x.r.qty, 0) };
}

function paintTotal(mount) {
  const s = summary();
  const left = s.rows.length - s.done.length;
  mount.querySelector("#fctotal").innerHTML = `
    <div class="spread">
      <div>
        <div class="muted">Total fabric</div>
        <div class="fcbig"><span class="fcm">${fmtM(s.total)} m</span>
          <span class="muted">${s.curtains} curtain${s.curtains === 1 ? "" : "s"}${left ? ` · ${left} card${left === 1 ? "" : "s"} not counted yet` : ""}</span></div>
      </div>
      <div class="row">
        <button class="btn sm" data-copy>Copy for WhatsApp</button>
        <button class="btn sm" data-xlsx>Excel</button>
        <button class="btn sm ghost" data-clear>Clear all</button>
      </div>
    </div>
    ${s.byFabric.size ? `<div class="fcfab">${[...s.byFabric].map(([k, v]) => `<span class="chip info">${esc(k)}: ${fmtM(v)} m</span>`).join("")}</div>` : ""}`;

  const t = mount.querySelector("#fctotal");
  t.querySelector("[data-copy]").addEventListener("click", async () => {
    toast(await copyText(whatsappText()) ? "Copied - paste it into WhatsApp" : "Could not copy", "ok");
  });
  t.querySelector("[data-xlsx]").addEventListener("click", () => {
    downloadXlsx(`fabric-calculation-${today()}.xlsx`, [{ name: "Fabric calculation", rows: excelRows() }])
      .catch((e) => toast(e.message || String(e), "bad"));
  });
  t.querySelector("[data-clear]").addEventListener("click", () => {
    const m = modal(`
      <h3>Clear all curtains?</h3>
      <p class="muted" style="margin:8px 0 16px">Removes every card on this screen. Nothing else is affected.</p>
      <div class="row" style="justify-content:flex-end">
        <button class="btn ghost" data-no>Cancel</button>
        <button class="btn danger" data-yes>Clear all</button>
      </div>`);
    m.sheet.querySelector("[data-no]").onclick = () => m.close();
    m.sheet.querySelector("[data-yes]").onclick = () => {
      m.close();
      LINES = [blank()];
      save();
      paintLines(mount.querySelector("#fclines"));
      paintTotal(mount);
    };
  });
}

const nameOf = (l, i) => `Curtain ${i + 1}${l.label ? " - " + l.label : ""}`;
const bottomName = (l) => (l.bottom === "hemming" ? "hemming" : "lead band");

function whatsappText() {
  const s = summary();
  const out = ["*Fabric calculation*"];
  s.rows.forEach(({ l, i, r }) => {
    out.push("");
    out.push(`${nameOf(l, i)}${l.fabric ? ` (${l.fabric})` : ""}`);
    out.push(`${styleOf(l.style).label} ×${l.mult} · W ${l.width || "?"} × H ${l.height || "?"} cm · roll ${l.roll || "?"} cm · ${bottomName(l)}`);
    if (!r.ready) { out.push(r.missing ? `Not worked out: enter the ${r.missing.join(", ")}` : `Not worked out: ${r.errors[0] || ""}`); return; }
    out.push(`${METHOD[r.method].label}: ${r.working}`);
    out.push(r.qty > 1 ? `= ${fmtM(r.metres)} m × ${r.qty} = *${fmtM(r.total)} m*` : `= *${fmtM(r.metres)} m*`);
    r.warnings.forEach((w) => out.push("⚠ " + w));
  });
  out.push("");
  out.push(`*Total: ${fmtM(s.total)} m* (${s.curtains} curtain${s.curtains === 1 ? "" : "s"})`);
  if (s.byFabric.size) out.push([...s.byFabric].map(([k, v]) => `${k}: ${fmtM(v)} m`).join(" · "));
  return out.join("\n");
}

function excelRows() {
  return summary().rows.map(({ l, i, r }) => ({
    "Curtain": i + 1,
    "Window / room": l.label || "",
    "Fabric code": l.fabric || "",
    "Style": styleOf(l.style).label,
    "Gathering ×": n(l.mult),
    "Adj. width (cm)": n(l.width),
    "Adj. height (cm)": n(l.height),
    "Roll width (cm)": n(l.roll),
    "Roll width in fabric list (cm)": (findFabric(l.fabric) || {}).roll ?? "",
    "Bottom asked": bottomName(l),
    "Direction asked": (DIRS.find((d) => d.value === l.dir) || DIRS[0]).label,
    "Method used": r.ready ? METHOD[r.method].label : "",
    "Panels (inverted)": r.ready && r.method === "inverted" ? r.panels : "",
    "Panel length (cm)": r.ready && r.method === "inverted" ? r.panelLen : "",
    "Fabric per curtain (m)": r.ready ? r.metres : "",
    "Quantity": r.qty,
    "Fabric total (m)": r.ready ? r.total : "",
    "Working": r.ready ? r.working : "",
    "Warnings / notes": [...(r.missing ? ["Missing: " + r.missing.join(", ")] : []), ...r.errors, ...r.warnings, ...r.notes].join(" | "),
  }));
}

function paintRules(mount) {
  const g = (mult) => STYLES.filter((s) => s.mult === mult).map((s) => s.label).join(" / ");
  mount.querySelector("#fcrules").innerHTML = `
    <details>
      <summary><b>How it is worked out</b></summary>
      <div class="fcrules">
        <p><b>Gathering</b> (× adjusted width): ${esc(g(2.1))} ${2.1} · ${esc(g(2.3))} ${2.3}. Change it on a card if a curtain needs another figure.</p>
        <p><b>Hemming:</b> bottom ${RULES.hemBottomCm} cm, sides ${RULES.hemSideCm} cm. <b>Round up</b> = up to the next whole metre (7.35 m → 8 m), for straight and inverted alike.</p>
        <p><b>Two directions.</b> <i>Straight</i>: the roll's width runs along the top and bottom of the curtain, so the height must fit inside the roll width. <i>Inverted</i>: the roll runs top to bottom, so the curtain is made of panels side by side.</p>
        <p><b>Straight · lead band</b> - only if height ≤ roll width − ${RULES.straightLeadCm} cm (${RULES.tapeTopCm} cm tape at the top). Fabric = round up (adjusted width × gathering).</p>
        <p><b>Straight · hemming</b> (no lead band) - only if height ≤ roll width − ${RULES.straightHemCm} cm (${RULES.hemBottomCm * 2} cm hemming + ${RULES.tapeTopCm} cm tape). Can be relaxed to − ${RULES.straightHemReducedCm} cm by reducing the hem, in exceptional cases only. Fabric = the same formula - which is why hemming needs more fabric at times: the stricter limit sends the curtain to inverted sooner.</p>
        <p><b>Exactly on a limit</b> (e.g. 266 cm on a 280 cm roll with lead band) counts as fitting, with a warning on the card: there is no spare fabric, so check the roll's real width before cutting.</p>
        <p><b>Inverted</b> - no lead band possible. Panels = round up (adjusted width × gathering ÷ roll width). Each panel = adjusted height + ${RULES.invertedExtraCm} cm. Fabric = round up (panels × panel length).</p>
        <p><b>Direction: Auto</b> uses straight when it fits and inverted otherwise. The table on each card shows every option, so the other one can be picked by hand.</p>
      </div>
    </details>`;
}
