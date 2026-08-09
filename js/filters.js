/* The shared filter bar, used identically by all three modules.
 *
 * Every field maps to a PostgREST predicate on v_ops_order_roster / v_ops_status_board, so filtering
 * happens in Postgres and the browser never holds more than a page of rows.
 *
 * State lives in location.hash, so a coordinator can bookmark a filtered view or WhatsApp the link -
 * the cheapest possible "share this list".
 */
import { tr } from "./i18n.js";
import { DATE_BUCKETS } from "./config.js";
import { $, esc, el, selectHtml } from "./ui.js";

export const FIELDS = [
  "order", "from", "to", "sheet", "city", "customer",
  "stitch", "commercial", "wref", "comment", "fab1", "fab2", "bucket", "q", "alt",
];

export function readHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [route, qs] = raw.split("?");
  const p = new URLSearchParams(qs || "");
  const f = {};
  FIELDS.forEach((k) => { const v = p.get(k); if (v) f[k] = v; });
  return { route: route || "production", filters: f, params: p };
}

export function writeHash(route, filters, extra) {
  const p = new URLSearchParams();
  FIELDS.forEach((k) => { if (filters[k]) p.set(k, filters[k]); });
  if (extra) for (const k in extra) { if (extra[k]) p.set(k, extra[k]); }
  const qs = p.toString();
  location.hash = "/" + route + (qs ? "?" + qs : "");
}

export function activeCount(f) {
  return FIELDS.filter((k) => f[k]).length;
}

/* Build the PostgREST query string fragment for the current filters. */
export function toQuery(f) {
  const q = [];
  const ilike = (col, v) => `${col}=ilike.*${encodeURIComponent(String(v).replace(/[*,]/g, " ").trim())}*`;
  const contains = (col, v) => `${col}=cs.{${encodeURIComponent('"' + String(v).replace(/"/g, '\\"') + '"')}}`;

  if (f.order)      q.push(ilike("order_id", f.order));
  if (f.from)       q.push(`installation_date=gte.${f.from}`);
  if (f.to)         q.push(`installation_date=lte.${f.to}`);
  if (f.sheet)      q.push(`sheet_status=eq.${encodeURIComponent(f.sheet)}`);
  if (f.bucket)     q.push(`date_bucket=eq.${f.bucket}`);
  // `alteration` is exposed on the roster AND the status board, so this one predicate works in
  // every module rather than needing a per-module special case
  if (f.alt)        q.push(`alteration=is.${f.alt === "yes"}`);

  // 492 of 641 orders have no city at all, so "unknown" has to be selectable rather than
  // silently excluded
  if (f.city === "__none__") q.push("city=is.null");
  else if (f.city)           q.push(`city=eq.${encodeURIComponent(f.city)}`);

  // customer name, optional comment and free text all live in the prebuilt lowercase search_blob
  if (f.customer) q.push(ilike("search_blob", f.customer.toLowerCase()));
  if (f.comment)  q.push(ilike("search_blob", f.comment.toLowerCase()));
  if (f.q)        q.push(ilike("search_blob", f.q.toLowerCase()));

  if (f.stitch)     q.push(contains("stitching_types", f.stitch));
  if (f.commercial) q.push(contains("commercial_names", f.commercial));
  if (f.wref)       q.push(contains("window_refs", f.wref));
  if (f.fab1)       q.push(contains("fabric_1_codes", f.fab1.toLowerCase().trim()));
  if (f.fab2)       q.push(contains("fabric_2_codes", f.fab2.toLowerCase().trim()));

  return q.length ? "&" + q.join("&") : "";
}

/* Options for the dropdowns, derived once from the roster so they only ever offer real values. */
export function deriveOptions(rows) {
  const uniq = (fn) => {
    const s = new Set();
    rows.forEach((r) => { const v = fn(r); if (Array.isArray(v)) v.forEach((x) => x && s.add(x)); else if (v) s.add(v); });
    return Array.from(s).sort((a, b) => String(a).localeCompare(String(b)));
  };
  return {
    cities: uniq((r) => r.city),
    sheet: uniq((r) => r.sheet_status),
    stitch: uniq((r) => r.stitching_types),
    commercial: uniq((r) => r.commercial_names),
    wref: uniq((r) => r.window_refs),
    fab1: uniq((r) => r.fabric_1_codes),
    fab2: uniq((r) => r.fabric_2_codes),
  };
}

