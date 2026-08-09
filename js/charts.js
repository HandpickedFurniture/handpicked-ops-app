/* Charts, as inline SVG. No library, consistent with the rest of the app being zero-build.
 *
 * Form: horizontal bars. The category names here are long ("Successfully completed", "Awaiting
 * fabric"), and horizontal bars give them room without rotating any text.
 *
 * Colour, deliberately:
 *   * Production status is ORDINAL - it is a pipeline, and reordering it would change the meaning -
 *     so it takes ONE hue in monotone lightness steps. The reader sees the order in the colour.
 *     Ramp validated with the dataviz validator (monotone L, adjacent dL >= 0.06, light-end
 *     contrast >= 2:1, single hue): an earlier, prettier ramp failed the light end at 1.52:1.
 *   * Installation status is nominal, so every bar takes the SAME hue. Colouring nominal bars by
 *     their own value would spend the identity channel re-encoding what bar length already shows.
 *     State is carried instead by a status dot plus the written label, never colour alone.
 *
 * Every bar is directly labelled with its value, so nothing depends on reading a colour.
 */
import { esc } from "./ui.js";
import { tr } from "./i18n.js";

/* Single-hue ordinal ramp, light -> dark. Validated; do not re-step by eye. */
export const ORDINAL_RAMP = ["#8fb9c6", "#74a5b6", "#5991a6", "#3e7d96", "#256986", "#0f4c5c"];
export const BAR_HUE = "#3e7d96";     // 4.59:1 on white
const TRACK = "#eef2f4";
const INK = "#16232a";
const MUTED = "#5f7480";

const TONE_DOT = {
  ok: "#1a7f37", warn: "#9a5b00", bad: "#c0392b", info: "#0f4c5c", mute: "#8aa0ab",
};

/* rows: [{ label, value, tone?, color? }]  */
export function barChart(rows, opts = {}) {
  const data = rows.filter((r) => Number(r.value) > 0 || opts.keepZero);
  if (!data.length) return `<div class="dnone">${esc(tr("dash.noChart"))}</div>`;

  const max = Math.max(...data.map((r) => Number(r.value) || 0), 1);
  // taller rows when any bar carries a secondary note (e.g. metres under the count)
  const hasNote = data.some((r) => r.note);
  const rowH = hasNote ? 34 : 26;
  const gap = 6, padL = opts.labelWidth || 132, padR = 62, top = 4;
  const h = top + data.length * (rowH + gap);
  const w = 460;                      // viewBox units; the SVG scales to its container
  const barW = w - padL - padR;

  const bars = data.map((r, i) => {
    const y = top + i * (rowH + gap);
    const v = Number(r.value) || 0;
    const len = Math.max(v > 0 ? 3 : 0, (v / max) * barW);
    const fill = r.color || opts.color || BAR_HUE;
    const dot = r.tone ? TONE_DOT[r.tone] || MUTED : null;

    return `
      <g>
        ${dot ? `<circle cx="6" cy="${y + rowH / 2}" r="4" fill="${dot}"/>` : ""}
        <text class="lbl" x="${dot ? 16 : 0}" y="${y + rowH / 2 + 4}">${esc(trunc(r.label, 22))}</text>
        <rect class="track" x="${padL}" y="${y + 4}" width="${barW}" height="${rowH - 8}" rx="4"/>
        <rect x="${padL}" y="${y + 4}" width="${len}" height="${rowH - 8}" rx="4" fill="${fill}"/>
        <text class="val" x="${padL + len + 8}" y="${y + rowH / 2 + 4}">${esc(String(v))}</text>
        ${r.note ? `<text class="lbl" x="${padL + len + 8}" y="${y + rowH / 2 + 15}"
           >${esc(r.note)}</text>` : ""}
      </g>`;
  }).join("");

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img"
    aria-label="${esc(opts.title || "")}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}

function trunc(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/* A titled card wrapping a chart, plus a hidden-in-plain-sight table for the same numbers so the
 * data is readable without seeing the graphic at all. */
export function chartCard(title, rows, opts = {}) {
  const total = rows.reduce((a, r) => a + (Number(r.value) || 0), 0);
  return `
    <div class="card">
      <div class="spread" style="margin-bottom:8px">
        <h4>${esc(title)}</h4>
        <span class="muted">${esc(String(total))}</span>
      </div>
      ${barChart(rows, { ...opts, title })}
      <details style="margin-top:8px">
        <summary class="muted" style="cursor:pointer;font-size:12px">${esc(tr("dash.csv"))}</summary>
        <table class="dense" style="margin-top:6px">
          <tbody>${rows.map((r) =>
            `<tr><td>${esc(r.label)}</td><td style="text-align:right"><b>${esc(String(r.value))}</b></td></tr>`
          ).join("")}</tbody>
        </table>
      </details>
    </div>`;
}
