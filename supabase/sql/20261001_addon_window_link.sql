-- Add-ons (tie backs, velcro with stitching, lining) tied to their curtain by a FORGIVING window key,
-- and flagged when they match no curtain at all (user, 1 Oct 2026).
--
-- Why: order 73982's 'Velcro with stitching' line is on 'Master Bedroom right w' (one space) while
-- its curtain is 'Master  Bedroom right w' (two). Matching on the exact name, nothing tied the two
-- together, so the velcro reached no production row. Over all orders on 1 Oct 2026: 19 add-on lines
-- differed from their curtain only by spacing/case (now matched), 33 match no curtain at all (e.g.
-- 74171 'Mas', 74291 'Bed', 72702 'Living Room' vs 'Living Room LW'/'RW') - those are flagged.
--
-- Python twin: ingestion-agent/pdf_export.py window_key / is_addon / is_addon_target /
-- unlinked_addons. Keep the two in step or the PDF and the app disagree about the same order.

-- 1. The matching key: trimmed, whitespace collapsed, lower case.
create or replace function public.fn_window_key(p text)
returns text
language sql immutable parallel safe
set search_path = pg_catalog
as $$ select lower(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))) $$;

-- 2. Every add-on line of an order and whether it is linked to a curtain.
--    linked = true   its window key matches a curtain/roman/fabric row
--    linked = false  it matches none -> flagged
--    linked = null   the order has no curtain row at all (velcro-only rework on the customer's own
--                    curtains, e.g. 75054) -> nothing to confirm, not flagged
create or replace function public.fn_order_addons(p_order_id text)
returns table (line_no int, window_name text, window_key text, product text, quantity numeric,
               comment text, linked boolean)
language sql stable
set search_path = public, pg_temp
as $$
  with l as (
    select f.line_no, f.window_name, public.fn_window_key(f.window_name) as wk,
           coalesce(nullif(btrim(f.commercial_name), ''), f.curtain_type, 'add-on') as product,
           f.quantity, f.optional_comment, f.curtain_type,
           (coalesce(btrim(f.l1_fabric), '') <> '' or coalesce(btrim(f.l2_fabric), '') <> '') as has_fab,
           (coalesce(f.sku, '') in ('C-1b', 'C-1c', 'C-1d', 'C-1e')
              or f.commercial_name ilike '%tie back%'
              or f.commercial_name ilike '%velcro with stitching%'
              or f.commercial_name ~* '\mlining\M') as addon_name
    from public.order_lines_final f
    where f.order_id = p_order_id
  ), a as (
    select * from l where addon_name and not has_fab
  ), t as (
    select distinct wk from l
    where not (addon_name and not has_fab)
      and (curtain_type in ('American', 'Wave', 'Ring', 'Roman') or has_fab)
      and wk <> ''
  )
  select a.line_no, a.window_name, a.wk, a.product, a.quantity, a.optional_comment,
         case when not exists (select 1 from t) then null
              else exists (select 1 from t where t.wk = a.wk) end
  from a
  order by a.line_no
$$;

grant execute on function public.fn_window_key(text) to authenticated, service_role;
grant execute on function public.fn_order_addons(text) to authenticated, service_role;

