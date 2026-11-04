-- 4 Nov 2026: Expense tracking module, part 2 - who went where, fuel, ledger, audit flags.
-- Everything here is derived. Re-running fn_exp_after_capture() rebuilds it from the raw copies.

-- Who counts as paying advances. A payment proof posted by one of these becomes a to_confirm advance.
create table if not exists public.exp_payer (
  phone text primary key,
  name  text not null check (name in ('Ashmeet','Elysha'))
);
alter table public.exp_payer enable row level security;
drop policy if exists p_ops_read on public.exp_payer;
create policy p_ops_read on public.exp_payer for select to authenticated using (not public.fn_is_viewer());
revoke all on public.exp_payer from anon;
grant select on public.exp_payer to authenticated;
insert into public.exp_payer values ('971565389740', 'Ashmeet') on conflict do nothing;

-- Road km between two points: straight line times the schedule engine's road factor for that band.
create or replace function public.fn_exp_road_km(a numeric, b numeric, c numeric, d numeric)
returns numeric language sql stable as $$
  with k as (select public.fn_sched_haversine(a, b, c, d)::numeric km)
  select k.km * coalesce((select g.road_factor from public.geo_speed g
                          where g.max_km is null or k.km <= g.max_km
                          order by g.max_km nulls last limit 1), 1.3)
  from k
$$;

-- A day's route for one crew: base -> stops in order -> base.
create or replace function public.fn_exp_route_km(p_day date, p_group text, p_lat numeric, p_lng numeric)
returns numeric language plpgsql stable as $$
declare r record; v_lat numeric := p_lat; v_lng numeric := p_lng; v_km numeric := 0; v_any boolean := false;
begin
  for r in select lat, lng from public.exp_team_stop
           where day = p_day and group_id = p_group and lat is not null order by seq, order_id loop
    v_km := v_km + public.fn_exp_road_km(v_lat, v_lng, r.lat, r.lng);
    v_lat := r.lat; v_lng := r.lng; v_any := true;
  end loop;
  if not v_any then return null; end if;
  return round(v_km + public.fn_exp_road_km(v_lat, v_lng, p_lat, p_lng), 1);
end $$;

-- Read the coordinators' posts. Last post for a day wins, so a corrected schedule replaces the first.
create or replace function public.fn_exp_rebuild_teams()
returns integer language plpgsql security definer set search_path = public as $$
declare
  r record; v_group text := ''; v_day date; v_hdr timestamptz; m text[]; v_mem text; v_line text; n integer := 0;
