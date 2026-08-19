/* Handpicked Operations Management - configuration and vocabularies.
 *
 * Every value below that is written to the database is the canonical snake_case / exact-case string
 * the column's CHECK constraint expects. Labels are translated in i18n.js; VALUES ARE NEVER
 * TRANSLATED. Reverse that and writes start failing their CHECK.
 */

export const BUILD = "2026-08-19.2";

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
 * A phone photo is 3-6 MB raw; 1280px long edge at q0.65 lands around 120-200 KB, which is still
 * legible for damage evidence and survives mobile data in a lift. */
export const PHOTO_BUCKET  = "ops-photos";
export const PHOTO_MAX_PX  = 1280;
export const PHOTO_QUALITY = 0.65;
/* Uploads fail on mobile data far more often than they fail for any other reason, and a failed
 * evidence photo is usually never retaken. Three attempts with a widening gap turns most of them
 * into a slight pause instead. */
export const PHOTO_RETRIES    = 3;
export const PHOTO_RETRY_MS   = 1200;

/* ---------------------------------------------------------------- stages
 * Fabric receiving: order x fabric, on receiving_expectations.status (+ an independent qc_result).
 * Preparation:      window x layer, on preparation_events.stage - see PREP_STAGES.
 * Outwork:          order, on order_dispatch - see DISPATCH_SUBSTATES.
 *
 * preparation_events' CHECK still permits four legacy values from an earlier design
 * (follow_up_supplier, received, out_of_stock_fabric, fabric_quality_check) and the four stages
 * dropped in Aug 2026. The app writes only what PREP_STAGES lists - that is the constraint that
 * matters, and check_values.py enforces it. */
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

/* Started -> Packed -> Stacking.
 *
 * 'cutting' is LABELLED "Started" and keeps its stored value: renaming it would invalidate every
 * existing preparation_events row and fn_ops_set_dispatch's folding_packing call, for no gain. The
 * CHECK constraint still permits hemming / ironing / marking_measurement / taping - three historical
 * rows use hemming - but nothing writes them any more, and v_ops_order_roster folds all four onto
 * rank 1 so those panels still read as Started rather than disappearing off the ladder. */
export const PREP_STAGES = [
  { value: "cutting",         key: "prep.started" },
  { value: "folding_packing", key: "prep.packed" },
  { value: "stacking",        key: "prep.stacking" },
];

/* Where a packed order physically goes. Constrained the same way in preparation_events' CHECK, so a
 * value invented here is refused by the database rather than quietly stored. */
export const STACK_FLOORS = [
  { value: "G", key: "stack.floorG" },
  { value: "F", key: "stack.floorF" },
];
export const STACK_RACKS  = Array.from({ length: 10 }, (_, i) => `R${i + 1}`);
export const STACK_SHELVES = Array.from({ length: 9 }, (_, i) => `S${i + 1}`);
export const STACK_ZONES  = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

export const DISPATCH_CONTRACTORS = [
  { value: "farooq",  key: "disp.farooq" },
  { value: "jamal",   key: "disp.jamal" },
  { value: "shahzad", key: "disp.shahzad" },
  { value: "other",   key: "disp.other" },
];

/* planned -> sent -> received_back -> qc_passed -> paid, with qc_failed | issue off to the side.
 * Passing QC is what closes the production loop: fn_ops_set_dispatch then marks the order's panels
 * "Completed - folded & packed", but only once EVERY contractor on the order has passed.
 *
 * `paid` is a rung ABOVE qc_passed, not a state beside it: settling with the last tailor still
 * closes production. order_dispatch carries a payment axis of its own (payment_status / paid_at)
 * that the Dragon Mart report reads, and fn_ops_set_dispatch keeps the two in step in both
 * directions - moving a row back off paid returns it to unpaid. */
