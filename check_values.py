"""Guards the cardinal i18n rule: TRANSLATE THE LABEL, KEEP THE VALUE ENGLISH.

Every string this app writes to a constrained column - preparation_events.stage,
receiving_expectations.status/qc_result, order_dispatch.contractor/substate,
accounting_alerts.charge_type/status, order_status.status - must stay exactly as the database's CHECK
constraint spells it. If one of those canonical values ever gets translated, or drifts from the
constraint, writes start failing at runtime rather than here.

This checks js/config.js against the vocabularies as applied by the migrations.

    python check_values.py
"""
import re
import sys

src = open("js/config.js", encoding="utf-8").read()

# The database side of the contract. Keep in step with the migrations.
EXPECTED = {
    "RECV_STATUSES": {"pending", "ordered", "received", "partial", "out_of_stock", "cancelled"},
    "QC_RESULTS": {"ok_fabric", "damaged_fabric", "insufficient_fabric", "wrong_fabric"},
    # preparation_events' CHECK still permits the four dropped stages plus four older legacy values;
    # the app must write ONLY these three. 'cutting' is LABELLED "Started" and keeps its value.
    "PREP_STAGES": {"cutting", "folding_packing", "stacking"},
    # line_review_mark.status. Unread is deliberately absent - it is the ABSENCE of a mark.
    "LINE_REVIEW_STATUSES": {"read", "follow_up_production", "follow_up_installation",
                             "follow_up_procurement", "ask_coordinators", "installed"},
    # derived in v_ops_line_review, and filtered on with an overlap - a value that drifts out of
    # step with the view returns nothing rather than erroring
    "PROCUREMENT_REQS": {"roman_production", "pelmet", "eyelet"},
    "DISPATCH_CONTRACTORS": {"farooq", "jamal", "shahzad", "other"},
    "DISPATCH_SUBSTATES": {"planned", "sent", "received_back", "qc_passed", "paid",
                           "qc_failed", "issue"},
    "CHARGE_TYPES": {"alteration", "pickup", "drop_off", "moving", "removal", "extra_track",
                     "scaffolding", "additional_visit", "tieback", "other"},
    "ADJ_STATUSES": {"new", "reviewed", "invoiced", "dropped"},
    # date_bucket is computed in v_ops_order_roster, not a CHECK - these must match that CASE
    "DATE_BUCKETS": {"overdue", "today", "tomorrow", "day_after", "this_week",
                     "later", "nodate", "done"},
    # likewise production_state, derived in the same view
    "PRODUCTION_STATES": {"awaiting_fabric", "ordered", "fabric_in", "in_production",
                          "packed", "qc_failed", "cancelled"},
    # also derived in v_ops_order_roster, and filtered on by equality - a value that drifts out of
    # step with the view's CASE silently returns nothing rather than erroring
    "FABRIC_RECV_STATES": {"not_received", "partial", "received"},
    # DISPATCH_SUBSTATES plus not_sent, which is the absence of any order_dispatch row
    "DISPATCH_STATES": {"not_sent", "planned", "sent", "received_back",
                        "qc_passed", "paid", "qc_failed", "issue"},
    "TRANSFER_STATUSES": {"in_progress", "ready", "returned", "partially_returned",
                          "extra_materials", "cancelled", "issue"},
    # handover.kind and handover.status, both CHECK-constrained. 'acknowledged' is the one that
    # matters: fn_ops_ack_handover posts the inventory ledger on exactly that string.
    "HANDOVER_KINDS": {"order", "inventory"},
    "HANDOVER_STATUSES": {"handed_over", "acknowledged", "disputed"},
    "MOVE_REASONS": {"purchase", "consumption", "adjustment", "return",
                     "transfer_out", "transfer_in"},
    "LOCATION_KINDS": {"warehouse", "rack", "shelf", "van", "site", "contractor", "office", "other"},
    "PHOTO_CONTEXTS": {"receiving", "prep", "dispatch", "order_status", "visit", "adjustment",
                       "transfer", "inventory", "other"},
}

# The first two are pre-states; the rest are outcomes. Order matters here because the UI renders
# the list in this sequence.
ORDER_STATUSES = [
    "Scheduled", "Out for installation",
    "Successfully completed", "Production issue", "Consultation issue", "Rescheduled",
    "Partially completed", "Client change of mind", "Installation issue", "Others",
]

problems = []


def block(name):
    m = re.search(r"export const " + name + r"\s*=\s*\[", src)
    if not m:
        problems.append(f"{name} not found in config.js")
        return ""
    s = m.end()
    depth, i = 1, s
    while depth > 0:
        if src[i] == "[":
            depth += 1
        elif src[i] == "]":
            depth -= 1
        i += 1
    return src[s:i - 1]


for name, expected in EXPECTED.items():
    body = block(name)
    found = set(re.findall(r'value:\s*"([^"]+)"', body))
    if found != expected:
        missing = expected - found
        extra = found - expected
        if missing:
            problems.append(f"{name} is missing canonical value(s): {sorted(missing)}")
        if extra:
            problems.append(f"{name} has value(s) the database will reject: {sorted(extra)}")
    # a value containing a non-ASCII character means someone translated it
    for v in found:
        if not v.isascii():
            problems.append(f"{name} value {v!r} is not ASCII - values must never be translated")

body = block("ORDER_STATUSES")
found = re.findall(r'"([^"]+)"', body)
if found != ORDER_STATUSES:
    problems.append(f"ORDER_STATUSES drifted from the CHECK constraint.\n"
                    f"      expected: {ORDER_STATUSES}\n      found:    {found}")

print(f"checked {len(EXPECTED) + 1} vocabularies against the database constraints")
print()
if problems:
    print("PROBLEMS:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("OK - every value the app writes matches its CHECK constraint")
