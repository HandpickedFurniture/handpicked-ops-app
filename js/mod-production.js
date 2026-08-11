/* Module 1 - Production tracking.
 *
 * One row per order, showing installation date, city, PO version, every fabric code in the PO with
 * its quantity, and a count for every special requirement (roller blinds, baton sticks, pelmet boxes,
 * roman blinds, motors, tie backs...). Expand a row for the drawer.
 *
 * Cards on mobile, a dense table from 1024px - production coordinators work on a laptop, installers
 * on a phone.
 */
import { apiAll, isSignedIn, submit, currentActor, queueDepth } from "./api.js";
import { tr, tv } from "./i18n.js";
import { docButton, openLatest } from "./docs.js";
import {
  SPECIAL_COLS, DATE_BUCKETS, PAGE_SIZE, bucketOf, DISPATCH_SUBSTATES, PRODUCTION_STATES,
  PREP_STAGES, DISPATCH_CONTRACTORS,
} from "./config.js";
import { syncBar } from "./sync.js";
import {
  $, esc, el, chip, num, fmtDate, daysSince, toast, loading, progressBar, modal, selectHtml,
  downloadCsv, today, confirmSheet,
} from "./ui.js";
import { renderFilterBar, toQuery, deriveOptions, activeCount } from "./filters.js";
import { renderDrawer, invalidate } from "./drawer.js";

/* Which of the opt-in filters v_ops_order_roster can actually answer - see OPTIONAL in filters.js.
 * The roster is the only view carrying fabric_recv_state and dispatch_state. */
const CAPS = { fabstatus: true, tailor: true, prodstate: true };

const ROSTER_COLS = [
  "order_id", "customer_name", "city", "city_source", "version_no", "po_number",
  "installation_date", "fabric_cutoff_date", "date_bucket", "sheet_status", "sheet_team",
  "synced_at", "window_count", "est_minutes", "fabrics", "revised_recheck", "needs_height_review",
  "recv_total", "recv_done", "recv_ordered", "recv_oos", "recv_qc_fail",
  "prep_total", "prep_done", "prep_started", "dispatch", "dispatch_all_back",
  "adj_total", "adj_new", "adj_agreed_aed", "production_hold", "cancelled", "hold_reason",
  "team_no", "order_status", "ready", "alteration", "alteration_note",
  "fabric_meters_total", "meters_sent_total", "production_state",
  "dispatch_qc_failed", "dispatch_qc_passed", "dispatch_issue",
  "recv_fab_total", "recv_fab_done", "recv_mat_total", "recv_mat_done",
  "prep_max_rank", "owl_curtains", "owl_blinds", "owl_total", "issue_flag",
  "stitching_types", "commercial_names", "window_refs", "fabric_1_codes", "fabric_2_codes",
  "fabric_recv_state",
  ...SPECIAL_COLS.map((s) => s.col),
].join(",");

