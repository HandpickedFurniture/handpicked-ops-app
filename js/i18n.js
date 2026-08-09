/* Trilingual labels - English / Hindi / Bengali.
 *
 * CARDINAL RULE, carried over from pfc-order-app: TRANSLATE THE LABEL, KEEP THE VALUE ENGLISH.
 * Anything that reaches the database (stage names, statuses, charge types) stays canonical in
 * config.js and is looked up here only for display. Translate a value and its CHECK constraint
 * rejects the write.
 *
 * check_i18n.py enforces that every key exists in all three languages.
 */
import { STORAGE_PREFIX } from "./config.js";

export const LANGS = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी" },
  { code: "bn", label: "বাংলা" },
];

const LANG_KEY = STORAGE_PREFIX + "lang";
let LANG = localStorage.getItem(LANG_KEY) || "en";

export function getLang() { return LANG; }
export function setLang(l) { LANG = l; localStorage.setItem(LANG_KEY, l); }

/* Speech recognition locales. Indian variants, because the coordinators code-switch. */
export const SPEECH_LOCALE = { en: "en-IN", hi: "hi-IN", bn: "bn-IN" };

export const I18N = {
  en: {
    "app.title": "Operations",
    "nav.production": "Production", "nav.status": "Installation", "nav.dashboard": "Dashboard",
    "nav.eod": "End of day",

    "auth.title": "Sign in", "auth.email": "Email", "auth.password": "Password",
    "auth.signin": "Sign in", "auth.signout": "Sign out",
    "auth.hint": "Accounts are created by your administrator.",
    "auth.failed": "Sign in failed. Check your email and password.",
    "auth.required": "Please sign in to continue.",

    "f.title": "Filters", "f.clear": "Clear", "f.apply": "Apply", "f.orderId": "Order ID",
    "f.dateFrom": "Install date from", "f.dateTo": "Install date to",
    "f.sheetStatus": "Installation status (3D sheet)", "f.city": "City",
    "f.customer": "Customer name", "f.stitching": "Curtain stitching type",
    "f.commercial": "Commercial name", "f.windowRef": "Window ref",
    "f.comment": "Optional comment", "f.fabric1": "Fabric 1", "f.fabric2": "Fabric 2",
    "f.any": "Any", "f.unknownCity": "Unknown city", "f.summary": "{n} filters · {m} orders",
    "f.none": "No filters · {m} orders", "f.search": "Search text",

    "col.order": "Order", "col.customer": "Customer", "col.city": "City",
    "col.install": "Install date", "col.version": "PO v", "col.windows": "Windows",
    "col.fabrics": "Fabrics", "col.special": "Special requirements",
    "col.receiving": "Receiving", "col.prep": "Production", "col.dispatch": "Dispatch",
    "col.status": "Status", "col.team": "Team", "col.visits": "Visits",
    "col.adjustments": "Adjustments", "col.billable": "Billable",

    "recv.pending": "Pending", "recv.ordered": "Ordered", "recv.received": "Received",
    "recv.partial": "Partial", "recv.oos": "Out of stock", "recv.cancelled": "Cancelled",
    "qc.ok": "Ok fabric", "qc.damaged": "Damaged fabric",
    "qc.insufficient": "Insufficient fabric", "qc.wrong": "Wrong fabric",
    "qc.title": "Fabric quality check",

    "prep.cutting": "Cutting", "prep.hemming": "Hemming", "prep.ironing": "Ironing",
    "prep.marking": "Marking & measurement", "prep.taping": "Taping",
    "prep.packed": "Completed – folded & packed",

    "disp.farooq": "Farooq", "disp.jamal": "Jamal", "disp.shahzad": "Shahzad",
    "disp.other": "Other", "disp.planned": "Planned", "disp.sent": "Sent",
    "disp.back": "Received back", "disp.otherName": "Name", "disp.items": "Items",
    "disp.title": "Sent out for stitching",
    "disp.qcPass": "Quality check success", "disp.qcFail": "Quality check failed",
    "disp.qcFailWhat": "What failed the quality check?",
    "disp.qcFailRequired": "Say what failed — a red flag with no reason helps nobody.",
    "disp.packedAuto": "Production marked completed – folded & packed",
    "disp.qcPartial": "Marked, but other contractors on this order have not passed yet",

    "chg.visit": "Additional visit", "chg.alteration": "Curtain alteration",
    "chg.removal": "Remove existing curtains", "chg.pickup": "Pickup and drop-off",
    "chg.dropoff": "Drop-off", "chg.scaffolding": "Scaffolding rental",
    "chg.tieback": "Tie backs (post installation)", "chg.track": "Extra trunking",
    "chg.moving": "Furniture moving", "chg.other": "Other chargeable work",

    "adj.new": "To review", "adj.reviewed": "Agreed", "adj.invoiced": "Invoiced",
    "adj.dropped": "Not charged", "adj.title": "Extra work beyond the PO",
    "adj.add": "Add extra work", "adj.type": "Charge type", "adj.qty": "Quantity",
    "adj.amount": "Amount (AED)", "adj.reason": "Reason (required)",
    "adj.chargeable": "Charge the client", "adj.auto": "auto", "adj.suggested": "Rate card",
    "adj.drift": "Rate card says AED {n}", "adj.total": "Extra beyond PO",
    "adj.reasonRequired": "A reason is required - it is printed on the invoice.",
    "adj.confirm": "Confirm", "adj.drop": "Do not charge",
    "adj.buildInvoice": "Build draft invoice",
    "adj.buildInvoiceHint":
      "Creates a draft invoice from the PO lines plus every agreed extra. Re-running rebuilds it in place.",

    "bucket.overdue": "Overdue", "bucket.today": "Today", "bucket.week": "This week",
    "bucket.later": "Later", "bucket.nodate": "No date", "bucket.done": "Done",

    "sp.roman": "Roman blinds", "sp.roller": "Roller blinds", "sp.zebra": "Zebra blinds",
    "sp.wooden": "Wooden blinds", "sp.venetian": "Venetian blinds", "sp.pelmet": "Pelmet boxes",
    "sp.motor": "Motors", "sp.bend": "Bend rails", "sp.scaffolding": "Scaffolding",
    "sp.pullcord": "Pull cord track", "sp.eyelet": "Eyelet", "sp.baton": "Baton sticks",
    "sp.tiebackhook": "Tie backs – hooks", "sp.tiebackvelcro": "Tie backs – velcro",
    "sp.cassette": "Cassette", "sp.trunking": "Trunking", "sp.velcro": "Velcro stitching",
    "sp.pickup": "Pickup", "sp.alteration": "Alteration", "sp.removal": "Removal",

    "d.installAlerts": "Installation alerts", "d.procureAlerts": "Procurement alerts",
    "d.prodAlerts": "Production alerts", "d.acctAlerts": "Chargeable extras",
    "d.comments": "Optional comments", "d.interpreted": "Interpreted comments",
    "d.emails": "Emails & PO history", "d.opsComments": "Coordinator comments",
    "d.none": "Nothing recorded", "d.open": "Details", "d.close": "Close",

    "act.receiveAll": "Mark all fabrics received", "act.applyAll": "Apply to all",
    "act.selected": "{n} selected", "act.comment": "Add comment", "act.save": "Save",
    "act.cancel": "Cancel", "act.speak": "Speak", "act.listening": "Listening…",
    "act.retry": "Retry", "act.markStage": "Mark stage",

    "st.ready": "Ready", "st.teamAssigned": "Team assigned", "st.assignTeam": "Assign team",
    "st.visit": "Visit {n}", "st.addVisit": "Add visit", "st.visitDate": "Visit date",
    "st.visitTime": "Time", "st.visitStatus": "Visit outcome", "st.internal": "Internal comment",
    "st.slack": "Slack comment", "st.orderStatus": "Order status",
    "st.maxVisits": "Visit 10 is the maximum.",
    "st.slackHint": "Saved now, posted to Slack once that connection is switched on.",

    "dash.title": "Management dashboard", "dash.eod": "End of day report",
    "dash.overall": "Overall", "dash.team": "Team {n}", "dash.unassigned": "Unassigned",
    "dash.visited": "Orders visited", "dash.first": "First visits", "dash.revisits": "Revisits",
    "dash.completed": "Completed", "dash.issues": "Issues", "dash.adjAed": "Extra charges",
    "dash.successPct": "First-visit success", "dash.copy": "Copy for WhatsApp",
    "dash.csv": "Download CSV", "dash.copied": "Copied.", "dash.noData": "Nothing logged for this date.",
    "dash.billable": "Total billable", "dash.poValue": "PO value",

    "t.loading": "Loading…", "t.saved": "Saved", "t.queued": "Saved – will sync when back online",
    "t.error": "{m}", "t.offline": "{n} waiting to sync", "t.failed": "{n} failed to save",
    "t.empty": "No orders match these filters.",
    "t.emptyUnfiltered": "No data came back. Your session may have expired – sign in again.",
    "t.stale": "3D sheet last synced {d}", "t.staleWarn": "3D sheet data is over a day old",
    "t.cityUnknown": "City not recorded", "t.citySheet": "City from 3D sheet",
    "t.drift": "PO says {a} m, expected {b} m", "t.staleRow": "Not in the current PO",
    "t.big": "Large text",

    "nav.transfer": "Transfers", "nav.inventory": "Inventory", "nav.audit": "Photo audit",

    "photo.add": "Photo", "photo.count": "{n} photo(s)", "photo.uploading": "Uploading {n}…",
    "photo.saved": "{n} photo(s) saved", "photo.open": "Open full size",
    "photo.noLocation": "No location", "photo.addLocation": "+ New location…",
    "photo.title": "Photos", "photo.none": "No photos yet",
    "photo.delete": "Remove photo", "photo.deleteReason": "Why is this being removed?",
    "photo.deleted": "Removed", "photo.deletedBy": "Removed by {who}",
    "photo.backend": "Stored in", "photo.hash": "Checksum", "photo.views": "{n} view(s)",
    "photo.showDeleted": "Include removed photos", "photo.context": "Attached to",
    "photo.uploader": "Uploaded by", "photo.evidenceNote":
      "Photos are optional and never block a status change.",

    "loc.title": "Location", "loc.code": "Code", "loc.label": "Name", "loc.kind": "Type",
    "loc.warehouse": "Warehouse", "loc.rack": "Rack", "loc.shelf": "Shelf", "loc.van": "Van",
    "loc.site": "Site", "loc.contractor": "Contractor", "loc.office": "Office", "loc.other": "Other",
    "loc.created": "Location added",

    "tr.title": "Transfer of materials", "tr.inprogress": "In progress", "tr.ready": "Ready",
    "tr.returned": "Returned", "tr.partial": "Partially returned", "tr.cancelled": "Cancelled",
    "tr.issue": "Issue", "tr.issueNote": "What is the issue?",
    "tr.issueRequired": "Describe the issue — the status is meaningless without it.",
    "tr.lines": "Items", "tr.addLine": "Add item", "tr.desc": "Description",
    "tr.qtyOut": "Sent out", "tr.qtyBack": "Returned", "tr.outstanding": "Outstanding",
    "tr.post": "Post to inventory", "tr.posted": "Posted to inventory",
    "tr.no": "Transfer {n}", "tr.newTransfer": "New transfer",
    "tr.linkItem": "Inventory item", "tr.noItem": "Not stock-tracked",
    "tr.autoStatus": "Status set from what came back",

    "inv.title": "Inventory", "inv.item": "Item", "inv.code": "Item code", "inv.onHand": "On hand",
    "inv.reorder": "Reorder level", "inv.needsReorder": "Reorder", "inv.move": "Record movement",
    "inv.qty": "Quantity (+ in, − out)", "inv.reason": "Reason", "inv.ledger": "Movement history",
    "inv.purchase": "Purchase", "inv.consumption": "Consumption", "inv.adjustment": "Adjustment",
    "inv.return": "Return", "inv.transferOut": "Transfer out", "inv.transferIn": "Transfer in",
    "inv.addItem": "Add item", "inv.name": "Name", "inv.category": "Category",
    "inv.balance": "Balance", "inv.noItems": "No inventory items yet",
    "inv.linked": "Inventory", "inv.viewStock": "View stock",

    "st.alteration": "Alteration", "st.alterationNote": "Alteration detail",
    "st.removalCount": "Curtains removed",

    "audit.title": "Photo audit", "audit.filters": "Filters", "audit.from": "From", "audit.to": "To",
    "audit.total": "{n} photo(s)", "audit.export": "Download index (CSV)",
    "audit.noPhotos": "No photos match these filters.",

    "bucket.tomorrow": "Tomorrow", "bucket.dayAfter": "Day after",

    "ps.awaiting": "Awaiting fabric", "ps.ordered": "Fabric ordered", "ps.fabricIn": "Fabric in",
    "ps.inProd": "In production", "ps.packed": "Packed", "ps.cancelled": "Cancelled",
    "ps.qcFailed": "Quality check failed",

    "tr.extra": "Extra materials", "tr.toLocation": "To location",

    "col.owlTotal": "OWL total", "col.owlCurtains": "OWL curtains", "col.owlBlinds": "OWL blinds",
    "col.meters": "Fabric (m)", "col.alteration": "Alteration",
    "col.optComments": "Optional comments", "col.installNotes": "Installation notes",
    "col.production": "Production",
    "t.metersNote": "From the PO fabric total",

    "f.alteration": "Alteration", "f.alterationYes": "Has alteration",
    "f.alterationNo": "No alteration",

    "st.members": "Team members", "st.member": "Member {n}", "st.addMember": "+ Add name",
    "st.memberNone": "—", "st.newMember": "New name…", "st.memberAdded": "Name added",

    "inv.packs": "Packs", "inv.packName": "Pack name", "inv.packQty": "Units per pack",
    "inv.addPack": "Add pack", "inv.packCount": "How many packs",
    "inv.receivePacks": "Receive in packs", "inv.noPacks": "No packs defined",
    "inv.packLimit": "An item can have at most 10 pack types.",
    "inv.override": "Set counted quantity", "inv.overrideHint":
      "The difference is recorded as an adjustment, so the correction stays in the history.",
    "inv.counted": "Counted quantity", "inv.was": "Was {n}, now {m} ({d})",
    "inv.noChange": "Already correct — nothing recorded.",
    "inv.packsTotal": "{n} packs × {q} = {t}",

    "dash.byProduction": "By production status", "dash.byInstall": "By installation status",
    "dash.noChart": "Nothing to chart yet.",
  },

  hi: {
    "app.title": "ऑपरेशंस",
    "nav.production": "उत्पादन", "nav.status": "इंस्टॉलेशन", "nav.dashboard": "डैशबोर्ड",
    "nav.eod": "दिन का अंत",

    "auth.title": "साइन इन करें", "auth.email": "ईमेल", "auth.password": "पासवर्ड",
    "auth.signin": "साइन इन", "auth.signout": "साइन आउट",
    "auth.hint": "खाते आपके व्यवस्थापक द्वारा बनाए जाते हैं।",
    "auth.failed": "साइन इन विफल। ईमेल और पासवर्ड जाँचें।",
    "auth.required": "जारी रखने के लिए साइन इन करें।",

    "f.title": "फ़िल्टर", "f.clear": "साफ़ करें", "f.apply": "लागू करें", "f.orderId": "ऑर्डर आईडी",
    "f.dateFrom": "इंस्टॉल तिथि से", "f.dateTo": "इंस्टॉल तिथि तक",
    "f.sheetStatus": "इंस्टॉलेशन स्थिति (3D शीट)", "f.city": "शहर",
    "f.customer": "ग्राहक का नाम", "f.stitching": "पर्दा सिलाई प्रकार",
    "f.commercial": "व्यावसायिक नाम", "f.windowRef": "खिड़की संदर्भ",
    "f.comment": "वैकल्पिक टिप्पणी", "f.fabric1": "कपड़ा 1", "f.fabric2": "कपड़ा 2",
    "f.any": "कोई भी", "f.unknownCity": "अज्ञात शहर", "f.summary": "{n} फ़िल्टर · {m} ऑर्डर",
    "f.none": "कोई फ़िल्टर नहीं · {m} ऑर्डर", "f.search": "टेक्स्ट खोजें",

    "col.order": "ऑर्डर", "col.customer": "ग्राहक", "col.city": "शहर",
    "col.install": "इंस्टॉल तिथि", "col.version": "PO सं.", "col.windows": "खिड़कियाँ",
    "col.fabrics": "कपड़े", "col.special": "विशेष आवश्यकताएँ",
    "col.receiving": "प्राप्ति", "col.prep": "उत्पादन", "col.dispatch": "भेजा गया",
    "col.status": "स्थिति", "col.team": "टीम", "col.visits": "विज़िट",
    "col.adjustments": "अतिरिक्त शुल्क", "col.billable": "बिल योग्य",

    "recv.pending": "लंबित", "recv.ordered": "ऑर्डर किया", "recv.received": "प्राप्त",
    "recv.partial": "आंशिक", "recv.oos": "स्टॉक में नहीं", "recv.cancelled": "रद्द",
    "qc.ok": "कपड़ा ठीक", "qc.damaged": "क्षतिग्रस्त कपड़ा",
    "qc.insufficient": "अपर्याप्त कपड़ा", "qc.wrong": "गलत कपड़ा",
    "qc.title": "कपड़ा गुणवत्ता जाँच",

    "prep.cutting": "कटाई", "prep.hemming": "हेमिंग", "prep.ironing": "इस्त्री",
    "prep.marking": "मार्किंग और माप", "prep.taping": "टेपिंग",
    "prep.packed": "पूर्ण – मोड़ा और पैक",

    "disp.farooq": "फ़ारूक़", "disp.jamal": "जमाल", "disp.shahzad": "शहज़ाद",
    "disp.other": "अन्य", "disp.planned": "योजित", "disp.sent": "भेजा",
    "disp.back": "वापस मिला", "disp.otherName": "नाम", "disp.items": "आइटम",
    "disp.title": "सिलाई के लिए भेजा",
    "disp.qcPass": "गुणवत्ता जाँच सफल", "disp.qcFail": "गुणवत्ता जाँच विफल",
    "disp.qcFailWhat": "गुणवत्ता जाँच में क्या विफल हुआ?",
    "disp.qcFailRequired": "कारण बताएं — बिना कारण लाल निशान बेकार है।",
    "disp.packedAuto": "उत्पादन पूर्ण – मोड़ा और पैक चिह्नित",
    "disp.qcPartial": "चिह्नित, पर इस ऑर्डर के अन्य ठेकेदार अभी पास नहीं हुए",

    "chg.visit": "अतिरिक्त विज़िट", "chg.alteration": "पर्दा अल्टरेशन",
    "chg.removal": "पुराने पर्दे हटाना", "chg.pickup": "पिकअप और ड्रॉप-ऑफ",
    "chg.dropoff": "ड्रॉप-ऑफ", "chg.scaffolding": "मचान किराया",
    "chg.tieback": "टाई बैक (इंस्टॉलेशन के बाद)", "chg.track": "अतिरिक्त ट्रंकिंग",
    "chg.moving": "फर्नीचर हटाना", "chg.other": "अन्य शुल्क योग्य कार्य",

    "adj.new": "समीक्षा हेतु", "adj.reviewed": "सहमत", "adj.invoiced": "बिल बना",
    "adj.dropped": "शुल्क नहीं", "adj.title": "PO से अतिरिक्त कार्य",
    "adj.add": "अतिरिक्त कार्य जोड़ें", "adj.type": "शुल्क प्रकार", "adj.qty": "मात्रा",
    "adj.amount": "राशि (AED)", "adj.reason": "कारण (आवश्यक)",
    "adj.chargeable": "ग्राहक से शुल्क लें", "adj.auto": "स्वतः", "adj.suggested": "दर सूची",
    "adj.drift": "दर सूची कहती है AED {n}", "adj.total": "PO से अतिरिक्त",
    "adj.reasonRequired": "कारण आवश्यक है – यह बिल पर छपता है।",
    "adj.confirm": "पुष्टि करें", "adj.drop": "शुल्क न लें",
    "adj.buildInvoice": "ड्राफ़्ट बिल बनाएँ",
    "adj.buildInvoiceHint":
      "PO लाइनों और सभी सहमत अतिरिक्त कार्यों से ड्राफ़्ट बिल बनाता है। दोबारा चलाने पर वही बिल फिर से बनता है।",

    "bucket.overdue": "विलंबित", "bucket.today": "आज", "bucket.week": "इस सप्ताह",
    "bucket.later": "बाद में", "bucket.nodate": "तिथि नहीं", "bucket.done": "पूर्ण",

    "sp.roman": "रोमन ब्लाइंड", "sp.roller": "रोलर ब्लाइंड", "sp.zebra": "ज़ेबरा ब्लाइंड",
    "sp.wooden": "लकड़ी ब्लाइंड", "sp.venetian": "वेनिशियन ब्लाइंड", "sp.pelmet": "पेल्मेट बॉक्स",
    "sp.motor": "मोटर", "sp.bend": "बेंड रेल", "sp.scaffolding": "मचान",
    "sp.pullcord": "पुल कॉर्ड ट्रैक", "sp.eyelet": "आईलेट", "sp.baton": "बैटन स्टिक",
    "sp.tiebackhook": "टाई बैक – हुक", "sp.tiebackvelcro": "टाई बैक – वेल्क्रो",
    "sp.cassette": "कैसेट", "sp.trunking": "ट्रंकिंग", "sp.velcro": "वेल्क्रो सिलाई",
    "sp.pickup": "पिकअप", "sp.alteration": "अल्टरेशन", "sp.removal": "हटाना",

    "d.installAlerts": "इंस्टॉलेशन अलर्ट", "d.procureAlerts": "खरीद अलर्ट",
    "d.prodAlerts": "उत्पादन अलर्ट", "d.acctAlerts": "शुल्क योग्य अतिरिक्त",
    "d.comments": "वैकल्पिक टिप्पणियाँ", "d.interpreted": "व्याख्या की गई टिप्पणियाँ",
    "d.emails": "ईमेल और PO इतिहास", "d.opsComments": "समन्वयक टिप्पणियाँ",
    "d.none": "कुछ दर्ज नहीं", "d.open": "विवरण", "d.close": "बंद करें",

    "act.receiveAll": "सभी कपड़े प्राप्त चिह्नित करें", "act.applyAll": "सभी पर लागू करें",
    "act.selected": "{n} चयनित", "act.comment": "टिप्पणी जोड़ें", "act.save": "सहेजें",
    "act.cancel": "रद्द करें", "act.speak": "बोलें", "act.listening": "सुन रहे हैं…",
    "act.retry": "पुनः प्रयास", "act.markStage": "चरण चिह्नित करें",

    "st.ready": "तैयार", "st.teamAssigned": "टीम नियुक्त", "st.assignTeam": "टीम नियुक्त करें",
    "st.visit": "विज़िट {n}", "st.addVisit": "विज़िट जोड़ें", "st.visitDate": "विज़िट तिथि",
    "st.visitTime": "समय", "st.visitStatus": "विज़िट परिणाम", "st.internal": "आंतरिक टिप्पणी",
    "st.slack": "Slack टिप्पणी", "st.orderStatus": "ऑर्डर स्थिति",
    "st.maxVisits": "अधिकतम 10 विज़िट।",
    "st.slackHint": "अभी सहेजा गया, Slack कनेक्शन चालू होने पर भेजा जाएगा।",

    "dash.title": "प्रबंधन डैशबोर्ड", "dash.eod": "दिन के अंत की रिपोर्ट",
    "dash.overall": "कुल", "dash.team": "टीम {n}", "dash.unassigned": "अनियुक्त",
    "dash.visited": "विज़िट किए ऑर्डर", "dash.first": "पहली विज़िट", "dash.revisits": "पुनः विज़िट",
    "dash.completed": "पूर्ण", "dash.issues": "समस्याएँ", "dash.adjAed": "अतिरिक्त शुल्क",
    "dash.successPct": "पहली विज़िट सफलता", "dash.copy": "WhatsApp के लिए कॉपी करें",
    "dash.csv": "CSV डाउनलोड करें", "dash.copied": "कॉपी हो गया।",
    "dash.noData": "इस तिथि के लिए कुछ दर्ज नहीं।",
    "dash.billable": "कुल बिल योग्य", "dash.poValue": "PO मूल्य",

    "t.loading": "लोड हो रहा है…", "t.saved": "सहेजा गया",
    "t.queued": "सहेजा गया – ऑनलाइन होने पर सिंक होगा",
    "t.error": "{m}", "t.offline": "{n} सिंक होना बाकी", "t.failed": "{n} सहेजने में विफल",
    "t.empty": "इन फ़िल्टर से कोई ऑर्डर नहीं मिला।",
    "t.emptyUnfiltered": "कोई डेटा नहीं आया। सत्र समाप्त हो सकता है – फिर से साइन इन करें।",
    "t.stale": "3D शीट अंतिम सिंक {d}", "t.staleWarn": "3D शीट डेटा एक दिन से पुराना है",
    "t.cityUnknown": "शहर दर्ज नहीं", "t.citySheet": "शहर 3D शीट से",
    "t.drift": "PO में {a} मी, अपेक्षित {b} मी", "t.staleRow": "वर्तमान PO में नहीं",
    "t.big": "बड़ा टेक्स्ट",

    "nav.transfer": "ट्रांसफ़र", "nav.inventory": "इन्वेंटरी", "nav.audit": "फ़ोटो ऑडिट",

    "photo.add": "फ़ोटो", "photo.count": "{n} फ़ोटो", "photo.uploading": "{n} अपलोड हो रही…",
    "photo.saved": "{n} फ़ोटो सहेजी गईं", "photo.open": "पूरा आकार खोलें",
    "photo.noLocation": "कोई स्थान नहीं", "photo.addLocation": "+ नया स्थान…",
    "photo.title": "फ़ोटो", "photo.none": "अभी कोई फ़ोटो नहीं",
    "photo.delete": "फ़ोटो हटाएँ", "photo.deleteReason": "इसे क्यों हटाया जा रहा है?",
    "photo.deleted": "हटाई गई", "photo.deletedBy": "{who} ने हटाई",
    "photo.backend": "संग्रहित", "photo.hash": "चेकसम", "photo.views": "{n} बार देखी",
    "photo.showDeleted": "हटाई गई फ़ोटो भी दिखाएँ", "photo.context": "संलग्न",
    "photo.uploader": "अपलोड करने वाला",
    "photo.evidenceNote": "फ़ोटो वैकल्पिक हैं और स्थिति बदलने में बाधा नहीं डालतीं।",

    "loc.title": "स्थान", "loc.code": "कोड", "loc.label": "नाम", "loc.kind": "प्रकार",
    "loc.warehouse": "गोदाम", "loc.rack": "रैक", "loc.shelf": "शेल्फ़", "loc.van": "वैन",
    "loc.site": "साइट", "loc.contractor": "ठेकेदार", "loc.office": "ऑफ़िस", "loc.other": "अन्य",
    "loc.created": "स्थान जोड़ा गया",

    "tr.title": "सामग्री ट्रांसफ़र", "tr.inprogress": "प्रगति में", "tr.ready": "तैयार",
    "tr.returned": "वापस आया", "tr.partial": "आंशिक वापस", "tr.cancelled": "रद्द",
    "tr.issue": "समस्या", "tr.issueNote": "समस्या क्या है?",
    "tr.issueRequired": "समस्या बताएं — इसके बिना स्थिति निरर्थक है।",
    "tr.lines": "आइटम", "tr.addLine": "आइटम जोड़ें", "tr.desc": "विवरण",
    "tr.qtyOut": "भेजा गया", "tr.qtyBack": "वापस आया", "tr.outstanding": "बकाया",
    "tr.post": "इन्वेंटरी में पोस्ट करें", "tr.posted": "इन्वेंटरी में पोस्ट हुआ",
    "tr.no": "ट्रांसफ़र {n}", "tr.newTransfer": "नया ट्रांसफ़र",
    "tr.linkItem": "इन्वेंटरी आइटम", "tr.noItem": "स्टॉक में ट्रैक नहीं",
    "tr.autoStatus": "वापसी के आधार पर स्थिति तय",

    "inv.title": "इन्वेंटरी", "inv.item": "आइटम", "inv.code": "आइटम कोड", "inv.onHand": "उपलब्ध",
    "inv.reorder": "पुनःऑर्डर स्तर", "inv.needsReorder": "पुनःऑर्डर", "inv.move": "मूवमेंट दर्ज करें",
    "inv.qty": "मात्रा (+ आया, − गया)", "inv.reason": "कारण", "inv.ledger": "मूवमेंट इतिहास",
    "inv.purchase": "खरीद", "inv.consumption": "खपत", "inv.adjustment": "समायोजन",
    "inv.return": "वापसी", "inv.transferOut": "ट्रांसफ़र आउट", "inv.transferIn": "ट्रांसफ़र इन",
    "inv.addItem": "आइटम जोड़ें", "inv.name": "नाम", "inv.category": "श्रेणी",
    "inv.balance": "शेष", "inv.noItems": "अभी कोई इन्वेंटरी आइटम नहीं",
    "inv.linked": "इन्वेंटरी", "inv.viewStock": "स्टॉक देखें",

    "st.alteration": "अल्टरेशन", "st.alterationNote": "अल्टरेशन विवरण",
    "st.removalCount": "हटाए गए पर्दे",

    "audit.title": "फ़ोटो ऑडिट", "audit.filters": "फ़िल्टर", "audit.from": "से", "audit.to": "तक",
    "audit.total": "{n} फ़ोटो", "audit.export": "सूची डाउनलोड करें (CSV)",
    "audit.noPhotos": "इन फ़िल्टर से कोई फ़ोटो नहीं मिली।",

    "bucket.tomorrow": "कल", "bucket.dayAfter": "परसों",

    "ps.awaiting": "कपड़े का इंतज़ार", "ps.ordered": "कपड़ा ऑर्डर किया", "ps.fabricIn": "कपड़ा आ गया",
    "ps.inProd": "उत्पादन में", "ps.packed": "पैक हो गया", "ps.cancelled": "रद्द",
    "ps.qcFailed": "गुणवत्ता जाँच विफल",

    "tr.extra": "अतिरिक्त सामग्री", "tr.toLocation": "किस स्थान पर",

    "col.owlTotal": "OWL कुल", "col.owlCurtains": "OWL पर्दे", "col.owlBlinds": "OWL ब्लाइंड",
    "col.meters": "कपड़ा (मी)", "col.alteration": "अल्टरेशन",
    "col.optComments": "वैकल्पिक टिप्पणियाँ", "col.installNotes": "इंस्टॉलेशन नोट्स",
    "col.production": "उत्पादन",
    "t.metersNote": "PO कपड़ा कुल से",

    "f.alteration": "अल्टरेशन", "f.alterationYes": "अल्टरेशन है",
    "f.alterationNo": "अल्टरेशन नहीं",

    "st.members": "टीम सदस्य", "st.member": "सदस्य {n}", "st.addMember": "+ नाम जोड़ें",
    "st.memberNone": "—", "st.newMember": "नया नाम…", "st.memberAdded": "नाम जोड़ा गया",

    "inv.packs": "पैक", "inv.packName": "पैक का नाम", "inv.packQty": "प्रति पैक इकाई",
    "inv.addPack": "पैक जोड़ें", "inv.packCount": "कितने पैक",
    "inv.receivePacks": "पैक में प्राप्त करें", "inv.noPacks": "कोई पैक परिभाषित नहीं",
    "inv.packLimit": "एक आइटम में अधिकतम 10 पैक प्रकार।",
    "inv.override": "गिनी गई मात्रा सेट करें", "inv.overrideHint":
      "अंतर समायोजन के रूप में दर्ज होता है, ताकि सुधार इतिहास में बना रहे।",
    "inv.counted": "गिनी गई मात्रा", "inv.was": "पहले {n}, अब {m} ({d})",
    "inv.noChange": "पहले से सही — कुछ दर्ज नहीं हुआ।",
    "inv.packsTotal": "{n} पैक × {q} = {t}",

    "dash.byProduction": "उत्पादन स्थिति अनुसार", "dash.byInstall": "इंस्टॉलेशन स्थिति अनुसार",
    "dash.noChart": "अभी चार्ट के लिए कुछ नहीं।",
  },

  bn: {
    "app.title": "অপারেশনস",
    "nav.production": "উৎপাদন", "nav.status": "ইনস্টলেশন", "nav.dashboard": "ড্যাশবোর্ড",
    "nav.eod": "দিনের শেষ",

    "auth.title": "সাইন ইন করুন", "auth.email": "ইমেল", "auth.password": "পাসওয়ার্ড",
    "auth.signin": "সাইন ইন", "auth.signout": "সাইন আউট",
    "auth.hint": "অ্যাকাউন্ট আপনার প্রশাসক তৈরি করেন।",
    "auth.failed": "সাইন ইন ব্যর্থ। ইমেল ও পাসওয়ার্ড দেখুন।",
    "auth.required": "চালিয়ে যেতে সাইন ইন করুন।",

    "f.title": "ফিল্টার", "f.clear": "মুছুন", "f.apply": "প্রয়োগ করুন", "f.orderId": "অর্ডার আইডি",
    "f.dateFrom": "ইনস্টল তারিখ থেকে", "f.dateTo": "ইনস্টল তারিখ পর্যন্ত",
    "f.sheetStatus": "ইনস্টলেশন অবস্থা (3D শিট)", "f.city": "শহর",
    "f.customer": "গ্রাহকের নাম", "f.stitching": "পর্দা সেলাইয়ের ধরন",
    "f.commercial": "বাণিজ্যিক নাম", "f.windowRef": "জানালা রেফ",
    "f.comment": "ঐচ্ছিক মন্তব্য", "f.fabric1": "কাপড় ১", "f.fabric2": "কাপড় ২",
    "f.any": "যেকোনো", "f.unknownCity": "অজানা শহর", "f.summary": "{n} ফিল্টার · {m} অর্ডার",
    "f.none": "কোনো ফিল্টার নেই · {m} অর্ডার", "f.search": "টেক্সট খুঁজুন",

    "col.order": "অর্ডার", "col.customer": "গ্রাহক", "col.city": "শহর",
    "col.install": "ইনস্টল তারিখ", "col.version": "PO সং.", "col.windows": "জানালা",
    "col.fabrics": "কাপড়", "col.special": "বিশেষ প্রয়োজন",
    "col.receiving": "প্রাপ্তি", "col.prep": "উৎপাদন", "col.dispatch": "পাঠানো",
    "col.status": "অবস্থা", "col.team": "দল", "col.visits": "ভিজিট",
    "col.adjustments": "অতিরিক্ত চার্জ", "col.billable": "বিলযোগ্য",

    "recv.pending": "অপেক্ষমাণ", "recv.ordered": "অর্ডার করা", "recv.received": "প্রাপ্ত",
    "recv.partial": "আংশিক", "recv.oos": "স্টকে নেই", "recv.cancelled": "বাতিল",
    "qc.ok": "কাপড় ঠিক", "qc.damaged": "ক্ষতিগ্রস্ত কাপড়",
    "qc.insufficient": "অপর্যাপ্ত কাপড়", "qc.wrong": "ভুল কাপড়",
    "qc.title": "কাপড়ের মান পরীক্ষা",

    "prep.cutting": "কাটা", "prep.hemming": "হেমিং", "prep.ironing": "ইস্ত্রি",
    "prep.marking": "মার্কিং ও পরিমাপ", "prep.taping": "টেপিং",
    "prep.packed": "সম্পন্ন – ভাঁজ ও প্যাক",

    "disp.farooq": "ফারুক", "disp.jamal": "জামাল", "disp.shahzad": "শাহজাদ",
    "disp.other": "অন্য", "disp.planned": "পরিকল্পিত", "disp.sent": "পাঠানো",
    "disp.back": "ফেরত এসেছে", "disp.otherName": "নাম", "disp.items": "আইটেম",
    "disp.title": "সেলাইয়ের জন্য পাঠানো",
    "disp.qcPass": "মান পরীক্ষা সফল", "disp.qcFail": "মান পরীক্ষা ব্যর্থ",
    "disp.qcFailWhat": "মান পরীক্ষায় কী ব্যর্থ হয়েছে?",
    "disp.qcFailRequired": "কারণ লিখুন — কারণ ছাড়া লাল চিহ্ন অর্থহীন।",
    "disp.packedAuto": "উৎপাদন সম্পন্ন – ভাঁজ ও প্যাক চিহ্নিত",
    "disp.qcPartial": "চিহ্নিত, তবে এই অর্ডারের অন্য ঠিকাদাররা এখনো পাস করেনি",

    "chg.visit": "অতিরিক্ত ভিজিট", "chg.alteration": "পর্দা অল্টারেশন",
    "chg.removal": "পুরনো পর্দা সরানো", "chg.pickup": "পিকআপ ও ড্রপ-অফ",
    "chg.dropoff": "ড্রপ-অফ", "chg.scaffolding": "মাচা ভাড়া",
    "chg.tieback": "টাই ব্যাক (ইনস্টলেশনের পরে)", "chg.track": "অতিরিক্ত ট্রাঙ্কিং",
    "chg.moving": "আসবাব সরানো", "chg.other": "অন্য চার্জযোগ্য কাজ",

    "adj.new": "পর্যালোচনার জন্য", "adj.reviewed": "সম্মত", "adj.invoiced": "বিল হয়েছে",
    "adj.dropped": "চার্জ নয়", "adj.title": "PO-র বাইরে অতিরিক্ত কাজ",
    "adj.add": "অতিরিক্ত কাজ যোগ করুন", "adj.type": "চার্জের ধরন", "adj.qty": "পরিমাণ",
    "adj.amount": "পরিমাণ (AED)", "adj.reason": "কারণ (আবশ্যক)",
    "adj.chargeable": "গ্রাহককে চার্জ করুন", "adj.auto": "স্বয়ংক্রিয়", "adj.suggested": "রেট তালিকা",
    "adj.drift": "রেট তালিকা বলছে AED {n}", "adj.total": "PO-র বাইরে অতিরিক্ত",
    "adj.reasonRequired": "কারণ আবশ্যক – এটি বিলে ছাপা হয়।",
    "adj.confirm": "নিশ্চিত করুন", "adj.drop": "চার্জ করবেন না",
    "adj.buildInvoice": "খসড়া বিল তৈরি করুন",
    "adj.buildInvoiceHint":
      "PO লাইন ও সম্মত সব অতিরিক্ত কাজ থেকে খসড়া বিল তৈরি করে। আবার চালালে সেটিই পুনর্গঠিত হয়।",

    "bucket.overdue": "বিলম্বিত", "bucket.today": "আজ", "bucket.week": "এই সপ্তাহে",
    "bucket.later": "পরে", "bucket.nodate": "তারিখ নেই", "bucket.done": "সম্পন্ন",

    "sp.roman": "রোমান ব্লাইন্ড", "sp.roller": "রোলার ব্লাইন্ড", "sp.zebra": "জেব্রা ব্লাইন্ড",
    "sp.wooden": "কাঠের ব্লাইন্ড", "sp.venetian": "ভেনিশিয়ান ব্লাইন্ড", "sp.pelmet": "পেলমেট বক্স",
    "sp.motor": "মোটর", "sp.bend": "বেন্ড রেল", "sp.scaffolding": "মাচা",
    "sp.pullcord": "পুল কর্ড ট্র্যাক", "sp.eyelet": "আইলেট", "sp.baton": "ব্যাটন স্টিক",
    "sp.tiebackhook": "টাই ব্যাক – হুক", "sp.tiebackvelcro": "টাই ব্যাক – ভেলক্রো",
    "sp.cassette": "ক্যাসেট", "sp.trunking": "ট্রাঙ্কিং", "sp.velcro": "ভেলক্রো সেলাই",
    "sp.pickup": "পিকআপ", "sp.alteration": "অল্টারেশন", "sp.removal": "সরানো",

    "d.installAlerts": "ইনস্টলেশন সতর্কতা", "d.procureAlerts": "ক্রয় সতর্কতা",
    "d.prodAlerts": "উৎপাদন সতর্কতা", "d.acctAlerts": "চার্জযোগ্য অতিরিক্ত",
    "d.comments": "ঐচ্ছিক মন্তব্য", "d.interpreted": "ব্যাখ্যা করা মন্তব্য",
    "d.emails": "ইমেল ও PO ইতিহাস", "d.opsComments": "সমন্বয়কারীর মন্তব্য",
    "d.none": "কিছু রেকর্ড নেই", "d.open": "বিস্তারিত", "d.close": "বন্ধ করুন",

    "act.receiveAll": "সব কাপড় প্রাপ্ত চিহ্নিত করুন", "act.applyAll": "সবগুলিতে প্রয়োগ করুন",
    "act.selected": "{n} নির্বাচিত", "act.comment": "মন্তব্য যোগ করুন", "act.save": "সংরক্ষণ",
    "act.cancel": "বাতিল", "act.speak": "বলুন", "act.listening": "শুনছি…",
    "act.retry": "আবার চেষ্টা", "act.markStage": "ধাপ চিহ্নিত করুন",

    "st.ready": "প্রস্তুত", "st.teamAssigned": "দল নিযুক্ত", "st.assignTeam": "দল নিযুক্ত করুন",
    "st.visit": "ভিজিট {n}", "st.addVisit": "ভিজিট যোগ করুন", "st.visitDate": "ভিজিটের তারিখ",
    "st.visitTime": "সময়", "st.visitStatus": "ভিজিটের ফলাফল", "st.internal": "অভ্যন্তরীণ মন্তব্য",
    "st.slack": "Slack মন্তব্য", "st.orderStatus": "অর্ডার অবস্থা",
    "st.maxVisits": "সর্বাধিক ১০টি ভিজিট।",
    "st.slackHint": "এখন সংরক্ষিত, Slack সংযোগ চালু হলে পাঠানো হবে।",

    "dash.title": "ব্যবস্থাপনা ড্যাশবোর্ড", "dash.eod": "দিনের শেষের রিপোর্ট",
    "dash.overall": "সামগ্রিক", "dash.team": "দল {n}", "dash.unassigned": "অনিযুক্ত",
    "dash.visited": "ভিজিট করা অর্ডার", "dash.first": "প্রথম ভিজিট", "dash.revisits": "পুনঃভিজিট",
    "dash.completed": "সম্পন্ন", "dash.issues": "সমস্যা", "dash.adjAed": "অতিরিক্ত চার্জ",
    "dash.successPct": "প্রথম ভিজিটে সাফল্য", "dash.copy": "WhatsApp-এর জন্য কপি করুন",
    "dash.csv": "CSV ডাউনলোড", "dash.copied": "কপি হয়েছে।",
    "dash.noData": "এই তারিখে কিছু রেকর্ড নেই।",
    "dash.billable": "মোট বিলযোগ্য", "dash.poValue": "PO মূল্য",

    "t.loading": "লোড হচ্ছে…", "t.saved": "সংরক্ষিত",
    "t.queued": "সংরক্ষিত – অনলাইনে এলে সিঙ্ক হবে",
    "t.error": "{m}", "t.offline": "{n} সিঙ্ক বাকি", "t.failed": "{n} সংরক্ষণে ব্যর্থ",
    "t.empty": "এই ফিল্টারে কোনো অর্ডার নেই।",
    "t.emptyUnfiltered": "কোনো ডেটা আসেনি। সেশন শেষ হতে পারে – আবার সাইন ইন করুন।",
    "t.stale": "3D শিট সর্বশেষ সিঙ্ক {d}", "t.staleWarn": "3D শিটের ডেটা একদিনের বেশি পুরনো",
    "t.cityUnknown": "শহর রেকর্ড নেই", "t.citySheet": "শহর 3D শিট থেকে",
    "t.drift": "PO-তে {a} মি, প্রত্যাশিত {b} মি", "t.staleRow": "বর্তমান PO-তে নেই",
    "t.big": "বড় টেক্সট",

    "nav.transfer": "ট্রান্সফার", "nav.inventory": "ইনভেন্টরি", "nav.audit": "ছবি অডিট",

    "photo.add": "ছবি", "photo.count": "{n} ছবি", "photo.uploading": "{n} আপলোড হচ্ছে…",
    "photo.saved": "{n} ছবি সংরক্ষিত", "photo.open": "পূর্ণ আকারে খুলুন",
    "photo.noLocation": "কোনো অবস্থান নেই", "photo.addLocation": "+ নতুন অবস্থান…",
    "photo.title": "ছবি", "photo.none": "এখনো কোনো ছবি নেই",
    "photo.delete": "ছবি সরান", "photo.deleteReason": "কেন সরানো হচ্ছে?",
    "photo.deleted": "সরানো হয়েছে", "photo.deletedBy": "{who} সরিয়েছেন",
    "photo.backend": "সংরক্ষিত", "photo.hash": "চেকসাম", "photo.views": "{n} বার দেখা",
    "photo.showDeleted": "সরানো ছবিও দেখান", "photo.context": "সংযুক্ত",
    "photo.uploader": "আপলোডকারী",
    "photo.evidenceNote": "ছবি ঐচ্ছিক এবং অবস্থা পরিবর্তনে বাধা দেয় না।",

    "loc.title": "অবস্থান", "loc.code": "কোড", "loc.label": "নাম", "loc.kind": "ধরন",
    "loc.warehouse": "গুদাম", "loc.rack": "র‍্যাক", "loc.shelf": "তাক", "loc.van": "ভ্যান",
    "loc.site": "সাইট", "loc.contractor": "ঠিকাদার", "loc.office": "অফিস", "loc.other": "অন্য",
    "loc.created": "অবস্থান যোগ হয়েছে",

    "tr.title": "উপকরণ ট্রান্সফার", "tr.inprogress": "চলছে", "tr.ready": "প্রস্তুত",
    "tr.returned": "ফেরত এসেছে", "tr.partial": "আংশিক ফেরত", "tr.cancelled": "বাতিল",
    "tr.issue": "সমস্যা", "tr.issueNote": "সমস্যাটি কী?",
    "tr.issueRequired": "সমস্যাটি লিখুন — এটি ছাড়া অবস্থাটি অর্থহীন।",
    "tr.lines": "আইটেম", "tr.addLine": "আইটেম যোগ করুন", "tr.desc": "বিবরণ",
    "tr.qtyOut": "পাঠানো", "tr.qtyBack": "ফেরত", "tr.outstanding": "বকেয়া",
    "tr.post": "ইনভেন্টরিতে পোস্ট করুন", "tr.posted": "ইনভেন্টরিতে পোস্ট হয়েছে",
    "tr.no": "ট্রান্সফার {n}", "tr.newTransfer": "নতুন ট্রান্সফার",
    "tr.linkItem": "ইনভেন্টরি আইটেম", "tr.noItem": "স্টকে ট্র্যাক করা নেই",
    "tr.autoStatus": "ফেরতের ভিত্তিতে অবস্থা নির্ধারিত",

    "inv.title": "ইনভেন্টরি", "inv.item": "আইটেম", "inv.code": "আইটেম কোড", "inv.onHand": "মজুত",
    "inv.reorder": "পুনরায় অর্ডার স্তর", "inv.needsReorder": "পুনঃঅর্ডার", "inv.move": "মুভমেন্ট রেকর্ড",
    "inv.qty": "পরিমাণ (+ ঢুকল, − গেল)", "inv.reason": "কারণ", "inv.ledger": "মুভমেন্ট ইতিহাস",
    "inv.purchase": "ক্রয়", "inv.consumption": "ব্যবহার", "inv.adjustment": "সমন্বয়",
    "inv.return": "ফেরত", "inv.transferOut": "ট্রান্সফার আউট", "inv.transferIn": "ট্রান্সফার ইন",
    "inv.addItem": "আইটেম যোগ করুন", "inv.name": "নাম", "inv.category": "শ্রেণি",
    "inv.balance": "ব্যালেন্স", "inv.noItems": "এখনো কোনো ইনভেন্টরি আইটেম নেই",
    "inv.linked": "ইনভেন্টরি", "inv.viewStock": "স্টক দেখুন",

    "st.alteration": "অল্টারেশন", "st.alterationNote": "অল্টারেশন বিবরণ",
    "st.removalCount": "সরানো পর্দা",

    "audit.title": "ছবি অডিট", "audit.filters": "ফিল্টার", "audit.from": "থেকে", "audit.to": "পর্যন্ত",
    "audit.total": "{n} ছবি", "audit.export": "সূচি ডাউনলোড (CSV)",
    "audit.noPhotos": "এই ফিল্টারে কোনো ছবি নেই।",

    "bucket.tomorrow": "আগামীকাল", "bucket.dayAfter": "পরশু",

    "ps.awaiting": "কাপড়ের অপেক্ষায়", "ps.ordered": "কাপড় অর্ডার হয়েছে", "ps.fabricIn": "কাপড় এসেছে",
    "ps.inProd": "উৎপাদনে", "ps.packed": "প্যাক হয়েছে", "ps.cancelled": "বাতিল",
    "ps.qcFailed": "মান পরীক্ষা ব্যর্থ",

    "tr.extra": "অতিরিক্ত উপকরণ", "tr.toLocation": "কোন অবস্থানে",

    "col.owlTotal": "OWL মোট", "col.owlCurtains": "OWL পর্দা", "col.owlBlinds": "OWL ব্লাইন্ড",
    "col.meters": "কাপড় (মি)", "col.alteration": "অল্টারেশন",
    "col.optComments": "ঐচ্ছিক মন্তব্য", "col.installNotes": "ইনস্টলেশন নোট",
    "col.production": "উৎপাদন",
    "t.metersNote": "PO কাপড় মোট থেকে",

    "f.alteration": "অল্টারেশন", "f.alterationYes": "অল্টারেশন আছে",
    "f.alterationNo": "অল্টারেশন নেই",

    "st.members": "দলের সদস্য", "st.member": "সদস্য {n}", "st.addMember": "+ নাম যোগ করুন",
    "st.memberNone": "—", "st.newMember": "নতুন নাম…", "st.memberAdded": "নাম যোগ হয়েছে",

    "inv.packs": "প্যাক", "inv.packName": "প্যাকের নাম", "inv.packQty": "প্রতি প্যাকে একক",
    "inv.addPack": "প্যাক যোগ করুন", "inv.packCount": "কতগুলি প্যাক",
    "inv.receivePacks": "প্যাকে গ্রহণ করুন", "inv.noPacks": "কোনো প্যাক নির্ধারিত নেই",
    "inv.packLimit": "একটি আইটেমে সর্বাধিক ১০টি প্যাক ধরন।",
    "inv.override": "গণনা করা পরিমাণ সেট করুন", "inv.overrideHint":
      "পার্থক্যটি সমন্বয় হিসেবে রেকর্ড হয়, তাই সংশোধনটি ইতিহাসে থেকে যায়।",
    "inv.counted": "গণনা করা পরিমাণ", "inv.was": "আগে {n}, এখন {m} ({d})",
    "inv.noChange": "আগে থেকেই সঠিক — কিছু রেকর্ড হয়নি।",
    "inv.packsTotal": "{n} প্যাক × {q} = {t}",

    "dash.byProduction": "উৎপাদন অবস্থা অনুযায়ী", "dash.byInstall": "ইনস্টলেশন অবস্থা অনুযায়ী",
    "dash.noChart": "চার্ট করার মতো কিছু নেই।",
  },
};

/* tr(key, vars) - translated label with {placeholder} substitution. */
export function tr(key, vars) {
  const table = I18N[LANG] || I18N.en;
  let s = table[key];
  if (s === undefined) s = I18N.en[key];
  if (s === undefined) return key;
  if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
  return s;
}

/* tv(list, value) - label for a canonical VALUE from config.js. The value itself never changes. */
export function tv(list, value) {
  const hit = (list || []).find((x) => x.value === value);
  return hit ? tr(hit.key) : value || "";
}
