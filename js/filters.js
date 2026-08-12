/* The shared filter bar, used identically by all three modules.
 *
 * Every field maps to a PostgREST predicate on v_ops_order_roster / v_ops_status_board, so filtering
 * happens in Postgres and the browser never holds more than a page of rows.
 *
 * State lives in location.hash, so a coordinator can bookmark a filtered view or WhatsApp the link -
 * the cheapest possible "share this list".
 *
 * Every value filter is a LIST OF CHECKBOXES rather than a dropdown, so it takes any number of values
 * at once: "Dubai and Abu Dhabi", "sent and received back", "today and tomorrow". Values within a
 * field are OR-ed, and the fields are AND-ed together - which is what ticking two cities means.
 *
 * Multi-values ride in the hash as a REPEATED KEY (?city=Dubai&city=Sharjah) rather than a joined
 * string: three of the option values contain a comma, and URLSearchParams gets the escaping right
 * where a separator of our own choosing would need escaping rules nobody would remember. A one-value
 * link written before any of this still reads back correctly, so #/production?bucket=overdue sitting
 * in somebody's WhatsApp keeps working.
 */
import { tr } from "./i18n.js";
import { DATE_BUCKETS, FABRIC_RECV_STATES, DISPATCH_STATES, PRODUCTION_STATES } from "./config.js";
import { esc, el } from "./ui.js";

/* Free text and dates - one value each. */
export const TEXT_FIELDS = ["order", "from", "to", "customer", "comment", "q"];
/* Everything picked from a list - any number of values each. */
export const MULTI_FIELDS = [
  "bucket", "sheet", "city", "stitch", "commercial", "wref", "fab1", "fab2",
  "alt", "fabstatus", "tailor", "prodstate",
];
export const FIELDS = [...TEXT_FIELDS, ...MULTI_FIELDS];

/* Fields whose column only exists on SOME of the views this bar filters. The caller opts in; a
 * module that does not gets neither the control nor the predicate, rather than a 400 on a column
 * the view has never heard of.
 *
 * fabstatus and tailor are roster-only; prodstate is on the roster AND the status board. */
const OPTIONAL = ["fabstatus", "tailor", "prodstate"];

/* The selected values of one multi-field, always as a list.
 *
 * Tolerates a bare string, so a hand-typed link (?bucket=today) and any caller still handing over a
 * single value behave exactly like a one-item list. */
export const vals = (f, k) => {
  const v = f[k];
  if (v === undefined || v === null || v === "") return [];
  return (Array.isArray(v) ? v : [v]).filter(Boolean);
};
export const has = (f, k, v) => vals(f, k).includes(v);
/* Tick or untick one value, returning a new filter object - for the tiles and chips outside this
 * bar that drive the same fields. */
export const toggle = (f, k, v) =>
  ({ ...f, [k]: has(f, k, v) ? vals(f, k).filter((x) => x !== v) : [...vals(f, k), v] });

export function readHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [route, qs] = raw.split("?");
  const p = new URLSearchParams(qs || "");
  const f = {};
  TEXT_FIELDS.forEach((k) => { const v = p.get(k); if (v) f[k] = v; });
  MULTI_FIELDS.forEach((k) => { const v = p.getAll(k).filter(Boolean); if (v.length) f[k] = v; });
  return { route: route || "production", filters: f, params: p };
}

export function writeHash(route, filters, extra) {
  const p = new URLSearchParams();
  TEXT_FIELDS.forEach((k) => { if (filters[k]) p.set(k, filters[k]); });
  MULTI_FIELDS.forEach((k) => vals(filters, k).forEach((v) => p.append(k, v)));
  if (extra) for (const k in extra) { if (extra[k]) p.set(k, extra[k]); }
  const qs = p.toString();
  location.hash = "/" + route + (qs ? "?" + qs : "");
}

export function activeCount(f, caps) {
  const set = (k) => (MULTI_FIELDS.includes(k) ? vals(f, k).length > 0 : !!f[k]);
  return FIELDS.filter((k) => set(k) && (!OPTIONAL.includes(k) || (caps && caps[k]))).length;
}

