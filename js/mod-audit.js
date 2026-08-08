/* Module 6 - Photo audit.
 *
 * Every photo ever taken, with the context that makes it evidence: which order, what status change
 * it was attached to, who took it, when, from which location, its checksum, which store holds the
 * bytes, and how many times it has been looked at.
 *
 * Removed photos are still here. fn_ops_delete_photo only soft-deletes - the row, the stored object
 * and the stated reason all survive - because a photo that can be silently erased proves nothing.
 * Tick "include removed" to see them.
 */
import { api, rpc, currentActor, isSignedIn } from "./api.js";
import { tr, tv } from "./i18n.js";
import { PHOTO_CONTEXTS } from "./config.js";
import {
  $, esc, el, chip, num, fmtDate, fmtDateTime, today, toast, loading, modal, selectHtml, downloadCsv,
} from "./ui.js";
import { viewUrl, locations } from "./photos.js";

export async function render(mount, state) {
  if (!isSignedIn()) return;

  const p = state.params;
  const f = {
    order: p.get("order") || "",
    context: p.get("context") || "",
    from: p.get("from") || "",
    to: p.get("to") || "",
    who: p.get("who") || "",
    loc: p.get("loc") || "",
    deleted: p.get("deleted") === "1",
  };

  const locs = await locations();

  mount.innerHTML = `
    <div class="card">
      <div class="fgrid" style="margin:0">
        <div><label class="f">${esc(tr("f.orderId"))}</label>
          <input type="text" name="aorder" value="${esc(f.order)}"></div>
        <div><label class="f">${esc(tr("photo.context"))}</label>
          ${selectHtml("acontext", PHOTO_CONTEXTS.map((c) => ({ value: c.value, label: tr(c.key) })),
                       f.context, tr("f.any"))}</div>
        <div><label class="f">${esc(tr("audit.from"))}</label>
          <input type="date" name="afrom" value="${esc(f.from)}"></div>
        <div><label class="f">${esc(tr("audit.to"))}</label>
          <input type="date" name="ato" value="${esc(f.to)}"></div>
        <div><label class="f">${esc(tr("photo.uploader"))}</label>
          <input type="text" name="awho" value="${esc(f.who)}"></div>
        <div><label class="f">${esc(tr("loc.title"))}</label>
          ${selectHtml("aloc", locs.map((l) => ({ value: l.code, label: `${l.code} — ${l.label}` })),
                       f.loc, tr("f.any"))}</div>
      </div>
      <div class="row" style="justify-content:space-between;margin-top:10px">
        <label class="row" style="gap:6px;font-size:14px;font-weight:600">
          <input type="checkbox" name="adeleted" style="width:auto;min-height:0"
                 ${f.deleted ? "checked" : ""}> ${esc(tr("photo.showDeleted"))}
        </label>
        <div class="row">
          <button class="btn ghost sm" id="aclear">${esc(tr("f.clear"))}</button>
          <button class="btn primary sm" id="aapply">${esc(tr("f.apply"))}</button>
        </div>
      </div>
    </div>
    <div id="abody"></div>`;

  const apply = () => {
    const q = new URLSearchParams();
    const g = (n) => $(`[name="${n}"]`, mount).value.trim();
    if (g("aorder")) q.set("order", g("aorder"));
    if (g("acontext")) q.set("context", g("acontext"));
    if (g("afrom")) q.set("from", g("afrom"));
    if (g("ato")) q.set("to", g("ato"));
    if (g("awho")) q.set("who", g("awho"));
    if (g("aloc")) q.set("loc", g("aloc"));
    if ($('[name="adeleted"]', mount).checked) q.set("deleted", "1");
    location.hash = "/audit" + (q.toString() ? "?" + q.toString() : "");
  };
  $("#aapply", mount).addEventListener("click", apply);
  $("#aclear", mount).addEventListener("click", () => { location.hash = "/audit"; });
  mount.querySelectorAll("input").forEach((i) =>
    i.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); }));

  const box = $("#abody", mount);
  loading(true, tr("t.loading"));

  let url = "/rest/v1/v_ops_photo_audit?select=*&order=uploaded_at.desc&limit=300";
  if (!f.deleted) url += "&deleted_at=is.null";
  if (f.order) url += `&order_id=eq.${encodeURIComponent(f.order)}`;
  if (f.context) url += `&context=eq.${encodeURIComponent(f.context)}`;
  if (f.from) url += `&uploaded_at=gte.${f.from}T00:00:00Z`;
  if (f.to) url += `&uploaded_at=lte.${f.to}T23:59:59Z`;
  if (f.who) url += `&uploaded_by=ilike.*${encodeURIComponent(f.who)}*`;
  if (f.loc) url += `&location_code=eq.${encodeURIComponent(f.loc)}`;

  let rows = [];
  try { rows = await api(url); }
  catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  box.appendChild(el(`
    <div class="card spread">
      <div><b>${esc(tr("audit.total", { n: rows.length }))}</b>
        ${rows.filter((r) => r.is_deleted).length
          ? chip(tr("photo.deleted") + " " + rows.filter((r) => r.is_deleted).length, "warn") : ""}
      </div>
      <button class="btn sm" id="acsv">${esc(tr("audit.export"))}</button>
    </div>`));

  $("#acsv", box).addEventListener("click", () => downloadCsv(`photo_audit_${today()}.csv`,
    rows.map((r) => ({
      id: r.id, order_id: r.order_id, customer: r.customer_name, city: r.city,
      context: r.context, context_label: r.context_label,
      uploaded_by: r.uploaded_by, uploaded_at: r.uploaded_at, taken_at: r.taken_at,
      location: r.location_code, backend: r.storage_backend, bucket: r.bucket,
      object_path: r.object_path, size_bytes: r.size_bytes, sha256: r.sha256,
      views: r.view_count, last_viewed_at: r.last_viewed_at,
      deleted_at: r.deleted_at, deleted_by: r.deleted_by, delete_reason: r.delete_reason,
    }))));

  if (!rows.length) {
    box.appendChild(el(`<div class="card"><span class="muted">${esc(tr("audit.noPhotos"))}</span></div>`));
    return;
  }

  const grid = el(`<div class="pgrid"></div>`);
  rows.forEach((r) => grid.appendChild(photoCard(r, () => render(mount, state))));
  box.appendChild(grid);
}

