-- 10 Nov 2026 (user). Four additions, one file:
--   A. Stage 4 (live day): a second note per order, separate from the Stage 3 note; the coordinator's
--      daily invoicing confirmation (ready to invoice? any adjustment?); adjustments booked through the
--      Installation sheet are linked to the live day; v_live_invoicing is what Finance downloads.
--   B. ISR cases (issue resolution) - Production > ISR, and the cards Stage 2 of the stepper drags in.
--   C. Fabric / material received before its PO email (manual_receipt) - matched to the PO's
--      receiving_expectations the moment those rows are created.
--   D. Tailors (MD Tailors module + the Planning tailor dropdown): tailors, rates, per-order tailor,
--      editable American / Wave counts, payment status.
-- Every write is a SECURITY DEFINER function that calls fn_live_guard() (read-only roles refused, the
-- caller's email recorded). Tables are read-only to the browser.

-- ================================================================ A. Stage 4
alter table public.live_order
  add column if not exists live_note text,
  add column if not exists invoice_state text,
  add column if not exists adj_state text,
  add column if not exists invoice_note text,
  add column if not exists invoice_by text,
  add column if not exists invoice_at timestamptz,
  add column if not exists isr_id bigint;
alter table public.live_order drop constraint if exists live_order_invoice_state_check;
alter table public.live_order add constraint live_order_invoice_state_check check (invoice_state is null or invoice_state in ('ready','not_ready'));
alter table public.live_order drop constraint if exists live_order_adj_state_check;
alter table public.live_order add constraint live_order_adj_state_check check (adj_state is null or adj_state in ('none','has'));

create or replace function public.fn_live_live_note(p_day date, p_city text, p_order text, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); t int;
begin
  update public.live_order set live_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now(), updated_by = who
   where day = p_day and city = p_city and order_id = p_order returning team into t;
  if not found then raise exception 'Order % is not on that live day', p_order using errcode = 'P0001'; end if;
  perform public.fn_live_log(p_day, p_city, p_order, t, who, 'live_note', jsonb_build_object('note', p_note));
end $$;

-- p_invoice: 'ready' | 'not_ready' | null (not confirmed yet); p_adj: 'none' | 'has' | null
create or replace function public.fn_live_set_invoice(p_day date, p_city text, p_order text, p_invoice text, p_adj text, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); t int;
begin
  if p_invoice is not null and p_invoice not in ('ready','not_ready') then raise exception 'Unknown invoicing state %', p_invoice using errcode = 'P0001'; end if;
  if p_adj is not null and p_adj not in ('none','has') then raise exception 'Unknown adjustment state %', p_adj using errcode = 'P0001'; end if;
  update public.live_order set invoice_state = p_invoice, adj_state = p_adj,
         invoice_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), invoice_note),
         invoice_by = who, invoice_at = now(), updated_at = now(), updated_by = who
   where day = p_day and city = p_city and order_id = p_order returning team into t;
  if not found then raise exception 'Order % is not on that live day', p_order using errcode = 'P0001'; end if;
  perform public.fn_live_log(p_day, p_city, p_order, t, who, 'invoice', jsonb_build_object('invoice', p_invoice, 'adj', p_adj, 'note', p_note));
end $$;

-- adjustments booked for the order through the Installation sheet (opened from Stage 4) carry the
-- person's email as captured_by, not 'live:'; link every one made since the morning of the job day so
-- the live card shows it. Returns how many were linked.
create or replace function public.fn_live_link_adjustments(p_day date, p_city text, p_order text)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); n int;
begin
  insert into public.live_adjustment(day, city, order_id, alert_id, created_by)
  select p_day, p_city, p_order, a.id, who from public.accounting_alerts a
   where a.order_id = p_order and a.created_at >= (p_day::timestamp - interval '4 hours') and a.status <> 'dropped'
     and not exists (select 1 from public.live_adjustment l where l.alert_id = a.id)
     and exists (select 1 from public.live_order o where o.day = p_day and o.city = p_city and o.order_id = p_order);
  get diagnostics n = row_count;
  return n;
