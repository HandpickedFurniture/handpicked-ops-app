-- Slack fabric alerts (2 Oct 2026, user request)
--
-- At 11:00 / 14:00 / 17:00 Dubai, look at the NEXT WORKING DAY's schedule (Sunday skipped, as in
-- fn_mgmt_next_working_day), keep only the Order-flagged rows (ISR and Odd Time are excluded; the
-- one "Others" row type in the sheet is "Issue raised", which is not an install either), and for every
-- order with fabric not yet received post a reply in THAT ORDER'S Slack thread - the parent message
-- Make.com created - listing fabric code + outstanding quantity.
--
--   11:00  Follow Up 1      14:00  Follow Up 2      17:00  Red Alert
--
-- The SQL decides WHAT to say; the Edge Function `slack-fabric-alert` decides WHERE (it finds the
-- Make.com thread with conversations.history, caches it in order_slack_threads, and posts with
-- chat.postMessage). pg_net cannot read a response synchronously, which is why the Slack half is not SQL.
--
-- Preview without sending:   select * from fn_fabric_alert_batch('follow_up_1', date '2026-10-05', true);
-- Dry run through Slack lookup (no posting):  select fn_fabric_alert_run('follow_up_1', true);
--   then read the result in net._http_response (id = returned request id).
-- Switch on:   update slack_config set v = 'true' where k = 'fabric_alert_enabled';

-- ── settings ──────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.slack_config (
  k text primary key,
  v text not null default '',
  note text,
  updated_at timestamptz not null default now()
);
alter table public.slack_config enable row level security;
revoke all on public.slack_config from anon, authenticated;

insert into public.slack_config (k, v, note) values
  ('fabric_alert_enabled', 'false', 'true = the 11/14/17 cron posts; false = it does nothing (dry runs still work)'),
  ('fabric_alert_channels', '', 'comma-separated Slack channel ids that hold the Make.com order threads'),
  ('make_bot_ids', '', 'optional: comma-separated bot_id / app_id of the Make.com poster. Empty = any bot whose name is Make/Integromat'),
  ('thread_lookback_days', '75', 'how far back conversations.history is scanned for an order''s Make.com thread')
on conflict (k) do nothing;

-- ── log / dedupe ──────────────────────────────────────────────────────────────────────────────────
create table if not exists public.fabric_alert_log (
  id bigserial primary key,
  install_date date not null,
  order_id text not null,
  stage text not null check (stage in ('follow_up_1', 'follow_up_2', 'red_alert')),
  status text not null check (status in ('sent', 'no_thread', 'error', 'dry_run')),
  channel text,
  thread_ts text,
  message_ts text,
  body text,
  detail text,
  created_at timestamptz not null default now()
);
-- one SENT alert per order per stage per install date; failures may repeat (each run retries them)
create unique index if not exists fabric_alert_log_sent_once
  on public.fabric_alert_log (install_date, order_id, stage) where status = 'sent';
alter table public.fabric_alert_log enable row level security;
revoke all on public.fabric_alert_log from anon, authenticated;

-- ── secrets the Edge Function may read (service role only) ───────────────────────────────────────
create or replace function public.fn_slack_secret(p_name text)
returns text language sql security definer set search_path to '' as $$
  select decrypted_secret from vault.decrypted_secrets
   where name = p_name and p_name in ('slack_bot_token', 'fabric_alert_secret')
$$;
revoke all on function public.fn_slack_secret(text) from public, anon, authenticated;
grant execute on function public.fn_slack_secret(text) to service_role;

do $$ begin
  if not exists (select 1 from vault.secrets where name = 'fabric_alert_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'fabric_alert_secret',
                                'shared secret between pg_cron and the slack-fabric-alert Edge Function');
  end if;
end $$;

-- ── what is pending ───────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_fabric_alert_pending(p_install_date date)
returns table (order_id text, city text, customer_name text, install_time text, items jsonb)
language sql stable security definer set search_path to '' as $$
  with sched as (
    -- an order can sit on the sheet twice; take its earliest slot
    select s.order_id, min(s.city) city, min(s.customer_name) customer_name, min(s.install_time) install_time
      from public.v_mgmt_schedule_rows s
     where s.install_date = p_install_date
       and s.issue_flag = 'Order'
     group by s.order_id
  )
  select sc.order_id, sc.city, sc.customer_name, sc.install_time,
         jsonb_agg(jsonb_build_object(
             'code',     r.item,
             'qty',      trim_scale(r.qty_outstanding),
             'expected', trim_scale(r.qty_expected),
             'received', trim_scale(r.qty_received),
             'uom',      coalesce(r.uom, 'm'),
             'status',   r.status)
           order by r.item)
    from sched sc
    join public.v_ops_receivables r
      on r.order_id = sc.order_id
     and r.grain = 'order_fabric'
     and r.status not in ('received', 'cancelled')
     and r.qty_outstanding > 0
   group by sc.order_id, sc.city, sc.customer_name, sc.install_time
   order by sc.install_time, sc.order_id
