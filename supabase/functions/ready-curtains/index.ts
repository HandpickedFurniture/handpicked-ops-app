/* ready-curtains: the only door behind ready-curtains.html (23 Nov 2026).
 *
 * The page where staff register ready-made curtains: fields + up to 20 photos + 1 optional video, website pictures made by AI.
 * Deployed with verify_jwt OFF: sign-in is its own (auth.ts, approved emails only, header x-rc-session), anon has no grants anywhere and this
 * function writes with the service role. While rc_settings.login_required is not 'on', start / finish / create_image / feedback also work
 * without a session (roll-out of the login); everything else always needs one.
 *
 *   POST {action:"start",  submission_id, ref, curtain_type, ..., curtains:[{width_cm,height_cm,quantity,height_variation}] (1-20),
 *                        photos:[{type,size}], video:{type,size}|null}
 *        -> {ok, ref, uploads:[{letter,file_name,kind,url}]}   (one-time signed upload URLs into Storage)
 *   POST {action:"finish", ref, submission_id}
 *        -> {ok, ref, files}  (checks every file really arrived, marks the registration complete, starts Drive copy)
 *   POST {action:"create_image", style, opacity, tieback, shot, photo:{data}, feedback?, previous?:{data}}  -> {image(base64), mime, label, faults}
 *        one Gemini picture per call (see images.ts + rules.json); the colour comes only from `photo`; limited per person and per day
 *   POST {action:"feedback", audio:{data,mime}|text, pictures:[{id,label,kind}], style, opacity, tieback}  -> what to change in which picture
 *   POST {action:"approve_start" | "approve_finish" | "approve_status"}  -> approved pictures to Drive "Approved images" (approve.ts)
 *   POST {action:"login" | "setup_info" | "setup" | "me" | "logout" | "people"}  (auth.ts)
 *   POST {action:"sync"} + header x-cron-key   -> copies pending files into Google Drive folder Ready_Curtains
 *   GET  ?action=ping                          -> {ok, drive:true|false}
 *
 * Files are named <REF>_A, <REF>_B ... (photos first, the video continues the sequence). They land in the private
 * Storage bucket ready-curtains first (nothing is lost if Drive is down) and are then copied to Drive by `sync`,
 * which runs after every finish and from pg_cron. Drive uses its own Drive-only OAuth token held in Vault.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createImage, understand } from "./images.ts";
import { login, logout, people, setup, setupInfo, type Who, whoIs } from "./auth.ts";
import { approvalFolder, approveFinish, approveStart, approveStatus } from "./approve.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "ready-curtains";
const DRIVE_FOLDER_NAME = "Ready_Curtains", APPROVED_FOLDER_NAME = "Approved images";
const GAPI = Deno.env.get("GOOGLE_BASE") || "https://www.googleapis.com", GOAUTH = Deno.env.get("GOOGLE_BASE") || "https://oauth2.googleapis.com";   // GOOGLE_BASE: local tests only
const MAX_PHOTOS = 20, MAX_PHOTO_BYTES = 15 * 1024 * 1024, MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const MAX_CURTAINS = 20;
const MAX_BODY = 100_000;
const MAX_IMAGE_BODY = 4_500_000;      // create_image carries the fabric photo and, for a change, the picture; feedback carries a recording
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/3gpp": "3gp", "video/x-m4v": "m4v",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info, x-cron-key, x-rc-session",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class Bad extends Error {
  status: number; extra: any = null;
  constructor(m: string, status = 400) { super(m); this.status = status; }
}

const H = { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY };

async function rest(path: string, init: RequestInit & { prefer?: string } = {}): Promise<any> {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: init.method || "GET",
    headers: { ...H, "Content-Type": "application/json", ...(init.prefer ? { Prefer: init.prefer } : {}) },
    body: init.body,
  });
  const text = await r.text();
  if (!r.ok) {
    let code = ""; try { code = JSON.parse(text).code; } catch { /* ignore */ }
    console.error("rest", path.slice(0, 80), r.status, text.slice(0, 400));
    const e: any = new Error("db " + r.status); e.pg = code; throw e;
  }
  return text ? JSON.parse(text) : null;
}

