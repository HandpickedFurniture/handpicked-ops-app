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
import { api, apiAll, rpc, submit, currentActor, queueDepth, isSignedIn } from "./api.js";
import { tr, tv } from "./i18n.js";
import { TRANSFER_STATUSES } from "./config.js";
import {
  $, esc, el, chip, num, fmtDate, fmtDateTime, toast, loading, modal, selectHtml, confirmSheet,
} from "./ui.js";
import { renderFilterBar, toQuery, deriveOptions, activeCount } from "./filters.js";
import { photoStrip, locationSelect, createLocation, locations } from "./photos.js";

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

export async function render(mount, state, setFilters) {
  if (!isSignedIn()) return;
  mount.innerHTML = `<div id="fbar"></div><div id="tstate"></div><div id="tlist"></div>`;

  if (!OPTIONS) {
    try {
      const all = await apiAll("/rest/v1/v_ops_order_roster?select=city,sheet_status,stitching_types,commercial_names,window_refs,fabric_1_codes,fabric_2_codes");
      OPTIONS = deriveOptions(all);
    } catch (e) { OPTIONS = deriveOptions([]); }
  }
  if (!ITEMS) {
    try { ITEMS = await api("/rest/v1/inventory_items?select=id,item_code,name,uom&active=is.true&order=item_code"); }
    catch (e) { ITEMS = []; }
  }

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

  const reload = () => render(mount, state, setFilters);
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