let OPTIONS = null;      // filter dropdown values, derived once from the unfiltered roster
let SORT = "installation_date.asc.nullslast";
let DOCS = {};           // order_id -> { has_pdf, doc_count } for the PDF column

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

  const paintBar = () => renderFilterBar(bar, state, OPTIONS, (f) => setFilters(f), CAPS);
  paintBar();

  loading(true, tr("t.loading"));
  let rows = [];
  try {
    rows = await apiAll(
      `/rest/v1/v_ops_order_roster?select=${ROSTER_COLS}&order=${SORT}${toQuery(state.filters, CAPS)}`,
      PAGE_SIZE);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  state.count = rows.length;
  paintBar();

  // one request for the whole page's PDF availability, rather than one per row
  try {
    const docs = await apiAll(
      "/rest/v1/v_ops_order_doc_summary?select=order_id,has_pdf,doc_count,pdf_outdated");
    DOCS = Object.fromEntries(docs.map((d) => [d.order_id, d]));
  } catch (e) { DOCS = {}; }

  if (!rows.length) {
    // "no rows with no filters" is an auth failure, not an empty result: anon has no policy on these
    // tables, so a bad bearer returns 200 with [] and never 401s
    const msg = activeCount(state.filters, CAPS) ? tr("t.empty") : tr("t.emptyUnfiltered");
    box.innerHTML = `<div class="card"><span class="muted">${esc(msg)}</span></div>`;
    return;
  }

  /* ---- totals for the filtered set: what the floor has to get through today */
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const totals = el(`
    <div class="card totalsbar">
      <div class="tot"><b>${esc(num(rows.length))}</b><span>${esc(tr("col.order"))}</span></div>
      <div class="tot"><b>${esc(num(sum("window_count")))}</b><span>${esc(tr("col.windows"))}</span></div>
      <div class="tot"><b>${esc(num(sum("owl_curtains")))}</b><span>${esc(tr("col.owlCurtains"))}</span></div>
      <div class="tot"><b>${esc(num(sum("owl_blinds")))}</b><span>${esc(tr("col.owlBlinds"))}</span></div>
      <div class="tot"><b>${esc(num(sum("owl_total")))}</b><span>${esc(tr("col.owlTotal"))}</span></div>
      <div class="tot"><b>${esc(num(sum("fabric_meters_total")))}</b><span>${esc(tr("col.meters"))}</span></div>
      <div class="tot"><b>${esc(num(sum("n_motor")))}</b><span>${esc(tr("sp.motor"))}</span></div>
      <div class="tot"><b>${esc(num(sum("n_roman")))}</b><span>${esc(tr("sp.roman"))}</span></div>
      <div class="tot"><b>${esc(num(sum("n_roller")))}</b><span>${esc(tr("sp.roller"))}</span></div>
      <div class="tot"><b>${esc(num(sum("n_scaffolding")))}</b><span>${esc(tr("sp.scaffolding"))}</span></div>
      <div class="tot"><b>${esc(num(sum("est_minutes") / 60))}</b><span>${esc(tr("rep.estTime"))} h</span></div>
    </div>`);
  box.appendChild(totals);

  const stale = rows.find((r) => r.synced_at);
  if (stale && daysSince(stale.synced_at) >= 1) {
    box.appendChild(el(`<div class="banner warn">${esc(tr("t.staleWarn"))} — ${
      esc(tr("t.stale", { d: fmtDate(stale.synced_at) }))}</div>`));
  }

  /* ---- expand / collapse every order's details at once */
  const bar2 = el(`
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <span id="prodsync"></span>
      <button class="btn sm" id="expandall">${esc(tr("act.expandAll"))}</button>
    </div>`);
  bar2.querySelector("#prodsync").appendChild(syncBar());
  box.appendChild(bar2);

  const isWide = window.matchMedia("(min-width:1024px)").matches;
  const listEl = isWide ? tableView(rows) : cardView(rows);
  const selected = new Set();
  const bulk = bulkBar(rows, selected, listEl);
  box.appendChild(bulk.root);
  box.appendChild(listEl);
  // once up front, so the column titles pin below the app header even with nothing selected
  bulk.update();

  listEl.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("input[data-selall]")) {
      listEl.querySelectorAll("input[data-sel]").forEach((cb) => {
        cb.checked = t.checked;
        if (t.checked) selected.add(cb.value); else selected.delete(cb.value);
      });
    } else if (t.matches("input[data-sel]")) {
      if (t.checked) selected.add(t.value); else selected.delete(t.value);
    } else return;
    bulk.update();
  });

  let expanded = false;
  bar2.querySelector("#expandall").addEventListener("click", (e) => {
    expanded = !expanded;
    e.target.textContent = expanded ? tr("act.collapseAll") : tr("act.expandAll");
    // clicking every toggle is what the user would do by hand; doing it for 600 orders at once
    // would fire 600 drawer loads, so cap it and say so
    const toggles = Array.from(listEl.querySelectorAll("[data-open], .ohead"));
    const cap = 40;
    toggles.slice(0, cap).forEach((t) => {
      const row = t.closest("tr, .ocard");
      const open = row && (row.nextElementSibling?.style.display === "table-row"
                           || row.querySelector(".dhost")?.innerHTML);
      if (expanded !== !!open) t.click();
    });
    if (toggles.length > cap) toast(tr("act.expandCap", { n: cap }), "");
  });
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

/* Tailor name, with the state written out beneath it. A coloured chip alone made you remember what
 * each colour meant; the words do not. */