// ---------- input cleaning ----------
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const opt = (v: unknown, max: number) => clean(v, max) || null;
function num(v: unknown, label: string, min: number, max: number): number {
  const n = Number(String(v ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n < min || n > max) throw new Bad(label + " is not a valid number");
  return Math.round(n * 100) / 100;
}
const CHOICES = {
  curtain_type: ["American", "Wave", "Eyelet", "Others"],
  bottom_finish: ["Lead band", "Hemming"],
  fabric_kind: ["Blackout", "Semi-blackout", "Sheer"],
};
function pick(v: unknown, list: string[], label: string): string {
  const s = clean(v, 40);
  const hit = list.find((x) => x.toLowerCase() === s.toLowerCase());
  if (!hit) throw new Bad("Please choose " + label);
  return hit;
}
function normRef(v: unknown): string {
  const ref = clean(v, 60).replace(/\s+/g, "-").toUpperCase();
  if (!ref) throw new Bad("Reference number is required");
  if (!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(ref)) throw new Bad("Reference number can only use letters, digits, - _ . (max 40)");
  return ref;
}
const normSid = (v: unknown) => {
  const s = clean(v, 80);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(s)) throw new Bad("Bad request");
  return s;
};

// ---------- storage ----------
const objectPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
async function signUpload(path: string): Promise<string> {
  const r = await fetch(SUPABASE_URL + "/storage/v1/object/upload/sign/" + BUCKET + "/" + objectPath(path), {
    method: "POST", headers: { ...H, "Content-Type": "application/json", "x-upsert": "true" }, body: "{}",
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.url) { console.error("sign", r.status, JSON.stringify(j)); throw new Error("sign failed"); }
  return SUPABASE_URL + "/storage/v1" + j.url;
}
async function listFiles(prefix: string): Promise<Map<string, number>> {
  const r = await fetch(SUPABASE_URL + "/storage/v1/object/list/" + BUCKET, {
    method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ prefix, limit: 100 }),
  });
  const listed: any[] = r.ok ? await r.json() : [];
  return new Map(listed.map((o) => [o.name, Number(o.metadata?.size) || 0]));
}

