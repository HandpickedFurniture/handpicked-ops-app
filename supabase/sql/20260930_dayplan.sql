-- Daily schedule plan (user, 30 Sep 2026): 10:00 tentative team count to the "Schedule change"
-- WhatsApp group, 16:00 next-day schedule PDF to Drive HI/Schedule. The planner is
-- ingestion-agent/daily_schedule.py (Cloud Run job handpicked-dayplan); this file gives it
--   sched_settings       the Schedule skill's roster_seed.json + rules.json, so the cloud run and the
--                        skill share one roster. Update the 'roster' row when the skill's seed changes.
--   fn_sched_day_raw(d)  the skill's Step 1 query as one call: the day's schedule rows with resolved
--                        locations + every PO line of those orders.
create table if not exists public.sched_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.sched_settings enable row level security;
revoke all on public.sched_settings from anon;
drop policy if exists sched_settings_read on public.sched_settings;
create policy sched_settings_read on public.sched_settings for select to authenticated using (true);

insert into public.sched_settings (key, value, updated_by) values
  ('roster', $json${"_about": "Seed roster for the Schedule skill. Team names and pairs come from the WhatsApp 'Team N' groups (checked 28 Sep 2026). Person flags are the standing assignment rules the user gave on 28 Sep 2026. Edit this file (or export from the Team Board's 'Teams and people' panel) to change them.", "updated": "2026-09-28", "base": {"name": "International City, Dubai", "lat": 25.1673, "lng": 55.4103, "depart_earliest": "07:00"}, "people": [{"name": "Maruf", "emaar": false, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false}, {"name": "Sohail", "emaar": false, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": true, "note": "Give him the lowest total windows (orders may be many)"}, {"name": "Gourav", "emaar": false, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false}, {"name": "Shaju", "emaar": false, "no_motor": false, "no_scaffolding": true, "fewest_orders": false, "fewest_windows": false, "note": "Avoid scaffolding orders"}, {"name": "Ikbal", "emaar": true, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false}, {"name": "Kaleem", "emaar": false, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false}, {"name": "Ajish", "emaar": true, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false}, {"name": "Ranjit", "emaar": true, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false}, {"name": "Mizanur", "emaar": false, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false}, {"name": "Ejaz", "emaar": true, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false}, {"name": "Raqib", "emaar": false, "no_motor": true, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false, "note": "Avoid motor orders"}, {"name": "Hafis", "emaar": false, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false}, {"name": "Mohsin", "emaar": false, "no_motor": true, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false, "note": "Avoid motor orders"}, {"name": "Ibrahim", "emaar": false, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false}, {"name": "Mamun", "emaar": false, "no_motor": false, "no_scaffolding": false, "fewest_orders": true, "fewest_windows": false, "note": "Give him the lowest number of orders (windows may be many)"}, {"name": "Kawsar", "emaar": true, "no_motor": false, "no_scaffolding": false, "fewest_orders": false, "fewest_windows": false}], "teams": [{"team": 1, "name": "Team 1", "members": ["Maruf", "Sohail"]}, {"team": 2, "name": "Team 2", "members": ["Gourav", "Shaju"]}, {"team": 3, "name": "Team 3", "members": ["Ikbal", "Kaleem"]}, {"team": 4, "name": "Team 4", "members": ["Ajish", "Ranjit"]}, {"team": 5, "name": "Team 5", "members": ["Mizanur", "Ejaz"]}, {"team": 6, "name": "Team 6", "members": ["Raqib", "Hafis"]}, {"team": 7, "name": "Team 7", "members": ["Mohsin", "Ibrahim"]}, {"team": 8, "name": "Team 8", "members": ["Mamun", "Kawsar"]}]}$json$::jsonb, 'seed 30 Sep 2026 from ~/.claude/skills/Schedule/roster_seed.json'),
  ('rules',  $json${"_about": "Timing rules the user gave on 28 Sep 2026. build_facts.py and sched_eval.py read them; change a number here, not in code.", "blind_min": 20, "curtain_1layer_min": 30, "curtain_2layer_min": 45, "standard_width_cm": 350, "width_step_cm": 20, "width_step_min": 1, "pelmet_min": 30, "flex_track_min": 20, "scaffold_height_cm": 350, "scaffold_order_min": 60, "scaffold_extra_window_min": 45, "motor_per_window_min": 30, "removal_min": 15, "cassette_min": 0, "isr_flat_min": 60, "work_start": "09:00", "work_end": "18:00", "villa_work_end": "20:00", "odd_time_before": "08:00", "odd_time_after": "18:00", "tall_flag_cm": 320, "travel": {"buffer_min": 15, "same_place_km": 0.3, "same_place_min": 5, "bands": [{"max_km": 8, "road_factor": 1.45, "kmh": 32}, {"max_km": 25, "road_factor": 1.35, "kmh": 45}, {"max_km": 60, "road_factor": 1.25, "kmh": 65}, {"max_km": null, "road_factor": 1.15, "kmh": 90}]}, "notes": ["Style (eyelet / ring / American / wave / ripplefold) does not change the time.", "A window's separate '(sheer)' and '(blackout)' lines of the same width count as ONE 2-layer window.", "Scaffolding: first window over 350 cm (user, 30 Sep 2026; was 400) adds scaffold_order_min to the order; each further window over 350 cm adds scaffold_extra_window_min.", "Motor or remote: motor_per_window_min for each motorised window (the reading the user accepted on 28 Sep; the alternative is every window of a motor order).", "Accessories (tie backs, velcro, hand batons, pull-cord tracks, trunking, remotes, express lines) carry no time.", "Independent villas may run to villa_work_end; everything else must end by work_end."]}$json$::jsonb, 'seed 30 Sep 2026 from ~/.claude/skills/Schedule/rules.json')
on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;

create or replace function public.fn_sched_day_raw(p_date date)
returns jsonb
language sql
stable
set search_path = public
as $fn$
with s as (
  select s.order_id, s.city, s.customer_name, s.install_date, s.install_time, s.entry_type, s.status, s.address, s.notes,
         s.pin_lat, s.pin_lng, s.client_phone_e164 as phone, s.time_unscheduled, s.synced_at, s.sheet_duration_min,
         r.lat, r.lng, r.community, r.property_type, r.confidence, r.anomaly_reason,
         public.fn_sched_is_emaar(s.address) as emaar_db
  from public.v_installation_schedule_live s
  cross join lateral public.fn_sched_resolve_location(s.address, s.city, s.pin_lat, s.pin_lng) r
  where s.install_date = p_date
)
select jsonb_build_object(
  'date', p_date,
  'rows', coalesce((select jsonb_agg(to_jsonb(s) order by s.city, s.install_time) from s), '[]'::jsonb),
  'lines', coalesce((select jsonb_agg(jsonb_build_object(
      'order_id', l.order_id, 'version_no', l.version_no, 'line_no', l.line_no, 'window_name', l.window_name,
      'commercial_name', l.commercial_name, 'product_name', l.product_name, 'quantity', l.quantity,
      'w', l.adjusted_width_cm, 'h', greatest(l.adjusted_height_cm, l.height_left_cm, l.height_middle_cm, l.height_right_cm),
      'lay', l.number_of_layers, 'curtain_type', l.curtain_type,
      'pelmet', l.pelmet, 'bend', l.bend, 'motor', l.motor, 'scaffolding', l.scaffolding, 'rm', l.remove_flag,
      'oc', l.owl_curtains, 'ob', l.owl_blinds, 'wc', l.window_count,
      'cmt', left(coalesce(l.optional_comment, ''), 300)) order by l.order_id, l.line_no)
    from public.order_lines_final l where l.order_id in (select order_id from s)), '[]'::jsonb)
);
$fn$;
revoke all on function public.fn_sched_day_raw(date) from public, anon;
grant execute on function public.fn_sched_day_raw(date) to authenticated, service_role;
