-- 25 Sep 2026: Planning gets the Fabric status filter, as the PO tab did the same day
-- (20260925_line_review_fabric_recv_state.sql). v_ops_report_orders is built on v_ops_order_roster,
-- so this only passes the roster's fabric_recv_state through - appended LAST, as CREATE OR REPLACE
-- requires. Grants and reloptions are kept by the replace.
create or replace view public.v_ops_report_orders as
 WITH meters AS (
         SELECT order_lines_final.order_id,
            round(sum(
                CASE
                    WHEN order_lines_final.curtain_stitching_type ~~* '%american%'::text THEN COALESCE(order_lines_final.fabric_meters, 0::numeric)
                    ELSE 0::numeric
                END), 1) AS american_meters,
            round(sum(
                CASE
                    WHEN order_lines_final.curtain_stitching_type ~~* '%wave%'::text OR order_lines_final.curtain_stitching_type ~~* '%ripplefold%'::text THEN COALESCE(order_lines_final.fabric_meters, 0::numeric)
                    ELSE 0::numeric
                END), 1) AS wave_meters,
            round(sum(
                CASE
                    WHEN order_lines_final.curtain_stitching_type !~* 'american|wave|ripplefold'::text THEN COALESCE(order_lines_final.fabric_meters, 0::numeric)
                    ELSE 0::numeric
                END), 1) AS other_meters
           FROM order_lines_final
          GROUP BY order_lines_final.order_id
        ), recvm AS (
         SELECT r_1.order_id,
            round(sum(e.qty_received), 1) AS received_meters
           FROM receiving_expectations r_1
             JOIN receiving_events e ON e.expectation_id = r_1.id
          WHERE r_1.grain = 'order_fabric'::text AND e.qty_received IS NOT NULL
          GROUP BY r_1.order_id
        )
 SELECT r.order_id,
    r.customer_name,
    r.city,
    r.city_source,
    r.installation_date,
    r.sheet_install_time AS installation_time,
    r.issue_flag,
    r.sheet_status,
    r.date_bucket,
    r.version_no,
    r.team_no,
    r.order_status,
    r.production_state,
    r.window_count,
    r.owl_curtains,
    r.owl_blinds,
    r.owl_total,
    r.fabric_meters_total,
    r.meters_sent_total,
    COALESCE(m.american_meters, 0::numeric) AS american_meters,
    COALESCE(m.wave_meters, 0::numeric) AS wave_meters,
    COALESCE(m.other_meters, 0::numeric) AS other_meters,
    COALESCE(rm.received_meters, 0::numeric) AS received_meters,
    b.po_amount_aed AS credits,
    r.est_minutes,
    r.n_pelmet,
    r.n_bend_rail,
    r.n_motor,
    r.n_scaffolding,
    r.n_pull_cord,
    r.n_roman,
    r.n_roller,
    r.n_eyelet,
    r.n_baton_stick,
    r.n_removal,
    r.n_alteration,
    r.alteration,
    r.optional_comments,
    r.installation_notes,
    r.production_comments,
    r.recv_fab_done,
    r.recv_fab_total,
    r.recv_mat_done,
    r.recv_mat_total,
    r.prep_done,
    r.prep_total,
    r.prep_max_rank,
    r.stitching_types,
    r.commercial_names,
    r.window_refs,
    r.fabric_1_codes,
    r.fabric_2_codes,
    r.search_blob,
    r.synced_at,
    COALESCE(NULLIF(rm.received_meters, 0::numeric), r.meters_sent_total, 0::numeric) AS report_meters,
    COALESCE(rm.received_meters, 0::numeric) > 0::numeric AS meters_is_received,
    r.prep_started,
    COALESCE(pl.receive, false) AS plan_receive,
    COALESCE(pl.cut, false) AS plan_cut,
    COALESCE(pl.hemming, false) AS plan_hemming,
    COALESCE(pl.iron, false) AS plan_iron,
    COALESCE(pl.marking, false) AS plan_marking,
    COALESCE(pl.taping, false) AS plan_taping,
    COALESCE(pl.fold, false) AS plan_fold,
    pl.comment AS plan_comment,
    pl.updated_by AS plan_updated_by,
    pl.updated_at AS plan_updated_at,
    pl.priority AS plan_priority,
    r.fabric_recv_state
   FROM v_ops_order_roster r
     LEFT JOIN planning_status pl ON pl.order_id = r.order_id
     LEFT JOIN meters m ON m.order_id = r.order_id
     LEFT JOIN recvm rm ON rm.order_id = r.order_id
     LEFT JOIN v_ops_billing b ON b.order_id = r.order_id;