begin
  delete from exp_team_stop where true;
  delete from exp_team_day where true;

  for r in select * from exp_team_post where body is not null order by group_id, at, wa_id loop
    if r.group_id <> v_group then v_group := r.group_id; v_day := null; end if;

    -- the header opens a day for this group
    m := regexp_match(r.body, '(?is)dear\s+team.*?\(\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*\)');
    if m is not null then
      begin
        v_day := make_date(m[3]::int, m[2]::int, m[1]::int);
      exception when others then v_day := null;
      end;
      if v_day is not null then
        v_hdr := r.at;
        v_mem := (regexp_match(r.body, '(?is)assigned\s+personnel\W*\n\s*(.+)$'))[1];
        delete from exp_team_stop where day = v_day and group_id = r.group_id;
        insert into exp_team_day(day, group_id, group_name, team_no, members)
        values (v_day, r.group_id, r.group_name,
                (regexp_match(r.group_name, '(?i)team\s*(\d+)'))[1]::int,
                coalesce((select array_agg(btrim(x)) from
                  regexp_split_to_table(coalesce(v_mem,''), '\s*(?:&|,|\n|\y[Aa][Nn][Dd]\y)\s*') x
                  where btrim(x) <> ''), '{}'))
        on conflict (day, group_id) do update set members = excluded.members, group_name = excluded.group_name;
        n := n + 1;
      end if;
      continue;
    end if;
    if v_day is null or r.at > v_hdr + interval '36 hours' then continue; end if;

    -- an order card
    m := regexp_match(r.body, '(?i)order\s*id\s*:\s*(\d{5})');
    if m is not null then
      insert into exp_team_stop(day, group_id, order_id, address, appt, note)
      values (v_day, r.group_id, m[1],
              btrim((regexp_match(r.body, '(?in)^address\s*:\s*(.*)$'))[1]),
              btrim((regexp_match(r.body, '(?in)^time\s*:\s*(.*)$'))[1]),
              btrim((regexp_match(r.body, '(?in)^remarks\s*:\s*(.*)$'))[1]))
      on conflict (day, group_id, order_id) do update set
        address = excluded.address, appt = excluded.appt,
        note = coalesce(excluded.note, exp_team_stop.note);
      continue;
    end if;

    -- the summary: "team 7 / names / 79768- new"
    if r.msg_type = 'text' and r.body ~* '^\s*team\s*\d+' then
      for v_line in select unnest(regexp_split_to_array(r.body, '\n')) loop
        m := regexp_match(v_line, '^\s*(\d{5})\s*[-–:]?\s*(.*)$');
        if m is not null then
          insert into exp_team_stop(day, group_id, order_id, note)
          values (v_day, r.group_id, m[1], nullif(btrim(m[2]), ''))
          on conflict (day, group_id, order_id) do update
            set note = coalesce(exp_team_stop.note, excluded.note);
        end if;
      end loop;
      continue;
    end if;

    -- the checklist PDFs name the order too
    m := regexp_match(r.body, 'PO-\d{8}-(\d{5})-');
    if r.msg_type = 'document' and m is not null then
      insert into exp_team_stop(day, group_id, order_id) values (v_day, r.group_id, m[1])
      on conflict do nothing;
    end if;
  end loop;

  -- Coordinates: the published day first, then the schedule engine's run, then the sheet's pin.
  update exp_team_stop s set lat = l.lat, lng = l.lng, geo_source = 'live', geo_confidence = 'high',
         address = coalesce(s.address, l.address)
    from live_order l where l.day = s.day and l.order_id = s.order_id and l.lat is not null;

  update exp_team_stop s set lat = x.lat, lng = x.lng, geo_source = 'schedule',
         geo_confidence = x.geo_confidence, address = coalesce(s.address, x.address)
    from (select distinct on (sr.sched_date, t.order_id) sr.sched_date, t.order_id, t.lat, t.lng, t.geo_confidence, t.address
          from sched_stop t join sched_run sr on sr.id = t.run_id
          where t.lat is not null and coalesce(t.geo_confidence,'none') <> 'none'
          order by sr.sched_date, t.order_id, sr.version_no desc, sr.id desc) x
   where s.lat is null and x.sched_date = s.day and x.order_id = s.order_id;

  update exp_team_stop s set lat = i.pin_lat, lng = i.pin_lng, geo_source = 'sheet', geo_confidence = 'high',
         address = coalesce(s.address, i.address)
    from installation_schedule i
   where s.lat is null and i.install_date = s.day and i.order_id = s.order_id and i.pin_lat is not null;

  update exp_team_stop s set address = i.address
    from installation_schedule i
   where s.address is null and i.install_date = s.day and i.order_id = s.order_id;

  -- Visit order: the card's time ("11/4/26 10:33 AM"), then the schedule's, then whatever is left.
  update exp_team_stop s set seq = o.rn
    from (select day, group_id, order_id,
                 row_number() over (partition by day, group_id
                   order by case when t.appt ~* '^\d{1,2}/\d{1,2}/\d{2}\s+\d{1,2}:\d{2}\s*[AP]M'
                                 then to_timestamp(t.appt, 'MM/DD/YY HH12:MI AM') end nulls last, order_id) rn
          from exp_team_stop t) o
   where o.day = s.day and o.group_id = s.group_id and o.order_id = s.order_id;

  return n;
end $$;
revoke execute on function public.fn_exp_rebuild_teams() from public, anon, authenticated;

-- A bill that is really a payment proof, from a known payer, becomes a to_confirm advance.
create or replace function public.fn_exp_ingest_payments()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with p as (
    select e.wa_id, e.day, pr.name payer, e.ocr,
      (e.ocr->>'amount')::numeric amount,
      (select h.id from exp_holder h
        where h.member_key is not null and coalesce(e.ocr->>'payee','') ~* ('\y(' || h.member_key || ')\y')
        order by h.confirmed desc, h.id limit 1) holder_id
    from exp_message e join exp_payer pr on pr.phone = e.sender_phone
    where e.ocr->>'doc_type' = 'payment_proof' and (e.ocr->>'amount') ~ '^[0-9.]+$'
      and (e.ocr->>'amount')::numeric > 0
  ), ins as (
    insert into exp_payment(holder_id, paid_on, amount, paid_by, method, reference, note, source, wa_id, status, created_by)
    select holder_id, day, amount, payer, ocr->>'merchant', ocr->>'receipt_no',
           'Payee on the proof: ' || coalesce(ocr->>'payee','not readable'), 'whatsapp', wa_id, 'to_confirm', 'auto'
    from p on conflict (wa_id) do nothing returning 1
  ) select count(*) into n from ins;
  return n;
