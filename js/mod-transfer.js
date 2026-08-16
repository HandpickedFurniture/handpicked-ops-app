/* Module 4 - Transfer of materials.
 *
 * The order manager's view of physical goods going out and coming back. DISTINCT from the dispatch
 * stages in production tracking: those track outwork stitching (Farooq/Jamal/Shahzad), this tracks
 * materials leaving for installation and what returns.
 *
 * Status is per order (transfer_no allows repeat round trips). Item lines are optional, but they are
 * what makes "partially returned" mean something specific - and what lets the transfer post to the
 * inventory ledger. When lines exist, the status is DERIVED from what actually came back rather than
 * being asserted by hand.
 */
import { api, apiAll, rpc, submit, currentActor, queueDepth, isSignedIn, isViewer } from "./api.js";
import { tr, tv } from "./i18n.js";
import { TRANSFER_STATUSES, HANDOVER_KINDS, HANDOVER_STATUSES } from "./config.js";
import {
  $, esc, el, chip, num, fmtDate, fmtDateTime, toast, loading, modal, selectHtml, confirmSheet,
} from "./ui.js";
import { renderFilterBar, toQuery, deriveOptions, activeCount, writeHash } from "./filters.js";
import { photoStrip, locationSelect, createLocation, locations } from "./photos.js";
import { syncBar } from "./sync.js";

const COLS = [
  // NB: the board exposes the order's status as `status`; `order_status` is the roster's name for it
  "order_id", "customer_name", "city", "installation_date", "date_bucket", "team_no",
  "status", "transfer_id", "transfer_no", "transfer_status", "transfer_location",
  "transfer_changed_at", "photo_count", "issue_note",
  "stitching_types", "commercial_names", "window_refs", "fabric_1_codes", "fabric_2_codes",
  "search_blob", "sheet_status",
].join(",");

let OPTIONS = null;
let ITEMS = null;
let PEOPLE = null;

/* Two screens, because the module answers two questions that overlap but are not the same:
 *   Transfers - where an order's materials are in the going-out-and-coming-back cycle
 *   Handovers - whose hands things are in right now, and whether that person agreed they have them
 * A handover can be of a whole order OR of loose inventory with no order at all, which is why it
 * could not be a column on material_transfers (whose order_id is NOT NULL). */
const SECTIONS = [
  { id: "transfers", key: "tr.title",  icon: "📦", render: (m, s, f) => renderTransfers(m, s, f) },
  { id: "handovers", key: "hnd.title", icon: "🤝", render: (m, s) => renderHandovers(m, s) },
];

export async function render(mount, state, setFilters) {
  if (!isSignedIn()) return;

  const secId = state.params.get("sec") || "transfers";
  const sec = SECTIONS.find((s) => s.id === secId) || SECTIONS[0];

  mount.innerHTML = `
    <div class="sectionbar">
      <div class="subtabs" id="trTabs"></div>
      <span id="trsync"></span>
    </div>
    <div id="trBody"></div>`;
  $("#trsync", mount).appendChild(syncBar());

  $("#trTabs", mount).innerHTML = SECTIONS.map((s) =>
    `<button data-sec="${s.id}" class="${s.id === sec.id ? "on" : ""}">${s.icon} ${esc(tr(s.key))}</button>`
  ).join("");
  $("#trTabs", mount).querySelectorAll("[data-sec]").forEach((b) => {
    b.addEventListener("click", () => {
      const q = new URLSearchParams(location.hash.split("?")[1] || "");
      q.set("sec", b.dataset.sec);
      q.delete("tstatus");     // the two screens have different status vocabularies
      location.hash = "/transfer?" + q.toString();
    });
  });

  /* The filter bar writes the hash from the filters alone, which would drop ?sec= and bounce you
   * back to Transfers the moment you applied a filter on Handovers. Carry it. */
  const keepSec = (f) => writeHash("transfer", f, { sec: sec.id === "transfers" ? "" : sec.id });

  await sec.render($("#trBody", mount), state, keepSec);
}

/* Who can hand something over, and to whom. The active crew, same list the Installation module
 * loads - a handover to a name somebody typed is a handover to nobody. */
async function people() {
  if (PEOPLE) return PEOPLE;
  try {
    const rows = await api("/rest/v1/team_members?select=id,name,display_name,team_no&active=is.true&order=name");
    PEOPLE = rows.map((r) => r.display_name || r.name).filter(Boolean);
  } catch (e) { PEOPLE = []; }
  return PEOPLE;
}

