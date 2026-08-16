/* Bootstrap and hash router.
 *
 * Filter state lives in the hash, so a coordinator can bookmark a filtered view or send the link on
 * WhatsApp and the recipient lands on exactly the same list.
 */
import { BUILD, STORAGE_PREFIX } from "./config.js";
import {
  loadSession, isSignedIn, signOut, onSession, onQueue, startQueueWatcher, flush,
  queueDepth, failedWrites, currentActor, loadRole,
} from "./api.js";
import { tr, getLang, setLang, LANGS } from "./i18n.js";
import { $, esc, el, toast } from "./ui.js";
import { renderLogin } from "./auth.js";
import { readHash, writeHash } from "./filters.js";
import { logoSvg, installFavicon } from "./brand.js";
import * as home from "./mod-home.js";
import * as menu from "./mod-menu.js";
import * as production from "./mod-production.js";
import * as prep from "./mod-prep.js";
import * as status from "./mod-status.js";
import * as schedule from "./mod-schedule.js";
import * as transfer from "./mod-transfer.js";
import * as inventory from "./mod-inventory.js";
import * as comments from "./mod-comments.js";
import * as chotu from "./mod-chotu.js";
import * as dashboard from "./mod-dashboard.js";
import * as reports from "./mod-reports.js";
import * as audit from "./mod-audit.js";
import * as roles from "./mod-roles.js";

/* Every screen is a top-level route. Only seven of them are in the ribbon.
 *
 * The Insights container is gone. It bundled five unrelated read-only screens behind one tab, which
 * buried the one screen coordinators work THROUGH - the line-by-line PO review - three clicks deep
 * under Insights > Reports > Comments. That review is now the PO tab and opens on its own. The four
 * it used to sit beside are routes of their own, reached from Home, along with Schedule and
 * Transfers. Nothing was deleted; the ribbon just stopped being where everything has to live. */
const ROUTES = {
  home:       { key: "nav.home",       render: (m, s) => home.render(m, s) },
  production: { key: "nav.production", render: (m, s, f) => production.render(m, s, f) },
  prep:       { key: "nav.prep",       render: (m, s, f) => prep.render(m, s, f) },
  status:     { key: "nav.status",     render: (m, s, f) => status.render(m, s, f) },
  inventory:  { key: "nav.inventory",  render: (m, s) => inventory.render(m, s) },
  po:         { key: "nav.po",         render: (m, s, f) => comments.render(m, s, f) },
  chotu:      { key: "nav.chotu",      render: (m, s) => chotu.render(m, s) },

  // off the ribbon, reached from Home (and still linkable)
  menu:       { key: "nav.menu",       render: (m, s) => menu.render(m, s) },
  schedule:   { key: "nav.schedule",   render: (m, s, f) => schedule.render(m, s, f) },
  transfer:   { key: "nav.transfer",   render: (m, s, f) => transfer.render(m, s, f) },
  dashboard:  { key: "nav.dashboard",  render: (m, s, f) => dashboard.render(m, s, f) },
  reports:    { key: "nav.reports",    render: (m, s, f) => reports.render(m, s, f) },
  eod:        { key: "nav.eod",        render: (m, s) => dashboard.renderEod(m, s) },
  audit:      { key: "nav.audit",      render: (m, s) => audit.render(m, s) },
  roles:      { key: "nav.roles",      render: (m, s) => roles.render(m, s) },
};

/* Seven, in the order the day runs. More than this and a phone scrolls the strip sideways, which is
 * how the last two tabs stop being used at all. */
const RIBBON = ["home", "production", "prep", "status", "inventory", "po", "chotu"];

/* The Insights sub-sections that became routes under the same name. */
const INSIGHT_SECS = ["dashboard", "eod", "audit", "roles"];

/* Old links are sitting in people's WhatsApp and in browser bookmarks, so they are redirected rather
 * than left to land on Home. The shared filters in the query string are carried across - the whole
 * point of putting them in the hash was that a filtered view could be sent to somebody. */
function redirectFor(name, params) {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const to = (route) => {
    const qs = q.toString();
    return "/" + route + (qs ? "?" + qs : "");
  };

  if (name === "insights") {
    const sec = params.get("sec") || "reports";      // Comments was the default section
    q.delete("sec");
    if (sec === "reports") {
      const rep = params.get("rep") || "comments";   // ...and Comments the default report
      q.delete("rep");
      if (rep === "comments") return to("po");
      q.set("rep", rep);
      return to("reports");
    }
    q.delete("rep");
    return to(INSIGHT_SECS.includes(sec) ? sec : "dashboard");
  }

  // Preparation was a sub-tab of Production; it is its own tab now
  if (name === "production" && params.get("sec") === "prep") { q.delete("sec"); return to("prep"); }
  return null;
}

function setFilters(route, f) { writeHash(route, f); }

