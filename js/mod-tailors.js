/* MD Tailors (#/tailors). 10 Nov 2026 (user).
 *
 * The tailor of an order is picked on the Planning sheet (or here). Each row: the order's received date,
 * order number, tailor, and the American and Wave counts - pre-filled from the PO (the Planning view's
 * american_meters / wave_meters, i.e. fabric metres of American- and Wave-stitched lines) and editable,
 * because what the tailor is paid for is what was actually stitched. Amount = American × rate + Wave ×
 * rate, from tailor_rate: Ali 4 American / 6 Wave, everybody else 5 / 7 (editable under Rates).
 *
 * Payments: a status per order (unpaid / partly paid / paid / on hold) and, per tailor, a statement of
 * account (SOA) for any date range - printed through the browser like every other PDF in the app.
 */
import { apiAll, rpc, isSignedIn, isViewer } from "./api.js";
import { esc, el, toast, loading, fmtDate, today, printSheet, downloadXlsx, aed } from "./ui.js";

const PAY = [["unpaid", "Unpaid", "warn"], ["partial", "Partly paid", "info"], ["paid", "Paid", "ok"], ["hold", "On hold", "bad"]];
const payOf = (v) => PAY.find((p) => p[0] === v) || PAY[0];
const n2 = (v) => (Math.round((Number(v) || 0) * 100) / 100);
const isoShift = (iso, d) => { const [y, m, x] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, x + d)).toISOString().slice(0, 10); };

let TAB = "orders";
let F = { from: isoShift(today(), -30), to: today(), tailor: "", pay: "", q: "" };
let ROWS = [], TAILORS = [], RATES = [], UNASSIGNED = [];

export async function render(mount) {
  if (!isSignedIn()) return;
  mount.innerHTML = `<div class="sectionbar"><div class="subtabs"><a href="#/home">🏠 Home</a><button class="on">🪡 MD Tailors</button></div></div>
    <div class="subtabs" id="tlt" style="margin:6px 0">
      <button data-t="orders">Orders</button><button data-t="soa">Payments &amp; SOA</button><button data-t="rates">Rates &amp; tailors</button></div>
    <div class="card" id="tlf"></div><div id="tlb"></div>`;
  mount.querySelectorAll("#tlt [data-t]").forEach((b) => b.addEventListener("click", () => { TAB = b.dataset.t; paint(mount); }));
  await load();
  paint(mount);
}

async function load() {
  loading(true, "Loading MD Tailors…");
  try {
    [ROWS, TAILORS, RATES] = await Promise.all([
      apiAll("/rest/v1/v_md_tailors?select=*&order=received_date.desc.nullslast,order_id.desc"),
      apiAll("/rest/v1/tailor?select=name,active&order=name.asc"),
      apiAll("/rest/v1/tailor_rate?select=tailor,style,rate_aed&order=tailor.asc"),
    ]);
  } catch (e) { toast(e.message || String(e), "bad"); }
  loading(false);
}

function filtered() {
  const q = F.q.trim().toLowerCase();
  return ROWS.filter((r) => (!F.from || (r.received_date || "") >= F.from) && (!F.to || (r.received_date || "") <= F.to)
    && (!F.tailor || r.tailor === F.tailor) && (!F.pay || r.payment_status === F.pay)
    && (!q || [r.order_id, r.customer_name].join(" ").toLowerCase().includes(q)));
}

