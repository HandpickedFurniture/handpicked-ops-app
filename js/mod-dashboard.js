/* Module 3 - Management dashboard and the end-of-day report.
 *
 * Colour coding by date comes from v_ops_order_roster.date_bucket, computed SERVER-SIDE against
 * Asia/Dubai, so a laptop on the wrong timezone cannot disagree with a phone.
 *
 * Every field captured in Order status is a filter here: the shared filter bar plus status, ready,
 * team, adjustment yes/no and visit count.
 *
 * The end-of-day report is one call to v_ops_eod, which returns team-level AND overall rows together
 * via GROUPING SETS (is_overall marks the summary).
 */
import { apiAll, api, isSignedIn } from "./api.js";
import { tr, tv } from "./i18n.js";
import {
  ORDER_STATUSES, STATUS_TONE, DATE_BUCKETS, PRODUCTION_STATES, bucketOf,
} from "./config.js";
import {
  $, esc, el, chip, aed, aed0, num, fmtDate, today, toast, loading, selectHtml, downloadCsv, copyText,
} from "./ui.js";
import { renderFilterBar, toQuery, deriveOptions, writeHash } from "./filters.js";
import { chartCard, ORDINAL_RAMP } from "./charts.js";

const COLS = [
  "order_id", "customer_name", "city", "installation_date", "date_bucket", "sheet_status",
  "status", "ready", "team_no", "team_name", "team_assigned", "visit_count",
  "has_adjustment", "adjustment_count", "alteration", "adj_pending",
  "production_state", "owl_total", "window_count", "fabric_meters_total",
  "production_hold", "cancelled",
  "stitching_types", "commercial_names", "window_refs", "fabric_1_codes", "fabric_2_codes",
].join(",");

let OPTIONS = null;