export const DISPATCH_SUBSTATES = [
  { value: "planned",       key: "disp.planned",  tone: "info" },
  { value: "sent",          key: "disp.sent",     tone: "warn" },
  { value: "received_back", key: "disp.back",     tone: "info" },
  { value: "qc_passed",     key: "disp.qcPass",   tone: "ok" },
  { value: "paid",          key: "disp.paid",     tone: "ok" },
  { value: "qc_failed",     key: "disp.qcFail",   tone: "bad" },
  // work stalled at the tailor - distinct from qc_failed, which is work that came back and failed
  { value: "issue",         key: "disp.issue",    tone: "bad" },
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
  // ranked above 'packed' in the view: panels that failed QC are not finished, however far prep got
  { value: "qc_failed",       key: "ps.qcFailed",  tone: "bad" },
  { value: "cancelled",       key: "ps.cancelled", tone: "bad" },
];

/* v_ops_order_roster.fabric_recv_state - how much of an order's FABRIC has landed, ignoring
 * materials. Derived in the view from recv_fab_done / recv_fab_total, so the filter runs in Postgres
 * rather than over a page of rows. */
export const FABRIC_RECV_STATES = [
  { value: "not_received", key: "fs.none",    tone: "mute" },
  { value: "partial",      key: "fs.partial", tone: "warn" },
  { value: "received",     key: "fs.full",    tone: "ok" },
];

/* v_ops_order_roster.dispatch_state - one outwork state for a whole order, so the Ext Tailor filter
 * is a single equality rather than a search through the dispatch array. Derived in the view: an
 * issue or a failed check wins outright, otherwise it reports the LEAST advanced tailor, because an
 * order split between two of them is only as far along as the one still holding panels.
 * These are DISPATCH_SUBSTATES plus not_sent, which is the absence of any order_dispatch row.
 *
 * ORDER MATTERS BEYOND THE DROPDOWN: mod-production sorts its Tailors column by an order's position
 * in this list, so it reads least-advanced first with the two problem states last. */
export const DISPATCH_STATES = [
  { value: "not_sent",      key: "disp.notSent", tone: "mute" },
  { value: "planned",       key: "disp.planned", tone: "info" },
  { value: "sent",          key: "disp.sent",    tone: "warn" },
  { value: "received_back", key: "disp.back",    tone: "info" },
  { value: "qc_passed",     key: "disp.qcPass",  tone: "ok" },
  { value: "paid",          key: "disp.paid",    tone: "ok" },
  { value: "qc_failed",     key: "disp.qcFail",  tone: "bad" },
  { value: "issue",         key: "disp.issue",   tone: "bad" },
];

/* ---------------------------------------------------------------- line review
 * line_review_mark.status. A coordinator has to read every line of every order; these are what they
 * can record against one.
 *
 * UNREAD IS NOT IN THIS LIST, deliberately. It is the ABSENCE of any mark, so 4,409 lines need no
 * rows at all to start in the right state, and "unread" can never drift out of step with the marks
 * beside it. The UI shows it as a chip like the rest. */
export const LINE_REVIEW_STATUSES = [
  { value: "read",                  key: "rev.read",           tone: "ok" },
  { value: "follow_up_production",  key: "rev.fuProduction",   tone: "warn" },
  { value: "follow_up_installation",key: "rev.fuInstallation", tone: "warn" },
  { value: "follow_up_procurement", key: "rev.fuProcurement",  tone: "warn" },
  { value: "ask_coordinators",      key: "rev.askCoord",       tone: "info" },
  { value: "installed",             key: "rev.installed",      tone: "ok" },
];

/* v_ops_line_review.procurement_req - what procurement has to act on before this line can be made.
 * Derived in the view, not here; these are the labels and the filter's options. A roman blind only
 * counts when the line is ours to produce, since a fixing-only roman is somebody else's stock -
 * see the view for the supplier_type test. */
export const PROCUREMENT_REQS = [
  { value: "roman_production", key: "proc.roman" },
  { value: "pelmet",           key: "proc.pelmet" },
  { value: "eyelet",           key: "proc.eyelet" },
];

/* ---------------------------------------------------------------- inventory vocabularies
 * Both are CHECK-constrained on inventory_items, so these are values, not labels - see the header.
 * The item_code prefix for each category is decided in fn_ops_next_item_code, NOT here: the code is
 * generated inside the same statement that inserts the row, so two tablets adding an item at the
 * same moment cannot land on the same one. */
