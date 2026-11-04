-- 4 Nov 2026: Expense tracking, part 3 - tuning after looking at the first real week.
--
-- The route estimate only counts base -> stops -> base, and crews fill up in lumps, so nearly every
-- claim sits above it. "Above the estimate" alone would flag the whole fleet and teach everyone to
-- ignore the list. An OUTLIER now needs a finished week with routes for every day, AND to be above
-- the estimate, AND to be well above the fleet's own AED per km. A week that fails only the first
-- test is 'watch', which is amber and raises no audit flag.

insert into public.exp_settings(key, value, note) values
  ('peer_over_pct', 25, 'An outlier must also be this % above the fleet''s AED per km that week')
on conflict (key) do nothing;

-- Crew names as typed: "*Gourav", "Shaju + Musa". And two people are called Maruf: in a "Maruf 2"
-- group a bare "Maruf" is the second one.
create or replace function public.fn_exp_clean_members()
returns void language plpgsql security definer set search_path = public as $$
begin
  update exp_team_day d set members = c.members
    from (select t.day, t.group_id,
            array_agg(case when t.group_name ~* 'maruf\s*2' and p ~* '^maruf$' then 'Maruf 2' else p end) members
          from exp_team_day t
          cross join lateral (
            select btrim(regexp_replace(x, '[*_]', '', 'g')) p
            from unnest(t.members) u, regexp_split_to_table(u, '\s*\+\s*') x
          ) q
          where q.p <> '' group by t.day, t.group_id, t.group_name) c
   where c.day = d.day and c.group_id = d.group_id and c.members is distinct from d.members;
end $$;
revoke execute on function public.fn_exp_clean_members() from public, anon, authenticated;

create or replace function public.fn_exp_after_capture()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform fn_exp_parse_all();
  insert into exp_holder(phone, display_name, note)
  select distinct on (s.sender_phone) s.sender_phone, coalesce(e.sender_name, s.sender_phone), 'Added automatically: name it'
  from exp_statement s join exp_message e using (wa_id)
  where s.sender_phone is not null and s.sender_phone not in (select phone from exp_payer)
  order by s.sender_phone, s.at desc
  on conflict (phone) do nothing;
  perform fn_exp_rebuild_teams();
  perform fn_exp_clean_members();
  perform fn_exp_ingest_payments();
end $$;
revoke execute on function public.fn_exp_after_capture() from public, anon, authenticated;

create or replace view public.v_exp_fuel_week with (security_invoker = true) as
with w as (
  select holder_id, display_name, date_trunc('week', day)::date as week_start,
    sum(km) km, sum(est_aed) est_aed, sum(est_litres) est_litres, sum(claimed) claimed,
    sum(receipt_litres) receipt_litres, sum(orders) orders,
    count(*) filter (where not no_route) route_days, count(*) filter (where no_route) no_route_days
  from public.v_exp_fuel_day group by 1, 2, 3
), cfg as (
  select max(value) filter (where key='fuel_over_pct') pct, max(value) filter (where key='fuel_over_min_aed') gap,
         max(value) filter (where key='peer_over_pct') peer
  from public.exp_settings
), med as (
  select week_start, percentile_cont(0.5) within group (order by claimed / nullif(km,0)) aed_km
  from w where km > 0 and claimed > 0 and no_route_days = 0 group by 1
), j as (
  select w.*, cfg.pct, cfg.gap, cfg.peer,
    round(w.claimed / nullif(w.km,0), 2) claimed_per_km, round(m.aed_km::numeric, 2) peers_per_km,
    (w.km > 0 and w.claimed > w.est_aed * (1 + cfg.pct/100) and w.claimed - w.est_aed > cfg.gap) above_est,
    (w.no_route_days = 0 and w.week_start + 7 <= (now() at time zone 'Asia/Dubai')::date) complete
  from w cross join cfg left join med m on m.week_start = w.week_start
)
select holder_id, display_name, week_start, km, est_aed, est_litres, claimed, receipt_litres, orders,
  route_days, no_route_days, claimed_per_km, peers_per_km,
  coalesce(above_est and complete and claimed_per_km > peers_per_km * (1 + peer/100), false) outlier,
  coalesce(above_est and not (complete and claimed_per_km > peers_per_km * (1 + peer/100)), false) watch,
  complete
from j;

-- Statements only exist from the day someone joined the group, so older days are not "missing".
alter view public.v_exp_flags rename to v_exp_flags_raw;
create view public.v_exp_flags with (security_invoker = true) as
select f.* from public.v_exp_flags_raw f
where not (f.flag_type = 'no_statement' and f.day <
  coalesce((select min(s.stmt_date) from public.v_exp_statement s where s.holder_id = f.holder_id), 'infinity'::date));
grant select on public.v_exp_flags, public.v_exp_flags_raw to authenticated;

select public.fn_exp_after_capture();
