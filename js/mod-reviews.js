/* Reviews (#/reviews). 10 Nov 2026 (user).
 *
 * When a customer leaves a 5-star review, a team member posts in the WhatsApp group "Fixer" the order
 * number and the names of the people on that order, usually with a photo of the review. The
 * review-capture Edge Function copies the group every 5 minutes, the model reads each message, and
 * fn_rev_rebuild() makes one review per order (photos paired by sender and time). The photos also go
 * to Google Drive, "Reviews/<YYYY-MM Month>" (ingestion agent, reviews_drive.py).
 *
 * This screen: reviews per day (line chart), reviews per person per month (table + Excel), names that
 * are not on the roster, and every review with its photo, editable by ops. Counted = not rejected and
 * 5 stars (a review whose stars nobody wrote counts as 5). A person's change is never undone by the
 * next capture; "Back to automatic" hands a row back to it. See supabase/sql/20261110_reviews.sql.
 */
import { apiAll, rpc, authedFetch, isSignedIn, isViewer } from "./api.js";
import { esc, el, toast, loading, fmtDate, fmtDateTime, today, modal, downloadXlsx } from "./ui.js";
import { SB_URL } from "./config.js";

const HUE = "#3e7d96";              // the app's validated bar hue (charts.js BAR_HUE), 4.59:1 on white
const isoShift = (iso, d) => { const [y, m, x] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, x + d)).toISOString().slice(0, 10); };
const monthName = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }); };
const STATUS = { auto: ["Automatic", "info"], confirmed: ["Checked", "ok"], manual: ["Added by hand", "ok"], rejected: ["Rejected", "bad"] };

let F = { from: isoShift(today(), -89), to: today(), city: "", person: "", q: "", all: false };
let ROWS = [], NAMES = [], RUN = null;

export async function render(mount) {
  if (!isSignedIn()) return;
  mount.innerHTML = `<div class="sectionbar"><div class="subtabs"><a href="#/home">🏠 Home</a><button class="on">⭐ Reviews</button></div></div>
    <div class="card" id="rvf"></div><div id="rvb"></div>`;
  await load();
  paint(mount);
}

async function load() {
  loading(true, "Loading reviews…");
  try {
    const [rows, names, runs] = await Promise.all([
      apiAll("/rest/v1/v_review?select=*&order=day.desc,at.desc.nullslast"),
      rpc("fn_rev_known_names", {}),
      apiAll("/rest/v1/review_capture_run?select=at,stats,error&order=at.desc&limit=1"),
    ]);
    ROWS = rows || []; NAMES = names || []; RUN = (runs || [])[0] || null;
  } catch (e) { toast(e.message || String(e), "bad"); }
  loading(false);
}

const inRange = (r) => (!F.from || r.day >= F.from) && (!F.to || r.day <= F.to) && (!F.city || r.city === F.city);
const counted = () => ROWS.filter((r) => r.counted && inRange(r) && (!F.person || (r.people || []).includes(F.person)));