function paintHeader() {
  const h = $("#hdr");
  h.innerHTML = `
    <span class="logo">${logoSvg(36)}</span>
    <div class="titles">
      <div class="t1">${esc(tr("app.title"))}</div>
      <div class="t2">${esc(currentActor() || "")}</div>
    </div>
    <select id="langsel" aria-label="Language">
      ${LANGS.map((l) => `<option value="${l.code}"${l.code === getLang() ? " selected" : ""}>${esc(l.label)}</option>`).join("")}
    </select>
    <button class="hbtn" id="bigtoggle" title="${esc(tr("t.big"))}">A+</button>
    <span id="qslot"></span>
    ${isSignedIn() ? `<button class="hbtn" id="signout">${esc(tr("auth.signout"))}</button>` : ""}`;

  $("#langsel").addEventListener("change", (e) => {
    setLang(e.target.value);
    document.documentElement.lang = e.target.value;
    paintHeader(); paintTabs(); route();
  });
  $("#bigtoggle").addEventListener("click", () => {
    const on = document.body.classList.toggle("big");
    localStorage.setItem(STORAGE_PREFIX + "big", on ? "1" : "");
  });
  const so = $("#signout");
  if (so) so.addEventListener("click", async () => { await signOut(); location.hash = "#/production"; route(); });
  paintQueue();
}

function paintQueue() {
  const slot = $("#qslot");
  if (!slot) return;
  const n = queueDepth();
  const f = failedWrites().length;
  slot.innerHTML = n ? `<span class="qbadge" title="${esc(tr("t.offline", { n }))}">${n} ⇅</span>`
    : f ? `<span class="qbadge fail" title="${esc(tr("t.failed", { n: f }))}">${f} !</span>` : "";
}

const TAB_ICON = { home: "🏠", production: "✂️", prep: "🧵", status: "🚚", schedule: "🗓️",
                   transfer: "📦", inventory: "🔩", po: "📄", chotu: "🗣️", menu: "🧭",
                   dashboard: "📊", reports: "📈", eod: "🌙", audit: "📷", roles: "🔑" };

function paintTabs() {
  const { route: r } = readHash();
  /* A route that is not in the ribbon still highlights nothing rather than mis-highlighting Home,
   * so somebody who arrived on Reports from a link can see that they are off the strip. */
  $("#tabs").innerHTML = RIBBON.map((k) =>
    `<a href="#/${k}" class="${k === r ? "active" : ""}">${TAB_ICON[k] || ""} ${esc(tr(ROUTES[k].key))}</a>`
  ).join("");
}

/* One render at a time - but a navigation that arrives mid-render is REMEMBERED, not dropped.
 *
 * This used to `return` and forget. A render here is a real wait: the roster is 712 orders and the
 * PO review is 4,400 lines, so tapping a tab while the previous screen is still loading did nothing
 * at all and you had to tap again. Worse now that an old #/insights link redirects, because the
 * redirect is itself a navigation - lose it and the person is left sitting on a dead URL.
 *
 * Only a flag is kept, not a queue: what matters is the hash as it stands when the render finishes,
 * and three taps in a row should settle on the third, not replay all three. */
let busy = false;
let again = false;
async function route() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const { route: name, filters, params } = readHash();

    // an old link lands where its screen moved to rather than 404ing to Home
    const moved = redirectFor(name, params);
    if (moved) { location.hash = moved; return; }

    const def = ROUTES[name] || ROUTES.home;
    paintTabs();

    const main = $("#main");
    if (!isSignedIn()) {
      $("#tabs").classList.add("hidden");
      renderLogin(main, afterSignIn);
      return;
    }
    $("#tabs").classList.remove("hidden");

    // resolved once per signed-in session; decides which write controls get drawn, nothing more
    await loadRole();

    const state = { filters, params, count: null };
    await def.render(main, state, (f) => setFilters(name, f));
  } catch (e) {
    if (String(e.message) === "NOT_SIGNED_IN") {
      renderLogin($("#main"), afterSignIn);
    } else {
      console.error(e);
      toast(e.message || String(e), "bad");
    }
  } finally {
    busy = false;
    if (again) { again = false; route(); }
  }
}

/* Signing in lands on the launcher, not on whatever screen the router was about to draw.
 *
 * Deliberately here and NOT in boot(): a reload, a bookmark or a WhatsApp link goes straight to the
 * screen it names. The menu is for the start of a shift, which is the one moment somebody genuinely
 * has to choose what they are doing, and the one moment an extra screen is not in the way. */
function afterSignIn() {
  paintHeader();
  $("#tabs").classList.remove("hidden");
  // assigning a DIFFERENT hash fires hashchange, which routes; assigning the same one does not
  if (readHash().route === "menu") route();
  else location.hash = "#/menu";
}

function boot() {
  document.documentElement.lang = getLang();
  installFavicon();
  if (localStorage.getItem(STORAGE_PREFIX + "big")) document.body.classList.add("big");
  $("#build").textContent = BUILD;

  loadSession();
  paintHeader();
  startQueueWatcher();
  onQueue(paintQueue);
  onSession(() => paintHeader());

  window.addEventListener("hashchange", route);
  window.addEventListener("ops:rerender", route);
  if (!location.hash) location.hash = "#/home";
  route();
  flush();
}

boot();
