/* Comments - per-line review, and the default screen under Insights.
 *
 * A coordinator is expected to read every line of every order. Before this there was no way to
 * record that they had, so the only evidence of a line having been looked at was that nothing had
 * gone wrong yet. This page is the record: 4,409 lines, each carrying the order-form columns the
 * coordinators actually read from, and each markable.
 *
 * Marks are MULTIPLE per line and Unread is the absence of them - see LINE_REVIEW_STATUSES. Every
 * change is logged with who made it (line_review_event), because "who signed this off" is the
 * question this page exists to answer.
 *
 * Three things fight for attention here and each gets a distinct treatment:
 *   * which order you are in    - alternating bands BY ORDER, never by row
 *   * what you have done        - read lines fade back
 *   * what procurement must act on - roman blinds we produce, pelmet boxes, eyelet/ring, in a
 *                                    bright cell that also names the requirement in words
 */
import { apiAll, isSignedIn, submit, currentActor, queueDepth, isViewer } from "./api.js";
import { tr, tv } from "./i18n.js";
import { LINE_REVIEW_STATUSES, PROCUREMENT_REQS, PAGE_SIZE } from "./config.js";
import {
  $, esc, el, chip, num, toast, loading, modal, downloadCsv, today, progressBar,
  selectHtml, confirmSheet,
} from "./ui.js";
import { renderFilterBar, toQuery, deriveOptions, activeCount } from "./filters.js";

/* v_ops_line_review is the only view carrying these three. */
const CAPS = { prodstate: true, procurement: true, review: true };

/* The 21 columns the coordinators asked for, in the order they read them - which is the order of
 * the order form itself, not of the database. `wide` marks the free-text ones that need room. */
const COLS = [
  { k: "issue_flag", key: "rev.issueFlag",
    fmt: (v) => chip(v || "—", v === "Issue" ? "warn" : "mute") },
  { k: "window_ref", key: "f.windowRef", bold: 1 },
  { k: "linkage", key: "rev.linkage" },
  { k: "supplier_type", key: "rev.supplierType" },
  { k: "commercial_name", key: "f.commercial", wide: 1 },
  { k: "window_name", key: "rev.windowName" },
  { k: "optional_comment", key: "f.comment", wide: 1 },
  { k: "installation_notes", key: "col.installNotes", wide: 1 },
  { k: "fabric_1_bottom_stitch", key: "rev.f1Bottom" },
  { k: "fabric_2_bottom_stitch", key: "rev.f2Bottom" },
  { k: "quantity", key: "rev.quantity" },
  { k: "adjusted_width", key: "rev.adjWidth" },
  { k: "adjusted_height", key: "rev.adjHeight" },
  { k: "height_variation", key: "rev.heightVar" },
  { k: "brackets", key: "rep.brackets" },
  { k: "opening", key: "rev.opening" },
  { k: "pooling", key: "rev.pooling" },
  { k: "fabric_1_new", key: "rev.f1New" },
  { k: "fabric_1_quantity", key: "rev.f1Qty" },
  { k: "fabric_2_new", key: "rev.f2New" },
  { k: "fabric_2_quantity", key: "rev.f2Qty" },
];

const SELECT = ["line_id", "order_id", "line_no", "marks", "marks_actioned", "is_read",
  "open_follow_ups", "procurement_req", "customer_name", "installation_date",
  ...COLS.map((c) => c.k)].join(",");

/* Which procurement requirement, if any, a given column is evidence of - so the highlight lands on
 * the cell that explains it rather than washing the whole row. */
const PROC_COL = {
  commercial_name: ["roman_production", "pelmet", "eyelet"],
  supplier_type: ["roman_production"],
};

let OPTIONS = null;
let SHOWN = 300;     // rows drawn at once; the rest come on demand - see the Show more button

/* Apply one mark to a set of lines. Shared by "Mark all" and by the selection bar, so the two can
 * never drift into behaving differently.
 *
 * Sent as ONE call per chunk rather than one per line: 4,000 lines as 4,000 queued RPCs is several
 * minutes of round trips. Still queued like every other write, so it survives a van with no signal. */
const MARK_CHUNK = 1000;

