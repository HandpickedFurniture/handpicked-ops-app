-- Punctuality (#/punctuality). 18 Nov 2026 (user).
--
-- How early or late each installation team arrives against the time it was scheduled for, overall and by
-- vertical (Kurtains / Floorz), city and team, as Punctuality30 (arrived within 30 min of the scheduled
-- time) and Punctuality60 (within 60 min), for ALL orders and for each team's FIRST order of the day.
--
--   Google Sheet (a Tookan export, one tab per vertical + city; tabs listed in punctuality_source)
--     -> punctuality-sync (Edge Function; pg_cron every 3 h via fn_punct_run_sync, and the Refresh button)
--     -> punctuality_job (one row per Tookan task, upserted on source + job_id)
--     -> v_punctuality   (the rules below, in ONE place; the screen only counts)
--
-- THE RULES (they live in v_punctuality, nowhere else)
--   counted      = the team went to site: outcome Successful / Failed / Arrived, with a minutes_late.
--                  NOT counted: Declined, Assigned, Accepted, Started (no arrival time) and Cancelled
--                  (it carries an "arrived" time, but 15 of 50 are more than 5 hours off the slot, so it is
--                  not a site arrival; the sheet itself marks Cancelled first_visit = n/a).
--   minutes_late = the sheet's own figure. It is the difference of two FULL date-times; the HH:MM `arrived`
--                  column is only a label (a task marked arrived days later shows a small clock time).
--   p30 / p60    = minutes_late <= 30 / <= 60. Early counts as punctual. p30 matches the sheet's own
--                  on_time column on all 1,493 rows (largest "yes" is 30, smallest "no" is 31).
--   first_order  = the sheet's first_visit = 'yes': the team's earliest job of that day (jobs sharing the
--                  earliest slot all count). Checked against the rule "earliest slot among Successful /
--                  Failed / Arrived jobs of that fleet and day" on every counted row: they agree.
--   team         = the Tookan agent, tidied: "Handpicked  T1" / "handpicked t10" / "Handpicked 11" -> T1 /
--                  T10 / T11, and an agent whose name is a person ("Ejaz Ahmad") takes the T-label the SAME
--                  fleet_id carries on its other rows (Team 5). Dubai T1 and Abu Dhabi T1 are different
--                  fleet_ids, so they are different teams.

-- ======================================================================= tabs to read
create table if not exists public.punctuality_source (
  source text primary key,                 -- 'kurtains-dubai'
  vertical text not null,                  -- Kurtains | Floorz
  city text not null,                      -- Dubai | Abu Dhabi
  sheet_id text not null,
  gid text not null,
  active boolean not null default true,
  last_read_at timestamptz, last_rows int, last_error text);

insert into public.punctuality_source (source, vertical, city, sheet_id, gid) values
  ('kurtains-dubai',    'Kurtains', 'Dubai',     '1Abnk3vT2hs6fV_AbowL7w5KgKEXHxxDSYIwuDt1Gp-g', '0'),
  ('kurtains-abudhabi', 'Kurtains', 'Abu Dhabi', '1Abnk3vT2hs6fV_AbowL7w5KgKEXHxxDSYIwuDt1Gp-g', '1154779886'),
  ('floorz-dubai',      'Floorz',   'Dubai',     '1Abnk3vT2hs6fV_AbowL7w5KgKEXHxxDSYIwuDt1Gp-g', '517999109')
on conflict (source) do nothing;

-- ======================================================================= one row per task
create table if not exists public.punctuality_job (
  source text not null references public.punctuality_source (source) on delete cascade,
  job_id text not null,
  day date not null,
  week date,                               -- Monday of the week, as the sheet has it
  fleet_id text,
  agent_raw text,                          -- as typed in Tookan
  team text,                               -- tidied label, see above
  order_id text,
  slot text,                               -- scheduled time, as in the sheet (a PM hour can read "3:00")
  arrived text,                            -- HH:MM only; use minutes_late
  minutes_late int,
  outcome text,
  first_visit text,                        -- yes | no | n/a
  synced_at timestamptz not null default now(),
  primary key (source, job_id));
create index if not exists punctuality_job_day on public.punctuality_job (day);

create table if not exists public.punctuality_sync_run (
  id bigserial primary key, at timestamptz not null default now(),
  trigger text, stats jsonb, error text);

do $$ declare t text; begin
  foreach t in array array['punctuality_source','punctuality_job','punctuality_sync_run'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists p_read_all on public.%I', t);
    execute format('create policy p_read_all on public.%I for select to authenticated using (true)', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
revoke all on sequence public.punctuality_sync_run_id_seq from anon;

-- ======================================================================= the rules
create or replace view public.v_punctuality with (security_invoker = true) as
select j.source, s.vertical, s.city, j.day, j.week, j.fleet_id, j.team, j.job_id, j.order_id, j.slot,
       j.minutes_late, j.outcome,
       (j.minutes_late is not null and j.outcome in ('Successful', 'Failed', 'Arrived')) as counted,
       case when j.minutes_late is not null and j.outcome in ('Successful', 'Failed', 'Arrived')
            then j.minutes_late <= 30 end as p30,
       case when j.minutes_late is not null and j.outcome in ('Successful', 'Failed', 'Arrived')
            then j.minutes_late <= 60 end as p60,
       (j.first_visit = 'yes') as first_order
  from public.punctuality_job j
  join public.punctuality_source s on s.source = j.source;
revoke all on public.v_punctuality from anon;
grant select on public.v_punctuality to authenticated;

-- ======================================================================= refresh
-- The Refresh button and pg_cron: ask punctuality-sync to read the sheets now. The anon key below is the
-- project's public one (the gateway wants some JWT); the real gate is the x-sync-key Vault secret.
create or replace function public.fn_punct_run_sync(p_trigger text default 'manual')
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_key text; v_req bigint;
begin
  if auth.uid() is not null and public.fn_is_viewer() then raise exception 'Your role can look but not refresh' using errcode = 'P0001'; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'punctuality_sync_secret';
  select net.http_post(
    url := 'https://jrevqijbzzwdcwxcnwfa.supabase.co/functions/v1/punctuality-sync',
    body := jsonb_build_object('trigger', p_trigger),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', v_key,
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpyZXZxaWpienp3ZGN3eGNud2ZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMDYyMDQsImV4cCI6MjA5OTc4MjIwNH0.kd1OBmwhyn-JdniDALMWkvG8duIGBGJnkB7xSPFoNiY'),
    timeout_milliseconds := 60000) into v_req;
  return v_req;
end $$;
revoke all on function public.fn_punct_run_sync(text) from public, anon;
grant execute on function public.fn_punct_run_sync(text) to authenticated;

-- ======================================================================= secret + schedule
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'punctuality_sync_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'punctuality_sync_secret', 'x-sync-key for punctuality-sync');
  end if;
end $$;

-- the Edge Function reads its key through this allow-list (same list as before, plus the new name)
create or replace function public.fn_wa_secret(p_name text)
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets
   where name = p_name and p_name in ('whapi_token', 'wa_webhook_secret', 'expense_capture_secret', 'review_capture_secret', 'punctuality_sync_secret')
$$;

select cron.unschedule('handpicked-punctuality-sync') where exists (select 1 from cron.job where jobname = 'handpicked-punctuality-sync');
select cron.schedule('handpicked-punctuality-sync', '10 */3 * * *', $$select public.fn_punct_run_sync('cron')$$);
