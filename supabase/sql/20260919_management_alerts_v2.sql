-- Management alerts, second cut.  19 September 2026 (user).
--
-- APPLIED as two migrations (the statement text is in supabase_migrations.schema_migrations, the
-- record of what actually ran):
--   20260919054338  management_alerts_next_working_day_and_received_date
--   20260919054712  mgmt_order_received_lowest_version   (the view dated by version_no = 1 at first;
--                   six orders exist only as v2 and came out with no received date - now the LOWEST
--                   surviving version; and the YTD / MTD order counts gained a thousands separator)
-- This file is the end state.
-- Builds on 20260918_management_alerts_and_issue_flag.sql; everything not mentioned here is as it was.
--
-- What changed, and why:
--
-- 1. 4/4 PRODUCTION STATUS is for the NEXT WORKING DAY, not today. At 07:00 the day's vans have
--    already been loaded; what production can still act on is tomorrow's installations. The next
--    working day is tomorrow, and Monday when tomorrow is a Sunday (Sunday carries 6 installations
--    in the whole roster against ~100 on every other weekday) - fn_mgmt_next_working_day(). So the
--    Saturday 19 Sep message is about Monday 21 Sep. No public-holiday calendar.
--
-- 2. 2/4 ORDER VALUE. Year to date / month to date / per day are by the date the order was
--    RECEIVED, not by installation date - they are a sales figure, not a delivery figure. The
--    received date per order (v_mgmt_order_received.received_date, with received_source saying
--    which rule fired):
--      po_number     the PO-YYYYMMDD- date in the first version's PO number - Makan's order date,
--                    which is the day the email arrived for 640 of 707 emailed orders; the other
--                    67 are import lag (the agent's first run on 20 Jul swept 13-18 Jul in one go),
--                    where the PO date is the truer one
--      sheet_column  the July sheet backfill (SHEET-... PO numbers): its Order Received Date column
--                    - NOT order_lines_final.order_received_date, which is still NULL for 323 of
--                    those orders (materialised before the fn_parse_date fix, never rebuilt)
--      import_time   the first po_lines_raw row's created_at in Dubai time (nothing needs it today:
--                    717 orders date by po_number, 349 by sheet_column, none are left over)
--    The period figures count EVERY order received except cancelled: the Order flag is an
--    installation-schedule idea (a 3D-sheet row inside 09:00-19:00) and applied to "received this
--    month" it would drop the orders not scheduled yet and the ones whose current sheet row is an
--    issue resolution - the newest bookings. Today / next 5 days are unchanged: installation date,
--    Order-flagged rows, from v_mgmt_order_value, like the OWL report. The message says both.
--    The database holds orders from 29 May 2026, so 2026 year-to-date runs from there - the text
--    says so while the year is 2026.
--
-- 3. "Recent 3 days" is gone from the message, the jsonb (no 'recent' key) and the dashboard.
--
-- Preview without sending:
--   select public.fn_mgmt_body_order_value(), public.fn_mgmt_body_production_status();
-- Force a real send (four messages):  select public.fn_mgmt_daily_alerts(true);

-- ---------------------------------------------------------------- helpers
create or replace function public.fn_mgmt_next_working_day(p_from date)
returns date language sql immutable set search_path = '' as $$
  select case when extract(isodow from p_from + 1) = 7 then p_from + 2 else p_from + 1 end
$$;

-- the PO-YYYYMMDD- date in a PO number; null for the SHEET- backfill numbers or a malformed date
create or replace function public.fn_mgmt_po_date(p_po_number text)
returns date language plpgsql immutable set search_path = '' as $$
begin
  if p_po_number !~ '^PO-\d{8}-' then return null; end if;
  return to_date(substring(p_po_number from '^PO-(\d{8})-'), 'YYYYMMDD');
exception when others then
  return null;
end $$;

revoke execute on function public.fn_mgmt_next_working_day(date) from public, anon;
revoke execute on function public.fn_mgmt_po_date(text)          from public, anon;
grant  execute on function public.fn_mgmt_next_working_day(date) to authenticated, service_role;
grant  execute on function public.fn_mgmt_po_date(text)          to authenticated, service_role;

