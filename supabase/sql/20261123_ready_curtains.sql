-- Ready-made curtains register, fed from the public page ready-curtains.html (23 Nov 2026).
-- No login: the page talks only to the edge function ready-curtains (verify_jwt off), which writes with the
-- service role. anon gets nothing (see the anon definer-view leak). Photos / videos are uploaded to the private
-- Storage bucket ready-curtains first, then copied by the same function into the Google Drive folder
-- Ready_Curtains as <reference>_A, <reference>_B ... (drive_* columns say what has been copied).

create table if not exists public.ready_curtains (
  id             bigint generated always as identity primary key,
  ref            text not null unique,                 -- reference number typed by the user; names every file
  submission_id  text not null,                       -- idempotency: a retry of the same submit is not a duplicate
  curtain_type   text not null check (curtain_type in ('American','Wave','Eyelet','Others')),
  type_other     text,                                 -- free text when curtain_type = 'Others'
  order_no       text,
  window_no      text,
  fabric_no      text,
  height_cm      numeric not null check (height_cm > 0 and height_cm < 1000),
  width_cm       numeric not null check (width_cm > 0 and width_cm < 2000),
  quantity       integer not null check (quantity > 0 and quantity < 10000),
  colour         text not null,
  condition      text not null,
  bottom_finish  text not null check (bottom_finish in ('Lead band','Hemming')),
  fabric_kind    text not null check (fabric_kind in ('Blackout','Semi-blackout','Sheer')),
  rack_no        text not null,
  photo_count    integer not null default 0 check (photo_count between 0 and 20),
  has_video      boolean not null default false,
  status         text not null default 'uploading' check (status in ('uploading','complete')),
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);
create index if not exists ready_curtains_created_idx on public.ready_curtains (created_at desc);
create index if not exists ready_curtains_order_idx on public.ready_curtains (order_no) where order_no is not null;

create table if not exists public.ready_curtain_files (
  id              bigint generated always as identity primary key,
  ref             text not null references public.ready_curtains(ref) on delete cascade,
  letter          text not null,                       -- A, B, C ... (video continues the sequence)
  kind            text not null check (kind in ('photo','video')),
  file_name       text not null,                       -- <ref>_<letter>.<ext>, the name used in Drive
  storage_path    text not null,                       -- path inside bucket ready-curtains
  mime            text,
  size_bytes      bigint,
  uploaded_at     timestamptz,                         -- set by finish, once the object is confirmed in Storage
  drive_file_id   text,
  drive_synced_at timestamptz,
  drive_error     text,
  unique (ref, letter)
);
create index if not exists ready_curtain_files_pending_idx on public.ready_curtain_files (id)
  where uploaded_at is not null and drive_synced_at is null;

alter table public.ready_curtains enable row level security;
alter table public.ready_curtain_files enable row level security;
revoke all on public.ready_curtains, public.ready_curtain_files from anon;
grant select on public.ready_curtains, public.ready_curtain_files to authenticated;
drop policy if exists ready_curtains_read on public.ready_curtains;
create policy ready_curtains_read on public.ready_curtains for select to authenticated using (true);
drop policy if exists ready_curtain_files_read on public.ready_curtain_files;
create policy ready_curtain_files_read on public.ready_curtain_files for select to authenticated using (true);

