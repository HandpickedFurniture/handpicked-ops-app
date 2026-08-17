/* Photo evidence, attachable to any status change.
 *
 * PLUGGABLE BACKEND. The bytes go to whichever store is configured:
 *
 *   supabase - a PRIVATE `ops-photos` bucket on the project we already use. Works today, no new
 *              credentials. Reads need a short-lived signed URL; there is no public URL.
 *   gcs      - a private Google Cloud Storage bucket. The browser never holds a GCP credential: the
 *              `photo-signed-url` Edge Function mints a V4 signed PUT, and the browser uploads
 *              straight to Google.
 *
 * Which one is live is DETECTED ONCE per session by probing the Edge Function, so switching to
 * Google Cloud later needs no app change. `storage_backend` is recorded on every row, so photos
 * already in Supabase keep resolving after the switch.
 *
 * Photos are always OPTIONAL and are uploaded OUT OF BAND from the status change itself: a failed
 * or slow upload must never block a coordinator from marking work done. The status write goes
 * through the offline queue in api.js; the photo reports its own success or failure.
 */
import {
  SB_URL, SB_KEY, PHOTO_BUCKET, PHOTO_MAX_PX, PHOTO_QUALITY, STORAGE_PREFIX,
  PHOTO_RETRIES, PHOTO_RETRY_MS,
} from "./config.js";
import { api, rpc, getSession, currentActor, isViewer } from "./api.js";
import { tr } from "./i18n.js";
import { esc, el, toast, modal, fmtDateTime, num } from "./ui.js";

const BACKEND_KEY = STORAGE_PREFIX + "photo_backend";
let LOCATIONS = null;

/* ---------------------------------------------------------------- backend detection
 * Probed once a day rather than once a session: while Google Cloud Storage is not configured the
 * `photo-signed-url` function is simply not deployed, and the browser logs a CORS/network error for
 * the failed preflight that no amount of try/catch can suppress. Caching for 24 h keeps that to one
 * benign console line per device per day, while still picking up the switch to GCS on its own once
 * the function is deployed.
 *
 * A ONE-OFF CONSOLE ERROR MENTIONING photo-signed-url IS EXPECTED until GCS is set up. Photos still
 * upload - to the private Supabase bucket. */
const PROBE_TTL_MS = 24 * 3600 * 1000;

async function backend() {
  try {
    const cached = JSON.parse(localStorage.getItem(BACKEND_KEY) || "null");
    if (cached && Date.now() - cached.t < PROBE_TTL_MS) return cached.b;
  } catch (e) { /* fall through and re-probe */ }

  let chosen = "supabase";
  try {
    const s = getSession();
    const r = await fetch(SB_URL + "/functions/v1/photo-signed-url", {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: "Bearer " + (s && s.access_token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ probe: true }),
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      if (j.configured) chosen = "gcs";
    }
  } catch (e) { /* function absent or unreachable - Supabase it is */ }

  try { localStorage.setItem(BACKEND_KEY, JSON.stringify({ b: chosen, t: Date.now() })); } catch (e) {}
  return chosen;
}

/* Lets an admin force a re-probe straight after deploying the GCS function. */
export function forgetBackendProbe() {
  localStorage.removeItem(BACKEND_KEY);
  sessionStorage.removeItem(BACKEND_KEY);
}

/* ---------------------------------------------------------------- image handling */
/* A raw phone photo is 3-6 MB. Downscaling on-device keeps uploads viable on mobile data, which is
 * where these are actually taken. Long edge 1280px at q0.65 lands around 120-200 KB and is still
 * legible for damage evidence.
 *
 * createImageBitmap, NOT `new Image()` + object URL. The old path decoded a 12-megapixel JPEG on the
 * main thread into a full-size bitmap before drawing it: on a mid-range phone that freezes the UI
 * for seconds and, often enough, is simply killed for memory - which is what "the photo doesn't
 * upload or takes too long" actually was. createImageBitmap decodes off-thread and can downsample
 * during the decode, so the full-size bitmap never exists.
 *
 * resizeQuality/resizeWidth are ignored by browsers that do not implement them; the canvas draw
 * below still produces the right size, just via a slower path. */