// ---------- start ----------
async function start(b: any, who: Who | null): Promise<Response> {
  const ref = normRef(b.ref), sid = normSid(b.submission_id);
  const curtain_type = pick(b.curtain_type, CHOICES.curtain_type, "a curtain type");
  const type_other = curtain_type === "Others" ? clean(b.type_other, 80) : "";
  if (curtain_type === "Others" && !type_other) throw new Bad("Please describe the curtain type");
  const row = {
    ref, submission_id: sid, curtain_type, type_other: type_other || null,
    order_no: opt(b.order_no, 40), window_no: opt(b.window_no, 40), fabric_no: opt(b.fabric_no, 60),
    colour: clean(b.colour, 60), condition: clean(b.condition, 120),
    bottom_finish: pick(b.bottom_finish, CHOICES.bottom_finish, "lead band or hemming"),
    fabric_kind: pick(b.fabric_kind, CHOICES.fabric_kind, "a fabric"),
    rack_no: clean(b.rack_no, 40),
    tieback: pick(b.tieback || "No tie back", ["No tie back", "Velcro tie back", "Hook style tie back"], "a tie back option"),
    photo_count: 0, has_video: false, curtain_count: 1, total_quantity: 1, registered_by: who?.email ?? null,
  };
  if (!row.colour) throw new Bad("Colour is required");
  if (!row.condition) throw new Bad("Condition is required");
  if (!row.rack_no) throw new Bad("Rack number is required");

  // one or more curtain sizes under this reference (an old cached page sends the single-size fields instead)
  const rawCurtains = Array.isArray(b.curtains) && b.curtains.length
    ? b.curtains : [{ width_cm: b.width_cm, height_cm: b.height_cm, quantity: b.quantity }];
  if (rawCurtains.length > MAX_CURTAINS) throw new Bad("Maximum " + MAX_CURTAINS + " curtains per reference");
  const seen = new Set<string>();
  const curtains = rawCurtains.map((c: any, i: number) => {
    const label = LETTERS[i];
    const item = {
      item_no: i + 1, label,
      width_cm: num(c?.width_cm, "Width of curtain " + label, 1, 1999),
      height_cm: num(c?.height_cm, "Height of curtain " + label, 1, 999),
      quantity: Math.round(num(c?.quantity, "Quantity of curtain " + label, 1, 9999)),
      height_variation: opt(c?.height_variation, 60),
    };
    const key = item.width_cm + "x" + item.height_cm + "|" + (item.height_variation || "").toLowerCase();
    if (seen.has(key)) throw new Bad("Curtain " + label + " has the same size as an earlier curtain - raise that quantity instead");
    seen.add(key);
    return item;
  });
  row.curtain_count = curtains.length;
  row.total_quantity = curtains.reduce((a: number, c: { quantity: number }) => a + c.quantity, 0);

  const photos = Array.isArray(b.photos) ? b.photos : [];
  if (photos.length < 1) throw new Bad("Please add at least one photo");
  if (photos.length > MAX_PHOTOS) throw new Bad("Maximum " + MAX_PHOTOS + " photos");
  const video = b.video && typeof b.video === "object" ? b.video : null;
  const items: { letter: string; kind: "photo" | "video"; mime: string; size: number; ext: string }[] = [];
  photos.forEach((p: any, i: number) => {
    const mime = clean(p?.type, 40).toLowerCase(), size = Number(p?.size) || 0;
    if (!mime.startsWith("image/") || !EXT[mime]) throw new Bad("Photo " + (i + 1) + " is not a supported image (use JPG, PNG, WEBP or HEIC)");
    if (size <= 0 || size > MAX_PHOTO_BYTES) throw new Bad("Photo " + (i + 1) + " is too large (max 15 MB)");
    items.push({ letter: LETTERS[i], kind: "photo", mime, size, ext: EXT[mime] });
  });
  if (video) {
    const mime = clean(video.type, 40).toLowerCase(), size = Number(video.size) || 0;
    if (!mime.startsWith("video/") || !EXT[mime]) throw new Bad("The video format is not supported (use MP4 or MOV)");
    if (size <= 0 || size > MAX_VIDEO_BYTES) throw new Bad("The video is too large (max 150 MB)");
    items.push({ letter: LETTERS[photos.length], kind: "video", mime, size, ext: EXT[mime] });
  }
  row.photo_count = photos.length; row.has_video = !!video;

  // same reference again?
  const prev = await rest("ready_curtains?select=id,submission_id,status&ref=eq." + encodeURIComponent(ref));
  if (prev && prev.length) {
    if (prev[0].submission_id !== sid) throw new Bad("Reference " + ref + " is already registered. Use a different reference number.", 409);
    if (prev[0].status === "complete") return json({ ok: true, ref, done: true, uploads: [] });
    await rest("ready_curtains?id=eq." + prev[0].id, { method: "DELETE" });          // unfinished earlier try: start clean
  }
  try {
    await rest("ready_curtains", { method: "POST", body: JSON.stringify(row), prefer: "return=minimal" });
  } catch (e: any) {
    if (e.pg === "23505") throw new Bad("Reference " + ref + " is already registered. Use a different reference number.", 409);
    throw e;
  }
  try {
    await rest("ready_curtain_items", { method: "POST", body: JSON.stringify(curtains.map((c: any) => ({ ref, ...c }))), prefer: "return=minimal" });
  } catch (e) {
    await rest("ready_curtains?ref=eq." + encodeURIComponent(ref), { method: "DELETE" }).catch(() => {});   // no half-registered reference
    throw e;
  }
  const files = items.map((it) => {
    const file_name = ref + "_" + it.letter + "." + it.ext;
    return { ref, letter: it.letter, kind: it.kind, file_name, storage_path: ref + "/" + file_name, mime: it.mime, size_bytes: it.size };
  });
  await rest("ready_curtain_files", { method: "POST", body: JSON.stringify(files), prefer: "return=minimal" });

  const uploads = await Promise.all(files.map(async (f) => ({ letter: f.letter, file_name: f.file_name, kind: f.kind, url: await signUpload(f.storage_path) })));
  return json({ ok: true, ref, uploads });
}

