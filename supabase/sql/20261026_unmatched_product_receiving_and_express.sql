-- 26 Oct 2026
-- 1. A product that is not in product_catalog yet (79135 / RC-2) must still be receivable.
--    Both the receiving builder and the prep view joined the catalog and kept only receiving_mode =
--    'order_fabric', so an unmatched line with fabric vanished from Planning altogether. Rule now: a
--    line with a fabric code and NO catalog row is treated as order_fabric (fabric is the only thing
--    we can receive for an unknown product). Lines whose catalog row says otherwise are unchanged.
-- 2. v_ops_express_orders: an order is "express" when it has a 2-Day Express Installation line
--    (sku EXP-*). The app tags every order number it shows with this.

create or replace function public.fn_generate_receiving(p_order_id text)
returns void language plpgsql set search_path to 'public','pg_temp' as $function$
begin
  -- order-fabric grain (American / Ripplefold / Eyelet curtains, and any product not in the catalog yet)
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

  -- order-window grain (motorized tracks, motors, remotes, all blinds, cassettes)
  insert into public.receiving_expectations (order_id, grain, window_name, item_description, qty_expected, uom)
  select distinct f.order_id, 'order_window', coalesce(btrim(f.window_name),''), f.commercial_name, coalesce(f.quantity,1), 'pc'
  from public.order_lines_final f
  join public.product_catalog c on c.id = f.catalog_id and c.receiving_mode = 'order_window'
  where f.order_id = p_order_id
  on conflict do nothing;

  -- inventory grain (pull cord tracks, hand baton sticks - self-procured)
  insert into public.receiving_expectations (order_id, grain, window_name, item_description, qty_expected, uom)
  select distinct f.order_id, 'inventory', coalesce(btrim(f.window_name),''), f.commercial_name, coalesce(f.quantity,1), 'pc'
  from public.order_lines_final f
  join public.product_catalog c on c.id = f.catalog_id and c.receiving_mode = 'inventory'
  where f.order_id = p_order_id
  on conflict do nothing;
end $function$;

create or replace view public.v_ops_prep_units with (security_invoker = on) as
 SELECT f.order_id,
    btrim(f.window_name) AS window_name,
    l.n AS layer_no,
    max(f.window_ref) AS window_ref,
    max(f.window_no) AS window_no,
    max(l.fab) AS fabric_code,
    max(f.curtain_type) AS curtain_type,
    max(f.curtain_stitching_type) AS curtain_stitching_type,
    max(f.installation_date) AS installation_date,
    max(CASE WHEN (l.n = 1) THEN f.l1_cut_width_cm ELSE f.l2_cut_width_cm END) AS cut_width_cm,
    max(CASE
            WHEN fn_is_eyelet(f.eyelet, f.commercial_name) THEN fn_eyelet_stitch_h(f.adjusted_height_cm, f.brackets, f.drilling_type, f.installation_notes)
            WHEN (l.n = 1) THEN f.l1_cut_height_cm
            ELSE f.l2_cut_height_cm
        END) AS cut_height_cm,
    max(CASE WHEN (l.n = 1) THEN f.l1_bottom_finish ELSE f.l2_bottom_finish END) AS bottom_finish,
    max(f.pieces) AS pieces,
    max(f.pieces_label) AS pieces_label
   FROM order_lines_final f
     LEFT JOIN product_catalog c ON c.id = f.catalog_id
     CROSS JOIN LATERAL ( VALUES (1,f.l1_fabric), (2,f.l2_fabric)) l(n, fab)
  WHERE l.fab IS NOT NULL AND btrim(COALESCE(f.window_name, '')) <> ''
    AND (c.receiving_mode = 'order_fabric'::receiving_mode OR c.id IS NULL)
  GROUP BY f.order_id, (btrim(f.window_name)), l.n;

create or replace view public.v_ops_express_orders with (security_invoker = on) as
 select distinct order_id from public.order_lines_final where sku ilike 'EXP-%';
revoke all on public.v_ops_express_orders from anon;
grant select on public.v_ops_express_orders to authenticated, service_role;

-- backfill: every order that already has an unmatched fabric line and no fabric expectation
select public.fn_generate_receiving(o) from (
  select distinct f.order_id o from public.order_lines_final f
  where f.catalog_id is null and (f.l1_fabric is not null or f.l2_fabric is not null)
) q;