async function items() {
  if (ITEMS) return ITEMS;
  try { ITEMS = await api("/rest/v1/inventory_items?select=id,item_code,name,uom&active=is.true&order=item_code"); }
  catch (e) { ITEMS = []; }
  return ITEMS;
}

async function renderTransfers(mount, state, setFilters) {
  mount.innerHTML = `<div id="fbar"></div><div id="tstate"></div><div id="tlist"></div>`;

  if (!OPTIONS) {
    try {
      const all = await apiAll("/rest/v1/v_ops_order_roster?select=city,sheet_status,stitching_types,commercial_names,window_refs,fabric_1_codes,fabric_2_codes");
      OPTIONS = deriveOptions(all);
    } catch (e) { OPTIONS = deriveOptions([]); }
  }
  await items();

  const bar = $("#fbar", mount);
  const stateBox = $("#tstate", mount);
  const box = $("#tlist", mount);
  const paintBar = () => renderFilterBar(bar, state, OPTIONS, setFilters);
  paintBar();

  const fStatus = state.params.get("tstatus") || "";

  let q = toQuery(state.filters);
  if (fStatus === "__none__") q += "&transfer_status=is.null";
  else if (fStatus) q += `&transfer_status=eq.${encodeURIComponent(fStatus)}`;

  loading(true, tr("t.loading"));
  let rows = [];
  try {
    rows = await apiAll(`/rest/v1/v_ops_status_board?select=${COLS}&order=installation_date.asc.nullslast${q}`, 300);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  state.count = rows.length;
  paintBar();

  // state chips act as a second filter row
  const counts = { __none__: 0 };
  TRANSFER_STATUSES.forEach((s) => { counts[s.value] = 0; });
  rows.forEach((r) => {
    const k = r.transfer_status || "__none__";
    if (counts[k] !== undefined) counts[k]++;
  });

  const chips = el(`<div class="card"><div class="bucketrow" style="margin:0"></div></div>`);
  const row = chips.querySelector(".bucketrow");
  [{ value: "", label: tr("f.any"), n: rows.length },
   ...TRANSFER_STATUSES.map((s) => ({ value: s.value, label: tr(s.key), n: counts[s.value] })),
   { value: "__none__", label: "—", n: counts.__none__ }].forEach((s) => {
    const b = el(`<button class="${fStatus === s.value ? "on" : ""}">${esc(s.label)} ${s.n}</button>`);
    b.addEventListener("click", () => {
      const p = new URLSearchParams(location.hash.split("?")[1] || "");
      if (s.value) p.set("tstatus", s.value); else p.delete("tstatus");
      location.hash = "/transfer?" + p.toString();
    });
    row.appendChild(b);
  });
  stateBox.appendChild(chips);

  if (!rows.length) {
    box.innerHTML = `<div class="card"><span class="muted">${
      esc(activeCount(state.filters) ? tr("t.empty") : tr("t.emptyUnfiltered"))}</span></div>`;
    return;
  }

  // repaint THIS section, not the whole module - re-running render() would nest a second tab strip
  const reload = () => renderTransfers(mount, state, setFilters);
  const list = el(`<div class="olist"></div>`);
  rows.forEach((r) => list.appendChild(card(r, reload)));
  box.appendChild(list);
}

function card(r, reload) {
  const st = TRANSFER_STATUSES.find((s) => s.value === r.transfer_status);
  const c = el(`
    <div class="ocard b-${esc(r.date_bucket)}">
      <div class="ohead">
        <div class="ometa">
          <div class="row" style="gap:6px">
            <span class="oid">${esc(r.order_id)}</span>
            ${st ? chip(tr(st.key), st.tone) : chip("—", "mute")}
            ${r.transfer_location ? chip(r.transfer_location, "info") : ""}
            ${r.photo_count ? chip(tr("photo.count", { n: r.photo_count }), "mute", "📷") : ""}
          </div>
          <div class="oname">${esc(r.customer_name || "—")}</div>
          <div class="osub">${esc(r.city || tr("t.cityUnknown"))} · ${esc(fmtDate(r.installation_date))}
            ${r.transfer_changed_at ? " · " + esc(fmtDateTime(r.transfer_changed_at)) : ""}</div>
        </div>
        <span class="ocaret">▾</span>
      </div>
      <div class="dhost"></div>
    </div>`);

  const head = c.querySelector(".ohead");
  const host = c.querySelector(".dhost");
  head.addEventListener("click", async () => {
    if (host.innerHTML) { host.innerHTML = ""; c.querySelector(".ocaret").textContent = "▾"; return; }
    c.querySelector(".ocaret").textContent = "▴";
    await panel(host, r, reload);
  });
  return c;
}

async function panel(host, r, reload) {
  host.innerHTML = `<div class="drawer"><span class="muted">${esc(tr("t.loading"))}</span></div>`;

  const no = r.transfer_no || 1;
  let lines = [];
  if (r.transfer_id) {
    try {
      lines = await api(`/rest/v1/material_transfer_lines?select=*&transfer_id=eq.${r.transfer_id}&order=id`);
    } catch (e) { /* show the state machine even if lines fail to load */ }
  }
  let handovers = [];
  try {
    await people();
    handovers = await api(
      `/rest/v1/v_ops_handovers?select=*&order_id=eq.${encodeURIComponent(r.order_id)}&order=handed_at.desc`);
  } catch (e) { /* the transfer is still workable without its handover history */ }

  const wrap = el(`<div class="drawer"></div>`);

  /* ---- state machine */
  const sm = el(`
    <div class="dsec">
      <h4>${esc(tr("tr.title"))} — ${esc(tr("tr.no", { n: no }))}</h4>
      <div class="statebtns">
        ${TRANSFER_STATUSES.map((s) => `<button class="btn sm ${
          r.transfer_status === s.value ? "primary" : ""}" data-st="${s.value}">${esc(tr(s.key))}</button>`).join("")}
      </div>
      <div class="grid2" style="margin-top:10px">
        <div><label class="f">${esc(tr("tr.toLocation"))}</label><span data-loc></span></div>
        <div><label class="f">${esc(tr("tr.issueNote"))}</label>
          <input type="text" name="tissue" value="${esc(r.issue_note || "")}"></div>
      </div>
    </div>`);
  sm.querySelector("[data-loc]").innerHTML = await locationSelect("tloc", r.transfer_location || "");
  wireNewLocation(sm.querySelector('[name="tloc"]'));

  sm.querySelectorAll("[data-st]").forEach((b) => {
    b.addEventListener("click", async () => {
      const status = b.dataset.st;
      const issue = sm.querySelector('[name="tissue"]').value.trim();
      // the CHECK constraint rejects an issue with no note; catching it here explains why
      if (status === "issue" && !issue) { toast(tr("tr.issueRequired"), "bad"); return; }
      await submit("fn_ops_set_transfer", {
        p_order_id: r.order_id, p_status: status, p_transfer_no: no,
        p_location_code: sm.querySelector('[name="tloc"]').value || null,
        p_note: null, p_issue_note: issue || null, p_actor: currentActor(),
      });
      toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
      reload();
    });
  });
  wrap.appendChild(sm);

  /* ---- item lines */
  const lb = el(`<div class="dsec"><h4>${esc(tr("tr.lines"))} <span class="chip mute">${lines.length}</span></h4></div>`);
  lines.forEach((l) => lb.appendChild(lineRow(l, r, reload)));

  const add = el(`<button class="btn sm">+ ${esc(tr("tr.addLine"))}</button>`);
  add.addEventListener("click", async () => {
    // a line needs a transfer to hang off; create one on first use
    let tid = r.transfer_id;
    if (!tid) {
      tid = await rpc("fn_ops_set_transfer", {
        p_order_id: r.order_id, p_status: r.transfer_status || "in_progress",
        p_transfer_no: no, p_location_code: null, p_note: null, p_issue_note: null,
        p_actor: currentActor(),
      });
    }
    openLineSheet(tid, null, r, reload);
  });
  lb.appendChild(add);

  if (lines.length) {
    const out = lines.reduce((a, l) => a + Number(l.qty_out || 0), 0);
    const back = lines.reduce((a, l) => a + Number(l.qty_returned || 0), 0);
    const post = el(`
      <div class="row" style="margin-top:10px;align-items:center">
        <button class="btn sm accent" data-post>${esc(tr("tr.post"))}</button>
        <span class="muted">${esc(tr("tr.qtyOut"))} ${esc(num(out))} ·
          ${esc(tr("tr.qtyBack"))} ${esc(num(back))} ·
          ${esc(tr("tr.outstanding"))} <b>${esc(num(out - back))}</b></span>
      </div>
      `);
    post.querySelector("[data-post]").addEventListener("click", async () => {
      const go = await confirmSheet(tr("tr.post"), tr("tr.autoStatus"));
      if (!go) return;
      try {
        const res = await rpc("fn_ops_post_transfer_inventory", {
          p_transfer_id: r.transfer_id, p_actor: currentActor(),
        });
        toast(`${tr("tr.posted")} — ${res.out_lines}/${res.in_lines}`, "ok");
        reload();
      } catch (e) { toast(e.message, "bad"); }
    });
    lb.appendChild(post);
  }
  wrap.appendChild(lb);

  /* ---- who has it
   * The transfer status says the goods are "ready" or "returned"; it never said who is holding them.
   * That is the gap somebody falls into when an order comes back one bracket short. */
  const hb = el(`
    <div class="dsec">
      <div class="spread" style="margin-bottom:8px">
        <h4>${esc(tr("hnd.title"))} <span class="chip mute">${(handovers || []).length}</span></h4>
        ${isViewer() ? "" : `<button class="btn sm" data-hand>+ ${esc(tr("hnd.handOrder"))}</button>`}
      </div>
    </div>`);
  (handovers || []).forEach((h) => {
    const hs = HANDOVER_STATUSES.find((s) => s.value === h.status) || { tone: "mute" };
    hb.appendChild(el(`
      <div class="unit">
        <div class="uname">${esc(h.from_person)} → ${esc(h.to_person)}
          <div class="usub">${esc(fmtDateTime(h.handed_at))}${h.note ? " · " + esc(h.note) : ""}</div>
        </div>
        <div>${chip(tv(HANDOVER_STATUSES, h.status), hs.tone)}</div>
      </div>`));
  });
  if (!(handovers || []).length) hb.appendChild(el(`<div class="dnone">${esc(tr("hnd.none"))}</div>`));
  const handBtn = hb.querySelector("[data-hand]");
  if (handBtn) handBtn.addEventListener("click", () => handoverSheet(r.order_id, reload));
  wrap.appendChild(hb);

  /* ---- photos */
  const pb = el(`<div class="dsec"><h4>${esc(tr("photo.title"))}</h4></div>`);
  pb.appendChild(photoStrip({
    context: "transfer", context_id: r.transfer_id || null, order_id: r.order_id,
    context_label: tr("tr.no", { n: no }),
    location_code: r.transfer_location || null,
  }));
  pb.appendChild(el(`<div class="muted" style="margin-top:6px">${esc(tr("photo.evidenceNote"))}</div>`));
  wrap.appendChild(pb);

  host.innerHTML = "";
  host.appendChild(wrap);
}

function lineRow(l, r, reload) {
  const row = el(`
    <div class="tline">
      <div><b>${esc(l.description)}</b>
        <div class="muted">${esc(l.uom)}${l.location_code ? " · " + esc(l.location_code) : ""}
          ${l.item_id ? "" : " · " + esc(tr("tr.noItem"))}</div></div>
      <div class="muted">${esc(tr("tr.qtyOut"))}<br><b>${esc(num(l.qty_out))}</b></div>
      <div class="muted">${esc(tr("tr.qtyBack"))}<br><b>${esc(num(l.qty_returned))}</b></div>
      <div><button class="btn sm" data-edit>${esc(tr("d.open"))}</button></div>
    </div>`);
  row.querySelector("[data-edit]").addEventListener("click",
    () => openLineSheet(l.transfer_id, l, r, reload));
  return row;
}

function openLineSheet(transferId, l, r, reload) {
  locationSelect("lloc", (l && l.location_code) || "").then((locHtml) => {
    const m = modal(`
      <h3>${esc(l ? tr("tr.lines") : tr("tr.addLine"))}</h3>
      <div style="margin-top:12px">
        <label class="f">${esc(tr("tr.desc"))}</label>
        <input type="text" name="ldesc" value="${esc((l && l.description) || "")}" autofocus>
      </div>
      <div class="grid3" style="margin-top:10px">
        <div><label class="f">${esc(tr("tr.qtyOut"))}</label>
          <input type="number" name="lout" class="qty" step="0.01" min="0"
                 value="${esc((l && l.qty_out) || 0)}"></div>
        <div><label class="f">${esc(tr("tr.qtyBack"))}</label>
          <input type="number" name="lback" class="qty" step="0.01" min="0"
                 value="${esc((l && l.qty_returned) || 0)}"></div>
        <div><label class="f">UOM</label>
          <input type="text" name="luom" value="${esc((l && l.uom) || "pc")}"></div>
      </div>
      <div class="grid2" style="margin-top:10px">
        <div><label class="f">${esc(tr("tr.linkItem"))}</label>
          ${selectHtml("litem", (ITEMS || []).map((i) => ({
            value: i.id, label: `${i.item_code} — ${i.name}` })), (l && l.item_id) || "",
            tr("tr.noItem"))}</div>
        <div><label class="f">${esc(tr("tr.toLocation"))}</label>${locHtml}</div>
      </div>
      <div class="muted" style="margin-top:8px">${esc(tr("tr.autoStatus"))}</div>
      <div id="lerr" class="err hidden" style="margin-top:10px"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
        <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
      </div>`);

    wireNewLocation(m.sheet.querySelector('[name="lloc"]'));
    m.sheet.querySelector("[data-no]").onclick = m.close;
    m.sheet.querySelector("[data-yes]").onclick = async () => {
      const g = (n) => m.sheet.querySelector(`[name="${n}"]`).value;
      const errBox = m.sheet.querySelector("#lerr");
      const out = Number(g("lout") || 0), back = Number(g("lback") || 0);
      if (!g("ldesc").trim()) { errBox.textContent = tr("tr.desc"); errBox.classList.remove("hidden"); return; }
      // mtl_return_check rejects this in the database; saying so here is friendlier
      if (back > out) {
        errBox.textContent = `${tr("tr.qtyBack")} > ${tr("tr.qtyOut")}`;
        errBox.classList.remove("hidden");
        return;
      }
      m.close();
      await submit("fn_ops_save_transfer_line", {
        p_transfer_id: transferId,
        p_description: g("ldesc").trim(),
        p_qty_out: out, p_qty_returned: back,
        p_item_id: g("litem") ? Number(g("litem")) : null,
        p_uom: g("luom") || "pc",
        p_location_code: g("lloc") || null,
        p_note: null,
        p_line_id: l ? l.id : null,
      });
      toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
      reload();
    };
  });
}

/* ---------------------------------------------------------------- handovers
 *
 * "Who has it now?" - the question a transfer status cannot answer, because a transfer says where
 * goods are in the process and a handover says whose hands they are in.
 *
 * Two kinds share this screen. An ORDER handover is a whole job passed to an installer; an INVENTORY
 * handover is loose stock passed to anyone, with no order involved - which is exactly the case that
 * could not live on material_transfers, whose order_id is NOT NULL.
 *
 * Acknowledging is the load-bearing step, not a formality: for an inventory handover it is what
 * posts the lines to the movement ledger. Until the receiver says they have it, the stock has not
 * moved, because "I put it in the van" and "I have it" are different claims.
 */
async function renderHandovers(mount, state) {
  mount.innerHTML = `<div id="hstate"></div><div id="hlist"></div>`;
  const stateBox = $("#hstate", mount);
  const box = $("#hlist", mount);

  const fStatus = state.params.get("hstatus") || "";
  await Promise.all([people(), items()]);

  loading(true, tr("t.loading"));
  let rows = [];
  try {
    rows = await apiAll("/rest/v1/v_ops_handovers?select=*&order=handed_at.desc", 300);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);
  state.count = rows.length;

  const reload = () => renderHandovers(mount, state);

  const counts = {};
  HANDOVER_STATUSES.forEach((s) => { counts[s.value] = rows.filter((r) => r.status === s.value).length; });

  const head = el(`
    <div class="card">
      <div class="spread" style="margin-bottom:9px">
        <h4>${esc(tr("hnd.title"))}</h4>
        ${isViewer() ? "" : `<button class="btn primary sm" data-new>+ ${esc(tr("hnd.new"))}</button>`}
      </div>
      <div class="bucketrow" style="margin:0"></div>
    </div>`);
  const row = head.querySelector(".bucketrow");
  [{ value: "", label: tr("f.any"), n: rows.length },
   ...HANDOVER_STATUSES.map((s) => ({ value: s.value, label: tr(s.key), n: counts[s.value] }))]
    .forEach((s) => {
      const b = el(`<button class="${fStatus === s.value ? "on" : ""}">${esc(s.label)} ${s.n}</button>`);
      b.addEventListener("click", () => {
        const p = new URLSearchParams(location.hash.split("?")[1] || "");
        p.set("sec", "handovers");
        if (s.value) p.set("hstatus", s.value); else p.delete("hstatus");
        location.hash = "/transfer?" + p.toString();
      });
      row.appendChild(b);
    });
  const nb = head.querySelector("[data-new]");
  if (nb) nb.addEventListener("click", () => handoverSheet(null, reload));
  stateBox.appendChild(head);

  const shown = fStatus ? rows.filter((r) => r.status === fStatus) : rows;
  if (!shown.length) {
    box.innerHTML = `<div class="card"><span class="muted">${esc(tr("hnd.none"))}</span></div>`;
    return;
  }

  const list = el(`<div class="olist"></div>`);
  shown.forEach((h) => list.appendChild(handoverCard(h, reload)));
  box.appendChild(list);
}

function handoverCard(h, reload) {
  const st = HANDOVER_STATUSES.find((s) => s.value === h.status) || { tone: "mute" };
  const lines = Array.isArray(h.lines) ? h.lines : [];
  const c = el(`
    <div class="ocard">
      <div class="ohead">
        <div class="ometa">
          <div class="row" style="gap:6px">
            <span class="oid">${esc(h.from_person)} → ${esc(h.to_person)}</span>
            ${chip(tv(HANDOVER_STATUSES, h.status), st.tone)}
            ${chip(tv(HANDOVER_KINDS, h.kind), "mute")}
            ${h.order_id ? chip(h.order_id, "info") : ""}
            ${h.location_code ? chip(h.location_code, "mute", "📍") : ""}
            ${h.posted_at ? chip(tr("hnd.posted"), "ok", "✓") : ""}
          </div>
          <div class="oname">${lines.length
            ? esc(lines.map((l) => `${l.description} ×${num(l.qty)}`).join(" · "))
            : esc(h.customer_name || tr("hnd.wholeOrder"))}</div>
          <div class="osub">${esc(fmtDateTime(h.handed_at))}${
            h.acknowledged_at ? " · " + esc(tr("hnd.acknowledged")) + " " + esc(fmtDateTime(h.acknowledged_at)) : ""}${
            h.note ? " · " + esc(h.note) : ""}</div>
          ${h.dispute_note ? `<div class="err" style="margin-top:4px">${esc(h.dispute_note)}</div>` : ""}
        </div>
        <span class="ocaret">▾</span>
      </div>
      <div class="dhost"></div>
    </div>`);

  const head = c.querySelector(".ohead");
  const host = c.querySelector(".dhost");
  head.addEventListener("click", () => {
    if (host.innerHTML) { host.innerHTML = ""; c.querySelector(".ocaret").textContent = "▾"; return; }
    c.querySelector(".ocaret").textContent = "▴";
    host.appendChild(handoverPanel(h, reload));
  });
  return c;
}

function handoverPanel(h, reload) {
  const lines = Array.isArray(h.lines) ? h.lines : [];
  const wrap = el(`
    <div class="drawer">
      <div class="dsec">
        <h4>${esc(tr("hnd.what"))} <span class="chip mute">${lines.length}</span></h4>
        ${lines.length
          ? lines.map((l) => `<div class="unitrow" style="cursor:default">
               <span class="uname">${esc(l.description)}
                 <span class="usub">${esc(num(l.qty))} ${esc(l.uom || "pc")}${
                   l.item_id ? "" : " · " + esc(tr("tr.noItem"))}</span></span></div>`).join("")
          : `<div class="dnone">${esc(tr("hnd.wholeOrder"))}</div>`}
      </div>
    </div>`);

  if (!isViewer() && h.status === "handed_over") {
    const acts = el(`
      <div class="dsec">
        <h4>${esc(tr("hnd.confirm"))}</h4>
        <p class="muted" style="margin:0 0 9px">${esc(
          h.kind === "inventory" ? tr("hnd.ackPostsStock") : tr("hnd.ackNote"))}</p>
        <div class="row">
          <button class="btn primary sm" data-ack>${esc(tr("hnd.acknowledge"))}</button>
          <button class="btn ghost sm" data-dispute>${esc(tr("hnd.dispute"))}</button>
        </div>
      </div>`);

    acts.querySelector("[data-ack]").addEventListener("click", async () => {
      if (!await confirmSheet(tr("hnd.acknowledge"),
                              h.kind === "inventory" ? tr("hnd.ackPostsStock") : tr("hnd.ackNote"))) return;
      /* NOT queued: acknowledging an inventory handover moves the ledger server-side, and the caller
       * needs the count back to be told that it did. A failure here must be visible, not silent. */
      try {
        const res = await rpc("fn_ops_ack_handover", {
          p_id: h.id, p_status: "acknowledged", p_note: null, p_actor: currentActor(),
        });
        toast(res && res.moved ? tr("hnd.ackMoved", { n: res.moved }) : tr("t.saved"), "ok");
        reload();
      } catch (e) { toast(e.message, "bad"); }
    });

    acts.querySelector("[data-dispute]").addEventListener("click", async () => {
      // the database refuses a dispute with no reason; asking here explains why
      const why = (prompt(tr("hnd.disputeWhat")) || "").trim();
      if (!why) { toast(tr("hnd.disputeRequired"), "bad"); return; }
      try {
        await rpc("fn_ops_ack_handover", {
          p_id: h.id, p_status: "disputed", p_note: why, p_actor: currentActor(),
        });
        toast(tr("t.saved"), "ok");
        reload();
      } catch (e) { toast(e.message, "bad"); }
    });
    wrap.appendChild(acts);
  }

  // photo evidence lives on the transfer context, so a handover photo sits beside the transfer ones
  const pb = el(`<div class="dsec"><h4>${esc(tr("photo.title"))}</h4></div>`);
  pb.appendChild(photoStrip({
    context: "transfer", context_id: null, order_id: h.order_id || null,
    context_label: `${tr("hnd.title")} #${h.id}`,
    location_code: h.location_code || null,
  }));
  wrap.appendChild(pb);
  return wrap;
}

