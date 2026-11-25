/* auth.ts - sign-in for ready-curtains.html, only for approved email addresses (25 Nov 2026).
 *
 * Its own small credential store ON PURPOSE: a Supabase Auth account in this project is `authenticated` and can read about 100 ops tables
 * (policies "to authenticated using (true)"), so curtain staff must not get one. Nothing here is reachable except through this function
 * (service role); rc_people / rc_sessions / rc_login_log have RLS on, no policies and no grants.
 *
 *  - An admin approves an email address -> a one-time link (7 days) -> the person chooses a password. There is no open sign-up.
 *  - Passwords: PBKDF2-SHA256, per-person salt. Links and sessions: 256-bit random, only their SHA-256 is stored.
 *  - Six wrong passwords lock that email for 15 minutes; thirty wrong tries from one connection in 15 minutes are refused.
 */
import { sha256 } from "./images.ts";

// deno-lint-ignore-file no-explicit-any
export type Who = { email: string; name: string | null; admin: boolean };
export type Core = { rest: (path: string, init?: any) => Promise<any>; Bad: new (m: string, s?: number) => Error; ip: string };

const ITER = 210_000, SESSION_DAYS = 30, SETUP_DAYS = 7, MAX_FAILS = 6, LOCK_MIN = 15, IP_FAILS = 30, MIN_PW = 8;
const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const random = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const q = encodeURIComponent;
const WRONG = "The email or password is not right, or this email is not approved.";

