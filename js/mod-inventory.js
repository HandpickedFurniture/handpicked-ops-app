/* Module 5 - Inventory management.
 *
 * Stock on hand is the SUM OF THE MOVEMENT LEDGER, never a stored number. There is no quantity
 * column to drift out of step with its own history, and every figure on screen can be traced to the
 * movements that produced it.
 *
 * Movements arrive from three places: recorded by hand here, posted automatically by a material
 * transfer (transfer_out / transfer_in), or consumed against an order.
 */
import { api, rpc, submit, currentActor, queueDepth, isSignedIn } from "./api.js";
import { tr, tv } from "./i18n.js";
import { MOVE_REASONS, LOCATION_KINDS } from "./config.js";
import {
  $, esc, el, chip, num, fmtDate, fmtDateTime, toast, loading, modal, selectHtml, downloadCsv,
} from "./ui.js";
import { photoStrip, locationSelect } from "./photos.js";
import { wireNewLocation } from "./mod-transfer.js";

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
        <button class="btn sm accent" id="iadd">+ ${esc(tr("inv.addItem"))}</button>
        <button class="btn sm" id="icsv">${esc(tr("dash.csv"))}</button>
      </div>
    </div>
    <div id="ibody"></div>`;

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
  $("#iadd", mount).addEventListener("click", () => openItemSheet(null, reload));
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

  const list = el(`<div class="olist"></div>`);
  rows.forEach((r) => list.appendChild(itemCard(r, reload)));
  box.appendChild(list);
}

function itemCard(r, reload) {
  const c = el(`
    <div class="ocard ${r.needs_reorder ? "b-overdue" : ""}">
      <div class="ohead">
        <div class="ometa">
          <div class="row" style="gap:6px">
            <span class="oid">${esc(r.item_code)}</span>
            ${chip(`${num(r.on_hand)} ${r.uom}`, r.needs_reorder ? "bad" : "ok",
                   r.needs_reorder ? "!" : "")}
            ${r.location_code ? chip(r.location_code, "info") : ""}
            ${r.photo_count ? chip(String(r.photo_count), "mute", "📷") : ""}
          </div>
          <div class="oname">${esc(r.name)}</div>
          <div class="osub">${esc(r.category || "")}
            ${r.reorder_level ? " · " + esc(tr("inv.reorder")) + " " + esc(num(r.reorder_level)) : ""}
            ${r.last_moved_at ? " · " + esc(fmtDateTime(r.last_moved_at)) : ""}</div>
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
        <button class="btn primary sm" data-move>${esc(tr("act.save"))}</button>
      </div>
    </div>`);
  act.querySelector("[data-loc]").innerHTML = await locationSelect("mloc", r.location_code || "");
  wireNewLocation(act.querySelector('[name="mloc"]'));

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
  wrap.appendChild(act);

  const pb = el(`<div class="dsec"><h4>${esc(tr("photo.title"))}</h4></div>`);
  pb.appendChild(photoStrip({
    context: "inventory", context_id: r.id, context_label: `${r.item_code} — ${r.name}`,
    location_code: r.location_code || null,
  }));
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

function openItemSheet(item, reload) {
  locationSelect("iloc", (item && item.location_code) || "").then((locHtml) => {
    const m = modal(`
      <h3>${esc(tr("inv.addItem"))}</h3>
      <div class="grid2" style="margin-top:12px">
        <div><label class="f">${esc(tr("inv.code"))}</label>
          <input type="text" name="icode" autofocus></div>
        <div><label class="f">${esc(tr("inv.name"))}</label><input type="text" name="iname"></div>
        <div><label class="f">UOM</label><input type="text" name="iuom" value="pc"></div>
        <div><label class="f">${esc(tr("inv.category"))}</label><input type="text" name="icat"></div>
        <div><label class="f">${esc(tr("inv.reorder"))}</label>
          <input type="number" name="ireorder" step="0.01" value="0"></div>
        <div><label class="f">${esc(tr("loc.title"))}</label>${locHtml}</div>
      </div>
      <div id="ierr" class="err hidden" style="margin-top:10px"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
        <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
      </div>`);

    wireNewLocation(m.sheet.querySelector('[name="iloc"]'));
    m.sheet.querySelector("[data-no]").onclick = m.close;
    m.sheet.querySelector("[data-yes]").onclick = async () => {
      const g = (n) => m.sheet.querySelector(`[name="${n}"]`).value.trim();
      const errBox = m.sheet.querySelector("#ierr");
      if (!g("icode") || !g("iname")) {
        errBox.textContent = `${tr("inv.code")} + ${tr("inv.name")}`;
        errBox.classList.remove("hidden");
        return;
      }
      try {
        await api("/rest/v1/inventory_items", {
          method: "POST",
          body: JSON.stringify({
            item_code: g("icode"), name: g("iname"), uom: g("iuom") || "pc",
            category: g("icat") || null,
            reorder_level: Number(g("ireorder") || 0),
            location_code: g("iloc") || null,
          }),
        });
        m.close();
        toast(tr("t.saved"), "ok");
        reload();
      } catch (e) {
        errBox.textContent = e.message;
        errBox.classList.remove("hidden");
      }
    };
  });
}