/* Build the PostgREST query string fragment for the current filters. */
export function toQuery(f, caps) {
  const q = [];
  const ilike = (col, v) => `${col}=ilike.*${encodeURIComponent(String(v).replace(/[*,]/g, " ").trim())}*`;
  /* PostgREST list syntax. Every element is double-quoted: three of the commercial names contain a
   * comma, and an unquoted one would split into two values that match nothing. */
  const quote = (v) => '"' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const inList = (col, list) =>
    `${col}=in.${encodeURIComponent("(" + list.map(quote).join(",") + ")")}`;
  /* Array columns take `ov` - overlap, ie "holds any of these" - which is what ticking two stitching
   * types means. With one value ticked it is the same test as the `cs` this used to send. */
  const overlaps = (col, list) =>
    `${col}=ov.${encodeURIComponent("{" + list.map(quote).join(",") + "}")}`;
  const m = (k) => vals(f, k);

  if (f.order) q.push(ilike("order_id", f.order));
  if (f.from)  q.push(`installation_date=gte.${f.from}`);
  if (f.to)    q.push(`installation_date=lte.${f.to}`);

  if (m("sheet").length)  q.push(inList("sheet_status", m("sheet")));
  if (m("bucket").length) q.push(inList("date_bucket", m("bucket")));

  /* `alteration` is exposed on the roster AND the status board, so this one predicate works in every
   * module rather than needing a per-module special case. Ticking both Yes and No says exactly what
   * ticking neither says, so it filters on nothing. */
  const alt = m("alt");
  if (alt.length === 1) q.push(`alteration=is.${alt[0] === "yes"}`);

  // see OPTIONAL - each of these only exists on some of the views this bar drives
  if (m("fabstatus").length && caps && caps.fabstatus) q.push(inList("fabric_recv_state", m("fabstatus")));
  if (m("tailor").length    && caps && caps.tailor)    q.push(inList("dispatch_state", m("tailor")));
  if (m("prodstate").length && caps && caps.prodstate) q.push(inList("production_state", m("prodstate")));

  /* 492 of 641 orders have no city at all, so "unknown" has to be selectable rather than silently
   * excluded - and now it can be ticked ALONGSIDE real cities. That needs a single or=(), because
   * `city=is.null` and `city=in.(...)` as two predicates would be AND-ed and match nothing. */
  const named = m("city").filter((c) => c !== "__none__");
  const anon = has(f, "city", "__none__");
  if (anon && named.length) {
    q.push(`or=${encodeURIComponent(`(city.is.null,city.in.(${named.map(quote).join(",")}))`)}`);
  } else if (anon) {
    q.push("city=is.null");
  } else if (named.length) {
    q.push(inList("city", named));
  }

  // customer name, optional comment and free text all live in the prebuilt lowercase search_blob
  if (f.customer) q.push(ilike("search_blob", f.customer.toLowerCase()));
  if (f.comment)  q.push(ilike("search_blob", f.comment.toLowerCase()));
  if (f.q)        q.push(ilike("search_blob", f.q.toLowerCase()));

  if (m("stitch").length)     q.push(overlaps("stitching_types", m("stitch")));
  if (m("commercial").length) q.push(overlaps("commercial_names", m("commercial")));
  if (m("wref").length)       q.push(overlaps("window_refs", m("wref")));
  if (m("fab1").length)       q.push(overlaps("fabric_1_codes", m("fab1").map((v) => v.toLowerCase().trim())));
  if (m("fab2").length)       q.push(overlaps("fabric_2_codes", m("fab2").map((v) => v.toLowerCase().trim())));

  return q.length ? "&" + q.join("&") : "";
}

/* Options for the checkbox lists, derived once from the roster so they only ever offer real values. */
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

/* Past a dozen options the list grows its own search box, and only the first CB_CAP matches are
 * drawn. This is not a nicety: window ref has ~2,500 distinct values and fabric 1 has ~455, and the
 * bar is rebuilt twice on every render. */
const CB_SEARCH_OVER = 12;
const CB_CAP = 150;

const plain = (v) => ({ value: v, label: v });
const fromCfg = (s) => ({ value: s.value, label: tr(s.key) });

