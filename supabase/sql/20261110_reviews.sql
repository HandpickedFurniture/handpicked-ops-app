-- Reviews (#/reviews). 10 Nov 2026 (user).
--
-- When a customer leaves a 5-star review, a team member posts in the WhatsApp group "Fixer"
-- (120363427089622464@g.us) the order number and the names of the people who were on that order,
-- usually with a photo / screenshot of the review. This module counts those per day and per person.
--
--   review-capture (Edge Function, pg_cron every 5 min) -> review_message (raw copy of every Fixer message)
--     images  -> private bucket `reviews`;  Gemini reads each message into review_message.ai
--   fn_rev_rebuild()  -> review   (one row per order per report; derived, re-runnable)
--   ingestion agent reviews_drive.py -> Google Drive "Reviews/<YYYY-MM Month>/" (the photos)
--
-- Like Expense tracking, everything derived is SQL so a pairing rule can change and be re-applied to
-- history. A person's edit (status 'confirmed' / 'rejected' / 'manual') is never overwritten by a rebuild.
--
-- The message text and the photo are untrusted (anyone in the group). The model only fills fixed fields;
-- the only thing it can cause is a review row, which a person can reject.

-- ======================================================================= raw copy
create table if not exists public.review_message (
  wa_id text primary key,
  at timestamptz not null,
  day date not null,                       -- Dubai day
  sender_phone text, sender_name text,
  msg_type text,                           -- text | image | document | ...
  body text,                               -- text, or the image caption
  quoted_id text,                          -- a reply to another message
  media_id text, media_mime text, media_size bigint,
  storage_path text,                       -- bucket `reviews`
  fetched_at timestamptz, fetch_error text,
  ai jsonb, ai_at timestamptz, ai_error text,
  drive_file_id text, drive_name text, drive_folder text, drive_synced_at timestamptz, drive_error text,
  created_at timestamptz not null default now());
create index if not exists review_message_sender_at on public.review_message (sender_phone, at);

-- ======================================================================= people
-- Names are matched to team_members (name, display_name, first word of name), then to this alias list.
create table if not exists public.review_alias (
  alias text primary key,                  -- lower case
  person text not null,
  updated_at timestamptz not null default now(), updated_by text);

-- ======================================================================= reviews
create table if not exists public.review (
  id bigserial primary key,
  source_key text not null unique,         -- '<report wa_id>:<order>' | '<photo wa_id>' | 'manual:<n>'
  report_wa_id text,                       -- the message with the order number (null for a photo on its own)
  day date not null,
  at timestamptz,
  order_id text,
  people text[] not null default '{}',
  stars int,                               -- null = not stated; counted as 5
  sender_name text, sender_phone text,
  raw_text text,
  photo_wa_ids text[] not null default '{}',
  status text not null default 'auto',
  note text,
  edited_by text, edited_at timestamptz,
  customer_name text, city text, installation_date date,   -- copied from v_ops_order_roster by fn_rev_fill_orders
  order_seen text, order_found boolean,                    -- the order those were copied for; false = no such order
  created_at timestamptz not null default now(),
  constraint review_status_check check (status in ('auto','confirmed','rejected','manual')));
create index if not exists review_day on public.review (day);

create table if not exists public.review_capture_run (
  id bigserial primary key, at timestamptz not null default now(),
  trigger text, stats jsonb, error text);

do $$ declare t text; begin
  foreach t in array array['review_message','review_alias','review','review_capture_run'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists p_read_all on public.%I', t);
    execute format('create policy p_read_all on public.%I for select to authenticated using (true)', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
revoke all on sequence public.review_id_seq from anon;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('reviews', 'reviews', false, 20971520, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;
drop policy if exists reviews_read on storage.objects;
create policy reviews_read on storage.objects for select to authenticated using (bucket_id = 'reviews');

-- ======================================================================= helpers
create or replace function public.fn_rev_person(p text)
returns text language sql stable set search_path = public, pg_temp as $$
  with t as (select nullif(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')), '') as v)
  select case when t.v is null then null else coalesce(
    (select a.person from public.review_alias a where a.alias = lower(t.v)),
    (select coalesce(m.display_name, initcap(m.name)) from public.team_members m
      where lower(m.display_name) = lower(t.v) or lower(m.name) = lower(t.v)
      order by m.active desc, m.id limit 1),
    (select coalesce(m.display_name, initcap(m.name)) from public.team_members m
      where lower(split_part(m.name, ' ', 1)) = lower(t.v)
      order by m.active desc, m.id limit 1),
    initcap(t.v)) end
  from t $$;

-- every name the app knows: roster + alias targets (for the model's spelling and the text fallback)
create or replace function public.fn_rev_known_names()
returns text[] language sql stable set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct n order by n), '{}') from (
    select coalesce(display_name, initcap(name)) n from public.team_members where active
    union select person from public.review_alias) x $$;

-- order numbers in a text: 5 digits, standalone
create or replace function public.fn_rev_orders_in(p text)
returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct m[1]), '{}') from regexp_matches(coalesce(p, ''), '(?<![0-9])([0-9]{5})(?![0-9])', 'g') m $$;

-- names in a text without the model: words that are a roster name, a first name or an alias
create or replace function public.fn_rev_names_in(p text)
returns text[] language sql stable set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct public.fn_rev_person(w)), '{}')
  from regexp_split_to_table(coalesce(p, ''), '[^[:alpha:]]+') w
  where length(w) >= 3 and (
     exists (select 1 from public.team_members m where lower(m.display_name) = lower(w)
             or lower(m.name) = lower(w) or lower(split_part(m.name, ' ', 1)) = lower(w))
     or exists (select 1 from public.review_alias a where a.alias = lower(w))) $$;

-- customer / city / installation date copied from the roster when a review's order is new or changed
-- (the roster view is too heavy to join per row in v_review)
create or replace function public.fn_rev_fill_orders()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare ids text[]; n int;
begin
  select coalesce(array_agg(distinct order_id), '{}') into ids from public.review
   where order_id is not null and order_id is distinct from order_seen;
  update public.review v set customer_name = o.customer_name, city = o.city, installation_date = o.installation_date,
         order_seen = v.order_id, order_found = (o.order_id is not null)
    from (select x as order_id from unnest(ids) x) w
    left join (select r.order_id, r.customer_name, r.city, r.installation_date from public.v_ops_order_roster r
                where r.order_id = any(ids)) o on o.order_id = w.order_id
   where v.order_id = w.order_id and v.order_id is distinct from v.order_seen;
  get diagnostics n = row_count;
  update public.review set customer_name = null, city = null, installation_date = null, order_seen = null, order_found = null
   where order_id is null and order_seen is not null;
  return n;
end $$;
revoke all on function public.fn_rev_fill_orders() from public, anon, authenticated;

-- ======================================================================= rebuild
-- A REPORT is a text (or a captioned image) carrying at least one order number that either the model
-- read as a review report, or (before / without the model) has a review word, or sits next to a review
-- screenshot from the same sender. Photos: every image from the same sender within 15 minutes of a
-- report goes to the NEAREST report; a reply quoting an image takes that image. A review screenshot that
-- reaches no report still becomes a review, with no order, so it is not lost.
create or replace function public.fn_rev_rebuild()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n_new int := 0; n_upd int := 0; n_del int := 0;
begin
  drop table if exists pg_temp._m, pg_temp._r, pg_temp._p, pg_temp._new;
  create temp table _m on commit drop as
  select m.*,
         (m.msg_type in ('image','document') and m.storage_path is not null) as is_img,
         coalesce((m.ai ->> 'is_review_screenshot')::boolean, false) as is_shot,
         nullif(m.ai ->> 'stars', '')::numeric as ai_stars
    from public.review_message m;

  create temp table _r on commit drop as
  select m.wa_id, m.at, m.day, m.sender_phone, m.sender_name, m.body, m.is_img, m.is_shot, m.quoted_id,
         (select coalesce(array_agg(distinct o), '{}') from unnest(
            public.fn_rev_orders_in(m.body)
            || coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(m.ai -> 'orders') = 'array' then m.ai -> 'orders' else '[]' end)), '{}')) o
          where o ~ '^[0-9]{5}$') as orders,
         (select coalesce(array_agg(distinct p) filter (where p is not null), '{}') from unnest(
            public.fn_rev_names_in(m.body)
            || coalesce(array(select public.fn_rev_person(x) from jsonb_array_elements_text(case when jsonb_typeof(m.ai -> 'people') = 'array' then m.ai -> 'people' else '[]' end) x), '{}')) p) as people,
         m.ai_stars
    from _m m
   where coalesce(m.body, '') <> '' or m.is_shot;

  delete from _r r where cardinality(r.orders) = 0;
  delete from _r r where not (
       coalesce((select (m.ai ->> 'is_review')::boolean from _m m where m.wa_id = r.wa_id), false)
    or r.is_shot
    or ((select m.ai from _m m where m.wa_id = r.wa_id) is null
        and r.body ~* '(review|star|⭐|rating|feedback|5\s*\*|google)')
    or exists (select 1 from _m s where s.is_shot and s.sender_phone is not distinct from r.sender_phone
                and abs(extract(epoch from s.at - r.at)) <= 900)
    or exists (select 1 from _m s where s.is_shot and s.wa_id = r.quoted_id));

  -- each image -> its nearest report from the same sender (or the report quoting it, or itself)
  create temp table _p on commit drop as
  select distinct on (i.wa_id) i.wa_id as photo, r.wa_id as report
    from _m i join _r r on (r.wa_id = i.wa_id)
                        or (r.quoted_id = i.wa_id)
                        or (r.sender_phone is not distinct from i.sender_phone and abs(extract(epoch from i.at - r.at)) <= 900)
   where i.is_img
   order by i.wa_id, (r.wa_id = i.wa_id) desc, (r.quoted_id = i.wa_id) desc, abs(extract(epoch from i.at - r.at));

  create temp table _new on commit drop as
  select r.wa_id || ':' || o as source_key, r.wa_id as report_wa_id, r.day, r.at, o as order_id,
         -- no names in the text: the names the review itself mentions (read off the photo)
         case when cardinality(r.people) > 0 then r.people else coalesce((select array_agg(distinct public.fn_rev_person(x))
           from _p p join _m m on m.wa_id = p.photo
           cross join lateral jsonb_array_elements_text(case when jsonb_typeof(m.ai -> 'people') = 'array' then m.ai -> 'people' else '[]' end) x
          where p.report = r.wa_id), '{}') end as people,
         r.sender_name, r.sender_phone, r.body as raw_text,
         coalesce(array(select p.photo from _p p join _m mm on mm.wa_id = p.photo where p.report = r.wa_id order by mm.at), '{}') as photos,
         coalesce(r.ai_stars, (select max(m.ai_stars) from _p p join _m m on m.wa_id = p.photo where p.report = r.wa_id))::int as stars
    from _r r cross join lateral unnest(r.orders) o
  union all
  -- a review screenshot that reached no report
  select m.wa_id, null, m.day, m.at, null,
         coalesce(array(select public.fn_rev_person(x) from jsonb_array_elements_text(case when jsonb_typeof(m.ai -> 'people') = 'array' then m.ai -> 'people' else '[]' end) x), '{}'),
         m.sender_name, m.sender_phone, m.body, array[m.wa_id], m.ai_stars::int
    from _m m where m.is_shot and not exists (select 1 from _p p where p.photo = m.wa_id);

  insert into public.review (source_key, report_wa_id, day, at, order_id, people, sender_name, sender_phone, raw_text, photo_wa_ids, stars)
  select n.source_key, n.report_wa_id, n.day, n.at, n.order_id, n.people, n.sender_name, n.sender_phone, n.raw_text, n.photos, n.stars
    from _new n
  on conflict (source_key) do nothing;
  get diagnostics n_new = row_count;

  -- the rebuild owns 'auto' rows; for a person's row it only keeps the photos current
  update public.review v set
    report_wa_id = n.report_wa_id, day = n.day, at = n.at, order_id = n.order_id, people = n.people,
    sender_name = n.sender_name, sender_phone = n.sender_phone, raw_text = n.raw_text, photo_wa_ids = n.photos, stars = n.stars
    from _new n
   where v.source_key = n.source_key and v.status = 'auto'
     and (v.people, v.photo_wa_ids, v.stars, v.order_id, v.raw_text) is distinct from (n.people, n.photos, n.stars, n.order_id, n.raw_text);
  get diagnostics n_upd = row_count;
  update public.review v set photo_wa_ids = n.photos
    from _new n where v.source_key = n.source_key and v.status in ('confirmed','rejected') and v.photo_wa_ids is distinct from n.photos;

  delete from public.review v where v.status = 'auto' and not exists (select 1 from _new n where n.source_key = v.source_key);
  get diagnostics n_del = row_count;
  perform public.fn_rev_fill_orders();
  return jsonb_build_object('new', n_new, 'updated', n_upd, 'removed', n_del);