end $$;
revoke execute on function public.fn_exp_ingest_payments() from public, anon, authenticated;

-- A sender who posts a statement gets a holder row, unconfirmed, so nobody falls out of the ledger.
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
  perform fn_exp_ingest_payments();
end $$;
revoke execute on function public.fn_exp_after_capture() from public, anon, authenticated;

-- ---------------------------------------------------------------- views (all security_invoker)

create or replace view public.v_exp_receipt with (security_invoker = true) as
select e.wa_id, e.sender_phone, e.day, e.at, e.storage_path, e.media_mime, e.media_sha,
       e.ocr->>'doc_type' doc_type, e.ocr->>'merchant' merchant,
       case when e.ocr->>'doc_date' ~ '^\d{4}-\d{2}-\d{2}$' then (e.ocr->>'doc_date')::date end doc_date,
       case when e.ocr->>'amount' ~ '^[0-9.]+$' then (e.ocr->>'amount')::numeric end amount,
       case when e.ocr->>'litres' ~ '^[0-9.]+$' then (e.ocr->>'litres')::numeric end litres,
       case when e.ocr->>'unit_price' ~ '^[0-9.]+$' then (e.ocr->>'unit_price')::numeric end unit_price,
       e.ocr->>'grade' grade, e.ocr->>'plate' plate, e.ocr->>'receipt_no' receipt_no,
       case when e.ocr->>'confidence' ~ '^[0-9.]+$' then (e.ocr->>'confidence')::numeric end confidence,
       (select s.wa_id from public.exp_statement s
         where s.sender_phone = e.sender_phone and abs(extract(epoch from s.at - e.at)) < 1800
         order by abs(extract(epoch from s.at - e.at)) limit 1) statement_wa_id
from public.exp_message e
where e.ocr is not null and coalesce(e.ocr->>'doc_type','') not in ('payment_proof','not_a_bill');

-- The month's pump price: a typed one wins, else the median of that month's fuel receipts.
create or replace view public.v_exp_fuel_price with (security_invoker = true) as
with rec as (
  select date_trunc('month', coalesce(doc_date, day))::date as month, coalesce(grade,'special') grade,
         percentile_cont(0.5) within group (order by unit_price) med, count(*) n
  from public.v_exp_receipt
  where doc_type = 'fuel' and unit_price between 1 and 10
  group by 1, 2
)
select coalesce(p.month, r.month) as month, coalesce(p.grade, r.grade) as grade,
       coalesce(p.price, round(r.med::numeric, 3)) as price,
       case when p.price is not null then 'typed' else 'receipts' end as source,
       round(r.med::numeric, 3) as receipts_median, coalesce(r.n, 0) as receipts
from public.exp_fuel_price p full join rec r on r.month = p.month and r.grade = p.grade;

create or replace function public.fn_exp_price_for(p_day date, p_grade text)
returns numeric language sql stable as $$
  select price from public.v_exp_fuel_price
  where grade = p_grade and month <= date_trunc('month', p_day)::date
  order by month desc limit 1
$$;

create or replace view public.v_exp_statement with (security_invoker = true) as
with pay as (
  select holder_id, paid_on, amount from public.exp_payment where voided_at is null and status = 'confirmed'
), s as (
  select s.*, h.id holder_id, h.display_name,
    round(coalesce(s.petrol,0)+coalesce(s.parking,0)+coalesce(s.salik,0)+coalesce(s.darb,0)
         +coalesce(s.food,0)+coalesce(s.car_wash,0)+coalesce(s.other,0), 2) lines_sum,
    lag(s.closing_claimed) over w prev_closing,
    lag(s.stmt_date) over w prev_date
  from public.exp_statement s left join public.exp_holder h on h.phone = s.sender_phone
  window w as (partition by s.sender_phone order by s.stmt_date, s.at)
)
select s.*, m.storage_path,
  (select coalesce(sum(p.amount),0) from pay p
    where p.holder_id = s.holder_id and p.paid_on > coalesce(s.prev_date, s.stmt_date) and p.paid_on <= s.stmt_date) paid_between,
  (select coalesce(sum(r.amount),0) from public.v_exp_receipt r where r.statement_wa_id = s.wa_id and r.doc_type = 'fuel') receipt_fuel,
  (select coalesce(sum(r.amount),0) from public.v_exp_receipt r where r.statement_wa_id = s.wa_id and r.doc_type in ('parking','toll')) receipt_parking,
  (select coalesce(sum(r.amount),0) from public.v_exp_receipt r where r.statement_wa_id = s.wa_id) receipt_all,
  (select count(*) from public.v_exp_receipt r where r.statement_wa_id = s.wa_id) receipts
