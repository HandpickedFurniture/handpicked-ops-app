/* Order PDFs, served straight from Supabase Storage.
 *
 * The agent writes every generated PDF to BOTH Google Drive and the `order-pdfs` bucket, so for any
 * order it has processed the two are the same file. Serving from Storage means a coordinator gets
 * the PDF in one tap without leaving the app, signing into Drive, or searching a folder of hundreds.
 *
 * COVERAGE IS PARTIAL, AND HONESTLY SO. Only orders processed by the agent have PDFs here - 238 of
 * 643 as of 9 Aug 2026. The rest were bulk-loaded from history before the generator existed; their
 * files are in Drive under the older `{order}_L1/_L2/_RO/-Checklist` naming, in a different folder.
 * For those, this offers a Drive search link rather than an empty panel pretending nothing exists.
 *
 * Buckets are PRIVATE. Every link is a short-lived signed URL, minted on demand.
 */
import { SB_URL, SB_KEY } from "./config.js";
import { api, getSession } from "./api.js";
import { tr } from "./i18n.js";
import { esc, el, chip, num, fmtDate, toast } from "./ui.js";

const KIND_KEY = {
  production_report: "doc.production",
  rail_checklist: "doc.rail",
  po_checklist: "doc.poChecklist",
  panel_plan: "doc.panel",
};

/* Newest PO version first, then the main report ahead of its checklists. */
const KIND_RANK = { production_report: 0, rail_checklist: 1, panel_plan: 2, po_checklist: 3 };

export async function listDocs(orderId) {
  try {
    return await api(
      `/rest/v1/v_ops_order_docs?select=*&order_id=eq.${encodeURIComponent(orderId)}`);
  } catch (e) {
    return [];
  }
}

export async function signedUrl(bucket, path, download) {
  const s = getSession();
  if (!s || !s.access_token) throw new Error(tr("auth.required"));
  const r = await fetch(`${SB_URL}/storage/v1/object/sign/${bucket}/${encodeURI(path)}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + s.access_token,
               "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.signedURL) throw new Error(j.message || j.error || "Could not open that file");
  const base = SB_URL + "/storage/v1" + (j.signedURL.startsWith("/") ? "" : "/") + j.signedURL;
  // `download` makes the browser save it rather than preview it in a tab
  return download ? base + (base.includes("?") ? "&" : "?") + "download" : base;
}

/* Drive can't be queried from the browser app, so this hands off a search for the order number.
 * One click, and it works because staff are already signed into Google. */
function driveSearchUrl(orderId) {
  return "https://drive.google.com/drive/search?q=" + encodeURIComponent(orderId + " type:pdf");
}

export async function docSummary(orderId) {
  try {
    const r = await api(
      `/rest/v1/v_ops_order_doc_summary?select=*&order_id=eq.${encodeURIComponent(orderId)}`);
    return r && r[0];
  } catch (e) { return null; }
}

/* The panel shown inside an order's drawer. Reads the summary view for the staleness check rather
 * than having the caller thread a version through. */
export function docsPanel(orderId) {
  const box = el(`
    <div class="dsec">
      <h4>${esc(tr("doc.title"))}</h4>
      <div class="docs"><span class="muted">${esc(tr("t.loading"))}</span></div>
    </div>`);
  const list = box.querySelector(".docs");

  Promise.all([listDocs(orderId), docSummary(orderId)]).then(([rows, sum]) => {
    const currentVersion = sum && sum.current_version;
    if (!rows.length) {
      list.innerHTML = `
        <div class="dnone">${esc(tr("doc.none"))}</div>
        <div class="muted" style="margin:6px 0 8px">${esc(tr("doc.driveHint"))}</div>
        <a class="btn sm" href="${esc(driveSearchUrl(orderId))}" target="_blank" rel="noopener">
          ${esc(tr("doc.openDrive"))} ↗</a>`;
      return;
    }

    rows.sort((a, b) =>
      (b.version_no - a.version_no) || (KIND_RANK[a.doc_kind] - KIND_RANK[b.doc_kind]));

    const stale = rows[0].version_no > 0 && currentVersion && rows[0].version_no < currentVersion;

    list.innerHTML = (stale
      ? `<div class="banner warn">${esc(tr("doc.outdated",
          { n: rows[0].version_no, m: currentVersion }))}</div>` : "")
      + rows.map((d) => `
        <div class="docrow" data-bucket="${esc(d.bucket_id)}" data-path="${esc(d.object_path)}">
          <span class="dico">📄</span>
          <span class="dmeta">
            <b>${esc(tr(KIND_KEY[d.doc_kind] || "doc.production"))}</b>
            <span class="muted">
              ${d.version_no ? esc(tr("doc.version", { n: d.version_no })) + " · " : ""}
              ${esc(num((d.bytes || 0) / 1024))} KB · ${esc(fmtDate(d.created_at))}</span>
          </span>
          <span class="row">
            <button class="btn sm" data-view>${esc(tr("doc.open"))}</button>
            <button class="btn sm primary" data-dl>${esc(tr("doc.download"))}</button>
          </span>
        </div>`).join("");

    list.querySelectorAll(".docrow").forEach((row) => {
      const open = async (download) => {
        try {
          const url = await signedUrl(row.dataset.bucket, row.dataset.path, download);
          window.open(url, "_blank", "noopener");
        } catch (e) { toast(e.message, "bad"); }
      };
      row.querySelector("[data-view]").addEventListener("click", () => open(false));
      row.querySelector("[data-dl]").addEventListener("click", () => open(true));
    });
  });

  return box;
}

/* Compact button for the production table's row - opens the newest production report directly. */
export function docButton(orderId, summary) {
  if (!summary || !summary.has_pdf) {
    return `<a class="btn sm ghost" href="${esc(driveSearchUrl(orderId))}"
      target="_blank" rel="noopener" title="${esc(tr("doc.driveHint"))}">↗</a>`;
  }
  return `<button class="btn sm" data-pdf="${esc(orderId)}"
    title="${esc(tr("doc.count", { n: summary.doc_count }))}">📄 ${esc(summary.doc_count)}</button>`;
}

/* Opens the newest production report for an order without expanding its drawer. */
export async function openLatest(orderId) {
  const rows = await listDocs(orderId);
  if (!rows.length) { window.open(driveSearchUrl(orderId), "_blank", "noopener"); return; }
  rows.sort((a, b) =>
    (b.version_no - a.version_no) || (KIND_RANK[a.doc_kind] - KIND_RANK[b.doc_kind]));
  try {
    window.open(await signedUrl(rows[0].bucket_id, rows[0].object_path, false), "_blank", "noopener");
  } catch (e) { toast(e.message, "bad"); }
}