-- ---------------------------------------------------------------- one row per order, dated by receipt
create or replace view public.v_mgmt_order_received
with (security_invoker = true) as
with v1 as (   -- the order's lowest surviving version (not version_no = 1: six orders only have a v2)
  select distinct on (order_id)
         order_id, created_at as first_seen_at, po_number, order_received_date_raw
  from public.po_lines_raw
  order by order_id, version_no, line_no
)
select r.order_id, r.customer_name, r.city, r.installation_date, r.issue_flag, r.order_status,
       r.production_state, coalesce(b.po_amount_aed, 0) as credits,
       coalesce(public.fn_mgmt_po_date(v1.po_number),
                public.fn_parse_date(v1.order_received_date_raw),
                (v1.first_seen_at at time zone 'Asia/Dubai')::date) as received_date,
       case when public.fn_mgmt_po_date(v1.po_number) is not null            then 'po_number'
            when public.fn_parse_date(v1.order_received_date_raw) is not null then 'sheet_column'
            else 'import_time' end as received_source
from public.v_ops_order_roster r
left join public.v_ops_billing b on b.order_id = r.order_id
left join v1 on v1.order_id = r.order_id
where coalesce(r.production_state, '') <> 'cancelled';

revoke all on public.v_mgmt_order_received from anon;
grant select on public.v_mgmt_order_received to authenticated, service_role;

-- ---------------------------------------------------------------- the figures (dashboard + message)
create or replace function public.fn_mgmt_order_value(p_today date default null)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_today   date := coalesce(p_today, (now() at time zone 'Asia/Dubai')::date);
  v_ytd     numeric; v_ytd_n int;
  v_mtd     numeric; v_mtd_n int;
  v_days    int := extract(day from v_today)::int;
  v_today_j jsonb; v_future jsonb;
begin
  -- the period figures: by the date the order was received, every order except cancelled
  select coalesce(sum(credits), 0), count(*) into v_ytd, v_ytd_n
    from public.v_mgmt_order_received
   where received_date >= date_trunc('year', v_today)::date and received_date <= v_today;
  select coalesce(sum(credits), 0), count(*) into v_mtd, v_mtd_n
    from public.v_mgmt_order_received
   where received_date >= date_trunc('month', v_today)::date and received_date <= v_today;

  -- the day rows: by installation date, Order-flagged rows only, like the OWL report
  select jsonb_build_object('date', v_today, 'value', coalesce(sum(credits), 0), 'orders', count(*))
    into v_today_j from public.v_mgmt_order_value where installation_date = v_today;
  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'value', v, 'orders', n) order by d), '[]'::jsonb)
    into v_future
    from (select g.d, coalesce(sum(o.credits), 0) v, count(o.order_id) n
            from generate_series(v_today + 1, v_today + 5, interval '1 day') g(d)
            left join public.v_mgmt_order_value o on o.installation_date = g.d::date
           group by g.d) t;

  return jsonb_build_object(
    'today', v_today,
    'basis', jsonb_build_object('periods', 'received_date', 'days', 'installation_date'),
    'ytd', jsonb_build_object('value', v_ytd, 'orders', v_ytd_n, 'from', date_trunc('year', v_today)::date),
    'mtd', jsonb_build_object('value', v_mtd, 'orders', v_mtd_n, 'from', date_trunc('month', v_today)::date,
                              'days_elapsed', v_days, 'per_day', round(v_mtd / greatest(v_days, 1), 2)),
    'today_row', v_today_j, 'future', v_future);
end $$;

-- ---------------------------------------------------------------- 2/4 the message
create or replace function public.fn_mgmt_body_order_value(p_today date default null)
returns text language plpgsql stable set search_path = '' as $$
declare
  j jsonb := public.fn_mgmt_order_value(p_today);
  v_today date := (j->>'today')::date;
  v_body text;
  r jsonb;
