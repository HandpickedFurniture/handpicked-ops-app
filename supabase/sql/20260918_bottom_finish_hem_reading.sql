-- Bottom finish: how the comment is read for hemming.  18 September 2026.
-- APPLIED as migration `bottom_finish_hem_variants_and_negation`.
--
-- fn_bottom_finish() decides what the production sheet prints for a fabric whose PO bottom column
-- says 'Lead Band': 'Keep Lead Band', or 'Cut Lead Band and Make Stitch Hem' (which
-- ingestion-agent/pdf_export.bottom_label prints as *Hemming*). Until today it keyed on a short
-- list of spellings - hemming / hemstitch / hem-stitch / stitch-hem - and nothing else, and it
-- could not tell an instruction from a refusal. Two things it got wrong (user, 18 Sep 2026):
--
--   * order 73558 "Light leakage and joining stitching panel explained. Hem style" stayed
--     Keep Lead Band. 'Hem style' is one sales rep's standard phrase - 12 orders on file - and
--     'hooksHemming stitch' (72992, two fields glued together) and 'heming' (63540) were missed
--     the same way. Going forward ANY hem word counts: hem, hems, hemmed, hemming, heming,
--     hemstitch, hemstich, stitch hem, hem-stitch, and a 'hemming' glued to the word before it.
--   * order 72218 "client doesn't want hemming in her kurtains" read as a hem instruction (its PO
--     happened to say Hemming rather than Lead Band, so that sheet was right by luck). A hem word
--     that is REFUSED now keeps the lead band.
--
-- What counts as a refusal, and what deliberately does not:
--   * a negation word (no / not / never / without / cannot / don't / doesn't / didn't / won't /
--     can't / refused / declined / rejected / avoid / skip) at most 25 characters BEFORE the hem
--     word, in the same clause - a full stop, comma, semicolon or colon ends the search. The
--     25-character cap and the clause boundary are what keep three real comments positive:
--       "will not be joining, hemming inside frame"                     (70999 - comma)
--       "we can not adjust it 100%, hemming, Stitching"                 (64423 - comma)
--       "not on the outer wall from left bottom hemming"                (67148 - 36 chars away)
--     'lead' inside that window also cancels the negation: "no lead band hemming" is an
--     instruction to hem, not to skip hemming.
--   * or 'not required / not needed / not wanted / cancelled / removed / n/a' straight AFTER the
--     hem word. Only those words: "Bottom with hemming no panel stitching" is the most common
--     comment on file, and its 'no' belongs to the panel stitching, not the hem.
--   * the apostrophe in doesn't arrives as ' or ’ or as \' with one to seven backslashes in
--     front of it - escaped somewhere upstream, and differently on different windows of the same
--     PO (72218 has 1, 3 and 7) - so the contraction is matched with the apostrophe optional and
--     any run of those characters allowed.
--
-- Checked against every distinct comment on file (2,539, all PO versions): 24 comments gained a
-- hem (the 22 'Hem style', the glued 'hooksHemming', the 'heming'), 10 lost one (all 72218), and
-- nothing else moved. The DO block at the end re-runs the hand-written cases on every apply.
--
-- SIBLING IN PYTHON: tools/validate.py recomputes this rule from the source CSV to check the
-- database against it (HEM_WORD / HEM_REFUSED_BEFORE / HEM_REFUSED_AFTER). CHANGE BOTH TOGETHER.
-- The Gemini reading in ingestion-agent/ai_steps.py (comment_interpretations.keep_lead_band) is
-- a third, independent opinion that feeds only the 'inferred comment' column; it already read
-- both cases correctly and is deliberately not used here - the production sheet stays
-- deterministic and auditable.
--
-- Not rebuilt: the 12 lead-band orders the old rule got wrong were all installed before 18 Sep,
-- and order_lines_final should keep saying what the sheet said when the curtain was made.
-- Every order imported, endorsed or revised from now on passes through fn_process_order ->
-- fn_rebuild_order -> fn_bottom_finish and gets the new reading.

-- ---------------------------------------------------------------- the reading, in one place

create or replace function public.fn_comment_asks_hem(comment_txt text, notes_txt text)
returns boolean
language sql immutable parallel safe
set search_path = public, pg_temp
as $$
  with t as (select coalesce(comment_txt, '') || ' ' || coalesce(notes_txt, '') as txt)
  select
        -- a hem word: hem / hems / hemmed / hemstitch / hemstich as whole words, or hemming /
        -- heming even when glued to the word before it ('hooksHemming')
        txt ~* '(\mhem(s|med|stit?ch)?\M|hemm?ing\M)'
    -- ... not refused just before it, within the clause
    and not txt ~* ('\m(no|not|never|without|cannot|nor|avoid\w*|skip\w*|refus\w*|declin\w*|reject\w*'
                    || '|(don|doesn|didn|won|can|isn|aren|wasn|shouldn|wouldn|couldn|mustn)[\\''’`´]*t)\M'
                    || '((?!lead)[^.,;:\n]){0,25}'
                    || '(\mhem(s|med|stit?ch)?\M|hemm?ing\M)')
    -- ... and not refused straight after it
    and not txt ~* ('(\mhem(s|med|stit?ch)?\M|hemm?ing\M)\s*[-:,]?\s*((is|are|was|were)\s+)?'
                    || '((not|no|never)\s+(required|needed|necessary|wanted|want|need|to be done|to do|at all|applicable)'
                    || '|cancel\w*|removed|skip\w*|avoid\w*|n/a\M)')
  from t
$$;

comment on function public.fn_comment_asks_hem(text, text) is
  'True when the Optional Comment / Installation Notes ask for the bottom to be hemmed: any hem '
  'word (hem, hemming, heming, hemstitch, stitch hem ...) that is not refused in the same clause '
  '(no / not / doesn''t want / without / not required ...). Mirrors HEM_* in tools/validate.py - '
  'change both together. 18 Sep 2026.';

-- ---------------------------------------------------------------- the column rule, unchanged shape

create or replace function public.fn_bottom_finish(bottom text, comment_txt text, notes_txt text)
returns text
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when bottom is null or btrim(bottom) = '' then null
    when lower(btrim(bottom)) in ('lead band', 'use lead band') then
      case when public.fn_comment_asks_hem(comment_txt, notes_txt)
        then 'Cut Lead Band and Make Stitch Hem'
        else 'Keep Lead Band'
      end
    else btrim(bottom)
  end
$$;

comment on function public.fn_bottom_finish(text, text, text) is
  'Bottom finish for one fabric layer as the production sheet prints it. A PO ''Lead Band'' '
  'becomes ''Cut Lead Band and Make Stitch Hem'' (the sheet prints *Hemming*) when '
  'fn_comment_asks_hem() is true, else ''Keep Lead Band''. Any other PO value passes through. '
  'Called only from fn_rebuild_order. 18 Sep 2026.';

-- ---------------------------------------------------------------- self-test: fail the apply if the reading drifts

do $$
declare
  bad text;
begin
  select string_agg(format('%s -> %s', c.txt, r.got), E'\n')
    into bad
  from (values
    -- refusals: keep the lead band
    ('Client does not want hemming',                              false),
    ('client doesn''t want hemming in her curtains',              false),
    ('client doesn\''t want hemming in her kurtains',             false),
    ('client doesn\\\''t want hemming in her kurtains',           false),
    ('client doesnt want any hemming',                            false),
    ('No hemming',                                                false),
    ('no hem',                                                    false),
    ('without hemming please',                                    false),
    ('No need for hemming',                                       false),
    ('client refused hemming',                                    false),
    ('not interested in hemming, keep lead band',                 false),
    ('keep lead band, no hemming',                                false),
    ('Hemming not required',                                      false),
    ('hemming is not needed for sheer',                           false),
    ('hemming - cancelled',                                       false),
    -- instructions: cut the band and hem
    ('Hem style',                                                 true),
    ('Light leakage and joining stitching panel explained. Hem style', true),
    ('hem',                                                       true),
    ('STITCH HEM IN ALL WINDOWS',                                 true),
    ('Stitch-hem',                                                true),
    ('hemstitch',                                                 true),
    ('hemstich',                                                  true),
    ('10cm extra heming',                                         true),
    ('adjust in the hooksHemming stitch',                         true),
    ('bottom hemmed',                                             true),
    ('Bottom with hemming no panel stitching',                    true),
    ('Invert the fabric 10 cm overlapping, will not be joining, hemming inside frame', true),
    ('Track should be install in inner pocket not on the outer wall from left bottom hemming', true),
    ('we can not adjust it 100%, hemming, Stitching',             true),
    ('no lead band hemming',                                      true),
    ('no lead band, hemming required',                            true),
    ('do not keep lead band, hemming',                            true),
    ('Hemming stitch, need bottom staple.',                       true),
    ('he doesn''t want blackout. Hemming the sheer please',       true),
    ('no need for the door. The bottom should be hemming please', true),
    -- no hem word at all
    ('adjust them with hooks',                                    false),
    ('chemical wash',                                             false),
    ('hemp fabric',                                               false),
    ('light leakage explained',                                   false),
    ('curtains will not move with gathering client agreed',       false)
  ) as c(txt, expect)
  cross join lateral (select public.fn_comment_asks_hem(c.txt, null) as got) r
  where r.got is distinct from c.expect;

  if bad is not null then
    raise exception 'fn_comment_asks_hem self-test failed: %', E'\n' || bad;
  end if;

  -- and the column rule on top of it
  if public.fn_bottom_finish('Lead Band', 'Hem style', null) <> 'Cut Lead Band and Make Stitch Hem'
     or public.fn_bottom_finish('Lead Band', 'Client does not want hemming', null) <> 'Keep Lead Band'
     or public.fn_bottom_finish('Lead Band', 'Light leakage explained', 'Wall_To_Wall & Ceiling_To_Floor fixing') <> 'Keep Lead Band'
     or public.fn_bottom_finish('Stitch Hem', 'Client does not want hemming', null) <> 'Stitch Hem'
     or public.fn_bottom_finish('Hemming', null, null) <> 'Hemming'
     or public.fn_bottom_finish('  ', 'hemming', null) is not null
  then
    raise exception 'fn_bottom_finish self-test failed';
  end if;
end $$;