end $$;

-- what Finance downloads: every live order in a date range with its outcome, the coordinator's
-- confirmation and every adjustment of the order that is not yet invoiced or dropped
create or replace view public.v_live_invoicing with (security_invoker = true) as
select o.day, o.city, o.team, t.name as team_name, array_to_string(t.members, ' & ') as crew,
       o.order_id, o.customer, o.address, o.plan_start, o.plan_end, o.status as live_status, o.reason as live_reason, o.resched_to,
       o.note as plan_note, o.live_note, o.invoice_state, o.adj_state, o.invoice_note, o.invoice_by, o.invoice_at,
       os.status as installation_status,
       coalesce(a.n_open, 0) as adj_open_count, coalesce(a.open_amount, 0) as adj_open_amount,
       coalesce(a.n_all, 0) as adj_count, coalesce(a.all_amount, 0) as adj_amount,
       a.lines as adj_lines, o.status_at, o.status_by
  from public.live_order o
  left join public.live_team t on t.day = o.day and t.city = o.city and t.team = o.team
  left join public.order_status os on os.order_id = o.order_id
  left join lateral (
    select count(*) filter (where x.status in ('new','reviewed')) as n_open,
           round(sum(coalesce(x.agreed_amount_aed, x.suggested_amount_aed, 0)) filter (where x.status in ('new','reviewed') and x.chargeable), 2) as open_amount,
           count(*) as n_all,
           round(sum(coalesce(x.agreed_amount_aed, x.suggested_amount_aed, 0)) filter (where x.chargeable), 2) as all_amount,
           string_agg(format('%s AED %s (%s%s)', replace(x.charge_type, '_', ' '), round(coalesce(x.agreed_amount_aed, x.suggested_amount_aed, 0), 2),
                             x.status, case when x.chargeable then '' else ', not charged' end)
                      || coalesce(': ' || split_part(x.reason, E'\n', 1), ''), ' | ' order by x.id) as lines
      from public.accounting_alerts x where x.order_id = o.order_id and x.status <> 'dropped') a on true
 where o.status <> 'removed';
grant select on public.v_live_invoicing to authenticated;

-- ================================================================ B. ISR cases
create table if not exists public.isr_case (
  id bigserial primary key,
  order_id text not null,
  customer text, city text, address text,
  isr_type text not null default 'others',
  source text not null default 'others_kurtains',
  issue text not null,
  expected_back text,          -- curtain / blind / track coming back from site
  expected_new text,           -- new fabric / blind / track / motor to arrive
  received boolean not null default false, received_at timestamptz, received_by text,
  ready boolean not null default false, ready_at timestamptz, ready_by text,
  return_supplier boolean not null default false, return_note text, return_at timestamptz, return_by text,
  status text not null default 'open',
  sched_day date, sched_city text, sched_team integer,
  created_at timestamptz not null default now(), created_by text,
  updated_at timestamptz not null default now(), updated_by text,
  constraint isr_case_type_check check (isr_type in ('on_the_spot','new_fabric','planned_alteration','unplanned_alteration','others')),
  constraint isr_case_source_check check (source in ('production','installation','consultation','client_change_of_mind','fabric','others_kurtains')),
  constraint isr_case_status_check check (status in ('open','scheduled','done','cancelled')));
create index if not exists isr_case_order on public.isr_case(order_id);
create index if not exists isr_case_status on public.isr_case(status);

create table if not exists public.isr_event (
  id bigserial primary key, isr_id bigint not null references public.isr_case(id) on delete cascade,
  at timestamptz not null default now(), who text, kind text, detail jsonb);
create index if not exists isr_event_case on public.isr_event(isr_id, at desc);

-- readiness the filters use: waiting (nothing back / nothing ready yet), received, ready
create or replace view public.v_isr_cases with (security_invoker = true) as
select c.*,
       case when c.ready then 'ready' when c.received then 'received' else 'waiting' end as readiness,
       r.installation_date, coalesce(c.city, r.city) as city_any, coalesce(c.customer, r.customer_name) as customer_any
  from public.isr_case c left join public.v_ops_order_roster r on r.order_id = c.order_id;
