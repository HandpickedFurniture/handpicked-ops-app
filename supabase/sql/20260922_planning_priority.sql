-- Planning priority: High / Medium / Low on the workshop sheet.  22 September 2026.
-- APPLIED as migration `planning_priority`.
--
-- Asked for as a COLOUR, and given no column of its own (user): the sheet already fits fourteen
-- columns on one portrait page, so the mark rides inside the order cell and the colour runs down
-- the row's left edge. The app never sends colour alone - the letter H / M / L and a translated
-- word travel with it, so the mark survives a monochrome printout.
--
-- GRAIN: one row per order, on planning_status beside the stage ticks and the comment, because that
-- is the grain the sheet is ticked at. NULL is "no priority" - the absence of a value, not a fourth
-- value - and it is what almost every row holds.
--
-- Nothing downstream reads it. Unlike a stage tick, which v_ops_order_roster.production_state turns
-- into a Dashboard position the same second, a priority is the sheet's own note about the order of
-- the day's work. That is why the app asks no question before changing one.

alter table public.planning_status add column if not exists priority text;

alter table public.planning_status drop constraint if exists planning_status_priority_check;
alter table public.planning_status add constraint planning_status_priority_check
  check (priority is null or priority = any (array['high'::text, 'medium'::text, 'low'::text]));

-- Set-state, replay-safe through the app's offline queue, and it refuses an order id that is not in
-- the order tables - the same shape as fn_ops_planning_set / _comment. SECURITY INVOKER on purpose:
-- planning_status' write policies (not fn_is_viewer()) are what keep a viewer out, and a blocked
-- write there returns the row unchanged rather than an error.
create or replace function public.fn_ops_planning_priority(p_order_id text, p_priority text, p_actor text)
 returns jsonb
 language plpgsql
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare v_row public.planning_status;
begin
  if p_priority is not null and p_priority not in ('high', 'medium', 'low') then
    raise exception 'unknown planning priority %', p_priority;
  end if;
  if not exists (select 1 from public.order_lines_final where order_id = p_order_id) then
    raise exception 'order % is not in the order tables', p_order_id;
  end if;
  insert into public.planning_status (order_id, priority, updated_by) values (p_order_id, p_priority, p_actor)
  on conflict (order_id) do update set priority = excluded.priority, updated_by = excluded.updated_by;
  select * into v_row from public.planning_status where order_id = p_order_id;
  return to_jsonb(v_row);
end $function$;

revoke all on function public.fn_ops_planning_priority(text, text, text) from public;
grant execute on function public.fn_ops_planning_priority(text, text, text) to authenticated, service_role;

-- v_ops_report_orders gains plan_priority, appended after plan_updated_at.
--
-- The view is rebuilt from its OWN definition with one column spliced in, rather than from a copy of
-- the SELECT pasted here: a pasted copy is a second source of truth that goes stale the moment
-- anything else touches the view, and this view is 68 columns of five joins. The anchor is asserted,
-- so a view that has changed shape stops the migration instead of being rewritten from a guess.
-- CREATE OR REPLACE keeps the grants (authenticated / service_role; anon was revoked across the
-- schema on 18 Sep 2026 and must NOT come back) and the view has no reloptions to lose - it is not
-- security_invoker, so there is none to reset either.
do $$
declare v_def text; v_new text;
begin
  v_def := pg_get_viewdef('public.v_ops_report_orders'::regclass, true);
  v_new := replace(v_def,
    '    pl.updated_at AS plan_updated_at' || chr(10) || '   FROM v_ops_order_roster r',
    '    pl.updated_at AS plan_updated_at,' || chr(10) || '    pl.priority AS plan_priority' || chr(10) || '   FROM v_ops_order_roster r');
  if v_new = v_def then
    raise exception 'v_ops_report_orders: plan_updated_at anchor not found - the view changed shape';
  end if;
  execute 'create or replace view public.v_ops_report_orders as ' || rtrim(btrim(v_new), ';');
end $$;