export const UOM_OPTIONS = [
  { value: "pieces", key: "inv.uomPieces" },
  { value: "meters", key: "inv.uomMeters" },
  { value: "sqmt",   key: "inv.uomSqmt" },
];

export const ITEM_CATEGORIES = [
  { value: "Fixer Tools",     key: "inv.catFixerTools" },
  { value: "Fixer Materials", key: "inv.catFixerMaterials" },
  { value: "Tailors",         key: "inv.catTailors" },
  { value: "Consumables",     key: "inv.catConsumables" },
  { value: "Others",          key: "inv.catOthers" },
];

/* ---------------------------------------------------------------- roles
 * app_roles.role. 'ops' is the access everyone had before roles existed; 'viewer' reads everything
 * and writes nothing; 'prod_viewer' is a viewer pointed at Production alone - people who need to
 * watch fabric receiving without being able to touch it.
 *
 * ONLY 'ops' CAN WRITE. fn_is_viewer() in the database tests `role <> 'ops'`, so a role added here
 * arrives read-only and has to be let in deliberately, rather than arriving with full access across
 * 42 tables until somebody remembers to go and stop it.
 *
 * Which TABS a role sees is presentation and lives in app.js; what it may WRITE is RLS and lives in
 * the database. The app ships its publishable key, so a viewer holds a genuine bearer token they
 * could point at PostgREST directly - hiding a button has never been the boundary. */
export const APP_ROLES = [
  { value: "ops",         key: "role.ops" },
  { value: "viewer",      key: "role.viewer" },
  { value: "prod_viewer", key: "role.prodViewer" },
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
  { value: "extra_wire",       key: "chg.wire" },
  { value: "extra_trunking",   key: "chg.trunking" },
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

/* ---------------------------------------------------------------- handover
 * handover.kind and handover.status. A handover is who physically gave what to whom, which is a
 * different question from a material transfer's state: a transfer says where the goods are in the
 * process, a handover says whose hands they are in and whether that person agreed.
 *
 * ACKNOWLEDGED IS NOT COSMETIC. For an inventory handover it is the moment fn_ops_ack_handover posts
 * the lines to the movement ledger - "I put it in the van" and "I have it" are different claims, and
 * stock should follow the second one. */
export const HANDOVER_KINDS = [
  { value: "order",     key: "hnd.kindOrder" },
  { value: "inventory", key: "hnd.kindInventory" },
];

export const HANDOVER_STATUSES = [
  { value: "handed_over",  key: "hnd.handedOver",  tone: "warn" },
  { value: "acknowledged", key: "hnd.acknowledged", tone: "ok" },
  { value: "disputed",     key: "hnd.disputed",    tone: "bad" },
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

/* ---------------------------------------------------------------- schedule
 * These two are NOT written by the browser - fn_sched_* computes them server-side and the module
 * only reads them back - so they are absent from check_values.py, which guards values the app
 * writes to CHECK-constrained columns. The strings must still match sched_run_team.util_band and
 * sched_stop.counts->>'tag' or the card renders untoned.
 *
 * Bands are on (on-site minutes + travel) / usable minutes, so a team can be "stretched" on driving
 * alone - which is exactly the case a coordinator needs to see before it becomes a late arrival. */
export const UTIL_BANDS = [
  { value: "under",     key: "sch.band.under",     tone: "ok"   },
  { value: "optimum",   key: "sch.band.optimum",   tone: "ok"   },
  { value: "stretched", key: "sch.band.stretched", tone: "warn" },
  { value: "over",      key: "sch.band.over",      tone: "bad"  },
];

export const STOP_TAGS = [
  { value: "new",        key: "sch.tag.new" },
  { value: "issue",      key: "sch.tag.issue" },
  { value: "alteration", key: "sch.tag.alteration" },
  { value: "manual",     key: "sch.tag.manual" },
];

export const PAGE_SIZE = 200;