function markSheet(targetRows, after) {
  const n = targetRows.length;
  if (!n) return;
  const m = modal(`
    <h3>${esc(tr("rev.markAll", { n }))}</h3>
    <p class="muted" style="margin:4px 0 12px">${esc(tr("rev.markAllBody", { n }))}</p>
    <div style="margin-bottom:10px"><label class="f">${esc(tr("rev.marks"))}</label>
      ${selectHtml("bulkstatus",
          LINE_REVIEW_STATUSES.map((s) => ({ value: s.value, label: tr(s.key) })), "read")}</div>
    <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
      <input type="checkbox" name="bulkoff"> ${esc(tr("rev.markAllRemove"))}</label>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
      <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
    </div>`);

  m.sheet.querySelector("[data-no]").onclick = m.close;
  m.sheet.querySelector("[data-yes]").onclick = async () => {
    const status = m.sheet.querySelector('[name="bulkstatus"]').value;
    const on = !m.sheet.querySelector('[name="bulkoff"]').checked;
    m.close();
    if (!await confirmSheet(tr("rev.markAll", { n }), tr("rev.markAllConfirm", { n }))) return;

    loading(true, tr("bulk.working", { n }));
    try {
      for (let i = 0; i < n; i += MARK_CHUNK) {
        await submit("fn_ops_set_line_review_bulk", {
          p_line_ids: targetRows.slice(i, i + MARK_CHUNK).map((r) => r.line_id),
          p_status: status, p_on: on,
          p_actor: currentActor(), p_op: crypto.randomUUID(),
        });
      }
    } finally { loading(false); }
    if (after) after();
    toast(queueDepth() ? tr("t.queued") : tr("bulk.done", { n }), "ok");
    window.dispatchEvent(new CustomEvent("ops:rerender"));
  };
}

