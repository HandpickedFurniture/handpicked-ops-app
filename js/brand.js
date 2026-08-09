/* Handpicked mark.
 *
 * Drawn as inline SVG rather than shipped as an image file: it is a few hundred bytes, stays crisp
 * at any size, needs no extra network request, and can be reused as the favicon via a data URI.
 *
 * Geometry follows the supplied logo - a terracotta disc with an H and an F sharing a vertical gap,
 * their crossbars meeting at the same heights so the two letters read as one mark.
 */

export const BRAND_TERRACOTTA = "#A9714B";

/* viewBox 0 0 100 100. Bars are cut as white rectangles over the disc, exactly as in the original. */
export function logoSvg(size = 36, bg = BRAND_TERRACOTTA, fg = "#ffffff") {
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" role="img"
     aria-label="Handpicked" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="48" fill="${bg}"/>
  <g fill="${fg}">
    <rect x="15" y="29" width="7"  height="53"/>
    <rect x="15" y="49" width="32" height="7"/>
    <rect x="46" y="2"  width="7"  height="80"/>
    <rect x="57" y="29" width="30" height="7"/>
    <rect x="57" y="29" width="7"  height="69"/>
    <rect x="57" y="53" width="26" height="7"/>
  </g>
</svg>`;
}

/* A favicon needs a real URI, so the same markup goes in as a data: URL. encodeURIComponent rather
 * than base64 keeps it readable and avoids the btoa unicode trap. */
export function faviconDataUri() {
  const svg = logoSvg(64).replace(/\n\s*/g, " ");
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

export function installFavicon() {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = faviconDataUri();
}