function paint(mount) {
  const fb = mount.querySelector("#rvf"), box = mount.querySelector("#rvb");
  const people = [...new Set(ROWS.flatMap((r) => r.people || []))].sort();
  const cities = [...new Set(ROWS.map((r) => r.city).filter(Boolean))].sort();
  fb.innerHTML = `<div class="fgrid">
    <div><label class="f">From</label><input type="date" name="from" value="${esc(F.from)}"></div>
    <div><label class="f">to</label><input type="date" name="to" value="${esc(F.to)}"></div>
    <div><label class="f">City</label><select name="city"><option value="">All</option>${cities.map((c) => `<option ${c === F.city ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
    <div><label class="f">Person</label><select name="person"><option value="">Everyone</option>${people.map((p) => `<option ${p === F.person ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></div>
    <div><label class="f">Search</label><input name="q" value="${esc(F.q)}" placeholder="order, customer, name"></div></div>
    <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center">
      <button class="btn sm" data-r="30">Last 30 days</button><button class="btn sm" data-r="90">90 days</button>
      <button class="btn sm" data-r="month">This month</button><button class="btn sm" data-r="year">This year</button>
      <span class="muted" style="font-size:12px;margin-left:auto">${RUN ? `Fixer group last read ${esc(fmtDateTime(RUN.at))}${RUN.error ? " - failed: " + esc(String(RUN.error).slice(0, 80)) : ""}` : "Fixer group not read yet"} · every 5 min</span>
      ${isViewer() ? "" : `<button class="btn sm" data-refresh>↻ Check Fixer now</button>`}</div>`;
  fb.querySelectorAll("input,select").forEach((i) => i.addEventListener(i.name === "q" ? "input" : "change", () => { F[i.name] = i.value; paint(mount); }));
  fb.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
    const t = today(), r = b.dataset.r;
    F.to = t;
    F.from = r === "month" ? t.slice(0, 8) + "01" : r === "year" ? t.slice(0, 5) + "01-01" : isoShift(t, -(Number(r) - 1));
    paint(mount);
  }));
  const rf = fb.querySelector("[data-refresh]");
  if (rf) rf.addEventListener("click", async () => {
    rf.disabled = true;
    try { await rpc("fn_rev_run_capture", { p_trigger: "button", p_days: 3 }); toast("Reading the Fixer group - this takes up to a minute", "ok");
      setTimeout(async () => { await load(); paint(mount); }, 45000); }
    catch (e) { toast(e.message || String(e), "bad"); rf.disabled = false; }
  });

  const rows = counted();
  const thisMonth = today().slice(0, 7);
  const byPerson = new Map();
  rows.forEach((r) => (r.people || []).forEach((p) => byPerson.set(p, (byPerson.get(p) || 0) + 1)));
  const top = [...byPerson.entries()].sort((a, b) => b[1] - a[1])[0];
  box.innerHTML = "";
  box.appendChild(el(`<div class="card statrow" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
    <div class="stat"><span class="sn">${rows.length}</span><span class="sl">5-star reviews in range</span></div>
    <div class="stat"><span class="sn">${ROWS.filter((r) => r.counted && r.day.startsWith(thisMonth) && (!F.city || r.city === F.city)).length}</span><span class="sl">this month</span></div>
    <div class="stat"><span class="sn">${byPerson.size}</span><span class="sl">people credited</span></div>
    <div class="stat"><span class="sn">${top ? esc(top[0]) : "-"}</span><span class="sl">${top ? `most reviews (${top[1]})` : "most reviews"}</span></div>
    <div class="stat"><span class="sn">${rows.filter((r) => !r.order_id || r.order_unknown || !(r.people || []).length).length}</span><span class="sl">need a look</span></div></div>`));
  box.appendChild(lineCard(rows));
  box.appendChild(monthTable(rows));
  const odd = unknownNames(mount);
  if (odd) box.appendChild(odd);
  box.appendChild(listCard(mount));
}

