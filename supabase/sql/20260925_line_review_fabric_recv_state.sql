-- 25 Sep 2026: PO tab gets the Fabric status filter (not received / partially / fully received).
--
-- v_ops_line_review already joins v_ops_order_roster, which derives fabric_recv_state from
-- recv_fab_done / recv_fab_total - so this only appends that one column. It is an ORDER-level state
-- carried onto every line, the same figure the Production screen filters on, so the two screens can
-- never disagree about whether an order's fabric is in.
--
-- CREATE OR REPLACE keeps grants and reloptions; the column is appended LAST because a replace may
-- only add columns at the end.
create or replace view public.v_ops_line_review as
 WITH marks AS (
         SELECT line_review_mark.line_id,
            array_agg(line_review_mark.status ORDER BY line_review_mark.status) AS marks,
            array_agg(line_review_mark.status ORDER BY line_review_mark.status) FILTER (WHERE line_review_mark.actioned) AS marks_actioned,
            bool_or(line_review_mark.status = 'read'::text) AS is_read,
            count(*) FILTER (WHERE line_review_mark.status <> 'read'::text AND NOT line_review_mark.actioned) AS open_follow_ups,
            max(line_review_mark.updated_at) AS marked_at
           FROM line_review_mark
          GROUP BY line_review_mark.line_id
        ), vers AS (
         SELECT po_lines_raw.order_id,
            count(DISTINCT po_lines_raw.version_no) AS version_count
           FROM po_lines_raw
          GROUP BY po_lines_raw.order_id
        )
 SELECT f.id AS line_id,
    f.order_id,
    f.line_no,
    o.issue_flag,
    f.window_ref,
    r.linkage,
    f.supplier_type,
    f.commercial_name,
    f.window_name,
    f.optional_comment,
    f.installation_notes,
    f.l1_bottom_finish AS fabric_1_bottom_stitch,
    f.l2_bottom_finish AS fabric_2_bottom_stitch,
    f.quantity,
    f.adjusted_width_cm AS adjusted_width,
    f.adjusted_height_cm AS adjusted_height,
    f.height_variation_raw AS height_variation,
    f.brackets,
    f.opening,
    f.pooling,
    COALESCE(r.fabric1_code, f.l1_fabric) AS fabric_1_new,
    r.fabric1_qty AS fabric_1_quantity,
    COALESCE(r.fabric2_code, f.l2_fabric) AS fabric_2_new,
    r.fabric2_qty AS fabric_2_quantity,
    array_remove(ARRAY[
        CASE
            WHEN COALESCE(f.roman, 0) = 1 AND f.supplier_type ~~* '%production%'::text THEN 'roman_production'::text
            ELSE NULL::text
        END,
        CASE
            WHEN COALESCE(f.pelmet, 0) = 1 THEN 'pelmet'::text
            ELSE NULL::text
        END,
        CASE
            WHEN COALESCE(f.eyelet, 0) = 1 THEN 'eyelet'::text
            ELSE NULL::text
        END], NULL::text) AS procurement_req,
    COALESCE(m.marks, '{}'::text[]) AS marks,
    COALESCE(m.marks_actioned, '{}'::text[]) AS marks_actioned,
    COALESCE(m.is_read, false) AS is_read,
    COALESCE(m.open_follow_ups, 0::bigint) AS open_follow_ups,
    m.marked_at,
        CASE
            WHEN COALESCE(m.is_read, false) THEN 'read'::text
            ELSE 'unread'::text
        END AS read_state,
    f.customer_name,
    f.city,
    f.installation_date,
    f.production_comment,
    o.date_bucket,
    o.sheet_status,
    o.alteration,
    o.city_source,
    o.production_state,
    o.stitching_types,
    o.commercial_names,
    o.window_refs,
    o.fabric_1_codes,
    o.fabric_2_codes,
    o.search_blob,
    o.version_no,
    COALESCE(v.version_count, 1::bigint)::integer AS version_count,
    o.fabric_recv_state
   FROM order_lines_final f
     LEFT JOIN po_lines_raw r ON r.id = f.po_line_raw_id
     LEFT JOIN v_ops_order_roster o ON o.order_id = f.order_id
     LEFT JOIN marks m ON m.line_id = f.id
     LEFT JOIN vers v ON v.order_id = f.order_id;
