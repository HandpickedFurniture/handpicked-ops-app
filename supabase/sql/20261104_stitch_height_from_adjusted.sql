-- USER RULE 4 Nov 2026 (supersedes the American/Wave part of 20261029_cut_height_from_variation):
-- American stitching height = adjusted_height; Wave = adjusted_height - 4, on every side and both layers.
-- (74156 Hussein room: Height Variation 352 but adjusted 349 -> PDF printed 352, must be 349.)
-- Ring / Roman / others keep the 29 Oct behaviour (Height Variation column per side).
do $do$
declare
  d text; o text;
begin
  d := pg_get_functiondef('public.fn_rebuild_order(text)'::regprocedure);
  o := d;
  d := replace(d, $q$      case when coalesce(greatest(d.hl, d.hm, d.hr), d.adjh) is null then null
           else coalesce(greatest(d.hl, d.hm, d.hr), d.adjh) - (case when d.ct = 'Wave' then 4 else 0 end) end as cuth1,$q$,
$q$      case when d.ct in ('American','Wave') and d.adjh is not null then d.adjh - (case when d.ct = 'Wave' then 4 else 0 end)
           when coalesce(greatest(d.hl, d.hm, d.hr), d.adjh) is null then null
           else coalesce(greatest(d.hl, d.hm, d.hr), d.adjh) - (case when d.ct = 'Wave' then 4 else 0 end) end as cuth1,$q$);
  d := replace(d, $q$      case when d.has2 and coalesce(greatest(d.hl, d.hm, d.hr), d.adjh) is not null
             then coalesce(greatest(d.hl, d.hm, d.hr), d.adjh)$q$,
$q$      case when d.has2 and d.ct in ('American','Wave') and d.adjh is not null
             then d.adjh - (case when d.ct = 'Wave' then 4 else 0 end)
           when d.has2 and coalesce(greatest(d.hl, d.hm, d.hr), d.adjh) is not null
             then coalesce(greatest(d.hl, d.hm, d.hr), d.adjh)$q$);
  d := replace(d, 'case when d.hl is null then d.cuth1 else d.hl -',
                  'case when d.ct in (''American'',''Wave'') and d.adjh is not null then d.cuth1 when d.hl is null then d.cuth1 else d.hl -');
  d := replace(d, 'case when d.hm is null then d.cuth1 else d.hm -',
                  'case when d.ct in (''American'',''Wave'') and d.adjh is not null then d.cuth1 when d.hm is null then d.cuth1 else d.hm -');
  d := replace(d, 'case when d.hr is null then d.cuth1 else d.hr -',
                  'case when d.ct in (''American'',''Wave'') and d.adjh is not null then d.cuth1 when d.hr is null then d.cuth1 else d.hr -');
  if d = o or d not like '%d.ct in (''American'',''Wave'') and d.adjh is not null then d.adjh%' then
    raise exception 'fn_rebuild_order patch did not apply cleanly';
  end if;
  execute d;
end
$do$;
