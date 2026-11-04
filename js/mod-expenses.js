/* Expense tracking - the crews' float, bills, advances and fuel, in one place to audit.
 *
 * WHERE IT COMES FROM. The expense-capture Edge Function copies the WhatsApp group "Bills to be
 * uploaded" and the Team N day posts every morning, stores each bill in the private team-bills
 * bucket and has the model read it. Every number here is then derived in SQL (see
 * supabase/sql/20261104_expense_tracking_*.sql), so this screen only reads views and calls fn_exp_*.
 *
 * THE LEDGER IS PER CASH HOLDER, not per team: the float belongs to a person and crews change.
 *
 * "Book" is where a float should stand: the first statement's opening, plus confirmed advances,
 * minus the REAL sum of each statement's lines. "Claimed" is what the person last wrote. The gap
 * between them is the audit question.
 *
 * A proof a payer posts arrives as a to-confirm advance. It counts for nothing until somebody here
 * accepts it, because its amount and payee were read by a model from a screenshot.
 *
 * Ops only: RLS refuses everyone else, and the tile is hidden from them.
 */
import { api, rpc, submit, authedFetch, isSignedIn, isViewer } from "./api.js";
import { tr } from "./i18n.js";
import { SB_URL } from "./config.js";
import {
  $, $$, esc, el, aed, aed0, num, fmtDate, fmtDateTime, today, toast, loading, modal, chip, selectHtml,
  downloadCsv,
} from "./ui.js";

const TABS = ["overview", "people", "payments", "bills", "fuel", "audit", "setup"];
const GRADES = ["super", "special", "eplus", "diesel"];
const PAYERS = ["Ashmeet", "Elysha"];
const TONE = { high: "bad", med: "warn", low: "info" };

const st = { tab: "overview", month: "", data: null, flagView: "open", who: "" };

const monthStart = (m) => m + "-01";
function nextMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
}
function monthOptions() {
  const out = [];
  const d = new Date(today() + "T00:00:00");
  for (let i = 0; i < 12; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const v = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
    out.push({ value: v, label: x.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) });
  }
  return out;
}
const sum = (rows, f) => rows.reduce((a, r) => a + Number(r[f] || 0), 0);
const money = (n) => (n === null || n === undefined ? "—" : aed(n));

async function load() {
  const from = monthStart(st.month), to = nextMonth(st.month);
  const range = (c) => `&${c}=gte.${from}&${c}=lt.${to}`;
  const [ledger, statements, receipts, payments, fuelDay, fuelWeek, flags, holders, prices, settings, runs] =
    await Promise.all([
      api("/rest/v1/v_exp_ledger?select=holder_id,display_name,phone,active,confirmed,vehicle_plate,first_opening,first_date,spent,fuel,statements,paid_confirmed,paid_to_confirm,paid_ashmeet,paid_elysha,last_paid,last_date,closing_claimed,book_balance&order=display_name"),
      api("/rest/v1/v_exp_statement?select=wa_id,holder_id,display_name,stmt_date,opening,topup,petrol,parking,salik,darb,food,car_wash,other,total_claimed,lines_sum,closing_claimed,receipts,receipt_fuel,storage_path&order=stmt_date.desc" + range("stmt_date")),
      api("/rest/v1/v_exp_receipt?select=wa_id,sender_phone,day,doc_type,merchant,doc_date,amount,litres,unit_price,grade,plate,receipt_no,storage_path,statement_wa_id&order=day.desc" + range("day")),
      api("/rest/v1/exp_payment?select=id,holder_id,paid_on,amount,paid_by,method,reference,note,source,wa_id,status,voided_at,void_reason,created_by&order=paid_on.desc,id.desc"),
      api("/rest/v1/v_exp_fuel_day?select=holder_id,display_name,day,groups,orders,located,stops,km,km_per_l,kml_assumed,est_litres,price,est_aed,claimed,receipt_litres,no_route,gap,over_day&order=day.desc,display_name" + range("day")),
      api("/rest/v1/v_exp_fuel_week?select=holder_id,display_name,week_start,km,est_aed,claimed,orders,no_route_days,claimed_per_km,peers_per_km,outlier,watch,complete&order=week_start.desc,display_name"),
      api("/rest/v1/v_exp_flags?select=flag_key,severity,flag_type,holder_id,who,day,wa_id,amount,detail,review_status,review_note,reviewed_by,reviewed_at,storage_path&order=day.desc.nullslast"),
      api("/rest/v1/exp_holder?select=id,phone,display_name,member_key,vehicle_plate,km_per_l,fuel_grade,active,confirmed,note&order=display_name"),
      api("/rest/v1/v_exp_fuel_price?select=month,grade,price,source,receipts_median,receipts&order=month.desc"),
      api("/rest/v1/exp_settings?select=key,value,note&order=key"),
      api("/rest/v1/exp_capture_run?select=at,stats,error&order=at.desc&limit=1"),
    ]);
  /* A proof is not a receipt, so its picture has to be looked up separately. */
  const ids = payments.filter((p) => p.wa_id && !p.voided_at).map((p) => `"${p.wa_id}"`);
  const proofs = {};
  if (ids.length) {
    const rows = await api(`/rest/v1/exp_message?select=wa_id,storage_path&wa_id=in.(${encodeURIComponent(ids.join(","))})`);
    rows.forEach((r) => { proofs[r.wa_id] = r.storage_path; });
  }
  st.data = { ledger, statements, receipts, payments, fuelDay, fuelWeek, flags, holders, prices, settings, proofs, run: runs[0] || null };
}