$$;
revoke all on function public.fn_fabric_alert_pending(date) from public, anon;
grant execute on function public.fn_fabric_alert_pending(date) to authenticated, service_role;

-- ── the message (Slack mrkdwn; < and > MUST be escaped or Slack eats "<Automated Alert>") ─────────
create or replace function public.fn_fabric_alert_text(p_stage text, p_install_date date,
                                                       p_install_time text, p_items jsonb)
returns text language sql immutable set search_path to '' as $$
  select
    '&lt;Automated Alert&gt; '
    || case p_stage
         when 'follow_up_1' then '*Follow Up 1* - fabric not received yet'
         when 'follow_up_2' then '*Follow Up 2* - fabric still not received'
         else ':rotating_light: *RED ALERT* - fabric still not received'
       end
    || E'\n'
    || 'Installation: *' || to_char(p_install_date, 'Dy DD Mon')
    || coalesce(', ' || nullif(p_install_time, ''), '') || '*' || E'\n'
    || 'Pending fabric:' || E'\n'
    || (select string_agg(
                 '• `' || (i->>'code') || '` - ' || (i->>'qty') || ' ' || (i->>'uom')
                 || case
                      when (i->>'received')::numeric > 0
                        then ' (' || (i->>'received') || ' of ' || (i->>'expected') || ' ' || (i->>'uom') || ' received)'
                      when i->>'status' = 'ordered'      then ' (ordered with supplier)'
                      when i->>'status' = 'out_of_stock' then ' (out of stock)'
                      else ''
                    end,
                 E'\n' order by i->>'code')
          from jsonb_array_elements(p_items) i)
    || E'\n'
    || case p_stage
         when 'red_alert' then 'Please confirm today whether this order can go ahead.'
         else 'Please share the delivery ETA.'
       end
$$;

-- ── batch for one run: everything not yet SENT for this stage ─────────────────────────────────────
create or replace function public.fn_fabric_alert_batch(p_stage text, p_install_date date default null,
                                                        p_force boolean default false)
returns table (install_date date, order_id text, city text, customer_name text, body text)
language sql stable security definer set search_path to '' as $$
  with d as (
    select coalesce(p_install_date,
                    public.fn_mgmt_next_working_day((now() at time zone 'Asia/Dubai')::date)) as day
  )
  select d.day, p.order_id, p.city, p.customer_name,
         public.fn_fabric_alert_text(p_stage, d.day, p.install_time, p.items)
    from d, public.fn_fabric_alert_pending(d.day) p
   where p_force
      or not exists (select 1 from public.fabric_alert_log l
                      where l.install_date = d.day and l.order_id = p.order_id
                        and l.stage = p_stage and l.status = 'sent')
$$;
revoke all on function public.fn_fabric_alert_batch(text, date, boolean) from public, anon;
grant execute on function public.fn_fabric_alert_batch(text, date, boolean) to authenticated, service_role;

-- ── the Edge Function reports back here ───────────────────────────────────────────────────────────
-- p_results: [{order_id, status, channel, thread_ts, message_ts, body, detail}]
-- Orders with no Make.com thread, or a Slack error, go to Admin alerts (WhatsApp) once per run, so a
-- missing thread is never silent.
create or replace function public.fn_fabric_alert_record(p_stage text, p_install_date date, p_results jsonb)
returns text language plpgsql security definer set search_path to '' as $$
declare v_bad text; v_group text; v_token text; v_n int;
begin
  insert into public.fabric_alert_log (install_date, order_id, stage, status, channel, thread_ts, message_ts, body, detail)
  select p_install_date, r->>'order_id', p_stage, r->>'status', r->>'channel', r->>'thread_ts',
         r->>'message_ts', r->>'body', r->>'detail'
    from jsonb_array_elements(p_results) r
  on conflict do nothing;
  get diagnostics v_n = row_count;

  -- remember threads (found by scan) so the next run does not scan again
  insert into public.order_slack_threads (order_id, channel, thread_ts)
  select r->>'order_id', r->>'channel', r->>'thread_ts'
    from jsonb_array_elements(p_results) r
   where r->>'status' in ('sent', 'dry_run') and coalesce(r->>'thread_ts', '') <> ''
  on conflict (order_id) do update set channel = excluded.channel, thread_ts = excluded.thread_ts;

  select string_agg('• ' || (r->>'order_id') || ': ' ||
                    case r->>'status' when 'no_thread' then 'no Make.com thread found in Slack'
                                      else coalesce(r->>'detail', 'Slack error') end, E'\n')
    into v_bad
    from jsonb_array_elements(p_results) r
   where r->>'status' in ('no_thread', 'error');

  if v_bad is not null then
    select group_id into v_group from public.notify_groups
     where team = 'admin' and enabled and coalesce(group_id, '') <> '';
    select decrypted_secret into v_token from vault.decrypted_secrets where name = 'whapi_token';
    if v_group is not null and v_token is not null then
      perform net.http_post(
        url     := 'https://gate.whapi.cloud/messages/text',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
        body    := jsonb_build_object('to', v_group, 'body',
                     '*Slack fabric alert (' || replace(p_stage, '_', ' ') || ') could not post for '
                     || to_char(p_install_date, 'Dy DD Mon') || '*' || E'\n' || v_bad || E'\n\n'
                     || '_Post these by hand in the order thread. Fix the thread with:_ '
                     || 'insert into order_slack_threads (order_id, channel, thread_ts) values (...)'));
    end if;
  end if;
  return format('%s logged', v_n);