-- 3. fn_generate_alerts: + 'addon_unlinked' (production, review), one row per unlinked add-on line.
--    Shows in the order's Production alerts tab. Body otherwise unchanged.
create or replace function public.fn_generate_alerts(p_order_id text)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- regenerate auto alerts: clear this order's OPEN alerts, keep any a human RESOLVED
  delete from public.production_alerts where order_id = p_order_id and status = 'open';

  -- DATA QUALITY (per line/window)
  insert into public.production_alerts (order_id, window_name, line_no, alert_type, category, severity, message)
  select p_order_id, f.window_name, f.line_no, 'height_review', 'data_quality', 'review',
         'Per-side heights need review: adjusted '||coalesce(f.adjusted_height_cm::text,'?')||
         ', variation '||coalesce(f.height_variation_raw,'?')
  from public.order_lines_final f
  where f.order_id = p_order_id and f.needs_height_review;

  insert into public.production_alerts (order_id, window_name, line_no, alert_type, category, severity, message)
  select p_order_id, f.window_name, f.line_no, 'pieces_ambiguous', 'data_quality', 'review',
         'Opening text not recognized, pieces uncomputed: '||coalesce(f.opening,'(blank)')
  from public.order_lines_final f
  where f.order_id = p_order_id
    and (f.l1_fabric is not null or f.l2_fabric is not null)
    and f.curtain_type is not null
    and coalesce(btrim(f.opening),'') not in ('','NA')
    and f.pieces is null;

  insert into public.production_alerts (order_id, alert_type, category, severity, message)
  select p_order_id, 'roll_width_missing', 'data_quality', 'info',
         count(*)||' curtain layer(s) have no roll width -> panel plan cannot be finalized'
  from public.order_lines_final f
  where f.order_id = p_order_id and (f.l1_roll_width_missing or f.l2_roll_width_missing)
  having count(*) > 0;

  -- PRODUCTION
  insert into public.production_alerts (order_id, window_name, alert_type, category, severity, message)
  select p_order_id, p.window_name, 'lead_band_not_possible', 'production', 'blocker',
         'Fabric roll too short to keep lead band in one piece ('||coalesce(p.fabric_code,'?')||
         ') - tell client or re-decide bottom finish'
  from public.panel_plans p
  where p.order_id = p_order_id and p.plan_type = 'lead_band_not_possible';

  insert into public.production_alerts (order_id, window_name, alert_type, category, severity, message)
  select distinct p_order_id, f.window_name, 'revised_recheck', 'production', 'review',
         'Window changed in a revision - panel plan withheld pending human review'
  from public.order_lines_final f
  where f.order_id = p_order_id and f.revised_recheck;

  -- an add-on whose window matches no curtain reaches no production row (user, 1 Oct 2026)
  insert into public.production_alerts (order_id, window_name, line_no, alert_type, category, severity, message)
  select p_order_id, a.window_name, a.line_no, 'addon_unlinked', 'production', 'review',
         a.product || coalesce(' x' || nullif(a.quantity, 1)::int::text, '') ||
         ' is on window "' || coalesce(nullif(btrim(a.window_name), ''), 'line ' || a.line_no) ||
         '", which matches no curtain in this order - confirm which window it belongs to'
  from public.fn_order_addons(p_order_id) a
  where a.linked = false;

  -- SPECIAL HANDLING (one row per order per flag, with a count)
  insert into public.production_alerts (order_id, alert_type, category, severity, message)
  select p_order_id, x.atype, 'special_handling', x.sev, x.cnt||' '||x.label
  from (
    select 'motor' atype, 'info' sev,
           count(*) filter (where motor=1) cnt, 'motorized curtain(s)' label
      from public.order_lines_final where order_id=p_order_id
    union all select 'bend','info', count(*) filter (where bend=1), 'bend-track curtain(s)'
      from public.order_lines_final where order_id=p_order_id
    union all select 'pelmet','info', count(*) filter (where pelmet=1), 'pelmet box(es)'
      from public.order_lines_final where order_id=p_order_id
    union all select 'scaffolding','review', count(*) filter (where scaffolding=1 or scaffolding_windows>0), 'window(s) needing scaffolding'
      from public.order_lines_final where order_id=p_order_id
    union all select 'pickup','info', count(*) filter (where pickup=1), 'pickup item(s)'
      from public.order_lines_final where order_id=p_order_id
    union all select 'alteration','review', count(*) filter (where alteration=1), 'alteration(s)'
      from public.order_lines_final where order_id=p_order_id
    union all select 'pull_cord','info', count(*) filter (where pull_cord_track=1 or commercial_name ~* 'pull.?cord'), 'pull-cord track(s)'
      from public.order_lines_final where order_id=p_order_id
    union all select 'hand_baton','info', count(*) filter (where commercial_name ~* 'baton'), 'hand baton stick(s)'
      from public.order_lines_final where order_id=p_order_id
    union all select 'velcro_stitching','info', count(*) filter (where commercial_name ~* '^\s*velcro with stitching'), 'velcro-with-stitching item(s)'
      from public.order_lines_final where order_id=p_order_id
    union all select 'remove_existing','review', count(*) filter (where remove_flag), 'window(s) needing existing curtains removed'
      from public.order_lines_final where order_id=p_order_id
  ) x
  where x.cnt > 0;
end $function$;