from s join public.exp_message m using (wa_id);

-- The book: where the float should stand if every statement's real sum and every advance are right.
create or replace view public.v_exp_ledger with (security_invoker = true) as
with first_s as (
  select distinct on (sender_phone) sender_phone, stmt_date,
    coalesce(opening, closing_claimed + total_claimed) as first_opening
  from public.exp_statement order by sender_phone, stmt_date, at
), last_s as (
  select distinct on (sender_phone) sender_phone, stmt_date, closing_claimed, at
  from public.exp_statement order by sender_phone, stmt_date desc, at desc
), spent as (
  select sender_phone, sum(lines_sum) spent, sum(coalesce(petrol,0)) fuel, count(*) statements
  from public.v_exp_statement group by 1
), paid as (
  select holder_id,
    sum(amount) filter (where status = 'confirmed') paid_confirmed,
    sum(amount) filter (where status = 'to_confirm') paid_to_confirm,
    sum(amount) filter (where status = 'confirmed' and paid_by = 'Ashmeet') paid_ashmeet,
    sum(amount) filter (where status = 'confirmed' and paid_by = 'Elysha') paid_elysha,
    max(paid_on) last_paid
  from public.exp_payment where voided_at is null group by 1
)
select h.id holder_id, h.display_name, h.phone, h.active, h.confirmed, h.vehicle_plate,
  f.first_opening, f.stmt_date first_date, coalesce(sp.spent,0) spent, coalesce(sp.fuel,0) fuel,
  coalesce(sp.statements,0) statements, coalesce(pa.paid_confirmed,0) paid_confirmed,
  coalesce(pa.paid_to_confirm,0) paid_to_confirm, coalesce(pa.paid_ashmeet,0) paid_ashmeet,
  coalesce(pa.paid_elysha,0) paid_elysha, pa.last_paid, l.stmt_date last_date, l.closing_claimed,
  round(coalesce(f.first_opening,0)
        + coalesce((select sum(p.amount) from public.exp_payment p
                    where p.holder_id = h.id and p.voided_at is null and p.status = 'confirmed'
                      and (f.stmt_date is null or p.paid_on > f.stmt_date)),0)
        - coalesce(sp.spent,0), 2) book_balance
from public.exp_holder h
left join first_s f on f.sender_phone = h.phone
left join last_s l on l.sender_phone = h.phone
left join spent sp on sp.sender_phone = h.phone
left join paid pa on pa.holder_id = h.id;