function paint(mount) {
  mount.querySelectorAll("#tlt [data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === TAB));
  const fb = mount.querySelector("#tlf"), box = mount.querySelector("#tlb");
  const names = TAILORS.filter((t) => t.active).map((t) => t.name);
  fb.hidden = TAB === "rates";
  fb.innerHTML = `<div class="fgrid">
    <div><label class="f">Received from</label><input type="date" name="from" value="${esc(F.from)}"></div>
    <div><label class="f">to</label><input type="date" name="to" value="${esc(F.to)}"></div>
    <div><label class="f">Tailor</label><select name="tailor"><option value="">All</option>${names.map((n) => `<option ${n === F.tailor ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></div>
    <div><label class="f">Payment</label><select name="pay"><option value="">Any</option>${PAY.map((p) => `<option value="${p[0]}" ${p[0] === F.pay ? "selected" : ""}>${p[1]}</option>`).join("")}</select></div>
    <div><label class="f">Search</label><input name="q" value="${esc(F.q)}" placeholder="order or customer"></div></div>`;
  fb.querySelectorAll("input,select").forEach((i) => i.addEventListener(i.name === "q" ? "input" : "change", () => { F[i.name] = i.value; paint(mount); }));
  box.innerHTML = "";
  if (TAB === "orders") box.appendChild(ordersView(mount, names));
  else if (TAB === "soa") box.appendChild(soaView(mount));
  else box.appendChild(ratesView(mount));
}

/* ---------------------------------------------------------------- orders */
function ordersView(mount, names) {
  const rows = filtered(), ro = isViewer();
  const tot = (k) => n2(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0));
  const wrap = el(`<div>
    <div class="card statrow" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
      <div class="stat"><span class="sn">${rows.length}</span><span class="sl">orders</span></div>
      <div class="stat"><span class="sn">${tot("american_qty")}</span><span class="sl">American</span></div>
      <div class="stat"><span class="sn">${tot("wave_qty")}</span><span class="sl">Wave</span></div>
      <div class="stat"><span class="sn">${esc(aed(tot("amount_aed")))}</span><span class="sl">amount</span></div>
      <div class="stat"><span class="sn">${esc(aed(n2(rows.filter((r) => r.payment_status !== "paid").reduce((a, r) => a + (Number(r.amount_aed) || 0) - (r.payment_status === "partial" ? Number(r.paid_amount) || 0 : 0), 0))))}</span><span class="sl">still to pay</span></div>
    </div>
    ${ro ? "" : `<div class="card row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div><label class="f">Add an order</label><input name="addid" placeholder="order no." style="width:120px"></div>
      <div><label class="f">Tailor</label><select name="addt">${names.map((n) => `<option>${esc(n)}</option>`).join("")}</select></div>
      <button class="btn sm accent" data-add>＋ Add</button>
      <span class="muted" style="flex-basis:100%;font-size:12px">Orders get their tailor on the Planning sheet too. American / Wave start from the PO's stitched-fabric metres; type over them to change the count.</span></div>`}
    <div class="card scrollx" style="padding:0"><table class="dense report"><thead><tr>
      <th>Received</th><th>Order</th><th>Customer</th><th>Tailor</th><th class="num">American</th><th class="num">Wave</th><th class="num">Rate A / W</th>
      <th class="num">Amount</th><th>Payment</th><th>Paid on</th><th>Note</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(fmtDate(r.received_date))}</td><td><b>${esc(r.order_id)}</b></td><td>${esc(r.customer_name || "")}<div class="muted" style="font-size:11px">${esc(r.city || "")}${r.installation_date ? " · install " + esc(fmtDate(r.installation_date)) : ""}</div></td>
      <td>${ro ? esc(r.tailor) : `<select data-f="tailor" data-id="${esc(r.order_id)}"><option value="">— remove —</option>${[...new Set([...names, r.tailor])].map((n) => `<option ${n === r.tailor ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>`}</td>
      <td class="num">${ro ? esc(r.american_qty) : `<input type="number" step="0.1" min="0" data-f="american_qty" data-id="${esc(r.order_id)}" value="${r.american_edited ? esc(r.american_qty) : ""}" placeholder="${esc(r.american_po)}" style="width:70px" title="PO: ${esc(r.american_po)} - leave empty to use it">`}</td>
      <td class="num">${ro ? esc(r.wave_qty) : `<input type="number" step="0.1" min="0" data-f="wave_qty" data-id="${esc(r.order_id)}" value="${r.wave_edited ? esc(r.wave_qty) : ""}" placeholder="${esc(r.wave_po)}" style="width:70px" title="PO: ${esc(r.wave_po)} - leave empty to use it">`}</td>
      <td class="num">${esc(r.american_rate)} / ${esc(r.wave_rate)}</td>
      <td class="num"><b>${esc(aed(r.amount_aed))}</b></td>
      <td>${ro ? esc(payOf(r.payment_status)[1]) : `<select data-f="payment_status" data-id="${esc(r.order_id)}">${PAY.map((p) => `<option value="${p[0]}" ${p[0] === r.payment_status ? "selected" : ""}>${p[1]}</option>`).join("")}</select>`}
        ${r.payment_status === "partial" ? (ro ? ` ${esc(aed(r.paid_amount))}` : `<input type="number" step="1" min="0" data-f="paid_amount" data-id="${esc(r.order_id)}" value="${esc(r.paid_amount ?? "")}" placeholder="paid" style="width:70px">`) : ""}</td>
      <td>${ro ? esc(fmtDate(r.paid_on)) : `<input type="date" data-f="paid_on" data-id="${esc(r.order_id)}" value="${esc(r.paid_on || "")}">`}</td>
      <td>${ro ? esc(r.pay_note || "") : `<input data-f="pay_note" data-id="${esc(r.order_id)}" value="${esc(r.pay_note || "")}" style="min-width:120px">`}</td></tr>`).join("")
      || `<tr><td colspan="11" class="muted">No orders with a tailor in this range.</td></tr>`}</tbody>
    <tfoot><tr><th colspan="4">Total (${rows.length})</th><th class="num">${tot("american_qty")}</th><th class="num">${tot("wave_qty")}</th><th></th><th class="num">${esc(aed(tot("amount_aed")))}</th><th colspan="3"></th></tr></tfoot></table></div>
    <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn sm" data-xlsx>⬇ Excel</button></div></div>`);
  wrap.querySelectorAll("[data-f]").forEach((i) => i.addEventListener("change", async () => {
    const p = { [i.dataset.f]: i.value === "" ? null : i.value };
    try { await rpc("fn_order_tailor_set", { p_order: i.dataset.id, p }); await load(); paint(mount); toast("Saved", "ok"); }
    catch (e) { toast(e.message || String(e), "bad"); }
  }));
  const add = wrap.querySelector("[data-add]");
  if (add) add.addEventListener("click", async () => {
    const id = wrap.querySelector("[name=addid]").value.trim(), t = wrap.querySelector("[name=addt]").value;
    if (!id) return;
    try { await rpc("fn_order_tailor_set", { p_order: id, p: { tailor: t } }); await load(); paint(mount); toast(`${id} → ${t}`, "ok"); }
    catch (e) { toast(e.message || String(e), "bad"); }
  });
  wrap.querySelector("[data-xlsx]").addEventListener("click", () => downloadXlsx(`md_tailors_${F.from}_to_${F.to}.xlsx`, [{ name: "Orders", rows: rows.map((r) => ({
    "Received": r.received_date, "Order": r.order_id, "Customer": r.customer_name, "City": r.city, "Tailor": r.tailor,
    "American": Number(r.american_qty), "Wave": Number(r.wave_qty), "American rate": Number(r.american_rate), "Wave rate": Number(r.wave_rate),
    "Amount (AED)": Number(r.amount_aed), "Payment": payOf(r.payment_status)[1], "Paid amount": r.paid_amount, "Paid on": r.paid_on || "", "Note": r.pay_note || "" })) }])
    .catch((e) => toast(e.message, "bad")));
  return wrap;
}

/* ---------------------------------------------------------------- payments + statement of account */
function soaView(mount) {
  const rows = filtered(), by = new Map();
  rows.forEach((r) => { if (!by.has(r.tailor)) by.set(r.tailor, []); by.get(r.tailor).push(r); });
  const paidOf = (r) => (r.payment_status === "paid" ? Number(r.amount_aed) || 0 : r.payment_status === "partial" ? Number(r.paid_amount) || 0 : 0);
  const wrap = el(`<div><div class="card scrollx" style="padding:0"><table class="dense report"><thead><tr>
      <th>Tailor</th><th class="num">Orders</th><th class="num">American</th><th class="num">Wave</th><th class="num">Amount</th><th class="num">Paid</th><th class="num">Balance</th><th></th></tr></thead>
    <tbody>${[...by.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([t, rs]) => {
      const amt = n2(rs.reduce((a, r) => a + (Number(r.amount_aed) || 0), 0)), paid = n2(rs.reduce((a, r) => a + paidOf(r), 0));
      return `<tr><td><b>${esc(t)}</b></td><td class="num">${rs.length}</td><td class="num">${n2(rs.reduce((a, r) => a + Number(r.american_qty || 0), 0))}</td>
        <td class="num">${n2(rs.reduce((a, r) => a + Number(r.wave_qty || 0), 0))}</td><td class="num">${esc(aed(amt))}</td><td class="num">${esc(aed(paid))}</td>
        <td class="num"><b>${esc(aed(n2(amt - paid)))}</b></td>
        <td style="white-space:nowrap"><button class="btn sm primary" data-soa="${esc(t)}">📄 SOA</button>
          ${isViewer() ? "" : `<button class="btn sm" data-payall="${esc(t)}" title="Mark every unpaid order of ${esc(t)} in this range as paid today">Mark all paid</button>`}</td></tr>`; }).join("")
      || `<tr><td colspan="8" class="muted">Nothing in this range.</td></tr>`}</tbody></table></div>
    <div class="muted" style="font-size:12px;margin-top:6px">The statement covers the received dates in the filter above (${esc(fmtDate(F.from))} – ${esc(fmtDate(F.to))}).</div></div>`);
  wrap.querySelectorAll("[data-soa]").forEach((b) => b.addEventListener("click", () => printSoa(b.dataset.soa, by.get(b.dataset.soa) || [], paidOf)));
  wrap.querySelectorAll("[data-payall]").forEach((b) => b.addEventListener("click", async () => {
    const rs = (by.get(b.dataset.payall) || []).filter((r) => r.payment_status !== "paid");
    if (!rs.length) { toast("Nothing unpaid", ""); return; }
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = `Press again: ${rs.length} order(s)`; b.classList.add("danger"); return; }
    try {
      for (const r of rs) await rpc("fn_order_tailor_set", { p_order: r.order_id, p: { payment_status: "paid", paid_on: today() } });
      toast(`${rs.length} order(s) marked paid`, "ok"); await load(); paint(mount);
    } catch (e) { toast(e.message || String(e), "bad"); }
  }));
  return wrap;
}
function printSoa(tailor, rs, paidOf) {
  const rows = rs.slice().sort((a, b) => String(a.received_date || "").localeCompare(String(b.received_date || "")) || String(a.order_id).localeCompare(String(b.order_id)));
  const amt = n2(rows.reduce((a, r) => a + (Number(r.amount_aed) || 0), 0)), paid = n2(rows.reduce((a, r) => a + paidOf(r), 0));
  const html = `<table class="dense report"><thead><tr><th>Received</th><th>Order</th><th>Customer</th><th class="num">American</th><th class="num">× rate</th>
      <th class="num">Wave</th><th class="num">× rate</th><th class="num">Amount</th><th>Status</th><th>Paid on</th><th class="num">Paid</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${esc(fmtDate(r.received_date))}</td><td>${esc(r.order_id)}</td><td>${esc(r.customer_name || "")}</td>
      <td class="num">${esc(r.american_qty)}</td><td class="num">${esc(r.american_rate)}</td><td class="num">${esc(r.wave_qty)}</td><td class="num">${esc(r.wave_rate)}</td>
      <td class="num">${esc(aed(r.amount_aed))}</td><td>${esc(payOf(r.payment_status)[1])}</td><td>${esc(r.paid_on ? fmtDate(r.paid_on) : "")}</td><td class="num">${esc(aed(paidOf(r)))}</td></tr>`).join("")}</tbody>
    <tfoot><tr><th colspan="7">Total (${rows.length} orders)</th><th class="num">${esc(aed(amt))}</th><th colspan="2">Paid</th><th class="num">${esc(aed(paid))}</th></tr>
      <tr><th colspan="10">Balance due to ${esc(tailor)}</th><th class="num">${esc(aed(n2(amt - paid)))}</th></tr></tfoot></table>`;
  if (!printSheet(`Statement of account · ${tailor}`, `Orders received ${fmtDate(F.from)} – ${fmtDate(F.to)} · printed ${fmtDate(today())}`, html, { portrait: true }))
    toast("The browser blocked the pop-up. Allow pop-ups and try again.", "bad");
}

/* ---------------------------------------------------------------- rates + the tailor list */
function ratesView(mount) {
  const ro = isViewer(), rate = (t, s) => (RATES.find((r) => r.tailor === t && r.style === s) || {}).rate_aed;
  const wrap = el(`<div class="card">
    <h4>Rates (AED per unit)</h4>
    <table class="dense report" style="max-width:520px"><thead><tr><th>Tailor</th><th class="num">American</th><th class="num">Wave</th></tr></thead><tbody>
      <tr><td><b>Everybody else</b></td>${["american", "wave"].map((s) => `<td class="num">${ro ? esc(rate("*", s)) : `<input type="number" step="0.5" min="0" data-rate="*" data-style="${s}" value="${esc(rate("*", s) ?? "")}" style="width:70px">`}</td>`).join("")}</tr>
      ${TAILORS.map((t) => `<tr><td>${esc(t.name)}${t.active ? "" : ` <span class="muted">(inactive)</span>`}</td>${["american", "wave"].map((s) => `<td class="num">${ro ? esc(rate(t.name, s) ?? "") : `<input type="number" step="0.5" min="0" data-rate="${esc(t.name)}" data-style="${s}" value="${esc(rate(t.name, s) ?? "")}" placeholder="${esc(rate("*", s))}" style="width:70px">`}</td>`).join("")}</tr>`).join("")}
    </tbody></table>
    <div class="muted" style="font-size:12px;margin:4px 0 10px">An empty box means the tailor is paid the "Everybody else" rate.</div>
    ${ro ? "" : `<div class="row" style="gap:8px"><input name="newt" placeholder="New tailor's name"><button class="btn sm accent" data-newt>＋ Add tailor</button></div>`}</div>`);
  wrap.querySelectorAll("[data-rate]").forEach((i) => i.addEventListener("change", async () => {
    try { await rpc("fn_tailor_rate_set", { p_tailor: i.dataset.rate, p_style: i.dataset.style, p_rate: i.value === "" ? null : Number(i.value) }); await load(); paint(mount); toast("Rate saved", "ok"); }
    catch (e) { toast(e.message || String(e), "bad"); }
  }));
  const nb = wrap.querySelector("[data-newt]");
  if (nb) nb.addEventListener("click", async () => {
    const v = wrap.querySelector("[name=newt]").value.trim(); if (!v) return;
    try { const n = await rpc("fn_tailor_add", { p_name: v }); toast(`${n} added`, "ok"); await load(); paint(mount); }
    catch (e) { toast(e.message || String(e), "bad"); }
  });
  return wrap;
}