export async function render(mount, state, setFilters) {
  if (!isSignedIn()) return;
  mount.innerHTML = `<div id="fbar"></div><div id="extra"></div><div id="dash"></div>`;

  if (!OPTIONS) {
    try {
      const all = await apiAll("/rest/v1/v_ops_order_roster?select=city,sheet_status,stitching_types,commercial_names,window_refs,fabric_1_codes,fabric_2_codes");
      OPTIONS = deriveOptions(all);
    } catch (e) { OPTIONS = deriveOptions([]); }
  }

  const bar = $("#fbar", mount);
  const extra = $("#extra", mount);
  const box = $("#dash", mount);
  const paintBar = () => renderFilterBar(bar, state, OPTIONS, setFilters);
  paintBar();

  // the order-status-specific filters, which sit outside the shared bar
  const p = state.params;
  const fStatus = p.get("status") || "";
  const fTeam = p.get("team") || "";
  const fReady = p.get("ready") || "";
  const fAdj = p.get("adj") || "";

  extra.innerHTML = "";
  const ex = el(`
    <div class="card">
      <div class="fgrid" style="margin:0">
        <div><label class="f">${esc(tr("col.status"))}</label>
          ${selectHtml("dstatus", ORDER_STATUSES, fStatus, tr("f.any"))}</div>
        <div><label class="f">${esc(tr("col.team"))}</label>
          <input type="text" name="dteam" value="${esc(fTeam)}" placeholder="${esc(tr("f.any"))}"></div>
        <div><label class="f">${esc(tr("st.ready"))}</label>
          ${selectHtml("dready", [{ value: "true", label: tr("st.ready") },
                                  { value: "false", label: "—" }], fReady, tr("f.any"))}</div>
        <div><label class="f">${esc(tr("col.adjustments"))}</label>
          ${selectHtml("dadj", [{ value: "true", label: tr("adj.chargeable") },
                                { value: "false", label: tr("adj.dropped") }], fAdj, tr("f.any"))}</div>
      </div>
    </div>`);
  ex.querySelectorAll("select,input").forEach((i) => i.addEventListener("change", () => {
    writeHash("dashboard", state.filters, {
      status: ex.querySelector('[name="dstatus"]').value,
      team: ex.querySelector('[name="dteam"]').value,
      ready: ex.querySelector('[name="dready"]').value,
      adj: ex.querySelector('[name="dadj"]').value,
    });
  }));
  extra.appendChild(ex);

  let q = toQuery(state.filters);
  if (fStatus) q += `&status=eq.${encodeURIComponent(fStatus)}`;
  if (fTeam)   q += `&team_no=eq.${encodeURIComponent(fTeam)}`;
  if (fReady)  q += `&ready=is.${fReady}`;
  if (fAdj)    q += `&has_adjustment=is.${fAdj}`;

  loading(true, tr("t.loading"));
  let rows = [];
  try {
    rows = await apiAll(`/rest/v1/v_ops_status_board?select=${COLS}&order=installation_date.asc.nullslast${q}`, 500);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  state.count = rows.length;
  paintBar();

  /* ---- bucket tiles */
  const counts = {};
  DATE_BUCKETS.forEach((b) => { counts[b.value] = 0; });
  rows.forEach((r) => { if (counts[r.date_bucket] !== undefined) counts[r.date_bucket]++; });

  const tiles = el(`<div class="tiles"></div>`);
  DATE_BUCKETS.forEach((b) => {
    const t = el(`<button class="tile b-${b.value} ${state.filters.bucket === b.value ? "on" : ""}">
        <div class="tn">${counts[b.value]}</div>
        <div class="tl">${esc(b.glyph)} ${esc(tr(b.key))}</div></button>`);
    t.addEventListener("click", () =>
      setFilters({ ...state.filters, bucket: state.filters.bucket === b.value ? "" : b.value }));
    tiles.appendChild(t);
  });
  box.appendChild(tiles);

  /* ---- headline numbers (money deliberately absent - it belongs in the management view) */
  const sum = (fn) => rows.reduce((a, r) => a + Number(fn(r) || 0), 0);
  box.appendChild(el(`
    <div class="card statrow">
      <div class="stat"><span class="sn">${rows.length}</span>
        <span class="sl">${esc(tr("col.order"))}</span></div>
      <div class="stat"><span class="sn">${rows.filter((r) => r.status === "Successfully completed").length}</span>
        <span class="sl">${esc(tr("dash.completed"))}</span></div>
      <div class="stat"><span class="sn">${rows.filter((r) => r.alteration).length}</span>
        <span class="sl">${esc(tr("col.alteration"))}</span></div>
      <div class="stat"><span class="sn">${rows.filter((r) => r.adj_pending).length}</span>
        <span class="sl">${esc(tr("adj.new"))}</span></div>
      <div class="stat"><span class="sn">${esc(num(sum((r) => r.owl_total)))}</span>
        <span class="sl">${esc(tr("col.owlTotal"))}</span></div>
    </div>`));

  /* ---- charts */
  const prodRows = PRODUCTION_STATES.map((s, i) => {
    const inState = rows.filter((r) => r.production_state === s.value);
    const metres = inState.reduce((a, r) => a + (Number(r.fabric_meters_total) || 0), 0);
    return {
      label: tr(s.key),
      value: inState.length,
      // the metres sitting at each stage, not just the order count - 3 orders holding 400 m is a
      // very different problem from 30 orders holding 40 m
      note: metres ? num(metres) + " m" : "",
      // ordinal ramp: the colour carries the pipeline order, not identity
      color: ORDINAL_RAMP[Math.min(i, ORDINAL_RAMP.length - 1)],
    };
  });
  const instRows = [
    ...ORDER_STATUSES.map((s) => ({
      label: s, value: rows.filter((r) => r.status === s).length, tone: STATUS_TONE[s],
    })),
    { label: "—", value: rows.filter((r) => !r.status).length, tone: "mute" },
  ];

  box.appendChild(el(`<div class="chartwrap">
    ${chartCard(tr("dash.byProduction"), prodRows, { keepZero: true })}
    ${chartCard(tr("dash.byInstall"), instRows)}
  </div>`));

  /* ---- table */
  if (!rows.length) {
    box.appendChild(el(`<div class="card"><span class="muted">${esc(tr("t.empty"))}</span></div>`));
  } else {
    const wrap = el(`<div class="card scrollx" style="padding:0"></div>`);
    wrap.appendChild(el(`
      <table class="dense">
        <thead><tr>
          <th>${esc(tr("col.order"))}</th><th>${esc(tr("col.customer"))}</th>
          <th>${esc(tr("col.city"))}</th><th>${esc(tr("col.install"))}</th>
          <th>${esc(tr("col.status"))}</th><th>${esc(tr("col.production"))}</th>
          <th>${esc(tr("col.team"))}</th>
          <th>${esc(tr("col.visits"))}</th><th>${esc(tr("col.alteration"))}</th>
        </tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><b>${esc(r.order_id)}</b> ${bucketChip(r)}</td>
            <td>${esc(r.customer_name || "—")}</td>
            <td>${esc(r.city || "—")}</td>
            <td>${esc(fmtDate(r.installation_date))}</td>
            <td>${r.status ? chip(r.status, STATUS_TONE[r.status] || "mute") : "—"}
                ${r.ready ? chip(tr("st.ready"), "ok", "✓") : ""}</td>
            <td>${esc(tv(PRODUCTION_STATES, r.production_state))}</td>
            <td>${esc(r.team_name || (r.team_no ? tr("dash.team", { n: r.team_no }) : "—"))}</td>
            <td>${esc(r.visit_count)}</td>
            <td>${r.alteration ? chip(tr("col.alteration"), "warn", "!") : "—"}</td>
          </tr>`).join("")}</tbody>
      </table>`));
    box.appendChild(wrap);
  }

  box.appendChild(el(`<div class="row" style="justify-content:flex-end">
      <button class="btn sm" id="dlcsv">${esc(tr("dash.csv"))}</button></div>`));
  $("#dlcsv", box).addEventListener("click", () => downloadCsv(`orders_${today()}.csv`, rows.map((r) => ({
    order_id: r.order_id, customer: r.customer_name, city: r.city,
    install_date: r.installation_date, bucket: r.date_bucket, status: r.status,
    production_state: r.production_state, ready: r.ready,
    team: r.team_name || r.team_no, visits: r.visit_count,
    alteration: r.alteration, owl_total: r.owl_total, windows: r.window_count,
    adjustments_pending: r.adj_pending,
  }))));
}

function bucketChip(r) {
  const b = bucketOf(r.date_bucket);
  return chip(tr(b.key), b.tone, b.glyph);
}

/* ---------------------------------------------------------------- end of day */
export async function renderEod(mount, state) {
  if (!isSignedIn()) return;
  const date = state.params.get("date") || today();

  mount.innerHTML = `
    <div class="card spread">
      <div class="row">
        <label class="f" style="margin:0">${esc(tr("dash.eod"))}</label>
        <input type="date" name="eoddate" value="${esc(date)}" style="width:auto">
      </div>
      <div class="row">
        <button class="btn sm" id="eodcopy">${esc(tr("dash.copy"))}</button>
        <button class="btn sm" id="eodcsv">${esc(tr("dash.csv"))}</button>
      </div>
    </div>
    <div id="eodbody"></div>`;

  $('[name="eoddate"]', mount).addEventListener("change", (e) =>
    writeHash("eod", state.filters, { date: e.target.value }));

  const box = $("#eodbody", mount);
  loading(true, tr("t.loading"));
  let rows = [], planned = [];
  try {
    [rows, planned] = await Promise.all([
      api(`/rest/v1/v_ops_eod?select=*&report_date=eq.${date}&order=is_overall.desc,team_no.asc.nullsfirst`),
      api(`/rest/v1/v_ops_eod_planned?select=*&report_date=eq.${date}`),
    ]);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  if (!rows.length) {
    box.innerHTML = `<div class="card"><span class="muted">${esc(tr("dash.noData"))}</span></div>`;
    // still allow copy/CSV of the planned side
  }

  const overall = rows.find((r) => r.is_overall);
  const teams = rows.filter((r) => !r.is_overall);

  if (overall) {
    box.appendChild(el(`
      <div class="card">
        <h3 style="margin-bottom:10px">${esc(tr("dash.overall"))} — ${esc(fmtDate(date))}</h3>
        <div class="statrow">
          ${statTile(overall.orders_visited, tr("dash.visited"))}
          ${statTile(overall.completed, tr("dash.completed"))}
          ${statTile(overall.revisits, tr("dash.revisits"))}
          ${statTile(aed0(overall.adjustment_aed), tr("dash.adjAed"))}
          ${statTile((overall.first_visit_success_pct ?? "—") + "%", tr("dash.successPct"))}
        </div>
      </div>`));
  }

  teams.forEach((t) => {
    const plan = planned.find((p) => String(p.team_no) === String(t.team_no));
    box.appendChild(el(`
      <div class="card">
        <div class="spread" style="margin-bottom:10px">
          <h4>${esc(t.team_name || (t.team_no ? tr("dash.team", { n: t.team_no }) : tr("dash.unassigned")))}</h4>
          ${plan ? `<span class="muted">${esc(plan.orders_scheduled)} scheduled ·
            ${esc(Math.round((plan.est_minutes || 0) / 60))}h</span>` : ""}
        </div>
        <div class="statrow">
          ${statTile(t.orders_visited, tr("dash.visited"))}
          ${statTile(t.completed, tr("dash.completed"))}
          ${statTile(t.first_visits, tr("dash.first"))}
          ${statTile(t.revisits, tr("dash.revisits"))}
          ${statTile(aed0(t.adjustment_aed), tr("dash.adjAed"))}
        </div>
        <div class="ochips" style="margin-top:10px">
          ${issueChips(t)}
        </div>
      </div>`));
  });

  $("#eodcopy", mount).addEventListener("click", async () => {
    const ok = await copyText(eodText(date, overall, teams));
    toast(ok ? tr("dash.copied") : "Copy failed", ok ? "ok" : "bad");
  });
  $("#eodcsv", mount).addEventListener("click", () =>
    downloadCsv(`eod_${date}.csv`, rows.map((r) => ({
      report_date: r.report_date,
      level: r.is_overall ? "OVERALL" : (r.team_name || r.team_no || "unassigned"),
      orders_visited: r.orders_visited, first_visits: r.first_visits, revisits: r.revisits,
      completed: r.completed, partial: r.partial,
      production_issue: r.production_issue, consultation_issue: r.consultation_issue,
      installation_issue: r.installation_issue, rescheduled: r.rescheduled,
      change_of_mind: r.change_of_mind, others: r.others,
      adjustments: r.adjustments, adjustment_aed: r.adjustment_aed,
      first_visit_success_pct: r.first_visit_success_pct,
    }))));
}

function statTile(n, label) {
  return `<div class="stat"><span class="sn">${esc(String(n ?? 0))}</span>
    <span class="sl">${esc(label)}</span></div>`;
}

function issueChips(t) {
  const out = [];
  const add = (n, label, tone) => { if (Number(n)) out.push(chip(`${label} ${n}`, tone)); };
  add(t.partial, tr("dash.completed") + " (partial)", "warn");
  add(t.production_issue, "Production", "bad");
  add(t.consultation_issue, "Consultation", "bad");
  add(t.installation_issue, "Installation", "bad");
  add(t.rescheduled, "Rescheduled", "warn");
  add(t.change_of_mind, "Change of mind", "mute");
  add(t.others, "Others", "mute");
  return out.length ? out.join(" ") : `<span class="muted">${esc(tr("d.none"))}</span>`;
}

/* Plain text for WhatsApp, mirroring the digest style of ingestion-agent/notify.py.
 * Kept a PURE FUNCTION so a scheduled send-eod Edge Function can reuse it verbatim later. */
export function eodText(date, overall, teams) {
  const L = [];
  L.push(`*End of day — ${fmtDate(date)}*`);
  if (overall) {
    L.push(`Orders visited: ${overall.orders_visited}   Completed: ${overall.completed}`);
    L.push(`First visits: ${overall.first_visits}   Revisits: ${overall.revisits}`);
    if (Number(overall.adjustment_aed)) L.push(`Extra charges: ${aed(overall.adjustment_aed)}`);
    if (overall.first_visit_success_pct != null) L.push(`First-visit success: ${overall.first_visit_success_pct}%`);
  }
  teams.forEach((t) => {
    const name = t.team_name || (t.team_no ? `Team ${t.team_no}` : "Unassigned");
    const issues = [];
    if (t.production_issue)    issues.push(`${t.production_issue} production`);
    if (t.consultation_issue)  issues.push(`${t.consultation_issue} consultation`);
    if (t.installation_issue)  issues.push(`${t.installation_issue} installation`);
    if (t.rescheduled)         issues.push(`${t.rescheduled} rescheduled`);
    if (t.partial)             issues.push(`${t.partial} partial`);
    L.push("");
    L.push(`*${name}* — ${t.orders_visited} visited, ${t.completed} completed`
      + (issues.length ? ` (${issues.join(", ")})` : "")
      + (Number(t.adjustment_aed) ? ` · ${aed(t.adjustment_aed)} extra` : ""));
  });
  return L.join("\n");
}
