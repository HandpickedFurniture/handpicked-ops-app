/* Handpicked Operations Management - configuration and vocabularies.
 *
 * Every value below that is written to the database is the canonical snake_case / exact-case string
 * the column's CHECK constraint expects. Labels are translated in i18n.js; VALUES ARE NEVER
 * TRANSLATED. Reverse that and writes start failing their CHECK.
 */

export const BUILD = "2026-08-09.1";

/* Supabase project "handpicked-curtains". The publishable key is safe to ship: every table is
 * RLS-locked to the `authenticated` role and `anon` has no policy at all. The bearer token on each
 * request is the signed-in user's access token, NOT this key - see api.js. */
export const SB_URL = "https://jrevqijbzzwdcwxcnwfa.supabase.co";
export const SB_KEY = "sb_publishable_I4J8srUWlXVnkI-9qGpPQg_XblXWZ8r";

export const STORAGE_PREFIX = "kops_";

/* ---------------------------------------------------------------- photos
 * The bucket name is the same on both backends, so switching Supabase -> Google Cloud Storage does
 * not rewrite any stored path. Which backend is live is detected at runtime (see js/photos.js), not
 * configured here.
 * A phone photo is 3-6 MB raw; 1600px long edge at q0.72 lands around 200-350 KB, which is still
 * legible for damage evidence and survives mobile data in a lift. */
export const PHOTO_BUCKET  = "ops-photos";
export const PHOTO_MAX_PX  = 1600;
export const PHOTO_QUALITY = 0.72;

/* ---------------------------------------------------------------- stages
 * Stage 1-4: order x fabric, on receiving_expectations.status (+ an independent qc_result axis).
 * Stage 5-10: window x layer, on preparation_events.stage.
 * Stage 11-14: order, on order_dispatch.
 *
 * preparation_events' CHECK still permits four legacy values from an earlier design
 * (follow_up_supplier, received, out_of_stock_fabric, fabric_quality_check). The app writes only the
 * six below - this list is the constraint that matters. */
export const RECV_STATUSES = [
  { value: "pending",      key: "recv.pending",  tone: "wait" },
  { value: "ordered",      key: "recv.ordered",  tone: "wait" },
  { value: "received",     key: "recv.received", tone: "ok" },
  { value: "partial",      key: "recv.partial",  tone: "warn" },
  { value: "out_of_stock", key: "recv.oos",      tone: "bad" },
  { value: "cancelled",    key: "recv.cancelled",tone: "mute" },
];

export const QC_RESULTS = [
  { value: "ok_fabric",           key: "qc.ok",           tone: "ok" },
  { value: "damaged_fabric",      key: "qc.damaged",      tone: "bad" },
  { value: "insufficient_fabric", key: "qc.insufficient", tone: "bad" },
  { value: "wrong_fabric",        key: "qc.wrong",        tone: "bad" },
];

export const PREP_STAGES = [
  { value: "cutting",             key: "prep.cutting" },
  { value: "hemming",             key: "prep.hemming" },
  { value: "ironing",             key: "prep.ironing" },
  { value: "marking_measurement", key: "prep.marking" },
  { value: "taping",              key: "prep.taping" },
  { value: "folding_packing",     key: "prep.packed" },
];

export const DISPATCH_CONTRACTORS = [
  { value: "farooq",  key: "disp.farooq" },
  { value: "jamal",   key: "disp.jamal" },
  { value: "shahzad", key: "disp.shahzad" },
  { value: "other",   key: "disp.other" },
];

export const DISPATCH_SUBSTATES = [
  { value: "planned",       key: "disp.planned" },
  { value: "sent",          key: "disp.sent" },
  { value: "received_back", key: "disp.back" },
];

/* ---------------------------------------------------------------- order status
 * Exact strings - order_status_status_check and order_visits_status_check are case-sensitive. */
/* The first two are PRE-states; the rest are outcomes. v_ops_eod counts outcomes, so Scheduled and
 * Out for installation deliberately fall outside both the completed and the issue tallies. */
export const ORDER_STATUSES = [
  "Scheduled",
  "Out for installation",
  "Successfully completed",
  "Production issue",
  "Consultation issue",
  "Rescheduled",
  "Partially completed",
  "Client change of mind",
  "Installation issue",
  "Others",
];

export const STATUS_TONE = {
  "Scheduled":              "info",
  "Out for installation":   "info",
  "Successfully completed": "ok",
  "Partially completed":    "warn",
  "Rescheduled":            "warn",
  "Production issue":       "bad",
  "Consultation issue":     "bad",
  "Installation issue":     "bad",
  "Client change of mind":  "mute",
  "Others":                 "mute",
};

/* v_ops_order_roster.production_state - a coarse production position, for the dashboard chart. */
export const PRODUCTION_STATES = [
  { value: "awaiting_fabric", key: "ps.awaiting",  tone: "mute" },
  { value: "ordered",         key: "ps.ordered",   tone: "info" },
  { value: "fabric_in",       key: "ps.fabricIn",  tone: "info" },
  { value: "in_production",   key: "ps.inProd",    tone: "warn" },
  { value: "packed",          key: "ps.packed",    tone: "ok" },
  { value: "cancelled",       key: "ps.cancelled", tone: "bad" },
];

/* ---------------------------------------------------------------- adjustments
 * accounting_alerts.charge_type vocabulary. Rates are NOT hardcoded here - they come from
 * adjustment_rate_card via the fn_ops_rate_for RPC, so removal's banding and any future rate change
 * live in one place. */
