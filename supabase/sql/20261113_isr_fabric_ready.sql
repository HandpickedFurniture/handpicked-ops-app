-- 13 Nov 2026 (user): Production's simple ISR view - fabric received yes / no, which fabric, a photo,
-- and "report ready". The answer shows on every ISR card: Stage 2 and Stage 4 of the Step scheduler
-- and the ISR list, which now lives in the Installation module (#/status?view=isr).
--
-- fabric_received is three-valued on purpose: null = production has not answered yet, false = "No,
-- not here yet", true = "Yes, received". A plain boolean would make "not answered" read as "No".
-- Photos are ordinary order_photos rows with context 'isr' and context_id = the ISR id.

alter table public.isr_case
  add column if not exists fabric_received boolean,
  add column if not exists fabric_name text,
  add column if not exists fabric_at timestamptz,
  add column if not exists fabric_by text;

alter table public.order_photos drop constraint if exists order_photos_context_check;
alter table public.order_photos add constraint order_photos_context_check check (context = any (array[
  'receiving','prep','dispatch','order_status','visit','adjustment','transfer','inventory','other','isr']));

-- c.* grew, so the view is dropped and made again (nothing depends on it)
drop view if exists public.v_isr_cases;
create view public.v_isr_cases with (security_invoker = true) as
select c.*,
       case when c.ready then 'ready' when c.received then 'received' else 'waiting' end as readiness,
       r.installation_date, coalesce(c.city, r.city) as city_any, coalesce(c.customer, r.customer_name) as customer_any,
       coalesce(p.n, 0) as photo_count
  from public.isr_case c
  left join public.v_ops_order_roster r on r.order_id = c.order_id
  left join lateral (select count(*)::int as n from public.order_photos ph
                      where ph.context = 'isr' and ph.context_id = c.id and ph.deleted_at is null) p on true;
revoke all on public.v_isr_cases from public, anon;
grant select on public.v_isr_cases to authenticated;

-- p_received: true / false / null (clear the answer); p_fabric: which fabric (kept when blank)
create or replace function public.fn_isr_fabric(p_id bigint, p_received boolean, p_fabric text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare who text := public.fn_live_guard();
begin
  update public.isr_case
     set fabric_received = p_received,
         fabric_name = coalesce(nullif(btrim(coalesce(p_fabric, '')), ''), fabric_name),
         fabric_at = case when p_received is null then null else now() end,
         fabric_by = case when p_received is null then null else who end,
         updated_at = now(), updated_by = who
   where id = p_id;
  if not found then raise exception 'ISR % no longer exists', p_id using errcode = 'P0001'; end if;
  insert into public.isr_event(isr_id, who, kind, detail)
  values (p_id, who, 'fabric', jsonb_build_object('received', p_received, 'fabric', nullif(btrim(coalesce(p_fabric, '')), '')));
end $$;
revoke all on function public.fn_isr_fabric(bigint, boolean, text) from public, anon;
grant execute on function public.fn_isr_fabric(bigint, boolean, text) to authenticated;
