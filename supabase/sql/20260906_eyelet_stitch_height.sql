-- Eyelet stitch height on the ops app: window vs ceiling fixing.  6 September 2026.
-- APPLIED as migration `eyelet_stitch_height_window_vs_ceiling`. Parity with the PDF is checked
-- by tools/check_eyelet_parity.py, which reads these views live.
--
-- The rule (user, 6 Sep 2026):
--     eyelet curtain fixed at the WINDOW  -> stitch height = adjusted height, exactly
--     eyelet curtain fixed at the CEILING -> stitch height = adjusted height - 3 cm
--
-- SIBLING OF ingestion-agent/pdf_export.py -- is_eyelet() / is_ceiling_install() / eyelet_stitch_h()
-- / eyelet_side_h() are the same four rules in Python. THE TWO MUST MOVE TOGETHER: the PDF reads
-- order_lines_final directly and cannot see these functions. If you change the deduction, change
-- EYELET_CEILING_DEDUCTION_CM there in the same commit.
--
-- Applied at DISPLAY time in both places and deliberately NOT written to
-- order_lines_final.l1/l2_cut_height_cm, for three reasons:
--   * those columns are materialised, so writing the rule there would reach an order only when that
--     order is next rebuilt - every historical order would keep printing the old height;
--   * they also drive the cutters' fabric optimisation and the panel plans;
--   * the same choice was already made for the roman Stitch W deduction (pdf_export.roman_stitch_w).
-- A view, by contrast, is right for every order the moment it is replaced.
--
-- Both views are replaced in place (CREATE OR REPLACE, same columns and types) because
-- v_ops_order_roster depends on v_ops_prep_units and v_ops_report_stitching depends on v_stitching -
-- a DROP would cascade, and PostgREST refuses a whole select list if one column disappears.
-- security_invoker is restated explicitly: it is NOT inherited by a replacement.

-- ---------------------------------------------------------------- the rule, in one place

-- The deduction as a function rather than a literal, so the two callers below cannot disagree.
create or replace function public.fn_eyelet_ceiling_deduction_cm()
returns numeric
language sql immutable parallel safe
set search_path = public, pg_temp
as $$ select 3::numeric $$;

comment on function public.fn_eyelet_ceiling_deduction_cm() is
  'Centimetres taken off an eyelet curtain stitched for CEILING fixing (user, 6 Sep 2026). Mirrors '
  'EYELET_CEILING_DEDUCTION_CM in ingestion-agent/pdf_export.py - change both together.';

-- Keyed on the flag OR the name, matching pdf_export.is_eyelet(). The name test is not optional:
-- every eyelet line on order 70178 carries eyelet = 0 and no catalog_id at all, and would be missed
-- by the flag alone.
create or replace function public.fn_is_eyelet(p_eyelet integer, p_commercial_name text)
returns boolean
language sql immutable parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(p_eyelet, 0) = 1
      or coalesce(p_commercial_name, '') ilike '%eyelet%';
$$;

-- -> true (ceiling), false (window / wall), or NULL when the line does not say.
--
-- `brackets` is the structured field and states it outright ('Ceiling brackets' on 2,429 lines,
-- 'Wall brackets' on 376), but it is null on 3,004 more and carries free text on a handful, so the
-- fixing method is read as the fallback: installation_notes / drilling_type spell the height datum
-- as 'Ceiling_To_Floor' or 'Wall_To_Floor', and across every line on file those two agree with
-- `brackets` 100% of the time. The loose 'ceiling mount' / 'wall mount' wording is read last,
-- because a few POs type the fixing as a sentence instead of filling the columns.
--
-- strpos, not LIKE: '_' is a single-character wildcard in LIKE, so '%ceiling_to_floor%' would also
-- match 'ceilingXtoYfloor'.
create or replace function public.fn_is_ceiling_install(p_brackets text, p_drilling text, p_notes text)
returns boolean
language sql immutable parallel safe
set search_path = public, pg_temp
as $$
  select case
           when strpos(b, 'ceiling bracket') = 1 then true
           when strpos(b, 'wall bracket') = 1    then false
           when strpos(t, 'ceiling_to_floor') > 0
             or strpos(t, 'ceiling bracket') > 0
             or strpos(t, 'ceiling mount') > 0   then true
           when strpos(t, 'wall_to_floor') > 0
             or strpos(t, 'wall bracket') > 0
             or strpos(t, 'wall mount') > 0      then false
           else null
         end
  from (select lower(btrim(coalesce(p_brackets, ''))) as b,
               lower(concat_ws(' ', coalesce(p_drilling, ''), coalesce(p_notes, ''),
                                    coalesce(p_brackets, ''))) as t) x;
$$;

-- Stitch height for an eyelet curtain. An unreadable fixing method takes the WINDOW case: NULL is
-- not true, so it falls through to ELSE. That is deliberate - over-length is recoverable on a
-- curtain and short is not, so the 3 cm comes off only when something actually says ceiling.
create or replace function public.fn_eyelet_stitch_h(p_adjusted_height_cm numeric, p_brackets text,
                                                     p_drilling text, p_notes text)
returns numeric
language sql immutable parallel safe
set search_path = public, pg_temp
as $$
  select case
           when p_adjusted_height_cm is null then null
           when public.fn_is_ceiling_install(p_brackets, p_drilling, p_notes)
             then p_adjusted_height_cm - public.fn_eyelet_ceiling_deduction_cm()
           else p_adjusted_height_cm
         end;
$$;

-- The same deduction on one per-side cutting height, so an L / M / R triple cannot contradict the
-- stitch height printed beside it. Per-side variation is preserved - only the datum moves.
create or replace function public.fn_eyelet_side_h(p_h numeric, p_brackets text,
                                                   p_drilling text, p_notes text)