function photoCard(r, reload) {
  const card = el(`
    <button class="pcard ${r.is_deleted ? "gone" : ""}">
      <div class="pimg">${r.is_deleted ? "🚫" : "🖼️"}</div>
      <div class="pmeta">
        <b>${esc(r.order_id || "—")}</b>
        <div class="muted">${esc(tv(PHOTO_CONTEXTS, r.context))}</div>
        <div class="muted">${esc(fmtDateTime(r.uploaded_at))}</div>
        <div class="muted">${esc(r.uploaded_by || "—")}</div>
        ${r.location_code ? `<div class="muted">📍 ${esc(r.location_code)}</div>` : ""}
        ${r.view_count ? `<div class="muted">${esc(tr("photo.views", { n: r.view_count }))}</div>` : ""}
        ${r.is_deleted ? `<div class="err">${esc(tr("photo.deleted"))}</div>` : ""}
      </div>
    </button>`);

  card.addEventListener("click", () => openDetail(r, reload));
  return card;
}

async function openDetail(r, reload) {
  let url = null;
  try { url = await viewUrl(r, "audit"); }
  catch (e) { toast(e.message, "bad"); }

  const m = modal(`
    <h3>${esc(r.order_id || "—")} · ${esc(tv(PHOTO_CONTEXTS, r.context))}</h3>
    ${r.is_deleted ? `<div class="banner bad" style="margin-top:10px">
       ${esc(tr("photo.deletedBy", { who: r.deleted_by || "?" }))} ·
       ${esc(fmtDateTime(r.deleted_at))}<br>${esc(r.delete_reason || "")}</div>` : ""}
    <div class="lightbox" style="margin-top:10px">
      ${url ? `<img src="${esc(url)}" alt="">` : `<div class="dnone">${esc(tr("d.none"))}</div>`}
    </div>
    <table class="dense" style="margin-top:12px">
      <tbody>
        <tr><td>${esc(tr("photo.context"))}</td><td>${esc(r.context_label || r.context)}</td></tr>
        <tr><td>${esc(tr("col.customer"))}</td><td>${esc(r.customer_name || "—")}</td></tr>
        <tr><td>${esc(tr("photo.uploader"))}</td><td>${esc(r.uploaded_by || "—")}</td></tr>
        <tr><td>${esc(tr("st.visitDate"))}</td><td>${esc(fmtDateTime(r.uploaded_at))}</td></tr>
        <tr><td>${esc(tr("loc.title"))}</td>
            <td>${esc(r.location_code || "—")} ${esc(r.location_label || "")}</td></tr>
        <tr><td>${esc(tr("photo.backend"))}</td>
            <td>${esc(r.storage_backend)} / ${esc(r.bucket)}</td></tr>
        <tr><td>${esc(tr("photo.views"), { n: r.view_count })}</td>
            <td>${esc(r.view_count)}${r.last_viewed_at ? " · " + esc(fmtDateTime(r.last_viewed_at)) : ""}</td></tr>
        <tr><td>${esc(tr("photo.hash"))}</td>
            <td class="mono" style="word-break:break-all">${esc(r.sha256 || "—")}</td></tr>
        <tr><td>${esc(tr("photo.title"))}</td>
            <td class="mono" style="word-break:break-all">${esc(r.object_path)}</td></tr>
      </tbody>
    </table>
    <div class="row" style="justify-content:space-between;margin-top:14px">
      ${r.is_deleted ? "<span></span>"
        : `<button class="btn sm ghost" data-del>${esc(tr("photo.delete"))}</button>`}
      <div class="row">
        ${url ? `<a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener">${esc(tr("photo.open"))}</a>` : ""}
        <button class="btn sm primary" data-close>${esc(tr("d.close"))}</button>
      </div>
    </div>`);

  m.sheet.querySelector("[data-close]").onclick = m.close;

  const del = m.sheet.querySelector("[data-del]");
  if (del) del.addEventListener("click", () => {
    const d = modal(`
      <h3>${esc(tr("photo.delete"))}</h3>
      <div style="margin:12px 0">
        <label class="f">${esc(tr("photo.deleteReason"))}</label>
        <input type="text" name="dreason" autofocus>
        <div class="muted" style="margin-top:6px">${esc(tr("photo.deleted"))} —
          ${esc(tr("audit.title"))}</div>
      </div>
      <div class="row" style="justify-content:flex-end">
        <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
        <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
      </div>`);
    d.sheet.querySelector("[data-no]").onclick = d.close;
    d.sheet.querySelector("[data-yes]").onclick = async () => {
      const reason = d.sheet.querySelector('[name="dreason"]').value.trim();
      // the RPC refuses a blank reason; the audit trail is worthless without one
      if (!reason) return;
      d.close(); m.close();
      try {
        await rpc("fn_ops_delete_photo", { p_id: r.id, p_reason: reason, p_actor: currentActor() });
        toast(tr("t.saved"), "ok");
        reload();
      } catch (e) { toast(e.message, "bad"); }
    };
  });
}
