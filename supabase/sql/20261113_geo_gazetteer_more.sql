-- 13 Nov 2026 (user: "many times the distance between two locations is assumed to be just 5 minutes").
--
-- Half the addresses on the 3D sheet (50 of 99 over 75 days) matched no community and had no pin, so
-- fn_sched_resolve_location put every one of them on the city centre. Two such orders are 0 km apart,
-- which the Step scheduler read as "same building, 5 minutes". Two fixes here; the travel model in
-- js/mod-stepper.js stops treating an unknown or community-centre location as an exact point.
--
-- 1. ~60 more communities / buildings, taken from those unmatched addresses and the common communities
--    the list was missing. Centres are approximate (community level), like the rest of the table.
-- 2. The resolver matched patterns from either emirate. "Marina Heights" is a Reem Island tower AND a
--    Dubai Marina tower, so it now only takes a community from the order's own city when the city is known.

insert into public.geo_community(pattern, community, emirate, lat, lng, property_type, priority, active, note)
select v.pattern, v.community, v.emirate, v.lat, v.lng, v.ptype, 50, true, 'added 13 Nov 2026 (stepper travel fix)'
from (values
  -- Dubai
  ('springs',                 'The Springs',            'Dubai', 25.0570, 55.1790, 'villa'),
  ('meadows',                 'The Meadows',            'Dubai', 25.0640, 55.1610, 'villa'),
  ('the lakes',               'The Lakes',              'Dubai', 25.0700, 55.1620, 'villa'),
  ('emirates hills',          'Emirates Hills',         'Dubai', 25.0680, 55.1700, 'villa'),
  ('the greens',              'The Greens',             'Dubai', 25.0935, 55.1720, 'tower'),
  ('the views',               'The Views',              'Dubai', 25.0950, 55.1640, 'tower'),
  ('golf heights',            'The Views',              'Dubai', 25.0910, 55.1610, 'tower'),
  ('palm jumeirah',           'Palm Jumeirah',          'Dubai', 25.1124, 55.1390, 'mixed'),
  ('palm jumeira',            'Palm Jumeirah',          'Dubai', 25.1124, 55.1390, 'mixed'),
  ('the palm',                'Palm Jumeirah',          'Dubai', 25.1124, 55.1390, 'mixed'),
  ('royal bay',               'Palm Jumeirah',          'Dubai', 25.1180, 55.1450, 'tower'),
  ('bluewaters',              'Bluewaters',             'Dubai', 25.0790, 55.1210, 'tower'),
  ('emaar beachfront',        'Emaar Beachfront',       'Dubai', 25.0950, 55.1430, 'tower'),
  ('dubai harbour',           'Emaar Beachfront',       'Dubai', 25.0950, 55.1430, 'tower'),
  ('jumeirah golf estates',   'Jumeirah Golf Estates',  'Dubai', 25.0200, 55.2000, 'villa'),
  ('jumeirah village triangle','Jumeirah Village Triangle','Dubai', 25.0480, 55.1890, 'mixed'),
  ('jvt',                     'Jumeirah Village Triangle','Dubai', 25.0480, 55.1890, 'mixed'),
  ('jumeirah islands',        'Jumeirah Islands',       'Dubai', 25.0560, 55.1560, 'villa'),
  ('barsha heights',          'Barsha Heights',         'Dubai', 25.0980, 55.1770, 'tower'),
  ('tecom',                   'Barsha Heights',         'Dubai', 25.0980, 55.1770, 'tower'),
  ('al barsha',               'Al Barsha',              'Dubai', 25.1060, 55.2000, 'mixed'),
  ('sports city',             'Dubai Sports City',      'Dubai', 25.0400, 55.2200, 'tower'),
  ('remraam',                 'Remraam',                'Dubai', 25.0010, 55.2520, 'tower'),
  ('al barari',               'Al Barari',              'Dubai', 25.0990, 55.3150, 'villa'),
  ('serena',                  'Serena',                 'Dubai', 25.0275, 55.2900, 'villa'),
  ('city walk',               'City Walk',              'Dubai', 25.2070, 55.2620, 'tower'),
  ('boulevard central',       'Downtown Dubai',         'Dubai', 25.1950, 55.2780, 'tower'),
  ('boulevard point',         'Downtown Dubai',         'Dubai', 25.1950, 55.2780, 'tower'),
  ('boulevard heights',       'Downtown Dubai',         'Dubai', 25.1950, 55.2780, 'tower'),
  ('bin rashid boulevard',    'Downtown Dubai',         'Dubai', 25.1950, 55.2780, 'tower'),
  ('bin rashed boulevard',    'Downtown Dubai',         'Dubai', 25.1950, 55.2780, 'tower'),
  ('burj views',              'Downtown Dubai',         'Dubai', 25.1920, 55.2810, 'tower'),
  ('harbour views',           'Dubai Creek Harbour',    'Dubai', 25.2010, 55.3480, 'tower'),
  ('ontario tower',           'Business Bay',           'Dubai', 25.1860, 55.2650, 'tower'),
  ('amna tower',              'Business Bay',           'Dubai', 25.1835, 55.2565, 'tower'),
  ('noora tower',             'Business Bay',           'Dubai', 25.1835, 55.2565, 'tower'),
  ('noor townhouse',          'Town Square',            'Dubai', 25.0094, 55.2904, 'villa'),
  ('sobha waves',             'Sobha Hartland',         'Dubai', 25.1755, 55.3122, 'tower'),
  ('wilton park',             'MBR City',               'Dubai', 25.1700, 55.3000, 'tower'),
  ('umm suqeim',              'Umm Suqeim',             'Dubai', 25.1450, 55.2060, 'villa'),
  ('al khawaneej',            'Al Khawaneej',           'Dubai', 25.2300, 55.4900, 'villa'),
  ('alkhawaneej',             'Al Khawaneej',           'Dubai', 25.2300, 55.4900, 'villa'),
  ('al safa',                 'Al Safa',                'Dubai', 25.1820, 55.2400, 'villa'),
  ('al qusais',               'Al Qusais',              'Dubai', 25.2750, 55.3800, 'tower'),
  ('karama',                  'Al Karama',              'Dubai', 25.2450, 55.3030, 'tower'),
  ('satwa',                   'Al Satwa',               'Dubai', 25.2300, 55.2780, 'mixed'),
  ('al nahda',                'Al Nahda',               'Dubai', 25.2900, 55.3700, 'tower'),
  ('mirdif',                  'Mirdif',                 'Dubai', 25.2200, 55.4200, 'villa'),
  ('al warqaa',               'Al Warqa',               'Dubai', 25.1900, 55.4100, 'villa'),
  ('dubai south',             'Dubai South',            'Dubai', 24.8960, 55.1600, 'mixed'),
  ('investment park',         'Dubai Investments Park', 'Dubai', 24.9930, 55.1650, 'mixed'),
  ('studio city',             'Studio City',            'Dubai', 25.0410, 55.2460, 'tower'),
  ('healthcare city',         'Dubai Healthcare City',  'Dubai', 25.2320, 55.3220, 'tower'),
  ('jumeirah lake',           'JLT',                    'Dubai', 25.0700, 55.1410, 'tower'),
  ('akoya',                   'Damac Hills 2',          'Dubai', 24.9900, 55.3870, 'villa'),
  ('the valley',              'The Valley',             'Dubai', 24.9900, 55.4800, 'villa'),
  ('sustainable city',        'The Sustainable City',   'Dubai', 25.0300, 55.2730, 'villa'),
  -- Abu Dhabi
  ('radiant',                 'Al Reem Island',         'Abu Dhabi', 24.4980, 54.4060, 'tower'),
  ('meera shams',             'Al Reem Island',         'Abu Dhabi', 24.4960, 54.4020, 'tower'),
  ('shams meera',             'Al Reem Island',         'Abu Dhabi', 24.4960, 54.4020, 'tower'),
  ('shams abu dhabi',         'Al Reem Island',         'Abu Dhabi', 24.4960, 54.4020, 'tower'),
  ('the arc tower',           'Al Reem Island',         'Abu Dhabi', 24.4990, 54.4010, 'tower'),
  ('marina heights',          'Al Reem Island',         'Abu Dhabi', 24.4950, 54.3940, 'tower'),
  ('ansam',                   'Yas Island',             'Abu Dhabi', 24.4840, 54.5990, 'tower'),
  ('lamar residence',         'Al Raha Beach',          'Abu Dhabi', 24.4520, 54.6060, 'tower'),
  ('al muneera',              'Al Raha Beach',          'Abu Dhabi', 24.4510, 54.6050, 'tower'),
  ('al bandar',               'Al Raha Beach',          'Abu Dhabi', 24.4500, 54.6130, 'tower'),
  ('raha gardens',            'Al Raha Gardens',        'Abu Dhabi', 24.4210, 54.5850, 'villa'),
  ('masdar',                  'Masdar City',            'Abu Dhabi', 24.4270, 54.6150, 'tower'),
  ('shakhbout',               'Shakhbout City',         'Abu Dhabi', 24.3550, 54.6350, 'villa'),
  ('hydra village',           'Al Shahamah',            'Abu Dhabi', 24.5800, 54.6950, 'villa'),
  ('shahamah',                'Al Shahamah',            'Abu Dhabi', 24.5450, 54.6750, 'villa'),
  ('riyadh city',             'Madinat Al Riyad',       'Abu Dhabi', 24.3200, 54.7300, 'villa'),
  ('riyad city',              'Madinat Al Riyad',       'Abu Dhabi', 24.3200, 54.7300, 'villa'),
  ('alriyad',                 'Madinat Al Riyad',       'Abu Dhabi', 24.3200, 54.7300, 'villa'),
  ('reeman',                  'Al Shamkha',             'Abu Dhabi', 24.3640, 54.6800, 'villa'),
  ('sas al nakhl',            'Sas Al Nakhl',           'Abu Dhabi', 24.4330, 54.4580, 'villa'),
  ('al maryah',               'Al Maryah Island',       'Abu Dhabi', 24.5000, 54.3880, 'tower'),
  ('khalidiya',               'Al Khalidiyah',          'Abu Dhabi', 24.4720, 54.3500, 'tower'),
  ('al mushrif',              'Al Mushrif',             'Abu Dhabi', 24.4400, 54.3870, 'villa')
) v(pattern, community, emirate, lat, lng, ptype)
where not exists (select 1 from public.geo_community c where c.pattern = v.pattern);

