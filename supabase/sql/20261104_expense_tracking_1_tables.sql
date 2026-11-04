-- 4 Nov 2026: Expense tracking module, part 1 - storage and parsers.
--
-- WHERE THE MONEY FACTS COME FROM
--   WhatsApp "Bills to be uploaded": each crew's cash holder posts receipts plus a daily "statement
--   of account" (petrol, parking, salik, darb, food, other, total, company balance).
--   WhatsApp "Team N" groups: the coordinators' day posts - the record of who went where.
--   The expense-capture Edge Function copies those messages here; everything else is SQL so it can
--   be re-run over the stored raw text whenever a parsing rule changes.
--
-- THE LEDGER IS PER CASH HOLDER, not per team: the float belongs to a person and crews change.
-- Access: ops only, read and write. This is staff money; 'viewer' roles do not see it.

create table if not exists public.exp_holder (
  id            bigint generated always as identity primary key,
  phone         text not null unique,          -- digits only, 971...
  display_name  text not null,
  member_key    text,                          -- the name used in "Assigned personnel" posts
  vehicle_plate text,
  km_per_l      numeric check (km_per_l is null or km_per_l > 0),
  fuel_grade    text not null default 'special' check (fuel_grade in ('super','special','eplus','diesel')),
  base_lat      numeric,                       -- null = the company base in exp_settings
  base_lng      numeric,
  active        boolean not null default true,
  confirmed     boolean not null default false, -- false = name guessed from WhatsApp, needs a look
  note          text,
  updated_at    timestamptz not null default now(),
  updated_by    text
);

