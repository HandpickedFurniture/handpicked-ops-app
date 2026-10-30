-- 30 Oct 2026: Emaar property list (EMAAR.docx) loaded into emaar_property. Real misses before this:
-- Boulevard Central (78345, 78096), Bonaire Tower, The Fairways North Tower, Marina Quays, Marina Vista, Sidra village.
-- fn_sched_is_emaar now matches at the START of a word (so "maple" no longer fires inside "example"); a pattern
-- ending in a space also has to end on a word edge ("una " does not match "unaware"). Deliberately NOT added
-- (generic, or a different developer): reem / al reem (Abu Dhabi, Aldar), al ghaf (Tilal Al Ghaf), aurora (alone),
-- eden, sun, spring, june, joy, may, casa, lila, palma, rosa, rasha, samara, yasmin, tower 1, podium, panorama,
-- the residences, the lofts, collective, socio, acacia, al nakheel, fairfield.
create or replace function public.fn_sched_is_emaar(p_addr text)
returns boolean language sql stable set search_path to 'public','extensions','pg_temp' as $$
  select exists (
    select 1 from public.emaar_property e
     where e.active and ' ' || public.fn_sched_norm_addr(p_addr) || ' ' like '% ' || e.pattern || '%');
$$;

insert into public.emaar_property (pattern, community, note)
select v.p, v.c, 'EMAAR.docx 30 Oct 2026'
from (values
 ('al mahra','Arabian Ranches'),('al reem 1','Arabian Ranches'),('al reem 2','Arabian Ranches'),('al reem 3','Arabian Ranches'),
 ('alma 1','Arabian Ranches'),('alma 2','Arabian Ranches'),('alvorada','Arabian Ranches'),('aseel','Arabian Ranches'),('hattan','Arabian Ranches'),
 ('la avenida','Arabian Ranches'),('mirador','Arabian Ranches'),('palmera','Arabian Ranches'),('terranova','Arabian Ranches'),
 ('azelea','Arabian Ranches II'),('azalea','Arabian Ranches II'),('camelia','Arabian Ranches II'),
 ('bliss','Arabian Ranches III'),('elie saab','Arabian Ranches III'),('anya ','Arabian Ranches III'),('anya ii','Arabian Ranches III'),
 ('29 boulevard','Downtown Dubai'),('8 boulevard','Downtown Dubai'),('act one','Downtown Dubai'),('bd grande','Downtown Dubai'),
 ('boulevard central','Downtown Dubai'),('boulevard crescent','Downtown Dubai'),('boulevard heights','Downtown Dubai'),('boulevard point','Downtown Dubai'),
 ('burj crown','Downtown Dubai'),('burj royale','Downtown Dubai'),('burj views','Downtown Dubai'),('burj vista','Downtown Dubai'),
 ('claren ','Downtown Dubai'),('downtown views','Downtown Dubai'),('forte ','Downtown Dubai'),('old town','Downtown Dubai'),
 ('opera grand','Downtown Dubai'),('south ridge','Downtown Dubai'),('standpoint','Downtown Dubai'),
 ('breeze building','Dubai Creek Harbour'),('bay shore building','Dubai Creek Harbour'),('summer building','Dubai Creek Harbour'),
 ('sunset building','Dubai Creek Harbour'),('surf building','Dubai Creek Harbour'),('dc lotus','Dubai Creek Harbour'),('dc orchid','Dubai Creek Harbour'),
 ('dc grove','Dubai Creek Harbour'),('dc rosewater','Dubai Creek Harbour'),('dc cedar','Dubai Creek Harbour'),('dc canopy','Dubai Creek Harbour'),
 ('dc moor','Dubai Creek Harbour'),('dc savanna','Dubai Creek Harbour'),('dc mongrove','Dubai Creek Harbour'),('creek crescent','Dubai Creek Harbour'),
 ('creek edge','Dubai Creek Harbour'),('creek gate','Dubai Creek Harbour'),('creek rise','Dubai Creek Harbour'),('creek side','Dubai Creek Harbour'),
 ('icon bay','Dubai Creek Harbour'),('dubai creek residences','Dubai Creek Harbour'),('harbour gate','Dubai Creek Harbour'),('harubor gate','Dubai Creek Harbour'),
 ('harbour views','Dubai Creek Harbour'),('island park','Dubai Creek Harbour'),('the cove ','Dubai Creek Harbour'),('the cove ii','Dubai Creek Harbour'),
 ('address hillcrest','Dubai Hills Estate'),('dubai hills business park','Dubai Hills Estate'),('elvira','Dubai Hills Estate'),('emerald hills','Dubai Hills Estate'),
 ('fairways','Dubai Hills Estate'),('gold grand','Dubai Hills Estate'),('golf grove','Dubai Hills Estate'),('golf place','Dubai Hills Estate'),
 ('golf suites','Dubai Hills Estate'),('golfville','Dubai Hills Estate'),('hills grove','Dubai Hills Estate'),('lime garden','Dubai Hills Estate'),
 ('park field','Dubai Hills Estate'),('park gate','Dubai Hills Estate'),('park horizon','Dubai Hills Estate'),('park points','Dubai Hills Estate'),
 ('park ridge','Dubai Hills Estate'),('parkside views','Dubai Hills Estate'),('parkways','Dubai Hills Estate'),('sidra','Dubai Hills Estate'),
 ('palm hills','Dubai Hills Estate'),('majestics vistas','Dubai Hills Estate'),
 ('al majara','Dubai Marina'),('al sahab','Dubai Marina'),('marina homes','Dubai Marina'),('dubai marina towers','Dubai Marina'),
 ('al mass','Dubai Marina'),('al yass','Dubai Marina'),('anbar','Dubai Marina'),('fairooz','Dubai Marina'),('mesk ','Dubai Marina'),('murjan','Dubai Marina'),
 ('marina promenade','Dubai Marina'),('atessa','Dubai Marina'),('beauport','Dubai Marina'),('delphine','Dubai Marina'),('paloma ','Dubai Marina'),
 ('shemara','Dubai Marina'),('marina quays','Dubai Marina'),('park island','Dubai Marina'),('blakely','Dubai Marina'),('bonaire','Dubai Marina'),('sanibel','Dubai Marina'),
 ('beach mension','Emaar Beachfront'),('beach mansion','Emaar Beachfront'),('beach vista','Emaar Beachfront'),('beach isle','Emaar Beachfront'),
 ('grand bleu','Emaar Beachfront'),('marina vista','Emaar Beachfront'),('sunrise bay','Emaar Beachfront'),
 ('es fairway','Emaar South'),('golf links','Emaar South'),('golf views','Emaar South'),('greenview','Emaar South'),('urbana ','Emaar South'),
 ('emaar towers','Emaar Towers'),
 ('emirates hills','Emirates Living'),('montgomerie','Emirates Living'),('montgomorie','Emirates Living'),('deema','Emirates Living'),
 ('forat ','Emirates Living'),('ghadeer','Emirates Living'),('maeen','Emirates Living'),('zulal','Emirates Living'),('polo homes','Emirates Living'),
 ('seagate','Emirates Living'),('sunridge','Emirates Living'),('rashid yacht','Emirates Living'),('al alka','Emirates Living'),('al arta','Emirates Living'),
 ('al dhafrah','Emirates Living'),('al ghozlan','Emirates Living'),('al jaz ','Emirates Living'),('al samar','Emirates Living'),('al sidir','Emirates Living'),
 ('al thayyal','Emirates Living'),('golf heights','Emirates Living'),('golf towers','Emirates Living'),('mosela','Emirates Living'),('tanaro','Emirates Living'),
 ('the fairways','Emirates Living'),('the links ','Emirates Living'),('travo ','Emirates Living'),('turia ','Emirates Living'),
 ('springs 10','Emirates Living - The Springs'),('springs 11','Emirates Living - The Springs'),('springs 12','Emirates Living - The Springs'),
 ('springs 13','Emirates Living - The Springs'),('springs 14','Emirates Living - The Springs'),('springs 15','Emirates Living - The Springs'),
 ('vida residence','The Hills'),('the hills ','The Hills'),('umm al quwain mistral','Mistral'),('al murad','Al Murad Tower')
) v(p, c)
where not exists (select 1 from public.emaar_property e where e.pattern = v.p);
