/* Pointer-event drag for the Schedule board.
 *
 * NOT HTML5 drag-and-drop. `dragstart` never fires on touch in iOS or Android Chrome, and this app
 * is used on phones in vans, so the native API would make the board mouse-only. Pointer Events give
 * one code path for mouse, touch and stylus.
 *
 * The drag starts from a dedicated grip, never the whole card. `touch-action: none` has to be set on
 * whatever begins the drag - otherwise the browser claims the gesture for scrolling and cancels our
 * pointer stream - and putting it on the card would kill scrolling of the column the card sits in.
 * A grip keeps both: drag by the grip, scroll by the card.
 *
 * Everything here is presentation. It reports "this item went into that zone at that index" and the
 * caller decides what that means; no schedule maths lives in this file.
 */

const THRESHOLD = 6;      // px of movement before a press becomes a drag
const EDGE = 60;          // px from the board edge that triggers auto-scroll
const EDGE_SPEED = 18;

/* opts: { handleSel, itemSel, zoneSel, itemKey(el), zoneKey(el), onDrop(itemKey, zoneKey, index) }
 * Returns a teardown function. */
export function dragBoard(root, opts) {
  const { handleSel, itemSel, zoneSel, itemKey, zoneKey, onDrop } = opts;
  let st = null;
  let scroller = null;

  root.addEventListener("pointerdown", onDown);

  function onDown(e) {
    if (e.button) return;                       // right/middle click never drags
    const handle = e.target.closest(handleSel);
    if (!handle || !root.contains(handle)) return;
    const item = handle.closest(itemSel);
    if (!item) return;

    e.preventDefault();
    st = { item, handle, x0: e.clientX, y0: e.clientY, live: false, ghost: null, marker: null };
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
  }

  function begin(e) {
    const r = st.item.getBoundingClientRect();
    st.dx = r.left - e.clientX;
    st.dy = r.top - e.clientY;

    const g = st.item.cloneNode(true);
    g.classList.add("dragghost");
    g.style.width = r.width + "px";
    g.style.left = r.left + "px";
    g.style.top = r.top + "px";
    document.body.appendChild(g);
    st.ghost = g;
    st.item.classList.add("dragsrc");

    st.marker = document.createElement("div");
    st.marker.className = "dropline";

    // one measurement per drag; the board does not reflow while a finger is down
    st.zones = Array.from(root.querySelectorAll(zoneSel)).map((z) => ({ el: z, r: z.getBoundingClientRect() }));
    st.live = true;
  }

  function onMove(e) {
    if (!st) return;
    if (!st.live) {
      if (Math.abs(e.clientX - st.x0) < THRESHOLD && Math.abs(e.clientY - st.y0) < THRESHOLD) return;
      begin(e);
    }
    e.preventDefault();

    st.ghost.style.left = e.clientX + st.dx + "px";
    st.ghost.style.top = e.clientY + st.dy + "px";

    const zone = st.zones.find((z) => e.clientX >= z.r.left && e.clientX <= z.r.right
                                   && e.clientY >= z.r.top - 8 && e.clientY <= z.r.bottom + 8);
    if (!zone) { st.marker.remove(); st.target = null; autoscroll(e); return; }

    // insert before the first sibling whose middle is below the pointer
    const sibs = Array.from(zone.el.querySelectorAll(itemSel)).filter((n) => n !== st.item);
    let idx = sibs.length;
    for (let i = 0; i < sibs.length; i++) {
      const b = sibs[i].getBoundingClientRect();
      if (e.clientY < b.top + b.height / 2) { idx = i; break; }
    }
    if (idx >= sibs.length) zone.el.appendChild(st.marker);
    else zone.el.insertBefore(st.marker, sibs[idx]);

    st.target = { zone: zone.el, index: idx };
    autoscroll(e);
  }

  function autoscroll(e) {
    const r = root.getBoundingClientRect();
    let d = 0;
    if (e.clientX < r.left + EDGE) d = -EDGE_SPEED;
    else if (e.clientX > r.right - EDGE) d = EDGE_SPEED;
    if (d && !scroller) scroller = setInterval(() => { root.scrollLeft += d; }, 16);
    else if (!d && scroller) { clearInterval(scroller); scroller = null; }
  }

  function cleanup() {
    if (scroller) { clearInterval(scroller); scroller = null; }
    if (st) {
      if (st.ghost) st.ghost.remove();
      if (st.marker) st.marker.remove();
      st.item.classList.remove("dragsrc");
      st.handle.removeEventListener("pointermove", onMove);
      st.handle.removeEventListener("pointerup", onUp);
      st.handle.removeEventListener("pointercancel", onCancel);
    }
    st = null;
  }

  function onUp() {
    if (!st) return;
    const live = st.live, item = st.item, target = st.target;
    cleanup();
    if (live && target) onDrop(itemKey(item), zoneKey(target.zone), target.index);
  }

  function onCancel() { cleanup(); }

  return () => { root.removeEventListener("pointerdown", onDown); cleanup(); };
}