export const CHARGE_TYPES = [
  { value: "additional_visit", key: "chg.visit" },
  { value: "alteration",       key: "chg.alteration" },
  { value: "removal",          key: "chg.removal" },
  { value: "pickup",           key: "chg.pickup" },
  { value: "drop_off",         key: "chg.dropoff" },
  { value: "scaffolding",      key: "chg.scaffolding" },
  { value: "tieback",          key: "chg.tieback" },
  { value: "extra_track",      key: "chg.track" },
  { value: "moving",           key: "chg.moving" },
  { value: "other",            key: "chg.other" },
];

export const ADJ_STATUSES = [
  { value: "new",      key: "adj.new",      tone: "warn" },
  { value: "reviewed", key: "adj.reviewed", tone: "ok" },
  { value: "invoiced", key: "adj.invoiced", tone: "mute" },
  { value: "dropped",  key: "adj.dropped",  tone: "mute" },
];

/* ---------------------------------------------------------------- date buckets
 * Computed server-side in v_ops_order_roster against Asia/Dubai, so a laptop on the wrong timezone
 * cannot disagree with a phone. Never colour-only: each carries a glyph and a label too. */
export const DATE_BUCKETS = [
  { value: "overdue",   key: "bucket.overdue",   glyph: "!", tone: "bad" },
  { value: "today",     key: "bucket.today",     glyph: "●", tone: "warn" },
  { value: "tomorrow",  key: "bucket.tomorrow",  glyph: "▸", tone: "warn" },
  { value: "day_after", key: "bucket.dayAfter",  glyph: "▹", tone: "info" },
  { value: "this_week", key: "bucket.week",      glyph: "›", tone: "info" },
  { value: "later",     key: "bucket.later",     glyph: "·", tone: "mute" },
  { value: "nodate",    key: "bucket.nodate",    glyph: "?", tone: "mute" },
  { value: "done",      key: "bucket.done",      glyph: "✓", tone: "ok" },
];

/* Tone lives on the entry above rather than in a hardcoded ladder in each module, so adding a
 * bucket needs one edit here instead of three that can silently drift apart. */
export const bucketOf = (v) =>
  DATE_BUCKETS.find((b) => b.value === v) || { key: "bucket.later", glyph: "·", tone: "mute" };

/* Special-requirement columns on v_ops_order_roster, in the order production cares about. */
export const SPECIAL_COLS = [
  { col: "n_roman",          key: "sp.roman" },
  { col: "n_roller",         key: "sp.roller" },
  { col: "n_zebra",          key: "sp.zebra" },
  { col: "n_wooden",         key: "sp.wooden" },
  { col: "n_venetian",       key: "sp.venetian" },
  { col: "n_pelmet",         key: "sp.pelmet" },
  { col: "n_motor",          key: "sp.motor" },
  { col: "n_bend_rail",      key: "sp.bend" },
  { col: "n_scaffolding",    key: "sp.scaffolding" },
  { col: "n_pull_cord",      key: "sp.pullcord" },
  { col: "n_eyelet",         key: "sp.eyelet" },
  { col: "n_baton_stick",    key: "sp.baton" },
  { col: "n_tieback_hooks",  key: "sp.tiebackhook" },
  { col: "n_tieback_velcro", key: "sp.tiebackvelcro" },
  { col: "n_cassette",       key: "sp.cassette" },
  { col: "n_trunking",       key: "sp.trunking" },
  { col: "n_velcro_stitch",  key: "sp.velcro" },
  { col: "n_pickup",         key: "sp.pickup" },
  { col: "n_alteration",     key: "sp.alteration" },
  { col: "n_removal",        key: "sp.removal" },
];

/* ---------------------------------------------------------------- transfers
 * material_transfers.status. Distinct from order_dispatch (outwork stitching): this is materials
 * going out for installation and what comes back. */
export const TRANSFER_STATUSES = [
  { value: "in_progress",        key: "tr.inprogress", tone: "info" },
  { value: "ready",              key: "tr.ready",      tone: "ok" },
  { value: "returned",           key: "tr.returned",   tone: "ok" },
  { value: "partially_returned", key: "tr.partial",    tone: "warn" },
  { value: "extra_materials",    key: "tr.extra",      tone: "warn" },
  { value: "cancelled",          key: "tr.cancelled",  tone: "mute" },
  { value: "issue",              key: "tr.issue",      tone: "bad" },
];

/* inventory_movements.reason */
export const MOVE_REASONS = [
  { value: "purchase",     key: "inv.purchase" },
  { value: "consumption",  key: "inv.consumption" },
  { value: "adjustment",   key: "inv.adjustment" },
  { value: "return",       key: "inv.return" },
  { value: "transfer_out", key: "inv.transferOut" },
  { value: "transfer_in",  key: "inv.transferIn" },
];

export const LOCATION_KINDS = [
  { value: "warehouse",  key: "loc.warehouse" },
  { value: "rack",       key: "loc.rack" },
  { value: "shelf",      key: "loc.shelf" },
  { value: "van",        key: "loc.van" },
  { value: "site",       key: "loc.site" },
  { value: "contractor", key: "loc.contractor" },
  { value: "office",     key: "loc.office" },
  { value: "other",      key: "loc.other" },
];

/* order_photos.context - what a photo is evidence OF */
export const PHOTO_CONTEXTS = [
  { value: "receiving",    key: "col.receiving" },
  { value: "prep",         key: "col.prep" },
  { value: "dispatch",     key: "disp.title" },
  { value: "order_status", key: "st.orderStatus" },
  { value: "visit",        key: "col.visits" },
  { value: "adjustment",   key: "adj.title" },
  { value: "transfer",     key: "nav.transfer" },
  { value: "inventory",    key: "nav.inventory" },
  { value: "other",        key: "chg.other" },
];

export const PAGE_SIZE = 200;
