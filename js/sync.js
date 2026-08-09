/* Last 3D-sheet sync, shown on every module.
 *
 * The sheet is mirrored by a Cloud Run job every 10 minutes. When that job stops - as it silently did
 * for 11 days in late July, failing on a missing IAM binding while the scheduler reported success -
 * every sheet-derived column quietly goes stale. Nothing on screen changed, so nobody noticed.
 *
 * So the timestamp is not decoration: it is the only thing that tells a coordinator whether the
 * "Installation status" they are reading is current. It goes amber past an hour and red past a day.
 */
import { api } from "./api.js";
import { tr } from "./i18n.js";
import { esc, el, fmtDateTime } from "./ui.js";

let cached = null;
let fetchedAt = 0;

export async function lastSync(force) {
  // one request per minute at most; every module asks for this on every render
  if (!force && cached !== null && Date.now() - fetchedAt < 60000) return cached;
  try {
    const rows = await api(
      "/rest/v1/installation_schedule?select=synced_at&order=synced_at.desc&limit=1");
    cached = rows && rows.length ? rows[0].synced_at : null;
  } catch (e) {
    cached = null;
  }
  fetchedAt = Date.now();
  return cached;
}

export function syncBarHtml(ts) {
  if (!ts) {
    return `<span class="syncstamp bad" title="${esc(tr("sync.never"))}">⚠ ${esc(tr("sync.never"))}</span>`;
  }
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  const tone = mins > 1440 ? "bad" : mins > 60 ? "warn" : "ok";
  const age = mins < 1 ? tr("sync.justNow")
    : mins < 60 ? tr("sync.minsAgo", { n: mins })
    : mins < 1440 ? tr("sync.hoursAgo", { n: Math.floor(mins / 60) })
    : tr("sync.daysAgo", { n: Math.floor(mins / 1440) });
  return `<span class="syncstamp ${tone}" title="${esc(fmtDateTime(ts))}">
    ${tone === "ok" ? "✓" : "⚠"} ${esc(tr("sync.label"))} ${esc(fmtDateTime(ts))} · ${esc(age)}</span>`;
}

/* Drop into any module header. Renders immediately from cache, then refreshes in place. */
export function syncBar() {
  const box = el(`<span class="syncwrap">${syncBarHtml(cached)}</span>`);
  lastSync().then((ts) => { box.innerHTML = syncBarHtml(ts); });
  return box;
}