async function downscale(file) {
  const dims = (w, h) => {
    const scale = Math.min(1, PHOTO_MAX_PX / Math.max(w, h));
    return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
  };

  let bmp = null;
  try {
    // probe the real dimensions first, so resizeWidth/Height ask for the right thing
    const probe = await createImageBitmap(file);
    const [w, h] = dims(probe.width, probe.height);
    if (w === probe.width && h === probe.height) {
      bmp = probe;
    } else {
      bmp = await createImageBitmap(file, {
        resizeWidth: w, resizeHeight: h, resizeQuality: "high",
      });
      probe.close?.();
    }
  } catch (e) {
    /* HEIC from an iPhone, or any format this browser cannot decode. Uploading the original beats
     * refusing the evidence: the bytes are bigger, but the photo exists. */
    if (file.size > 12 * 1024 * 1024) {
      throw new Error(tr("photo.tooBig"));
    }
    return file;
  }

  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0, bmp.width, bmp.height);
  bmp.close?.();

  const blob = await new Promise((resolve) =>
    c.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
  // a canvas that failed to encode gives null; the original is still better than nothing
  return blob || file;
}

/* Retry the bytes, not the whole upload. A van in a lift drops one request, not the session, and a
 * photo that fails once is usually never retaken - so a widening pause beats a red toast. */
async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < PHOTO_RETRIES; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      // a 4xx will fail identically next time - only wait out what looks transient
      if (e && e.status && e.status >= 400 && e.status < 500) break;
      if (i < PHOTO_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, PHOTO_RETRY_MS * Math.pow(2, i)));
      }
    }
  }
  throw last || new Error(label || "Upload failed");
}

/* Hashed at upload time, from the browser, so the stored bytes can later be shown to be the same
 * bytes that were taken. */
async function sha256(blob) {
  if (!crypto.subtle) return null;
  try {
    const buf = await blob.arrayBuffer();
    const d = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) { return null; }
}

/* ---------------------------------------------------------------- upload */
export async function uploadPhoto(file, meta) {
  const blob = await downscale(file);
  const hash = await sha256(blob);
  const be = await backend();

  const year = new Date().getFullYear();
  // the extension follows what downscale actually produced - it hands back the ORIGINAL when the
  // browser could not decode it (HEIC), and calling that .jpg would mislabel the stored bytes
  const jpeg = blob.type === "image/jpeg";
  const type = jpeg ? "image/jpeg" : (blob.type || "application/octet-stream");
  /* For an attached document the MIME subtype is no use as an extension - a .xlsx arrives as
   * vnd.openxmlformats-officedocument.spreadsheetml.sheet - so the real filename wins when it has
   * a sane one. Only downscaled camera output is renamed, because only then do the bytes change. */
  const named = (file.name || "").match(/\.([A-Za-z0-9]{1,8})$/);
  const ext = jpeg ? "jpg"
            : (named ? named[1].toLowerCase() : ((blob.type || "").split("/")[1] || "bin"));
  const name = crypto.randomUUID() + "." + ext;
  const path = `${meta.order_id || "general"}/${meta.context}/${year}/${name}`;

  if (be === "gcs") await withRetry(() => putGcs(path, blob, type), "Google Cloud upload failed");
  else await withRetry(() => putSupabase(path, blob, type), "Upload failed");

  return rpc("fn_ops_record_photo", {
    p_context: meta.context,
    p_bucket: PHOTO_BUCKET,
    p_object_path: path,
    p_order_id: meta.order_id || null,
    p_context_id: meta.context_id || null,
    p_context_label: meta.context_label || null,
    p_backend: be,
    p_content_type: type,
    p_size_bytes: blob.size,
    p_sha256: hash,
    p_caption: meta.caption || null,
    p_location_code: meta.location_code || null,
    p_taken_at: new Date(file.lastModified || Date.now()).toISOString(),
    p_actor: currentActor(),
    p_op: crypto.randomUUID(),
  });
}

