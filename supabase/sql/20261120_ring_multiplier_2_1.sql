-- 20 Nov 2026 (user): Ring curtains gather at 2.1, the same as American (was 2.2).
-- Applied as migration `ring_fabric_multiplier_2_1`. fn_rebuild_order now reads:
--     case when j.ct = 'Roman' then 1
--          when j.ct = 'Ring' then 2.1
--          when j.ct = 'American' then 2.1
--          when j.ct = 'Wave' then 2.3
--          else null end as mult,
-- It takes effect on the next rebuild of an order (a new order or a PO revision). Stored
-- order_lines_final rows are NOT rewritten: on 20 Nov 2026 the 59 Ring lines on file (20 orders)
-- all carried 2.2 and none of those orders installed that day or later, so nothing was rebuilt.
-- The same 2.1 / 2.3 multipliers are used by the ops-app Fabric calculation (js/mod-fabcalc.js).
do $mig$
declare src text;
begin
  select pg_get_functiondef(oid) into src from pg_proc where proname = 'fn_rebuild_order';
  if position($a$when j.ct = 'Ring' then 2.2$a$ in src) = 0 then
    raise exception 'anchor not found: fn_rebuild_order has no "when j.ct = ''Ring'' then 2.2"';
  end if;
  src := replace(src, $a$when j.ct = 'Ring' then 2.2$a$, $a$when j.ct = 'Ring' then 2.1$a$);
  execute src;
end
$mig$;
