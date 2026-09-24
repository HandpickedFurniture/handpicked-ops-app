-- Fabric metres - the fifth 07:00 management message and the dashboard's third table (user, 24 Sep 2026).
--
-- Per installation date and city, for the next 7 days:
--   total     = report_meters, the Planning sheet's "Fabric (m)": metres received where the fabric is
--               in, else the metres ordered on the PO
--   received  = received_meters, what receiving has booked in
--   ready     = the total of orders whose production_state is 'packed' (packed on Preparation, or Fold
--               ticked on Planning) - finished work is only known at order grain
--   to do     = total - ready
-- ISR rows are left out, as in the Planning subtotals, and so are cancelled orders. Odd Time and
-- Others stay in: they still need their fabric made up.
--
-- One function feeds both the WhatsApp body and the dashboard, so the two can never disagree.

create or replace function public.fn_mgmt_fabric(p_today date default null, p_days int default 7)
returns table (install_date date, city text, orders bigint,
               total_m numeric, received_m numeric, ready_m numeric, todo_m numeric)
language sql stable
set search_path to ''
as $$
  with d as (select coalesce(p_today, (now() at time zone 'Asia/Dubai')::date) as d0)
  select r.installation_date,
         coalesce(nullif(btrim(r.city), ''), 'City unknown'),
         count(*),
         round(sum(coalesce(r.report_meters, 0)), 1),
         round(sum(coalesce(r.received_meters, 0)), 1),
         round(coalesce(sum(r.report_meters) filter (where r.production_state = 'packed'), 0), 1),
         round(sum(coalesce(r.report_meters, 0))
               - coalesce(sum(r.report_meters) filter (where r.production_state = 'packed'), 0), 1)
    from public.v_ops_report_orders r, d
   where r.installation_date between d.d0 and d.d0 + (p_days - 1)
     and coalesce(r.issue_flag, '') <> 'ISR'
     and coalesce(r.production_state, '') <> 'cancelled'
   group by 1, 2
   order by 1, case when coalesce(nullif(btrim(r.city), ''), 'City unknown') = 'Dubai' then 1
                    when coalesce(nullif(btrim(r.city), ''), 'City unknown') = 'Abu Dhabi' then 2 else 3 end, 2
$$;

create or replace function public.fn_mgmt_m(p numeric)
returns text language sql immutable set search_path to '' as $$
  select to_char(round(coalesce(p, 0)), 'FM999,999,990') || ' m'
$$;

create or replace function public.fn_mgmt_body_fabric(p_today date default null, p_days int default 7)
returns text
language plpgsql stable
set search_path to ''
as $function$
declare
  v_today date := coalesce(p_today, (now() at time zone 'Asia/Dubai')::date);
  v_body text; v_day record; r record; t record; v_n int;
  fmt constant text := '%s order%s · %s · received %s · ready %s · to do %s';
begin
  v_body := '*🧵 Fabric metres — next ' || p_days || ' days* (5/5)' || E'\n'
         || public.fn_mgmt_day(v_today) || ' ' || to_char(now() at time zone 'Asia/Dubai', 'HH24:MI') || ' GST' || E'\n'
         || '_Fabric (m) as on the Planning sheet: metres received where the fabric is in, else metres ordered. '
         || 'Ready = orders packed (Fold ticked). To do = total − ready. ISR and cancelled not counted._' || E'\n';

  for v_day in select g.d::date as d from generate_series(v_today, v_today + (p_days - 1), interval '1 day') g(d) loop
    v_body := v_body || E'\n*' || public.fn_mgmt_day(v_day.d) || '*' || E'\n';
    v_n := 0;
    for r in select * from public.fn_mgmt_fabric(v_today, p_days) f where f.install_date = v_day.d loop
      v_n := v_n + 1;
      v_body := v_body || '• ' || r.city || ' — ' || format(fmt, r.orders, case when r.orders = 1 then '' else 's' end,
                  public.fn_mgmt_m(r.total_m), public.fn_mgmt_m(r.received_m),
                  public.fn_mgmt_m(r.ready_m), public.fn_mgmt_m(r.todo_m)) || E'\n';
    end loop;
    if v_n = 0 then
      v_body := v_body || '• none' || E'\n';
    elsif v_n > 1 then
      select sum(orders) orders, sum(total_m) tm, sum(received_m) rm, sum(ready_m) dm, sum(todo_m) om into t
        from public.fn_mgmt_fabric(v_today, p_days) f where f.install_date = v_day.d;
      v_body := v_body || '  = ' || format(fmt, t.orders, 's', public.fn_mgmt_m(t.tm), public.fn_mgmt_m(t.rm),
                  public.fn_mgmt_m(t.dm), public.fn_mgmt_m(t.om)) || E'\n';
    end if;
  end loop;

  select coalesce(sum(orders), 0) orders, sum(total_m) tm, sum(received_m) rm, sum(ready_m) dm, sum(todo_m) om into t
    from public.fn_mgmt_fabric(v_today, p_days);
  v_body := v_body || E'\n*' || p_days || '-day total* — ' || format(fmt, t.orders, case when t.orders = 1 then '' else 's' end,
              public.fn_mgmt_m(t.tm), public.fn_mgmt_m(t.rm), public.fn_mgmt_m(t.dm), public.fn_mgmt_m(t.om));
  return v_body;
end $function$;

-- the four existing messages are numbered out of 4 in their headings; there are five now
do $$
declare f text; d text;
begin
  foreach f in array array['fn_mgmt_body_owl(date,integer)', 'fn_mgmt_body_order_value(date)',
                           'fn_mgmt_body_install_status(date)', 'fn_mgmt_body_production_status(date)'] loop
    d := pg_get_functiondef(('public.' || f)::regprocedure);
    if d ~ '\(\d/4\)' then execute regexp_replace(d, '\((\d)/4\)', '(\1/5)'); end if;
  end loop;
end $$;

create or replace function public.fn_mgmt_daily_alerts(p_force boolean default false)
returns text
language plpgsql security definer
set search_path to ''
as $function$
declare v_today date := (now() at time zone 'Asia/Dubai')::date; v_out text := '';
begin
  v_out := v_out || public.fn_mgmt_send('owl',        'owl:'        || v_today, public.fn_mgmt_body_owl(v_today), p_force) || E'\n';
  v_out := v_out || public.fn_mgmt_send('order_value','order_value:'|| v_today, public.fn_mgmt_body_order_value(v_today), p_force) || E'\n';
  v_out := v_out || public.fn_mgmt_send('install',    'install:'    || v_today, public.fn_mgmt_body_install_status(v_today - 1), p_force) || E'\n';
  v_out := v_out || public.fn_mgmt_send('production', 'production:' || v_today,
                      public.fn_mgmt_body_production_status(public.fn_mgmt_next_working_day(v_today)), p_force) || E'\n';
  v_out := v_out || public.fn_mgmt_send('fabric',     'fabric:'     || v_today, public.fn_mgmt_body_fabric(v_today), p_force);
  return v_out;
end $function$;

-- the app reads the table and the preview; never anon (see the anon definer-view leak, 18 Sep 2026)
revoke all on function public.fn_mgmt_fabric(date, int), public.fn_mgmt_body_fabric(date, int), public.fn_mgmt_m(numeric) from public, anon;
grant execute on function public.fn_mgmt_fabric(date, int), public.fn_mgmt_body_fabric(date, int), public.fn_mgmt_m(numeric) to authenticated, service_role;
