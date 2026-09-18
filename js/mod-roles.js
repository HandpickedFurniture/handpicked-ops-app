/* Roles - who can do what.
 *
 * Three: 'ops' is the access everyone had before roles existed; 'viewer' reads every module and
 * writes nothing; 'prod_viewer' is a viewer shown the Production tab alone, for people brought in to
 * watch fabric receiving without being able to touch it.
 *
 * ONLY 'ops' WRITES. fn_is_viewer() tests `role <> 'ops'`, so a fourth role added later arrives
 * read-only rather than arriving with write access to 42 tables until somebody notices.
 *
 * THIS SCREEN IS NOT THE ACCESS BOUNDARY. It edits app_roles; the boundary is the RLS policy on
 * every table, which reads that table through fn_is_viewer(). The app ships its publishable key, so
 * a viewer holds a genuine bearer token and could POST to PostgREST without ever loading this page.
 * Hiding buttons is a courtesy to stop people trying; the database is what refuses them.
 *
 * There is deliberately no separate admin role: the brief was two levels, so anyone with full
 * access can change roles - including their own. The guard that matters is that a VIEWER cannot,
 * which app_roles' own write policy enforces.
 */
import { api, isSignedIn, isViewer, currentActor, getSession } from "./api.js";
import { tr } from "./i18n.js";
import { APP_ROLES } from "./config.js";
import { $, esc, el, toast, loading, selectHtml, fmtDateTime } from "./ui.js";

