-- 24 Oct 2026: Reports > Materials. One row per order with the COUNTS of what has to be on the van:
-- blinds (roller / cassette / roman, plus zebra / wooden / venetian in the total), motors, remotes,
-- hand baton sticks, bending track, motor-cable trunking, scaffolding, and curtain windows by layer.
-- Everything else comes straight from v_ops_report_orders, so the shared filter bar (city, Order vs
-- ISR via issue_flag, fabric received, production state, customer ...) drives it unchanged.
-- Lines flagged remove_flag (a removal, not a supply) are not counted. A motor is any line naming a
-- motor / Glydea / Movelite / Metro / tubular that is not a remote, USB cable or trunking.
create or replace view public.v_ops_report_materials as
with l as (
  select order_id, lower(commercial_name) n, coalesce(quantity, 1) q
  from order_lines_final
  where commercial_name is not null and not coalesce(remove_flag, false)
), k as (
  select order_id, q, n,
    case
      when n like '%roller%' then 'roller'
      when n like '%cassette%' then 'cassette'
      when n like '%roman%' then 'roman'
      when n ~ 'zebra|wooden|venetian' then 'oblind'
      when n like '%baton%' then 'baton'
      when n like '%bending track%' then 'bend'
      when n like '%trunking%' then 'trunk'
      when n like '%scaffold%' then 'scaf'
      when n like '%remote%' then 'remote'
      when n like '%usb%' then 'usb'
      when n ~ 'motor|glydea|movelite|metro|tubular' then 'motor'
      when n like '%curtain%' and n !~ 'tie back|velcro with|lining|side returns|manual ad on'
        then case when n like '2 layer%' then 'cur2' else 'cur1' end
    end kind
  from l
), a as (
  select order_id,
    sum(q) filter (where kind = 'roller')   m_roller,
    sum(q) filter (where kind = 'cassette') m_cassette,
    sum(q) filter (where kind = 'roman')    m_roman,
    sum(q) filter (where kind in ('roller','cassette','roman','oblind')) m_blinds,
    sum(q) filter (where kind = 'motor')    m_motors,
    sum(q) filter (where kind = 'remote')   m_remotes,
    sum(q) filter (where kind = 'baton')    m_baton,
    sum(q) filter (where kind = 'bend')     m_bend,
    sum(q) filter (where kind = 'trunk')    m_trunk,
    sum(q) filter (where kind = 'scaf')     m_scaf,
    sum(q) filter (where kind in ('cur1','cur2')) m_curtains,
    sum(q) filter (where kind = 'cur1')     m_cur1,
    sum(q) filter (where kind = 'cur2')     m_cur2
  from k group by order_id
)
select ro.*,
  coalesce(a.m_roller, 0) m_roller, coalesce(a.m_cassette, 0) m_cassette, coalesce(a.m_roman, 0) m_roman,
  coalesce(a.m_blinds, 0) m_blinds, coalesce(a.m_motors, 0) m_motors, coalesce(a.m_remotes, 0) m_remotes,
  coalesce(a.m_baton, 0) m_baton, coalesce(a.m_bend, 0) m_bend, coalesce(a.m_trunk, 0) m_trunk,
  coalesce(a.m_scaf, 0) m_scaf, coalesce(a.m_curtains, 0) m_curtains,
  coalesce(a.m_cur1, 0) m_cur1, coalesce(a.m_cur2, 0) m_cur2
from public.v_ops_report_orders ro
left join a using (order_id)
where ro.production_state is distinct from 'cancelled';   -- a cancelled order supplies nothing

revoke all on public.v_ops_report_materials from anon;
grant select on public.v_ops_report_materials to authenticated;
