-- 26 Oct 2026: a Roman blind is ALWAYS a material to receive (user rule). Order 78184's kitchen roman
-- (RM-3c, stitching-and-fixing) is catalogued order_fabric, so only its fabric was receivable and the
-- blind itself never appeared in Materials. fn_generate_receiving now ALSO books one order_window
-- expectation per roman window whatever the catalog says, alongside the fabric one.
create or replace function public.fn_generate_receiving(p_order_id text)
returns void language plpgsql set search_path to 'public','pg_temp' as $function$
begin
  insert into public.receiving_expectations (order_id, grain, fabric_code, item_description, qty_expected, uom)
  select f.order_id, 'order_fabric', l.fabric, 'Fabric for curtains', sum(l.meters), 'm'
  from public.order_lines_final f
  left join public.product_catalog c on c.id = f.catalog_id
  cross join lateral (values
    (lower(btrim(f.l1_fabric)), f.l1_meters_sent),
    (lower(btrim(f.l2_fabric)), f.l2_meters_sent)
  ) l(fabric, meters)
  where f.order_id = p_order_id and l.fabric is not null
    and (c.receiving_mode = 'order_fabric' or c.id is null)
  group by f.order_id, l.fabric
  on conflict do nothing;

  insert into public.receiving_expectations (order_id, grain, window_name, item_description, qty_expected, uom)
  select distinct f.order_id, 'order_window', coalesce(btrim(f.window_name),''), f.commercial_name, coalesce(f.quantity,1), 'pc'
  from public.order_lines_final f
  left join public.product_catalog c on c.id = f.catalog_id
  where f.order_id = p_order_id
    and ( c.receiving_mode = 'order_window'
          or ((f.roman = 1 or f.commercial_name ilike '%roman%') and not coalesce(f.remove_flag, false)) )
  on conflict do nothing;

  insert into public.receiving_expectations (order_id, grain, window_name, item_description, qty_expected, uom)
  select distinct f.order_id, 'inventory', coalesce(btrim(f.window_name),''), f.commercial_name, coalesce(f.quantity,1), 'pc'
  from public.order_lines_final f
  join public.product_catalog c on c.id = f.catalog_id and c.receiving_mode = 'inventory'
  where f.order_id = p_order_id
  on conflict do nothing;
end $function$;

-- backfill: 78184 and any roman order not yet installed (past orders are left alone - a pending row on
-- a finished job is noise)
select public.fn_generate_receiving(o) from (
  select distinct order_id o from public.order_lines_final
  where (roman = 1 or commercial_name ilike '%roman%') and not coalesce(remove_flag, false)
    and (order_id = '78184' or installation_date is null or installation_date >= '2026-10-22')
) q;
