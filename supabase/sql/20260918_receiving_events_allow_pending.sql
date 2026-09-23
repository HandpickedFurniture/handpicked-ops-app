-- Reverting a fabric to Pending.  18 September 2026.
-- APPLIED as migration `receiving_events_allow_pending`.
--
-- fn_ops_set_receiving updates receiving_expectations.status AND logs the change to
-- receiving_events with event_type = the new status. receiving_expectations_status_check accepts
-- 'pending' (it is the first value in RECV_STATUSES, and the dropdown offers it), but
-- receiving_events_event_type_check did not - so every received -> pending revert failed on the
-- audit insert, the whole call rolled back, and the app showed "A change could not be saved".
-- Order 74606 / mf806-35: six attempts 19:20-19:22 Dubai, all
--     new row for relation "receiving_events" violates check constraint "receiving_events_event_type_check"
-- 'pending' was the only RECV_STATUSES value the event log refused. check_values.py mirrors the
-- expectations CHECK only; this second CHECK must stay a superset of RECV_STATUSES by hand.
--
-- Nothing reads event_type by value: v_ops_receiving / v_ops_receivables / v_ops_status_board /
-- v_ops_report_orders use qty_received and received_at, so a 'pending' event is inert there
-- (qty_received is NULL for anything but received/partial).

alter table public.receiving_events
  drop constraint receiving_events_event_type_check;

alter table public.receiving_events
  add constraint receiving_events_event_type_check
  check (event_type = any (array['pending'::text, 'ordered'::text, 'received'::text, 'partial'::text,
                                 'out_of_stock'::text, 'quality_check'::text, 'cancelled'::text,
                                 'note'::text]));
