/* Module 1 - Production tracking.
 *
 * One row per order, showing installation date, city, PO version, every fabric code in the PO with
 * its quantity, and a count for every special requirement (roller blinds, baton sticks, pelmet boxes,
 * roman blinds, motors, tie backs...). Expand a row for the drawer.
 *
 * Cards on mobile, a dense table from 1024px - production coordinators work on a laptop, installers
 * on a phone.
 */
import { apiAll, isSignedIn } from "./api.js";
import { tr } from "./i18n.js";
import { SPECIAL_COLS, DATE_BUCKETS, PAGE_SIZE, bucketOf } from "./config.js";
import {
  $, esc, el, chip, num, fmtDate, daysSince, toast, loading, progressBar,
} from "./ui.js";
import { renderFilterBar, toQuery, deriveOptions, activeCount } from "./filters.js";
import { renderDrawer, invalidate } from "./drawer.js";

const ROSTER_COLS = [
  "order_id", "customer_name", "city", "city_source", "version_no", "po_number",
  "installation_date", "fabric_cutoff_date", "date_bucket", "sheet_status", "sheet_team",
  "synced_at", "window_count", "est_minutes", "fabrics", "revised_recheck", "needs_height_review",
  "recv_total", "recv_done", "recv_ordered", "recv_oos", "recv_qc_fail",
  "prep_total", "prep_done", "prep_started", "dispatch", "dispatch_all_back",
  "adj_total", "adj_new", "adj_agreed_aed", "production_hold", "cancelled", "hold_reason",
  "team_no", "order_status", "ready", "alteration", "alteration_note",
  "fabric_meters_total", "meters_sent_total", "production_state",
  "stitching_types", "commercial_names", "window_refs", "fabric_1_codes", "fabric_2_codes",
  ...SPECIAL_COLS.map((s) => s.col),
].join(",");

let OPTIONS = null;      // filter dropdown values, derived once from the unfiltered roster
let SORT = "installation_date.asc.nullslast";