/* New handover. `presetOrder` opens it already pointed at an order, which is how the button inside
 * an order's transfer panel works. */
function handoverSheet(presetOrder, after) {
  const who = (PEOPLE || []).map((p) => ({ value: p, label: p }));
  locationSelect("hloc", "").then((locHtml) => {
    const m = modal(`
      <h3>${esc(tr("hnd.new"))}</h3>
      <div class="grid2" style="margin-top:12px">
        <div><label class="f">${esc(tr("hnd.kind"))}</label>
          ${selectHtml("hkind", HANDOVER_KINDS.map((k) => ({ value: k.value, label: tr(k.key) })),
                       presetOrder ? "order" : "inventory")}</div>
        <div data-orderwrap><label class="f">${esc(tr("f.orderId"))}</label>
          <input type="text" name="horder" inputmode="numeric" value="${esc(presetOrder || "")}"></div>
      </div>
      <div class="grid2" style="margin-top:10px">
        <div><label class="f">${esc(tr("hnd.from"))}</label>
          ${selectHtml("hfrom", who, currentActor() || "", tr("hnd.pickPerson"))}</div>
        <div><label class="f">${esc(tr("hnd.to"))}</label>
          ${selectHtml("hto", who, "", tr("hnd.pickPerson"))}</div>
      </div>
      <div class="grid2" style="margin-top:10px">
        <div><label class="f">${esc(tr("tr.toLocation"))}</label>${locHtml}</div>
        <div><label class="f">${esc(tr("tr.desc"))}</label>
          <input type="text" name="hnote" placeholder="${esc(tr("hnd.notePlaceholder"))}"></div>
      </div>
      <div data-lineswrap style="margin-top:12px">
        <div class="f" style="margin-bottom:6px">${esc(tr("hnd.what"))}</div>
        <div data-lines></div>
        <button class="btn sm" data-addline>+ ${esc(tr("hnd.addItem"))}</button>
      </div>
      <div id="herr" class="err hidden" style="margin-top:10px"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
        <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
      </div>`);

    const q = (s) => m.sheet.querySelector(s);
    wireNewLocation(q('[name="hloc"]'));

    const kind = q('[name="hkind"]');
    /* An order handover is the whole job and needs no item list; an inventory handover is nothing
     * WITHOUT one, since the lines are what moves the stock. Ask for exactly what applies. */
    const sync = () => {
      q("[data-orderwrap]").hidden = kind.value !== "order";
      q("[data-lineswrap]").hidden = kind.value !== "inventory";
    };
    kind.addEventListener("change", sync);
    sync();

    const linesBox = q("[data-lines]");
    const addLine = () => {
      const rowEl = el(`
        <div class="row" style="gap:6px;margin-bottom:6px;align-items:flex-end">
          <div style="flex:2;min-width:150px">
            ${selectHtml("", (ITEMS || []).map((i) => ({ value: i.id, label: `${i.item_code} — ${i.name}` })),
                         "", tr("hnd.pickItem"))}
          </div>
          <div style="flex:1;min-width:70px">
            <input type="number" class="qty" step="0.01" min="0.01" value="1"
                   aria-label="${esc(tr("tr.qtyOut"))}">
          </div>
          <button class="btn ghost sm" data-drop>×</button>
        </div>`);
      rowEl.querySelector("[data-drop]").addEventListener("click", () => rowEl.remove());
      linesBox.appendChild(rowEl);
    };
    q("[data-addline]").addEventListener("click", addLine);
    addLine();

    q("[data-no]").onclick = m.close;
    q("[data-yes]").onclick = async () => {
      const errBox = q("#herr");
      const fail = (msg) => { errBox.textContent = msg; errBox.classList.remove("hidden"); };
      const k = kind.value;
      const from = q('[name="hfrom"]').value.trim();
      const to = q('[name="hto"]').value.trim();
      const orderId = q('[name="horder"]').value.trim();

      if (!from || !to) return fail(tr("hnd.pickPerson"));
      if (from === to) return fail(tr("hnd.samePerson"));
      if (k === "order" && !orderId) return fail(tr("f.orderId"));

      let lines = null;
      if (k === "inventory") {
        lines = Array.from(linesBox.children).map((rowEl) => {
          const sel = rowEl.querySelector("select");
          const qty = Number(rowEl.querySelector("input").value || 0);
          const item = (ITEMS || []).find((i) => String(i.id) === sel.value);
          return item && qty > 0
            ? { item_id: item.id, description: `${item.item_code} — ${item.name}`,
                qty, uom: item.uom || "pc" }
            : null;
        }).filter(Boolean);
        if (!lines.length) return fail(tr("hnd.needItem"));
      }

      m.close();
      await submit("fn_ops_save_handover", {
        p_kind: k,
        p_from_person: from,
        p_to_person: to,
        p_order_id: k === "order" ? orderId : null,
        p_location_code: q('[name="hloc"]').value || null,
        p_note: q('[name="hnote"]').value.trim() || null,
        p_lines: lines,
        p_actor: currentActor(),
        p_op: crypto.randomUUID(),
      });
      toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
      if (after) after();
    };
  });
}

