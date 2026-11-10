-- USER RULE 29 Oct 2026: cut heights come from the PO "Height variation" column only, never from
-- comments or the gap-adjusted Adjusted Height. American / Ring / Roman = the column as written,
-- Wave = column minus 4 cm, per side. The single Stitch H (l1/l2) is the tallest side.
-- adjusted_height_cm itself is left alone (it is still the PO's own figure). Falls back to
-- adjusted_height only when the column is empty / unparseable.
do $do$
declare
  d text; o text;
begin
  d := pg_get_functiondef('public.fn_rebuild_order(text)'::regprocedure);
  o := d;
  d := replace(d, $q$      case when d.adjh is null then null
           when d.ct = 'Wave' then d.adjh - 4
           else d.adjh end as cuth1,$q$,
$q$      case when coalesce(greatest(d.hl, d.hm, d.hr), d.adjh) is null then null
           else coalesce(greatest(d.hl, d.hm, d.hr), d.adjh) - (case when d.ct = 'Wave' then 4 else 0 end) end as cuth1,$q$);
  d := replace(d, $q$case when d.has2 and d.adjh is not null$q$,
                  $q$case when d.has2 and coalesce(greatest(d.hl, d.hm, d.hr), d.adjh) is not null$q$);
  d := replace(d, $q$then d.adjh - (case when d.ct in ('American','Ring','Roman')$q$,
                  $q$then coalesce(greatest(d.hl, d.hm, d.hr), d.adjh) - (case when d.ct in ('American','Ring','Roman')$q$);
  d := replace(d, 'case when d.hl is null then d.cuth1 else d.cuth1 - (d.h_ref - d.hl) end',
                  'case when d.hl is null then d.cuth1 else d.hl - (case when d.ct = ''Wave'' then 4 else 0 end) end');
  d := replace(d, 'case when d.hm is null then d.cuth1 else d.cuth1 - (d.h_ref - d.hm) end',
                  'case when d.hm is null then d.cuth1 else d.hm - (case when d.ct = ''Wave'' then 4 else 0 end) end');
  d := replace(d, 'case when d.hr is null then d.cuth1 else d.cuth1 - (d.h_ref - d.hr) end',
                  'case when d.hr is null then d.cuth1 else d.hr - (case when d.ct = ''Wave'' then 4 else 0 end) end');
  if d = o or d like '%d.cuth1 - (d.h_ref%' or d like '%then d.adjh - (case%' then
    raise exception 'fn_rebuild_order patch did not apply cleanly';
  end if;
  execute d;
end
$do$;