function dispatchCell(r) {
  const d = r.dispatch || [];
  if (!d.length) return `<span class="muted">—</span>`;
  return d.map((x) => {
    const name = x.contractor === "other" ? (x.other_name || "other") : x.contractor;
    const s = DISPATCH_SUBSTATES.find((y) => y.value === x.substate) || { tone: "info" };
    const glyph = x.substate === "qc_passed" ? "✓"
      : (x.substate === "qc_failed" || x.substate === "issue") ? "!"
      : x.substate === "received_back" ? "↩" : "›";
    const bad = x.substate === "qc_failed" || x.substate === "issue";
    return `<div class="dispcell">
        <b>${esc(name)}</b>
        <div>${chip(tv(DISPATCH_SUBSTATES, x.substate), s.tone, glyph)}</div>
        ${bad && x.qc_note
          ? `<div class="err" style="font-size:11px">${esc(String(x.qc_note).slice(0, 60))}</div>` : ""}
      </div>`;
  }).join("");
}

function bucketChip(r) {
  const b = bucketOf(r.date_bucket);
  return chip(tr(b.key), b.tone, b.glyph);
}

/* The furthest production stage actually reached. A count like "0/3" said nothing about WHERE the
 * order had got to - an order with hemming done on every panel still read as 0 packed. */
function stageCell(r) {
  const rank = Number(r.prep_max_rank || 0);
  if (!rank) return `<span class="muted">—</span>`;
  const s = PREP_STAGES[rank - 1];
  const done = rank === PREP_STAGES.length;
  return chip(tr(s.key), done ? "ok" : "info", done ? "✓" : "›")
    + `<div class="muted" style="font-size:11px">${esc(r.prep_done)}/${esc(r.prep_total)}</div>`;
}

