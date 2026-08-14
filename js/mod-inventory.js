/* Module 5 - Inventory management.
 *
 * Stock on hand is the SUM OF THE MOVEMENT LEDGER, never a stored number. There is no quantity
 * column to drift out of step with its own history, and every figure on screen can be traced to the
 * movements that produced it.
 *
 * Movements arrive from three places: recorded by hand here, posted automatically by a material
 * transfer (transfer_out / transfer_in), or consumed against an order.
 */
import {
  api, rpc, submit, currentActor, queueDepth, isSignedIn, isViewer, flush, failedWrites,
} from "./api.js";
/* fn_ops_pack_limit and the qty override both live in the database, so the rules hold however the
 * row arrives - not only through this screen. */
import { tr, tv } from "./i18n.js";
import { MOVE_REASONS, LOCATION_KINDS, UOM_OPTIONS, ITEM_CATEGORIES } from "./config.js";
import {
  $, esc, el, chip, num, fmtDate, fmtDateTime, toast, loading, modal, selectHtml, downloadCsv,
  today, confirmSheet,
} from "./ui.js";
import {
  photoStrip, locationSelect, newestPhotoByContext, signedUrlMap, uploadPhoto, viewUrl, openLightbox,
} from "./photos.js";
import { wireNewLocation } from "./mod-transfer.js";
import { syncBar } from "./sync.js";

