/* Insights - one section holding what used to be four separate tabs: Dashboard, Reports,
 * End of day and Photo audit.
 *
 * They were split across the top-level nav, which pushed the seven data-entry modules off the edge on
 * a phone. They also belong together: all four are read-only views over work recorded elsewhere,
 * whereas Production, Installation, Transfers and Inventory are where people actually type.
 *
 * The active sub-section rides in the hash (?sec=), so a link to a specific report still works.
 */
import { isSignedIn, isViewer } from "./api.js";
import { tr } from "./i18n.js";
import { $, esc, el } from "./ui.js";
import { syncBar } from "./sync.js";
import * as dashboard from "./mod-dashboard.js";
import * as reports from "./mod-reports.js";
import * as audit from "./mod-audit.js";
import * as roles from "./mod-roles.js";

/* `ops` marks a section only a full-access account sees. Roles lives here rather than in the top
 * nav because it is administrative and rarely opened - and a viewer has nothing to do on it. */
const SECTIONS = [
  { id: "dashboard", key: "nav.dashboard", icon: "📊", render: (m, s, f) => dashboard.render(m, s, f) },
  { id: "reports",   key: "nav.reports",   icon: "📈", render: (m, s, f) => reports.render(m, s, f) },
  { id: "eod",       key: "nav.eod",       icon: "🌙", render: (m, s) => dashboard.renderEod(m, s) },
  { id: "audit",     key: "nav.audit",     icon: "📷", render: (m, s) => audit.render(m, s) },
  { id: "roles",     key: "nav.roles",     icon: "🔑", ops: true, render: (m, s) => roles.render(m, s) },
];

const visibleSections = () => SECTIONS.filter((s) => !s.ops || !isViewer());

export async function render(mount, state, setFilters) {
  if (!isSignedIn()) return;

  const shown = visibleSections();
  const secId = state.params.get("sec") || "dashboard";
  // a viewer following a ?sec=roles link lands on the dashboard rather than an empty tab
  const sec = shown.find((s) => s.id === secId) || shown[0];

  mount.innerHTML = `
    <div class="sectionbar">
      <div class="subtabs" id="secTabs"></div>
      <span id="secSync"></span>
    </div>
    <div id="secBody"></div>`;

  $("#secTabs", mount).innerHTML = shown.map((s) =>
    `<button data-sec="${s.id}" class="${s.id === sec.id ? "on" : ""}">${s.icon} ${esc(tr(s.key))}</button>`
  ).join("");

  $("#secTabs", mount).querySelectorAll("[data-sec]").forEach((b) => {
    b.addEventListener("click", () => {
      // keep the shared filters, drop the previous sub-section's own params
      const q = new URLSearchParams(location.hash.split("?")[1] || "");
      q.set("sec", b.dataset.sec);
      q.delete("rep");
      location.hash = "/insights?" + q.toString();
    });
  });

  $("#secSync", mount).appendChild(syncBar());

  await sec.render($("#secBody", mount), state, setFilters);
}