end $$;
revoke all on function public.fn_fabric_alert_record(text, date, jsonb) from public, anon, authenticated;
grant execute on function public.fn_fabric_alert_record(text, date, jsonb) to service_role;

-- ── cron entry point ─────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_fabric_alert_run(p_stage text, p_dry_run boolean default false,
                                                      p_install_date date default null)
returns text language plpgsql security definer set search_path to '' as $$
declare v_secret text; v_req bigint;
begin
  if not p_dry_run and coalesce((select v from public.slack_config where k = 'fabric_alert_enabled'), 'false') <> 'true' then
    return 'disabled (slack_config.fabric_alert_enabled)';
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'fabric_alert_secret';
  select net.http_post(
           url     := 'https://jrevqijbzzwdcwxcnwfa.supabase.co/functions/v1/slack-fabric-alert?k=' || v_secret,
           headers := jsonb_build_object('Content-Type', 'application/json'),
           body    := jsonb_build_object('stage', p_stage, 'dry_run', p_dry_run, 'date', p_install_date),
           timeout_milliseconds := 300000)
    into v_req;
  return format('%s request %s', case when p_dry_run then 'dry run' else 'live' end, v_req);
end $$;
revoke all on function public.fn_fabric_alert_run(text, boolean, date) from public, anon, authenticated;

-- 11:00 / 14:00 / 17:00 Asia/Dubai = 07:00 / 10:00 / 13:00 UTC
select cron.schedule('handpicked-fabric-alert-11', '0 7 * * *',  $$select public.fn_fabric_alert_run('follow_up_1')$$);
select cron.schedule('handpicked-fabric-alert-14', '0 10 * * *', $$select public.fn_fabric_alert_run('follow_up_2')$$);
select cron.schedule('handpicked-fabric-alert-17', '0 13 * * *', $$select public.fn_fabric_alert_run('red_alert')$$);

-- ── 3 Oct 2026 (user): new wording, 3 PM instead of 2 PM, tags by city, browser posting ─────────────
-- No bot token is possible (the user is a single-channel guest in Makan's Slack), so the LIVE path is now
-- three desktop-app scheduled tasks (fabric-alert-follow-up-1 / -2 / fabric-alert-red-alert, 11:00 / 15:00 /
-- 17:00 local) that read fn_fabric_alert_batch, post from the user's own Slack in the built-in browser, and
-- call fn_fabric_alert_record. The pg_cron + Edge Function path above stays dormant (fabric_alert_enabled =
-- false); the deployed Edge Function v1 predates the plain-text wording and the tags - redeploy before enabling.
-- fn_fabric_alert_text now returns PLAIN one-line text, e.g.
--   <Automated Alert> Follow Up 1 - fabric a (13 m), b (9 m) and c (26 m) not received, please follow up with supplier
--   <Automated Alert> Red Alert - Fabric a (13 m) not received, order might need to be rescheduled or need partial
--     installation (incurs split order fees of AED 100)
-- Tags: slack_config.tag_dubai = Bhuvana U0BRM23JXNY + Usha U09QR4D0811; tag_abu_dhabi = Devyani U0BF7EN8BPD + Usha.
-- No Make.com thread -> post in the channel with "Order <id> - Order thread not found".
-- cron: handpicked-fabric-alert-14 replaced by handpicked-fabric-alert-15 ('0 11 * * *' UTC = 15:00 Dubai).

-- ── 3 Oct 2026 (user): "fabric now received" closing reply ────────────────────────────────────────────
-- fn_fabric_alert_received_batch(date default next working day): orders with a SENT alert for that install date,
-- still Order-flagged on that day, nothing pending now, and no 'received' reply yet. Body:
--   <Automated Alert> Fabric received - a, b and c now received, no further follow up needed
-- (fabric received since the first alert; 'all fabric for this order' if none dated after it).
-- fabric_alert_log.stage now also allows 'received'. All three scheduled tasks post these BEFORE their alerts,
-- same thread + same city tags, and never fall back to the channel for them.

-- 4 Oct 2026 (user): Red Alert split order fee by city - Abu Dhabi AED 150, Dubai (and anything else) AED 100.
-- fn_fabric_alert_text gained a 5th arg p_city (old 4-arg version dropped); fn_fabric_alert_batch passes p.city.
-- Also 4 Oct: fn_fabric_alert_batch skips orders with a SENT alert at the same OR A LATER stage (no stepping back).
