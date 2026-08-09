/* Bootstrap and hash router.
 *
 * Filter state lives in the hash, so a coordinator can bookmark a filtered view or send the link on
 * WhatsApp and the recipient lands on exactly the same list.
 */
import { BUILD, STORAGE_PREFIX } from "./config.js";
import {
  loadSession, isSignedIn, signOut, onSession, onQueue, startQueueWatcher, flush,
  queueDepth, failedWrites, currentActor,
} from "./api.js";
import { tr, getLang, setLang, LANGS } from "./i18n.js";
import { $, esc, el, toast } from "./ui.js";
import { renderLogin } from "./auth.js";
import { readHash, writeHash } from "./filters.js";
import { logoSvg, installFavicon } from "./brand.js";
import * as production from "./mod-production.js";
import * as status from "./mod-status.js";
import * as dashboard from "./mod-dashboard.js";
import * as transfer from "./mod-transfer.js";
import * as inventory from "./mod-inventory.js";
import * as audit from "./mod-audit.js";

const ROUTES = {
  production: { key: "nav.production", render: (m, s, f) => production.render(m, s, f) },
  status:     { key: "nav.status",     render: (m, s, f) => status.render(m, s, f) },
  transfer:   { key: "nav.transfer",   render: (m, s, f) => transfer.render(m, s, f) },
  inventory:  { key: "nav.inventory",  render: (m, s) => inventory.render(m, s) },
  dashboard:  { key: "nav.dashboard",  render: (m, s, f) => dashboard.render(m, s, f) },
  eod:        { key: "nav.eod",        render: (m, s) => dashboard.renderEod(m, s) },
  audit:      { key: "nav.audit",      render: (m, s) => audit.render(m, s) },
};

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

function paintTabs() {
  const { route: r } = readHash();
  $("#tabs").innerHTML = Object.keys(ROUTES).map((k) =>
    `<a href="#/${k}" class="${k === r ? "active" : ""}">${esc(tr(ROUTES[k].key))}</a>`).join("");
}

let busy = false;
async function route() {
  if (busy) return;
  busy = true;
  try {
    const { route: name, filters, params } = readHash();
    const def = ROUTES[name] || ROUTES.production;
    paintTabs();

    const main = $("#main");
    if (!isSignedIn()) {
      $("#tabs").classList.add("hidden");
      renderLogin(main, () => { paintHeader(); $("#tabs").classList.remove("hidden"); route(); });
      return;
    }
    $("#tabs").classList.remove("hidden");

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
  if (!location.hash) location.hash = "#/production";
  route();
  flush();
}

boot();