-- One row per cash holder per day: orders, addresses, km, litres, cost, against the claim.
create or replace view public.v_exp_fuel_day with (security_invoker = true) as
with cfg as (
  select max(value) filter (where key='default_km_per_l') kml, max(value) filter (where key='base_lat') blat,
         max(value) filter (where key='base_lng') blng,
         max(value) filter (where key='fuel_over_pct') pct, max(value) filter (where key='fuel_over_min_aed') gap
  from public.exp_settings
), crew as (
  select h.id holder_id, d.day, d.group_id, d.group_name, d.members
  from public.exp_holder h join public.exp_team_day d
    on h.member_key is not null
   and exists (select 1 from unnest(d.members) m where m ~* ('^(' || h.member_key || ')$'))
), route as (
  select c.holder_id, c.day,
    string_agg(distinct c.group_name, ', ') groups, array_agg(distinct c.group_id) group_ids,
    sum(public.fn_exp_route_km(c.day, c.group_id, coalesce(h.base_lat, cfg.blat), coalesce(h.base_lng, cfg.blng))) km
  from crew c join public.exp_holder h on h.id = c.holder_id cross join cfg
  group by c.holder_id, c.day
), stops as (
  select c.holder_id, c.day, count(*) orders, count(s.lat) located,
    jsonb_agg(jsonb_build_object('order', s.order_id, 'address', s.address, 'appt', s.appt, 'note', s.note,
      'lat', s.lat, 'conf', s.geo_confidence) order by s.seq) stops
  from crew c join public.exp_team_stop s on s.day = c.day and s.group_id = c.group_id
  group by c.holder_id, c.day
), claim as (
  select holder_id, stmt_date as day, sum(coalesce(petrol,0)) claimed, sum(receipt_fuel) receipt_fuel
  from public.v_exp_statement where holder_id is not null group by 1, 2
), litres as (
  select h.id holder_id, coalesce(r.doc_date, r.day) as day, sum(r.litres) litres
  from public.v_exp_receipt r join public.exp_holder h on h.phone = r.sender_phone
  where r.doc_type = 'fuel' group by 1, 2
), days as (
  select holder_id, day from route union select holder_id, day from claim
)
select d.holder_id, h.display_name, d.day, r.groups, coalesce(st.orders,0) orders, coalesce(st.located,0) located,
  st.stops, r.km, coalesce(h.km_per_l, cfg.kml) km_per_l, h.km_per_l is null as kml_assumed,
  round(r.km / coalesce(h.km_per_l, cfg.kml), 1) est_litres,
  public.fn_exp_price_for(d.day, h.fuel_grade) price,
  round(r.km / coalesce(h.km_per_l, cfg.kml) * public.fn_exp_price_for(d.day, h.fuel_grade), 2) est_aed,
  coalesce(c.claimed, 0) claimed, coalesce(c.receipt_fuel, 0) receipt_fuel, l.litres receipt_litres,
  (r.km is null) as no_route,
  coalesce(c.claimed,0) - coalesce(r.km / coalesce(h.km_per_l, cfg.kml) * public.fn_exp_price_for(d.day, h.fuel_grade), 0) gap,
  (r.km is not null
   and c.claimed > r.km / coalesce(h.km_per_l, cfg.kml) * public.fn_exp_price_for(d.day, h.fuel_grade) * (1 + cfg.pct/100)
   and c.claimed - r.km / coalesce(h.km_per_l, cfg.kml) * public.fn_exp_price_for(d.day, h.fuel_grade) > cfg.gap) over_day
from days d
join public.exp_holder h on h.id = d.holder_id cross join cfg
left join route r on r.holder_id = d.holder_id and r.day = d.day
left join stops st on st.holder_id = d.holder_id and st.day = d.day
left join claim c on c.holder_id = d.holder_id and c.day = d.day
left join litres l on l.holder_id = d.holder_id and l.day = d.day;

-- Fill-ups are lumpy, so the verdict that matters is the week, not the day.
create or replace view public.v_exp_fuel_week with (security_invoker = true) as
with w as (
  select holder_id, display_name, date_trunc('week', day)::date as week_start,
    sum(km) km, sum(est_aed) est_aed, sum(est_litres) est_litres, sum(claimed) claimed,
    sum(receipt_litres) receipt_litres, sum(orders) orders,
    count(*) filter (where not no_route) route_days, count(*) filter (where no_route) no_route_days
  from public.v_exp_fuel_day group by 1, 2, 3
), cfg as (
  select max(value) filter (where key='fuel_over_pct') pct, max(value) filter (where key='fuel_over_min_aed') gap
  from public.exp_settings
), med as (
  select week_start, percentile_cont(0.5) within group (order by claimed / nullif(km,0)) aed_km
  from w where km > 0 and claimed > 0 group by 1
)
select w.*, round(w.claimed / nullif(w.km,0), 2) claimed_per_km, round(m.aed_km::numeric, 2) peers_per_km,
  (w.km > 0 and w.claimed > w.est_aed * (1 + cfg.pct/100) and w.claimed - w.est_aed > cfg.gap) outlier
from w cross join cfg left join med m on m.week_start = w.week_start;

