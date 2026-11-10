-- Step scheduler, 10 Nov 2026 (user):
--   * the plan is SHARED: anyone who opens the stepper for a date + city sees and edits the same plan
--     (it used to live in one browser's localStorage)
--   * saved VERSIONS that can be restored
--   * every change recorded with the person who made it (their sign-in email)
--   * a map pin picked by hand is remembered for the address (geo_place, which the resolver already
--     prefers over everything else), and an Emaar tick is remembered for the address too
--
-- Tables are read-only to the browser; every write is a SECURITY DEFINER fn_stepper_* that calls
-- fn_live_guard() (refuses read-only roles, returns the caller's email) - the Stage 4 pattern.

create table if not exists public.stepper_plan (
  day date not null, city text not null,
  state jsonb not null,
  rev integer not null default 1,
  updated_at timestamptz not null default now(), updated_by text,
  primary key (day, city));

create table if not exists public.stepper_plan_version (
  id bigserial primary key, day date not null, city text not null,
  label text, state jsonb not null, rev integer,
  created_at timestamptz not null default now(), created_by text);
create index if not exists stepper_plan_version_day on public.stepper_plan_version(day, city, created_at desc);

create table if not exists public.stepper_change (
  id bigserial primary key, day date not null, city text not null, rev integer,
  at timestamptz not null default now(), who text, kind text, summary text);
create index if not exists stepper_change_day on public.stepper_change(day, city, at desc);

create table if not exists public.stepper_presence (
  day date not null, city text not null, who text not null,
  stage integer, seen_at timestamptz not null default now(),
  primary key (day, city, who));

-- the user's own Emaar decision for an address beats every pattern, both ways
create table if not exists public.emaar_address_mark (
  addr_norm text primary key, emaar boolean not null, address_seen text,
  updated_by text, updated_at timestamptz not null default now());

do $$ declare t text; begin
  foreach t in array array['stepper_plan','stepper_plan_version','stepper_change','stepper_presence','emaar_address_mark'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists p_read_all on public.%I', t);
    execute format('create policy p_read_all on public.%I for select to authenticated using (true)', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- read + heartbeat (viewers too)
create or replace function public.fn_stepper_get(p_day date, p_city text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('state', p.state, 'rev', p.rev, 'updated_at', p.updated_at, 'updated_by', p.updated_by)
    from public.stepper_plan p where p.day = p_day and p.city = p_city $$;

-- who else has this day open (seen in the last 2 minutes), and the plan's current revision
create or replace function public.fn_stepper_ping(p_day date, p_city text, p_stage integer default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me text := coalesce(nullif(auth.jwt() ->> 'email', ''), 'unknown');
begin
  insert into public.stepper_presence(day, city, who, stage, seen_at) values (p_day, p_city, me, p_stage, now())
  on conflict (day, city, who) do update set stage = excluded.stage, seen_at = now();
  return jsonb_build_object(
    'rev', (select rev from public.stepper_plan where day = p_day and city = p_city),
    'updated_by', (select updated_by from public.stepper_plan where day = p_day and city = p_city),
    'updated_at', (select updated_at from public.stepper_plan where day = p_day and city = p_city),
    'present', coalesce((select jsonb_agg(jsonb_build_object('who', s.who, 'stage', s.stage, 'seen_at', s.seen_at) order by s.who)
                           from public.stepper_presence s
                          where s.day = p_day and s.city = p_city and s.who <> me and s.seen_at > now() - interval '2 minutes'), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- save (optimistic: base revision must match)
-- p_changes: [{kind, summary}] - what this save did, in words, for the change log
create or replace function public.fn_stepper_save(p_day date, p_city text, p_state jsonb, p_base_rev integer, p_changes jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); cur public.stepper_plan; nrev integer;
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object' then raise exception 'Nothing to save' using errcode = 'P0001'; end if;
  select * into cur from public.stepper_plan where day = p_day and city = p_city for update;
  if found and cur.rev <> coalesce(p_base_rev, 0) then
    -- somebody else saved first: hand back their plan so the browser can merge and try again
    return jsonb_build_object('ok', false, 'rev', cur.rev, 'state', cur.state, 'updated_by', cur.updated_by, 'updated_at', cur.updated_at);
  end if;
  nrev := coalesce(cur.rev, 0) + 1;
  insert into public.stepper_plan(day, city, state, rev, updated_at, updated_by) values (p_day, p_city, p_state, nrev, now(), who)
  on conflict (day, city) do update set state = excluded.state, rev = excluded.rev, updated_at = now(), updated_by = who;
  insert into public.stepper_change(day, city, rev, who, kind, summary)
  select p_day, p_city, nrev, who, coalesce(c ->> 'kind', 'edit'), left(coalesce(c ->> 'summary', ''), 500)
    from jsonb_array_elements(case when jsonb_typeof(p_changes) = 'array' then p_changes else '[]'::jsonb end) c
   where coalesce(c ->> 'summary', '') <> '';
  return jsonb_build_object('ok', true, 'rev', nrev);
end $$;

create or replace function public.fn_stepper_save_version(p_day date, p_city text, p_label text default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); cur public.stepper_plan; v bigint;
begin
  select * into cur from public.stepper_plan where day = p_day and city = p_city;
  if not found then raise exception 'There is no saved plan for % % yet' , p_city, p_day using errcode = 'P0001'; end if;
  insert into public.stepper_plan_version(day, city, label, state, rev, created_by)
  values (p_day, p_city, nullif(btrim(coalesce(p_label, '')), ''), cur.state, cur.rev, who) returning id into v;
  insert into public.stepper_change(day, city, rev, who, kind, summary)
  values (p_day, p_city, cur.rev, who, 'version', 'Saved version ' || coalesce(nullif(btrim(p_label), ''), '#' || v));
  return v;
end $$;

create or replace function public.fn_stepper_restore_version(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); v public.stepper_plan_version; nrev integer;
begin
  select * into v from public.stepper_plan_version where id = p_id;
  if not found then raise exception 'That version no longer exists' using errcode = 'P0001'; end if;
  insert into public.stepper_plan(day, city, state, rev, updated_at, updated_by) values (v.day, v.city, v.state, 1, now(), who)
  on conflict (day, city) do update set state = excluded.state, rev = public.stepper_plan.rev + 1, updated_at = now(), updated_by = who
  returning rev into nrev;
  insert into public.stepper_change(day, city, rev, who, kind, summary)
  values (v.day, v.city, nrev, who, 'restore', 'Restored version ' || coalesce(v.label, '#' || v.id) || ' (saved by ' || coalesce(v.created_by, '?') || ')');
  return jsonb_build_object('ok', true, 'rev', nrev, 'state', v.state);
end $$;

-- ---------------------------------------------------------------- map pin picked by hand
create or replace function public.fn_stepper_set_pin(p_address text, p_city text, p_lat numeric, p_lng numeric, p_order text default null)
returns void language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare who text := public.fn_live_guard(); n text := public.fn_sched_norm_addr(p_address);
begin
  if n is null or n = '' then raise exception 'This order has no address to remember the pin for' using errcode = 'P0001'; end if;
  if p_lat is null or p_lng is null or p_lat not between 22 and 27 or p_lng not between 51 and 57 then
    raise exception 'That pin is not in the UAE' using errcode = 'P0001'; end if;
  insert into public.geo_place(addr_norm, address_seen, lat, lng, property_type, source, confidence, updated_by, updated_at)
  values (n, p_address, round(p_lat, 6), round(p_lng, 6), case when n ~ '(villa|townhouse|town house)' then 'villa' else null end, 'manual', 'high', who, now())
  on conflict (addr_norm) do update set lat = excluded.lat, lng = excluded.lng, address_seen = excluded.address_seen,
        source = 'manual', confidence = 'high', updated_by = who, updated_at = now();
end $$;

-- ---------------------------------------------------------------- Emaar, remembered per address
create or replace function public.fn_stepper_mark_emaar(p_address text, p_emaar boolean)
returns void language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare who text := public.fn_live_guard(); n text := public.fn_sched_norm_addr(p_address);
begin
  if n is null or n = '' then return; end if;
  if p_emaar is null then delete from public.emaar_address_mark where addr_norm = n; return; end if;
  insert into public.emaar_address_mark(addr_norm, emaar, address_seen, updated_by, updated_at) values (n, p_emaar, p_address, who, now())
  on conflict (addr_norm) do update set emaar = excluded.emaar, address_seen = excluded.address_seen, updated_by = who, updated_at = now();
end $$;

create or replace function public.fn_sched_is_emaar(p_addr text)
returns boolean language sql stable set search_path = public, extensions, pg_temp as $$
  select coalesce(
    (select m.emaar from public.emaar_address_mark m where m.addr_norm = public.fn_sched_norm_addr(p_addr)),
    exists (select 1 from public.emaar_property e
             where e.active and not e.maybe and ' ' || public.fn_sched_norm_addr(p_addr) || ' ' like '% ' || e.pattern || '%')) $$;

create or replace function public.fn_sched_emaar_maybe(p_addr text)
returns boolean language sql stable set search_path = public, extensions, pg_temp as $$
  select not public.fn_sched_is_emaar(p_addr)
     and not exists (select 1 from public.emaar_address_mark m where m.addr_norm = public.fn_sched_norm_addr(p_addr))
     and exists (select 1 from public.emaar_property e
                  where e.active and e.maybe and ' ' || public.fn_sched_norm_addr(p_addr) || ' ' like '% ' || e.pattern || '%') $$;

-- more Emaar names (communities, buildings and sub-communities). Sure ones mark EMAAR, generic words
-- only EMAAR? so a coordinator decides - and that decision is remembered by emaar_address_mark.
insert into public.emaar_property(pattern, community, active, maybe, note)
select v.p, v.c, true, v.m, 'added 10 Nov 2026' from (values
  ('address downtown','Downtown Dubai',false), ('address sky view','Downtown Dubai',false), ('address opera','Downtown Dubai',false),
  ('address boulevard','Downtown Dubai',false), ('address residences','Emaar',false), ('address beach','Emaar Beachfront',false),
  ('address harbour','Dubai Creek Harbour',false), ('address the bay','Emaar Beachfront',false), ('address fountain','Downtown Dubai',false),
  ('vida dubai','Emaar',false), ('vida residences','Emaar',false), ('vida downtown','Downtown Dubai',false), ('vida marina','Dubai Marina',false),
  ('vida the hills','Emirates Hills',false), ('vida creek','Dubai Creek Harbour',false),
  ('act two','Downtown Dubai',false), ('il primo','Downtown Dubai',false), ('grande signature','Downtown Dubai',false),
  ('bellevue tower','Downtown Dubai',false), ('burj park','Downtown Dubai',false), ('the residence burj','Downtown Dubai',false),
  ('palace residences','Emaar',false), ('palace beach','Emaar Beachfront',false), ('seapoint','Emaar Beachfront',false),
  ('beachgate','Emaar Beachfront',false), ('bayview','Emaar Beachfront',false), ('beach mansion','Emaar Beachfront',false),
  ('creek palace','Dubai Creek Harbour',false), ('creek waters','Dubai Creek Harbour',false), ('harbour point','Dubai Creek Harbour',false),
  ('valo','Dubai Creek Harbour',false), ('aeon','Dubai Creek Harbour',false), ('creek vistas','Dubai Creek Harbour',false),
  ('club villas','Dubai Hills Estate',false), ('fairway vistas','Dubai Hills Estate',false), ('parkway vistas','Dubai Hills Estate',false),
  ('executive residences','Dubai Hills Estate',false), ('lime gardens','Dubai Hills Estate',false), ('hills park','Dubai Hills Estate',false),
  ('golf suites','Dubai Hills Estate',false), ('collective 2','Dubai Hills Estate',false),
  ('arabian ranches iii','Arabian Ranches 3',false), ('arabian ranches 3','Arabian Ranches 3',false), ('arabian ranches 2','Arabian Ranches 2',false),
  ('ranches','Arabian Ranches',true), ('gazelle','Arabian Ranches',false), ('reem community','Arabian Ranches 2',false),
  ('grand polo','Grand Polo Club',false), ('the oasis','The Oasis',false), ('palmiera','The Oasis',false), ('selvara','Grand Polo Club',false),
  ('eden the valley','The Valley',false), ('talia','The Valley',true), ('orania','The Valley',false), ('farm gardens','The Valley',false),
  ('alana','The Valley',true), ('velora','The Valley',false), ('rivana','The Valley',false), ('nara','The Valley',true),
  ('emaar beachfront','Emaar Beachfront',false), ('dubai creek harbour','Dubai Creek Harbour',false), ('dubai hills estate','Dubai Hills Estate',false),
  ('downtown dubai','Downtown Dubai',false), ('the old town','Downtown Dubai',false), ('old town island','Downtown Dubai',false),
  ('kamoon','Old Town',true), ('reehan','Old Town',false), ('yansoon','Old Town',false), ('zaafaran','Old Town',false), ('miska','Old Town',false),
  ('attareen','Old Town',false), ('tajer','Old Town',false),
  ('emaar south','Emaar South',false), ('expo golf','Emaar South',false), ('greenviews','Emaar South',false), ('golf links','Emaar South',false),
  ('ghadeer','The Lakes',false), ('hattan','The Lakes',false), ('zulal','The Lakes',false), ('maeen','The Lakes',false),
  ('forat','The Lakes',true), ('deema','The Lakes',false),
  ('al arta','The Greens',false), ('al dhafrah','The Greens',false), ('al jaz','The Greens',true),
  ('the springs','The Springs',false), ('meadows','The Meadows',false), ('emirates hills','Emirates Hills',false),
  ('the views','The Views',false), ('golf tower','The Views',false), ('panorama','The Views',true), ('fairways','The Views',true),
  ('rashid yachts','Rashid Yachts & Marina',false), ('mina rashid','Rashid Yachts & Marina',false),
  ('marina promenade','Dubai Marina',false), ('marina quay','Dubai Marina',false), ('emaar 6 towers','Dubai Marina',false),
  ('al majara','Dubai Marina',false), ('al sahab','Dubai Marina',false), ('murjan','Dubai Marina',false), ('shemara','Dubai Marina',false),
  ('al yass','Dubai Marina',false), ('al mesk','Dubai Marina',true), ('sanibel','Dubai Marina',false), ('beauport','Dubai Marina',false),
  ('mira oaisis','Reem',false), ('mira oases','Reem',false), ('sinature residence','Downtown Dubai',false),
  ('signature residence','Downtown Dubai',false), ('marina mansions','Dubai Marina',false), ('boulevard','Downtown Dubai',true),
  ('emaar','Emaar',false)
) as v(p, c, m)
where not exists (select 1 from public.emaar_property e where e.pattern = v.p);