-- 4. fn_order_drawer: + 'addons' (the Status tab hangs each one under its curtain's panels and lists
--    the unlinked ones in a warning box). Body otherwise unchanged.
create or replace function public.fn_order_drawer(p_order_id text)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
select jsonb_build_object(
  'order_id', p_order_id,
  'flags', (select to_jsonb(f) from public.order_flags f where f.order_id = p_order_id),
  'installation_alerts', coalesce((
      select jsonb_agg(jsonb_build_object('type', pa.alert_type, 'severity', pa.severity,
                       'window', pa.window_name, 'message', pa.message) order by pa.id)
      from public.production_alerts pa
      where pa.order_id = p_order_id and pa.category = 'special_handling' and pa.status = 'open'), '[]'::jsonb),
  'procurement_alerts', coalesce((
      select jsonb_agg(x order by x->>'label')
      from (
        select jsonb_build_object('label', coalesce(r.fabric_code, r.item_description),
               'kind', r.grain, 'status', r.status, 'qty', r.qty_expected, 'uom', r.uom,
               'qc', r.qc_result, 'stale', r.is_stale, 'drifted', r.is_drifted,
               'po_meters', r.po_meters) as x
        from public.v_ops_receiving r
        where r.order_id = p_order_id
          and (r.status not in ('received','cancelled') or r.is_stale or r.is_drifted)
        union all
        select jsonb_build_object('label', pa.alert_type, 'kind', 'alert', 'status', pa.severity,
               'message', pa.message)
        from public.production_alerts pa
        where pa.order_id = p_order_id and pa.alert_type = 'roll_width_missing' and pa.status = 'open'
      ) s), '[]'::jsonb),
  'production_alerts', coalesce((
      select jsonb_agg(jsonb_build_object('type', pa.alert_type, 'severity', pa.severity,
                       'window', pa.window_name, 'message', pa.message) order by pa.id)
      from public.production_alerts pa
      where pa.order_id = p_order_id and pa.status = 'open'
        and (pa.category = 'production' or pa.alert_type = 'height_review')), '[]'::jsonb),
  'accounting_alerts', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'charge_type', a.charge_type, 'reason', a.reason,
                       'qty', a.quantity, 'suggested', a.suggested_amount_aed,
                       'agreed', a.agreed_amount_aed, 'chargeable', a.chargeable,
                       'status', a.status, 'source', a.source, 'visit_no', a.visit_no,
                       'rate_drift', a.rate_drift) order by a.id)
      from public.v_ops_adjustments a where a.order_id = p_order_id), '[]'::jsonb),
  'optional_comments', coalesce((
      select jsonb_agg(x order by x->>'window')
      from (
        select jsonb_build_object('window', f.window_ref, 'window_name', f.window_name,
               'optional_comment', f.optional_comment, 'installation_notes', f.installation_notes,
               'production_comment', f.production_comment) as x
        from public.order_lines_final f
        where f.order_id = p_order_id
          and (f.optional_comment is not null or f.installation_notes is not null
               or f.production_comment is not null)
      ) s), '[]'::jsonb),
  'interpreted_comments', coalesce((
      select jsonb_agg(jsonb_build_object('window', ci.window_name, 'source', ci.source,
                       'raw_text', ci.raw_text, 'special_instructions', ci.special_instructions,
                       'confidence', ci.confidence, 'review_tier', ci.review_tier,
                       'status', ci.status) order by ci.id)
      from public.comment_interpretations ci where ci.order_id = p_order_id), '[]'::jsonb),
  'emails', coalesce((
      select jsonb_agg(x order by x->>'at' desc)
      from (
        select jsonb_build_object('kind', 'event', 'type', e.event_type, 'at', e.created_at,
               'details', to_jsonb(e)) as x
        from public.order_events e where e.order_id = p_order_id
        union all
        select jsonb_build_object('kind', 'version_diff', 'type', 'PO revision',
               'at', d.created_at, 'details', to_jsonb(d))
        from public.po_version_diffs d where d.order_id = p_order_id
        union all
        select jsonb_build_object('kind', 'notification', 'type', n.event_type, 'at', n.created_at,
               'details', jsonb_build_object('team', n.team, 'channel', n.channel,
                          'status', n.status, 'error', n.error))
        from public.order_notifications n where n.order_id = p_order_id
      ) s), '[]'::jsonb),
  'ops_comments', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'visit_no', c.visit_no, 'scope', c.scope,
                       'channel', c.channel, 'body', c.body, 'author', c.author,
                       'input_method', c.input_method, 'lang', c.lang, 'at', c.created_at)
                       order by c.created_at desc)
      from public.order_comments c where c.order_id = p_order_id), '[]'::jsonb),
  'receiving', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.grain, r.fabric_code, r.item_description)
      from public.v_ops_receiving r where r.order_id = p_order_id), '[]'::jsonb),
  'prep_units', coalesce((
      select jsonb_agg(jsonb_build_object('window_name', u.window_name, 'layer_no', u.layer_no,
                       'window_key', public.fn_window_key(u.window_name),
                       'window_ref', u.window_ref, 'fabric_code', u.fabric_code,
                       'cut_width_cm', u.cut_width_cm, 'cut_height_cm', u.cut_height_cm,
                       'bottom_finish', u.bottom_finish, 'pieces_label', u.pieces_label,
                       'stage', p.stage, 'qc_result', p.qc_result, 'actor', p.actor,
                       'occurred_at', p.occurred_at)
                       order by u.window_name, u.layer_no)
      from public.v_ops_prep_units u
      left join public.v_preparation_status p
             on p.order_id = u.order_id and p.window_name = u.window_name and p.layer_no = u.layer_no
      where u.order_id = p_order_id), '[]'::jsonb),
  'addons', coalesce((
      select jsonb_agg(jsonb_build_object('line_no', a.line_no, 'window_name', a.window_name,
                       'window_key', a.window_key, 'product', a.product, 'quantity', a.quantity,
                       'comment', a.comment, 'linked', a.linked) order by a.line_no)
      from public.fn_order_addons(p_order_id) a), '[]'::jsonb),
  'dispatch', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.contractor_key)
      from public.order_dispatch d where d.order_id = p_order_id), '[]'::jsonb),
  'visits', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.visit_no)
      from public.order_visits v where v.order_id = p_order_id), '[]'::jsonb)
);
$function$;