-- Every audit question, one row per finding. flag_key is stable so a verdict sticks across rebuilds.
create or replace view public.v_exp_flags with (security_invoker = true) as
with cfg as (
  select max(value) filter (where key='match_tolerance_aed') tol,
         max(value) filter (where key='price_tolerance_pct') ptol from public.exp_settings
), f as (
  select 'sum:'||s.wa_id k, 'high' sev, 'statement_sum' typ, s.holder_id, s.display_name who, s.stmt_date as day, s.wa_id,
    abs(s.total_claimed - s.lines_sum) amount,
    format('Total says %s but the lines add up to %s', s.total_claimed, s.lines_sum) detail
  from public.v_exp_statement s, cfg where s.total_claimed is not null and abs(s.total_claimed - s.lines_sum) > cfg.tol
  union all
  select 'close:'||s.wa_id, 'high', 'closing_balance', s.holder_id, s.display_name, s.stmt_date, s.wa_id,
    abs(s.closing_claimed - (s.opening - s.lines_sum)),
    format('Opening %s minus expenses %s is %s, statement says %s', s.opening, s.lines_sum, s.opening - s.lines_sum, s.closing_claimed)
  from public.v_exp_statement s, cfg
  where s.opening is not null and s.closing_claimed is not null
    and abs(s.closing_claimed - (s.opening - s.lines_sum)) > cfg.tol
  union all
  select 'chain:'||s.wa_id, 'high', 'balance_chain', s.holder_id, s.display_name, s.stmt_date, s.wa_id,
    abs(s.opening - (s.prev_closing + s.paid_between)),
    format('Opened at %s; last closing %s plus advances %s is %s', s.opening, s.prev_closing, s.paid_between, s.prev_closing + s.paid_between)
  from public.v_exp_statement s, cfg
  where s.opening is not null and s.prev_closing is not null
    and abs(s.opening - (s.prev_closing + s.paid_between)) > cfg.tol
  union all
  select 'nofuel:'||s.wa_id, 'med', 'fuel_no_receipt', s.holder_id, s.display_name, s.stmt_date, s.wa_id, s.petrol,
    format('Petrol %s claimed, no fuel receipt found with this statement', s.petrol)
  from public.v_exp_statement s where coalesce(s.petrol,0) > 0 and s.receipt_fuel = 0
  union all
  select 'fuelamt:'||s.wa_id, 'med', 'fuel_receipt_mismatch', s.holder_id, s.display_name, s.stmt_date, s.wa_id,
    abs(s.petrol - s.receipt_fuel), format('Petrol claimed %s, fuel receipts total %s', s.petrol, s.receipt_fuel)
  from public.v_exp_statement s, cfg where s.receipt_fuel > 0 and abs(s.petrol - s.receipt_fuel) > cfg.tol
  union all
  select 'dupsha:'||r.wa_id, 'high', 'duplicate_bill', h.id, coalesce(h.display_name, r.sender_phone), r.day, r.wa_id, r.amount,
    'The same image was posted before'
  from public.v_exp_receipt r left join public.exp_holder h on h.phone = r.sender_phone
  where r.media_sha is not null and exists (select 1 from public.exp_message o
    where o.media_sha = r.media_sha and o.at < r.at)
  union all
  select 'dupno:'||r.wa_id, 'high', 'duplicate_bill', h.id, coalesce(h.display_name, r.sender_phone), r.day, r.wa_id, r.amount,
    format('Receipt number %s of %s appears twice', r.receipt_no, coalesce(r.merchant,'?'))
  from public.v_exp_receipt r left join public.exp_holder h on h.phone = r.sender_phone
  where length(coalesce(r.receipt_no,'')) >= 5 and exists (select 1 from public.v_exp_receipt o
    where o.receipt_no = r.receipt_no and coalesce(o.merchant,'') = coalesce(r.merchant,'') and o.at < r.at
      and coalesce(o.media_sha,'') <> coalesce(r.media_sha,''))
  union all
  select 'price:'||r.wa_id, 'med', 'fuel_price', h.id, coalesce(h.display_name, r.sender_phone), r.day, r.wa_id, r.amount,
    format('Receipt price %s against the month''s %s', r.unit_price, public.fn_exp_price_for(coalesce(r.doc_date, r.day), coalesce(r.grade,'special')))
  from public.v_exp_receipt r left join public.exp_holder h on h.phone = r.sender_phone, cfg
  where r.doc_type = 'fuel' and r.unit_price is not null
    and abs(r.unit_price / public.fn_exp_price_for(coalesce(r.doc_date, r.day), coalesce(r.grade,'special')) - 1) * 100 > cfg.ptol
  union all
  select 'plate:'||r.wa_id, 'med', 'wrong_vehicle', h.id, h.display_name, r.day, r.wa_id, r.amount,
    format('Receipt shows vehicle %s, %s drives %s', r.plate, h.display_name, h.vehicle_plate)
  from public.v_exp_receipt r join public.exp_holder h on h.phone = r.sender_phone
  where h.vehicle_plate is not null and r.plate is not null and r.plate ~ '\d{3}'
    and r.plate !~ h.vehicle_plate and r.doc_type in ('fuel','parking')
  union all
  select 'date:'||r.wa_id, 'low', 'old_bill', h.id, coalesce(h.display_name, r.sender_phone), r.day, r.wa_id, r.amount,
    format('Bill dated %s posted on %s', r.doc_date, r.day)
  from public.v_exp_receipt r left join public.exp_holder h on h.phone = r.sender_phone
  where r.doc_date is not null and abs(r.day - r.doc_date) > 3
  union all
  select 'over:'||w.holder_id||':'||w.week_start, 'high', 'fuel_outlier', w.holder_id, w.display_name, w.week_start, null, w.claimed - w.est_aed,
    format('Week of %s: claimed AED %s of fuel, estimate AED %s for %s km', w.week_start, w.claimed, round(w.est_aed,0), round(w.km,0))
  from public.v_exp_fuel_week w where w.outlier
  union all
  select 'nostmt:'||d.holder_id||':'||d.day, 'low', 'no_statement', d.holder_id, d.display_name, d.day, null, null,
    format('Worked %s with %s orders, no statement received', d.groups, d.orders)
  from public.v_exp_fuel_day d
  where d.orders > 0 and d.day < (now() at time zone 'Asia/Dubai')::date
    and not exists (select 1 from public.v_exp_statement s where s.holder_id = d.holder_id and s.stmt_date = d.day)
  union all
  select 'topup:'||s.wa_id, 'med', 'topup_unmatched', s.holder_id, s.display_name, s.stmt_date, s.wa_id, s.topup,
    format('Statement shows a top-up of %s, no advance recorded around that date', s.topup)
  from public.v_exp_statement s
  where s.topup is not null and not exists (select 1 from public.exp_payment p
    where p.holder_id = s.holder_id and p.voided_at is null and p.amount = s.topup
      and abs(p.paid_on - s.stmt_date) <= 3)
  union all
  select 'pay:'||p.id, 'med', 'payment_to_confirm', p.holder_id, h.display_name, p.paid_on, p.wa_id, p.amount,
    format('Payment proof from %s to confirm. %s', p.paid_by, coalesce(p.note,''))
  from public.exp_payment p left join public.exp_holder h on h.id = p.holder_id
  where p.status = 'to_confirm' and p.voided_at is null
  union all
  select 'who:'||h.id, 'low', 'holder_unconfirmed', h.id, h.display_name, null, null, null,
    'Check this person''s name, vehicle and team name'
  from public.exp_holder h where not h.confirmed and h.active
)
select f.k flag_key, f.sev severity, f.typ flag_type, f.holder_id, f.who, f.day, f.wa_id, round(f.amount, 2) amount, f.detail,
  r.status review_status, r.note review_note, r.reviewed_by, r.reviewed_at, m.storage_path