// ---------- finish ----------
async function finish(b: any): Promise<Response> {
  const ref = normRef(b.ref), sid = normSid(b.submission_id);
  const reg = await rest("ready_curtains?select=id,submission_id,status,photo_count,has_video&ref=eq." + encodeURIComponent(ref));
  if (!reg?.length || reg[0].submission_id !== sid) throw new Bad("Registration not found - please submit again", 404);
  const files: any[] = await rest("ready_curtain_files?select=id,file_name,size_bytes&ref=eq." + encodeURIComponent(ref) + "&order=letter");
  const have = await listFiles(ref);
  const missing = files.filter((f) => !have.has(f.file_name)).map((f) => f.file_name);
  if (missing.length) return json({ error: "Some files did not arrive", missing }, 409);
  await rest("ready_curtain_files?ref=eq." + encodeURIComponent(ref) + "&uploaded_at=is.null", {
    method: "PATCH", body: JSON.stringify({ uploaded_at: new Date().toISOString() }), prefer: "return=minimal",
  });
  await rest("ready_curtains?id=eq." + reg[0].id, {
    method: "PATCH", body: JSON.stringify({ status: "complete", completed_at: new Date().toISOString() }), prefer: "return=minimal",
  });
  // @ts-ignore EdgeRuntime is provided by the Supabase runtime
  EdgeRuntime.waitUntil(syncDrive().catch((e) => console.error("sync after finish", e)));
  return json({ ok: true, ref, files: files.length });
}

// ---------- Google Drive ----------
async function secret(name: string): Promise<string | null> {
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/fn_rc_secret", {
    method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ p_name: name }),
  });
  if (!r.ok) return null;
  const v = await r.json();
  return typeof v === "string" && v ? v : null;
}

async function accessToken(): Promise<string | null> {
  const raw = await secret("ready_curtains_drive_token");
  if (!raw) return null;
  const t = JSON.parse(raw);
  const r = await fetch(GOAUTH + "/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret, refresh_token: t.refresh_token, grant_type: "refresh_token" }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.access_token) throw new Error("Drive token refresh failed: " + (j?.error || r.status));
  return j.access_token;
}

async function gd(tok: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { Authorization: "Bearer " + tok, ...(init.headers || {}) } });
}

/** A folder in My Drive made by this app (drive.file scope), remembered in rc_settings, created once. */
async function rootFolder(tok: string, key: string, name: string): Promise<string> {
  const saved = await rest("rc_settings?select=value&key=eq." + key);
  if (saved?.length) {
    const r = await gd(tok, GAPI + "/drive/v3/files/" + saved[0].value + "?fields=id,trashed");
    if (r.ok) { const j = await r.json(); if (!j.trashed) return saved[0].value; } else await r.body?.cancel();
  }
  const q = encodeURIComponent("name = '" + name + "' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false");
  const lr = await gd(tok, GAPI + "/drive/v3/files?spaces=drive&fields=files(id)&q=" + q);
  const found = lr.ok ? (await lr.json()).files || [] : [];
  let id: string = found[0]?.id;
  let created = false;
  if (!id) {
    const cr = await gd(tok, GAPI + "/drive/v3/files?fields=id", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: ["root"] }),
    });
    if (!cr.ok) throw new Error("Could not create the Drive folder: " + cr.status);
    id = (await cr.json()).id; created = true;
  }
  if (saved?.length) {                                                     // the remembered folder was deleted: remember the new one
    await rest("rc_settings?key=eq." + key, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ value: id }) });
    return id;
  }
  // first writer wins, so two runs at once never leave two folders
  const won = await rest("rc_settings?on_conflict=key", {
    method: "POST", prefer: "resolution=ignore-duplicates,return=representation",
    body: JSON.stringify({ key, value: id }),
  });
  if (won && won.length) return id;
  if (created) await gd(tok, GAPI + "/drive/v3/files/" + id, { method: "DELETE" });
  const now = await rest("rc_settings?select=value&key=eq." + key);
  return now[0].value;
}

const CHUNK = 8 * 1024 * 1024;                       // multiple of 256 KiB, as Drive requires