/* ---------------------------------------------------------------- 1. reviews per day */
function lineCard(rows) {
  const days = [];
  for (let d = F.from; d <= F.to && days.length < 800; d = isoShift(d, 1)) days.push(d);
  const n = new Map(days.map((d) => [d, 0]));
  rows.forEach((r) => { if (n.has(r.day)) n.set(r.day, n.get(r.day) + 1); });
  const pts = days.map((d) => ({ d, v: n.get(d) }));
  const W = 720, H = 220, L = 34, R = 12, T = 12, B = 28;
  const max = Math.max(1, ...pts.map((p) => p.v));
  const step = max <= 5 ? 1 : Math.ceil(max / 5);
  const top = Math.ceil(max / step) * step;
  const x = (i) => L + (pts.length < 2 ? (W - L - R) / 2 : (i * (W - L - R)) / (pts.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const grid = [];
  for (let v = 0; v <= top; v += step) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e6ecef" stroke-width="1"/>
    <text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="lbl">${v}</text>`);
  const every = Math.max(1, Math.ceil(pts.length / 8));
  const last = pts.length - 1;
  // the last day is always labelled; the regular label before it is dropped when the two would collide
  const xl = pts.map((p, i) => ((i % every === 0 && (i === last || last - i >= every * 0.6)) || i === last)
    ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="lbl">${esc(fmtDate(p.d).replace(/\s?\d{4}$/, ""))}</text>` : "").join("");
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const peak = pts.reduce((a, p, i) => (p.v > (a ? a.v : -1) ? { ...p, i } : a), null);
  const card = el(`<div class="card"><div class="spread" style="margin-bottom:6px"><h4>5-star reviews per day</h4>
      <span class="muted" style="font-size:12px">${esc(fmtDate(F.from))} – ${esc(fmtDate(F.to))}${F.person ? " · " + esc(F.person) : ""}</span></div>
    <div style="position:relative">
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="5-star reviews per day" xmlns="http://www.w3.org/2000/svg" style="touch-action:pan-y">
        ${grid.join("")}${xl}
        <path d="${path}" fill="none" stroke="${HUE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${peak && peak.v > 0 ? `<text x="${x(peak.i)}" y="${y(peak.v) - 8}" text-anchor="middle" class="val">${peak.v}</text>` : ""}
        <line data-cx y1="${T}" y2="${H - B}" stroke="#8aa0ab" stroke-width="1" visibility="hidden"/>
        <circle data-dot r="5" fill="${HUE}" stroke="#fff" stroke-width="2" visibility="hidden"/>
        <rect data-hit x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
      </svg>
      <div data-tip class="card" style="position:absolute;pointer-events:none;display:none;padding:6px 9px;font-size:12px;white-space:nowrap;margin:0;box-shadow:0 2px 8px rgba(0,0,0,.12)"></div>
    </div></div>`);
  const svg = card.querySelector("svg"), tip = card.querySelector("[data-tip]"), cx = card.querySelector("[data-cx]"), dot = card.querySelector("[data-dot]");
  const move = (ev) => {
    const b = svg.getBoundingClientRect(), px = ((ev.clientX - b.left) / b.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - L) / (W - L - R)) * (pts.length - 1))));
    const p = pts[i]; if (!p) return;
    cx.setAttribute("x1", x(i)); cx.setAttribute("x2", x(i)); cx.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(p.v)); dot.setAttribute("visibility", "visible");
    const who = rows.filter((r) => r.day === p.d).map((r) => r.order_id || "no order").join(", ");
    tip.innerHTML = `<b>${esc(fmtDate(p.d))}</b> · ${p.v} review${p.v === 1 ? "" : "s"}${who ? `<div class="muted">${esc(who)}</div>` : ""}`;
    tip.style.display = "block";
    const left = (x(i) / W) * b.width;
    tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), b.width - tip.offsetWidth) + "px";
    tip.style.top = Math.max(0, (y(p.v) / H) * b.height - tip.offsetHeight - 12) + "px";
  };
  const hide = () => { tip.style.display = "none"; cx.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
  card.querySelector("[data-hit]").addEventListener("pointermove", move);
  card.querySelector("[data-hit]").addEventListener("pointerleave", hide);
  return card;
}

/* ---------------------------------------------------------------- 2. per person per month */
function months() {
  const out = [];
  for (let m = F.from.slice(0, 7); m <= F.to.slice(0, 7) && out.length < 60;) {
    out.push(m);
    const [y, mo] = m.split("-").map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  }
  return out;
}