end $$;
revoke all on function public.fn_rev_rebuild() from public, anon, authenticated;

-- ======================================================================= views
-- counted = not rejected and 5 stars (a review whose stars nobody stated counts as 5)
create or replace view public.v_review with (security_invoker = true) as
select v.id, v.source_key, v.day, v.at, v.order_id, v.people, v.stars, v.status, v.note, v.sender_name, v.raw_text,
       v.edited_by, v.edited_at, v.report_wa_id,
       (v.status <> 'rejected' and coalesce(v.stars, 5) >= 5) as counted,
       v.customer_name, v.city, v.installation_date,
       (v.order_id is not null and v.order_found is false) as order_unknown,
       coalesce((select jsonb_agg(jsonb_build_object('wa_id', m.wa_id, 'path', m.storage_path, 'mime', m.media_mime,
                   'drive_id', m.drive_file_id, 'summary', m.ai ->> 'summary', 'reviewer', m.ai ->> 'reviewer') order by m.at)
                 from public.review_message m where m.wa_id = any(v.photo_wa_ids) and m.storage_path is not null), '[]') as photos
  from public.review v;
revoke all on public.v_review from anon;
grant select on public.v_review to authenticated;

create or replace view public.v_review_person with (security_invoker = true) as
select v.id as review_id, v.day, to_char(v.day, 'YYYY-MM') as month, v.order_id, v.city, p.person,
       (exists (select 1 from public.team_members m where coalesce(m.display_name, initcap(m.name)) = p.person)
        or exists (select 1 from public.review_alias a where a.person = p.person)) as known
  from public.review v cross join lateral unnest(v.people) p(person)
 where v.status <> 'rejected' and coalesce(v.stars, 5) >= 5;