export async function render(mount, state) {
  if (!isSignedIn()) return;

  const q = state.params.get("q") || "";
  const onlyReorder = state.params.get("reorder") === "1";

  mount.innerHTML = `
    <div class="card spread">
      <div class="row">
        <input type="text" name="isearch" value="${esc(q)}" placeholder="${esc(tr("f.search"))}"
               style="width:auto;min-width:180px">
        <button class="btn sm ${onlyReorder ? "primary" : ""}" id="ireorder">${esc(tr("inv.needsReorder"))}</button>
      </div>
      <div class="row">
        <span id="invsync"></span>
        <button class="btn sm" id="irefresh" title="${esc(tr("inv.refreshHint"))}">↻ ${esc(tr("inv.refresh"))}</button>
        ${isViewer() ? "" : `<button class="btn sm accent" id="iadd">+ ${esc(tr("inv.addItem"))}</button>`}
        <button class="btn sm" id="icsv">${esc(tr("dash.csv"))}</button>
      </div>
    </div>
    <div id="ibody"></div>`;
  $("#invsync", mount).appendChild(syncBar());

  const setP = (k, v) => {
    const p = new URLSearchParams(location.hash.split("?")[1] || "");
    if (v) p.set(k, v); else p.delete(k);
    location.hash = "/inventory?" + p.toString();
  };
  $('[name="isearch"]', mount).addEventListener("keydown", (e) => {
    if (e.key === "Enter") setP("q", e.target.value.trim());
  });
  $("#ireorder", mount).addEventListener("click", () => setP("reorder", onlyReorder ? "" : "1"));

  const box = $("#ibody", mount);
  loading(true, tr("t.loading"));
  let rows = [];
  try {
    let url = "/rest/v1/v_ops_inventory_stock?select=*&order=item_code";
    if (q) url += `&or=(item_code.ilike.*${encodeURIComponent(q)}*,name.ilike.*${encodeURIComponent(q)}*)`;
    if (onlyReorder) url += "&needs_reorder=is.true";
    rows = await api(url);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  const reload = () => render(mount, state);

  /* Push before you pull.
   *
   * Stock moves go through the offline queue (see submit() in api.js), so a change made on a phone
   * that lost signal sits in THAT phone's localStorage until a flush succeeds - it never reached the
   * server, and no amount of refreshing a laptop will show it. This button drains the queue first,
   * then re-reads, and says which of the two actually happened. Anything the server rejected outright
   * is parked in the failed list, where it was previously invisible behind a small header badge. */
  $("#irefresh", mount).addEventListener("click", async () => {
    loading(true, tr("t.loading"));
    const before = queueDepth();
    try { await flush(); } catch (e) { /* reported through the depth below */ }
    const left = queueDepth();
    const failed = failedWrites().length;
    loading(false);
    if (before && !left) toast(tr("inv.syncPushed", { n: before }), "ok");
    else if (left) toast(tr("inv.syncStuck", { n: left }), "bad");
    if (failed) toast(tr("t.failed", { n: failed }), "bad");
    reload();
  });

  const addBtn = $("#iadd", mount);
  if (addBtn) addBtn.addEventListener("click", () => openItemSheet(null, reload));
  $("#icsv", mount).addEventListener("click", () => downloadCsv("inventory.csv", rows.map((r) => ({
    item_code: r.item_code, name: r.name, uom: r.uom, category: r.category,
    on_hand: r.on_hand, reorder_level: r.reorder_level, location: r.location_code,
    last_moved_at: r.last_moved_at,
  }))));

  if (!rows.length) {
    box.innerHTML = `<div class="card"><span class="muted">${esc(tr("inv.noItems"))}</span></div>`;
    return;
  }

  const low = rows.filter((r) => r.needs_reorder).length;
  if (low) box.appendChild(el(`<div class="banner warn">${esc(tr("inv.needsReorder"))}: ${low}</div>`));

  /* The picture for each item, for the whole page in two requests rather than two per row: one to
   * find the newest photo per item, one to sign them all. A stores clerk identifies a bracket or a
   * finial by sight far quicker than by code, which is the whole point of showing these here. */
  const withPhotos = rows.filter((r) => r.photo_count);
  const newest = await newestPhotoByContext("inventory", withPhotos.map((r) => r.id));
  const urls = await signedUrlMap(Array.from(newest.values()));

  /* Ticking items is how a re-order is put together: flag what needs buying, export the list for
   * the supplier, clear it when it lands. The flag is stored on the item rather than held in the
   * page, so "what have we already asked for" survives a reload and a shift change - and it is
   * what the consumption forecasting will read and clear later. */
  const selected = new Set();
  const bulk = reorderBar(rows, selected, reload);
  box.appendChild(bulk.root);

  const list = el(`<div class="olist"></div>`);
  rows.forEach((r) => {
    const photo = newest.get(r.id) || null;
    list.appendChild(itemCard(r, reload, photo, photo ? urls.get(photo.id) : null, selected, bulk));
  });
  box.appendChild(list);
  bulk.update();
}

/* The sticky bar over the item list. Hidden entirely for a viewer: every action on it writes. */
function reorderBar(rows, selected, reload) {
  const root = el(`
    <div class="selbar" hidden>
      <span class="selcount"></span>
      <button class="btn sm primary" data-act="mark">${esc(tr("inv.markReorder"))}</button>
      <button class="btn sm" data-act="clear">${esc(tr("inv.clearReorder"))}</button>
      <button class="btn sm" data-act="csv">${esc(tr("inv.exportReorder"))}</button>
      <button class="btn sm ghost" data-act="none">${esc(tr("bulk.clear"))}</button>
    </div>`);

  const update = () => {
    root.hidden = selected.size === 0 || isViewer();
    root.querySelector(".selcount").textContent = tr("act.selected", { n: selected.size });
  };

  const ids = () => rows.filter((r) => selected.has(String(r.id))).map((r) => r.id);

  const setFlag = async (on) => {
    const list = ids();
    if (!list.length) return;
    loading(true, tr("bulk.working", { n: list.length }));
    try {
      await rpc("fn_ops_set_reorder_flag", {
        p_item_ids: list, p_on: on, p_actor: currentActor(),
      });
    } finally { loading(false); }
    toast(tr(on ? "inv.reorderMarked" : "inv.reorderCleared", { n: list.length }), "ok");
    reload();
  };

  root.querySelector('[data-act="mark"]').addEventListener("click", () => setFlag(true));
  root.querySelector('[data-act="clear"]').addEventListener("click", () => setFlag(false));
  root.querySelector('[data-act="none"]').addEventListener("click", () => {
    selected.clear();
    document.querySelectorAll(".olist input[data-isel]").forEach((c) => { c.checked = false; });
    document.querySelectorAll(".ocard.selected").forEach((c) => c.classList.remove("selected"));
    update();
  });
  root.querySelector('[data-act="csv"]').addEventListener("click", () => {
    const picked = rows.filter((r) => selected.has(String(r.id)));
    downloadCsv(`reorder_${today()}.csv`, picked.map((r) => ({
      item_code: r.item_code, name: r.name, category: r.category || "",
      uom: r.uom, on_hand: r.on_hand, reorder_level: r.reorder_level,
      stock_cover_days: r.stock_cover_days == null ? "" : r.stock_cover_days,
      shortfall: Math.max(0, Number(r.reorder_level || 0) - Number(r.on_hand || 0)),
      location: r.location_code || "", already_flagged: r.reorder_flagged ? "yes" : "",
    })));
  });

  return { root, update };
}

/* The picture tile on an item row. With a photo it opens full size; without one it IS the button
 * that adds the first picture, so an item never sits there with no obvious way to give it a face. */
function itemThumb(r, photo, url, reload) {
  const tile = el(`
    <label class="itemthumb${photo ? "" : " empty"}" title="${esc(photo ? tr("photo.open") : tr("photo.add"))}">
      ${url ? `<img src="${esc(url)}" alt="${esc(r.name)}" loading="lazy">`
            : `<span class="ph">${photo ? "🖼️" : "📷"}</span>`}
      <input type="file" accept="image/*" capture="environment" hidden>
      <span class="badge">＋</span>
    </label>`);

  const input = tile.querySelector("input");
  const img = tile.querySelector("img");
  if (img) img.addEventListener("error", () => { img.remove(); tile.classList.add("empty"); });

  const upload = async (file) => {
    if (!file) return;
    tile.classList.add("busy");
    try {
      await uploadPhoto(file, {
        context: "inventory", context_id: r.id,
        context_label: `${r.item_code} — ${r.name}`,
        location_code: r.location_code || null,
      });
      toast(tr("photo.saved", { n: 1 }), "ok");
      reload();
    } catch (e) {
      toast(e.message || String(e), "bad");
      tile.classList.remove("busy");
    }
  };
  input.addEventListener("change", () => { const f = input.files && input.files[0]; input.value = ""; upload(f); });

  // the whole card header opens the panel - the tile has to keep its clicks to itself
  tile.addEventListener("click", async (e) => {
    e.stopPropagation();
    // the little + always adds; the tile body opens the picture once there is one
    if (!photo || e.target.closest(".badge")) return;      // fall through to the file input
    e.preventDefault();
    try { openLightbox(await viewUrl(photo), photo); }
    catch (err) { toast(err.message, "bad"); }
  });
  return tile;
}

function itemCard(r, reload, photo, url, selected, bulk) {
  const c = el(`
    <div class="ocard ${r.needs_reorder ? "b-overdue" : ""}">
      <div class="ohead">
        ${isViewer() ? "" : `<input type="checkbox" data-isel value="${esc(r.id)}"
            aria-label="${esc(r.item_code)}" style="flex:none;margin-top:4px">`}
        <span data-thumbslot></span>
        <!-- Name first and bold, SKU beneath it. People look for "gromment pliers", not for
             FT-0042 - the code is how the shelf is labelled, not how the item is recognised. -->
        <div class="ometa">
          <div class="row" style="gap:6px">
            <span class="oid">${esc(r.name)}</span>
            ${chip(`${num(r.on_hand)} ${r.uom}`, r.needs_reorder ? "bad" : "ok",
                   r.needs_reorder ? "!" : "")}
            ${r.reorder_flagged ? chip(tr("inv.onOrder"), "warn", "↻") : ""}
            ${r.location_code ? chip(r.location_code, "info") : ""}
            ${r.photo_count ? chip(String(r.photo_count), "mute", "📷") : ""}
          </div>
          <div class="osub mono">${esc(r.item_code)}</div>
          <div class="osub">${esc(r.category || "")}
            ${r.reorder_level ? " · " + esc(tr("inv.reorder")) + " " + esc(num(r.reorder_level)) : ""}
            ${r.stock_cover_days ? " · " + esc(r.stock_cover_days) + "d" : ""}
            ${r.last_moved_at ? " · " + esc(fmtDateTime(r.last_moved_at)) : ""}</div>
        </div>
        <span class="ocaret">▾</span>
      </div>
      <div class="dhost"></div>
    </div>`);

  c.querySelector("[data-thumbslot]").replaceWith(itemThumb(r, photo, url, reload));

  // ticking must not also expand the card - the head opens the panel
  const box = c.querySelector("[data-isel]");
  if (box) {
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      if (box.checked) selected.add(String(r.id)); else selected.delete(String(r.id));
      c.classList.toggle("selected", box.checked);
      bulk.update();
    });
  }

  const head = c.querySelector(".ohead");
  const host = c.querySelector(".dhost");
  head.addEventListener("click", async () => {
    if (host.innerHTML) { host.innerHTML = ""; c.querySelector(".ocaret").textContent = "▾"; return; }
    c.querySelector(".ocaret").textContent = "▴";
    await itemPanel(host, r, reload);
  });
  return c;
}