function monthTable(rows) {
  const ms = months(), grid = new Map();
  rows.forEach((r) => (r.people || []).forEach((p) => {
    if (!grid.has(p)) grid.set(p, new Map());
    const k = r.day.slice(0, 7); grid.get(p).set(k, (grid.get(p).get(k) || 0) + 1);
  }));
  const people = [...grid.keys()].sort((a, b) => {
    const ta = [...grid.get(a).values()].reduce((s, v) => s + v, 0), tb = [...grid.get(b).values()].reduce((s, v) => s + v, 0);
    return tb - ta || a.localeCompare(b);
  });
  const tot = (p) => [...grid.get(p).values()].reduce((s, v) => s + v, 0);
  const colTot = (m) => rows.filter((r) => r.day.slice(0, 7) === m).length;
  const card = el(`<div class="card"><div class="spread" style="margin-bottom:6px"><h4>Reviews by person, month by month</h4>
      <button class="btn sm" data-xlsx>⬇ Excel</button></div>
    <div class="scrollx"><table class="dense report"><thead><tr><th>Person</th>${ms.map((m) => `<th class="num">${esc(monthName(m))}</th>`).join("")}<th class="num">Total</th></tr></thead>
    <tbody>${people.map((p) => `<tr><td><b>${esc(p)}</b></td>${ms.map((m) => `<td class="num">${grid.get(p).get(m) || ""}</td>`).join("")}<td class="num"><b>${tot(p)}</b></td></tr>`).join("")
      || `<tr><td colspan="${ms.length + 2}" class="muted">No 5-star reviews in this range yet.</td></tr>`}</tbody>
    <tfoot><tr><th>Reviews</th>${ms.map((m) => `<th class="num">${colTot(m)}</th>`).join("")}<th class="num">${rows.length}</th></tr></tfoot></table></div>
    <div class="muted" style="font-size:12px;margin-top:6px">A review with two people counts once for each of them, so a person row can add up to more than the Reviews row.</div></div>`);
  card.querySelector("[data-xlsx]").addEventListener("click", () => downloadXlsx(`reviews_by_person_${F.from}_to_${F.to}.xlsx`, [
    { name: "By person", rows: people.map((p) => Object.fromEntries([["Person", p], ...ms.map((m) => [monthName(m), grid.get(p).get(m) || 0]), ["Total", tot(p)]]))
        .concat([Object.fromEntries([["Person", "Reviews (each once)"], ...ms.map((m) => [monthName(m), colTot(m)]), ["Total", rows.length]])]) },
    { name: "Reviews", rows: rows.map((r) => ({ Date: r.day, Order: r.order_id || "", Customer: r.customer_name || "", City: r.city || "",
        People: (r.people || []).join(", "), Stars: r.stars ?? 5, "Posted by": r.sender_name || "", Message: r.raw_text || "", Note: r.note || "" })) },
  ]).catch((e) => toast(e.message, "bad")));
  return card;
}

/* ---------------------------------------------------------------- names that are not on the roster */
function unknownNames(mount) {
  const roster = new Set(NAMES);
  const odd = [...new Set(ROWS.filter((r) => r.status !== "rejected").flatMap((r) => r.people || []))].filter((p) => !roster.has(p)).sort();
  if (!odd.length || isViewer()) return null;
  const card = el(`<div class="card"><h4>Names to check</h4>
    <div class="muted" style="font-size:12px;margin:4px 0 8px">Written in the group but not on the team list. Pick who it is (remembered for next time), or keep it as a person of its own.</div>
    ${odd.map((p) => `<div class="row" style="gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap"><b style="min-width:110px">${esc(p)}</b>
      <select data-to="${esc(p)}"><option value="">is…</option>${NAMES.map((n) => `<option>${esc(n)}</option>`).join("")}</select>
      <button class="btn sm" data-keep="${esc(p)}">Keep as a new person</button></div>`).join("")}</div>`);
  const save = async (alias, person) => {
    try { await rpc("fn_review_alias_set", { p_alias: alias, p_person: person }); await load(); paint(mount); toast(`${alias} → ${person}`, "ok"); }
    catch (e) { toast(e.message || String(e), "bad"); }
  };
  card.querySelectorAll("[data-to]").forEach((s) => s.addEventListener("change", () => s.value && save(s.dataset.to, s.value)));
  card.querySelectorAll("[data-keep]").forEach((b) => b.addEventListener("click", () => save(b.dataset.keep, b.dataset.keep)));
  return card;
}

