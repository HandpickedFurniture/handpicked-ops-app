-- 25 Oct 2026: fn_sched_is_emaar matched only "the springs" / "the meadows" / "mira oasis", so addresses
-- written "Springs 1, Street 4, Villa 27" (78185), "Meadows 9 ...", "Mira 5 Community ..." and
-- "... Hadaeq Sheikh Mohammed" (Dubai Hills) were not flagged Emaar in the Step scheduler or #/schedule.
-- Checked against every address in v_installation_schedule_live before adding: 6 newly matched, all real
-- Emaar, no false matches. Bare "mira" is deliberately NOT a pattern: it sits inside "emirates".
insert into public.emaar_property (pattern, community, note)
select v.p, v.c, 'added 25 Oct 2026: address written without "the" (e.g. "Springs 1, Street 4"); 78185 was missed'
from (values
  ('springs 1','Emirates Living - The Springs'),('springs 2','Emirates Living - The Springs'),('springs 3','Emirates Living - The Springs'),
  ('springs 4','Emirates Living - The Springs'),('springs 5','Emirates Living - The Springs'),('springs 6','Emirates Living - The Springs'),
  ('springs 7','Emirates Living - The Springs'),('springs 8','Emirates Living - The Springs'),('springs 9','Emirates Living - The Springs'),
  ('meadows 1','Emirates Living - The Meadows'),('meadows 2','Emirates Living - The Meadows'),('meadows 3','Emirates Living - The Meadows'),
  ('meadows 4','Emirates Living - The Meadows'),('meadows 5','Emirates Living - The Meadows'),('meadows 6','Emirates Living - The Meadows'),
  ('meadows 7','Emirates Living - The Meadows'),('meadows 8','Emirates Living - The Meadows'),('meadows 9','Emirates Living - The Meadows'),
  ('mira 1','Mira'),('mira 2','Mira'),('mira 3','Mira'),('mira 4','Mira'),('mira 5','Mira'),
  ('emirates living','Emirates Living'),
  ('hadaeq sheikh mohammed','Dubai Hills Estate'),('park heights','Dubai Hills Estate'),('mulberry','Dubai Hills Estate'),
  ('the valley','The Valley')
) v(p, c)
where not exists (select 1 from public.emaar_property e where e.pattern = v.p);
