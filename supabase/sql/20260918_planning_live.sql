-- Planning goes live: order-level stage ticks, a comment, ad hoc orders.  18 September 2026.
-- APPLIED as migrations `planning_live_ticks` and `planning_status_id_for_audit`.
--
-- The Planning page (Reports > Planning, on the ribbon) is the workshop's sheet, and from today the
-- production team ticks it in the app: Receive / Cut / Hemming / Iron / Marking / Taping / Fold per
-- ORDER, plus a comment, plus orders added to a day by hand. Every tick asks first and ticks again
-- to undo (user).
--
-- GRAIN, deliberately: one row per order. The Preparation screen keeps recording per window x
-- layer in preparation_events; this is the coarse sheet the workshop actually ticks. The two meet
-- in v_ops_order_roster.production_state, which now reads BOTH: a tick moves an order forward when
-- the unit-level data has not caught up, and never moves it back. That column is what the
-- Dashboard's "by production status" chart and the Production tab's filter read, so the Dashboard
-- follows the sheet. In the app, a box the unit-level data already sets (Receive = every fabric
-- received, Cut = preparation started, Fold = packed) is shown ticked and LOCKED.

create table if not exists public.planning_status (
  order_id    text primary key,
  receive     boolean not null default false,
  cut         boolean not null default false,
  hemming     boolean not null default false,
  iron        boolean not null default false,
  marking     boolean not null default false,
  taping      boolean not null default false,
  fold        boolean not null default false,
  comment     text,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  id          bigserial unique          -- fn_audit() records new.id, so every audited table carries one
);
-- RLS: p_read_all (authenticated), p_write_ops / p_update_ops / p_delete_ops (not fn_is_viewer()).
-- Triggers: trg_audit_planning_status (fn_audit), trg_planning_status_updated (set_updated_at).

create table if not exists public.planning_extra (
  id          bigserial primary key,
  order_id    text not null,
  plan_date   date not null,
  added_by    text,
  added_at    timestamptz not null default now(),
  unique (order_id, plan_date)
);
-- RLS: p_read_all, p_write_ops (insert), p_delete_ops. Trigger: trg_audit_planning_extra.

-- RPCs (set-state, replay-safe through the app's offline queue; every one refuses an order id
-- that is not in order_lines_final):
--   fn_ops_planning_set(p_order_id text, p_stage text, p_on boolean, p_actor text) -> jsonb (the row)
--   fn_ops_planning_comment(p_order_id text, p_comment text, p_actor text)         -> jsonb (the row)
--   fn_ops_planning_add(p_order_id text, p_date date, p_actor text)                -> bigint (planning_extra.id)
--   fn_ops_planning_remove(p_order_id text, p_date date)                           -> integer (rows removed)
-- EXECUTE granted to authenticated only.

-- v_ops_order_roster.production_state gained three arms, in rank order among the existing ones:
--   WHEN pl.fold                                        THEN 'packed'
--   WHEN pl.cut OR pl.hemming OR pl.iron OR pl.marking OR pl.taping THEN 'in_production'
--   WHEN pl.receive                                     THEN 'fabric_in'
-- with LEFT JOIN planning_status pl ON pl.order_id = o.order_id.
--
-- v_ops_report_orders appended: prep_started (the Planning "Cut" pre-tick), plan_receive, plan_cut,
-- plan_hemming, plan_iron, plan_marking, plan_taping, plan_fold, plan_comment, plan_updated_by,
-- plan_updated_at.