begin
  v_body := '*💰 Order value* (2/4)' || E'\n'
         || public.fn_mgmt_day(v_today) || ' ' || to_char(now() at time zone 'Asia/Dubai', 'HH24:MI') || ' GST' || E'\n'
         || '_Year / month / per day: PO value by the date the order was received, every order except cancelled'
         || case when extract(year from v_today) = 2026 then ' (the database holds orders from 29 May 2026)' else '' end
         || '. Today / next 5 days: by installation date, Order rows only — Material ordered / Order placed / '
         || 'Endorsement done, 09:00–19:00; no ISR, no odd-time, no cancelled._' || E'\n\n'
         || format('*Year to date* (%s): %s · %s orders', to_char(v_today, 'YYYY'),
                   public.fn_mgmt_aed((j->'ytd'->>'value')::numeric), to_char((j->'ytd'->>'orders')::int, 'FM999,999')) || E'\n'
         || format('*Month to date* (%s): %s · %s orders', to_char(v_today, 'Mon'),
                   public.fn_mgmt_aed((j->'mtd'->>'value')::numeric), to_char((j->'mtd'->>'orders')::int, 'FM999,999')) || E'\n'
         || format('*Per day this month*: %s (%s days elapsed)',
                   public.fn_mgmt_aed((j->'mtd'->>'per_day')::numeric), j->'mtd'->>'days_elapsed') || E'\n\n';
  r := j->'today_row';
  v_body := v_body || format('*Today* %s — %s · %s orders', public.fn_mgmt_day(v_today),
                             public.fn_mgmt_aed((r->>'value')::numeric), r->>'orders') || E'\n\n'
         || '*Next 5 days*' || E'\n';
  for r in select * from jsonb_array_elements(j->'future') loop
    v_body := v_body || format('• %s — %s · %s orders', public.fn_mgmt_day((r->>'date')::date),
                               public.fn_mgmt_aed((r->>'value')::numeric), r->>'orders') || E'\n';
  end loop;
  return rtrim(v_body, E'\n');
end $$;

-- ---------------------------------------------------------------- 4/4 the message
create or replace function public.fn_mgmt_body_production_status(p_date date default null)
returns text language plpgsql stable set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Dubai')::date;
  v_date  date := coalesce(p_date, public.fn_mgmt_next_working_day(v_today));
  v_body text; r record; v_n int;
begin
  select count(*) into v_n from public.v_ops_order_roster where installation_date = v_date;
  v_body := '*✂️ Production status — ' || public.fn_mgmt_day(v_date) || '* (4/4)' || E'\n'
         || format('%s order%s installing on %s%s', v_n, case when v_n = 1 then '' else 's' end,
                   public.fn_mgmt_day(v_date),
                   case when v_date = public.fn_mgmt_next_working_day(v_today) then ' — the next working day' else '' end) || E'\n';
  for r in
    select production_state, count(*) n, round(sum(coalesce(report_meters, 0))) m,
           string_agg(order_id, ', ' order by order_id) ids
      from public.v_ops_order_roster
     where installation_date = v_date
     group by production_state
     order by case production_state
                when 'packed' then 1 when 'in_production' then 2 when 'fabric_in' then 3
                when 'ordered' then 4 when 'awaiting_fabric' then 5 when 'qc_failed' then 6
                when 'cancelled' then 7 else 8 end
  loop
    v_body := v_body || format('• %s: %s · %s m%s',
                 case r.production_state
                   when 'packed' then 'Packed' when 'in_production' then 'In production'
                   when 'fabric_in' then 'Fabric in' when 'ordered' then 'Ordered'
                   when 'awaiting_fabric' then '⚠️ Awaiting fabric' when 'qc_failed' then '🔴 QC failed'
                   when 'cancelled' then 'Cancelled' else coalesce(r.production_state, '—') end,
                 r.n, r.m,
                 case when r.n <= 6 and r.production_state in ('awaiting_fabric', 'ordered', 'qc_failed', 'fabric_in')
                      then ' (' || r.ids || ')' else '' end) || E'\n';
  end loop;
  if v_n = 0 then v_body := v_body || '• nothing is installing on ' || public.fn_mgmt_day(v_date) || E'\n'; end if;
  return rtrim(v_body, E'\n');
end $$;

-- ---------------------------------------------------------------- 07:00
create or replace function public.fn_mgmt_daily_alerts(p_force boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Asia/Dubai')::date; v_out text := '';
begin
  v_out := v_out || public.fn_mgmt_send('owl',        'owl:'        || v_today, public.fn_mgmt_body_owl(v_today), p_force) || E'\n';
  v_out := v_out || public.fn_mgmt_send('order_value','order_value:'|| v_today, public.fn_mgmt_body_order_value(v_today), p_force) || E'\n';
  v_out := v_out || public.fn_mgmt_send('install',    'install:'    || v_today, public.fn_mgmt_body_install_status(v_today - 1), p_force) || E'\n';
  v_out := v_out || public.fn_mgmt_send('production', 'production:' || v_today,
                      public.fn_mgmt_body_production_status(public.fn_mgmt_next_working_day(v_today)), p_force);
  return v_out;
end $$;