export async function render(mount, state, setFilters) {
  if (!isSignedIn()) return;

  mount.innerHTML = `<div id="fbar"></div><div id="rosterbox"></div>`;

  // Derive the dropdown options once, from the whole roster, so filters offer every real value
  // rather than only those in the current page.
  if (!OPTIONS) {
    try {
      const all = await apiAll(`/rest/v1/v_ops_order_roster?select=city,sheet_status,stitching_types,commercial_names,window_refs,fabric_1_codes,fabric_2_codes`);
      OPTIONS = deriveOptions(all);
    } catch (e) { OPTIONS = deriveOptions([]); }
  }

  const bar = $("#fbar", mount);
  const box = $("#rosterbox", mount);

  const paintBar = () => renderFilterBar(bar, state, OPTIONS, (f) => setFilters(f));
  paintBar();

  loading(true, tr("t.loading"));
  let rows = [];
  try {
    rows = await apiAll(
      `/rest/v1/v_ops_order_roster?select=${ROSTER_COLS}&order=${SORT}${toQuery(state.filters)}`,
      PAGE_SIZE);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  state.count = rows.length;
  paintBar();

  if (!rows.length) {
    // "no rows with no filters" is an auth failure, not an empty result: anon has no policy on these
    // tables, so a bad bearer returns 200 with [] and never 401s
    const msg = activeCount(state.filters) ? tr("t.empty") : tr("t.emptyUnfiltered");
    box.innerHTML = `<div class="card"><span class="muted">${esc(msg)}</span></div>`;
    return;
  }

  const stale = rows.find((r) => r.synced_at);
  if (stale && daysSince(stale.synced_at) >= 1) {
    box.appendChild(el(`<div class="banner warn">${esc(tr("t.staleWarn"))} — ${
      esc(tr("t.stale", { d: fmtDate(stale.synced_at) }))}</div>`));
  }

  const isWide = window.matchMedia("(min-width:1024px)").matches;
  box.appendChild(isWide ? tableView(rows) : cardView(rows));
}

/* ---------------------------------------------------------------- shared cell builders */
function fabricCell(r) {
  const fabs = r.fabrics || [];
  if (!fabs.length) return `<span class="muted">—</span>`;
  return fabs.map((f) => {
    const tone = f.status === "received" ? "ok"
      : f.status === "out_of_stock" ? "bad"
      : f.status === "ordered" ? "info"
      : f.drift ? "warn" : "mute";
    const glyph = f.status === "received" ? "✓" : f.status === "out_of_stock" ? "!" : "";
    return chip(`${f.code} ${num(f.meters)}m`, tone, glyph);
  }).join(" ");
}

function specialCell(r) {
  const on = SPECIAL_COLS.filter((s) => Number(r[s.col]) > 0);
  if (!on.length) return `<span class="muted">—</span>`;
  return on.map((s) => chip(`${tr(s.key)} ${num(r[s.col])}`, "info")).join(" ");
}

function dispatchCell(r) {
  const d = r.dispatch || [];
  if (!d.length) return `<span class="muted">—</span>`;
  return d.map((x) => {
    const name = x.contractor === "other" ? (x.other_name || "other") : x.contractor;
    const tone = x.substate === "received_back" ? "ok" : x.substate === "sent" ? "warn" : "info";
    return chip(name, tone, x.substate === "received_back" ? "✓" : "›");
  }).join(" ");
}

function bucketChip(r) {
  const b = bucketOf(r.date_bucket);
  return chip(tr(b.key), b.tone, b.glyph);
}

function flagChips(r) {
  const c = [];
  if (r.cancelled)          c.push(chip("CANCELLED", "bad", "!"));
  if (r.production_hold)    c.push(chip("HOLD", "bad", "!"));
  if (r.revised_recheck)    c.push(chip("revised", "warn", "!"));
  if (r.alteration)         c.push(chip(tr("col.alteration"), "warn", "!"));
  if (r.recv_oos)           c.push(chip(tr("recv.oos"), "bad", "!"));
  if (r.recv_qc_fail)       c.push(chip(tr("qc.title"), "bad", "!"));
  if (r.adj_new)            c.push(chip(`${tr("col.adjustments")} ${r.adj_new}`, "warn", "!"));
  if (!r.city)              c.push(chip(tr("t.cityUnknown"), "mute", "?"));
  else if (r.city_source === "sheet") c.push(chip(tr("t.citySheet"), "mute"));
  return c.join(" ");
}

/* ---------------------------------------------------------------- mobile */
function cardView(rows) {
  const list = el(`<div class="olist"></div>`);
  rows.forEach((r) => {
    const card = el(`
      <div class="ocard b-${esc(r.date_bucket)}">
        <div class="ohead">
          <div class="ometa">
            <div class="row" style="gap:6px">
              <span class="oid">${esc(r.order_id)}</span>
              <span class="chip mute">v${esc(r.version_no ?? 1)}</span>
              ${bucketChip(r)}
            </div>
            <div class="oname">${esc(r.customer_name || "—")}</div>
            <div class="osub">${esc(r.city || tr("t.cityUnknown"))} · ${esc(fmtDate(r.installation_date))}
              · ${esc(r.window_count)} ${esc(tr("col.windows").toLowerCase())}
              · ${esc(num(r.fabric_meters_total))} m
              ${r.sheet_status ? " · " + esc(r.sheet_status) : ""}</div>
            <div class="ochips">${flagChips(r)}</div>
            <div class="ochips">${fabricCell(r)}</div>
            <div class="ochips">${specialCell(r)}</div>
            <div class="ochips" style="gap:10px">
              <span class="muted">${esc(tr("col.receiving"))}</span> ${progressBar(r.recv_done, r.recv_total)}
              <span class="muted">${esc(tr("col.prep"))}</span> ${progressBar(r.prep_done, r.prep_total)}
            </div>
          </div>
          <span class="ocaret">▾</span>
        </div>
        <div class="dhost"></div>
      </div>`);
    wireExpand(card, r.order_id);
    list.appendChild(card);
  });
  return list;
}

/* ---------------------------------------------------------------- desktop */
function tableView(rows) {
  const wrap = el(`<div class="card scrollx" style="padding:0"></div>`);
  const table = el(`
    <table class="dense">
      <thead><tr>
        <th data-sort="order_id">${esc(tr("col.order"))}</th>
        <th data-sort="installation_date">${esc(tr("col.install"))}</th>
        <th data-sort="city">${esc(tr("col.city"))}</th>
        <th data-sort="customer_name">${esc(tr("col.customer"))}</th>
        <th data-sort="version_no">${esc(tr("col.version"))}</th>
        <th data-sort="fabric_meters_total" title="${esc(tr("t.metersNote"))}">${esc(tr("col.meters"))}</th>
        <th data-sort="alteration">${esc(tr("col.alteration"))}</th>
        <th>${esc(tr("col.fabrics"))}</th>
        <th>${esc(tr("col.special"))}</th>
        <th data-sort="recv_done">${esc(tr("col.receiving"))}</th>
        <th data-sort="prep_done">${esc(tr("col.prep"))}</th>
        <th>${esc(tr("disp.title"))}</th>
        <th></th>
      </tr></thead>
      <tbody></tbody>
    </table>`);

  const tb = table.querySelector("tbody");
  rows.forEach((r) => {
    const tr1 = el(`
      <tr>
        <td><b>${esc(r.order_id)}</b><div>${bucketChip(r)}</div></td>
        <td>${esc(fmtDate(r.installation_date))}
            <div class="muted">${esc(r.sheet_status || "")}</div></td>
        <td>${esc(r.city || "—")}${r.city_source === "sheet" ? '<div class="muted">3D</div>' : ""}</td>
        <td>${esc(r.customer_name || "—")}<div>${flagChips(r)}</div></td>
        <td>v${esc(r.version_no ?? 1)}</td>
        <td><b>${esc(num(r.fabric_meters_total))}</b>
            ${Number(r.meters_sent_total) &&
              Math.abs(Number(r.meters_sent_total) - Number(r.fabric_meters_total)) > 0.5
              ? `<div class="muted" title="${esc(tr("t.metersNote"))}">(${esc(num(r.meters_sent_total))} sent)</div>`
              : ""}</td>
        <td>${r.alteration ? chip(tr("col.alteration"), "warn", "!") : `<span class="muted">—</span>`}</td>
        <td>${fabricCell(r)}</td>
        <td>${specialCell(r)}</td>
        <td>${progressBar(r.recv_done, r.recv_total)}</td>
        <td>${progressBar(r.prep_done, r.prep_total)}</td>
        <td>${dispatchCell(r)}</td>
        <td><button class="btn sm" data-open>${esc(tr("d.open"))}</button></td>
      </tr>`);
    // colspan must track the header count above
    const host = el(`<tr class="dhostrow"><td colspan="13" style="padding:0"></td></tr>`);
    host.style.display = "none";
    let opened = false;
    tr1.querySelector("[data-open]").addEventListener("click", async () => {
      const showing = host.style.display !== "none";
      host.style.display = showing ? "none" : "table-row";
      if (!showing && !opened) {
        opened = true;
        await renderDrawer(host.firstElementChild, r.order_id, () => invalidate(r.order_id));
      }
    });
    tb.appendChild(tr1);
    tb.appendChild(host);
  });

  table.querySelectorAll("[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      SORT = SORT.startsWith(col + ".asc") ? col + ".desc.nullslast" : col + ".asc.nullslast";
      window.dispatchEvent(new CustomEvent("ops:rerender"));
    });
  });

  wrap.appendChild(table);
  return wrap;
}

function wireExpand(card, orderId) {
  const head = card.querySelector(".ohead");
  const host = card.querySelector(".dhost");
  let opened = false;
  head.addEventListener("click", async () => {
    const showing = host.innerHTML !== "";
    if (showing) { host.innerHTML = ""; card.querySelector(".ocaret").textContent = "▾"; return; }
    card.querySelector(".ocaret").textContent = "▴";
    opened = true;
    await renderDrawer(host, orderId, () => invalidate(orderId));
  });
}
