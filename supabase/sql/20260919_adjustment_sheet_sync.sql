-- Adjustments -> the partner-facing 'Adjustments' tabs.  19 September 2026 (user).
--
-- APPLIED as two migrations (see supabase_migrations.schema_migrations):
--   adjustment_sheet_sync          the columns, the three views, the finance city fix
--   adjustment_sheet_manual_hold   sheet_hold_reason + the queue view re-created with 'manual_hold'
--                                  first - so a person can keep one row off the sheet (used on the
--                                  first day for the nine rows that looked like restatements)
-- This file is the end state. The writer is ingestion-agent/sheet_sync.py, run at the end of every
-- 5-minute agent pass.
--
-- What this is for. Every adjustment - WhatsApp Chotu, the app's Chotu, the Installations module -
-- already lands as one accounting_alerts row through fn_ops_add_adjustment. Until now somebody
-- copied those rows by hand into the two partner workbooks (Finance: "Copy for sheet" + "Mark sheet
-- updated"), and the tick box recording the copy had never once been ticked: 0 of 91 rows on
-- 19 Sep 2026. The agent now does the copy itself and ticks the same box (sheet_updated_by =
-- 'sheet-sync'), so Finance shows exactly what reached which sheet.
--
-- 1. v_adjustment_sheet_queue - what is owed to a sheet, and why a row is being HELD. The rule lives
--    here, not in Python, so it can be read and argued with in SQL:
--      chargeable, not dropped, not yet on a sheet
--      manual_hold: sheet_hold_reason set by a person - stays off the sheet until cleared (null)
--      city from v_ops_order_roster (PO city, else the schedule sheet's) - NOT order_lines_final.city,
--        which is 'Unknown' for every order that has an adjustment (0 of 62 resolve that way; 59 of
--        62 resolve through the roster). No city anywhere -> hold_reason 'no_city': reported, never
--        guessed - a row on the wrong partner's sheet is a bill to the wrong company.
--      auto_unreviewed: the Installations module auto-proposes an additional_visit charge whenever
--        visit 2+ is recorded, and the Chotu capture for the same day usually already bills that
--        visit ("Extra visits: 1 × AED 150"). 14 of the 25 auto-proposed rows on 19 Sep sat beside
--        such a row. So an auto-proposed row reaches the sheet only once somebody marks it reviewed
--        (user, 19 Sep 2026); everything a person captured goes at once.
--      zero_amount: nothing to add - the column on the sheet is "amount to be added".
--
-- 2. accounting_alerts.sheet_row_ref / sheet_amount_aed - where the row went ('Abu Dhabi!A57') and
--    the amount as it was written. The amount is a snapshot on purpose: the partner may already have
--    invoiced against it, so a later change in the app must not silently edit their sheet.
--    v_adjustment_sheet_drift lists synced rows whose money has since changed (or that were dropped,
--    which counts as 0); the agent tells the Admin Alerts group and a person corrects the sheet.
--
-- 3. v_ops_finance_adjustments.city was NULL on every row for the same order_lines_final reason; the
--    Finance grid and its sheet export now fall back to the roster city. Definer view as before
--    (it had no security_invoker option); column list unchanged, so tools/check_columns.py is unmoved.
--
-- Nothing here is granted to anon (the 18 Sep revoke + default privileges stand).

alter table public.accounting_alerts
  add column if not exists sheet_row_ref     text,
  add column if not exists sheet_amount_aed  numeric,
  add column if not exists sheet_hold_reason text;

comment on column public.accounting_alerts.sheet_hold_reason is
  'Set by a person: keep this adjustment OFF the partner Adjustments tab until cleared (v_adjustment_sheet_queue shows it as hold_reason manual_hold). Null = flows normally.';

comment on column public.accounting_alerts.sheet_row_ref is
  'Where sheet_sync.py appended this adjustment: <city>!A<row> of the partner Adjustments tab. Null for rows a person copied.';
comment on column public.accounting_alerts.sheet_amount_aed is
  'The amount as written to the sheet by sheet_sync.py. A later change in the app shows up in v_adjustment_sheet_drift instead of editing the partner''s sheet.';

create or replace view public.v_adjustment_sheet_queue
with (security_invoker = true) as
select a.id,
       a.order_id,
       r.customer_name,
       r.city,
       r.city_source,
       round(coalesce(a.agreed_amount_aed, a.suggested_amount_aed, 0), 2) as amount_aed,
       a.reason,
       a.notes,
       a.charge_type,
       a.quantity,
       a.status,
       a.source,
       a.captured_by,
       a.created_at,
       case
         when a.sheet_hold_reason is not null                                 then 'manual_hold'
         when r.city is null or r.city not in ('Dubai', 'Abu Dhabi')          then 'no_city'
         when coalesce(a.notes, '') like 'Auto-proposed%'
              and a.status <> 'reviewed'                                     then 'auto_unreviewed'
         when coalesce(a.agreed_amount_aed, a.suggested_amount_aed, 0) <= 0  then 'zero_amount'
       end as hold_reason,
       a.sheet_hold_reason
from public.accounting_alerts a
left join public.v_ops_order_roster r on r.order_id = a.order_id
where a.chargeable
  and a.status <> 'dropped'
  and not a.sheet_updated;

comment on view public.v_adjustment_sheet_queue is
  'Adjustments not yet on a partner Adjustments tab. hold_reason null = sheet_sync.py appends it on its next pass; manual_hold / no_city / auto_unreviewed / zero_amount = held, see the migration header.';

create or replace view public.v_adjustment_sheet_drift
with (security_invoker = true) as
select a.id,
       a.order_id,
       a.sheet_row_ref,
       a.sheet_amount_aed,
       case when a.chargeable and a.status <> 'dropped'
            then round(coalesce(a.agreed_amount_aed, a.suggested_amount_aed, 0), 2)
            else 0 end as amount_now,
       a.status,
       a.chargeable,
       a.updated_at,
       a.sheet_updated_at
from public.accounting_alerts a
where a.sheet_updated
  and a.sheet_updated_by = 'sheet-sync'
  and a.sheet_amount_aed is not null
  and round(a.sheet_amount_aed, 2) <> case when a.chargeable and a.status <> 'dropped'
                                            then round(coalesce(a.agreed_amount_aed, a.suggested_amount_aed, 0), 2)
                                            else 0 end;

comment on view public.v_adjustment_sheet_drift is
  'Synced adjustments whose money changed after they reached the partner sheet (dropped counts as 0). sheet_sync.py alerts once per change and then re-snapshots sheet_amount_aed.';

-- 3. Finance grid city: roster fallback. Same columns, same order, definer view as before.
create or replace view public.v_ops_finance_adjustments as
with last_comment as (
  select distinct on (order_comments.order_id)
         order_comments.order_id, order_comments.body, order_comments.author, order_comments.created_at
  from public.order_comments
  where nullif(btrim(coalesce(order_comments.body, '')), '') is not null
  order by order_comments.order_id, order_comments.created_at desc
)
select a.id,
       a.order_id,
       coalesce(a.city, r.city)                        as city,
       coalesce(lc.body, a.notes)                      as installation_comment,
       a.order_id                                      as order_name,
       a.customer_name,
       a.effective_amount_aed                          as amount_aed,
       a.reason,
       a.charge_type,
       a.quantity,
       a.status                                        as adj_status,
       a.chargeable,
       a.visit_no,
       a.card_rate_aed,
       a.rate_drift,
       a.installation_date,
       r.order_received_date,
       r.order_status,
       r.date_bucket,
       coalesce(s.invoice_status, 'Pending')           as invoice_status,
       coalesce(s.adjustment_status, 'NA')             as adjustment_status,
       s.review_override,
       nullif(btrim(coalesce(a.reason, '')), '') is null or a.effective_amount_aed is null as rv_incomplete,
       a.rate_drift                                    as rv_rate_drift,
       a.amount_source,
       a.amount_source = 'system'                      as amount_is_system,
       rc.amount_aed                                   as card_amount_aed,
       a.sheet_updated,
       a.sheet_updated_at,
       a.sheet_updated_by,
       a.invoice_created,
       a.invoice_created_at,
       a.invoice_created_by,
       a.paid,
       a.paid_at,
       a.paid_by,
       a.reason_codes
from public.v_ops_adjustments a
left join last_comment lc on lc.order_id = a.order_id
left join public.v_ops_order_roster r on r.order_id = a.order_id
left join public.finance_order_state s on s.order_id = a.order_id
left join lateral public.fn_ops_rate_for(a.charge_type, coalesce(a.quantity, 1::numeric))
       rc(rate_card_id, rate_aed, amount_aed, unit, label) on true;

revoke all on public.v_adjustment_sheet_queue from anon;
revoke all on public.v_adjustment_sheet_drift from anon;