grant select on public.v_isr_cases to authenticated;

-- p: {id?, order_id, customer, city, address, isr_type, source, issue, expected_back, expected_new}
create or replace function public.fn_isr_save(p jsonb)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); v_id bigint := nullif(p ->> 'id', '')::bigint;
begin
  if coalesce(btrim(p ->> 'order_id'), '') = '' then raise exception 'Order number is needed' using errcode = 'P0001'; end if;
  if coalesce(btrim(p ->> 'issue'), '') = '' then raise exception 'Describe the issue' using errcode = 'P0001'; end if;
  if v_id is null then
    insert into public.isr_case(order_id, customer, city, address, isr_type, source, issue, expected_back, expected_new, created_by, updated_by)
    values (btrim(p ->> 'order_id'), nullif(p ->> 'customer', ''), nullif(p ->> 'city', ''), nullif(p ->> 'address', ''),
            coalesce(nullif(p ->> 'isr_type', ''), 'others'), coalesce(nullif(p ->> 'source', ''), 'others_kurtains'),
            btrim(p ->> 'issue'), nullif(btrim(coalesce(p ->> 'expected_back', '')), ''), nullif(btrim(coalesce(p ->> 'expected_new', '')), ''), who, who)
    returning id into v_id;
    insert into public.isr_event(isr_id, who, kind, detail) values (v_id, who, 'created', p);
  else
    update public.isr_case set order_id = btrim(p ->> 'order_id'), customer = nullif(p ->> 'customer', ''), city = nullif(p ->> 'city', ''),
           address = nullif(p ->> 'address', ''), isr_type = coalesce(nullif(p ->> 'isr_type', ''), isr_type),
           source = coalesce(nullif(p ->> 'source', ''), source), issue = btrim(p ->> 'issue'),
           expected_back = nullif(btrim(coalesce(p ->> 'expected_back', '')), ''), expected_new = nullif(btrim(coalesce(p ->> 'expected_new', '')), ''),
           updated_at = now(), updated_by = who
     where id = v_id;
    if not found then raise exception 'ISR % no longer exists', v_id using errcode = 'P0001'; end if;
    insert into public.isr_event(isr_id, who, kind, detail) values (v_id, who, 'edited', p);
  end if;
  return v_id;
end $$;