/* The location dropdown carries an "+ new" option so nobody is blocked by a missing code. */
export function wireNewLocation(sel) {
  if (!sel) return;
  sel.addEventListener("change", async () => {
    if (sel.value !== "__new__") return;
    sel.value = "";
    const m = modal(`
      <h3>${esc(tr("photo.addLocation"))}</h3>
      <div class="grid2" style="margin-top:12px">
        <div><label class="f">${esc(tr("loc.code"))}</label>
          <input type="text" name="ncode" placeholder="RACK-B3" autofocus></div>
        <div><label class="f">${esc(tr("loc.label"))}</label>
          <input type="text" name="nlabel" placeholder="Rack B3"></div>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
        <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
      </div>`);
    m.sheet.querySelector("[data-no]").onclick = m.close;
    m.sheet.querySelector("[data-yes]").onclick = async () => {
      const code = m.sheet.querySelector('[name="ncode"]').value.trim().toUpperCase();
      const label = m.sheet.querySelector('[name="nlabel"]').value.trim() || code;
      if (!code) return;
      m.close();
      try {
        await createLocation(code, label, "other");
        const list = await locations();
        sel.innerHTML = `<option value="">${esc(tr("photo.noLocation"))}</option>`
          + list.map((x) => `<option value="${esc(x.code)}">${esc(x.code)} — ${esc(x.label)}</option>`).join("")
          + `<option value="__new__">${esc(tr("photo.addLocation"))}</option>`;
        sel.value = code;
        toast(tr("loc.created"), "ok");
      } catch (e) { toast(e.message, "bad"); }
    };
  });
}