-- Private bucket: the page uploads through one-time signed upload URLs minted by the edge function.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ready-curtains', 'ready-curtains', false, 157286400,
        array['image/jpeg','image/png','image/webp','image/heic','image/heif',
              'video/mp4','video/quicktime','video/webm','video/3gpp','video/x-m4v'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Drive credentials live in Vault; only the service role may read them through this helper.
create or replace function public.fn_rc_secret(p_name text)
returns text language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = p_name and p_name in ('ready_curtains_drive_token','ready_curtains_cron_key') limit 1
$$;
revoke all on function public.fn_rc_secret(text) from public, anon, authenticated;
grant execute on function public.fn_rc_secret(text) to service_role;

-- Added the same day (migration "ready_curtains_drive_columns"): a claim marker so two sync runs never copy the
-- same file, and a tiny settings table that remembers the Drive folder id (so Ready_Curtains is created once).
alter table public.ready_curtain_files add column if not exists drive_claimed_at timestamptz;
create table if not exists public.rc_settings (
  key   text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.rc_settings enable row level security;
revoke all on public.rc_settings from anon, authenticated;

-- Migration "ready_curtains_secret_and_sync_helpers": store Vault secrets without the value passing through chat,
-- and the pg_cron entry point that asks the edge function to copy pending files into Drive.
create or replace function public.fn_rc_set_secret(p_name text, p_value text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  if p_name not in ('ready_curtains_drive_token','ready_curtains_cron_key') then raise exception 'unknown secret'; end if;
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then perform vault.create_secret(p_value, p_name, 'Ready-made curtains page');
  else perform vault.update_secret(v_id, p_value, p_name); end if;
end $$;
revoke all on function public.fn_rc_set_secret(text,text) from public, anon, authenticated;
grant execute on function public.fn_rc_set_secret(text,text) to service_role;

create or replace function public.fn_rc_run_sync()
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_key text; v_req bigint;
begin
  v_key := public.fn_rc_secret('ready_curtains_cron_key');
  if v_key is null then return null; end if;
  select net.http_post(
    url := 'https://jrevqijbzzwdcwxcnwfa.supabase.co/functions/v1/ready-curtains',
    body := '{"action":"sync"}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key', v_key),
    timeout_milliseconds := 145000) into v_req;
  return v_req;
end $$;
revoke all on function public.fn_rc_run_sync() from public, anon, authenticated;

-- cron (every 2 minutes), scheduled after the Drive token was stored:
-- select cron.schedule('handpicked-ready-curtains-sync', '*/2 * * * *', 'select public.fn_rc_run_sync()');

-- 24 Nov 2026, migration "ready_curtains_multi_size": one reference can hold several curtain sizes.
-- ready_curtains lost height_cm / width_cm / quantity (moved to ready_curtain_items, existing rows copied as Curtain A)
-- and gained curtain_count / total_quantity.
create table if not exists public.ready_curtain_items (
  id               bigint generated always as identity primary key,
  ref              text not null references public.ready_curtains(ref) on delete cascade,
  item_no          integer not null check (item_no between 1 and 20),
  label            text not null,                       -- A, B, C ...
  width_cm         numeric not null check (width_cm > 0 and width_cm < 2000),
  height_cm        numeric not null check (height_cm > 0 and height_cm < 1000),
  height_variation text,                                -- optional, e.g. "300, 299, 298"
  quantity         integer not null check (quantity > 0 and quantity < 10000),
  unique (ref, item_no)
);
alter table public.ready_curtain_items enable row level security;
revoke all on public.ready_curtain_items from anon;
grant select on public.ready_curtain_items to authenticated;
drop policy if exists ready_curtain_items_read on public.ready_curtain_items;
create policy ready_curtain_items_read on public.ready_curtain_items for select to authenticated using (true);
insert into public.ready_curtain_items (ref, item_no, label, width_cm, height_cm, quantity)
select ref, 1, 'A', width_cm, height_cm, quantity from public.ready_curtains on conflict (ref, item_no) do nothing;
alter table public.ready_curtains add column if not exists curtain_count integer not null default 1 check (curtain_count between 1 and 20);
alter table public.ready_curtains add column if not exists total_quantity integer;
update public.ready_curtains set total_quantity = quantity where total_quantity is null;
alter table public.ready_curtains alter column total_quantity set not null;
alter table public.ready_curtains drop column height_cm, drop column width_cm, drop column quantity;
create or replace view public.v_ready_curtains with (security_invoker = true) as
select c.ref, i.label as curtain, i.width_cm, i.height_cm, i.height_variation, i.quantity,
       c.curtain_type, c.type_other, c.colour, c.fabric_kind, c.bottom_finish, c.condition,
       c.order_no, c.window_no, c.fabric_no, c.rack_no, c.photo_count, c.has_video, c.status, c.created_at
from public.ready_curtains c join public.ready_curtain_items i on i.ref = c.ref;
revoke all on public.v_ready_curtains from anon;
grant select on public.v_ready_curtains to authenticated;

-- 25 Nov 2026, migration "ready_curtains_tieback_and_image_log": tie back choice, log behind the Create images spending limit.
alter table public.ready_curtains add column if not exists tieback text not null default 'No tie back'
  check (tieback in ('No tie back','Velcro tie back','Hook style tie back'));
-- v_ready_curtains gained c.tieback as its last column; fn_rc_secret / fn_rc_set_secret also allow 'ready_curtains_gemini_key'.
create table if not exists public.rc_image_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  ip_hash text not null,
  shot text
);
create index if not exists rc_image_log_at_idx on public.rc_image_log (at desc);
create index if not exists rc_image_log_ip_idx on public.rc_image_log (ip_hash, at desc);
alter table public.rc_image_log enable row level security;
revoke all on public.rc_image_log from anon, authenticated;

-- 25 Nov 2026, migration "ready_curtains_login_feedback_approvals": sign-in for approved emails only, spoken feedback, approved pictures.
-- Own credential store on purpose: a Supabase Auth account is `authenticated` and can read about 100 ops tables. Only the edge function
-- (service role) touches these tables: RLS on, no policies, no grants for anon or authenticated.
create table if not exists public.rc_people (
  email          text primary key check (email = lower(email) and length(email) <= 120),
  name           text,
  is_admin       boolean not null default false,
  active         boolean not null default true,
  password_hash  text,                                  -- pbkdf2$iterations$salt$hash, never a password
  setup_hash     text,                                  -- SHA-256 of the one-time link code
  setup_expires  timestamptz,
  fails          integer not null default 0,
  locked_until   timestamptz,
  last_login     timestamptz,
  created_by     text,
  created_at     timestamptz not null default now()
);
create unique index if not exists rc_people_setup_idx on public.rc_people (setup_hash) where setup_hash is not null;
create table if not exists public.rc_sessions (
  token_hash  text primary key,                         -- SHA-256 of the token the browser holds
  email       text not null references public.rc_people(email) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists rc_sessions_email_idx on public.rc_sessions (email);
create table if not exists public.rc_login_log (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  what     text not null,
  email    text,
  ok       boolean not null,
  ip_hash  text
);
create index if not exists rc_login_log_fail_idx on public.rc_login_log (ip_hash, at desc) where not ok;
create table if not exists public.rc_image_feedback (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  email       text,
  ref         text,
  spoken      boolean not null default false,
  language    text,
  transcript  text,
  english     text,
  changes     jsonb
);
create table if not exists public.rc_approvals (
  id               bigint generated always as identity primary key,
  ref              text not null,
  version          integer not null default 1,
  picture_count    integer not null check (picture_count between 1 and 20),
  approved_by      text not null,
  status           text not null default 'uploading' check (status in ('uploading','complete')),
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  replaced_at      timestamptz,                         -- a later approval of the same reference took over
  drive_folder_id  text,
  drive_renamed    boolean not null default false
);
create index if not exists rc_approvals_ref_idx on public.rc_approvals (ref);
create table if not exists public.rc_approved_files (
  id               bigint generated always as identity primary key,
  approval_id      bigint not null references public.rc_approvals(id) on delete cascade,
  ref              text not null,
  letter           text not null,
  file_name        text not null,                       -- <REF>_<letter>.jpg, the name in Drive
  storage_path     text not null,
  shot             text,
  label            text,
  kind             text not null check (kind in ('ai','photo')),
  mime             text not null default 'image/jpeg',
  size_bytes       bigint,
  uploaded_at      timestamptz,
  drive_file_id    text,
  drive_synced_at  timestamptz,
  drive_claimed_at timestamptz,
  drive_error      text,
  unique (approval_id, letter)
);
create index if not exists rc_approved_files_pending_idx on public.rc_approved_files (id) where uploaded_at is not null and drive_synced_at is null;
alter table public.ready_curtains add column if not exists registered_by text;
alter table public.rc_image_log add column if not exists email text;
create index if not exists rc_image_log_email_idx on public.rc_image_log (email, at desc) where email is not null;
alter table public.rc_people enable row level security;
alter table public.rc_sessions enable row level security;
alter table public.rc_login_log enable row level security;
alter table public.rc_image_feedback enable row level security;
alter table public.rc_approvals enable row level security;
alter table public.rc_approved_files enable row level security;
revoke all on public.rc_people, public.rc_sessions, public.rc_login_log, public.rc_image_feedback, public.rc_approvals, public.rc_approved_files from anon, authenticated, public;
-- rc_settings key 'login_required' = 'on' closes the page to everyone who is not signed in (15 s cache in the function).