revoke all on public.v_review_person from anon;
grant select on public.v_review_person to authenticated;

-- the photos the Drive step still has to copy: images on a review that is not rejected
create or replace view public.v_review_drive_todo with (security_invoker = true) as
select m.wa_id, m.at, m.storage_path, m.media_mime,
       string_agg(distinct coalesce(v.order_id, 'no-order'), '-') as orders,
       string_agg(distinct p.person, '-') as people
  from public.review_message m
  join public.review v on m.wa_id = any(v.photo_wa_ids) and v.status <> 'rejected'
  left join lateral unnest(v.people) p(person) on true
 where m.storage_path is not null and m.drive_synced_at is null and m.drive_error is null
 group by m.wa_id, m.at, m.storage_path, m.media_mime;
revoke all on public.v_review_drive_todo from anon, authenticated;
grant select on public.v_review_drive_todo to service_role;

-- ======================================================================= what people do
-- p: {order_id?, people?: [..], day?, stars?, status?: confirmed|rejected|auto, note?}
-- A change makes an auto row 'confirmed' so the next rebuild leaves it alone; status 'auto' hands it back.
-- A hand-added row stays 'manual' (unless rejected): as 'auto' the rebuild would delete it.
create or replace function public.fn_review_set(p_id bigint, p jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); st text;
begin
  st := nullif(p ->> 'status', '');
  if st is not null and st not in ('confirmed','rejected','auto') then raise exception 'Unknown status %', st using errcode = 'P0001'; end if;
  update public.review set
    order_id = case when p ? 'order_id' then nullif(btrim(p ->> 'order_id'), '') else order_id end,
    people   = case when p ? 'people' then coalesce(array(select distinct public.fn_rev_person(x)
                    from jsonb_array_elements_text(p -> 'people') x where btrim(x) <> ''), '{}') else people end,
    day      = case when p ? 'day' then (p ->> 'day')::date else day end,
    stars    = case when p ? 'stars' then nullif(p ->> 'stars', '')::int else stars end,
    note     = case when p ? 'note' then nullif(p ->> 'note', '') else note end,
    status   = case when st is not null then case when source_key like 'manual:%' and st <> 'rejected' then 'manual' else st end
                    when status = 'auto' then 'confirmed' else status end,
    edited_by = who, edited_at = now()
  where id = p_id;
  if not found then raise exception 'Review % not found', p_id using errcode = 'P0001'; end if;
  if st = 'auto' then perform public.fn_rev_rebuild(); else perform public.fn_rev_fill_orders(); end if;