async function derive(pw: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(pw.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as any, iterations: iter }, k, 256));
}
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64u(salt)}$${b64u(await derive(pw, salt, ITER))}`;
}
async function samePassword(pw: string, stored: string): Promise<boolean> {
  const [kind, it, salt, want] = stored.split("$");
  if (kind !== "pbkdf2") return false;
  const a = await derive(pw, unb64u(salt), Number(it)), b = unb64u(want);
  let d = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ (b[i] ?? 0);
  return d === 0;
}

export function normEmail(v: unknown, c: Core): string {
  const e = String(v ?? "").trim().toLowerCase();
  if (e.length > 120 || !/^[^@\s"'<>(),;:\\]+@[^@\s"'<>(),;:\\]+\.[a-z]{2,}$/.test(e)) throw new c.Bad("Please enter a valid email address.");
  return e;
}
function password(v: unknown, c: Core): string {
  const p = typeof v === "string" ? v : "";
  if (p.length < MIN_PW) throw new c.Bad(`The password needs at least ${MIN_PW} characters.`);
  if (p.length > 200) throw new c.Bad("The password is too long.");
  return p;
}

async function log(c: Core, what: string, email: string | null, ok: boolean) {
  await c.rest("rc_login_log", { method: "POST", prefer: "return=minimal", body: JSON.stringify({ what, email, ok, ip_hash: await sha256("rc|" + c.ip) }) })
    .catch((e: any) => console.error("login log", e?.message));
}
async function throttle(c: Core) {
  const since = q(new Date(Date.now() - LOCK_MIN * 60_000).toISOString());
  const n = await c.rest("rc_login_log?select=id&ok=is.false&ip_hash=eq." + await sha256("rc|" + c.ip) + "&at=gte." + since + "&limit=" + IP_FAILS);
  if ((n || []).length >= IP_FAILS) throw new c.Bad("Too many wrong tries. Please wait 15 minutes.", 429);
}

async function openSession(c: Core, p: any): Promise<any> {
  const token = random();
  await c.rest("rc_sessions", { method: "POST", prefer: "return=minimal", body: JSON.stringify({ token_hash: await sha256(token), email: p.email, expires_at: later(SESSION_DAYS * 86400_000) }) });
  await c.rest("rc_people?email=eq." + q(p.email), { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ fails: 0, locked_until: null, last_login: new Date().toISOString() }) });
  await c.rest("rc_sessions?expires_at=lt." + q(new Date().toISOString()), { method: "DELETE" }).catch(() => {});       // tidy up old ones
  return { session: token, me: { email: p.email, name: p.name, admin: !!p.is_admin } };
}

export async function login(b: any, c: Core): Promise<any> {
  await throttle(c);
  const email = normEmail(b.email, c), pw = typeof b.password === "string" ? b.password.slice(0, 200) : "";
  const p = (await c.rest("rc_people?select=*&email=eq." + q(email)))?.[0];
  if (p?.locked_until && new Date(p.locked_until) > new Date()) throw new c.Bad("Too many wrong passwords. Please wait 15 minutes.", 429);
  const usable = !!(p && p.active && p.password_hash);
  const ok = await samePassword(pw, usable ? p.password_hash : `pbkdf2$${ITER}$AAAAAAAAAAAAAAAAAAAAAA$AAAA`) && usable;   // same work either way
  await log(c, "login", email, ok);
  if (!ok) {
    if (usable) {
      const fails = (p.fails || 0) + 1;
      await c.rest("rc_people?email=eq." + q(email), { method: "PATCH", prefer: "return=minimal",
        body: JSON.stringify(fails >= MAX_FAILS ? { fails: 0, locked_until: later(LOCK_MIN * 60_000) } : { fails }) });
    }
    throw new c.Bad(WRONG, 401);
  }
  return openSession(c, p);
}

async function bySetupCode(code: unknown, c: Core): Promise<any> {
  await throttle(c);
  const s = String(code ?? "");
  const p = /^[A-Za-z0-9_-]{30,60}$/.test(s) ? (await c.rest("rc_people?select=*&setup_hash=eq." + await sha256("setup|" + s)))?.[0] : null;
  if (!p || !p.active || !p.setup_expires || new Date(p.setup_expires) < new Date()) {
    await log(c, "setup", null, false);
    throw new c.Bad("This link is no longer valid. Please ask for a new one.", 410);
  }
  return p;
}
export async function setupInfo(b: any, c: Core): Promise<any> {
  const p = await bySetupCode(b.code, c);
  return { email: p.email, name: p.name };
}
export async function setup(b: any, c: Core): Promise<any> {
  const p = await bySetupCode(b.code, c), pw = password(b.password, c);
  // the link works once: only the request that still finds the code clears it
  const won = await c.rest("rc_people?email=eq." + q(p.email) + "&setup_hash=eq." + p.setup_hash, { method: "PATCH", prefer: "return=representation",
    body: JSON.stringify({ password_hash: await hashPassword(pw), setup_hash: null, setup_expires: null, fails: 0, locked_until: null }) });
  if (!won?.length) throw new c.Bad("This link is no longer valid. Please ask for a new one.", 410);
  await c.rest("rc_sessions?email=eq." + q(p.email), { method: "DELETE" });                          // a new password signs out everywhere
  await log(c, "setup", p.email, true);
  return openSession(c, p);
}

export async function whoIs(token: string | null, c: Core): Promise<Who | null> {
  if (!token || !/^[A-Za-z0-9_-]{30,60}$/.test(token)) return null;
  const s = (await c.rest("rc_sessions?select=email,expires_at&token_hash=eq." + await sha256(token)))?.[0];
  if (!s || new Date(s.expires_at) < new Date()) return null;
  const p = (await c.rest("rc_people?select=email,name,is_admin,active&email=eq." + q(s.email)))?.[0];      // removing a person works at once
  return p && p.active ? { email: p.email, name: p.name, admin: !!p.is_admin } : null;
}
export async function logout(token: string | null, c: Core): Promise<any> {
  if (token) await c.rest("rc_sessions?token_hash=eq." + await sha256(token), { method: "DELETE" });
  return {};
}

// ---------- approved people (admins only) ----------
const state = (p: any) => !p.active ? "removed" : p.password_hash ? "active" : p.setup_expires && new Date(p.setup_expires) > new Date() ? "link sent" : "link expired";

async function newLink(c: Core, email: string): Promise<string> {
  const code = random();
  await c.rest("rc_people?email=eq." + q(email), { method: "PATCH", prefer: "return=minimal",
    body: JSON.stringify({ setup_hash: await sha256("setup|" + code), setup_expires: later(SETUP_DAYS * 86400_000) }) });
  return code;
}
async function admins(c: Core, except: string): Promise<number> {
  return ((await c.rest("rc_people?select=email&is_admin=is.true&active=is.true&email=neq." + q(except))) || []).length;
}

export async function people(b: any, me: Who, c: Core): Promise<any> {
  if (!me.admin) throw new c.Bad("Only an admin can do this.", 403);
  const op = String(b.op || "list");
  let code: string | null = null, email = "";
  if (op !== "list") email = normEmail(b.email, c);
  if (op === "add") {
    const name = String(b.name ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").trim().slice(0, 60) || null;
    const had = (await c.rest("rc_people?select=email,active,password_hash&email=eq." + q(email)))?.[0];
    if (had?.active) throw new c.Bad("This email is already approved.", 409);
    if (had) await c.rest("rc_people?email=eq." + q(email), { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ active: true, is_admin: !!b.admin, name, password_hash: null, fails: 0, locked_until: null }) });
    else await c.rest("rc_people", { method: "POST", prefer: "return=minimal", body: JSON.stringify({ email, name, is_admin: !!b.admin, created_by: me.email }) });
    code = await newLink(c, email);
  } else if (op === "link") {
    const had = (await c.rest("rc_people?select=email,active&email=eq." + q(email)))?.[0];
    if (!had?.active) throw new c.Bad("This email is not approved.", 404);
    code = await newLink(c, email);
  } else if (op === "remove") {
    if (email === me.email) throw new c.Bad("You cannot remove yourself.");
    if (!(await admins(c, email))) throw new c.Bad("At least one admin must stay.");
    await c.rest("rc_people?email=eq." + q(email), { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ active: false, setup_hash: null, setup_expires: null, password_hash: null }) });
    await c.rest("rc_sessions?email=eq." + q(email), { method: "DELETE" });
  } else if (op !== "list") throw new c.Bad("Unknown request.");
  const rows = await c.rest("rc_people?select=*&active=is.true&order=created_at");
  return { email, code, people: rows.map((p: any) => ({ email: p.email, name: p.name, admin: !!p.is_admin, state: state(p), last_login: p.last_login })) };
}