/* Bills live in a private bucket, so each view is a short-lived signed link. */
async function openBill(path) {
  if (!path) return;
  try {
    const r = await authedFetch(`${SB_URL}/storage/v1/object/sign/team-bills/${encodeURI(path)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 600 }),
    });
    const j = await r.json();
    if (!r.ok || !j.signedURL) throw new Error(j.message || "sign failed");
    const url = SB_URL + "/storage/v1" + j.signedURL;
    if (path.endsWith(".pdf")) { window.open(url, "_blank", "noopener"); return; }
    const m = modal(`<div class="spread" style="margin-bottom:8px"><b>${esc(tr("exp.bill"))}</b>
        <button class="btn sm" data-x>${esc(tr("d.close"))}</button></div>
      <img src="${esc(url)}" alt="${esc(tr("exp.bill"))}" style="max-width:100%;border-radius:8px">`);
    m.sheet.querySelector("[data-x]").addEventListener("click", m.close);
  } catch (e) { toast(e.message, "bad"); }
}
const billBtn = (p) => (p ? `<button class="btn sm" data-bill="${esc(p)}">${esc(tr("exp.view"))}</button>` : "");

function wire(box) {
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-bill]");
    if (b) openBill(b.getAttribute("data-bill"));
  });
}

async function write(fn, args, done) {
  const r = await submit(fn, args);
  if (r.status === "failed") { toast(r.error || tr("t.failed"), "bad"); return false; }
  if (r.status === "queued") { toast(tr("exp.queued"), "warn"); return false; }
  toast(done || tr("t.saved"), "ok");
  await refresh();
  return true;
}

let paintAll = null;
async function refresh() {
  loading(true, tr("t.loading"));
  try { await load(); if (paintAll) paintAll(); }
  catch (e) { toast(e.message, "bad"); }
  loading(false);
}

/* ---------------------------------------------------------------- overview */
function overview(box) {
  const d = st.data;
  const paid = d.payments.filter((p) => !p.voided_at && p.status === "confirmed"
    && p.paid_on >= monthStart(st.month) && p.paid_on < nextMonth(st.month));
  const toConfirm = d.payments.filter((p) => !p.voided_at && p.status === "to_confirm");
  const open = d.flags.filter((f) => !f.review_status);
  const high = open.filter((f) => f.severity === "high");
  const outliers = d.fuelWeek.filter((w) => w.outlier).length;
  const float = sum(d.ledger.filter((l) => l.active), "closing_claimed");
  const spent = sum(d.statements, "lines_sum");
  const fuel = sum(d.statements, "petrol");
  const tile = (n, l, cls) => `<div class="tile ${cls || ""}"><div class="tn" style="font-size:20px">${esc(n)}</div><div class="tl">${esc(l)}</div></div>`;
  const byPayer = PAYERS.map((p) => `${p} ${aed0(sum(paid.filter((x) => x.paid_by === p), "amount"))}`).join(" · ");

  box.innerHTML = `
    <div class="expgrid">
      ${tile(aed0(spent), tr("exp.spent"))}
      ${tile(aed0(fuel), tr("exp.fuelClaimed"))}
      ${tile(aed0(sum(paid, "amount")), tr("exp.advances"))}
      ${tile(aed0(float), tr("exp.floatHeld"))}
      ${tile(String(high.length), tr("exp.highFlags"), high.length ? "b-overdue" : "b-done")}
      ${tile(String(toConfirm.length), tr("exp.toConfirm"), toConfirm.length ? "b-today" : "")}
      ${tile(String(outliers), tr("exp.outliers"), outliers ? "b-overdue" : "")}
    </div>
    <div class="muted" style="margin:0 0 12px">${esc(tr("exp.paidBy"))}: ${esc(byPayer)}</div>
    <div class="card"><h4 style="margin-bottom:8px">${esc(tr("exp.attention"))}</h4>
      ${high.length ? `<table class="dense"><tbody>${high.slice(0, 8).map((f) => `<tr>
          <td>${esc(fmtDate(f.day))}</td><td><b>${esc(f.who || "")}</b></td>
          <td>${esc(f.detail)}</td><td>${billBtn(f.storage_path)}</td></tr>`).join("")}</tbody></table>`
        : `<span class="muted">${esc(tr("exp.nothingHigh"))}</span>`}
    </div>
    <div class="card"><h4 style="margin-bottom:8px">${esc(tr("exp.byPerson"))}</h4>
      <div class="tablewrap"><table class="dense"><thead><tr><th>${esc(tr("exp.person"))}</th>
        <th>${esc(tr("exp.statements"))}</th><th>${esc(tr("exp.fuelClaimed"))}</th><th>${esc(tr("exp.spent"))}</th></tr></thead>
      <tbody>${d.ledger.filter((l) => l.active).map((l) => {
        const s = d.statements.filter((x) => x.holder_id === l.holder_id);
        return `<tr><td>${esc(l.display_name)}</td><td>${s.length}</td>
          <td>${aed(sum(s, "petrol"))}</td><td>${aed(sum(s, "lines_sum"))}</td></tr>`;
      }).join("")}</tbody></table></div>
    </div>`;
}

/* ---------------------------------------------------------------- people */
function people(box) {
  const d = st.data;
  box.innerHTML = `<div class="card">
    <div class="muted" style="margin-bottom:8px">${esc(tr("exp.bookHelp"))}</div>
    <div class="tablewrap"><table class="dense"><thead><tr>
      <th>${esc(tr("exp.person"))}</th><th>${esc(tr("exp.vehicle"))}</th><th>${esc(tr("exp.paid"))}</th>
      <th>${esc(tr("exp.spent"))}</th><th>${esc(tr("exp.claimedBal"))}</th><th>${esc(tr("exp.bookBal"))}</th>
      <th>${esc(tr("exp.diff"))}</th><th>${esc(tr("exp.lastStatement"))}</th></tr></thead>
    <tbody>${d.ledger.map((l) => {
      const diff = l.closing_claimed === null ? null : Number(l.closing_claimed) - Number(l.book_balance);
      const bad = diff !== null && Math.abs(diff) > 1;
      return `<tr class="${bad ? "exp-out" : ""}" data-holder="${l.holder_id}" style="cursor:pointer">
        <td><b>${esc(l.display_name)}</b>${l.confirmed ? "" : ` ${chip(tr("exp.unconfirmed"), "warn")}`}</td>
        <td>${esc(l.vehicle_plate || "—")}</td>
        <td>${aed(l.paid_confirmed)}${Number(l.paid_to_confirm) ? `<div class="muted">+${aed(l.paid_to_confirm)} ${esc(tr("exp.pending"))}</div>` : ""}</td>
        <td>${aed(l.spent)}</td><td>${money(l.closing_claimed)}</td><td>${aed(l.book_balance)}</td>
        <td>${diff === null ? "—" : `<b>${aed(diff)}</b>`}</td>
        <td>${esc(fmtDate(l.last_date))}</td></tr>`;
    }).join("")}</tbody></table></div></div>
    <div id="expperson"></div>`;
  $$("[data-holder]", box).forEach((tr_) => tr_.addEventListener("click", () => {
    const id = Number(tr_.getAttribute("data-holder"));
    personDetail($("#expperson", box), id);
  }));
}

function personDetail(box, id) {
  const d = st.data;
  const l = d.ledger.find((x) => x.holder_id === id);
  const s = d.statements.filter((x) => x.holder_id === id);
  box.innerHTML = `<div class="card"><h4 style="margin-bottom:8px">${esc(l.display_name)}</h4>
    <div class="tablewrap"><table class="dense"><thead><tr>
      <th>${esc(tr("exp.date"))}</th><th>${esc(tr("exp.opening"))}</th><th>${esc(tr("exp.petrol"))}</th>
      <th>${esc(tr("exp.parking"))}</th><th>${esc(tr("exp.tolls"))}</th><th>${esc(tr("exp.other"))}</th>
      <th>${esc(tr("exp.total"))}</th><th>${esc(tr("exp.linesAdd"))}</th><th>${esc(tr("exp.closing"))}</th>
      <th>${esc(tr("exp.receipts"))}</th><th></th></tr></thead>
    <tbody>${s.map((x) => {
      const off = x.total_claimed !== null && Math.abs(Number(x.total_claimed) - Number(x.lines_sum)) > 1;
      return `<tr class="${off ? "exp-out" : ""}"><td>${esc(fmtDate(x.stmt_date))}</td><td>${money(x.opening)}</td>
        <td>${money(x.petrol)}</td><td>${money(x.parking)}</td>
        <td>${aed(Number(x.salik || 0) + Number(x.darb || 0))}</td>
        <td>${aed(Number(x.food || 0) + Number(x.car_wash || 0) + Number(x.other || 0))}</td>
        <td>${money(x.total_claimed)}</td><td>${aed(x.lines_sum)}</td><td>${money(x.closing_claimed)}</td>
        <td>${x.receipts}</td><td>${billBtn(x.storage_path)}</td></tr>`;
    }).join("") || `<tr><td colspan="11" class="muted">${esc(tr("exp.none"))}</td></tr>`}</tbody></table></div></div>`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------------------------------------------------------------- payments */
function payments(box) {
  const d = st.data;
  const name = (id) => (d.holders.find((h) => h.id === id) || {}).display_name || tr("exp.unknown");
  const hopts = d.holders.filter((h) => h.active).map((h) => ({ value: h.id, label: h.display_name }));
  const pending = d.payments.filter((p) => p.status === "to_confirm" && !p.voided_at);
  const done = d.payments.filter((p) => p.status === "confirmed" || p.voided_at);

  box.innerHTML = `
    ${pending.length ? `<div class="card"><h4 style="margin-bottom:8px">${esc(tr("exp.toConfirm"))}</h4>
      <div class="muted" style="margin-bottom:8px">${esc(tr("exp.confirmHelp"))}</div>
      ${pending.map((p) => `<div class="exp-line" data-pay="${p.id}">
        <div><b>${aed(p.amount)}</b> · ${esc(fmtDate(p.paid_on))} · ${esc(p.note || "")}
          ${p.reference ? `<span class="muted">${esc(tr("exp.ref"))} ${esc(p.reference)}</span>` : ""}</div>
        <div class="row" style="margin-top:6px">
          ${selectHtml("h", hopts, p.holder_id || "", tr("exp.person"))}
          ${selectHtml("by", PAYERS, p.paid_by)}
          ${billBtn(d.proofs[p.wa_id])}
          <button class="btn sm primary" data-ok>${esc(tr("exp.confirm"))}</button>
          <button class="btn sm" data-void>${esc(tr("exp.notAdvance"))}</button>
        </div></div>`).join("")}</div>` : ""}
    <div class="card"><h4 style="margin-bottom:8px">${esc(tr("exp.addPayment"))}</h4>
      <div class="fgrid" style="margin:0">
        <div><label class="f">${esc(tr("exp.person"))}</label>${selectHtml("ph", hopts, "", "—")}</div>
        <div><label class="f">${esc(tr("exp.date"))}</label><input type="date" name="pd" value="${esc(today())}"></div>
        <div><label class="f">${esc(tr("exp.amount"))}</label><input type="number" step="0.01" min="0" name="pa" inputmode="decimal"></div>
        <div><label class="f">${esc(tr("exp.paidBy"))}</label>${selectHtml("pb", PAYERS, "Ashmeet")}</div>
        <div><label class="f">${esc(tr("exp.method"))}</label><input type="text" name="pm"></div>
        <div><label class="f">${esc(tr("exp.ref"))}</label><input type="text" name="pr"></div>
        <div><label class="f">${esc(tr("exp.note"))}</label><input type="text" name="pn"></div>
        <div style="align-self:end"><button class="btn primary" id="expaddpay">${esc(tr("exp.save"))}</button></div>
      </div></div>
    <div class="card"><div class="spread" style="margin-bottom:8px"><h4>${esc(tr("exp.history"))}</h4>
        <button class="btn sm" id="exppaycsv">CSV</button></div>
      <div class="tablewrap"><table class="dense"><thead><tr><th>${esc(tr("exp.date"))}</th>
        <th>${esc(tr("exp.person"))}</th><th>${esc(tr("exp.amount"))}</th><th>${esc(tr("exp.paidBy"))}</th>
        <th>${esc(tr("exp.ref"))}</th><th>${esc(tr("exp.note"))}</th><th></th></tr></thead>
      <tbody>${done.map((p) => `<tr style="${p.voided_at ? "opacity:.5;text-decoration:line-through" : ""}">
        <td>${esc(fmtDate(p.paid_on))}</td><td>${esc(name(p.holder_id))}</td><td>${aed(p.amount)}</td>
        <td>${esc(p.paid_by)}</td><td>${esc(p.reference || "")}</td>
        <td>${esc(p.voided_at ? p.void_reason : p.note || "")}</td>
        <td>${p.voided_at ? "" : `<button class="btn sm" data-voidid="${p.id}">${esc(tr("exp.void"))}</button>`}</td></tr>`).join("")
        || `<tr><td colspan="7" class="muted">${esc(tr("exp.none"))}</td></tr>`}</tbody></table></div></div>`;

  $$("[data-pay]", box).forEach((row) => {
    const id = Number(row.getAttribute("data-pay"));
    $("[data-ok]", row).addEventListener("click", () => {
      const h = Number($("select[name=h]", row).value);
      if (!h) { toast(tr("exp.pickPerson"), "warn"); return; }
      write("fn_exp_confirm_payment", { p_id: id, p_holder: h, p_paid_by: $("select[name=by]", row).value });
    });
    $("[data-void]", row).addEventListener("click", () => {
      write("fn_exp_void_payment", { p_id: id, p_reason: "Not a team advance" });
    });
  });
  $$("[data-voidid]", box).forEach((b) => b.addEventListener("click", () => {
    const reason = window.prompt(tr("exp.voidWhy"));
    if (reason) write("fn_exp_void_payment", { p_id: Number(b.getAttribute("data-voidid")), p_reason: reason });
  }));
  $("#expaddpay", box).addEventListener("click", () => {
    const v = (n) => $(`[name=${n}]`, box).value;
    const amount = Number(v("pa"));
    if (!Number(v("ph"))) { toast(tr("exp.pickPerson"), "warn"); return; }
    if (!(amount > 0)) { toast(tr("exp.needAmount"), "warn"); return; }
    write("fn_exp_add_payment", {
      p_holder: Number(v("ph")), p_date: v("pd"), p_amount: amount, p_paid_by: v("pb"),
      p_method: v("pm") || null, p_reference: v("pr") || null, p_note: v("pn") || null,
    });
  });
  $("#exppaycsv", box).addEventListener("click", () => downloadCsv("advances.csv", [
    ["Date", "Person", "Amount", "Paid by", "Method", "Reference", "Note", "Status", "Voided"],
    ...done.map((p) => [p.paid_on, name(p.holder_id), p.amount, p.paid_by, p.method, p.reference, p.note, p.status, p.void_reason]),
  ]));
}

/* ---------------------------------------------------------------- bills */
function bills(box) {
  const d = st.data;
  const name = (ph) => (d.holders.find((h) => h.phone === ph) || {}).display_name || ph;
  const rows = d.receipts.filter((r) => !st.who || r.sender_phone === st.who);
  const people_ = [...new Set(d.receipts.map((r) => r.sender_phone))].map((p) => ({ value: p, label: name(p) }));
  box.innerHTML = `<div class="card">
    <div class="spread" style="margin-bottom:8px">
      <div>${selectHtml("bwho", people_, st.who, tr("exp.everyone"))}</div>
      <span class="muted">${rows.length} · ${aed(sum(rows, "amount"))}</span></div>
    <div class="tablewrap"><table class="dense"><thead><tr><th>${esc(tr("exp.received"))}</th>
      <th>${esc(tr("exp.person"))}</th><th>${esc(tr("exp.type"))}</th><th>${esc(tr("exp.merchant"))}</th>
      <th>${esc(tr("exp.billDate"))}</th><th>${esc(tr("exp.amount"))}</th><th>${esc(tr("exp.litres"))}</th>
      <th>${esc(tr("exp.vehicle"))}</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${esc(fmtDate(r.day))}</td><td>${esc(name(r.sender_phone))}</td>
      <td>${esc(r.doc_type || "")}</td><td>${esc(r.merchant || "")}</td><td>${esc(fmtDate(r.doc_date))}</td>
      <td>${money(r.amount)}</td><td>${r.litres ? esc(r.litres) : ""}</td><td>${esc(r.plate || "")}</td>
      <td>${billBtn(r.storage_path)}</td></tr>`).join("")
      || `<tr><td colspan="9" class="muted">${esc(tr("exp.none"))}</td></tr>`}</tbody></table></div></div>`;
  $("select[name=bwho]", box).addEventListener("change", (e) => { st.who = e.target.value; bills(box); });
}

/* ---------------------------------------------------------------- fuel */
function fuelStatus(w) {
  if (w.outlier) return chip(tr("exp.outlier"), "bad");
  if (w.watch) return chip(tr("exp.watch"), "warn");
  if (Number(w.no_route_days) > 0) return chip(tr("exp.noRoute"), "info");
  return chip(tr("exp.ok"), "ok");
}
function fuel(box) {
  const d = st.data;
  const cur = d.prices.filter((p) => p.month === monthStart(st.month));
  const kml = (d.settings.find((s) => s.key === "default_km_per_l") || {}).value;
  // a week counts for a month if any of its seven days falls inside it
  const first = new Date(monthStart(st.month) + "T00:00:00Z");
  first.setUTCDate(first.getUTCDate() - 6);
  const from = first.toISOString().slice(0, 10);
  const weeks = d.fuelWeek.filter((w) => w.week_start >= from && w.week_start < nextMonth(st.month));
  box.innerHTML = `
    <div class="card"><div class="spread"><h4>${esc(tr("exp.monthPrice"))}</h4>
      <span>${cur.map((p) => `<b>${esc(p.grade)}</b> AED ${esc(p.price)}/L
        <span class="muted">(${esc(p.source === "typed" ? tr("exp.typed") : tr("exp.fromReceipts", { n: p.receipts }))})</span>`).join(" · ")
        || `<span class="muted">${esc(tr("exp.noPrice"))}</span>`}</span></div>
      <div class="muted" style="margin-top:8px">${esc(tr("exp.fuelHelp", { kml }))}</div></div>
    <div class="card"><h4 style="margin-bottom:8px">${esc(tr("exp.byWeek"))}</h4>
      <div class="tablewrap"><table class="dense"><thead><tr><th>${esc(tr("exp.week"))}</th>
        <th>${esc(tr("exp.person"))}</th><th>${esc(tr("exp.orders"))}</th><th>km</th><th>${esc(tr("exp.estimate"))}</th>
        <th>${esc(tr("exp.claimed"))}</th><th>${esc(tr("exp.perKm"))}</th><th>${esc(tr("exp.fleetKm"))}</th><th></th></tr></thead>
      <tbody>${weeks.map((w) => `<tr class="${w.outlier ? "exp-out" : w.watch ? "exp-watch" : ""}">
        <td>${esc(fmtDate(w.week_start))}</td><td>${esc(w.display_name)}</td><td>${esc(w.orders)}</td>
        <td>${num(w.km)}</td><td>${money(w.est_aed)}</td><td>${aed(w.claimed)}</td>
        <td>${w.claimed_per_km ?? "—"}</td><td>${w.peers_per_km ?? "—"}</td><td>${fuelStatus(w)}</td></tr>`).join("")
        || `<tr><td colspan="9" class="muted">${esc(tr("exp.none"))}</td></tr>`}</tbody></table></div></div>
    <div class="card"><h4 style="margin-bottom:8px">${esc(tr("exp.byDay"))}</h4>
      <div class="tablewrap"><table class="dense"><thead><tr><th>${esc(tr("exp.date"))}</th>
        <th>${esc(tr("exp.person"))}</th><th>${esc(tr("exp.team"))}</th><th>${esc(tr("exp.orders"))}</th>
        <th>km</th><th>${esc(tr("exp.litres"))}</th><th>${esc(tr("exp.estimate"))}</th><th>${esc(tr("exp.claimed"))}</th></tr></thead>
      <tbody>${d.fuelDay.map((x, i) => `<tr class="${x.over_day ? "exp-watch" : ""}" data-day="${i}" style="cursor:pointer">
        <td>${esc(fmtDate(x.day))}</td><td>${esc(x.display_name)}</td><td>${esc(x.groups || "—")}</td>
        <td>${x.orders}${Number(x.located) < Number(x.orders) ? ` <span class="muted">(${x.located} ${esc(tr("exp.located"))})</span>` : ""}</td>
        <td>${x.km === null ? "—" : num(x.km)}</td><td>${x.est_litres ?? "—"}</td>
        <td>${money(x.est_aed)}</td><td>${aed(x.claimed)}${x.receipt_litres ? `<div class="muted">${esc(x.receipt_litres)} L</div>` : ""}</td></tr>`).join("")
        || `<tr><td colspan="8" class="muted">${esc(tr("exp.none"))}</td></tr>`}</tbody></table></div></div>`;
  $$("[data-day]", box).forEach((row) => row.addEventListener("click", () => {
    const x = d.fuelDay[Number(row.getAttribute("data-day"))];
    const stops = x.stops || [];
    const m = modal(`<div class="spread" style="margin-bottom:8px"><b>${esc(x.display_name)} · ${esc(fmtDate(x.day))}</b>
        <button class="btn sm" data-x>${esc(tr("d.close"))}</button></div>
      ${stops.map((s, i) => `<div class="exp-line"><b>${i + 1}. ${esc(s.order)}</b>
        ${s.lat ? "" : chip(tr("exp.notLocated"), "warn")}
        <div class="muted">${esc(s.address || "")}</div>
        <div class="muted">${esc(s.appt || "")} ${esc(s.note || "")}</div></div>`).join("")
        || `<span class="muted">${esc(tr("exp.none"))}</span>`}`);
    m.sheet.querySelector("[data-x]").addEventListener("click", m.close);
  }));
}

/* ---------------------------------------------------------------- audit */
function audit(box) {
  const d = st.data;
  const rows = d.flags.filter((f) => (st.flagView === "open" ? !f.review_status
    : st.flagView === "query" ? f.review_status === "query" : f.review_status === "ok"));
  const order = { high: 0, med: 1, low: 2 };
  rows.sort((a, b) => order[a.severity] - order[b.severity] || String(b.day).localeCompare(String(a.day)));
  const seg = (v, l) => `<button data-fv="${v}" class="${st.flagView === v ? "on" : ""}">${esc(l)} (${
    d.flags.filter((f) => (v === "open" ? !f.review_status : f.review_status === v)).length})</button>`;
  box.innerHTML = `<div class="card">
    <div class="spread" style="margin-bottom:10px">
      <div class="seg">${seg("open", tr("exp.open"))}${seg("query", tr("exp.queried"))}${seg("ok", tr("exp.cleared"))}</div>
      <button class="btn sm" id="expflagcsv">CSV</button></div>
    ${rows.map((f) => `<div class="exp-line" data-flag="${esc(f.flag_key)}">
      <div class="spread"><div>${chip(tr(`exp.flag.${f.flag_type}`), TONE[f.severity])}
        <b>${esc(f.who || "")}</b> <span class="muted">${esc(fmtDate(f.day))}</span>
        ${f.amount !== null ? `<b>${aed(f.amount)}</b>` : ""}</div>
        <div class="row">${billBtn(f.storage_path)}
          <button class="btn sm" data-r="ok">${esc(tr("exp.clear"))}</button>
          <button class="btn sm" data-r="query">${esc(tr("exp.query"))}</button></div></div>
      <div style="margin-top:4px">${esc(f.detail)}</div>
      ${f.review_status ? `<div class="muted">${esc(f.reviewed_by || "")} · ${esc(fmtDateTime(f.reviewed_at))} ${esc(f.review_note || "")}</div>` : ""}
    </div>`).join("") || `<span class="muted">${esc(tr("exp.none"))}</span>`}</div>`;
  $$("[data-fv]", box).forEach((b) => b.addEventListener("click", () => { st.flagView = b.getAttribute("data-fv"); audit(box); }));
  $$("[data-flag]", box).forEach((row) => $$("[data-r]", row).forEach((b) => b.addEventListener("click", () => {
    const status = b.getAttribute("data-r");
    const note = status === "query" ? window.prompt(tr("exp.queryWhat")) : null;
    write("fn_exp_review_flag", { p_key: row.getAttribute("data-flag"), p_status: status, p_note: note });
  })));
  $("#expflagcsv", box).addEventListener("click", () => downloadCsv("expense-audit.csv", [
    ["Severity", "Type", "Person", "Date", "Amount", "Detail", "Review", "Note", "Reviewed by"],
    ...d.flags.map((f) => [f.severity, f.flag_type, f.who, f.day, f.amount, f.detail, f.review_status, f.review_note, f.reviewed_by]),
  ]));
}

/* ---------------------------------------------------------------- setup */
function setup(box) {
  const d = st.data;
  box.innerHTML = `
    <div class="card"><h4 style="margin-bottom:4px">${esc(tr("exp.holders"))}</h4>
      <div class="muted" style="margin-bottom:8px">${esc(tr("exp.holdersHelp"))}</div>
      ${d.holders.map((h) => `<div class="exp-line" data-h="${h.id}">
        <div class="muted">+${esc(h.phone)} ${esc(h.note || "")}</div>
        <div class="fgrid" style="margin:6px 0 0">
          <div><label class="f">${esc(tr("exp.person"))}</label><input type="text" name="n" value="${esc(h.display_name)}"></div>
          <div><label class="f">${esc(tr("exp.teamName"))}</label><input type="text" name="k" value="${esc(h.member_key || "")}"></div>
          <div><label class="f">${esc(tr("exp.vehicle"))}</label><input type="text" name="v" value="${esc(h.vehicle_plate || "")}"></div>
          <div><label class="f">km/L</label><input type="number" step="0.1" name="l" value="${esc(h.km_per_l ?? "")}" placeholder="${esc(tr("exp.default"))}"></div>
          <div><label class="f">${esc(tr("exp.grade"))}</label>${selectHtml("g", GRADES, h.fuel_grade)}</div>
          <div><label class="f">${esc(tr("exp.isActive"))}</label>${selectHtml("a", [{ value: "1", label: tr("exp.yes") }, { value: "0", label: tr("exp.no") }], h.active ? "1" : "0")}</div>
          <div style="align-self:end"><button class="btn sm primary" data-s>${esc(tr("exp.saveConfirm"))}</button></div>
        </div></div>`).join("")}</div>
    <div class="card"><h4 style="margin-bottom:8px">${esc(tr("exp.setPrice"))}</h4>
      <div class="fgrid" style="margin:0">
        <div><label class="f">${esc(tr("exp.month"))}</label><input type="month" name="fm" value="${esc(st.month)}"></div>
        <div><label class="f">${esc(tr("exp.grade"))}</label>${selectHtml("fg", GRADES, "special")}</div>
        <div><label class="f">AED/L</label><input type="number" step="0.01" name="fp"></div>
        <div style="align-self:end"><button class="btn primary" id="expsaveprice">${esc(tr("exp.save"))}</button></div>
      </div></div>
    <div class="card"><h4 style="margin-bottom:8px">${esc(tr("exp.rules"))}</h4>
      ${d.settings.filter((s) => !s.key.startsWith("base_")).map((s) => `<div class="exp-line" data-set="${esc(s.key)}">
        <div class="spread"><div><b>${esc(s.note || s.key)}</b></div>
        <div class="row"><input type="number" step="any" value="${esc(s.value)}" style="width:90px">
          <button class="btn sm" data-ss>${esc(tr("exp.save"))}</button></div></div></div>`).join("")}</div>`;
  $$("[data-h]", box).forEach((row) => $("[data-s]", row).addEventListener("click", () => {
    const q = (n) => $(`[name=${n}]`, row).value;
    write("fn_exp_save_holder", {
      p_id: Number(row.getAttribute("data-h")), p_name: q("n"), p_member_key: q("k"), p_plate: q("v"),
      p_km_per_l: q("l") ? Number(q("l")) : null, p_grade: q("g"), p_active: q("a") === "1", p_confirmed: true,
    });
  }));
  $("#expsaveprice", box).addEventListener("click", () => {
    const p = Number($("[name=fp]", box).value);
    if (!(p > 0)) { toast(tr("exp.needAmount"), "warn"); return; }
    write("fn_exp_save_price", { p_month: $("[name=fm]", box).value + "-01", p_grade: $("[name=fg]", box).value, p_price: p });
  });
  $$("[data-set]", box).forEach((row) => $("[data-ss]", row).addEventListener("click", () =>
    write("fn_exp_save_setting", { p_key: row.getAttribute("data-set"), p_value: Number($("input", row).value) })));
}

const PAINT = { overview, people, payments, bills, fuel, audit, setup };

export async function render(mount) {
  if (!isSignedIn()) return;
  if (isViewer()) {
    mount.innerHTML = `<div class="card"><b>${esc(tr("role.readOnly"))}</b></div>`;
    return;
  }
  if (!st.month) st.month = today().slice(0, 7);

  mount.innerHTML = `
    <div class="card">
      <div class="spread">
        <div><h3 style="margin:0">${esc(tr("nav.expenses"))}</h3>
          <div class="muted" id="expsub" style="font-size:12px"></div></div>
        <div class="row">${selectHtml("expmonth", monthOptions(), st.month)}
          <button class="btn sm" id="exprefresh">${esc(tr("exp.refresh"))}</button></div>
      </div>
      <div class="subtabs" id="exptabs" style="margin-top:10px">
        ${TABS.map((t) => `<button data-t="${t}">${esc(tr(`exp.tab.${t}`))}</button>`).join("")}
      </div>
    </div>
    <div id="expbody"></div>`;
  const body = $("#expbody", mount);
  wire(body);

  paintAll = () => {
    if (!mount.isConnected) return;
    $$("#exptabs button", mount).forEach((b) => b.classList.toggle("on", b.getAttribute("data-t") === st.tab));
    const r = st.data.run;
    $("#expsub", mount).textContent = r
      ? tr("exp.lastRun", { at: fmtDateTime(r.at) }) + (r.error ? ` · ${r.error}` : "") : "";
    body.innerHTML = "";
    const box = el(`<div></div>`);
    body.appendChild(box);
    PAINT[st.tab](box);
  };

  $$("#exptabs button", mount).forEach((b) => b.addEventListener("click", () => {
    st.tab = b.getAttribute("data-t"); paintAll();
  }));
  $("select[name=expmonth]", mount).addEventListener("change", (e) => { st.month = e.target.value; refresh(); });
  $("#exprefresh", mount).addEventListener("click", async () => {
    try {
      await rpc("fn_exp_run_capture", { p_trigger: "manual", p_days: 3 });
      toast(tr("exp.refreshing"), "ok");
    } catch (e) { toast(e.message, "bad"); }
  });

  await refresh();
}