export function renderFilterBar(mount, state, opts, onChange, caps) {
  const f = state.filters;
  const n = activeCount(f, caps);
  const collapsed = n === 0;

  /* Every value list this bar can draw. Held here rather than inlined in the markup so the search
   * box can repaint one list without rebuilding the bar around it. */
  const OPTS = {
    bucket: DATE_BUCKETS.map((b) => ({ value: b.value, label: `${b.glyph} ${tr(b.key)}` })),
    sheet: opts.sheet.map(plain),
    city: [...opts.cities.map(plain), { value: "__none__", label: tr("f.unknownCity") }],
    stitch: opts.stitch.map(plain),
    commercial: opts.commercial.map(plain),
    wref: opts.wref.map(plain),
    fab1: opts.fab1.map(plain),
    fab2: opts.fab2.map(plain),
    alt: [{ value: "yes", label: tr("f.alterationYes") }, { value: "no", label: tr("f.alterationNo") }],
    fabstatus: FABRIC_RECV_STATES.map(fromCfg),
    tailor: DISPATCH_STATES.map(fromCfg),
    prodstate: PRODUCTION_STATES.map(fromCfg),
  };

  /* Staged selections. The bar has always committed on Apply rather than on every keystroke, and
   * ticking is no different - except the date-bucket row, which is the one-click row and still
   * filters the moment it is clicked.
   *
   * Holding the ticks HERE rather than reading the DOM at Apply time is what lets a long list draw
   * only its first 150 rows: a tick that a search has since scrolled out of view is still a tick. */
  const picks = {};
  MULTI_FIELDS.forEach((k) => { picks[k] = new Set(vals(f, k)); });

  /* A field: its label, a search box once the list is long, and the checkboxes themselves (painted
   * by paintOpts once the bar is in the DOM). */
  const cbField = (name, label) => {
    const long = (OPTS[name] || []).length > CB_SEARCH_OVER;
    return `
      <div><label class="f" id="lbl-${esc(name)}">${esc(label)}<span data-count="${esc(name)}"></span></label>
        <div class="cbfield" data-field="${esc(name)}" role="group" aria-labelledby="lbl-${esc(name)}">
          ${long ? `<input type="search" class="cbsearch" data-search="${esc(name)}"
                 placeholder="${esc(tr("f.narrow"))}" aria-label="${esc(label)} — ${esc(tr("f.narrow"))}">` : ""}
          <div class="cbopts"></div>
        </div></div>`;
  };

  const bar = el(`
    <div class="filterbar ${collapsed ? "collapsed" : ""}">
      <div class="fsummary">
        <span>${n ? esc(tr("f.summary", { n, m: state.count ?? "…" }))
                  : esc(tr("f.none", { m: state.count ?? "…" }))}</span>
        <span class="muted" data-toggle>▾</span>
      </div>
      <div class="fbody">
        <div class="bucketrow" data-field="bucket" role="group" aria-label="${esc(tr("col.install"))}">
          ${DATE_BUCKETS.map((b) => `<label class="${picks.bucket.has(b.value) ? "on" : ""}">
             <input type="checkbox" data-cb="bucket" value="${esc(b.value)}"${
               picks.bucket.has(b.value) ? " checked" : ""}>${esc(b.glyph)} ${esc(tr(b.key))}</label>`).join("")}
        </div>
        <div class="fgrid">
          <div><label class="f">${esc(tr("f.orderId"))}</label>
               <input type="text" name="order" value="${esc(f.order || "")}" inputmode="numeric"></div>
          <div><label class="f">${esc(tr("f.dateFrom"))}</label>
               <input type="date" name="from" value="${esc(f.from || "")}"></div>
          <div><label class="f">${esc(tr("f.dateTo"))}</label>
               <input type="date" name="to" value="${esc(f.to || "")}"></div>
          ${cbField("sheet", tr("f.sheetStatus"))}
          ${cbField("city", tr("f.city"))}
          <div><label class="f">${esc(tr("f.customer"))}</label>
               <input type="text" name="customer" value="${esc(f.customer || "")}"></div>
          ${cbField("stitch", tr("f.stitching"))}
          ${cbField("commercial", tr("f.commercial"))}
          ${cbField("wref", tr("f.windowRef"))}
          <div><label class="f">${esc(tr("f.comment"))}</label>
               <input type="text" name="comment" value="${esc(f.comment || "")}"></div>
          ${cbField("fab1", tr("f.fabric1"))}
          ${cbField("fab2", tr("f.fabric2"))}
          ${cbField("alt", tr("f.alteration"))}
          ${caps && caps.fabstatus ? cbField("fabstatus", tr("f.fabricStatus")) : ""}
          ${caps && caps.tailor ? cbField("tailor", tr("disp.title")) : ""}
          ${caps && caps.prodstate ? cbField("prodstate", tr("f.prodStatus")) : ""}
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn ghost" data-clear>${esc(tr("f.clear"))}</button>
          <button class="btn primary" data-apply>${esc(tr("f.apply"))}</button>
        </div>
      </div>
    </div>`);

  /* Draw one field's checkboxes, narrowed to `term`.
   *
   * Whatever is already ticked is drawn first and always, however far down the alphabet it sits or
   * whatever the search says - otherwise narrowing the list would hide a selection that is still
   * being applied, which is the one thing worse than a long list. */
  function paintOpts(name, term) {
    const box = bar.querySelector(`[data-field="${CSS.escape(name)}"] .cbopts`);
    if (!box) return;
    const t = (term || "").trim().toLowerCase();
    const all = OPTS[name] || [];
    const on = all.filter((o) => picks[name].has(o.value));
    const rest = all.filter((o) => !picks[name].has(o.value)
      && (!t || String(o.label).toLowerCase().includes(t)));
    const hidden = Math.max(0, rest.length - CB_CAP);
    const shown = [...on, ...rest.slice(0, CB_CAP)];
    box.innerHTML = shown.length
      ? shown.map((o) => `<label><input type="checkbox" data-cb="${esc(name)}" value="${esc(o.value)}"${
            picks[name].has(o.value) ? " checked" : ""}><span>${esc(o.label)}</span></label>`).join("")
        + (hidden ? `<div class="cbmore">${esc(tr("f.more", { n: hidden }))}</div>` : "")
      : `<div class="cbnone">${esc(tr("f.noMatch"))}</div>`;
  }

  const countLabel = (name) => {
    const c = bar.querySelector(`[data-count="${CSS.escape(name)}"]`);
    if (c) c.textContent = picks[name].size ? ` (${picks[name].size})` : "";
  };

  MULTI_FIELDS.forEach((k) => {
    if (bar.querySelector(`[data-field="${CSS.escape(k)}"]`)) { paintOpts(k, ""); countLabel(k); }
  });

  /* Text fields keep their own state in the DOM; list fields keep it in `picks`.
   *
   * A field this module did not ask for (see OPTIONAL) was never on screen to be changed, so its
   * value is carried through untouched rather than cleared: a tailor filter set in Production must
   * still be there after pressing Apply on the status board, which has no tailor control at all. */
  const merged = () => {
    const next = { ...f };
    bar.querySelectorAll("input[name]").forEach((i) => { next[i.name] = i.value; });
    MULTI_FIELDS.forEach((k) => {
      if (bar.querySelector(`[data-field="${CSS.escape(k)}"]`)) next[k] = Array.from(picks[k]);
    });
    return next;
  };

  bar.querySelector(".fsummary").addEventListener("click", () => bar.classList.toggle("collapsed"));

  bar.addEventListener("change", (e) => {
    if (!e.target.matches("input[data-cb]")) return;
    const name = e.target.dataset.cb;
    if (e.target.checked) picks[name].add(e.target.value); else picks[name].delete(e.target.value);
    e.target.closest("label").classList.toggle("on", e.target.checked);
    countLabel(name);
    // the date-bucket row is the one-click row: it has always filtered on the click, not on Apply
    if (name === "bucket") onChange(merged());
  });

  bar.querySelectorAll("[data-search]").forEach((s) =>
    s.addEventListener("input", () => paintOpts(s.dataset.search, s.value)));

  bar.querySelector("[data-clear]").addEventListener("click", () => onChange({}));
  bar.querySelector("[data-apply]").addEventListener("click", () => onChange(merged()));
  // Enter anywhere in the bar applies - including from a list's search box
  bar.querySelectorAll('input[name],input[type="search"]').forEach((i) => {
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); bar.querySelector("[data-apply]").click(); }
    });
  });

  mount.innerHTML = "";
  mount.appendChild(bar);
  return bar;
}
