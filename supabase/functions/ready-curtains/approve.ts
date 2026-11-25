/* approve.ts - "Approve images" of ready-curtains.html (25 Nov 2026).
 *
 * The approved pictures go, like the photos, through private Storage first (nothing is lost if Drive is down) and are then copied by the same
 * sync into Google Drive:  My Drive / Approved images / <REF> / <REF>_A.jpg, <REF>_B.jpg ...   (folder name = reference number, letters as for the photos)
 * Approving the same reference again never overwrites: the earlier folder is renamed "<REF> (replaced <date time>)" and a fresh <REF> folder is filled.
 */
import type { Who } from "./auth.ts";

// deno-lint-ignore-file no-explicit-any
export type Deps = {
  rest: (path: string, init?: any) => Promise<any>;
  Bad: new (m: string, s?: number) => Error;
  sign: (path: string) => Promise<string>;
  list: (prefix: string) => Promise<Map<string, number>>;
  normRef: (v: unknown) => string;
  bucket: string;
};
const MAX_PICTURES = 20, MAX_BYTES = 6 * 1024 * 1024, LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const q = encodeURIComponent;
const text = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);

export async function approveStart(b: any, me: Who, d: Deps): Promise<any> {
  const ref = d.normRef(b.ref), pics = Array.isArray(b.pictures) ? b.pictures : [];
  if (!pics.length) throw new d.Bad("There are no pictures to approve.");
  if (pics.length > MAX_PICTURES) throw new d.Bad("Maximum " + MAX_PICTURES + " pictures.");
  const earlier = (await d.rest("rc_approvals?select=id,approved_by,completed_at,picture_count&ref=eq." + q(ref) + "&status=eq.complete&replaced_at=is.null&order=id.desc&limit=1"))?.[0];
  if (earlier && !b.replace) {
    const e: any = new d.Bad(ref + " already has " + earlier.picture_count + " approved pictures.", 409);
    e.extra = { exists: { by: earlier.approved_by, at: earlier.completed_at, pictures: earlier.picture_count } };
    throw e;
  }
  pics.forEach((p: any, i: number) => { const s = Number(p?.size) || 0; if (s <= 0 || s > MAX_BYTES) throw new d.Bad("Picture " + (i + 1) + " cannot be saved (size)."); });
  const ap = (await d.rest("rc_approvals", { method: "POST", prefer: "return=representation",
    body: JSON.stringify({ ref, picture_count: pics.length, approved_by: me.email, version: Math.max(1, Math.min(99, Number(b.version) || 1)) }) }))[0];
  const files = pics.map((p: any, i: number) => {
    const file_name = ref + "_" + LETTERS[i] + ".jpg";
    return { approval_id: ap.id, ref, letter: LETTERS[i], file_name, storage_path: "_approved/" + ref + "/" + ap.id + "/" + file_name,
      shot: text(p?.id, 30) || null, label: text(p?.label, 80) || null, kind: p?.kind === "photo" ? "photo" : "ai", size_bytes: Number(p.size) };
  });
  await d.rest("rc_approved_files", { method: "POST", prefer: "return=minimal", body: JSON.stringify(files) });
  const uploads = await Promise.all(files.map(async (f: any) => ({ letter: f.letter, file_name: f.file_name, url: await d.sign(f.storage_path) })));
  return { approval_id: ap.id, ref, uploads };
}

async function mine(b: any, d: Deps): Promise<any> {
  const id = Number(b.approval_id);
  const ap = Number.isInteger(id) && id > 0 ? (await d.rest("rc_approvals?select=*&id=eq." + id))?.[0] : null;
  if (!ap) throw new d.Bad("Approval not found - please approve again.", 404);
  return ap;
}

export async function approveFinish(b: any, me: Who, d: Deps): Promise<any> {
  const ap = await mine(b, d);
  if (ap.approved_by !== me.email) throw new d.Bad("Approval not found - please approve again.", 404);
  if (ap.status !== "complete") {
    const files: any[] = await d.rest("rc_approved_files?select=file_name&approval_id=eq." + ap.id + "&order=letter");
    const have = await d.list("_approved/" + ap.ref + "/" + ap.id);
    const missing = files.map((f) => f.file_name).filter((n) => !have.has(n));
    if (missing.length) { const e: any = new d.Bad("Some pictures did not arrive. Please try again.", 409); e.extra = { missing }; throw e; }
    const now = new Date().toISOString();
    await d.rest("rc_approvals?ref=eq." + q(ap.ref) + "&status=eq.complete&replaced_at=is.null&id=neq." + ap.id, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ replaced_at: now }) });
    await d.rest("rc_approved_files?approval_id=eq." + ap.id + "&uploaded_at=is.null", { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ uploaded_at: now }) });
    await d.rest("rc_approvals?id=eq." + ap.id, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: "complete", completed_at: now }) });
  }
  return { ref: ap.ref, files: ap.picture_count };
}

export async function approveStatus(b: any, d: Deps): Promise<any> {
  const ap = await mine(b, d);
  const files: any[] = await d.rest("rc_approved_files?select=drive_synced_at,drive_error&approval_id=eq." + ap.id);
  const saved = files.filter((f) => f.drive_synced_at).length;
  return { ref: ap.ref, status: ap.status, total: files.length, saved, waiting: files.some((f) => f.drive_error && !f.drive_synced_at),
    folder: ap.drive_folder_id ? "https://drive.google.com/drive/folders/" + ap.drive_folder_id : null };
}

// ---------- Google Drive (called from syncDrive) ----------
const stamp = (iso: string) => new Date(new Date(iso).getTime() + 4 * 3600_000).toISOString().slice(0, 16).replace("T", " ").replace(":", ".");   // Dubai time

/** Folder of this approval inside "Approved images", created once. */
export async function approvalFolder(ap: any, root: string, gd: (path: string, init?: any) => Promise<Response>, d: Pick<Deps, "rest">): Promise<string> {
  if (ap.drive_folder_id) return ap.drive_folder_id;
  for (const old of await d.rest("rc_approvals?select=id,drive_folder_id,replaced_at&ref=eq." + q(ap.ref) + "&id=lt." + ap.id + "&drive_folder_id=not.is.null&drive_renamed=is.false&replaced_at=not.is.null")) {
    const r = await gd("/drive/v3/files/" + old.drive_folder_id + "?fields=id", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ap.ref + " (replaced " + stamp(old.replaced_at) + ")" }) });
    await r.body?.cancel();
    if (r.ok || r.status === 404) await d.rest("rc_approvals?id=eq." + old.id, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ drive_renamed: true }) });
    else throw new Error("Could not set the earlier folder aside (" + r.status + ")");
  }
  const cr = await gd("/drive/v3/files?fields=id", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: ap.ref, mimeType: "application/vnd.google-apps.folder", parents: [root] }) });
  if (!cr.ok) throw new Error("Could not create the reference folder (" + cr.status + ")");
  const id = (await cr.json()).id;
  const won = await d.rest("rc_approvals?id=eq." + ap.id + "&drive_folder_id=is.null", { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ drive_folder_id: id }) });
  if (won?.length) return id;
  await gd("/drive/v3/files/" + id, { method: "DELETE" });               // another run was first: drop our empty folder
  return (await d.rest("rc_approvals?select=drive_folder_id&id=eq." + ap.id))[0].drive_folder_id;
}