async function copyToDrive(tok: string, folder: string, f: any): Promise<string> {
  // already there (a retry after a half-finished run)?
  const q = encodeURIComponent("name = '" + f.file_name.replace(/'/g, "\\'") + "' and '" + folder + "' in parents and trashed = false");
  const lr = await gd(tok, GAPI + "/drive/v3/files?spaces=drive&fields=files(id)&q=" + q);
  if (lr.ok) { const hit = (await lr.json()).files?.[0]; if (hit) return hit.id; } else await lr.body?.cancel();

  const src = SUPABASE_URL + "/storage/v1/object/" + BUCKET + "/" + f.storage_path.split("/").map(encodeURIComponent).join("/");
  const head = await fetch(src, { method: "HEAD", headers: H });
  const total = Number(head.headers.get("content-length")) || 0;
  if (!head.ok || !total) throw new Error("file not found in Storage (" + head.status + ")");
  const mime = f.mime || "application/octet-stream";

  const init = await gd(tok, GAPI + "/upload/drive/v3/files?uploadType=resumable&fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(total) },
    body: JSON.stringify({ name: f.file_name, parents: [folder], mimeType: mime }),
  });
  const sess = init.headers.get("location");
  if (!init.ok || !sess) throw new Error("Drive refused the upload (" + init.status + ")");
  await init.body?.cancel();

  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total) - 1;
    const part = await fetch(src, { headers: { ...H, Range: "bytes=" + start + "-" + end } });
    if (!part.ok && part.status !== 206) throw new Error("Storage read failed (" + part.status + ")");
    const buf = new Uint8Array(await part.arrayBuffer());
    const put = await fetch(sess, {
      method: "PUT", body: buf,
      headers: { "Content-Length": String(buf.length), "Content-Range": "bytes " + start + "-" + (start + buf.length - 1) + "/" + total },
    });
    if (put.status === 308) { await put.body?.cancel(); continue; }
    if (put.ok) { const j = await put.json(); return j.id; }
    throw new Error("Drive upload failed (" + put.status + "): " + (await put.text()).slice(0, 200));
  }
  throw new Error("Drive upload did not complete");
}

let syncing = false;
async function syncDrive(budgetMs = 110_000): Promise<{ drive: boolean; copied: number; failed: number; left?: number }> {
  if (syncing) return { drive: true, copied: 0, failed: 0 };
  syncing = true;
  try {
    const tok = await accessToken();
    if (!tok) return { drive: false, copied: 0, failed: 0 };
    const t0 = Date.now();
    let copied = 0, failed = 0, folder = "", approvedRoot = "";
    const folderFor = async (table: string, f: any): Promise<string> => {
      if (table === "ready_curtain_files") return folder ||= await rootFolder(tok, "drive_folder_id", DRIVE_FOLDER_NAME);
      approvedRoot ||= await rootFolder(tok, "approved_folder_id", APPROVED_FOLDER_NAME);
      const ap = (await rest("rc_approvals?select=*&id=eq." + f.approval_id))[0];
      return approvalFolder(ap, approvedRoot, (path, init) => gd(tok, GAPI + path, init), { rest });
    };
    for (const table of ["ready_curtain_files", "rc_approved_files"]) {
      while (Date.now() - t0 < budgetMs) {
        const stale = new Date(Date.now() - 6 * 60_000).toISOString();
        const rows: any[] = await rest(table + "?select=*&uploaded_at=not.is.null&drive_synced_at=is.null" +
          "&or=(drive_claimed_at.is.null,drive_claimed_at.lt." + stale + ")&order=id&limit=1");
        if (!rows.length) break;
        const f = rows[0];
        // claim it (atomic: only one run gets the row back)
        const claimed = await rest(table + "?id=eq." + f.id + "&drive_synced_at=is.null" +
          "&or=(drive_claimed_at.is.null,drive_claimed_at.lt." + stale + ")", {
          method: "PATCH", prefer: "return=representation", body: JSON.stringify({ drive_claimed_at: new Date().toISOString() }),
        });
        if (!claimed?.length) continue;
        try {
          const id = await copyToDrive(tok, await folderFor(table, f), f);
          await rest(table + "?id=eq." + f.id, {
            method: "PATCH", prefer: "return=minimal",
            body: JSON.stringify({ drive_file_id: id, drive_synced_at: new Date().toISOString(), drive_error: null }),
          });
          copied++;
        } catch (e: any) {
          console.error("drive copy", f.file_name, e?.message);
          failed++;
          await rest(table + "?id=eq." + f.id, {
            method: "PATCH", prefer: "return=minimal",
            // keep the claim for 6 minutes so one bad file does not block the queue; cron retries it later
            body: JSON.stringify({ drive_error: String(e?.message || e).slice(0, 300) }),
          });
        }
      }
    }
    return { drive: true, copied, failed };
  } finally { syncing = false; }
}