export async function render(mount, state) {
  if (!isSignedIn()) return;

  if (isViewer()) {
    mount.innerHTML = `<div class="card">
      <b>${esc(tr("role.readOnly"))}</b>
      <div class="muted" style="margin-top:6px">${esc(tr("role.readOnlyBody"))}</div></div>`;
    return;
  }

  mount.innerHTML = `<div id="rolebody"></div>`;
  const box = $("#rolebody", mount);

  loading(true, tr("t.loading"));
  let rows = [];
  try {
    rows = await api("/rest/v1/app_roles?select=user_id,email,role,updated_at,updated_by&order=email");
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  const me = getSession() && getSession().user ? getSession().user.id : null;

  const card = el(`<div class="card">
    <h3 style="margin:0 0 4px">${esc(tr("role.manage"))}</h3>
    <div class="muted" style="margin-bottom:12px;font-size:12px">${esc(tr("role.legend"))}</div>
    <div class="rolelist"></div></div>`);
  const list = card.querySelector(".rolelist");

  rows.forEach((r) => {
    const line = el(`
      <div class="tline">
        <div><b>${esc(r.email || r.user_id)}</b>
          ${r.user_id === me ? ` <span class="chip info">${esc(tr("auth.you"))}</span>` : ""}
          <div class="muted">${r.updated_at ? esc(fmtDateTime(r.updated_at)) : ""}
            ${r.updated_by ? " · " + esc(r.updated_by) : ""}</div></div>
        <div>${selectHtml("role_" + r.user_id,
                 APP_ROLES.map((x) => ({ value: x.value, label: tr(x.key) })), r.role)}</div>
        <div></div>
        <div><button class="btn sm primary" data-save="${esc(r.user_id)}">${esc(tr("act.save"))}</button></div>
      </div>`);

    line.querySelector("[data-save]").addEventListener("click", async () => {
      const val = line.querySelector(`[name="role_${r.user_id}"]`).value;
      try {
        await api(`/rest/v1/app_roles?user_id=eq.${r.user_id}`, {
          method: "PATCH",
          body: JSON.stringify({ role: val, updated_at: new Date().toISOString(),
                                 updated_by: currentActor() }),
        });
        toast(tr("role.saved"), "ok");
        // a role change only takes effect on that person's next load; say so rather than imply live
        if (r.user_id === me) location.reload();
      } catch (e) { toast(e.message, "bad"); }
    });
    list.appendChild(line);
  });

  box.appendChild(card);
  box.appendChild(await waSendersCard());
}

/* ---------------------------------------------------------------- WhatsApp senders
 *
 * Who may talk to Chotu over WhatsApp, and what each may do. This table IS the authorization
 * boundary for the inbound path: the wa-inbound function writes with the service role, which
 * bypasses RLS, so nothing but a row here lets a number do anything - an unlisted number gets no
 * reply at all. Five separate capabilities, all off by default, because a warehouse hand who marks
 * fabric received must not be able to charge a client. Revoking keeps the row (revoked_at) so the
 * history stays; the number can be re-enabled by ticking Active again.
 *
 * Phones are stored as bare digits, country code first, no '+' - exactly how Whapi reports a
 * sender, which is the only form fn_wa_sender matches. */
const WA_CAPS = [
  ["can_track", "wa.capTrack"], ["can_receive_fabric", "wa.capFabric"],
  ["can_receive_material", "wa.capMaterial"], ["can_order_status", "wa.capStatus"],
  ["can_adjustment", "wa.capAdjust"], ["can_tailor_log", "wa.capTailor"],
];

async function waSendersCard() {
  let rows = [];
  try {
    // the select list is spelled out so tools/check_columns.py can verify it against the table
    rows = await api("/rest/v1/whatsapp_sender?select=id,phone,display_name,active,revoked_at,note,can_track,can_receive_fabric,can_receive_material,can_order_status,can_adjustment,can_tailor_log&order=revoked_at.nullsfirst,display_name");
  } catch (e) {
    return el(`<div class="card"><span class="err">${esc(e.message)}</span></div>`);
  }
  const card = el(`<div class="card">
    <h3 style="margin:0 0 4px">${esc(tr("wa.title"))}</h3>
    <div class="muted" style="margin-bottom:12px;font-size:12px">${esc(tr("wa.legend"))}</div>
    <div class="walist"></div>
    <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
      <input type="text" name="waphone" inputmode="numeric" placeholder="9715xxxxxxxx" style="width:150px">
      <input type="text" name="waname" placeholder="${esc(tr("wa.name"))}" style="width:180px">
      <button class="btn sm accent" data-add>+ ${esc(tr("wa.add"))}</button>
    </div></div>`);
  const list = card.querySelector(".walist");
  const capsHtml = (r) => WA_CAPS.map(([k, key]) =>
    `<label class="wacap"><input type="checkbox" data-cap="${k}"${r[k] ? " checked" : ""}> ${esc(tr(key))}</label>`).join("");

  rows.forEach((r) => {
    const line = el(`
      <div class="tline waline ${r.revoked_at ? "revoked" : ""}">
        <div><b>${esc(r.display_name || "—")}</b> <span class="muted">+${esc(r.phone)}</span>
          ${r.revoked_at ? ` <span class="chip mute">${esc(tr("wa.revoked"))}</span>` : ""}
          ${r.note ? `<div class="muted">${esc(r.note)}</div>` : ""}</div>
        <div class="wacaps">${capsHtml(r)}
          <label class="wacap"><input type="checkbox" data-active${r.active && !r.revoked_at ? " checked" : ""}> ${esc(tr("wa.active"))}</label></div>
        <div></div>
        <div><button class="btn sm primary" data-save>${esc(tr("act.save"))}</button></div>
      </div>`);
    line.querySelector("[data-save]").addEventListener("click", async () => {
      const patch = { updated_at: new Date().toISOString(), granted_by: currentActor() };
      WA_CAPS.forEach(([k]) => { patch[k] = line.querySelector(`[data-cap="${k}"]`).checked; });
      const active = line.querySelector("[data-active]").checked;
      patch.active = active;
      patch.revoked_at = active ? null : (r.revoked_at || new Date().toISOString());
      try {
        await api(`/rest/v1/whatsapp_sender?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify(patch) });
        toast(tr("wa.saved"), "ok");
      } catch (e) { toast(e.message, "bad"); }
    });
    list.appendChild(line);
  });
  if (!rows.length) list.innerHTML = `<div class="muted">${esc(tr("wa.none"))}</div>`;

  card.querySelector("[data-add]").addEventListener("click", async () => {
    const phone = card.querySelector('[name="waphone"]').value.replace(/\D/g, "");
    const name = card.querySelector('[name="waname"]').value.trim();
    if (!/^[0-9]{8,15}$/.test(phone)) { toast(tr("wa.badPhone"), "bad"); return; }
    try {
      // arrives with every capability OFF: ticking is the deliberate step
      await api("/rest/v1/whatsapp_sender", {
        method: "POST",
        // display_name is NOT NULL on the table: an unnamed number is shown as its number
        body: JSON.stringify({ phone, display_name: name || ("+" + phone), active: true, granted_by: currentActor() }),
      });
      toast(tr("wa.saved"), "ok");
      window.dispatchEvent(new CustomEvent("ops:rerender"));
    } catch (e) { toast(e.message, "bad"); }
  });
  return card;
}