from f
left join public.exp_flag_review r on r.flag_key = f.k
left join public.exp_message m on m.wa_id = f.wa_id;

grant select on public.v_exp_receipt, public.v_exp_fuel_price, public.v_exp_statement, public.v_exp_ledger,
  public.v_exp_fuel_day, public.v_exp_fuel_week, public.v_exp_flags to authenticated;

-- ---------------------------------------------------------------- writes from the app

create or replace function public.fn_exp_guard()
returns text language plpgsql stable as $$
begin
  if public.fn_is_viewer() then raise exception 'Read-only accounts cannot change expenses'; end if;
  return coalesce(auth.jwt()->>'email', 'unknown');
end $$;

create or replace function public.fn_exp_add_payment(p_holder bigint, p_date date, p_amount numeric,
  p_paid_by text, p_method text default null, p_reference text default null, p_note text default null)
returns bigint language plpgsql as $$
declare v_who text := public.fn_exp_guard(); v_id bigint;
begin
  insert into public.exp_payment(holder_id, paid_on, amount, paid_by, method, reference, note, created_by)
  values (p_holder, p_date, p_amount, p_paid_by, p_method, p_reference, p_note, v_who) returning id into v_id;
  return v_id;
end $$;

create or replace function public.fn_exp_confirm_payment(p_id bigint, p_holder bigint, p_paid_by text)
returns void language plpgsql as $$
declare v_who text := public.fn_exp_guard();
begin
  update public.exp_payment set status = 'confirmed', holder_id = p_holder, paid_by = p_paid_by,
    note = trim(coalesce(note,'') || ' Confirmed by ' || v_who)
  where id = p_id and voided_at is null;
  if not found then raise exception 'Payment % not found', p_id; end if;
end $$;