create table if not exists public.exp_settings (
  key   text primary key,
  value numeric not null,
  note  text,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.exp_settings(key, value, note) values
  ('default_km_per_l',   10,      'ASSUMPTION until set per vehicle'),
  ('fuel_over_pct',      40,      'Period fuel claim above the estimate by this % is an outlier'),
  ('fuel_over_min_aed',  50,      'Ignore gaps smaller than this many AED'),
  ('price_tolerance_pct', 2,      'Receipt price this far from the month price is flagged'),
  ('match_tolerance_aed', 1,      'Rounding allowed when comparing amounts'),
  ('base_lat',           25.1673, 'International City, the schedule engine''s base'),
  ('base_lng',           55.4103, 'International City, the schedule engine''s base')
on conflict (key) do nothing;

-- Raw copy of the bills group. Never edited by a person.
create table if not exists public.exp_message (
  wa_id        text primary key,
  at           timestamptz not null,
  day          date not null,                  -- Dubai date it was RECEIVED
  sender_phone text,
  sender_name  text,
  msg_type     text not null,
  body         text,                           -- caption or text
  media_id     text,
  media_mime   text,
  media_size   bigint,
  media_sha    text,
  storage_path text,                           -- bucket team-bills
  fetched_at   timestamptz,
  fetch_error  text,
  ocr          jsonb,
  ocr_at       timestamptz,
  ocr_error    text,
  drive_name   text,
  drive_file_id text,
  drive_synced_at timestamptz,
  drive_error  text,
  captured_at  timestamptz not null default now()
);
create index if not exists exp_message_day on public.exp_message(day);
create index if not exists exp_message_todo on public.exp_message(fetched_at) where media_id is not null;

-- One parsed statement per message that is one. Rebuilt from exp_message.body by fn_exp_parse_all().
create table if not exists public.exp_statement (
  wa_id        text primary key references public.exp_message(wa_id) on delete cascade,
  sender_phone text,
  at           timestamptz not null,
  stmt_date    date,
  opening      numeric,
  topup        numeric,                        -- "38.79+500=538.79" -> 500
  petrol       numeric, parking numeric, salik numeric, darb numeric,
  food         numeric, car_wash numeric, other numeric,
  total_claimed numeric,
  pending      numeric,
  closing_claimed numeric,
  date_guessed boolean not null default false
);
create index if not exists exp_statement_who on public.exp_statement(sender_phone, stmt_date);

-- Advances. Never deleted: a wrong one is voided with a reason.
create table if not exists public.exp_payment (
  id          bigint generated always as identity primary key,
  holder_id   bigint references public.exp_holder(id),
  paid_on     date not null,
  amount      numeric not null check (amount > 0),
  paid_by     text not null check (paid_by in ('Ashmeet','Elysha')),
  method      text,
  reference   text,
  note        text,
  source      text not null default 'manual' check (source in ('manual','whatsapp')),
  wa_id       text unique references public.exp_message(wa_id),
  status      text not null default 'confirmed' check (status in ('confirmed','to_confirm')),
  created_by  text,
  created_at  timestamptz not null default now(),
  voided_at   timestamptz,
  voided_by   text,
  void_reason text
);
create index if not exists exp_payment_holder on public.exp_payment(holder_id, paid_on);

-- Manual override of the month's pump price. Without a row the median of that month's receipts is used.
create table if not exists public.exp_fuel_price (
  month  date not null,                        -- first of the month
  grade  text not null check (grade in ('super','special','eplus','diesel')),
  price  numeric not null check (price > 0),
  note   text,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (month, grade)
);

-- Raw copy of the coordinators' posts in the Team N groups.
create table if not exists public.exp_team_post (
  wa_id      text primary key,
  group_id   text not null,
  group_name text not null,
  at         timestamptz not null,
  msg_type   text not null,
  body       text
);
create index if not exists exp_team_post_group on public.exp_team_post(group_id, at);

create table if not exists public.exp_team_day (
  day        date not null,
  group_id   text not null,
  group_name text not null,
  team_no    integer,
  members    text[] not null default '{}',
  primary key (day, group_id)
);

create table if not exists public.exp_team_stop (
  day      date not null,
  group_id text not null,
  order_id text not null,
  seq      integer,
  appt     text,
  address  text,
  note     text,
  lat      numeric,
  lng      numeric,
  geo_source text,
  geo_confidence text,
  primary key (day, group_id, order_id)
);

-- A human's verdict on a flag. The flag itself is computed; this only remembers the decision.
create table if not exists public.exp_flag_review (
  flag_key    text primary key,
  status      text not null check (status in ('ok','query')),
  note        text,
  reviewed_by text,
  reviewed_at timestamptz not null default now()
);

create table if not exists public.exp_capture_run (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  trigger text,
  stats jsonb,
  error text
);

-- RLS: ops only. Writes go through fn_exp_* (security invoker) so this is the only gate.
do $$
declare t text;
begin
  foreach t in array array['exp_holder','exp_settings','exp_message','exp_statement','exp_payment',
    'exp_fuel_price','exp_team_post','exp_team_day','exp_team_stop','exp_flag_review','exp_capture_run']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists p_ops_read on public.%I', t);
    execute format('create policy p_ops_read on public.%I for select to authenticated using (not public.fn_is_viewer())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  foreach t in array array['exp_holder','exp_settings','exp_payment','exp_fuel_price','exp_flag_review']
  loop
    execute format('drop policy if exists p_ops_ins on public.%I', t);
    execute format('drop policy if exists p_ops_upd on public.%I', t);
    execute format('create policy p_ops_ins on public.%I for insert to authenticated with check (not public.fn_is_viewer())', t);
    execute format('create policy p_ops_upd on public.%I for update to authenticated using (not public.fn_is_viewer()) with check (not public.fn_is_viewer())', t);
    execute format('grant insert, update on public.%I to authenticated', t);
  end loop;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('team-bills', 'team-bills', false, 20971520,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;
drop policy if exists team_bills_ops_read on storage.objects;
create policy team_bills_ops_read on storage.objects for select to authenticated
  using (bucket_id = 'team-bills' and not public.fn_is_viewer());

-- First number after a label on one line. 70:00 is how some phones type 70.00.
create or replace function public.fn_exp_amt(p_body text, p_label text)
returns numeric language sql immutable as $$
  select nullif(replace(m[1], ':', '.'), '')::numeric
  from regexp_match(p_body, '(?in)^[^a-z0-9]*' || p_label || '[^0-9\n]*([0-9]+(?:[.:][0-9]{1,2})?)') m
$$;

create or replace function public.fn_exp_is_statement(p_body text)
returns boolean language sql immutable as $$
  select coalesce(p_body ~* '(^|\n)[^a-z0-9]*petrol' and p_body ~* '(^|\n)[^a-z0-9]*total', false)
$$;

create or replace function public.fn_exp_stmt_date(p_body text)
returns date language plpgsql immutable as $$
declare m text[]; mon int;
begin
  m := regexp_match(p_body, '(\d{1,2})\s*[._/ -]\s*(\d{1,2})\s*[._/ -]\s*(20\d\d)');
  if m is not null then
    begin
      return make_date(m[3]::int, m[2]::int, m[1]::int);
    exception when others then null;
    end;
  end if;
  m := regexp_match(p_body, '(?i)(\d{1,2})\s*[._/ -]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[._/ -]?\s*(20\d\d)');
  if m is not null then
    mon := (strpos('janfebmaraprmayjunjulaugsepoctnovdec', lower(m[2])) + 2) / 3;
    begin
      return make_date(m[3]::int, mon, m[1]::int);
    exception when others then null;
    end;
  end if;
  return null;
end $$;

create or replace function public.fn_exp_parse_statement(p_body text)
returns jsonb language plpgsql immutable as $$
declare
  v_open_txt text; v_open numeric; v_top numeric; m text[];
  v_park numeric; v_rta numeric; v_salik numeric; v_toll numeric;
begin
  if not public.fn_exp_is_statement(p_body) then return null; end if;

  -- Opening is written three ways: "350.54", "38.79+500=538.79", "500--157.90=\n342.10".
  v_open_txt := (regexp_match(p_body,
    '(?in)^[^a-z0-9]*company\s*(?:previous\s*balance|balance(?!\s*amount))[^0-9\n]*((?:[^\n]*\n?)[^\n]*)'))[1];
  if v_open_txt is not null then
    m := regexp_match(v_open_txt, '=\s*([0-9]+(?:[.:][0-9]{1,2})?)');
    if m is not null then
      v_open := replace(m[1], ':', '.')::numeric;
      m := regexp_match(v_open_txt, '^\s*[0-9.]+\s*\+\s*([0-9.]+)\s*=');
      if m is not null then v_top := m[1]::numeric; end if;
    else
      m := regexp_match(v_open_txt, '^([0-9]+(?:[.:][0-9]{1,2})?)');
      if m is not null then v_open := replace(m[1], ':', '.')::numeric; end if;
    end if;
  end if;

  v_park  := public.fn_exp_amt(p_body, 'parking');         -- "Parking exp" / "Parking Salik pay"
  v_rta   := public.fn_exp_amt(p_body, 'rta\s*parking');
  v_salik := public.fn_exp_amt(p_body, 'salik');
  v_toll  := public.fn_exp_amt(p_body, 'tolls?');

  return jsonb_build_object(
    'stmt_date', public.fn_exp_stmt_date(p_body),
    'opening',  v_open,
    'topup',    v_top,
    'petrol',   public.fn_exp_amt(p_body, 'petrol'),
    'parking',  coalesce(v_park,0) + coalesce(v_rta,0),
    'salik',    coalesce(v_salik,0) + coalesce(v_toll,0),
    'darb',     public.fn_exp_amt(p_body, 'dr?a?r?a?b'),
    'food',     public.fn_exp_amt(p_body, 'food'),
    'car_wash', public.fn_exp_amt(p_body, 'car\s*wash'),
    'other',    public.fn_exp_amt(p_body, 'other'),
    'total_claimed', public.fn_exp_amt(p_body, 'total'),
    'pending',  public.fn_exp_amt(p_body, 'pending'),
    'closing_claimed', coalesce(public.fn_exp_amt(p_body, 'company\s*balance\s*amount'),
                                public.fn_exp_amt(p_body, 'now\s*i\s*have\s*company\s*balance'))
  );
end $$;

-- Rebuild every statement from the stored raw text. Safe to run any time.
create or replace function public.fn_exp_parse_all()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with p as (
    select e.wa_id, e.sender_phone, e.at, public.fn_exp_parse_statement(e.body) j
    from public.exp_message e where e.body is not null
  ), ins as (
    insert into public.exp_statement as s (wa_id, sender_phone, at, stmt_date, opening, topup, petrol,
      parking, salik, darb, food, car_wash, other, total_claimed, pending, closing_claimed, date_guessed)
    select wa_id, sender_phone, at,
      coalesce((j->>'stmt_date')::date, (at at time zone 'Asia/Dubai')::date),
      (j->>'opening')::numeric, (j->>'topup')::numeric, (j->>'petrol')::numeric, (j->>'parking')::numeric,
      (j->>'salik')::numeric, (j->>'darb')::numeric, (j->>'food')::numeric, (j->>'car_wash')::numeric,
      (j->>'other')::numeric, (j->>'total_claimed')::numeric, (j->>'pending')::numeric,
      (j->>'closing_claimed')::numeric, (j->>'stmt_date') is null
    from p where j is not null
    on conflict (wa_id) do update set
      stmt_date = excluded.stmt_date, opening = excluded.opening, topup = excluded.topup,
      petrol = excluded.petrol, parking = excluded.parking, salik = excluded.salik, darb = excluded.darb,
      food = excluded.food, car_wash = excluded.car_wash, other = excluded.other,
      total_claimed = excluded.total_claimed, pending = excluded.pending,
      closing_claimed = excluded.closing_claimed, date_guessed = excluded.date_guessed
    returning 1
  )
  select count(*) into n from ins;
  return n;
end $$;
revoke execute on function public.fn_exp_parse_all() from public, anon;