async function putSupabase(path, blob, type) {
  const s = getSession();
  if (!s || !s.access_token) throw new Error(tr("auth.required"));
  const r = await fetch(`${SB_URL}/storage/v1/object/${PHOTO_BUCKET}/${encodeURI(path)}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY, Authorization: "Bearer " + s.access_token,
      "Content-Type": type || "image/jpeg",
    },
    body: blob,
  });
  if (!r.ok) {
    let m = "Upload failed (" + r.status + ")";
    try { const j = await r.json(); m = j.message || j.error || m; } catch (e) {}
    // carried so withRetry can tell a dead 4xx from a flaky connection
    const err = new Error(m);
    err.status = r.status;
    throw err;
  }
}

async function putGcs(path, blob, type) {
  const s = getSession();
  const ct = type || "image/jpeg";
  const r = await fetch(SB_URL + "/functions/v1/photo-signed-url", {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + s.access_token, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "upload", path, contentType: ct }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) {
    const err = new Error(j.error || "Could not get an upload link");
    err.status = r.status;
    throw err;
  }

  const up = await fetch(j.url, { method: "PUT", headers: { "Content-Type": ct }, body: blob });
  if (!up.ok) {
    const err = new Error("Google Cloud upload failed (" + up.status + ")");
    err.status = up.status;
    throw err;
  }
}

/* ---------------------------------------------------------------- viewing */
/* Minting a signed URL is the moment a person actually sees the image, so it is logged.
 * Pass purpose === null to skip the log - only for callers that log the batch themselves. */
export async function viewUrl(photo, purpose) {
  let url;
  if (photo.storage_backend === "gcs") {
    const s = getSession();
    const r = await fetch(SB_URL + "/functions/v1/photo-signed-url", {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + s.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "view", path: photo.object_path }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error(j.error || "Could not open that photo");
    url = j.url;
  } else {
    const s = getSession();
    if (!s || !s.access_token) throw new Error(tr("auth.required"));
    const r = await fetch(
      `${SB_URL}/storage/v1/object/sign/${photo.bucket}/${encodeURI(photo.object_path)}`,
      {
        method: "POST",
        headers: { apikey: SB_KEY, Authorization: "Bearer " + s.access_token, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 600 }),
      });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.signedURL) throw new Error(j.message || j.error || "Could not open that photo");
    // signedURL comes back relative, e.g. "/object/sign/ops-photos/..."
    url = SB_URL + "/storage/v1" + (j.signedURL.startsWith("/") ? "" : "/") + j.signedURL;
  }
  if (purpose !== null) {
    rpc("fn_ops_log_photo_access", {
      p_ids: [photo.id], p_actor: currentActor(), p_purpose: purpose || "view",
    }).catch(() => {});
  }
  return url;
}

/* ---------------------------------------------------------------- bulk signing
 * A list of thumbnails needs a signed URL per image, and doing that one request at a time turns a
 * screen of 40 items into 40 round trips. Supabase signs a whole array of paths in one call.
 *
 * These ARE the real bytes (there is no separate small rendition), so showing one is a view and gets
 * logged - but deduped per session with purpose 'thumbnail'. Without the dedupe, a list that
 * repaints on every save would bury the deliberate "someone opened this photo" rows in the audit
 * trail, which is the only reason that log exists.
 */
const thumbLogged = new Set();

function logThumbnails(photos) {
  const ids = photos.map((p) => p.id).filter((id) => id && !thumbLogged.has(id));
  if (!ids.length) return;
  ids.forEach((id) => thumbLogged.add(id));
  rpc("fn_ops_log_photo_access", {
    p_ids: ids, p_actor: currentActor(), p_purpose: "thumbnail",
  }).catch(() => {});
}

/* photos -> Map(photo.id -> signed url). Missing entries just mean that image will not render;
 * a thumbnail is decoration and must never break the list it sits in. */
export async function signedUrlMap(photos) {
  const out = new Map();
  const list = (photos || []).filter((p) => p && p.object_path);
  if (!list.length) return out;

  const byBucket = new Map();
  list.filter((p) => p.storage_backend !== "gcs").forEach((p) => {
    const b = p.bucket || PHOTO_BUCKET;
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(p);
  });

  for (const [bucket, group] of byBucket) {
    try {
      const s = getSession();
      if (!s || !s.access_token) break;
      const r = await fetch(`${SB_URL}/storage/v1/object/sign/${bucket}`, {
        method: "POST",
        headers: {
          apikey: SB_KEY, Authorization: "Bearer " + s.access_token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: 600, paths: group.map((p) => p.object_path) }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(j)) continue;
      j.forEach((row, i) => {
        const signed = row && (row.signedURL || row.signedUrl);
        if (!signed) return;
        // match on path where the API echoes it, fall back to position
        const hit = (row.path && group.find((p) => p.object_path === row.path)) || group[i];
        if (hit) out.set(hit.id, SB_URL + "/storage/v1" + (signed.startsWith("/") ? "" : "/") + signed);
      });
    } catch (e) { /* leave these unsigned */ }
  }

  // no bulk equivalent on the Google side; it is one call each, and logging is handled below
  for (const p of list.filter((x) => x.storage_backend === "gcs")) {
    try { out.set(p.id, await viewUrl(p, null)); } catch (e) { /* skip */ }
  }

  logThumbnails(list.filter((p) => out.has(p.id)));
  return out;
}

/* The newest surviving photo per context_id - what a list shows as "the picture of this thing". */
export async function newestPhotoByContext(context, ids) {
  const map = new Map();
  const wanted = (ids || []).filter((x) => x !== null && x !== undefined);
  if (!wanted.length) return map;
  let rows = [];
  try {
    rows = await api("/rest/v1/order_photos"
      + "?select=id,context_id,object_path,bucket,storage_backend,caption,location_code,uploaded_by,uploaded_at"
      + `&context=eq.${encodeURIComponent(context)}`
      + `&context_id=in.(${wanted.join(",")})`
      + "&deleted_at=is.null&order=uploaded_at.desc");
  } catch (e) { return map; }
  // ordered newest first, so the first row seen for an id is the one to keep
  rows.forEach((p) => { if (!map.has(p.context_id)) map.set(p.context_id, p); });
  return map;
}

/* ---------------------------------------------------------------- locations */
export async function locations() {
  if (LOCATIONS) return LOCATIONS;
  try {
    LOCATIONS = await api("/rest/v1/locations?select=code,label,kind&active=is.true&order=sort_order,code");
  } catch (e) { LOCATIONS = []; }
  return LOCATIONS;
}

export async function locationSelect(name, current) {
  const list = await locations();
  return `<select name="${esc(name)}">
    <option value="">${esc(tr("photo.noLocation"))}</option>
    ${list.map((l) => `<option value="${esc(l.code)}"${l.code === current ? " selected" : ""}>${
      esc(l.code)} — ${esc(l.label)}</option>`).join("")}
    <option value="__new__">${esc(tr("photo.addLocation"))}</option>
  </select>`;
}

export async function createLocation(code, label, kind) {
  const row = await api("/rest/v1/locations", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ code, label, kind: kind || "other", created_by: currentActor() }),
  });
  LOCATIONS = null;
  return Array.isArray(row) ? row[0] : row;
}

/* ---------------------------------------------------------------- the reusable strip
 * Drops a camera button + thumbnails anywhere. Used at every status-change point.
 */
export function photoStrip(meta, opts = {}) {
  const id = "ph_" + Math.random().toString(36).slice(2, 9);
  /* readOnly drops the camera button but keeps the thumbnails: a viewer can look, not add.
   *
   * It DEFAULTS to the role rather than waiting to be passed. Every one of the eight callers would
   * otherwise have to remember, and the one that forgot would show a read-only account a camera
   * button that fails at the api.js choke point - refused, but only after they had taken the photo. */
  const readOnly = opts.readOnly ?? isViewer();
  /* Two buttons, not one, when opts.files is set.
   *
   * `capture="environment"` opens the camera and ONLY the camera - on a phone there is no way from
   * that button to a photo already in the gallery, let alone to a PDF a supplier sent. That is the
   * right default at a status-change point, where the photo is being taken right now, and the wrong
   * one everywhere somebody is attaching a document they already have. So the camera keeps its fast
   * path and a second control opens the ordinary picker beside it. */
  const box = el(`
    <div class="photostrip" data-strip="${id}">
      <div class="row" style="gap:6px;align-items:center">
        ${readOnly ? "" : `<label class="btn sm" style="margin:0">
          📷 ${esc(opts.label || tr("photo.add"))}
          <input type="file" accept="image/*" capture="environment" multiple hidden>
        </label>`}
        ${readOnly || !opts.files ? "" : `<label class="btn sm" style="margin:0">
          📎 ${esc(tr("photo.attach"))}
          <input type="file" data-any multiple hidden>
        </label>`}
        <span class="muted" data-count></span>
        <span class="muted" data-busy></span>
      </div>
      <div class="thumbs"></div>
    </div>`);

  // both inputs, when present, run the same upload path - absent entirely when readOnly
  const inputs = Array.from(box.querySelectorAll("input[type=file]"));
  const input = inputs[0];
  const thumbs = box.querySelector(".thumbs");
  const countEl = box.querySelector("[data-count]");
  const busyEl = box.querySelector("[data-busy]");

  async function refresh() {
    if (!meta.context_id && !meta.order_id) { countEl.textContent = ""; return; }
    let q = `/rest/v1/order_photos?select=id,object_path,bucket,storage_backend,caption,location_code,uploaded_by,uploaded_at&deleted_at=is.null&order=uploaded_at.desc&limit=12`
      + `&context=eq.${encodeURIComponent(meta.context)}`;
    q += meta.context_id ? `&context_id=eq.${meta.context_id}`
                         : `&order_id=eq.${encodeURIComponent(meta.order_id)}`;
    let rows = [];
    try { rows = await api(q); } catch (e) { return; }
    countEl.textContent = rows.length ? tr("photo.count", { n: rows.length }) : "";
    thumbs.innerHTML = "";
    // one signing call for the whole strip, not one per thumbnail
    const urls = await signedUrlMap(rows);
    rows.forEach((p) => thumbs.appendChild(thumb(p, urls.get(p.id))));
  }

  inputs.forEach((inp) => inp.addEventListener("change", async () => {
    const files = Array.from(inp.files || []);
    inp.value = "";
    if (!files.length) return;
    busyEl.textContent = tr("photo.uploading", { n: files.length });
    let ok = 0;
    for (const f of files) {
      try { await uploadPhoto(f, meta); ok++; }
      // optional by design: a failed photo never blocks the status change that prompted it
      catch (e) { toast(e.message || String(e), "bad"); }
    }
    busyEl.textContent = "";
    if (ok) toast(tr("photo.saved", { n: ok }), "ok");
    refresh();
    if (opts.onChange) opts.onChange(ok);
  }));

  refresh();
  box.refresh = refresh;
  return box;
}

/* Shows the picture itself. The emoji this used to render told you a photo existed but not what was
 * in it, so every check meant opening each one in turn. Falls back to the emoji when signing failed
 * or the image will not load. */
function thumb(p, url) {
  const t = el(`<button class="thumb" title="${esc(p.caption || p.object_path)}">${
    url ? `<img src="${esc(url)}" alt="${esc(p.caption || "")}" loading="lazy">` : "🖼️"}</button>`);
  const img = t.querySelector("img");
  if (img) img.addEventListener("error", () => { t.textContent = "🖼️"; });
  // always re-sign on open rather than reusing the thumbnail's URL: that one expires in 10 minutes,
  // and opening a photo deliberately is the thing the access log is actually for
  t.addEventListener("click", async () => {
    try { openLightbox(await viewUrl(p), p); }
    catch (e) { toast(e.message, "bad"); }
  });
  return t;
}

export function openLightbox(url, p) {
  const m = modal(`
    <div class="lightbox">
      <img src="${esc(url)}" alt="${esc(p.caption || "")}">
      <div class="muted" style="margin-top:8px">
        ${esc(p.caption || "")}
        ${p.location_code ? " · " + esc(p.location_code) : ""}
        ${p.uploaded_by ? " · " + esc(p.uploaded_by) : ""}
        ${p.uploaded_at ? " · " + esc(fmtDateTime(p.uploaded_at)) : ""}
        ${p.size_bytes ? " · " + esc(num(p.size_bytes / 1024)) + " KB" : ""}
      </div>
      ${p.sha256 ? `<div class="muted mono" style="margin-top:4px;word-break:break-all">
        sha256 ${esc(p.sha256)}</div>` : ""}
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener">${esc(tr("photo.open"))}</a>
        <button class="btn sm ghost" data-close>${esc(tr("d.close"))}</button>
      </div>
    </div>`);
  m.sheet.querySelector("[data-close]").onclick = m.close;
  return m;
}
