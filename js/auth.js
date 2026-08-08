/* Sign-in screen.
 *
 * There is deliberately NO sign-up: accounts are created by the owner in the Supabase dashboard and
 * public sign-up is disabled. The signed-in identity is what fills the actor / received_by / qc_by /
 * assigned_by / created_by / author columns that already existed on these tables, and what makes the
 * per-team end-of-day report attributable.
 */
import { signIn, isSignedIn } from "./api.js";
import { tr } from "./i18n.js";
import { $, esc, toast, loading } from "./ui.js";

export function renderLogin(mount, onDone) {
  mount.innerHTML = `
    <div class="card" style="max-width:420px;margin:6vh auto">
      <h3 style="margin-bottom:4px">${esc(tr("auth.title"))}</h3>
      <p class="muted" style="margin:0 0 16px">${esc(tr("auth.hint"))}</p>
      <form id="loginform" autocomplete="on">
        <div style="margin-bottom:12px">
          <label class="f" for="lg_email">${esc(tr("auth.email"))}</label>
          <input type="email" id="lg_email" name="email" autocomplete="username" required>
        </div>
        <div style="margin-bottom:16px">
          <label class="f" for="lg_pw">${esc(tr("auth.password"))}</label>
          <input type="password" id="lg_pw" name="password" autocomplete="current-password" required>
        </div>
        <div id="lg_err" class="err hidden" style="margin-bottom:10px"></div>
        <button class="btn primary" type="submit" style="width:100%">${esc(tr("auth.signin"))}</button>
      </form>
    </div>`;

  $("#loginform", mount).addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#lg_email", mount).value.trim();
    const pw = $("#lg_pw", mount).value;
    const errBox = $("#lg_err", mount);
    errBox.classList.add("hidden");
    loading(true, tr("t.loading"));
    try {
      await signIn(email, pw);
      toast(tr("auth.title") + " ✓", "ok");
      onDone();
    } catch (err) {
      errBox.textContent = tr("auth.failed");
      errBox.classList.remove("hidden");
    } finally {
      loading(false);
    }
  });
}

export function requireAuth(mount, onDone) {
  if (isSignedIn()) return true;
  renderLogin(mount, onDone);
  return false;
}
