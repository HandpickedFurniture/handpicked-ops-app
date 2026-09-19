-- RLS for the Trello / Finance-alerts bridge tables.  19 September 2026, evening.
--
-- APPLIED as migration finance_bridge_tables_rls (the statement text is in
-- supabase_migrations.schema_migrations).
--
-- trello_cards, finance_decisions and finance_cycles were created earlier the same day without
-- row level security, so every signed-in staff account could insert, update and delete them
-- through PostgREST (anon could not: no anon grants exist in public since the 18 Sep lock-down).
-- All three are written by finance_sync.py / trello_sync.py with the service-role key, which
-- bypasses RLS, and nothing in the app writes them - so they take the tailor_work shape: read for
-- signed-in users, writes only from the service role. If a Finance screen ever needs to write
-- (answer a decision, re-open a card), add p_write_ops / p_update_ops with (not fn_is_viewer())
-- the way accounting_alerts has them.
alter table public.trello_cards      enable row level security;
alter table public.finance_decisions enable row level security;
alter table public.finance_cycles    enable row level security;

create policy p_read_all on public.trello_cards      for select to authenticated using (true);
create policy p_read_all on public.finance_decisions for select to authenticated using (true);
create policy p_read_all on public.finance_cycles    for select to authenticated using (true);