async function itemPanel(host, r, reload) {
  host.innerHTML = `<div class="drawer"><span class="muted">${esc(tr("t.loading"))}</span></div>`;
  let ledger = [];
  try {
    ledger = await api(`/rest/v1/v_ops_inventory_ledger?select=*&item_id=eq.${r.id}&order=moved_at.desc&limit=50`);
  } catch (e) { /* the panel is still useful without history */ }

  const wrap = el(`<div class="drawer"></div>`);

  /* Edit and remove. Removing DEACTIVATES: stock on hand is the sum of the movement ledger, so a
   * hard delete would either orphan the history or destroy the evidence behind the number. The RPC
   * refuses while anything is still on hand, since hiding a real quantity from every count is worse
   * than leaving a tidy-up undone. */
  if (!isViewer()) {
    const admin = el(`
      <div class="dsec row" style="justify-content:flex-end;gap:8px">
        <button class="btn sm" data-edit>${esc(tr("inv.editItem"))}</button>
        <button class="btn ghost sm" data-del>${esc(tr("inv.deleteItem"))}</button>
      </div>`);
    admin.querySelector("[data-edit]").addEventListener("click", () => openItemSheet(r, reload));
    admin.querySelector("[data-del]").addEventListener("click", async () => {
      if (!await confirmSheet(`${tr("inv.deleteItem")} — ${r.item_code}`, tr("inv.deleteConfirm"))) return;
      try {
        await rpc("fn_ops_set_inventory_item_active",
                  { p_item_id: r.id, p_active: false, p_actor: currentActor() });
        toast(tr("t.saved"), "ok");
        reload();
      } catch (e) { toast(e.message || String(e), "bad"); }
    });
    wrap.appendChild(admin);
  }

  const act = el(`
    <div class="dsec">
      <h4>${esc(tr("inv.move"))}</h4>
      <div class="grid3">
        <div><label class="f">${esc(tr("inv.qty"))}</label>
          <input type="number" name="mqty" class="qty" step="0.01" placeholder="-2"></div>
        <div><label class="f">${esc(tr("inv.reason"))}</label>
          ${selectHtml("mreason", MOVE_REASONS.map((x) => ({ value: x.value, label: tr(x.key) })),
                       "consumption")}</div>
        <div><label class="f">${esc(tr("loc.title"))}</label><span data-loc></span></div>
      </div>
      <div class="grid2" style="margin-top:10px">
        <div><label class="f">${esc(tr("f.orderId"))}</label>
          <input type="text" name="morder" placeholder="${esc(tr("f.any"))}"></div>
        <div><label class="f">${esc(tr("act.comment"))}</label>
          <input type="text" name="mnote"></div>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:8px">
        <button class="btn sm" data-override>${esc(tr("inv.override"))}</button>
        <button class="btn primary sm" data-move>${esc(tr("act.save"))}</button>
      </div>
    </div>`);
  act.querySelector("[data-loc]").innerHTML = await locationSelect("mloc", r.location_code || "");
  wireNewLocation(act.querySelector('[name="mloc"]'));

  // Set the counted quantity. Recorded as the DIFFERENCE, because stock on hand is the sum of the
  // ledger - so a correction stays visible in the history instead of a number silently changing.
  act.querySelector("[data-override]").addEventListener("click", () => {
    const m = modal(`
      <h3>${esc(tr("inv.override"))} — ${esc(r.item_code)}</h3>
      <div class="muted" style="margin:8px 0 12px">${esc(tr("inv.overrideHint"))}</div>
      <div class="grid2">
        <div><label class="f">${esc(tr("inv.onHand"))}</label>
          <input type="text" value="${esc(num(r.on_hand))} ${esc(r.uom)}" disabled></div>
        <div><label class="f">${esc(tr("inv.counted"))}</label>
          <input type="number" name="ocount" step="0.01" autofocus></div>
      </div>
      <div style="margin-top:10px">
        <label class="f">${esc(tr("act.comment"))}</label>
        <input type="text" name="onote" placeholder="Stock count">
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
        <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
      </div>`);
    m.sheet.querySelector("[data-no]").onclick = m.close;
    m.sheet.querySelector("[data-yes]").onclick = async () => {
      const v = m.sheet.querySelector('[name="ocount"]').value;
      if (v === "") return;
      m.close();
      try {
        const res = await rpc("fn_ops_inventory_set_qty", {
          p_item_id: r.id, p_target_qty: Number(v),
          p_note: m.sheet.querySelector('[name="onote"]').value.trim() || null,
          p_location_code: act.querySelector('[name="mloc"]').value || null,
          p_actor: currentActor(),
        });
        toast(Number(res.delta) === 0 ? tr("inv.noChange")
          : tr("inv.was", { n: num(res.previous), m: num(res.new),
                            d: (Number(res.delta) > 0 ? "+" : "") + num(res.delta) }), "ok");
        reload();
      } catch (e) { toast(e.message, "bad"); }
    };
  });

  act.querySelector("[data-move]").addEventListener("click", async () => {
    const qty = Number(act.querySelector('[name="mqty"]').value);
    if (!qty) { toast(tr("inv.qty"), "bad"); return; }
    await submit("fn_ops_inventory_move", {
      p_item_id: r.id, p_qty_delta: qty,
      p_reason: act.querySelector('[name="mreason"]').value,
      p_order_id: act.querySelector('[name="morder"]').value.trim() || null,
      p_location_code: act.querySelector('[name="mloc"]').value || null,
      p_note: act.querySelector('[name="mnote"]').value.trim() || null,
      p_actor: currentActor(),
    });
    toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
    reload();
  });
  /* A viewer gets the ledger and the photos, but nothing that writes. The database would refuse
   * these anyway; drawing them would just be an invitation to a confusing error. */
  if (!isViewer()) {
    wrap.appendChild(act);
    /* ---- packs: reusable container definitions, up to 10 per item */
    wrap.appendChild(await packsSection(r, act, reload));
  }

  const pb = el(`<div class="dsec"><h4>${esc(tr("photo.title"))}</h4></div>`);
  pb.appendChild(photoStrip({
    context: "inventory", context_id: r.id, context_label: `${r.item_code} — ${r.name}`,
    location_code: r.location_code || null,
  }, { readOnly: isViewer() }));
  wrap.appendChild(pb);

  const lb = el(`<div class="dsec"><h4>${esc(tr("inv.ledger"))} <span class="chip mute">${ledger.length}</span></h4></div>`);
  if (!ledger.length) lb.appendChild(el(`<div class="dnone">${esc(tr("d.none"))}</div>`));
  else {
    lb.appendChild(el(`
      <div class="scrollx"><table class="dense">
        <thead><tr>
          <th>${esc(tr("st.visitDate"))}</th><th>${esc(tr("inv.qty"))}</th>
          <th>${esc(tr("inv.reason"))}</th><th>${esc(tr("loc.title"))}</th>
          <th>${esc(tr("f.orderId"))}</th><th>${esc(tr("photo.uploader"))}</th>
          <th>${esc(tr("inv.balance"))}</th>
        </tr></thead>
        <tbody>${ledger.map((m) => `<tr>
          <td>${esc(fmtDateTime(m.moved_at))}</td>
          <td><b style="color:${Number(m.qty_delta) < 0 ? "var(--danger)" : "var(--ok)"}">${
            Number(m.qty_delta) > 0 ? "+" : ""}${esc(num(m.qty_delta))}</b></td>
          <td>${esc(tv(MOVE_REASONS, m.reason))}</td>
          <td>${esc(m.location_code || "—")}</td>
          <td>${esc(m.order_id || "—")}</td>
          <td>${esc(m.actor || "—")}</td>
          <td>${esc(num(m.running_balance))}</td>
        </tr>`).join("")}</tbody>
      </table></div>`));
  }
  wrap.appendChild(lb);

  host.innerHTML = "";
  host.appendChild(wrap);
}