/* ---------------------------------------------------------------- every review */
function listCard(mount) {
  const q = F.q.trim().toLowerCase(), ro = isViewer();
  const rows = ROWS.filter((r) => inRange(r) && (F.all || r.counted) && (!F.person || (r.people || []).includes(F.person))
    && (!q || [r.order_id, r.customer_name, (r.people || []).join(" "), r.raw_text, r.sender_name].join(" ").toLowerCase().includes(q)));
  const hidden = ROWS.filter((r) => inRange(r) && !r.counted).length;
  const card = el(`<div class="card"><div class="spread" style="margin-bottom:6px;flex-wrap:wrap;gap:8px"><h4>Reviews (${rows.length})</h4>
      <label class="muted" style="font-size:12px"><input type="checkbox" data-all ${F.all ? "checked" : ""}> show rejected and under-5-star too (${hidden})</label></div>
    ${ro ? "" : `<div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px">
      <div><label class="f">Add by hand: date</label><input type="date" name="aday" value="${esc(today())}"></div>
      <div><label class="f">Order</label><input name="aorder" placeholder="order no." style="width:110px"></div>
      <div><label class="f">People (comma between)</label><input name="apeople" list="rvnames" placeholder="e.g. Mohsin, Ranjit" style="min-width:180px"></div>
      <button class="btn sm accent" data-add>＋ Add</button></div>`}
    <datalist id="rvnames">${NAMES.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
    <div class="scrollx" style="padding:0"><table class="dense report"><thead><tr>
      <th>Date</th><th>Order</th><th>Customer</th><th>People</th><th class="num">Stars</th><th>Photo</th><th>From the group</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map((r) => rowHtml(r, ro)).join("") || `<tr><td colspan="9" class="muted">Nothing here yet. Reviews appear a few minutes after they are posted in the Fixer group.</td></tr>`}</tbody></table></div></div>`);
  card.querySelector("[data-all]").addEventListener("change", (e) => { F.all = e.target.checked; paint(mount); });
  const set = async (id, p, msg) => {
    try { await rpc("fn_review_set", { p_id: Number(id), p }); await load(); paint(mount); toast(msg || "Saved", "ok"); }
    catch (e) { toast(e.message || String(e), "bad"); }
  };
  card.querySelectorAll("[data-f]").forEach((i) => i.addEventListener("change", () => {
    const f = i.dataset.f;
    const v = f === "people" ? i.value.split(/[,;/&+]|\band\b/i).map((s) => s.trim()).filter(Boolean) : i.value;
    set(i.dataset.id, { [f]: v });
  }));
  card.querySelectorAll("[data-st]").forEach((b) => b.addEventListener("click", () => set(b.dataset.id, { status: b.dataset.st },
    { rejected: "Rejected - no longer counted", confirmed: "Saved - counted", auto: "Back to automatic" }[b.dataset.st])));
  card.querySelectorAll("[data-photo]").forEach((b) => b.addEventListener("click", () => openPhoto(b.dataset.photo, b.dataset.cap)));
  const add = card.querySelector("[data-add]");
  if (add) add.addEventListener("click", async () => {
    const people = card.querySelector("[name=apeople]").value.split(",").map((s) => s.trim()).filter(Boolean);
    const day = card.querySelector("[name=aday]").value, order_id = card.querySelector("[name=aorder]").value.trim();
    if (!people.length) { toast("Type at least one name", "bad"); return; }
    try { await rpc("fn_review_add", { p: { day, order_id, people } }); await load(); paint(mount); toast("Review added", "ok"); }
    catch (e) { toast(e.message || String(e), "bad"); }
  });
  return card;
}

