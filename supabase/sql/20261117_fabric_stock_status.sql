-- Fabric stock status fed by suppliers / staff through the public page fabric-stock.html (17 Nov 2026).
-- No login yet: the page talks to the edge function fabric-stock (verify_jwt off), which calls the
-- three fn_fabric_stock_* functions with the service role. anon gets nothing; access control comes later.
-- APPLIED to jrevqijbzzwdcwxcnwfa as migration "fabric_stock_status".

create table if not exists public.fabric_stock_status (
  fabric_code   text primary key,
  supplier_code text not null,
  available     boolean,
  qty_m         numeric check (qty_m is null or qty_m >= 0),
  note          text,
  source        text not null default 'app' check (source in ('app','upload')),
  updated_by    text,
  updated_at    timestamptz not null default now()
);
create index if not exists fabric_stock_status_supplier_idx on public.fabric_stock_status (supplier_code);

create table if not exists public.fabric_stock_status_log (
  id          bigint generated always as identity primary key,
  fabric_code text not null,
  available   boolean,
  qty_m       numeric,
  note        text,
  source      text,
  updated_by  text,
  logged_at   timestamptz not null default now()
);
create index if not exists fabric_stock_status_log_code_idx on public.fabric_stock_status_log (fabric_code, logged_at desc);

alter table public.fabric_stock_status enable row level security;
alter table public.fabric_stock_status_log enable row level security;
revoke all on public.fabric_stock_status, public.fabric_stock_status_log from anon;
grant select on public.fabric_stock_status, public.fabric_stock_status_log to authenticated;
drop policy if exists fabric_stock_status_read on public.fabric_stock_status;
create policy fabric_stock_status_read on public.fabric_stock_status for select to authenticated using (true);
drop policy if exists fabric_stock_status_log_read on public.fabric_stock_status_log;
create policy fabric_stock_status_log_read on public.fabric_stock_status_log for select to authenticated using (true);

-- Supplier = letter prefix of a code that looks like PREFIX123-.. or PREFIX-12 (FD523B-16, MCJ4-1, TSLW-12).
-- Named collections (HAVEN-AMBER, CLASSIC-BASIX-...) go under OTHER; junk without letters is dropped.
create or replace function public.fn_fabric_supplier_of(p_code text)
returns text language sql immutable as $$
  select case
    when upper(trim(p_code)) ~ '^[A-Z]+[0-9]' or upper(trim(p_code)) ~ '^[A-Z]+-[0-9]+[A-Z]?$'
      then substring(upper(trim(p_code)) from '^[A-Z]+')
    when upper(trim(p_code)) ~ '^[A-Z]' and upper(trim(p_code)) !~ '^SELECTED' then 'OTHER'
  end
$$;

create or replace view public.v_fabric_master with (security_invoker = true) as
with codes as (
  select upper(trim(fabric_code)) as fabric_code, roll_width_cm, 0 as uses from public.fabric_roll_widths
  union all
  select upper(trim(fabric_code)), null, 1 from public.v_order_fabrics where coalesce(trim(fabric_code),'') <> ''
)
select fabric_code, public.fn_fabric_supplier_of(fabric_code) as supplier_code,
       max(roll_width_cm) as roll_width_cm, sum(uses)::int as order_lines
from codes
where public.fn_fabric_supplier_of(fabric_code) is not null
group by fabric_code;
revoke all on public.v_fabric_master from anon;
grant select on public.v_fabric_master to authenticated;

create or replace function public.fn_fabric_stock_suppliers()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', supplier_code, 'fabrics', n, 'updated', u, 'last_update', lu)
                  order by (supplier_code = 'OTHER'), n desc), '[]'::jsonb)
  from (
    select m.supplier_code, count(*) n, count(s.fabric_code) u, max(s.updated_at) lu
    from v_fabric_master m left join fabric_stock_status s using (fabric_code)
    group by m.supplier_code
  ) x
$$;

create or replace function public.fn_fabric_stock_list(p_supplier text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', m.fabric_code, 'roll_width_cm', m.roll_width_cm, 'order_lines', m.order_lines,
           'available', s.available, 'qty_m', s.qty_m, 'note', s.note, 'source', s.source,
           'updated_by', s.updated_by, 'updated_at', s.updated_at) order by m.fabric_code), '[]'::jsonb)
  from v_fabric_master m left join fabric_stock_status s using (fabric_code)
  where m.supplier_code = upper(trim(p_supplier))
$$;

-- p_rows: [{code, available (bool|null), qty_m (num|null), note}]. Only codes in v_fabric_master are saved;
-- the rest come back in "skipped". Every save is also appended to the log.
create or replace function public.fn_fabric_stock_save(p_rows jsonb, p_by text, p_source text default 'app')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_by text := left(nullif(trim(p_by), ''), 80);
  v_src text := case when p_source = 'upload' then 'upload' else 'app' end;
  v_saved int := 0;
  v_skipped jsonb;
begin
  if v_by is null then raise exception 'Please enter your name before saving' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be a list' using errcode = 'P0001'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Too many rows in one save (max 5000)' using errcode = 'P0001'; end if;

  create temp table _in on commit drop as
  select distinct on (upper(trim(r->>'code')))
         upper(trim(r->>'code')) as code,
         case when jsonb_typeof(r->'available') = 'boolean' then (r->>'available')::boolean end as available,
         case when jsonb_typeof(r->'qty_m') = 'number' and (r->>'qty_m')::numeric >= 0 then round((r->>'qty_m')::numeric, 2) end as qty_m,
         left(nullif(trim(r->>'note'), ''), 300) as note
  from jsonb_array_elements(p_rows) with ordinality as t(r, i)
  where coalesce(trim(r->>'code'), '') <> ''
  order by upper(trim(r->>'code')), i desc;

  select coalesce(jsonb_agg(code), '[]'::jsonb) into v_skipped
  from _in where code not in (select fabric_code from v_fabric_master);

  insert into fabric_stock_status as s (fabric_code, supplier_code, available, qty_m, note, source, updated_by, updated_at)
  select i.code, m.supplier_code, i.available, i.qty_m, i.note, v_src, v_by, now()
  from _in i join v_fabric_master m on m.fabric_code = i.code
  on conflict (fabric_code) do update
    set available = excluded.available, qty_m = excluded.qty_m, note = excluded.note,
        source = excluded.source, updated_by = excluded.updated_by, updated_at = now();
  get diagnostics v_saved = row_count;

  insert into fabric_stock_status_log (fabric_code, available, qty_m, note, source, updated_by)
  select i.code, i.available, i.qty_m, i.note, v_src, v_by
  from _in i where i.code in (select fabric_code from v_fabric_master);

  return jsonb_build_object('saved', v_saved, 'skipped', v_skipped);
end $$;

revoke all on function public.fn_fabric_stock_suppliers(), public.fn_fabric_stock_list(text),
  public.fn_fabric_stock_save(jsonb, text, text) from public, anon, authenticated;
grant execute on function public.fn_fabric_stock_suppliers(), public.fn_fabric_stock_list(text),
  public.fn_fabric_stock_save(jsonb, text, text) to service_role;
