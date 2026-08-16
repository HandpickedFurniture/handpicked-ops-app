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
}
