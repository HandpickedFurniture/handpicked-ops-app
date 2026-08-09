/* Home - the landing page.
 *
 * Two things, in this order: the app's own modules (with live counts, so the page is worth looking
 * at rather than just clicking through), then every internal link the team used to keep on the
 * Google Sites page, grouped by task instead of dumped in one flat list.
 */
import { api, isSignedIn, currentActor } from "./api.js";
import { tr } from "./i18n.js";
import { DATE_BUCKETS, bucketOf } from "./config.js";
import { $, esc, el, num, loading, chip } from "./ui.js";
import { LINK_GROUPS, APP_TILES, SITE_SOURCE } from "./links.js";
import { syncBar } from "./sync.js";

export async function render(mount, state) {
  if (!isSignedIn()) return;

  mount.innerHTML = `
    <div class="hero">
      <div>
        <h2>${esc(tr("home.hello", { who: (currentActor() || "").split("@")[0] }))}</h2>
        <div class="muted">${esc(tr("home.sub"))}</div>
      </div>
      <span id="homesync"></span>
    </div>
    <div id="homestats"></div>
    <div id="hometiles"></div>
    <div id="homelinks"></div>`;

  $("#homesync", mount).appendChild(syncBar());

  /* ---- live counts, so the landing page earns its place */
  let counts = null;
  try {
    const rows = await api(
      "/rest/v1/v_ops_order_roster?select=date_bucket,production_state,adj_new,dispatch_qc_failed,recv_oos");
    counts = { total: rows.length };
    DATE_BUCKETS.forEach((b) => {
      counts[b.value] = rows.filter((r) => r.date_bucket === b.value).length;
    });
    counts.qcFailed = rows.filter((r) => r.dispatch_qc_failed).length;
    counts.oos = rows.filter((r) => r.recv_oos).length;
    counts.adj = rows.filter((r) => r.adj_new).length;
  } catch (e) { /* the page is still useful without them */ }

  if (counts) {
    const attention = [
      { n: counts.overdue,  key: "bucket.overdue", tone: "bad",  hash: "#/production?bucket=overdue" },
      { n: counts.today,    key: "bucket.today",   tone: "warn", hash: "#/production?bucket=today" },
      { n: counts.tomorrow, key: "bucket.tomorrow",tone: "warn", hash: "#/production?bucket=tomorrow" },
      { n: counts.qcFailed, key: "disp.qcFail",    tone: "bad",  hash: "#/production" },
      { n: counts.oos,      key: "recv.oos",       tone: "bad",  hash: "#/production" },
      { n: counts.adj,      key: "adj.new",        tone: "warn", hash: "#/status" },
    ].filter((x) => x.n > 0);

    $("#homestats", mount).appendChild(el(`
      <div class="card">
        <div class="spread" style="margin-bottom:8px">
          <h4>${esc(tr("home.attention"))}</h4>
          <span class="muted">${esc(tr("home.ofOrders", { n: counts.total }))}</span>
        </div>
        <div class="row">
          ${attention.length
            ? attention.map((a) => `<a class="attn ${a.tone}" href="${a.hash}">
                 <b>${a.n}</b> ${esc(tr(a.key))}</a>`).join("")
            : `<span class="muted">${esc(tr("home.allClear"))}</span>`}
        </div>
      </div>`));
  }

  /* ---- the app's modules */
  $("#hometiles", mount).appendChild(el(`
    <div class="card">
      <h4 style="margin-bottom:10px">${esc(tr("home.modules"))}</h4>
      <div class="tilegrid">
        ${APP_TILES.map((t) => `
          <a class="ltile" href="${t.hash}">
            <span class="lico">${t.icon}</span>
            <span class="ltxt"><b>${esc(tr(t.key))}</b>
              <span class="muted">${esc(tr(t.desc))}</span></span>
          </a>`).join("")}
      </div>
    </div>`));

  /* ---- the internal links */
  const box = $("#homelinks", mount);
  LINK_GROUPS.forEach((g) => {
    const live = g.links.filter((l) => l.url);
    const dead = g.links.filter((l) => !l.url);
    box.appendChild(el(`
      <div class="card">
        <div class="spread" style="margin-bottom:10px">
          <h4>${g.icon} ${esc(tr(g.key))}</h4>
          <span class="muted">${live.length}</span>
        </div>
        <div class="tilegrid">
          ${live.map((l) => `
            <a class="ltile" href="${esc(l.url)}" target="_blank" rel="noopener">
              <span class="lico">↗</span>
              <span class="ltxt"><b>${esc(l.label)}</b></span>
            </a>`).join("")}
          ${dead.map((l) => `
            <span class="ltile dead" title="${esc(tr("home.noLink"))}">
              <span class="lico">—</span>
              <span class="ltxt"><b>${esc(l.label)}</b>
                <span class="muted">${esc(tr("home.noLink"))}</span></span>
            </span>`).join("")}
        </div>
      </div>`));
  });

  box.appendChild(el(`<div class="muted" style="text-align:center;padding:6px 0 18px">
    ${esc(tr("home.source"))} <a href="${esc(SITE_SOURCE)}" target="_blank" rel="noopener">Google Sites</a>
  </div>`));
}