create or replace function public.fn_sched_resolve_location(p_address text, p_city text, p_pin_lat numeric DEFAULT NULL::numeric, p_pin_lng numeric DEFAULT NULL::numeric)
 returns table(lat numeric, lng numeric, community text, property_type text, confidence text, anomaly boolean, anomaly_reason text)
 language plpgsql stable
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
#variable_conflict use_column
declare n text; g record; ov record; d numeric; is_villa boolean;
        em text := case when p_city ilike '%abu%' then 'Abu Dhabi' when p_city ilike '%dubai%' then 'Dubai' end;
begin
  n := public.fn_sched_norm_addr(p_address);

  -- 1. a hand-corrected address always wins
  select * into ov from public.geo_place where addr_norm = n and lat is not null;
  if found then
    return query select ov.lat, ov.lng, ov.community, ov.property_type, ov.confidence, false, null::text;
    return;
  end if;

  -- 2. address -> community gazetteer, only the order's own emirate when the city is known (13 Nov 2026)
  if n is not null then
    select * into g from public.geo_community c
      where c.active and n like '%' || c.pattern || '%'
        and (em is null or c.emirate is null or c.emirate = em)
      order by c.priority, length(c.pattern) desc limit 1;
  end if;

  -- an explicit "villa"/"townhouse" in the address overrides the community's default type,
  -- because the 20:00 late window is only allowed for independent villas
  is_villa := n is not null and (n like '%villa%' or n like '%townhouse%' or n like '%town house%');

  if found and g.lat is not null then
    d := case when p_pin_lat is not null
              then public.fn_sched_haversine(g.lat, g.lng, p_pin_lat, p_pin_lng) end;
    -- pin more than 5 km from the community centre means one of the two is wrong
    if d is not null and d > 5 then
      return query select g.lat, g.lng, g.community,
                          case when is_villa then 'villa' else g.property_type end,
                          'medium'::text, true,
                          format('Pin is %s km from %s - using the address', round(d), g.community);
      return;
    end if;
    return query select g.lat, g.lng, g.community,
                        case when is_villa then 'villa' else g.property_type end,
                        'high'::text, false, null::text;
    return;
  end if;

  -- 3. no community matched: fall back to the pin, flagged
  if p_pin_lat is not null then
    return query select p_pin_lat, p_pin_lng, null::text,
                        case when is_villa then 'villa' else 'unknown' end,
                        'low'::text, true,
                        'Address not recognised - using the GPS pin, which is often wrong'::text;
    return;
  end if;

  -- 4. city centroid. never zero distance, or the optimiser piles every unknown onto one team.
  return query select
      case when p_city ilike '%abu%' then 24.4539 else 25.2048 end::numeric,
      case when p_city ilike '%abu%' then 54.3773 else 55.2708 end::numeric,
      null::text, case when is_villa then 'villa' else 'unknown' end,
      'none'::text, true, 'No address match and no pin - using the city centre'::text;
end $function$;

-- travel settings the Step scheduler reads (js/mod-stepper.js drive()): an unknown location is a typical
-- leg, not zero; two different addresses on one community centre are a short drive, not the same door;
-- peak hours are slower.
update public.sched_settings
   set value = jsonb_set(value, '{travel}', (value -> 'travel') || jsonb_build_object(
         'unknown_min', 35, 'unknown_km', 18, 'same_community_min', 12,
         'peak_factor', 1.3, 'peak', jsonb_build_array(jsonb_build_array('07:00', '09:30'), jsonb_build_array('16:30', '19:30'))))
 where key = 'stepper_rules';