export function renderFilterBar(mount, state, opts, onChange) {
  const f = state.filters;
  const n = activeCount(f);
  const collapsed = n === 0;

  const sel = (name, list, placeholder) =>
    selectHtml(name, list.map((v) => ({ value: v, label: v })), f[name] || "", placeholder || tr("f.any"));

  const bar = el(`
    <div class="filterbar ${collapsed ? "collapsed" : ""}">
      <div class="fsummary">
        <span>${n ? esc(tr("f.summary", { n, m: state.count ?? "…" }))
                  : esc(tr("f.none", { m: state.count ?? "…" }))}</span>
        <span class="muted" data-toggle>▾</span>
      </div>
      <div class="fbody">
        <div class="bucketrow" role="group" aria-label="${esc(tr("f.dateFrom"))}">
          ${DATE_BUCKETS.map((b) => `<button data-bucket="${b.value}"
             class="${f.bucket === b.value ? "on" : ""}">${esc(b.glyph)} ${esc(tr(b.key))}</button>`).join("")}
        </div>
        <div class="fgrid">
          <div><label class="f">${esc(tr("f.orderId"))}</label>
               <input type="text" name="order" value="${esc(f.order || "")}" inputmode="numeric"></div>
          <div><label class="f">${esc(tr("f.dateFrom"))}</label>
               <input type="date" name="from" value="${esc(f.from || "")}"></div>
          <div><label class="f">${esc(tr("f.dateTo"))}</label>
               <input type="date" name="to" value="${esc(f.to || "")}"></div>
          <div><label class="f">${esc(tr("f.sheetStatus"))}</label>${sel("sheet", opts.sheet)}</div>
          <div><label class="f">${esc(tr("f.city"))}</label>
               ${selectHtml("city",
                   [...opts.cities.map((c) => ({ value: c, label: c })),
                    { value: "__none__", label: tr("f.unknownCity") }],
                   f.city || "", tr("f.any"))}</div>
          <div><label class="f">${esc(tr("f.customer"))}</label>
               <input type="text" name="customer" value="${esc(f.customer || "")}"></div>
          <div><label class="f">${esc(tr("f.stitching"))}</label>${sel("stitch", opts.stitch)}</div>
          <div><label class="f">${esc(tr("f.commercial"))}</label>${sel("commercial", opts.commercial)}</div>
          <div><label class="f">${esc(tr("f.windowRef"))}</label>${sel("wref", opts.wref)}</div>
          <div><label class="f">${esc(tr("f.comment"))}</label>
               <input type="text" name="comment" value="${esc(f.comment || "")}"></div>
          <div><label class="f">${esc(tr("f.fabric1"))}</label>${sel("fab1", opts.fab1)}</div>
          <div><label class="f">${esc(tr("f.fabric2"))}</label>${sel("fab2", opts.fab2)}</div>
          <div><label class="f">${esc(tr("f.alteration"))}</label>
               ${selectHtml("alt", [{ value: "yes", label: tr("f.alterationYes") },
                                    { value: "no",  label: tr("f.alterationNo") }],
                            f.alt || "", tr("f.any"))}</div>
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn ghost" data-clear>${esc(tr("f.clear"))}</button>
          <button class="btn primary" data-apply>${esc(tr("f.apply"))}</button>
        </div>
      </div>
    </div>`);

  bar.querySelector(".fsummary").addEventListener("click", () => bar.classList.toggle("collapsed"));

  bar.querySelectorAll("[data-bucket]").forEach((b) => {
    b.addEventListener("click", () => {
      const v = b.dataset.bucket;
      onChange({ ...f, bucket: f.bucket === v ? "" : v });
    });
  });

  bar.querySelector("[data-clear]").addEventListener("click", () => onChange({}));
  bar.querySelector("[data-apply]").addEventListener("click", () => {
    const next = { ...f };
    bar.querySelectorAll("input[name],select[name]").forEach((i) => { next[i.name] = i.value; });
    onChange(next);
  });
  // Enter anywhere in the bar applies
  bar.querySelectorAll("input").forEach((i) => {
    i.addEventListener("keydown", (e) => { if (e.key === "Enter") bar.querySelector("[data-apply]").click(); });
  });

  mount.innerHTML = "";
  mount.appendChild(bar);
  return bar;
}
