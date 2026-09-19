-- Trello cards, Finance alerts decisions, city override.  19 September 2026 (user).
--
-- APPLIED as two migrations (see supabase_migrations.schema_migrations):
--   trello_adjustment_cards               trello_cards
--   finance_decisions_and_city_override   accounting_alerts.city_override, the queue view re-created
--                                         to take it first, finance_decisions, finance_cycles
-- This file is the end state. Builds on 20260919_adjustment_sheet_sync.sql. The writers are
-- ingestion-agent/trello_sync.py and finance_sync.py (the 2-hourly `handpicked-finance` job).
--
-- 1. trello_cards - one row per card of the Accounting board's "Ajustments" list the bridge has
--    seen: the card text (so a --dry-run can price without a Trello token, and the file shows what a
--    booking was based on), Chotu's reply verbatim, and what became of it:
--      new / asked / booked / merged / duplicate / not_charge / error / cancelled
--
-- 2. accounting_alerts.city_override - a person can route an adjustment whose order has no city
--    anywhere (PO 'Unknown', not on a schedule sheet): 'Dubai' or 'Abu Dhabi', set from a Finance
--    alerts reply ("DUBAI") or by hand. The queue view takes it before the roster.
--
-- 3. finance_decisions - every question the finance job put to the 'Finance alerts' WhatsApp group
--    (kind trello_card / no_city / sheet_drift), the Whapi message id an answer must QUOTE, and what
--    came back. finance_cycles - one row per 2-hourly pass; where the reply reader starts from.

create table if not exists public.trello_cards (
  card_id          text primary key,
  short_link       text,
  url              text,
  board_name       text,
  list_name        text,
  name             text not null,
  description      text,
  comments         jsonb not null default '[]'::jsonb,   -- [{who, text, at}] newest last
  created_by       text,
  card_created_at  timestamptz,
  last_activity_at timestamptz,
  first_seen_at    timestamptz not null default now(),
  processed_at     timestamptz,                          -- last time Chotu read it (null = never)
  order_id         text,                                 -- as parsed / as Chotu resolved it
  status           text not null default 'new'
                   check (status in ('new','asked','booked','merged','duplicate','not_charge','error','cancelled')),
  proposal         jsonb,                                -- Chotu's last reply, verbatim
  amount_aed       numeric,
  adjustment_id    bigint references public.accounting_alerts(id),
  booked_at        timestamptz,
  asked_text       text,                                 -- the question posted on the card
  asked_at         timestamptz,
  error            text,
  updated_at       timestamptz not null default now()
);
comment on table public.trello_cards is
  'Trello Accounting board, list "Ajustments": every card the bridge has seen, Chotu''s reading of it and the adjustment it became. Written by trello_sync.py only.';
create index if not exists trello_cards_status_idx on public.trello_cards (status, last_activity_at);
create index if not exists trello_cards_order_idx  on public.trello_cards (order_id);
drop trigger if exists trg_trello_cards_updated on public.trello_cards;
create trigger trg_trello_cards_updated before update on public.trello_cards
  for each row execute function public.set_updated_at();
revoke all on public.trello_cards from anon;
grant select on public.trello_cards to authenticated;

alter table public.accounting_alerts
  add column if not exists city_override text
  check (city_override is null or city_override in ('Dubai', 'Abu Dhabi'));
comment on column public.accounting_alerts.city_override is
  'Routes this adjustment to that city''s partner Adjustments tab when the order has no city on the PO or a schedule sheet. Set by a person (Finance alerts reply or SQL).';

create or replace view public.v_adjustment_sheet_queue
with (security_invoker = true) as
select a.id,
       a.order_id,
       r.customer_name,
       coalesce(a.city_override, r.city) as city,
       case when a.city_override is not null then 'override' else r.city_source end as city_source,
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
         when coalesce(a.city_override, r.city) is null
              or coalesce(a.city_override, r.city) not in ('Dubai', 'Abu Dhabi') then 'no_city'
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
revoke all on public.v_adjustment_sheet_queue from anon;

create table if not exists public.finance_decisions (
  id                 bigserial primary key,
  kind               text not null check (kind in ('trello_card', 'no_city', 'sheet_drift')),
  ref                text not null,                 -- trello card_id, or accounting_alerts.id as text
  order_id           text,
  question           text not null,
  proposal           jsonb,                         -- what YES would book (trello_card)
  wa_message_id      text,
  asked_at           timestamptz not null default now(),
  status             text not null default 'open' check (status in ('open', 'answered', 'expired', 'superseded')),
  answer             text,
  answered_by        text,
  answer_message_id  text,
  answered_at        timestamptz,
  outcome            text,                          -- what was done with the answer
  updated_at         timestamptz not null default now()
);
create index if not exists finance_decisions_open_idx on public.finance_decisions (status, kind, ref);
create unique index if not exists finance_decisions_wa_msg_idx on public.finance_decisions (wa_message_id) where wa_message_id is not null;
drop trigger if exists trg_finance_decisions_updated on public.finance_decisions;
create trigger trg_finance_decisions_updated before update on public.finance_decisions
  for each row execute function public.set_updated_at();
comment on table public.finance_decisions is
  'Questions finance_sync.py asked in the Finance alerts group and what came back. An answer counts only when it quotes wa_message_id and comes from a FINANCE_APPROVERS number.';

create table if not exists public.finance_cycles (
  id           bigserial primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running',
  stats        jsonb
);

revoke all on public.finance_decisions from anon;
revoke all on public.finance_cycles from anon;
grant select on public.finance_decisions, public.finance_cycles to authenticated;