create or replace function public.fn_exp_void_payment(p_id bigint, p_reason text)
returns void language plpgsql as $$
declare v_who text := public.fn_exp_guard();
begin
  if coalesce(btrim(p_reason),'') = '' then raise exception 'Give a reason to void a payment'; end if;
  update public.exp_payment set voided_at = now(), voided_by = v_who, void_reason = p_reason
  where id = p_id and voided_at is null;
  if not found then raise exception 'Payment % not found', p_id; end if;
end $$;

create or replace function public.fn_exp_review_flag(p_key text, p_status text, p_note text default null)
returns void language plpgsql as $$
declare v_who text := public.fn_exp_guard();
begin
  insert into public.exp_flag_review(flag_key, status, note, reviewed_by)
  values (p_key, p_status, p_note, v_who)
  on conflict (flag_key) do update set status = excluded.status, note = excluded.note,
    reviewed_by = excluded.reviewed_by, reviewed_at = now();
end $$;

create or replace function public.fn_exp_save_holder(p_id bigint, p_name text, p_member_key text,
  p_plate text, p_km_per_l numeric, p_grade text, p_active boolean, p_confirmed boolean)
returns void language plpgsql as $$
declare v_who text := public.fn_exp_guard();
begin
  update public.exp_holder set display_name = p_name, member_key = nullif(btrim(p_member_key),''),
    vehicle_plate = nullif(btrim(p_plate),''), km_per_l = p_km_per_l, fuel_grade = p_grade,
    active = p_active, confirmed = p_confirmed, updated_at = now(), updated_by = v_who
  where id = p_id;
  if not found then raise exception 'Holder % not found', p_id; end if;
end $$;

create or replace function public.fn_exp_save_price(p_month date, p_grade text, p_price numeric, p_note text default null)
returns void language plpgsql as $$
declare v_who text := public.fn_exp_guard();
begin
  insert into public.exp_fuel_price(month, grade, price, note, updated_by)
  values (date_trunc('month', p_month)::date, p_grade, p_price, p_note, v_who)
  on conflict (month, grade) do update set price = excluded.price, note = excluded.note,
    updated_by = excluded.updated_by, updated_at = now();
end $$;

create or replace function public.fn_exp_save_setting(p_key text, p_value numeric)
returns void language plpgsql as $$
declare v_who text := public.fn_exp_guard();
begin
  update public.exp_settings set value = p_value, updated_at = now(), updated_by = v_who where key = p_key;
  if not found then raise exception 'Unknown setting %', p_key; end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'fn_exp_add_payment(bigint,date,numeric,text,text,text,text)',
    'fn_exp_confirm_payment(bigint,bigint,text)', 'fn_exp_void_payment(bigint,text)',
    'fn_exp_review_flag(text,text,text)',
    'fn_exp_save_holder(bigint,text,text,text,numeric,text,boolean,boolean)',
    'fn_exp_save_price(date,text,numeric,text)', 'fn_exp_save_setting(text,numeric)']
  loop
    execute 'revoke execute on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

-- People seen in the group so far. Names are read from WhatsApp, confirmed=false until someone checks.
insert into public.exp_holder(phone, display_name, member_key, note) values
  ('971565927515', 'Maruf',        'maruf',                     'WhatsApp name Ahmed_Maruf'),
  ('971551468033', 'Maruf 2',      'maruf\s*2|mayruf',          'WhatsApp name Mayruf Ahmed; in the Maruf 2 team groups'),
  ('971525290846', 'Kaleem',       'kaleem',                    null),
  ('971508203929', 'Mohsin',       'mohsin',                    'WhatsApp name Ismail Mohsin'),
  ('971506350364', 'Asif',         'asif',                      'WhatsApp name Muhammed Asif'),
  ('971569424473', 'Mijano?',      'mijano|mijanu|mizanur',     'WhatsApp name Only. Guess: in the Team 5 group and paid 500 on 2 Nov'),
  ('971526886948', 'Rana Shahbaz', 'shahbaz|shahabaz|rana',     'In no Team group')
on conflict (phone) do nothing;

select public.fn_exp_after_capture();

do $$ begin
  perform cron.unschedule('handpicked-expense-capture');
exception when others then null;
end $$;
-- 06:00-07:40 Dubai, every 20 minutes: the first run does the work, the rest finish what time cut short.
select cron.schedule('handpicked-expense-capture', '*/20 2-3 * * *',
  $$select public.fn_exp_run_capture('cron', 3)$$);