-- p_flag: received | ready | return_supplier | done | cancelled | reopen
create or replace function public.fn_isr_flag(p_id bigint, p_flag text, p_on boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard();
begin
  if p_flag = 'received' then
    update public.isr_case set received = p_on, received_at = case when p_on then now() end, received_by = case when p_on then who end, updated_at = now(), updated_by = who where id = p_id;
  elsif p_flag = 'ready' then
    update public.isr_case set ready = p_on, ready_at = case when p_on then now() end, ready_by = case when p_on then who end, updated_at = now(), updated_by = who where id = p_id;
  elsif p_flag = 'return_supplier' then
    update public.isr_case set return_supplier = p_on, return_note = case when p_on then coalesce(nullif(btrim(coalesce(p_note, '')), ''), return_note) end,
           return_at = case when p_on then now() end, return_by = case when p_on then who end, updated_at = now(), updated_by = who where id = p_id;
  elsif p_flag in ('done','cancelled') then
    update public.isr_case set status = case when p_on then p_flag else 'open' end, updated_at = now(), updated_by = who where id = p_id;
  elsif p_flag = 'reopen' then
    update public.isr_case set status = 'open', sched_day = null, sched_city = null, sched_team = null, updated_at = now(), updated_by = who where id = p_id;
  else
    raise exception 'Unknown ISR flag %', p_flag using errcode = 'P0001';
  end if;
  if not found then raise exception 'ISR % no longer exists', p_id using errcode = 'P0001'; end if;
  insert into public.isr_event(isr_id, who, kind, detail) values (p_id, who, p_flag, jsonb_build_object('on', p_on, 'note', p_note));
end $$;

-- put on (p_day not null) or take off (p_day null) a day's schedule - called by the stepper's Stage 2
create or replace function public.fn_isr_schedule(p_id bigint, p_day date, p_city text default null, p_team integer default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard();
begin
  update public.isr_case set sched_day = p_day, sched_city = case when p_day is null then null else p_city end,
         sched_team = case when p_day is null then null else p_team end,
         status = case when status in ('done','cancelled') then status when p_day is null then 'open' else 'scheduled' end,
         updated_at = now(), updated_by = who
   where id = p_id;
  if not found then raise exception 'ISR % no longer exists', p_id using errcode = 'P0001'; end if;
  insert into public.isr_event(isr_id, who, kind, detail) values (p_id, who, case when p_day is null then 'unscheduled' else 'scheduled' end,
         jsonb_build_object('day', p_day, 'city', p_city, 'team', p_team));
end $$;

-- ================================================================ C. received before the PO email
create table if not exists public.manual_receipt (
  id bigserial primary key,
  order_id text not null,
  po_number text,
  grain text not null default 'order_fabric',
  fabric_code text,            -- fabric name / code as typed
  description text,            -- material description
  qty numeric, uom text,
  note text,
  received_at timestamptz not null default now(), received_by text,
  matched_expectation_id bigint references public.receiving_expectations(id) on delete set null,
  matched_at timestamptz,
  cancelled boolean not null default false,
  constraint manual_receipt_grain_check check (grain in ('order_fabric','material')));
create index if not exists manual_receipt_order on public.manual_receipt(order_id) where matched_expectation_id is null and not cancelled;

create or replace function public.fn_norm_code(t text) returns text language sql immutable as $$
  select nullif(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', '', 'g'), '') $$;

-- Match every unmatched receipt of the order (or of every order, p_order null) to a PO expectation:
-- fabric by code ignoring case, spaces and dashes; material by description either way round. A match
-- marks the expectation received (partial when less arrived than the PO says) through
-- fn_ops_set_receiving, so receiving_events, the roster and the 3D sheet sync all see it.
create or replace function public.fn_manual_receipts_match(p_order text default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare m record; e record; n int := 0;
begin
  for m in select * from public.manual_receipt
            where matched_expectation_id is null and not cancelled and (p_order is null or order_id = p_order) order by id loop
    select r.* into e from public.receiving_expectations r
     where r.order_id = m.order_id and r.status in ('pending','ordered','partial')
       and not exists (select 1 from public.manual_receipt x where x.matched_expectation_id = r.id)
       and case when m.grain = 'order_fabric'
                then r.grain = 'order_fabric' and public.fn_norm_code(r.fabric_code) = public.fn_norm_code(m.fabric_code)
                else r.grain <> 'order_fabric' and coalesce(m.description, m.fabric_code) is not null
                     and (lower(r.item_description) like '%' || lower(btrim(coalesce(m.description, m.fabric_code))) || '%'
                          or lower(coalesce(m.description, m.fabric_code)) like '%' || lower(btrim(r.item_description)) || '%') end
     order by r.id limit 1;
    if found then
      perform public.fn_ops_set_receiving(array[e.id],
        case when m.qty is not null and e.qty_expected is not null and m.qty < e.qty_expected * 0.98 then 'partial' else 'received' end,
        null, coalesce(m.received_by, 'manual receipt'), 'Received before the PO email (manual receipt #' || m.id || ')');
      update public.manual_receipt set matched_expectation_id = e.id, matched_at = now() where id = m.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- p_items: [{grain: 'order_fabric'|'material', fabric_code, description, qty, uom, note}]
create or replace function public.fn_manual_receive(p_order text, p_po text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); it jsonb; n int := 0; matched int;
begin
  if coalesce(btrim(p_order), '') = '' then raise exception 'Order number is needed' using errcode = 'P0001'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if coalesce(btrim(it ->> 'fabric_code'), '') = '' and coalesce(btrim(it ->> 'description'), '') = '' then continue; end if;
    insert into public.manual_receipt(order_id, po_number, grain, fabric_code, description, qty, uom, note, received_by)
    values (btrim(p_order), nullif(btrim(coalesce(p_po, '')), ''), case when it ->> 'grain' = 'material' then 'material' else 'order_fabric' end,
            nullif(btrim(coalesce(it ->> 'fabric_code', '')), ''), nullif(btrim(coalesce(it ->> 'description', '')), ''),
            nullif(it ->> 'qty', '')::numeric, coalesce(nullif(it ->> 'uom', ''), case when it ->> 'grain' = 'material' then 'pc' else 'm' end),
            nullif(btrim(coalesce(it ->> 'note', '')), ''), who);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Type at least one fabric or material' using errcode = 'P0001'; end if;
  matched := public.fn_manual_receipts_match(btrim(p_order));
  return jsonb_build_object('saved', n, 'matched', matched);
end $$;

create or replace function public.fn_manual_receipt_cancel(p_id bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard();
begin
  update public.manual_receipt set cancelled = true, note = coalesce(note || ' | ', '') || 'cancelled by ' || who where id = p_id and matched_expectation_id is null;
end $$;

-- the PO email arrives -> its expectations are created -> match what was received before it
create or replace function public.fn_trg_manual_receipt_match() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.manual_receipt m where m.order_id = new.order_id and m.matched_expectation_id is null and not m.cancelled) then
    perform public.fn_manual_receipts_match(new.order_id);
  end if;
  return null;
end $$;
drop trigger if exists trg_manual_receipt_match on public.receiving_expectations;
create constraint trigger trg_manual_receipt_match after insert on public.receiving_expectations
  deferrable initially deferred for each row execute function public.fn_trg_manual_receipt_match();

-- ================================================================ D. tailors
create table if not exists public.tailor (
  name text primary key, active boolean not null default true,
  created_at timestamptz not null default now(), created_by text);
insert into public.tailor(name, created_by) values ('Belal','seed'), ('Shahzad','seed'), ('Faruk','seed'), ('Ali','seed'), ('Jamal','seed')
on conflict (name) do nothing;

-- tailor '*' is everybody without a row of their own
create table if not exists public.tailor_rate (
  tailor text not null, style text not null, rate_aed numeric not null,
  updated_at timestamptz not null default now(), updated_by text,
  primary key (tailor, style),
  constraint tailor_rate_style_check check (style in ('american','wave')));
insert into public.tailor_rate(tailor, style, rate_aed, updated_by) values
  ('*','american',5,'seed'), ('*','wave',7,'seed'), ('Ali','american',4,'seed'), ('Ali','wave',6,'seed')
on conflict do nothing;

create table if not exists public.order_tailor (
  order_id text primary key,
  tailor text references public.tailor(name) on update cascade,
  american_qty numeric,        -- null = take it from the PO (v_ops_report_orders.american_meters)
  wave_qty numeric,            -- null = take it from the PO (wave_meters)
  payment_status text not null default 'unpaid',
  paid_amount numeric, paid_on date, pay_note text,
  updated_at timestamptz not null default now(), updated_by text,
  constraint order_tailor_pay_check check (payment_status in ('unpaid','paid','partial','hold')));

do $$ declare t text; begin
  foreach t in array array['isr_case','isr_event','manual_receipt','tailor','tailor_rate','order_tailor'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists p_read_all on public.%I', t);
    execute format('create policy p_read_all on public.%I for select to authenticated using (true)', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

create or replace function public.fn_tailor_add(p_name text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); n text := initcap(btrim(coalesce(p_name, '')));
begin
  if n = '' then raise exception 'Type the tailor''s name' using errcode = 'P0001'; end if;
  n := coalesce((select x.name from public.tailor x where lower(x.name) = lower(n) limit 1), n);
  insert into public.tailor(name, created_by) values (n, who) on conflict (name) do update set active = true;
  return n;
end $$;

-- p: {tailor?, american_qty?, wave_qty?, payment_status?, paid_amount?, paid_on?, pay_note?} - only the keys sent change
create or replace function public.fn_order_tailor_set(p_order text, p jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard();
begin
  if coalesce(btrim(p_order), '') = '' then raise exception 'Order number is needed' using errcode = 'P0001'; end if;
  insert into public.order_tailor(order_id, updated_by) values (btrim(p_order), who) on conflict (order_id) do nothing;
  update public.order_tailor set
    tailor         = case when p ? 'tailor' then nullif(p ->> 'tailor', '') else tailor end,
    american_qty   = case when p ? 'american_qty' then nullif(p ->> 'american_qty', '')::numeric else american_qty end,
    wave_qty       = case when p ? 'wave_qty' then nullif(p ->> 'wave_qty', '')::numeric else wave_qty end,
    payment_status = case when p ? 'payment_status' then coalesce(nullif(p ->> 'payment_status', ''), 'unpaid') else payment_status end,
    paid_amount    = case when p ? 'paid_amount' then nullif(p ->> 'paid_amount', '')::numeric else paid_amount end,
    paid_on        = case when p ? 'paid_on' then nullif(p ->> 'paid_on', '')::date
                          when p ->> 'payment_status' = 'paid' and paid_on is null then (now() at time zone 'Asia/Dubai')::date else paid_on end,
    pay_note       = case when p ? 'pay_note' then nullif(p ->> 'pay_note', '') else pay_note end,
    updated_at = now(), updated_by = who
  where order_id = btrim(p_order);
end $$;

create or replace function public.fn_tailor_rate_set(p_tailor text, p_style text, p_rate numeric)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard();
begin
  if p_rate is null then delete from public.tailor_rate where tailor = p_tailor and style = p_style and tailor <> '*'; return; end if;
  insert into public.tailor_rate(tailor, style, rate_aed, updated_by) values (p_tailor, p_style, p_rate, who)
  on conflict (tailor, style) do update set rate_aed = excluded.rate_aed, updated_at = now(), updated_by = who;
end $$;

-- one row per order that has a tailor: received date, counts (typed, else the PO's metres), amount
create or replace view public.v_md_tailors with (security_invoker = true) as
select t.order_id, t.tailor, r.customer_name, r.city, r.installation_date,
       coalesce(rc.received_date, r.installation_date) as received_date,
       round(coalesce(r.american_meters, 0), 2) as american_po, round(coalesce(r.wave_meters, 0), 2) as wave_po,
       coalesce(t.american_qty, round(coalesce(r.american_meters, 0), 2)) as american_qty,
       coalesce(t.wave_qty, round(coalesce(r.wave_meters, 0), 2)) as wave_qty,
       t.american_qty is not null as american_edited, t.wave_qty is not null as wave_edited,
       coalesce(ra.rate_aed, rd.rate_aed) as american_rate, coalesce(rw.rate_aed, rwd.rate_aed) as wave_rate,
       round(coalesce(t.american_qty, coalesce(r.american_meters, 0)) * coalesce(ra.rate_aed, rd.rate_aed, 0)
           + coalesce(t.wave_qty, coalesce(r.wave_meters, 0)) * coalesce(rw.rate_aed, rwd.rate_aed, 0), 2) as amount_aed,
       t.payment_status, t.paid_amount, t.paid_on, t.pay_note, t.updated_at, t.updated_by
  from public.order_tailor t
  left join public.v_ops_report_orders r on r.order_id = t.order_id
  left join public.v_mgmt_order_received rc on rc.order_id = t.order_id
  left join public.tailor_rate ra on ra.tailor = t.tailor and ra.style = 'american'
  left join public.tailor_rate rd on rd.tailor = '*' and rd.style = 'american'
  left join public.tailor_rate rw on rw.tailor = t.tailor and rw.style = 'wave'
  left join public.tailor_rate rwd on rwd.tailor = '*' and rwd.style = 'wave'
 where t.tailor is not null;
grant select on public.v_md_tailors to authenticated;
