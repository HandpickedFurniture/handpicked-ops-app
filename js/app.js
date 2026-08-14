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
import * as production from "./mod-production.js";
import * as status from "./mod-status.js";
import * as schedule from "./mod-schedule.js";
import * as transfer from "./mod-transfer.js";
import * as inventory from "./mod-inventory.js";
import * as insights from "./mod-insights.js";

/* Dashboard, Reports, End of day and Photo audit now live inside Insights - four read-only views
 * under one tab, so the data-entry modules keep the top level. Old #/dashboard, #/eod and #/audit
 * links still work: they redirect into the right Insights sub-section (see route()). */
const ROUTES = {
  home:       { key: "nav.home",       render: (m, s) => home.render(m, s) },
  production: { key: "nav.production", render: (m, s, f) => production.render(m, s, f) },
  status:     { key: "nav.status",     render: (m, s, f) => status.render(m, s, f) },
  schedule:   { key: "nav.schedule",   render: (m, s, f) => schedule.render(m, s, f) },
  transfer:   { key: "nav.transfer",   render: (m, s, f) => transfer.render(m, s, f) },
  inventory:  { key: "nav.inventory",  render: (m, s) => inventory.render(m, s) },
  insights:   { key: "nav.insights",   render: (m, s, f) => insights.render(m, s, f) },
};

/* the tabs that used to be top-level, mapped to the section they became */
const MOVED = { dashboard: "dashboard", eod: "eod", audit: "audit", reports: "reports" };
/* Preparation went the same way, into Production rather than Insights - see mod-production.js */
const MOVED_TO_PRODUCTION = { prep: "prep" };

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

const TAB_ICON = { home: "🏠", production: "✂️", status: "🚚", schedule: "🗓️",
                   transfer: "📦", inventory: "🔩", insights: "📊" };

function paintTabs() {
  const { route: r } = readHash();
  $("#tabs").innerHTML = Object.keys(ROUTES).map((k) =>
    `<a href="#/${k}" class="${k === r ? "active" : ""}">${TAB_ICON[k] || ""} ${esc(tr(ROUTES[k].key))}</a>`
  ).join("");
}

let busy = false;
async function route() {
  if (busy) return;
  busy = true;
  try {
    const { route: name, filters, params } = readHash();

    // an old top-level link lands in the right sub-section rather than 404ing to Home
    if (MOVED[name] || MOVED_TO_PRODUCTION[name]) {
      const into = MOVED[name] ? "insights" : "production";
      const q = new URLSearchParams(location.hash.split("?")[1] || "");
      q.set("sec", MOVED[name] || MOVED_TO_PRODUCTION[name]);
      location.hash = "/" + into + "?" + q.toString();
      return;
    }

    const def = ROUTES[name] || ROUTES.home;
    paintTabs();

    const main = $("#main");
    if (!isSignedIn()) {
      $("#tabs").classList.add("hidden");
      renderLogin(main, () => { paintHeader(); $("#tabs").classList.remove("hidden"); route(); });
      return;
    }
    $("#tabs").classList.remove("hidden");

    // resolved once per signed-in session; decides which write controls get drawn, nothing more
    await loadRole();

    const state = { filters, params, count: null };
    await def.render(main, state, (f) => setFilters(name, f));
  } catch (e) {
    if (String(e.message) === "NOT_SIGNED_IN") {
      renderLogin($("#main"), () => { paintHeader(); route(); });
    } else {
      console.error(e);
      toast(e.message || String(e), "bad");
    }
  } finally { busy = false; }
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
