/* Google Cloud Storage signed URLs for photo evidence.
 *
 * The browser never holds a GCP credential. It asks this function for a short-lived V4 signed URL
 * and then talks to Google directly - so the bytes never pass through Supabase, and the service
 * account key stays server-side.
 *
 * UNTIL THIS IS CONFIGURED, IT REPORTS ITSELF UNCONFIGURED and the app transparently falls back to
 * the private Supabase `ops-photos` bucket. Nothing breaks; photos just live elsewhere. Each row in
 * order_photos records which backend holds its bytes, so old photos keep resolving after a switch.
 *
 * Setup (run on your machine - gcloud here needs an interactive login):
 *
 *   gcloud auth login
 *   gcloud config set project handpicked-curtains
 *
 *   # private bucket, uniform access, versioning so evidence cannot be quietly overwritten
 *   gcloud storage buckets create gs://handpicked-ops-photos \
 *       --location=me-central1 --uniform-bucket-level-access --public-access-prevention
 *   gcloud storage buckets update gs://handpicked-ops-photos --versioning
 *
 *   gcloud iam service-accounts create ops-photos --display-name="Ops photo uploads"
 *   gcloud storage buckets add-iam-policy-binding gs://handpicked-ops-photos \
 *       --member=serviceAccount:ops-photos@handpicked-curtains.iam.gserviceaccount.com \
 *       --role=roles/storage.objectAdmin
 *   gcloud iam service-accounts keys create ops-photos-key.json \
 *       --iam-account=ops-photos@handpicked-curtains.iam.gserviceaccount.com
 *
 *   # one line, the whole JSON key
 *   supabase secrets set GCS_BUCKET=handpicked-ops-photos
 *   supabase secrets set GCS_SA_KEY="$(cat ops-photos-key.json)"
 *   supabase functions deploy photo-signed-url
 *
 *   # then DELETE the local key file - it is a long-lived credential
 *   rm ops-photos-key.json
 */

const BUCKET = Deno.env.get("GCS_BUCKET") ?? "";
const SA_RAW = Deno.env.get("GCS_SA_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

interface SaKey { client_email: string; private_key: string }

function serviceAccount(): SaKey | null {
  if (!BUCKET || !SA_RAW) return null;
  try {
    const k = JSON.parse(SA_RAW);
    return k.client_email && k.private_key ? k : null;
  } catch {
    return null;
  }
}

/* --- V4 signing ---------------------------------------------------------- */
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

async function sha256Hex(s: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function signRsa(privatePem: string, message: string) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privatePem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(message)));
}

/* Canonical V4 query signing, per
 * https://cloud.google.com/storage/docs/access-control/signing-urls-manually */
async function signedUrl(
  sa: SaKey, method: "GET" | "PUT", objectPath: string, expiresSec: number, contentType?: string,
) {
  const host = "storage.googleapis.com";
  const canonicalUri = "/" + BUCKET + "/" + objectPath.split("/").map(encodeURIComponent).join("/");

  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = stamp.slice(0, 8);
  const scope = `${date}/auto/storage/goog4_request`;

  const headers: Record<string, string> = { host };
  if (contentType) headers["content-type"] = contentType;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort()
    .map((h) => `${h}:${headers[h]}\n`).join("");

  const params: Record<string, string> = {
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
    "X-Goog-Credential": `${sa.client_email}/${scope}`,
    "X-Goog-Date": stamp,
    "X-Goog-Expires": String(expiresSec),
    "X-Goog-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(params).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "GOOG4-RSA-SHA256", stamp, scope, await sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = await signRsa(sa.private_key, stringToSign);
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Goog-Signature=${signature}`;
}

/* --- handler ------------------------------------------------------------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const sa = serviceAccount();

  let body: { probe?: boolean; action?: string; path?: string; contentType?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  // The app probes on first use to decide which backend is live.
  if (body.probe) return json({ configured: !!sa, bucket: sa ? BUCKET : null });

  if (!sa) {
    return json({
      error: "Google Cloud Storage is not configured on this project. " +
             "Set GCS_BUCKET and GCS_SA_KEY, or leave it unset to keep using Supabase Storage.",
      configured: false,
    }, 501);
  }

  const path = (body.path ?? "").replace(/^\/+/, "");
  if (!path) return json({ error: "No object path supplied" }, 400);
  // never let a caller escape the prefix it was handed
  if (path.includes("..")) return json({ error: "Invalid object path" }, 400);

  try {
    if (body.action === "upload") {
      const url = await signedUrl(sa, "PUT", path, 300, body.contentType || "image/jpeg");
      return json({ url, backend: "gcs", bucket: BUCKET, expiresIn: 300 });
    }
    if (body.action === "view") {
      const url = await signedUrl(sa, "GET", path, 600);
      return json({ url, backend: "gcs", bucket: BUCKET, expiresIn: 600 });
    }
    return json({ error: "action must be 'upload' or 'view'" }, 400);
  } catch (e) {
    console.error("signing failed", e);
    return json({ error: "Could not sign the request" }, 500);
  }
});