returns numeric
language sql immutable parallel safe
set search_path = public, pg_temp
as $$
  select case
           when p_h is null then null
           when public.fn_is_ceiling_install(p_brackets, p_drilling, p_notes)
             then p_h - public.fn_eyelet_ceiling_deduction_cm()
           else p_h
         end;
$$;

-- ---------------------------------------------------------------- Prep screen (mod-prep, drawer)

-- Unchanged from the previous definition except cut_height_cm. Note that most eyelet lines carry
-- their only fabric in the LAYER 2 slot (l1_fabric null), so they reach this view as layer_no = 2
-- and it is the l2 column - previously adjusted height - 4 cm - that the floor was reading.
create or replace view public.v_ops_prep_units
with (security_invoker = on) as
 SELECT f.order_id,
    btrim(f.window_name) AS window_name,
    l.n AS layer_no,
    max(f.window_ref) AS window_ref,
    max(f.window_no) AS window_no,
    max(l.fab) AS fabric_code,
    max(f.curtain_type) AS curtain_type,
    max(f.curtain_stitching_type) AS curtain_stitching_type,
    max(f.installation_date) AS installation_date,
    max(
        CASE
            WHEN l.n = 1 THEN f.l1_cut_width_cm
            ELSE f.l2_cut_width_cm
        END) AS cut_width_cm,
    max(
        CASE
            WHEN public.fn_is_eyelet(f.eyelet, f.commercial_name)
              THEN public.fn_eyelet_stitch_h(f.adjusted_height_cm, f.brackets, f.drilling_type,
                                             f.installation_notes)
            WHEN l.n = 1 THEN f.l1_cut_height_cm
            ELSE f.l2_cut_height_cm
        END) AS cut_height_cm,
    max(
        CASE
            WHEN l.n = 1 THEN f.l1_bottom_finish
            ELSE f.l2_bottom_finish
        END) AS bottom_finish,
    max(f.pieces) AS pieces,
    max(f.pieces_label) AS pieces_label
   FROM order_lines_final f
     JOIN product_catalog c ON c.id = f.catalog_id AND c.receiving_mode = 'order_fabric'::receiving_mode
     CROSS JOIN LATERAL ( VALUES (1,f.l1_fabric), (2,f.l2_fabric)) l(n, fab)
  WHERE l.fab IS NOT NULL AND btrim(COALESCE(f.window_name, ''::text)) <> ''::text
  GROUP BY f.order_id, (btrim(f.window_name)), l.n;

-- ---------------------------------------------------------------- Stitching report (mod-reports)

-- Unchanged except l1_height, l2_height and the three per-side heights. The 'Roman H:' prefix and
-- the l2_fabric guard are kept exactly as they were.
create or replace view public.v_stitching
with (security_invoker = on) as
 SELECT order_id,
    window_ref,
    window_name,
    window_no,
    city,
    customer_name,
    installation_date,
    fabric_cutoff_date,
    curtain_type,
    curtain_stitching_type,
    pieces_label,
    l1_fabric,
    l1_meters_sent,
        CASE
            WHEN curtain_type = 'Roman'::text THEN 'Roman W:'::text || l1_cut_width_cm
            ELSE 'W:'::text || l1_cut_width_cm
        END AS l1_width,
        CASE
            WHEN curtain_type = 'Roman'::text THEN 'Roman H:'::text || l1_cut_height_cm
            WHEN public.fn_is_eyelet(eyelet, commercial_name)
              THEN 'H:'::text || public.fn_eyelet_stitch_h(adjusted_height_cm, brackets,
                                                           drilling_type, installation_notes)
            ELSE 'H:'::text || l1_cut_height_cm
        END AS l1_height,
    l1_pp_comment,
    l1_bottom_finish,
    l1_roll_width_cm,
    l1_roll_width_missing,
    l2_fabric,
    l2_meters_sent,
        CASE
            WHEN l2_fabric IS NOT NULL THEN 'W:'::text || l2_cut_width_cm
            ELSE NULL::text
        END AS l2_width,
        CASE
            WHEN l2_fabric IS NULL THEN NULL::text
            WHEN public.fn_is_eyelet(eyelet, commercial_name)
              THEN 'H:'::text || public.fn_eyelet_stitch_h(adjusted_height_cm, brackets,
                                                           drilling_type, installation_notes)
            ELSE 'H:'::text || l2_cut_height_cm
        END AS l2_height,
    l2_pp_comment,
    l2_bottom_finish,
    l2_roll_width_cm,
    l2_roll_width_missing,
        CASE
            WHEN public.fn_is_eyelet(eyelet, commercial_name)
              THEN public.fn_eyelet_side_h(cut_height_left_cm, brackets, drilling_type, installation_notes)
            ELSE cut_height_left_cm
        END AS cut_height_left_cm,
        CASE
            WHEN public.fn_is_eyelet(eyelet, commercial_name)
              THEN public.fn_eyelet_side_h(cut_height_middle_cm, brackets, drilling_type, installation_notes)
            ELSE cut_height_middle_cm
        END AS cut_height_middle_cm,
        CASE
            WHEN public.fn_is_eyelet(eyelet, commercial_name)
              THEN public.fn_eyelet_side_h(cut_height_right_cm, brackets, drilling_type, installation_notes)
            ELSE cut_height_right_cm
        END AS cut_height_right_cm,
    needs_height_review,
    optional_comment,
    installation_notes,
    production_comment,
    revised_recheck
   FROM order_lines_final f
  WHERE l1_fabric IS NOT NULL OR l2_fabric IS NOT NULL;
