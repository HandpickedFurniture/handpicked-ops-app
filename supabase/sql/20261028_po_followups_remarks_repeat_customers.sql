-- 28 Oct 2026 (user request)
--  1. PO module: new follow-up mark "follow_up_accounts" + a free-text remark per line
--  2. auto-tag rules: motor line taller than 4 m -> "Extra wire and trunking charge";
--     tall (>4 m) window with no scaffolding on the order -> "charge for scaffolding"
--  3. repeat-customer detection (same name AND address as another order)
--  4. scheduler thresholds: scaffolding above 400 cm, tall ladder above 350 cm

-- 1 ---------------------------------------------------------------------------------------------
alter table public.line_review_mark drop constraint line_review_mark_status_check;
alter table public.line_review_mark add constraint line_review_mark_status_check
  check (status = any (array['read','follow_up_production','follow_up_installation',
    'follow_up_procurement','follow_up_accounts','ask_coordinators','installed']));

create table if not exists public.line_remark (
  line_id    bigint primary key,
  order_id   text,
  remark     text not null default '',
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.line_remark enable row level security;
create policy p_read_all  on public.line_remark for select to authenticated using (true);
create policy p_write_ops on public.line_remark for insert to authenticated with check (not fn_is_viewer());
create policy p_update_ops on public.line_remark for update to authenticated
  using (not fn_is_viewer()) with check (not fn_is_viewer());
revoke all on public.line_remark from anon;
grant select, insert, update on public.line_remark to authenticated;
grant all on public.line_remark to service_role;

create or replace function public.fn_ops_set_line_remark(p_line_id bigint, p_remark text,
                                                         p_actor text default null, p_op uuid default null)
returns jsonb language plpgsql set search_path to 'public','pg_temp' as $$
declare v_order text;
begin
  select order_id into v_order from public.order_lines_final where id = p_line_id;
  if v_order is null then raise exception 'No order line %', p_line_id; end if;
  insert into public.line_remark (line_id, order_id, remark, updated_by)
  values (p_line_id, v_order, coalesce(p_remark, ''), p_actor)
  on conflict (line_id) do update
     set remark = excluded.remark, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('line_id', p_line_id, 'remark', coalesce(p_remark, ''));
end $$;
revoke execute on function public.fn_ops_set_line_remark(bigint, text, text, uuid) from public, anon;
grant execute on function public.fn_ops_set_line_remark(bigint, text, text, uuid) to authenticated, service_role;

-- the remark rides on the existing view as its LAST column (create or replace may only append)
create or replace view public.v_ops_line_review as
 WITH marks AS (
         SELECT line_review_mark.line_id,
            array_agg(line_review_mark.status ORDER BY line_review_mark.status) AS marks,
            array_agg(line_review_mark.status ORDER BY line_review_mark.status) FILTER (WHERE line_review_mark.actioned) AS marks_actioned,
            bool_or(line_review_mark.status = 'read'::text) AS is_read,
            count(*) FILTER (WHERE line_review_mark.status <> 'read'::text AND NOT line_review_mark.actioned) AS open_follow_ups,
            max(line_review_mark.updated_at) AS marked_at
           FROM line_review_mark
          GROUP BY line_review_mark.line_id
        ), vers AS (
         SELECT po_lines_raw.order_id,
            count(DISTINCT po_lines_raw.version_no) AS version_count
           FROM po_lines_raw
          GROUP BY po_lines_raw.order_id
        )
 SELECT f.id AS line_id,
    f.order_id,
    f.line_no,
    o.issue_flag,
    f.window_ref,
    r.linkage,
    f.supplier_type,
    f.commercial_name,
    f.window_name,
    f.optional_comment,
    f.installation_notes,
    f.l1_bottom_finish AS fabric_1_bottom_stitch,
    f.l2_bottom_finish AS fabric_2_bottom_stitch,
    f.quantity,
    f.adjusted_width_cm AS adjusted_width,
    f.adjusted_height_cm AS adjusted_height,
    f.height_variation_raw AS height_variation,
    f.brackets,
    f.opening,
    f.pooling,
    COALESCE(r.fabric1_code, f.l1_fabric) AS fabric_1_new,
    r.fabric1_qty AS fabric_1_quantity,
    COALESCE(r.fabric2_code, f.l2_fabric) AS fabric_2_new,
    r.fabric2_qty AS fabric_2_quantity,
    array_remove(ARRAY[
        CASE WHEN COALESCE(f.roman, 0) = 1 AND f.supplier_type ~~* '%production%'::text THEN 'roman_production'::text ELSE NULL::text END,
        CASE WHEN COALESCE(f.pelmet, 0) = 1 THEN 'pelmet'::text ELSE NULL::text END,
        CASE WHEN COALESCE(f.eyelet, 0) = 1 THEN 'eyelet'::text ELSE NULL::text END], NULL::text) AS procurement_req,
    COALESCE(m.marks, '{}'::text[]) AS marks,
    COALESCE(m.marks_actioned, '{}'::text[]) AS marks_actioned,
    COALESCE(m.is_read, false) AS is_read,
    COALESCE(m.open_follow_ups, 0::bigint) AS open_follow_ups,
    m.marked_at,
        CASE WHEN COALESCE(m.is_read, false) THEN 'read'::text ELSE 'unread'::text END AS read_state,
    f.customer_name,
    f.city,
    f.installation_date,
    f.production_comment,
    o.date_bucket,
    o.sheet_status,
    o.alteration,
    o.city_source,
    o.production_state,
    o.stitching_types,
    o.commercial_names,
    o.window_refs,
    o.fabric_1_codes,
    o.fabric_2_codes,
    o.search_blob,
    o.version_no,
    COALESCE(v.version_count, 1::bigint)::integer AS version_count,
    o.fabric_recv_state,
    lr.remark
   FROM order_lines_final f
     LEFT JOIN po_lines_raw r ON r.id = f.po_line_raw_id
     LEFT JOIN v_ops_order_roster o ON o.order_id = f.order_id
     LEFT JOIN marks m ON m.line_id = f.id
     LEFT JOIN vers v ON v.order_id = f.order_id
     LEFT JOIN line_remark lr ON lr.line_id = f.id;

-- 2 ---------------------------------------------------------------------------------------------
-- Each rule fires ONCE per line: its client_op_id is a fixed hash, so an event row means "already
-- handled" and un-ticking the tag by hand is respected instead of being re-applied every 10 minutes.
create or replace function public.fn_auto_accounts_followups()
returns jsonb language plpgsql set search_path to 'public','pg_temp' as $$
declare n_motor int; n_scaf int;
begin
  with t as (
    select f.id as line_id, f.order_id
      from public.order_lines_final f
     where coalesce(f.motor, 0) > 0 and f.adjusted_height_cm > 400 and f.installation_date >= current_date
       and not exists (select 1 from public.line_review_event e
                        where e.client_op_id = md5('auto-motor|' || f.id)::uuid)),
  m as (insert into public.line_review_mark (line_id, order_id, status, created_by)
        select line_id, order_id, 'follow_up_accounts', 'auto' from t
        on conflict (line_id, status) do nothing returning 1),
  e as (insert into public.line_review_event (line_id, order_id, status, action, actor, client_op_id)
        select line_id, order_id, 'follow_up_accounts', 'marked', 'auto', md5('auto-motor|' || line_id)::uuid from t
        on conflict do nothing returning 1),
  r as (insert into public.line_remark (line_id, order_id, remark, updated_by)
        select line_id, order_id, 'Extra wire and trunking charge', 'auto' from t
        on conflict (line_id) do update
           set remark = case when public.line_remark.remark ilike '%Extra wire and trunking charge%' then public.line_remark.remark
                             when coalesce(public.line_remark.remark, '') = '' then excluded.remark
                             else public.line_remark.remark || ' | ' || excluded.remark end,
               updated_at = now()
        returning 1)
  select count(*) into n_motor from t;

  with noscaf as (
    select order_id from public.order_lines_final
     where installation_date >= current_date
     group by order_id
    having coalesce(sum(scaffolding), 0) = 0
       and not bool_or((coalesce(installation_notes, '') || ' ' || coalesce(optional_comment, '')) ~* 'scaffold')),
  t as (
    select f.id as line_id, f.order_id
      from public.order_lines_final f join noscaf n on n.order_id = f.order_id
     where f.adjusted_height_cm > 400
       and not exists (select 1 from public.line_review_event e
                        where e.client_op_id = md5('auto-scaffold|' || f.id)::uuid)),
  m as (insert into public.line_review_mark (line_id, order_id, status, created_by)
        select line_id, order_id, 'follow_up_accounts', 'auto' from t
        on conflict (line_id, status) do nothing returning 1),
  e as (insert into public.line_review_event (line_id, order_id, status, action, actor, client_op_id)
        select line_id, order_id, 'follow_up_accounts', 'marked', 'auto', md5('auto-scaffold|' || line_id)::uuid from t
        on conflict do nothing returning 1),
  r as (insert into public.line_remark (line_id, order_id, remark, updated_by)
        select line_id, order_id, 'charge for scaffolding', 'auto' from t
        on conflict (line_id) do update
           set remark = case when public.line_remark.remark ilike '%charge for scaffolding%' then public.line_remark.remark
                             when coalesce(public.line_remark.remark, '') = '' then excluded.remark
                             else public.line_remark.remark || ' | ' || excluded.remark end,
               updated_at = now()
        returning 1)
  select count(*) into n_scaf from t;

  return jsonb_build_object('motor_tall', n_motor, 'scaffolding', n_scaf);
end $$;
revoke execute on function public.fn_auto_accounts_followups() from public, anon;
grant execute on function public.fn_auto_accounts_followups() to authenticated, service_role;

select cron.schedule('auto-accounts-followups', '*/10 * * * *', $$select public.fn_auto_accounts_followups()$$);

-- 3 ---------------------------------------------------------------------------------------------
-- Same customer = names share their words AND addresses share their words (unit numbers count, city
-- and generic words do not). Rebuilt wholesale: 1,600 orders, a few seconds.
create table if not exists public.order_repeat_customer (
  order_id    text primary key,
  other_orders text[] not null,
  updated_at  timestamptz not null default now()
);
alter table public.order_repeat_customer enable row level security;
create policy p_read_all on public.order_repeat_customer for select to authenticated using (true);
revoke all on public.order_repeat_customer from anon;
grant select on public.order_repeat_customer to authenticated;
grant all on public.order_repeat_customer to service_role;

create or replace function public.fn_refresh_repeat_customers()
returns int language plpgsql set search_path to 'public','pg_temp' as $$
declare n int;
begin
  create temp table _rc on commit drop as
  with base as (
    select distinct on (order_id) order_id, customer_name, client_address
      from public.order_lines_final order by order_id, line_no),
  tok as (
    select order_id,
      array(select distinct w from unnest(regexp_split_to_array(lower(regexp_replace(coalesce(customer_name, ''), '[^[:alnum:]]+', ' ', 'g')), '\s+')) w
             where length(w) >= 2) as nt,
      array(select distinct w from unnest(regexp_split_to_array(lower(regexp_replace(coalesce(client_address, ''), '[^[:alnum:]]+', ' ', 'g')), '\s+')) w
             where length(w) >= 2 and w <> all (array['dubai','abu','dhabi','uae','united','arab','emirates','apt','apartment',
               'flat','villa','building','bldg','unit','floor','street','road','the','of','and','tower','no','al'])) as at
      from base)
  select a.order_id as a_id, b.order_id as b_id
    from tok a join tok b on a.order_id < b.order_id and a.nt && b.nt and a.at && b.at
   where (select count(*) from unnest(a.nt) x where x = any (b.nt)) >= least(2, cardinality(a.nt), cardinality(b.nt))
     and (select count(*) from unnest(a.at) x where x = any (b.at)) >= least(2, cardinality(a.at), cardinality(b.at))
     and (select count(*) from unnest(a.at) x where x = any (b.at))::numeric
           / greatest(least(cardinality(a.at), cardinality(b.at)), 1) >= 0.6;

  delete from public.order_repeat_customer where true;
  insert into public.order_repeat_customer (order_id, other_orders)
  select o, array_agg(p order by p) from (
    select a_id as o, b_id as p from _rc union all select b_id, a_id from _rc) s
  group by o;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.fn_refresh_repeat_customers() from public, anon;
grant execute on function public.fn_refresh_repeat_customers() to authenticated, service_role;

select cron.schedule('refresh-repeat-customers', '*/10 * * * *', $$select public.fn_refresh_repeat_customers()$$);
select public.fn_refresh_repeat_customers();

-- 4 ---------------------------------------------------------------------------------------------
update public.sched_settings
   set value = (value::jsonb || '{"scaffold_height_cm": 400, "tall_flag_cm": 350}'::jsonb)
 where key = 'stepper_rules';