function rowHtml(r, ro) {
  const st = STATUS[r.status] || STATUS.auto;
  const flags = [!r.order_id ? "no order number" : r.order_unknown ? "order not found" : "", !(r.people || []).length ? "no names" : "",
    r.stars != null && r.stars < 5 ? `${r.stars} stars - not counted` : ""].filter(Boolean);
  const photos = (r.photos || []).map((p, i) => `<button class="btn sm" data-photo="${esc(p.path)}" data-cap="${esc([p.reviewer, p.summary].filter(Boolean).join(" - "))}">📷${r.photos.length > 1 ? " " + (i + 1) : ""}</button>${p.drive_id ? ` <a class="btn sm" href="https://drive.google.com/file/d/${esc(p.drive_id)}/view" target="_blank" rel="noopener" title="Open in Google Drive">Drive ↗</a>` : ""}`).join(" ");
  return `<tr style="${r.counted ? "" : "opacity:.6"}">
    <td style="white-space:nowrap">${ro ? esc(fmtDate(r.day)) : `<input type="date" data-f="day" data-id="${r.id}" value="${esc(r.day)}">`}</td>
    <td>${ro ? `<b>${esc(r.order_id || "")}</b>` : `<input data-f="order_id" data-id="${r.id}" value="${esc(r.order_id || "")}" placeholder="order" style="width:80px">`}</td>
    <td>${esc(r.customer_name || "")}<div class="muted" style="font-size:11px">${esc(r.city || "")}</div></td>
    <td>${ro ? esc((r.people || []).join(", ")) : `<input data-f="people" data-id="${r.id}" list="rvnames" value="${esc((r.people || []).join(", "))}" style="min-width:150px">`}</td>
    <td class="num">${ro ? esc(r.stars ?? "5?") : `<select data-f="stars" data-id="${r.id}"><option value="">5?</option>${[5, 4, 3, 2, 1].map((s) => `<option ${r.stars === s ? "selected" : ""}>${s}</option>`).join("")}</select>`}</td>
    <td style="white-space:nowrap">${photos || `<span class="muted">-</span>`}</td>
    <td style="max-width:260px"><div style="font-size:12px">${esc((r.raw_text || "").slice(0, 140))}</div><div class="muted" style="font-size:11px">${esc(r.sender_name || "")}${r.at ? " · " + esc(fmtDateTime(r.at)) : ""}</div>
      ${flags.length ? `<div style="font-size:11px;color:#9a5b00">⚠ ${esc(flags.join(" · "))}</div>` : ""}</td>
    <td><span class="chip ${st[1]}">${esc(st[0])}</span>${r.edited_by ? `<div class="muted" style="font-size:10px">${esc(r.edited_by)}</div>` : ""}</td>
    <td style="white-space:nowrap">${ro ? "" : r.status === "rejected"
      ? `<button class="btn sm" data-st="confirmed" data-id="${r.id}">Restore</button>`
      : `${r.status === "auto" ? `<button class="btn sm" data-st="confirmed" data-id="${r.id}" title="Lock it: the next capture will not change it">✓</button>` : ""}
         ${r.status === "confirmed" ? `<button class="btn sm" data-st="auto" data-id="${r.id}" title="Let the capture fill it again">Back to automatic</button>` : ""}
         <button class="btn sm" data-st="rejected" data-id="${r.id}" title="Not a review - do not count it">✕</button>`}</td></tr>`;
}

/* Photos live in a private bucket, so each view is a short-lived signed link. */
async function openPhoto(path, caption) {
  try {
    const r = await authedFetch(`${SB_URL}/storage/v1/object/sign/reviews/${encodeURI(path)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 600 }),
    });
    const j = await r.json();
    if (!r.ok || !j.signedURL) throw new Error(j.message || "could not open the photo");
    const url = SB_URL + "/storage/v1" + j.signedURL;
    if (path.endsWith(".pdf")) { window.open(url, "_blank", "noopener"); return; }
    const m = modal(`<div class="spread" style="margin-bottom:8px"><b>${esc(caption || "Review photo")}</b>
        <button class="btn sm" data-x>Close</button></div>
      <img src="${esc(url)}" alt="Review photo" style="max-width:100%;border-radius:8px">`);
    m.sheet.querySelector("[data-x]").addEventListener("click", m.close);
  } catch (e) { toast(e.message || String(e), "bad"); }
}
