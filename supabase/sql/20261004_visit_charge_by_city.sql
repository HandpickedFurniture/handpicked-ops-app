-- 4 Oct 2026 (user): the visit charge is AED 100 in Dubai and AED 150 in Abu Dhabi, for every future
-- adjustment. Until now additional_visit was one row at 150 for both cities.
--
-- HOW: adjustment_rate_card gains a nullable `city`. NULL means "every city" and stays the fallback
-- for an order whose city is unknown, so every other charge type is untouched. fn_ops_rate_for gains
-- p_order_id, resolves the city with fn_order_city (roster city, then an alert's city_override - the
-- city ALWAYS comes from the roster, never order_lines_final), and prefers the city's own row.
--
-- A changed signature means DROP + CREATE, and v_ops_finance_adjustments depends on the function, so
-- that view is dropped and recreated in the same transaction with its grants. v_ops_adjustments priced
-- card_rate_aed / rate_drift from a DISTINCT ON (charge_type, min_qty) over the card - with two city
-- rows it would pick one at random and flag every Dubai visit as drift - so it now asks the same
-- function. Columns of both views are unchanged (check_columns.py).
--
-- Callers that know the order (fn_ops_add_adjustment, fn_ops_build_invoice,
-- fn_finance_propose_adjustment_amount, fn_finance_set_adjustment_amount) are patched in place to pass
-- it; the old 2-argument call still works and simply gets the fallback row. fn_chotu_context now sends
-- each rate row's city so Chotu can tell 100 from 150.
--
-- Amounts already booked are NOT repriced: a stated or agreed figure is somebody's decision.

begin;

alter table public.adjustment_rate_card
    add column if not exists city text
    check (city is null or city in ('Dubai', 'Abu Dhabi'));
comment on column public.adjustment_rate_card.city is
    'NULL = every city (and the fallback when an order''s city is unknown). Set only where a city has its own rate - so far additional_visit.';

insert into public.adjustment_rate_card
    (charge_type, label, unit, rate_aed, min_qty, max_qty, catalog_id, effective_from, effective_to, active, note, free_qty, city)
values
    ('additional_visit', 'Additional visit charge (Dubai)', 'per visit', 100, 1, null, null, '2026-10-04', null, true,
     'Dubai visit charge 100 (user, 4 Oct 2026). Abu Dhabi is 150.', 0, 'Dubai'),
    ('additional_visit', 'Additional visit charge (Abu Dhabi)', 'per visit', 150, 1, null, null, '2026-10-04', null, true,
     'Abu Dhabi visit charge 150 (user, 4 Oct 2026). Dubai is 100.', 0, 'Abu Dhabi');

update public.adjustment_rate_card
   set note = 'FALLBACK only, for an order whose city is unknown. Dubai is 100 and Abu Dhabi 150 on their own rows from 4 Oct 2026.'
 where id = 3;

update public.adjustment_rate_card
   set note = 'FLAT 50 for the job, never multiplied by the count. ALWAYS billed together with a separate visit charge (additional_visit: Dubai 100, Abu Dhabi 150) - total 150 Dubai / 200 Abu Dhabi. Was 150 flat until 27 Sep 2026 (user, 28 Sep 2026); visit split by city 4 Oct 2026.'
 where id = 27;

create or replace function public.fn_order_city(p_order_id text)
returns text
language sql stable
set search_path to 'public', 'pg_temp'
as $$
    select coalesce(
        (select r.city from public.v_ops_order_roster r where r.order_id = p_order_id limit 1),
        (select a.city_override from public.accounting_alerts a
          where a.order_id = p_order_id and a.city_override is not null
          order by a.id desc limit 1));
$$;
grant execute on function public.fn_order_city(text) to authenticated, service_role;

drop view public.v_ops_finance_adjustments;
drop function public.fn_ops_rate_for(text, numeric, date);

create function public.fn_ops_rate_for(p_charge_type text, p_qty numeric default 1,
                                       p_on_date date default current_date,
                                       p_order_id text default null)
returns table(rate_card_id bigint, rate_aed numeric, amount_aed numeric, unit text, label text)
language sql stable
set search_path to 'public', 'pg_temp'
as $function$
    select c.id, c.rate_aed,
           round(case when c.unit in ('per order','per visit') then c.rate_aed
                      when c.free_qty > 0
                        then c.rate_aed * greatest(0, coalesce(p_qty, 1) - c.free_qty)
                      else c.rate_aed * greatest(1, coalesce(p_qty, 1)) end, 2),
           c.unit, c.label
    from public.adjustment_rate_card c
    cross join (select public.fn_order_city(p_order_id) as city) o
    where c.active
      and c.charge_type = p_charge_type
      and c.effective_from <= p_on_date
      and (c.effective_to is null or c.effective_to >= p_on_date)
      and greatest(1, coalesce(p_qty, 1)) >= c.min_qty
      and (c.max_qty is null or greatest(1, coalesce(p_qty, 1)) <= c.max_qty)
      and (c.city is null or c.city = o.city)
    -- the city's own row beats the every-city row, then newest, then the highest band
    order by (c.city is not null) desc, c.effective_from desc, c.min_qty desc
    limit 1;
$function$;
grant execute on function public.fn_ops_rate_for(text, numeric, date, text) to authenticated, service_role;