// ---------- entry ----------
let loginFlag: { on: boolean; until: number } | null = null;
/** rc_settings.login_required = 'on' closes the page to everyone who is not signed in. A read error counts as 'on'. */
async function loginRequired(): Promise<boolean> {
  if (loginFlag && loginFlag.until > Date.now()) return loginFlag.on;
  try {
    const r = await rest("rc_settings?select=value&key=eq.login_required");
    loginFlag = { on: r?.[0]?.value === "on", until: Date.now() + 15_000 };
    return loginFlag.on;
  } catch { return true; }
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method === "GET") {
      const action = new URL(req.url).searchParams.get("action") || "ping";
      if (action === "ping") return json({ ok: true, drive: !!(await secret("ready_curtains_drive_token")), login: await loginRequired() });
      return json({ error: "Unknown action" }, 400);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const raw = await req.text();
    if (raw.length > MAX_IMAGE_BODY) return json({ error: "Request too large" }, 413);
    let b: any; try { b = JSON.parse(raw); } catch { return json({ error: "Bad request" }, 400); }
    const big = b.action === "create_image" || b.action === "feedback";
    if (!big && raw.length > MAX_BODY) return json({ error: "Request too large" }, 413);

    if (b.action === "sync") {
      const key = await secret("ready_curtains_cron_key");
      if (!key || req.headers.get("x-cron-key") !== key) return json({ error: "Not allowed" }, 403);
      return json({ ok: true, ...(await syncDrive()) });
    }

    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown", core = { rest, Bad, ip };
    if (b.action === "login") return json({ ok: true, ...(await login(b, core)) });
    if (b.action === "setup_info") return json({ ok: true, ...(await setupInfo(b, core)) });
    if (b.action === "setup") return json({ ok: true, ...(await setup(b, core)) });

    const token = req.headers.get("x-rc-session"), who = await whoIs(token, core);
    const OPEN_UNTIL_ON = ["start", "finish", "create_image", "feedback"];
    if (!who && (!OPEN_UNTIL_ON.includes(b.action) || await loginRequired())) throw new Bad("Please sign in.", 401);

    const ctx = { rest, secret, url: SUPABASE_URL, H, Bad, ip, email: who?.email ?? null };
    if (b.action === "create_image") return json({ ok: true, ...(await createImage(b, ctx)) });
    if (b.action === "feedback") return json({ ok: true, ...(await understand(b, ctx)) });
    if (b.action === "start") return await start(b, who);
    if (b.action === "finish") return await finish(b);
    if (b.action === "me") return json({ ok: true, me: who });
    if (b.action === "logout") return json({ ok: true, ...(await logout(token, core)) });
    if (b.action === "people") return json({ ok: true, ...(await people(b, who!, core)) });
    const deps = { rest, Bad, sign: signUpload, list: listFiles, normRef, bucket: BUCKET };
    if (b.action === "approve_start") return json({ ok: true, ...(await approveStart(b, who!, deps)) });
    if (b.action === "approve_finish") {
      const out = await approveFinish(b, who!, deps);
      // @ts-ignore EdgeRuntime is provided by the Supabase runtime
      EdgeRuntime.waitUntil(syncDrive().catch((e) => console.error("sync after approve", e)));
      return json({ ok: true, ...out });
    }
    if (b.action === "approve_status") return json({ ok: true, ...(await approveStatus(b, deps)) });
    return json({ error: "Unknown action" }, 400);
  } catch (e: any) {
    if (e instanceof Bad) return json({ error: e.message, ...(e.extra || {}) }, e.status);
    console.error("ready-curtains", e?.message || e);
    return json({ error: "Something went wrong on the server. Please try again." }, 500);
  }
});
