-- USER RULE 16 Nov 26: ring-style curtains (curtain_type Ring, NOT the eyelet-flag lines) stitch at
-- adjusted height - 4 cm on both layers and every side; PP stays "No pp". Eyelets keep their own rule
-- (adjusted height, -3 ceiling). Patches fn_rebuild_order in place from its live definition.
do $m$
declare d text; n int; ring text := $r$(d.ct = 'Ring' and coalesce(d.cat_eyelet,0) = 0 and coalesce(d.commercial_name,'') !~* 'eyelet')$r$;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p where p.proname='fn_rebuild_order' and p.pronamespace='public'::regnamespace;
  n := (length(d) - length(replace(d, $a$case when d.ct in ('American','Wave') and d.adjh is not null then d.adjh - (case when d.ct = 'Wave' then 4 else 0 end)$a$, ''))) / length($a$case when d.ct in ('American','Wave') and d.adjh is not null then d.adjh - (case when d.ct = 'Wave' then 4 else 0 end)$a$);
  if n <> 1 then raise exception 'cuth1 anchor count %', n; end if;
  d := replace(d, $a$case when d.ct in ('American','Wave') and d.adjh is not null then d.adjh - (case when d.ct = 'Wave' then 4 else 0 end)$a$,
     'case when '||ring||' and d.adjh is not null then d.adjh - 4 when d.ct in (''American'',''Wave'') and d.adjh is not null then d.adjh - (case when d.ct = ''Wave'' then 4 else 0 end)');
  if position($a$case when d.has2 and d.ct in ('American','Wave') and d.adjh is not null$a$ in d) = 0 then raise exception 'cuth2 anchor'; end if;
  d := replace(d, $a$case when d.has2 and d.ct in ('American','Wave') and d.adjh is not null$a$,
     'case when d.has2 and '||ring||' and d.adjh is not null then d.adjh - 4 when d.has2 and d.ct in (''American'',''Wave'') and d.adjh is not null');
  n := (length(d) - length(replace(d, $a$case when d.ct in ('American','Wave') and d.adjh is not null then d.cuth1$a$, ''))) / length($a$case when d.ct in ('American','Wave') and d.adjh is not null then d.cuth1$a$);
  if n <> 3 then raise exception 'side anchor count %', n; end if;
  d := replace(d, $a$case when d.ct in ('American','Wave') and d.adjh is not null then d.cuth1$a$,
     'case when (d.ct in (''American'',''Wave'') or '||ring||') and d.adjh is not null then d.cuth1');
  execute d;
end $m$;