end $$;

-- p: {day, order_id?, people: [..], stars?, note?}
create or replace function public.fn_review_add(p jsonb)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); new_id bigint;
begin
  if coalesce(p ->> 'day', '') = '' then raise exception 'Pick the date of the review' using errcode = 'P0001'; end if;
  insert into public.review (source_key, day, at, order_id, people, stars, note, status, sender_name, edited_by, edited_at)
  values ('manual:' || gen_random_uuid(), (p ->> 'day')::date, now(), nullif(btrim(p ->> 'order_id'), ''),
          coalesce(array(select distinct public.fn_rev_person(x) from jsonb_array_elements_text(coalesce(p -> 'people', '[]')) x where btrim(x) <> ''), '{}'),
          nullif(p ->> 'stars', '')::int, nullif(p ->> 'note', ''), 'manual', who, who, now())
  returning id into new_id;
  perform public.fn_rev_fill_orders();
  return new_id;
end $$;

-- "Mohsn" is Mohsin: remembered, and every review already holding that name is corrected.
-- An alias to itself ("Asif" -> "Asif") accepts a name that is not on team_members as a person.
create or replace function public.fn_review_alias_set(p_alias text, p_person text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard(); a text := lower(btrim(coalesce(p_alias, ''))); t text := btrim(coalesce(p_person, ''));
begin
  if a = '' or t = '' then raise exception 'Both names are needed' using errcode = 'P0001'; end if;
  t := public.fn_rev_person(t);
  insert into public.review_alias (alias, person, updated_by) values (a, t, who)
  on conflict (alias) do update set person = excluded.person, updated_at = now(), updated_by = who;
  update public.review set people = coalesce(array(select distinct public.fn_rev_person(x) from unnest(people) x), '{}')
   where exists (select 1 from unnest(people) x where lower(x) = a);
  perform public.fn_rev_rebuild();
end $$;

-- the Refresh button and pg_cron: ask review-capture to read the Fixer group now
create or replace function public.fn_rev_run_capture(p_trigger text default 'manual', p_days int default 2)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_key text; v_req bigint;
begin
  if auth.uid() is not null and public.fn_is_viewer() then raise exception 'Your role can look but not refresh' using errcode = 'P0001'; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'review_capture_secret';
  select net.http_post(
    url := 'https://jrevqijbzzwdcwxcnwfa.supabase.co/functions/v1/review-capture',
    body := jsonb_build_object('trigger', p_trigger, 'days', p_days),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-capture-key', v_key,
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpyZXZxaWpienp3ZGN3eGNud2ZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMDYyMDQsImV4cCI6MjA5OTc4MjIwNH0.kd1OBmwhyn-JdniDALMWkvG8duIGBGJnkB7xSPFoNiY'),
    timeout_milliseconds := 145000) into v_req;
  return v_req;
end $$;

revoke all on function public.fn_review_set(bigint, jsonb), public.fn_review_add(jsonb),
  public.fn_review_alias_set(text, text), public.fn_rev_run_capture(text, int) from public, anon;
grant execute on function public.fn_review_set(bigint, jsonb), public.fn_review_add(jsonb),
  public.fn_review_alias_set(text, text), public.fn_rev_run_capture(text, int) to authenticated;
grant execute on function public.fn_rev_person(text), public.fn_rev_known_names(), public.fn_rev_orders_in(text),
  public.fn_rev_names_in(text) to authenticated, service_role;
grant execute on function public.fn_rev_rebuild() to service_role;

-- ======================================================================= secret + schedule
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'review_capture_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'review_capture_secret', 'x-capture-key for review-capture');
  end if;
end $$;

create or replace function public.fn_wa_secret(p_name text)
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets
   where name = p_name and p_name in ('whapi_token', 'wa_webhook_secret', 'expense_capture_secret', 'review_capture_secret')
$$;

select cron.unschedule('handpicked-review-capture') where exists (select 1 from cron.job where jobname = 'handpicked-review-capture');
select cron.schedule('handpicked-review-capture', '*/5 * * * *', $$select public.fn_rev_run_capture('cron', 2)$$);