function flagChips(r) {
  const c = [];
  if (r.cancelled)          c.push(chip("CANCELLED", "bad", "!"));
  if (r.production_hold)    c.push(chip("HOLD", "bad", "!"));
  if (r.revised_recheck)    c.push(chip("revised", "warn", "!"));
  // a failed quality check after stitching is the loudest thing here short of a dead order
  if (r.dispatch_qc_failed) c.push(chip(tr("disp.qcFail"), "bad", "!"));
  if (r.dispatch_issue)     c.push(chip(tr("disp.issue"), "bad", "!"));
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
      <div class="ocard b-${esc(r.date_bucket)}${(r.dispatch_qc_failed || r.dispatch_issue) ? " qcfail" : ""}">
        <div class="ohead">
          <input type="checkbox" class="oselect" data-sel value="${esc(r.order_id)}"
                 aria-label="${esc(r.order_id)}">
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
              <span class="muted">${esc(tr("col.recvFabric"))}</span> ${progressBar(r.recv_fab_done, r.recv_fab_total)}
              <span class="muted">${esc(tr("col.recvMaterials"))}</span> ${progressBar(r.recv_mat_done, r.recv_mat_total)}
              <span class="muted">${esc(tr("col.prep"))}</span> ${stageCell(r)}
            </div>
          </div>
          <span class="ocaret">▾</span>
        </div>
        <div class="dhost"></div>
      </div>`);
    // the whole header opens the drawer, so ticking the box must not also expand the card
    card.querySelector("input[data-sel]").addEventListener("click", (e) => e.stopPropagation());
    wireExpand(card, r.order_id);
    list.appendChild(card);
  });
  return list;
}

/* ---------------------------------------------------------------- desktop */
function tableView(rows) {
  /* No .scrollx here, unlike the other modules' tables. It is not just unnecessary now the columns
   * fit - overflow-x:auto also makes the wrapper a scroll container, which is what was quietly
   * breaking the sticky header: the column titles were sticking to a box that scrolled away with
   * the page instead of to the viewport. */
  const wrap = el(`<div class="card" style="padding:0"></div>`);
  /* Percentage widths + table-layout:fixed, so the 12 columns always divide up the container rather
   * than growing past it. Coordinators read this list all day; scrolling sideways to find out
   * whether an order's fabric had landed was the single most-complained-about thing here. */
  const table = el(`
    <table class="dense fit">
      <colgroup>
        <col style="width:3%"><col style="width:8%"><col style="width:8%"><col style="width:5%">
        <col style="width:12%"><col style="width:5%"><col style="width:13%"><col style="width:12%">
        <col style="width:9%"><col style="width:8%"><col style="width:10%"><col style="width:7%">
      </colgroup>
      <thead><tr>
        <th class="selcol"><input type="checkbox" data-selall
            aria-label="${esc(tr("bulk.selectAll"))}" title="${esc(tr("bulk.selectAll"))}"></th>
        <th data-sort="order_id">${esc(tr("col.order"))}</th>
        <th data-sort="installation_date">${esc(tr("col.install"))}</th>
        <th data-sort="city">${esc(tr("col.city"))}</th>
        <th data-sort="customer_name">${esc(tr("col.customer"))}</th>
        <th data-sort="fabric_meters_total" title="${esc(tr("t.metersNote"))}">${esc(tr("col.meters"))}</th>
        <th>${esc(tr("col.fabrics"))}</th>
        <th>${esc(tr("col.special"))}</th>
        <th data-sort="recv_fab_done">${esc(tr("col.receiving"))}</th>
        <th data-sort="prep_max_rank">${esc(tr("col.prep"))}</th>
        <th>${esc(tr("disp.title"))}</th>
        <th>${esc(tr("col.actions"))}</th>
      </tr></thead>
      <tbody></tbody>
    </table>`);

  const tb = table.querySelector("tbody");
  rows.forEach((r) => {
    const tr1 = el(`
      <tr class="${(r.dispatch_qc_failed || r.dispatch_issue) ? "qcfail" : ""}">
        <td class="selcol"><input type="checkbox" data-sel value="${esc(r.order_id)}"
            aria-label="${esc(r.order_id)}"></td>
        <td><b>${esc(r.order_id)}</b>
            <span class="chip mute">v${esc(r.version_no ?? 1)}</span>
            <div>${bucketChip(r)}</div></td>
        <td>${esc(fmtDate(r.installation_date))}
            <div class="muted">${esc(r.sheet_status || "")}</div></td>
        <td>${esc(r.city || "—")}${r.city_source === "sheet" ? '<div class="muted">3D</div>' : ""}</td>
        <!-- the alteration flag rides in flagChips here, so it no longer needs a column of its own -->
        <td>${esc(r.customer_name || "—")}<div>${flagChips(r)}</div></td>
        <td><b>${esc(num(r.fabric_meters_total))}</b>
            ${Number(r.meters_sent_total) &&
              Math.abs(Number(r.meters_sent_total) - Number(r.fabric_meters_total)) > 0.5
              ? `<div class="muted" title="${esc(tr("t.metersNote"))}">(${esc(num(r.meters_sent_total))} sent)</div>`
              : ""}</td>
        <td>${fabricCell(r)}</td>
        <td>${specialCell(r)}</td>
        <td>
          <div class="recvline"><span>${esc(tr("col.recvFabric"))}</span>
            ${progressBar(r.recv_fab_done, r.recv_fab_total)}</div>
          <div class="recvline"><span>${esc(tr("col.recvMaterials"))}</span>
            ${progressBar(r.recv_mat_done, r.recv_mat_total)}</div>
        </td>
        <td>${stageCell(r)}</td>
        <td>${dispatchCell(r)}</td>
        <td class="actcell">${docButton(r.order_id, DOCS[r.order_id])}
            <button class="btn sm" data-open>${esc(tr("d.open"))}</button></td>
      </tr>`);

    const pdfBtn = tr1.querySelector("[data-pdf]");
    if (pdfBtn) pdfBtn.addEventListener("click", () => openLatest(r.order_id));

    // colspan must track the header count above
    const host = el(`<tr class="dhostrow"><td colspan="12" style="padding:0"></td></tr>`);
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

/* ---------------------------------------------------------------- bulk actions
 * Moving thirty orders to the same tailor used to be thirty drawer-opens. The checkbox column plus
 * this bar makes it one pass.
 *
 * Every write is still ONE RPC PER ORDER through the offline queue rather than a new bulk function:
 * fn_ops_set_dispatch and fn_ops_apply_prep are set-state and idempotent, so a queue replay in a van
 * with no signal does nothing the second time.
 */
function bulkBar(rows, selected, listEl) {
  const root = el(`
    <div class="selbar" hidden>
      <b class="selcount"></b>
      <button class="btn sm primary" data-act="stitch">${esc(tr("bulk.stitch"))}</button>
      <button class="btn sm" data-act="prep">${esc(tr("bulk.prep"))}</button>
      <button class="btn sm" data-act="csv">${esc(tr("bulk.export"))}</button>
      <button class="btn ghost sm" data-act="none">${esc(tr("bulk.clear"))}</button>
    </div>`);

  /* Where a sticky element comes to rest: its own CSS `top` plus its height. */
  const restsAt = (node) => {
    if (!node) return 0;
    const s = getComputedStyle(node);
    return s.position === "sticky" ? (parseFloat(s.top) || 0) + node.offsetHeight : 0;
  };

  const update = () => {
    root.hidden = selected.size === 0;
    root.querySelector(".selcount").textContent = tr("act.selected", { n: selected.size });

    /* Three things pin to the top of the window: the app header, this bar, then the column titles.
     * All three are measured rather than assumed - the header wraps to two or three lines on a
     * narrow window, and a hardcoded offset parks the bar underneath it where nobody can see it. */
    const chrome = Math.max(restsAt($("#hdr")), restsAt($("nav.tabs")));
    root.style.top = chrome + "px";
    // offsetHeight is 0 while hidden, so this collapses to just the chrome when nothing is selected
    listEl.style.setProperty("--stickytop", (chrome + root.offsetHeight) + "px");
    listEl.querySelectorAll("input[data-sel]").forEach((cb) => {
      cb.closest("tr, .ocard").classList.toggle("selected", cb.checked);
    });
    const all = listEl.querySelector("input[data-selall]");
    if (all) all.checked = selected.size > 0 && selected.size === rows.length;
  };

  const clear = () => {
    selected.clear();
    listEl.querySelectorAll("input[data-sel], input[data-selall]")
      .forEach((cb) => { cb.checked = false; });
    update();
  };

  root.querySelector('[data-act="none"]').addEventListener("click", clear);

  root.querySelector('[data-act="csv"]').addEventListener("click", () => {
    const byId = new Map(rows.map((r) => [r.order_id, r]));
    downloadCsv(`production_${today()}.csv`,
      Array.from(selected).map((id) => csvRow(byId.get(id))).filter(Boolean));
  });

  root.querySelector('[data-act="stitch"]').addEventListener("click", () => stitchModal(selected, clear));
  root.querySelector('[data-act="prep"]').addEventListener("click", () => prepModal(selected, clear));

  return { root, update };
}

function csvRow(r) {
  if (!r) return null;
  const stage = Number(r.prep_max_rank || 0);
  return {
    order_id: r.order_id,
    customer: r.customer_name || "",
    city: r.city || "",
    installation_date: r.installation_date || "",
    sheet_status: r.sheet_status || "",
    version: r.version_no ?? 1,
    windows: r.window_count,
    meters: r.fabric_meters_total,
    fabric_status: r.fabric_recv_state || "",
    fabric_received: `${r.recv_fab_done}/${r.recv_fab_total}`,
    materials_received: `${r.recv_mat_done}/${r.recv_mat_total}`,
    production_state: r.production_state || "",
    prep_stage: stage ? PREP_STAGES[stage - 1].value : "",
    prep_packed: `${r.prep_done}/${r.prep_total}`,
    stitching: (r.dispatch || [])
      .map((x) => `${x.contractor === "other" ? (x.other_name || "other") : x.contractor}:${x.substate}`)
      .join(" | "),
    fabrics: (r.fabrics || []).map((f) => `${f.code} ${f.meters}m`).join(" | "),
    specials: SPECIAL_COLS.filter((s) => Number(r[s.col]) > 0)
      .map((s) => `${s.col.replace(/^n_/, "")} ${r[s.col]}`).join(" | "),
    hold: r.production_hold ? "yes" : "",
    cancelled: r.cancelled ? "yes" : "",
  };
}

/* Run one RPC per selected order, keeping the spinner up so nobody navigates away mid-batch.
 *
 * Every bulk write goes through here, so the size check lives here too. "Select all" ticks every
 * order the filter returned - apiAll pages the whole roster, so that is hundreds, not a screenful -
 * and none of these writes has an undo beyond running the opposite one. */
const BULK_CONFIRM_OVER = 25;

async function runBulk(ids, argsFor, fn) {
  if (ids.length > BULK_CONFIRM_OVER
      && !await confirmSheet(tr("bulk.confirmMany", { n: ids.length }), tr("bulk.confirmManyBody"))) {
    return;
  }
  loading(true, tr("bulk.working", { n: ids.length }));
  try {
    for (const id of ids) {
      await submit(fn, argsFor(id));
      invalidate(id);
    }
  } finally { loading(false); }
  toast(queueDepth() ? tr("t.queued") : tr("bulk.done", { n: ids.length }), "ok");
  window.dispatchEvent(new CustomEvent("ops:rerender"));
}

function stitchModal(selected, clear) {
  const ids = Array.from(selected);
  const m = modal(`
    <h3>${esc(tr("bulk.stitch"))}</h3>
    <p class="muted" style="margin:4px 0 14px">${esc(tr("act.selected", { n: ids.length }))}</p>
    <div style="margin-bottom:10px"><label class="f">${esc(tr("bulk.tailor"))}</label>
      ${selectHtml("contractor",
          DISPATCH_CONTRACTORS.map((c) => ({ value: c.value, label: tr(c.key) })), "farooq")}</div>
    <div style="margin-bottom:10px" data-othername hidden>
      <label class="f">${esc(tr("disp.otherName"))}</label><input type="text" name="oname"></div>
    <div style="margin-bottom:10px"><label class="f">${esc(tr("bulk.newState"))}</label>
      ${selectHtml("substate",
          [...DISPATCH_SUBSTATES.map((s) => ({ value: s.value, label: tr(s.key) })),
           { value: "__clear__", label: tr("disp.notSent") }], "sent")}</div>
    <div style="margin-bottom:10px" data-notewrap hidden>
      <label class="f">${esc(tr("disp.qcFailWhat"))}</label><input type="text" name="qcnote"></div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
    </div>`);

  const q = (s) => m.sheet.querySelector(s);
  const contractor = q('[name="contractor"]');
  const substate = q('[name="substate"]');
  const needsNote = () => substate.value === "qc_failed" || substate.value === "issue";
  const sync = () => {
    q("[data-othername]").hidden = contractor.value !== "other";
    q("[data-notewrap]").hidden = !needsNote();
  };
  contractor.addEventListener("change", sync);
  substate.addEventListener("change", sync);
  sync();

  q("[data-no]").onclick = m.close;
  q("[data-yes]").onclick = async () => {
    const oname = q('[name="oname"]').value.trim();
    if (contractor.value === "other" && !oname) { toast(tr("disp.otherName"), "bad"); return; }
    const note = q('[name="qcnote"]').value.trim();
    if (needsNote() && !note) {
      toast(tr(substate.value === "issue" ? "disp.issueRequired" : "disp.qcFailRequired"), "bad");
      return;
    }
    const sub = substate.value === "__clear__" ? null : substate.value;
    m.close();
    clear();
    await runBulk(ids, (id) => ({
      p_order_id: id, p_contractor: contractor.value, p_substate: sub,
      p_other_name: oname || null, p_actor: currentActor(),
      p_note: null, p_items: null, p_qc_note: note || null,
    }), "fn_ops_set_dispatch");
  };
}

function prepModal(selected, clear) {
  const ids = Array.from(selected);
  const m = modal(`
    <h3>${esc(tr("bulk.prep"))}</h3>
    <p class="muted" style="margin:4px 0 14px">${esc(tr("act.selected", { n: ids.length }))}
      · ${esc(tr("bulk.prepNote"))}</p>
    <div style="margin-bottom:10px"><label class="f">${esc(tr("col.prep"))}</label>
      ${selectHtml("stage", PREP_STAGES.map((s) => ({ value: s.value, label: tr(s.key) })), "cutting")}</div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
    </div>`);

  m.sheet.querySelector("[data-no]").onclick = m.close;
  m.sheet.querySelector("[data-yes]").onclick = async () => {
    const stage = m.sheet.querySelector('[name="stage"]').value;
    m.close();
    clear();
    // the op id is fixed HERE, not inside the RPC, so a queued write replays onto the same rows
    await runBulk(ids, (id) => ({
      p_order_id: id, p_stage: stage, p_units: null, p_qc: null,
      // stored, not shown - an audit note stays English so the trail reads the same for everyone
      p_actor: currentActor(), p_note: "Bulk-applied from the production list",
      p_op: crypto.randomUUID(),
    }), "fn_ops_apply_prep");
  };
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