export async function render(mount, state, setFilters) {
  if (!isSignedIn()) return;

  mount.innerHTML = `<div id="cfbar"></div><div id="cbody"></div>`;

  if (!OPTIONS) {
    try {
      const all = await apiAll("/rest/v1/v_ops_order_roster?select=city,sheet_status,stitching_types,commercial_names,window_refs,fabric_1_codes,fabric_2_codes");
      OPTIONS = deriveOptions(all);
    } catch (e) { OPTIONS = deriveOptions([]); }
  }

  const bar = $("#cfbar", mount);
  const box = $("#cbody", mount);
  const paintBar = () => renderFilterBar(bar, state, OPTIONS, (f) => setFilters(f), CAPS);
  paintBar();

  loading(true, tr("t.loading"));
  let rows = [];
  try {
    rows = await apiAll(
      `/rest/v1/v_ops_line_review?select=${SELECT}` +
      `&order=installation_date.desc.nullslast,order_id.desc,line_no.asc` +
      toQuery(state.filters, CAPS), PAGE_SIZE);
  } catch (e) {
    loading(false);
    box.innerHTML = `<div class="card"><span class="err">${esc(e.message)}</span></div>`;
    return;
  }
  loading(false);

  state.count = rows.length;
  paintBar();

  if (!rows.length) {
    const msg = activeCount(state.filters, CAPS) ? tr("t.empty") : tr("t.emptyUnfiltered");
    box.innerHTML = `<div class="card"><span class="muted">${esc(msg)}</span></div>`;
    return;
  }

  /* ---- how far the reading has got, over the filtered set */
  const readCount = () => rows.filter((r) => r.is_read).length;
  const openCount = () => rows.reduce((a, r) => a + (Number(r.open_follow_ups) || 0), 0);
  const head = el(`
    <div class="card row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
      <span class="revprogress">${progressBar(readCount(), rows.length)}
        <span data-progress>${esc(tr("rev.progress", { n: readCount(), m: rows.length }))}</span>
        <span data-open>${openCount() ? chip(tr("rev.open", { n: openCount() }), "warn", "!") : ""}</span>
      </span>
      <span class="row" style="gap:6px">
        ${isViewer() ? "" : `<button class="btn sm primary" data-markall
             >${esc(tr("rev.markAll", { n: rows.length }))}</button>`}
        <button class="btn sm" data-csv>${esc(tr("dash.csv"))}</button>
      </span>
    </div>`);
  box.appendChild(head);

  /* Mark every line the filter returned, in one go.
   *
   * This acts on the WHOLE filtered set, not on what is drawn - 300 rows are on screen and 4,409 may
   * match, and "select all" meaning "the first 300" is how a coordinator ends up believing they have
   * read an order they never saw. The count in the button is the real number, and the confirmation
   * repeats it. */
  const markAllBtn = head.querySelector("[data-markall]");
  if (markAllBtn) markAllBtn.addEventListener("click", () => markSheet(rows));

  const refreshHead = () => {
    head.querySelector("[data-progress]").textContent =
      tr("rev.progress", { n: readCount(), m: rows.length });
    head.querySelector("[data-open]").innerHTML =
      openCount() ? chip(tr("rev.open", { n: openCount() }), "warn", "!") : "";
    const bar2 = head.querySelector(".progress");
    if (bar2) bar2.outerHTML = progressBar(readCount(), rows.length);
  };

  head.querySelector("[data-csv]").addEventListener("click", () =>
    downloadCsv(`line_review_${today()}.csv`, rows.map((r) => {
      const o = { order_id: r.order_id };
      COLS.forEach((c) => { o[tr(c.key)] = r[c.k]; });
      o[tr("rev.marks")] = (r.marks || []).map((s) => tv(LINE_REVIEW_STATUSES, s)).join(" | ");
      o[tr("rev.actioned")] = (r.marks_actioned || []).map((s) => tv(LINE_REVIEW_STATUSES, s)).join(" | ");
      o[tr("proc.title")] = (r.procurement_req || []).map((p) => tv(PROCUREMENT_REQS, p)).join(" | ");
      return o;
    })));

  /* Row selection, for marking a subset rather than the whole filter.
   *
   * The tick box in the header selects the rows CURRENTLY DRAWN, which is not the same as the rows
   * the filter matched - 300 against 4,463 here. Conflating the two is how somebody ends up believing
   * they signed off an order they never saw, so the bar says which of the two it is holding and
   * offers to widen it explicitly. */
  const selected = new Set();
  let wholeFilter = false;

  const selbar = el(`
    <div class="selbar" hidden>
      <b class="selcount"></b>
      <button class="btn sm" data-act="all">${esc(tr("rev.selectMatching", { n: rows.length }))}</button>
      <button class="btn sm primary" data-act="mark">${esc(tr("rev.markSelected"))}</button>
      <button class="btn ghost sm" data-act="none">${esc(tr("bulk.clear"))}</button>
    </div>`);
  box.appendChild(selbar);

  const selCount = () => (wholeFilter ? rows.length : selected.size);
  const updateSel = () => {
    selbar.hidden = selCount() === 0 || isViewer();
    selbar.querySelector(".selcount").textContent = tr("act.selected", { n: selCount() });
    // widening only makes sense while a partial set is held
    selbar.querySelector('[data-act="all"]').hidden = wholeFilter || rows.length === selected.size;
    selbar.querySelectorAll("tr");
  };

  const clearSel = () => {
    selected.clear(); wholeFilter = false;
    box.querySelectorAll("input[data-sel], input[data-selall]").forEach((cb) => { cb.checked = false; });
    box.querySelectorAll("table.rev tbody tr.selected").forEach((t) => t.classList.remove("selected"));
    updateSel();
  };

  selbar.querySelector('[data-act="none"]').addEventListener("click", clearSel);
  selbar.querySelector('[data-act="all"]').addEventListener("click", () => {
    wholeFilter = true;
    updateSel();
    toast(tr("rev.selectedMatching", { n: rows.length }), "");
  });
  selbar.querySelector('[data-act="mark"]').addEventListener("click", () =>
    markSheet(wholeFilter ? rows : rows.filter((r) => selected.has(String(r.line_id))), clearSel));

  const wrap = el(`<div class="card revwrap" style="padding:0"></div>`);
  const table = el(`
    <table class="rev">
      <thead><tr>
        ${isViewer() ? "" : `<th class="selcol"><input type="checkbox" data-selall
              aria-label="${esc(tr("bulk.selectAll"))}" title="${esc(tr("bulk.selectAll"))}"></th>`}
        <th>${esc(tr("col.order"))}</th>
        ${isViewer() ? "" : `<th>${esc(tr("rev.read"))}</th>`}
        <th>${esc(tr("rev.marks"))}</th>
        ${COLS.map((c) => `<th>${esc(tr(c.key))}</th>`).join("")}
      </tr></thead>
      <tbody></tbody>
    </table>`);
  const tb = table.querySelector("tbody");
  wrap.appendChild(table);
  box.appendChild(wrap);

  const more = el(`<div class="row" style="justify-content:center;margin-top:10px"></div>`);
  box.appendChild(more);

  /* Alternating bands are assigned by ORDER, walking the rows in the order they are drawn, so an
   * order stays one colour however many lines it has. */
  const bandOf = new Map();
  let band = 0, lastOrder = null;
  rows.forEach((r) => {
    if (r.order_id !== lastOrder) { band ^= 1; lastOrder = r.order_id; }
    bandOf.set(r.line_id, band);
  });

  const cellValue = (c, r) => {
    const v = r[c.k];
    if (c.fmt) return c.fmt(v, r);
    if (v === null || v === undefined || v === "") return `<span class="muted">—</span>`;
    return esc(String(v));
  };

  const procChips = (r) => (r.procurement_req || [])
    .map((p) => chip(tv(PROCUREMENT_REQS, p), "warn", "!")).join(" ");

  function drawRow(r, isFirstOfOrder) {
    const marks = new Set(r.marks || []);
    const actioned = new Set(r.marks_actioned || []);
    const tr1 = el(`
      <tr class="ord${bandOf.get(r.line_id) ? "B" : "A"}${r.is_read ? " isread" : ""}${
          isFirstOfOrder ? " firstofblock" : ""}" data-line="${esc(r.line_id)}">
        ${isViewer() ? "" : `<td class="selcol"><input type="checkbox" data-sel
              value="${esc(r.line_id)}" aria-label="${esc(r.window_ref || r.line_id)}"></td>`}
        <td>${isFirstOfOrder
              ? `<b>${esc(r.order_id)}</b><div class="muted">${esc(r.customer_name || "")}</div>`
              : `<span class="muted">${esc(r.order_id)}</span>`}</td>
        ${isViewer() ? "" : `<td><input type="checkbox" data-read${marks.has("read") ? " checked" : ""}
              aria-label="${esc(tr("rev.read"))} ${esc(r.window_ref || r.line_id)}"
              style="width:19px;height:19px;accent-color:var(--brand);cursor:pointer"></td>`}
        <td><span class="revmarks" data-markcell></span></td>
        ${COLS.map((c) => {
          const hit = (PROC_COL[c.k] || []).filter((p) => (r.procurement_req || []).includes(p));
          return `<td class="${c.wide ? "wide " : ""}${hit.length ? "procreq" : ""}">${
            c.bold ? "<b>" : ""}${cellValue(c, r)}${c.bold ? "</b>" : ""}${
            hit.length ? `<div style="margin-top:3px">${procChips(r)}</div>` : ""}</td>`;
        }).join("")}
      </tr>`);

    const markCell = tr1.querySelector("[data-markcell]");
    const paintMarks = () => {
      const others = LINE_REVIEW_STATUSES.filter((s) => s.value !== "read" && marks.has(s.value));
      markCell.innerHTML = others.map((s) =>
        `<button data-mark="${esc(s.value)}" class="on${actioned.has(s.value) ? " done" : ""}"
                 title="${esc(actioned.has(s.value) ? tr("rev.actioned") : tr("rev.markActioned"))}"
        >${actioned.has(s.value) ? "✓ " : ""}${esc(tr(s.key))}</button>`).join("")
        + (isViewer() ? "" : `<button data-open-marks title="${esc(tr("rev.markLine"))}">⋯</button>`);
    };
    paintMarks();

    /* One RPC per change through the offline queue, like every other write here. fn_ops_set_line_review
     * is set-state, so a replay in a van does nothing the second time. */
    const send = async (status, on, act) => {
      await submit("fn_ops_set_line_review", {
        p_line_id: r.line_id, p_status: status, p_on: on,
        p_actioned: act === undefined ? null : act,
        p_actor: currentActor(), p_op: crypto.randomUUID(),
      });
    };

    const readBox = tr1.querySelector("[data-read]");
    if (readBox) {
      readBox.addEventListener("change", async () => {
        const on = readBox.checked;
        if (on) marks.add("read"); else marks.delete("read");
        r.is_read = on;
        r.marks = Array.from(marks);
        tr1.classList.toggle("isread", on);
        refreshHead();
        await send("read", on);
        if (queueDepth()) toast(tr("t.queued"), "");
      });
    }

    // tapping a follow-up chip toggles whether it has been actioned; the ⋯ button adds and removes
    markCell.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b || isViewer()) return;
      if (b.hasAttribute("data-open-marks")) { openMarkSheet(); return; }
      const s = b.dataset.mark;
      const nowActioned = !actioned.has(s);
      if (nowActioned) actioned.add(s); else actioned.delete(s);
      r.marks_actioned = Array.from(actioned);
      r.open_follow_ups = Array.from(marks).filter((x) => x !== "read" && !actioned.has(x)).length;
      paintMarks();
      refreshHead();
      await send(s, true, nowActioned);
    });

    function openMarkSheet() {
      const m = modal(`
        <h3>${esc(tr("rev.markLine"))}</h3>
        <p class="muted" style="margin:4px 0 12px">${esc(r.order_id)} · ${esc(r.window_ref || "")}</p>
        <div class="memgrid">
          ${LINE_REVIEW_STATUSES.map((s) => `
            <label class="cbrow"><input type="checkbox" value="${esc(s.value)}"${
              marks.has(s.value) ? " checked" : ""}> ${esc(tr(s.key))}</label>`).join("")}
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:14px">
          <button class="btn ghost" data-no>${esc(tr("act.cancel"))}</button>
          <button class="btn primary" data-yes>${esc(tr("act.save"))}</button>
        </div>`);
      m.sheet.querySelector("[data-no]").onclick = m.close;
      m.sheet.querySelector("[data-yes]").onclick = async () => {
        const want = new Set(Array.from(m.sheet.querySelectorAll("input:checked")).map((i) => i.value));
        m.close();
        const changes = [];
        LINE_REVIEW_STATUSES.forEach((s) => {
          if (want.has(s.value) && !marks.has(s.value)) changes.push([s.value, true]);
          if (!want.has(s.value) && marks.has(s.value)) changes.push([s.value, false]);
        });
        changes.forEach(([s, on]) => { if (on) marks.add(s); else { marks.delete(s); actioned.delete(s); } });
        r.marks = Array.from(marks);
        r.marks_actioned = Array.from(actioned);
        r.is_read = marks.has("read");
        r.open_follow_ups = Array.from(marks).filter((x) => x !== "read" && !actioned.has(x)).length;
        if (readBox) readBox.checked = r.is_read;
        tr1.classList.toggle("isread", r.is_read);
        paintMarks();
        refreshHead();
        for (const [s, on] of changes) await send(s, on);
        toast(queueDepth() ? tr("t.queued") : tr("t.saved"), "ok");
      };
    }

    return tr1;
  }

  /* Ticking is delegated, so it keeps working as Show more appends rows. The header box covers the
   * DRAWN rows only - widening to the whole filter is a separate, explicit choice in the bar. */
  wrap.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("input[data-selall]")) {
      wrap.querySelectorAll("input[data-sel]").forEach((cb) => {
        cb.checked = t.checked;
        cb.closest("tr").classList.toggle("selected", t.checked);
        if (t.checked) selected.add(cb.value); else selected.delete(cb.value);
      });
      wholeFilter = false;
    } else if (t.matches("input[data-sel]")) {
      if (t.checked) selected.add(t.value); else selected.delete(t.value);
      t.closest("tr").classList.toggle("selected", t.checked);
      wholeFilter = false;
    } else return;
    updateSel();
  });

  let drawn = 0;
  function draw() {
    const upto = Math.min(rows.length, drawn + SHOWN);
    for (let i = drawn; i < upto; i++) {
      const r = rows[i];
      tb.appendChild(drawRow(r, i === 0 || rows[i - 1].order_id !== r.order_id));
    }
    drawn = upto;
    const left = rows.length - drawn;
    more.innerHTML = "";
    if (left > 0) {
      const b = el(`<button class="btn">${esc(tr("rev.showMore", { n: left }))}</button>`);
      b.addEventListener("click", draw);
      more.appendChild(b);
    }
  }
  draw();
}