/* Packs are container definitions that live on, so "10 boxes" is enterable next month without
 * anyone remembering that a box holds 100. qty_per_pack is always in the ITEM'S own unit, which is
 * why there is no unit conversion here - and why an m -> sqm pack, which would need a fabric width
 * the inventory does not hold, is deliberately not offered. */
async function packsSection(r, act, reload) {
  let packs = [];
  try {
    packs = await api(`/rest/v1/inventory_packs?select=*&item_id=eq.${r.id}&active=is.true&order=name`);
  } catch (e) { /* the rest of the panel is still useful */ }

  const box = el(`
    <div class="dsec">
      <h4>${esc(tr("inv.packs"))} <span class="chip mute">${packs.length}/10</span></h4>
    </div>`);

  if (!packs.length) box.appendChild(el(`<div class="dnone">${esc(tr("inv.noPacks"))}</div>`));

  packs.forEach((p) => {
    const row = el(`
      <div class="tline">
        <div><b>${esc(p.name)}</b>
          <div class="muted">${esc(num(p.qty_per_pack))} ${esc(r.uom)} ${esc(tr("inv.packQty").toLowerCase())}</div></div>
        <div><input type="number" class="qty" name="pc_${p.id}" step="1" placeholder="0"
             aria-label="${esc(tr("inv.packCount"))}"></div>
        <div class="muted" data-total="${p.id}"></div>
        <div><button class="btn sm accent" data-recv="${p.id}">${esc(tr("inv.receivePacks"))}</button></div>
      </div>`);

    const input = row.querySelector(`[name="pc_${p.id}"]`);
    const totalEl = row.querySelector(`[data-total="${p.id}"]`);
    const showTotal = () => {
      const n = Number(input.value || 0);
      totalEl.textContent = n
        ? tr("inv.packsTotal", { n, q: num(p.qty_per_pack), t: num(n * p.qty_per_pack) + " " + r.uom })
        : "";
    };
    input.addEventListener("input", showTotal);

    row.querySelector(`[data-recv="${p.id}"]`).addEventListener("click", async () => {
      const n = Number(input.value || 0);
      if (!n) { toast(tr("inv.packCount"), "bad"); return; }
      await submit("fn_ops_inventory_move_packs", {
        p_pack_id: p.id, p_pack_count: n,
        p_reason: act.querySelector('[name="mreason"]').value || "purchase",
        p_order_id: act.querySelector('[name="morder"]').value.trim() || null,
        p_location_code: act.querySelector('[name="mloc"]').value || null,
        p_note: null, p_actor: currentActor(),
      });
      toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
      reload();
    });
    box.appendChild(row);
  });

  if (packs.length < 10) {
    const add = el(`<button class="btn sm">+ ${esc(tr("inv.addPack"))}</button>`);
    add.addEventListener("click", () => {
      const m = modal(`
        <h3>${esc(tr("inv.addPack"))} — ${esc(r.item_code)}</h3>
        <div class="grid2" style="margin-top:12px">
          <div><label class="f">${esc(tr("inv.packName"))}</label>
            <input type="text" name="pname" placeholder="Box" autofocus></div>
          <div><label class="f">${esc(tr("inv.packQty"))} (${esc(r.uom)})</label>
            <input type="number" name="pqty" step="0.01" min="0.01" placeholder="100"></div>
        </div>
        <div id="perr" class="err hidden" style="margin-top:10px"></div>
        <div class="row" style="justify-content:flex-end;margin-top:14px">
          <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
          <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
        </div>`);
      m.sheet.querySelector("[data-no]").onclick = m.close;
      m.sheet.querySelector("[data-yes]").onclick = async () => {
        const name = m.sheet.querySelector('[name="pname"]').value.trim();
        const qty = Number(m.sheet.querySelector('[name="pqty"]').value);
        const errBox = m.sheet.querySelector("#perr");
        if (!name || !(qty > 0)) {
          errBox.textContent = `${tr("inv.packName")} + ${tr("inv.packQty")}`;
          errBox.classList.remove("hidden");
          return;
        }
        try {
          await rpc("fn_ops_save_pack", {
            p_item_id: r.id, p_name: name, p_qty_per_pack: qty, p_actor: currentActor(),
          });
          m.close();
          toast(tr("t.saved"), "ok");
          reload();
        } catch (e) {
          errBox.textContent = /10 pack/.test(e.message) ? tr("inv.packLimit") : e.message;
          errBox.classList.remove("hidden");
        }
      };
    });
    box.appendChild(add);
  }

  return box;
}

