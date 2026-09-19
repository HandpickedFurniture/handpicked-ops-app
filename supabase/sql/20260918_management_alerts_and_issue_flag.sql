-- Management alerts, the four-valued issue flag, the Management Dashboard views, and the anon
-- lock-down.  18 September 2026.
--
-- SUPERSEDED IN PART by 20260919_management_alerts_v2.sql (19 Sep): 4/4 production status is now
-- the next working day, 2/4 order value's YTD / MTD / per day are by the date the order was
-- received (v_mgmt_order_received) and 'recent 3 days' is gone. Items 1, 2, 3 and 5 below stand.
--
-- APPLIED as eight migrations, in this order (the full statement text of each is in
-- supabase_migrations.schema_migrations, which is the record of what actually ran):
--
--   20260918131705  revoke_anon_from_public_schema
--   20260918132132  issue_flag_four_values
--   20260918132244  management_dashboard_views
--   20260918132445  management_alerts_7am
--   20260918132801  schedule_snapshot_log
--   20260918133125  mgmt_order_value_orders_only
--   20260918133557  report_views_filter_columns
--   20260918134339  mgmt_schedule_rows_filter_columns
--
-- What changed, and why (user, 18 Sep 2026):
--
-- 1. ANON LOCK-DOWN. The ten SECURITY DEFINER views (v_ops_order_roster, v_ops_report_orders,
--    v_ops_status_board, v_ops_finance_lines, ...) run as their owner and bypass RLS, and `anon`
--    held SELECT on every view - so a request carrying nothing but the publishable key that ships
--    inside the public app returned real order rows. Every anon grant in public is revoked (tables,
--    sequences, functions) and the default privileges changed so a future view cannot re-open it.
--    tools/check_columns.py now reads a 401 "permission denied" as "every column exists" - Postgres
--    resolves the select list (42703) before it checks privileges (42501). The Vault-token /
--    Whapi-calling helpers (fn_sched_wa_scan, fn_sched_wa_harvest, fn_sched_cron_build,
--    fn_set_whapi_token, fn_deadman_check, fn_schedule_watch_check) lost EXECUTE for
--    authenticated / anon / public as well.
--
-- 2. ISSUE FLAG. fn_issue_flag(status, install_time) -> 'Order' | 'ISR' | 'Odd Time' | 'Others':
--      Order     Material ordered / Order placed / Endorsement done, HH:MM inside 09:00-19:00
--      ISR       Issue resolution scheduled, whatever the time
--      Odd Time  one of the three order statuses but outside 09:00-19:00 or with no time (the 3D
--                sheet's "not really scheduled" convention - 03:00 rows)
--      Others    anything else, including an order the sheet does not carry
--    v_ops_order_roster.issue_flag now calls it (was 'Issue' / 'Order' keyed on the Issue text
--    column), so every report, the dashboard and the alerts read the same four words. The Python
--    twin is schedule_sync.issue_flag() in the ingestion agent - keep them in step.
--
-- 3. MANAGEMENT VIEWS (security_invoker):
--      v_mgmt_schedule_rows  one row per LIVE 3D-sheet row (an order can be on a sheet twice - an
--                            installation and an issue resolution), flagged, with the order's
--                            windows / OWL / credits from the database, plus every column the
--                            shared filter bar emits
--      v_mgmt_daily          per install_date x city x issue_flag: orders, windows, OWL blinds /
--                            curtains / total, credits, the sheet's own window figure as a check
--      v_mgmt_order_value    one row per order, Order-flagged and not cancelled, with its PO value
--    fn_mgmt_order_value(p_today) -> jsonb: ytd, mtd (+ days elapsed, per day), recent 3 days,
--    today, next 5 days. Callable by authenticated: the dashboard table and the WhatsApp message
--    are built from the same call.
--
-- 4. THE 07:00 ALERTS. pg_cron `handpicked-mgmt-7am` at 0 3 * * * (UTC = 07:00 Dubai) runs
--    fn_mgmt_daily_alerts(), which sends four messages to notify_groups.management
--    ('Management alerts', 120363412395597092@g.us, created 18 Sep 2026 via Whapi POST /groups with
--    +971565389740 and +971569948764) through pg_net with the Vault whapi_token - the same
--    transport as the dead man's switch:
--      1/4 fn_mgmt_body_owl                 next 7 days by date and city, Order rows only
--      2/4 fn_mgmt_body_order_value         YTD / MTD / per day / recent 3 / today / next 5
--      3/4 fn_mgmt_body_install_status      yesterday's orders by the app's Installation status,
--                                           with the count nobody updated
--      4/4 fn_mgmt_body_production_status   today's orders by production state, with metres
--    fn_mgmt_send() writes mgmt_alert_log keyed 'kind:date' so a re-run the same morning is a
--    no-op; fn_mgmt_daily_alerts(true) forces. The body builders are callable by authenticated
--    (the dashboard shows the messages as they would go out); the senders are not.
--
-- 5. schedule_snapshot_log: one row per city per day for the 18:00 schedule picture that
--    schedule_sync.send_snapshots posts to Installation alerts from the Cloud Run job.
--
-- 6. Report views (v_ops_report_stitching / _railing / _dragonmart) gained the filter-bar columns
--    (issue_flag, search_blob, commercial_names, window_refs, stitching_types, fabric codes,
--    alteration, installation_time / sheet_status) APPENDED, so one bar drives all eight pages.

-- ---------------------------------------------------------------- 1. anon lock-down
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
revoke execute on function public.fn_sched_wa_scan()               from authenticated, anon, public;
revoke execute on function public.fn_sched_wa_harvest()            from authenticated, anon, public;
revoke execute on function public.fn_sched_cron_build()            from authenticated, anon, public;
revoke execute on function public.fn_set_whapi_token(text)         from authenticated, anon, public;
revoke execute on function public.fn_deadman_check(int, boolean)   from authenticated, anon, public;
revoke execute on function public.fn_schedule_watch_check(boolean) from authenticated, anon, public;

-- ---------------------------------------------------------------- 2. issue flag
create or replace function public.fn_issue_flag(p_status text, p_time text)
returns text language sql immutable set search_path = '' as $$
  select case
    when lower(btrim(coalesce(p_status, ''))) = 'issue resolution scheduled' then 'ISR'
    when lower(btrim(coalesce(p_status, ''))) in ('material ordered', 'order placed', 'endorsement done') then
      case when p_time ~ '^[0-9]{2}:[0-9]{2}$'
                and p_time::time >= time '09:00' and p_time::time <= time '19:00'
           then 'Order' else 'Odd Time' end
    else 'Others'
  end
$$;
-- v_ops_order_roster: the issue_flag CASE was swapped for
--   public.fn_issue_flag(s.sheet_status, s.sheet_install_time) AS issue_flag
-- by text replacement on the live definition (see the migration for the DO block).

-- ---------------------------------------------------------------- 3. management views
create or replace view public.v_mgmt_schedule_rows
with (security_invoker = true) as
with live as (
  select distinct on (s.install_date, s.order_id, s.entry_type)
         s.city, s.order_id, s.customer_name, s.install_date, s.install_time, s.entry_type,
         s.status as sheet_status, s.team as sheet_team, s.notes as sheet_notes,
         nullif(regexp_replace(coalesce(s.raw_row->>'number_of_windows', ''), '[^0-9]', '', 'g'), '')::int as sheet_windows,
         s.synced_at
  from public.v_installation_schedule_live s
  where s.order_id is not null
  order by s.install_date, s.order_id, s.entry_type, s.synced_at desc, s.id desc
)
select l.city, l.order_id, l.customer_name, l.install_date, l.install_time, l.entry_type,
       l.sheet_status, l.sheet_team, l.sheet_notes, l.sheet_windows, l.synced_at,
       public.fn_issue_flag(l.sheet_status, l.install_time) as issue_flag,
       coalesce(r.window_count, 0)  as window_count,
       coalesce(r.owl_blinds, 0)    as owl_blinds,
       coalesce(r.owl_curtains, 0)  as owl_curtains,
       coalesce(r.owl_total, 0)     as owl_total,
       coalesce(r.report_meters, 0) as report_meters,
       coalesce(b.po_amount_aed, 0) as credits,
       r.order_status, r.production_state, r.team_no,
       r.commercial_names, r.window_refs, r.stitching_types, r.search_blob,
       (r.order_id is not null) as order_known,
       l.install_date as installation_date,
       r.fabric_1_codes, r.fabric_2_codes,
       coalesce(r.alteration, false) as alteration,
       r.date_bucket
from live l
left join public.v_ops_order_roster r on r.order_id = l.order_id
left join public.v_ops_billing b on b.order_id = l.order_id;

create or replace view public.v_mgmt_daily
with (security_invoker = true) as
select install_date, city, issue_flag,
       count(*)::int as orders, sum(window_count)::int as windows,
       sum(owl_blinds)::int as owl_blinds, sum(owl_curtains)::int as owl_curtains,
       sum(owl_total)::int as owl_total, round(sum(credits), 2) as credits,
       sum(sheet_windows)::int as sheet_windows,
       count(*) filter (where not order_known)::int as unknown_orders
from public.v_mgmt_schedule_rows
where install_date is not null
group by install_date, city, issue_flag;

create or replace view public.v_mgmt_order_value
with (security_invoker = true) as
select r.order_id, r.customer_name, r.city, r.installation_date, r.issue_flag, r.order_status,
       r.production_state, coalesce(b.po_amount_aed, 0) as credits
from public.v_ops_order_roster r
left join public.v_ops_billing b on b.order_id = r.order_id
where r.issue_flag = 'Order'
  and coalesce(r.production_state, '') <> 'cancelled';

-- fn_mgmt_order_value(date), fn_mgmt_send(text,text,text,boolean), fn_mgmt_aed(numeric),
-- fn_mgmt_day(date), fn_mgmt_body_owl(date,int), fn_mgmt_body_order_value(date),
-- fn_mgmt_body_install_status(date), fn_mgmt_body_production_status(date),
-- fn_mgmt_daily_alerts(boolean): see the management_alerts_7am and mgmt_order_value_orders_only
-- migrations for the bodies. Re-schedule with:
--   select cron.schedule('handpicked-mgmt-7am', '0 3 * * *', 'select public.fn_mgmt_daily_alerts()');
-- Test without waiting for 07:00 (sends for real, four messages):
--   select public.fn_mgmt_daily_alerts(true);
-- Read the text without sending:
--   select public.fn_mgmt_body_owl(), public.fn_mgmt_body_order_value(),
--          public.fn_mgmt_body_install_status(), public.fn_mgmt_body_production_status();

-- ---------------------------------------------------------------- 5. snapshot log
create table if not exists public.schedule_snapshot_log (
  id bigserial primary key, city text not null, snapshot_date date not null,
  rows_shown int not null default 0, group_id text, provider_message_id text,
  status text not null default 'sent', error text, sent_at timestamptz not null default now(),
  unique (city, snapshot_date)
);
alter table public.schedule_snapshot_log enable row level security;

create table if not exists public.mgmt_alert_log (
  id bigserial primary key, alert_key text not null unique, kind text not null, body text not null,
  net_request_id bigint, sent_at timestamptz not null default now()
);
alter table public.mgmt_alert_log enable row level security;
