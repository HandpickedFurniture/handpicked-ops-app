-- 26 Oct 2026: Stage 4 of the Step scheduler (#/stepper) - the LIVE day.
--
-- Stage 3 ends by PUBLISHING the plan (fn_live_publish). From then on the day lives here, not in one
-- browser's localStorage, so every signed-in user sees the same board and it survives a refresh:
--   live_team        one row per team that day (name, crew, leave time, team note)
--   live_order       one row per order: team, visit order, planned start/end, status, notes
--   live_event       append-only log of every change (status, retime, add, remove, move, note, adjustment)
--   live_adjustment  links an adjustment (accounting_alerts row) to the live order it was captured on
--
-- Adjustments are booked by the SAME function every other capture path uses (fn_ops_add_adjustment),
-- tagged captured_by = 'live:<who>'. The agent's sheet_sync.run_live() then writes them to the partner
-- "Adjustments" tabs in the usual A-D format, ONE ROW PER ORDER (user rule 7 Oct 2026).
--
-- Every write goes through a fn_live_* function that refuses viewers; the tables themselves are
-- read-only to the app (a blocked UPDATE from PostgREST is a silent 204 - see ops-app-roles-rls).

create table if not exists public.live_team (
  day      date    not null,
  city     text    not null,
  team     integer not null,
  name     text    not null,
  members  text[]  not null default '{}',
  leave_at text,                                    -- 'HH:MM'
  note     text,
  primary key (day, city, team)
);

create table if not exists public.live_order (
  day         date    not null,
  city        text    not null,
  order_id    text    not null,
  team        integer,                              -- null = on no team (waiting)
  seq         integer not null default 0,           -- visit order inside the team
  customer    text,
  phone       text,
  address     text,
  emaar       boolean not null default false,
  lat         double precision,
  lng         double precision,
  appt_time   text,                                 -- 'HH:MM' the 3D sheet / customer appointment
  plan_start  text,                                 -- 'HH:MM' planned start (moves when retimed)
  plan_end    text,
  est_min     integer,
  scope       text,                                 -- one-line work description
  status      text    not null default 'pending'
              check (status in ('pending','in_progress','completed','partial','failed','rescheduled','removed')),
  status_at   timestamptz,
  status_by   text,
  reason      text,                                 -- why partial / failed / rescheduled / removed
  resched_to  date,
  note        text,
  added_live  boolean not null default false,       -- put in after publishing
  started_at  timestamptz,
  finished_at timestamptz,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (day, city, order_id)
);
create index if not exists live_order_team_ix on public.live_order (day, city, team, seq);

create table if not exists public.live_event (
  id       bigserial primary key,
  day      date not null,
  city     text not null,
  order_id text,
  team     integer,
  at       timestamptz not null default now(),
  who      text,
  kind     text not null,                           -- publish|status|retime|add|remove|move|note|team_note|adjustment
  detail   jsonb not null default '{}'::jsonb
);
create index if not exists live_event_day_ix on public.live_event (day, city, at desc);

create table if not exists public.live_adjustment (
  id         bigserial primary key,
  day        date not null,
  city       text not null,
  order_id   text not null,
  alert_id   bigint not null references public.accounting_alerts(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by text
);
create index if not exists live_adjustment_day_ix on public.live_adjustment (day, city, order_id);

do $$ declare t text; begin
  foreach t in array array['live_team','live_order','live_event','live_adjustment'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists p_read_all on public.%I', t);
    execute format('create policy p_read_all on public.%I for select to authenticated using (true)', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------- helpers
create or replace function public.fn_live_t2m(p text) returns integer language sql immutable as $$
  select case when p ~ '^\d{1,2}:\d{2}' then split_part(p, ':', 1)::int * 60 + left(split_part(p, ':', 2), 2)::int end $$;
create or replace function public.fn_live_m2t(p integer) returns text language sql immutable as $$
  select case when p is null then null else lpad(((p % 1440 + 1440) % 1440 / 60)::text, 2, '0') || ':' || lpad((((p % 60) + 60) % 60)::text, 2, '0') end $$;

create or replace function public.fn_live_guard() returns text language plpgsql stable as $$
begin
  if public.fn_is_viewer() then raise exception 'Your role can look but not change the live day' using errcode = 'P0001'; end if;
  return coalesce(nullif(auth.jwt() ->> 'email', ''), 'unknown');
end $$;

create or replace function public.fn_live_log(p_day date, p_city text, p_order text, p_team integer, p_by text, p_kind text, p_detail jsonb)
returns void language sql as $$
  insert into public.live_event(day, city, order_id, team, who, kind, detail) values (p_day, p_city, p_order, p_team, p_by, p_kind, coalesce(p_detail, '{}'::jsonb)) $$;

-- ---------------------------------------------------------------------------- publish
-- p_teams  [{team,name,members:[..],leave,note}]
-- p_orders [{order_id,team,seq,customer,phone,address,emaar,lat,lng,appt_time,plan_start,plan_end,est_min,scope,note}]
-- Publishing again keeps the status, reason and notes of an order already live and only refreshes where
-- and when it is planned; an order that dropped out of the plan and has not been worked is removed.
create or replace function public.fn_live_publish(p_day date, p_city text, p_teams jsonb, p_orders jsonb)
returns jsonb language plpgsql as $$
declare who text := public.fn_live_guard(); o jsonb; t jsonb; n_new int := 0; n_upd int := 0; ids text[];
begin
  for t in select * from jsonb_array_elements(coalesce(p_teams, '[]'::jsonb)) loop
    insert into public.live_team(day, city, team, name, members, leave_at, note)
    values (p_day, p_city, (t ->> 'team')::int, coalesce(t ->> 'name', 'Team ' || (t ->> 'team')),
            coalesce(array(select jsonb_array_elements_text(coalesce(t -> 'members', '[]'::jsonb))), '{}'),
            t ->> 'leave', nullif(t ->> 'note', ''))
    on conflict (day, city, team) do update set name = excluded.name, members = excluded.members,
      leave_at = excluded.leave_at, note = coalesce(excluded.note, public.live_team.note);
  end loop;

  ids := array(select x ->> 'order_id' from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) x);
  for o in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) loop
    if exists (select 1 from public.live_order where day = p_day and city = p_city and order_id = o ->> 'order_id') then
      update public.live_order set team = nullif(o ->> 'team', '')::int, seq = coalesce((o ->> 'seq')::int, seq),
        customer = o ->> 'customer', phone = o ->> 'phone', address = o ->> 'address',
        emaar = coalesce((o ->> 'emaar')::boolean, false), lat = (o ->> 'lat')::float8, lng = (o ->> 'lng')::float8,
        appt_time = o ->> 'appt_time', est_min = (o ->> 'est_min')::int, scope = o ->> 'scope',
        plan_start = case when status in ('pending','in_progress') then o ->> 'plan_start' else plan_start end,
        plan_end   = case when status in ('pending','in_progress') then o ->> 'plan_end'   else plan_end end,
        note = coalesce(nullif(o ->> 'note', ''), note),
        status = case when status = 'removed' then 'pending' else status end,
        updated_at = now(), updated_by = who
      where day = p_day and city = p_city and order_id = o ->> 'order_id';
      n_upd := n_upd + 1;
    else
      insert into public.live_order(day, city, order_id, team, seq, customer, phone, address, emaar, lat, lng,
        appt_time, plan_start, plan_end, est_min, scope, note, updated_by)
      values (p_day, p_city, o ->> 'order_id', nullif(o ->> 'team', '')::int, coalesce((o ->> 'seq')::int, 0),
        o ->> 'customer', o ->> 'phone', o ->> 'address', coalesce((o ->> 'emaar')::boolean, false),
        (o ->> 'lat')::float8, (o ->> 'lng')::float8, o ->> 'appt_time', o ->> 'plan_start', o ->> 'plan_end',
        (o ->> 'est_min')::int, o ->> 'scope', nullif(o ->> 'note', ''), who);
      n_new := n_new + 1;
    end if;
  end loop;

  update public.live_order set status = 'removed', status_at = now(), status_by = who, reason = 'dropped from the plan',
         updated_at = now(), updated_by = who
   where day = p_day and city = p_city and status = 'pending' and not (order_id = any (ids));

  perform public.fn_live_log(p_day, p_city, null, null, who, 'publish', jsonb_build_object('new', n_new, 'updated', n_upd));
  return jsonb_build_object('new', n_new, 'updated', n_upd);
end $$;

-- ---------------------------------------------------------------------------- status
create or replace function public.fn_live_set_status(p_day date, p_city text, p_order text, p_status text,
  p_reason text default null, p_resched_to date default null)
returns void language plpgsql as $$
declare who text := public.fn_live_guard(); r public.live_order;
begin
  if p_status not in ('pending','in_progress','completed','partial','failed','rescheduled') then
    raise exception 'Unknown status %', p_status using errcode = 'P0001';
  end if;
  if p_status in ('partial','failed','rescheduled') and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why it was % (a short reason)', p_status using errcode = 'P0001';
  end if;
  if p_status = 'rescheduled' and p_resched_to is null then
    raise exception 'Pick the new date for the reschedule' using errcode = 'P0001';
  end if;
  update public.live_order set status = p_status, status_at = now(), status_by = who,
         reason = case when p_status in ('partial','failed','rescheduled') then btrim(p_reason) else null end,
         resched_to = case when p_status = 'rescheduled' then p_resched_to else null end,
         started_at  = case when p_status = 'in_progress' then coalesce(started_at, now())
                            when p_status = 'pending' then null else started_at end,
         finished_at = case when p_status in ('completed','partial','failed','rescheduled') then now() else null end,
         updated_at = now(), updated_by = who
   where day = p_day and city = p_city and order_id = p_order returning * into r;
  if not found then raise exception 'Order % is not on that live day', p_order using errcode = 'P0001'; end if;
  perform public.fn_live_log(p_day, p_city, p_order, r.team, who, 'status',
    jsonb_build_object('status', p_status, 'reason', p_reason, 'resched_to', p_resched_to));
end $$;

-- ---------------------------------------------------------------------------- timing
-- Move one order's planned start to p_start (HH:MM). With p_cascade the later orders of the same team that
-- are not finished move by the same number of minutes - a delay on one job pushes the rest of the day.
create or replace function public.fn_live_retime(p_day date, p_city text, p_order text, p_start text, p_cascade boolean default true)
returns integer language plpgsql as $$
declare who text := public.fn_live_guard(); r public.live_order; delta int; n int := 0;
begin
  if public.fn_live_t2m(p_start) is null then raise exception 'Time must look like 14:30' using errcode = 'P0001'; end if;
  select * into r from public.live_order where day = p_day and city = p_city and order_id = p_order;
  if not found then raise exception 'Order % is not on that live day', p_order using errcode = 'P0001'; end if;
  delta := public.fn_live_t2m(p_start) - coalesce(public.fn_live_t2m(r.plan_start), public.fn_live_t2m(p_start));
  update public.live_order set plan_start = public.fn_live_m2t(public.fn_live_t2m(plan_start) + delta),
         plan_end = public.fn_live_m2t(public.fn_live_t2m(plan_end) + delta), updated_at = now(), updated_by = who
   where day = p_day and city = p_city and order_id = p_order;
  n := 1;
  if p_cascade and r.team is not null then
    update public.live_order set plan_start = public.fn_live_m2t(public.fn_live_t2m(plan_start) + delta),
           plan_end = public.fn_live_m2t(public.fn_live_t2m(plan_end) + delta), updated_at = now(), updated_by = who
     where day = p_day and city = p_city and team = r.team and seq > r.seq and status in ('pending','in_progress');
    get diagnostics n = row_count; n := n + 1;
  end if;
  perform public.fn_live_log(p_day, p_city, p_order, r.team, who, 'retime',
    jsonb_build_object('from', r.plan_start, 'to', p_start, 'delta_min', delta, 'cascade', p_cascade, 'moved', n));
  return n;
end $$;

-- ---------------------------------------------------------------------------- add / remove / move
create or replace function public.fn_live_add_order(p_day date, p_city text, p_order text, p_team integer, p_start text,
  p_minutes integer default 60, p_customer text default null, p_phone text default null, p_address text default null,
  p_emaar boolean default false, p_scope text default null, p_note text default null)
returns void language plpgsql as $$
declare who text := public.fn_live_guard(); sq int;
begin
  if coalesce(btrim(p_order), '') = '' then raise exception 'Order number is needed' using errcode = 'P0001'; end if;
  if public.fn_live_t2m(p_start) is null then raise exception 'Start time must look like 14:30' using errcode = 'P0001'; end if;
  select coalesce(count(*), 0) into sq from public.live_order
   where day = p_day and city = p_city and team is not distinct from p_team
     and status <> 'removed' and order_id <> btrim(p_order) and public.fn_live_t2m(plan_start) <= public.fn_live_t2m(p_start);
  update public.live_order set seq = seq + 1 where day = p_day and city = p_city and team is not distinct from p_team and seq >= sq and order_id <> btrim(p_order);
  insert into public.live_order(day, city, order_id, team, seq, customer, phone, address, emaar, appt_time, plan_start, plan_end,
                                est_min, scope, note, added_live, updated_by)
  values (p_day, p_city, btrim(p_order), p_team, sq, p_customer, p_phone, p_address, coalesce(p_emaar, false), p_start, p_start,
          public.fn_live_m2t(public.fn_live_t2m(p_start) + coalesce(p_minutes, 60)), p_minutes, p_scope, nullif(p_note, ''), true, who)
  on conflict (day, city, order_id) do update set team = excluded.team, seq = excluded.seq, plan_start = excluded.plan_start,
    plan_end = excluded.plan_end, est_min = excluded.est_min, status = 'pending', reason = null, status_at = now(),
    status_by = who, added_live = true, updated_at = now(), updated_by = who,
    customer = coalesce(excluded.customer, public.live_order.customer), phone = coalesce(excluded.phone, public.live_order.phone),
    address = coalesce(excluded.address, public.live_order.address);
  perform public.fn_live_log(p_day, p_city, btrim(p_order), p_team, who, 'add', jsonb_build_object('start', p_start, 'minutes', p_minutes));
end $$;

create or replace function public.fn_live_remove_order(p_day date, p_city text, p_order text, p_reason text default null)
returns void language plpgsql as $$
declare who text := public.fn_live_guard(); t int;
begin
  update public.live_order set status = 'removed', status_at = now(), status_by = who, reason = nullif(btrim(coalesce(p_reason, '')), ''),
         updated_at = now(), updated_by = who
   where day = p_day and city = p_city and order_id = p_order returning team into t;
  if not found then raise exception 'Order % is not on that live day', p_order using errcode = 'P0001'; end if;
  perform public.fn_live_log(p_day, p_city, p_order, t, who, 'remove', jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.fn_live_move_order(p_day date, p_city text, p_order text, p_team integer)
returns void language plpgsql as $$
declare who text := public.fn_live_guard(); r public.live_order; sq int;
begin
  select * into r from public.live_order where day = p_day and city = p_city and order_id = p_order;
  if not found then raise exception 'Order % is not on that live day', p_order using errcode = 'P0001'; end if;
  select coalesce(count(*), 0) into sq from public.live_order
   where day = p_day and city = p_city and team is not distinct from p_team and status <> 'removed'
     and order_id <> p_order and public.fn_live_t2m(plan_start) <= public.fn_live_t2m(r.plan_start);
  update public.live_order set seq = seq + 1 where day = p_day and city = p_city and team is not distinct from p_team and seq >= sq and order_id <> p_order;
  update public.live_order set team = p_team, seq = sq, updated_at = now(), updated_by = who
   where day = p_day and city = p_city and order_id = p_order;
  perform public.fn_live_log(p_day, p_city, p_order, p_team, who, 'move', jsonb_build_object('from', r.team, 'to', p_team));
end $$;

-- ---------------------------------------------------------------------------- notes
create or replace function public.fn_live_note(p_day date, p_city text, p_order text, p_note text)
returns void language plpgsql as $$
declare who text := public.fn_live_guard(); t int;
begin
  update public.live_order set note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now(), updated_by = who
   where day = p_day and city = p_city and order_id = p_order returning team into t;
  if not found then raise exception 'Order % is not on that live day', p_order using errcode = 'P0001'; end if;
  perform public.fn_live_log(p_day, p_city, p_order, t, who, 'note', jsonb_build_object('note', p_note));
end $$;

create or replace function public.fn_live_team_note(p_day date, p_city text, p_team integer, p_note text)
returns void language plpgsql as $$
declare who text := public.fn_live_guard();
begin
  update public.live_team set note = nullif(btrim(coalesce(p_note, '')), '') where day = p_day and city = p_city and team = p_team;
  perform public.fn_live_log(p_day, p_city, null, p_team, who, 'team_note', jsonb_build_object('note', p_note));
end $$;

-- ---------------------------------------------------------------------------- adjustments
-- Books through fn_ops_add_adjustment (the one every capture path uses) so the rate card, city visit
-- price and Finance module all see it; the live link only says where it was captured. p_amount null =
-- the rate card's amount for this order's city. Chargeable false books it at the chosen amount but off the bill.
create or replace function public.fn_live_add_adjustment(p_day date, p_city text, p_order text, p_charge_type text,
  p_quantity numeric default 1, p_amount numeric default null, p_reason text default null, p_chargeable boolean default true)
returns bigint language plpgsql as $$
declare who text := public.fn_live_guard(); v_id bigint; t int; v_reason text;
begin
  if not exists (select 1 from public.live_order where day = p_day and city = p_city and order_id = p_order) then
    raise exception 'Order % is not on that live day', p_order using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say what the adjustment is for' using errcode = 'P0001'; end if;
  v_reason := btrim(p_reason);
  v_id := public.fn_ops_add_adjustment(p_order, p_charge_type, v_reason, coalesce(p_quantity, 1), null, coalesce(p_chargeable, true),
            p_amount, 'live:' || who, null, 'Captured on the live day ' || p_day::text, 'new', null);
  -- the app's own order city decides which partner sheet it goes to (v_ops_order_roster, else this)
  update public.accounting_alerts set city_override = p_city
   where id = v_id and city_override is null and not exists (select 1 from public.v_ops_order_roster r where r.order_id = p_order and r.city is not null);
  insert into public.live_adjustment(day, city, order_id, alert_id, created_by) values (p_day, p_city, p_order, v_id, who);
  select team into t from public.live_order where day = p_day and city = p_city and order_id = p_order;
  perform public.fn_live_log(p_day, p_city, p_order, t, who, 'adjustment',
    jsonb_build_object('alert_id', v_id, 'charge_type', p_charge_type, 'quantity', p_quantity, 'amount', p_amount, 'reason', v_reason));
  return v_id;
end $$;

-- what the live board shows under each order: the adjustment, its amount and whether it is on the sheet yet
create or replace view public.v_live_adjustments with (security_invoker = true) as
select l.day, l.city, l.order_id, l.alert_id, a.charge_type, a.quantity, a.reason, a.chargeable, a.status,
       round(coalesce(a.agreed_amount_aed, a.suggested_amount_aed, 0), 2) as amount_aed,
       a.sheet_updated, a.sheet_row_ref, a.sheet_hold_reason, l.created_at, l.created_by
  from public.live_adjustment l join public.accounting_alerts a on a.id = l.alert_id;
grant select on public.v_live_adjustments to authenticated;
revoke all on public.v_live_adjustments from anon;

do $$ declare f text; begin
  foreach f in array array[
    'fn_live_publish(date,text,jsonb,jsonb)','fn_live_set_status(date,text,text,text,text,date)',
    'fn_live_retime(date,text,text,text,boolean)',
    'fn_live_add_order(date,text,text,integer,text,integer,text,text,text,boolean,text,text)',
    'fn_live_remove_order(date,text,text,text)','fn_live_move_order(date,text,text,integer)',
    'fn_live_note(date,text,text,text)','fn_live_team_note(date,text,integer,text)',
    'fn_live_add_adjustment(date,text,text,text,numeric,numeric,text,boolean)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