/* Registering an item.
 *
 * No item-code field: fn_ops_create_inventory_item derives it from the category inside the same
 * statement that inserts the row, so two people adding an item at once cannot collide and nobody
 * has to invent a naming convention at the counter.
 *
 * The photo is picked here but can only be uploaded after the insert returns an id, since a photo
 * is addressed by the item it belongs to. The item is saved either way: a failed photo leaves a
 * registered item with no picture, never a lost item. */
/* Also the EDIT sheet: pass an item to prefill and update it instead of inserting.
 *
 * No Location field. Where a thing physically sits changes every time it is moved, and the move
 * panel below already records that against the movement that caused it - so a location typed once
 * at registration was a second, staler answer to a question already answered properly. */
function openItemSheet(item, reload) {
  const editing = !!(item && item.id);
  const v = (x) => esc(x === null || x === undefined ? "" : String(x));
  const m = modal(`
    <h3>${esc(editing ? tr("inv.editItem") : tr("inv.addItem"))}</h3>
    <div class="grid2" style="margin-top:12px">
      <div><label class="f">${esc(tr("inv.name"))}</label>
        <input type="text" name="iname" value="${v(item && item.name)}" autofocus></div>
      <div><label class="f">${esc(tr("inv.code"))}</label>
        <input type="text" value="${editing ? v(item.item_code) : esc(tr("inv.codeAuto"))}" disabled></div>
      <div><label class="f">${esc(tr("inv.uomLabel"))}</label>
        ${selectHtml("iuom", UOM_OPTIONS.map((u) => ({ value: u.value, label: tr(u.key) })),
                     (item && item.uom) || "pieces")}</div>
      <div><label class="f">${esc(tr("inv.category"))}</label>
        ${selectHtml("icat", ITEM_CATEGORIES.map((c) => ({ value: c.value, label: tr(c.key) })),
                     (item && item.category) || "", tr("inv.catPick"))}</div>
      <div><label class="f">${esc(tr("inv.reorder"))}</label>
        <input type="number" name="ireorder" step="0.01" value="${v((item && item.reorder_level) ?? 0)}"></div>
      <div><label class="f">${esc(tr("inv.stockCover"))}</label>
        <input type="number" name="icover" step="1" min="0" placeholder="30"
               value="${v(item && item.stock_cover_days)}"></div>
      <div><label class="f">${esc(tr("inv.photoOptional"))}</label>
        <label class="btn" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          📷 <span data-photoname>${esc(tr("photo.add"))}</span>
          <input type="file" accept="image/*" capture="environment" name="iphoto" hidden>
        </label></div>
    </div>
    <div class="muted" style="margin-top:8px;font-size:12px">${esc(tr("inv.stockCoverHint"))}</div>
    <div id="ierr" class="err hidden" style="margin-top:10px"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
    </div>`);

  const photoInput = m.sheet.querySelector('[name="iphoto"]');
  photoInput.addEventListener("change", () => {
    const f = photoInput.files && photoInput.files[0];
    m.sheet.querySelector("[data-photoname]").textContent = f ? f.name : tr("photo.add");
  });

  m.sheet.querySelector("[data-no]").onclick = m.close;
  m.sheet.querySelector("[data-yes]").onclick = async () => {
    const g = (n) => m.sheet.querySelector(`[name="${n}"]`).value.trim();
    const errBox = m.sheet.querySelector("#ierr");
    if (!g("iname")) {
      errBox.textContent = tr("inv.name");
      errBox.classList.remove("hidden");
      return;
    }
    try {
      const cover = g("icover") === "" ? null : Number(g("icover"));
      const row = editing
        ? await rpc("fn_ops_update_inventory_item", {
            p_item_id: item.id,
            p_name: g("iname"),
            p_uom: g("iuom") || "pieces",
            p_category: g("icat") || "",
            p_reorder_level: Number(g("ireorder") || 0),
            // -1 is the RPC's "clear it" signal; null there means "leave alone"
            p_stock_cover_days: cover === null ? -1 : cover,
            p_note: null,
            p_actor: currentActor(),
          })
        : await rpc("fn_ops_create_inventory_item", {
            p_name: g("iname"),
            p_uom: g("iuom") || "pieces",
            p_category: g("icat") || null,
            p_reorder_level: Number(g("ireorder") || 0),
            p_stock_cover_days: cover,
            p_location_code: null,
            p_note: null,
            p_actor: currentActor(),
          });
      m.close();

      const file = photoInput.files && photoInput.files[0];
      if (file && row && row.id) {
        try {
          await uploadPhoto(file, {
            context: "inventory", context_id: row.id,
            context_label: `${row.item_code} — ${row.name}`,
            location_code: row.location_code || null,
          });
        } catch (e) {
          // the item is already saved; say what failed rather than implying it all failed
          toast(e.message || String(e), "bad");
        }
      }
      toast(row && row.item_code ? `${tr("t.saved")} — ${row.item_code}` : tr("t.saved"), "ok");
      reload();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
    }
  };
}