create view public.v_ops_finance_adjustments as
 WITH last_comment AS (
         SELECT DISTINCT ON (order_comments.order_id) order_comments.order_id,
            order_comments.body,
            order_comments.author,
            order_comments.created_at
           FROM order_comments
          WHERE NULLIF(btrim(COALESCE(order_comments.body, ''::text)), ''::text) IS NOT NULL
          ORDER BY order_comments.order_id, order_comments.created_at DESC
        )
 SELECT a.id,
    a.order_id,
    COALESCE(a.city, r.city) AS city,
    COALESCE(lc.body, a.notes) AS installation_comment,
    a.order_id AS order_name,
    a.customer_name,
    a.effective_amount_aed AS amount_aed,
    a.reason,
    a.charge_type,
    a.quantity,
    a.status AS adj_status,
    a.chargeable,
    a.visit_no,
    a.card_rate_aed,
    a.rate_drift,
    a.installation_date,
    r.order_received_date,
    r.order_status,
    r.date_bucket,
    COALESCE(s.invoice_status, 'Pending'::text) AS invoice_status,
    COALESCE(s.adjustment_status, 'NA'::text) AS adjustment_status,
    s.review_override,
    NULLIF(btrim(COALESCE(a.reason, ''::text)), ''::text) IS NULL OR a.effective_amount_aed IS NULL AS rv_incomplete,
    a.rate_drift AS rv_rate_drift,
    a.amount_source,
    a.amount_source = 'system'::text AS amount_is_system,
    rc.amount_aed AS card_amount_aed,
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
   FROM v_ops_adjustments a
     LEFT JOIN last_comment lc ON lc.order_id = a.order_id
     LEFT JOIN v_ops_order_roster r ON r.order_id = a.order_id
     LEFT JOIN finance_order_state s ON s.order_id = a.order_id
     LEFT JOIN LATERAL fn_ops_rate_for(a.charge_type, COALESCE(a.quantity, 1::numeric), CURRENT_DATE, a.order_id)
          rc(rate_card_id, rate_aed, amount_aed, unit, label) ON true;
revoke all on public.v_ops_finance_adjustments from public, anon;
grant all on public.v_ops_finance_adjustments to authenticated, service_role;

create or replace view public.v_ops_adjustments with (security_invoker = on) as
 SELECT a.id,
    a.order_id,
    a.version_no,
    a.visit_no,
    a.line_no,
    a.window_name,
    a.commercial_name,
    a.charge_type,
    a.reason,
    a.quantity,
    a.suggested_amount_aed,
    a.agreed_amount_aed,
    a.chargeable,
    a.source,
    a.status,
    a.captured_by,
    a.notes,
    a.invoice_line_id,
    a.created_at,
    a.updated_at,
    COALESCE(a.agreed_amount_aed, a.suggested_amount_aed) AS effective_amount_aed,
    c.rate_aed AS card_rate_aed,
    c.label AS card_label,
    c.unit AS card_unit,
    a.suggested_amount_aed IS NOT NULL AND c.rate_aed IS NOT NULL AND round(a.suggested_amount_aed, 2) <> round(c.rate_aed, 2) AS rate_drift,
    o.customer_name,
    o.city,
    o.installation_date,
    v.visit_date,
    a.amount_source,
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
   FROM accounting_alerts a
     LEFT JOIN LATERAL fn_ops_rate_for(a.charge_type, COALESCE(a.quantity, 1::numeric), CURRENT_DATE, a.order_id) c ON true
     LEFT JOIN LATERAL ( SELECT max(f.customer_name) AS customer_name,
            max(NULLIF(NULLIF(f.city, 'Unknown'::text), ''::text)) AS city,
            max(f.installation_date) AS installation_date
           FROM order_lines_final f
          WHERE f.order_id = a.order_id) o ON true
     LEFT JOIN order_visits v ON v.order_id = a.order_id AND v.visit_no = a.visit_no;

-- Callers that know the order pass it. Patched in place (the fn_* bodies are not versioned in files);
-- each patch must hit or the whole migration rolls back.
do $patch$
declare
    r record; d text; n text;
begin
    for r in select * from (values
        ('fn_ops_add_adjustment', 'fn_ops_rate_for\(p_charge_type, p_quantity\)',
                                  'fn_ops_rate_for(p_charge_type, p_quantity, current_date, p_order_id)'),
        ('fn_ops_build_invoice',  'fn_ops_rate_for\(a\.charge_type, a\.quantity\)',
                                  'fn_ops_rate_for(a.charge_type, a.quantity, current_date, a.order_id)'),
        ('fn_finance_propose_adjustment_amount', 'fn_ops_rate_for\((\s*)a\.charge_type, coalesce\(a\.quantity, 1\)\)',
                                  'fn_ops_rate_for(\1a.charge_type, coalesce(a.quantity, 1), current_date, a.order_id)'),
        ('fn_finance_set_adjustment_amount', 'fn_ops_rate_for\((\s*)a\.charge_type, coalesce\(a\.quantity, 1\)\)',
                                  'fn_ops_rate_for(\1a.charge_type, coalesce(a.quantity, 1), current_date, a.order_id)'),
        ('fn_chotu_context', '''note'', c\.note\)', '''note'', c.note, ''city'', c.city)')
    ) v(fname, pat, rep)
    loop
        select pg_get_functiondef(p.oid) into d
          from pg_proc p join pg_namespace s on s.oid = p.pronamespace
         where s.nspname = 'public' and p.proname = r.fname;
        n := regexp_replace(d, r.pat, r.rep, 'g');
        if n = d then
            raise exception 'visit-by-city patch missed %', r.fname;
        end if;
        execute n;
    end loop;
end
$patch$;

commit;
