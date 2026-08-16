/* The launcher - the first screen after signing in.
 *
 * Everyone who opens this app is one of a handful of people doing one of a handful of jobs, and the
 * ribbon does not say which of them is yours. This does: eight big targets, in the order the day
 * runs, sized for a thumb on a phone in a workshop rather than a mouse on a desk.
 *
 * It is shown ONCE, on sign-in (see afterSignIn in app.js). A reload or a shared link goes straight
 * to the screen it names - a launcher that stands between somebody and their work every time they
 * glance at their phone would be worse than no launcher at all.
 *
 * "Others" is the escape hatch to Home, which still holds every module and every internal link.
 */
import { isSignedIn, currentActor, isViewer } from "./api.js";
import { tr } from "./i18n.js";
import { $, esc, el } from "./ui.js";

/* Your order, unchanged: Chotu first because the whole point of it is that you can use it with your
 * hands full, and Others last because it is the way out rather than a job. */
const CHOICES = [
  { hash: "#/chotu",      key: "nav.chotu",      desc: "home.dChotu",      icon: "🗣️" },
  { hash: "#/production", key: "nav.production", desc: "home.dProduction", icon: "✂️" },
  { hash: "#/prep",       key: "nav.prep",       desc: "home.dPrep",       icon: "🧵" },
  { hash: "#/status",     key: "nav.status",     desc: "home.dInstall",    icon: "🚚" },
  { hash: "#/inventory",  key: "nav.inventory",  desc: "home.dInventory",  icon: "🔩" },
  { hash: "#/po",         key: "nav.po",         desc: "home.dPo",         icon: "📄" },
  { hash: "#/reports",    key: "nav.reports",    desc: "home.dReports",    icon: "📈" },
  { hash: "#/home",       key: "menu.others",    desc: "home.dOthers",     icon: "🏠" },
];

export async function render(mount, state) {
  if (!isSignedIn()) return;

  mount.innerHTML = `
    <div class="hero">
      <div>
        <h2>${esc(tr("home.hello", { who: (currentActor() || "").split("@")[0] }))}</h2>
        <div class="muted">${esc(tr("menu.sub"))}</div>
      </div>
      ${isViewer() ? `<span class="chip mute">${esc(tr("role.viewer"))}</span>` : ""}
    </div>
    <div class="menugrid">
      ${CHOICES.map((c, i) => `
        <a class="mtile" href="${c.hash}">
          <span class="mnum">${i + 1}</span>
          <span class="mico">${c.icon}</span>
          <span class="mtxt"><b>${esc(tr(c.key))}</b>
            <span class="muted">${esc(tr(c.desc))}</span></span>
        </a>`).join("")}
    </div>`;

  /* Typing 1-8 picks a choice. The workshop tablet has a keyboard docked to it and this is the one
   * screen where the options are numbered, so the number is worth honouring. */
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (!n || n < 1 || n > CHOICES.length) return;
    // ...but not while somebody is typing into something
    if (document.activeElement && document.activeElement.matches("input,textarea,select")) return;
    location.hash = CHOICES[n - 1].hash;
  };
  document.addEventListener("keydown", onKey);
  // the router replaces #main wholesale on the next route, so drop the listener with the screen
  new MutationObserver((_m, obs) => {
    if (!mount.querySelector(".menugrid")) { document.removeEventListener("keydown", onKey); obs.disconnect(); }
  }).observe(mount, { childList: true });
}
