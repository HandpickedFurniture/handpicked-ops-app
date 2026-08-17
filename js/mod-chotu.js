/* Chotu - talk to the business.
 *
 * One big circle. Hold a curtain in one hand, tap it, say what happened, and either get an answer
 * read back or get a filled-in form to check and commit. It exists because the people who know
 * things first - the tailor who just unwrapped a roll, the driver who just took two motors - are the
 * people least able to stop and type.
 *
 * WHAT MAKES THE CAPTURED DATA TRUSTWORTHY, in the order the guards fire:
 *
 *   1. The model is handed the REAL rows (fn_chotu_context) and picks from them. It has no database
 *      access and cannot invent an order number or a fabric code.
 *   2. Anything it returns that was not in those rows is stripped server-side, in the chotu edge
 *      function, before it reaches this screen.
 *   3. NOTHING IS WRITTEN BY THE MODEL. What arrives here is a proposal. It is drawn as a form, the
 *      person reads it, and the COMMIT BUTTON is what calls the RPC - the same submit() every other
 *      screen uses, through the same offline queue, hitting the same replay-safe functions.
 *
 * So the worst a misheard sentence can do is put a wrong-looking card on screen, which somebody
 * declines. That is the whole design: speech is fast and unreliable, so speed is where the voice
 * goes and reliability is where the button goes.
 *
 * WHO SAID IT comes from the signed-in account, like every other write in this app. Chotu used to ask
 * for a name and keep it in localStorage, which was a question with a better answer already on file -
 * and a free-text one at that, so the same person could be "Kausar", "kausar" and "Kausar M" on
 * three different records. One account per person is the rule here; the account IS the name.
 */
import { api, rpc, submit, currentActor, queueDepth, isSignedIn, isViewer, getSession } from "./api.js";
import {
  SB_URL, SB_KEY, ORDER_STATUSES, DISPATCH_SUBSTATES, DISPATCH_CONTRACTORS, PREP_STAGES,
  STACK_FLOORS, STACK_RACKS, STACK_SHELVES, STACK_ZONES, CHARGE_TYPES,
} from "./config.js";
import { tr, getLang, SPEECH_LOCALE } from "./i18n.js";
import { $, esc, el, chip, num, aed, toast } from "./ui.js";
import { attachMic, speechAvailable } from "./voice.js";
import { photoStrip } from "./photos.js";

/* Conversation state. Module-level so switching tabs and coming back keeps the thread - a coordinator
 * who glanced at the roster mid-sentence should not have to start again. */
let HISTORY = [];
let ORDER = null;        // the order currently in scope, if one has been named
let PROPOSAL = null;     // the last capture awaiting a human decision

/* Who is talking: the signed-in account, never a typed name. The short form is for the screen and
 * for the model; the full one is what gets written, so a Chotu record is attributable exactly the
 * way a typed one is. */
const speaker = () => (currentActor() || "").split("@")[0];

/* Find the order number in what was said, before anything else happens.
 *
 * Every order id in this business is exactly five digits - all 712 of them, 42256 to 71161 - which
 * makes them findable in a sentence without asking the model. That matters because THE FACTS ARE
 * FETCHED BEFORE THE MODEL RUNS: miss the number on the first pass and Chotu is reasoning about an
 * order it was never shown, and correctly says it cannot find it.
 *
 * It used to rely on the model echoing the number back so the browser could ask again. That works
 * when the number is typed and is a coin toss when it is spoken, because "70 770", "70,770" and
 * "7 0 7 7 0" all come out of the transcriber and none of them is a five-digit token.
 *
 * The raw text is searched FIRST. Only if that finds nothing are digit runs joined, because joining
 * too eagerly turns "2 fabrics for 70770" into one six-digit run and loses the order entirely. */
function orderIn(text) {
  const exactly5 = (t) => (String(t).match(/\d{5,}/g) || []).find((n) => n.length === 5) || null;
  const raw = String(text || "");
  return exactly5(raw) || exactly5(raw.replace(/(\d)[\s,.–-]+(?=\d)/g, "$1"));
}

/* ------------------------------------------------------------------ speech out
 * The Web Speech synthesis API: on-device, free, no key, and it already has Hindi and Bengali voices
 * on the phones this runs on. Best-effort by design - if a device has no voice for the language it
 * simply stays quiet, and the answer is on screen anyway, which is why the answer is ALWAYS on
 * screen and never only spoken. */
function say(text) {
  if (!text || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();          // never let two answers talk over each other
    const u = new SpeechSynthesisUtterance(text);
    u.lang = SPEECH_LOCALE[getLang()] || "en-IN";
    const v = window.speechSynthesis.getVoices().find((x) => x.lang === u.lang)
           || window.speechSynthesis.getVoices().find((x) => x.lang.startsWith(u.lang.split("-")[0]));
    if (v) u.voice = v;
    u.rate = 1;
    window.speechSynthesis.speak(u);
  } catch (e) { /* the screen already has it */ }
}

/* ------------------------------------------------------------------ the brain */
async function ask(said) {
  const session = getSession();
  if (!session || !session.access_token) throw new Error(tr("auth.required"));
  const r = await fetch(SB_URL + "/functions/v1/chotu", {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: "Bearer " + session.access_token,   // verify_jwt = true on the function
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      said, order_id: ORDER, speaker: speaker(), lang: getLang(),
      history: HISTORY.slice(-6).map((h) => ({ who: h.who, text: h.text })),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Chotu is unavailable (${r.status})`);
  return j;
}

/* ------------------------------------------------------------------ screen */
export async function render(mount, state) {
  if (!isSignedIn()) return;

  mount.innerHTML = `
    <div class="chotu">
      <div class="chotuhead">
        <div>
          <b>${esc(tr("nav.chotu"))}</b>
          <div class="muted">${esc(tr("chotu.sub"))}</div>
        </div>
        <div class="row" style="gap:6px">
          <span id="chotuwho"></span>
          <span id="chotuorder"></span>
        </div>
      </div>

      <div class="chotulog" id="chotulog"></div>

      <div class="chotumid">
        <button class="chotucircle" id="chotubtn" aria-live="polite">
          <span class="chotuicon">🎙️</span>
          <span class="chotustate" id="chotustate">${esc(tr("chotu.tapToTalk"))}</span>
        </button>
        <!-- the mic implementation in voice.js dictates into a field and rewrites its own button's
             label; it drives this hidden pair so the circle above can keep its own markup -->
        <button id="chotumic" class="visually-hidden" tabindex="-1" aria-hidden="true"></button>
        <textarea id="chotusaid" class="visually-hidden" tabindex="-1" aria-hidden="true"></textarea>
      </div>

      <div class="chotutype">
        <input type="text" id="chotutext" placeholder="${esc(tr("chotu.orType"))}">
        <button class="btn primary" id="chotusend">${esc(tr("chotu.send"))}</button>
      </div>

      <div id="chotucard"></div>
    </div>`;

  paintWho(mount);
  paintOrder(mount);
  paintLog(mount);
  if (PROPOSAL) paintProposal(mount, PROPOSAL);

  const btn = $("#chotubtn", mount);
  const mic = $("#chotumic", mount);
  const said = $("#chotusaid", mount);
  const stateLbl = $("#chotustate", mount);

  if (!speechAvailable()) {
    btn.disabled = true;
    stateLbl.textContent = tr("chotu.noMic");
  } else {
    /* voice.js owns both paths - the on-device Web Speech API on Android and desktop Chrome, and
     * record-then-transcribe through the Gemini edge function on iPhone, which has no speech API at
     * all. Feature-detected in there; this screen only mirrors the state it reports. */
    attachMic(mic, said, (text) => {
      const t = (text || "").trim();
      said.value = "";                 // each tap is one utterance, not a growing transcript
      if (t) turn(mount, t);
    });

    btn.addEventListener("click", () => { said.value = ""; mic.click(); });

    // the hidden button's label IS voice.js's state machine: 🎤 idle, ■ listening, … transcribing
    new MutationObserver(() => {
      const s = mic.textContent;
      btn.classList.toggle("on", s === "■");
      btn.classList.toggle("busy", s === "…");
      stateLbl.textContent = s === "■" ? tr("chotu.listening")
                           : s === "…" ? tr("chotu.thinking")
                           : tr("chotu.tapToTalk");
    }).observe(mic, { childList: true, characterData: true, subtree: true });
  }

  const send = () => {
    const box = $("#chotutext", mount);
    const t = box.value.trim();
    if (!t) return;
    box.value = "";
    turn(mount, t);
  };
  $("#chotusend", mount).addEventListener("click", send);
  $("#chotutext", mount).addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); send(); }
  });

}

function paintWho(mount) {
  const box = $("#chotuwho", mount);
  if (!box) return;
  // not a control: there is nothing to choose, and offering a choice invites somebody to get it wrong
  box.innerHTML = `<span class="chip mute" title="${esc(tr("chotu.recordedAs"))}">👤 ${esc(speaker())}</span>`;
}

function paintOrder(mount) {
  const box = $("#chotuorder", mount);
  if (!box) return;
  box.innerHTML = ORDER ? chip(ORDER, "info", "#") : "";
}

function paintLog(mount) {
  const box = $("#chotulog", mount);
  if (!box) return;
  box.innerHTML = HISTORY.map((h) =>
    `<div class="chotumsg ${h.who === "me" ? "me" : "it"}">${esc(h.text)}</div>`).join("");
  box.scrollTop = box.scrollHeight;
}

/* ------------------------------------------------------------------ one exchange */
async function turn(mount, text) {
  HISTORY.push({ who: "me", text });
  paintLog(mount);

  /* Put the order in scope BEFORE the facts are fetched, so the very first call is grounded. */
  const spoken = orderIn(text);
  const guessed = spoken && spoken !== ORDER;
  if (guessed) { ORDER = spoken; paintOrder(mount); }

  const stateLbl = $("#chotustate", mount);
  if (stateLbl) stateLbl.textContent = tr("chotu.thinking");

  let res;
  let adopted = false;      // did we point the facts at a number that has not been confirmed yet
  try {
    res = await ask(text);
    /* The order number was spoken in THIS sentence.
     *
     * The facts are fetched before the model runs, so the first pass had no idea which order was
     * meant and was handed nothing about it - and correctly refused to answer rather than inventing
     * something, which is the behaviour we want but a poor first reply. Now that it has told us the
     * number, fetch that order and ask once more.
     *
     * Once only, and only when the first pass genuinely had no order in hand, so it cannot loop. */
    if (res.order_id && res.order_id !== ORDER && !(res.facts && res.facts.order)) {
      ORDER = String(res.order_id);
      adopted = true;
      paintOrder(mount);
      res = await ask(text);
    }

  } catch (e) {
    HISTORY.push({ who: "it", text: e.message });
    paintLog(mount);
    if (stateLbl) stateLbl.textContent = tr("chotu.tapToTalk");
    return;
  }
  if (stateLbl) stateLbl.textContent = tr("chotu.tapToTalk");

  /* Adopt the order only once the FACTS confirm it is a real one.
   *
   * Not every five-digit number in a sentence is an order - "we used 12345 meters" is a quantity -
   * and a bogus number left in the chip would silently become the subject of the next sentence.
   * facts.order comes back null for an id the roster does not have, which is the test.
   *
   * `adopted` matters as much as `guessed`: when the MODEL supplied the number rather than
   * orderIn(), guessed is false, and without this an unrecognised id would stay in the chip and
   * quietly become the subject of the next sentence. */
  if (res.facts && res.facts.order) {
    if (res.order_id && res.order_id !== ORDER) { ORDER = String(res.order_id); paintOrder(mount); }
  } else if (guessed || adopted) {
    ORDER = null;
    paintOrder(mount);
  }

  // what was actually said travels with the proposal, because chotu_log records it verbatim
  res.said = text;

  /* No key, or the model is down. The facts came back regardless, so say something true and short
   * rather than pretending nothing happened - and the typed path and the modules still work. */
  const line = (res.say || "").trim() || (res.llm === false ? tr("chotu.offline") : tr("chotu.unsure"));
  HISTORY.push({ who: "it", text: line });
  paintLog(mount);
  say(line);

  PROPOSAL = res.intent && res.intent !== "answer" ? res : null;
  const card = $("#chotucard", mount);
  card.innerHTML = "";
  if (PROPOSAL) paintProposal(mount, PROPOSAL);
}

/* ------------------------------------------------------------------ the confirmation card
 * The gap between "Chotu heard something" and "the database changed". Everything the model proposed
 * is shown in plain words - not ids - so it can be checked by somebody who has never seen this
 * screen before, and nothing happens until they tap Commit. */
/* Every action Chotu can propose, as a dropdown. The model's guess is the SELECTED one, not the
 * only one - it gets the intent wrong sometimes, and when it does the fix should be one tap rather
 * than saying the whole sentence again in different words. */
const INTENT_OPTIONS = [
  { value: "order_status",      key: "chotu.iStatus" },
  { value: "add_visit",         key: "chotu.iVisit" },
  { value: "adjustment",        key: "chotu.iAdjustment" },
  { value: "order_edit",        key: "chotu.iOrderEdit" },
  { value: "fabric_received",   key: "chotu.iFabric" },
  { value: "material_received", key: "chotu.iMaterial" },
  { value: "stack_location",    key: "chotu.iLocation" },
  { value: "prep_stage",        key: "chotu.iStage" },
  { value: "tailor_state",      key: "chotu.iTailor" },
  { value: "rail_done",         key: "chotu.iRail" },
  { value: "order_issue",       key: "chotu.iIssue" },
  { value: "inventory_move",    key: "chotu.iInventory" },
  { value: "low_stock",         key: "chotu.iLowStock" },
  { value: "handover",          key: "chotu.iHandover" },
  { value: "log_note",          key: "chotu.iNote" },
];

function paintProposal(mount, res) {
  const card = $("#chotucard", mount);
  card.innerHTML = "";                 // redrawn in place when the action dropdown changes
  const facts = res.facts || {};
  const f = res.fields || {};
  const need = res.need || [];
  const labelOf = (v) => {
    const o = INTENT_OPTIONS.find((x) => x.value === v);
    return o ? tr(o.key) : v;
  };

  /* Every field is EDITABLE, and every one that has a vocabulary is a dropdown rather than a box.
   * Chotu is a fast way to fill this form, not an authority over it: it mishears, and the fix has
   * to be visible and one tap away or people stop trusting the whole thing. The options come from
   * the same closed lists the database checks, so correcting by hand cannot invent a value either. */
  const opts = (list, sel) => list.map((o) =>
    `<option value="${esc(o.value)}"${String(o.value) === String(sel) ? " selected" : ""}>${
      esc(o.label)}</option>`).join("");
  const pick = (list, ids, key, idField = "id") => (facts[list] || []).map((r) => `
    <label class="cbrow"><input type="checkbox" data-pick value="${esc(r[idField])}"${
      (ids || []).map(Number).includes(Number(r[idField])) ? " checked" : ""}> ${
      esc(r[key] || r.description || r.name || r[idField])}</label>`).join("");

  let fields = "";
  switch (res.intent) {
    case "order_status":
      fields = `
        <label class="f">${esc(tr("col.status"))}</label>
        <select name="status">${opts(ORDER_STATUSES.map((s) => ({ value: s, label: s })), f.status)}</select>
        <label class="f" style="margin-top:8px">${esc(tr("act.comment"))}</label>
        <textarea name="note" rows="2">${esc(f.note || "")}</textarea>`;
      break;
    case "tailor_state":
      fields = `
        <label class="f">${esc(tr("bulk.newState"))}</label>
        <select name="state">${opts(
          DISPATCH_SUBSTATES.map((s) => ({ value: s.value, label: tr(s.key) })), f.state)}</select>
        <label class="f" style="margin-top:8px">${esc(tr("bulk.tailor"))}</label>
        <select name="contractor"><option value="">${esc(tr("chotu.allTailors"))}</option>${opts(
          DISPATCH_CONTRACTORS.map((c) => ({ value: c.value, label: tr(c.key) })), f.contractor)}</select>`;
      break;
    case "fabric_received":
      fields = `<label class="f">${esc(tr("col.fabrics"))}</label>
        <div class="memgrid">${pick("fabrics", f.ids, "fabric_code")}</div>`;
      break;
    case "material_received":
      fields = `<label class="f">${esc(tr("col.special"))}</label>
        <div class="memgrid">${pick("materials", f.ids, "description")}</div>`;
      break;
    case "rail_done":
      fields = `<label class="f">${esc(tr("rep.railing"))}</label>
        <div class="memgrid">${pick("rails", f.line_ids, "window_ref", "line_id")}</div>`;
      break;
    case "prep_stage":
      fields = `<label class="f">${esc(tr("col.prep"))}</label>
        <select name="stage">${opts(PREP_STAGES.filter((s) => s.value !== "stacking")
          .map((s) => ({ value: s.value, label: tr(s.key) })), f.stage)}</select>`;
      break;
    case "stack_location":
      fields = `<label class="f">${esc(tr("stack.title"))}</label>
        <div class="grid2">
          <select name="floor">${opts(STACK_FLOORS.map((x) => ({ value: x.value, label: tr(x.key) })), f.floor)}</select>
          <select name="rack">${opts(STACK_RACKS.map((x) => ({ value: x, label: x })), f.rack)}</select>
          <select name="shelf">${opts(STACK_SHELVES.map((x) => ({ value: x, label: x })), f.shelf)}</select>
          <select name="zone">${opts(STACK_ZONES.map((x) => ({ value: x, label: x })), f.zone)}</select>
        </div>
        <div class="muted" style="margin-top:6px">${esc(f.all_units ? tr("chotu.allWindows")
          : (f.units || []).map((u) => `${u.w} L${u.l}`).join(", "))}</div>`;
      break;
    case "order_issue":
      fields = `<label class="f">${esc(tr("act.comment"))}</label>
        <textarea name="note" rows="3">${esc(f.note || "")}</textarea>`;
      break;
    case "inventory_move":
    case "low_stock":
      fields = `<label class="f">${esc(tr("inv.title"))}</label>
        <select name="item_id">${opts((facts.inventory || [])
          .map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` })), f.item_id)}</select>
        ${res.intent === "inventory_move" ? `<label class="f" style="margin-top:8px">${
          esc(tr("inv.qty"))}</label>
          <input type="number" name="qty_delta" step="0.01" value="${esc(f.qty_delta ?? "")}">` : ""}`;
      break;
    case "handover":
      fields = `<div class="grid2">
          <div><label class="f">${esc(tr("hnd.from"))}</label>
            <select name="from">${opts((facts.people || []).map((p) => ({ value: p, label: p })), f.from)}</select></div>
          <div><label class="f">${esc(tr("hnd.to"))}</label>
            <select name="to">${opts((facts.people || []).map((p) => ({ value: p, label: p })), f.to)}</select></div>
        </div>
        <div class="muted" style="margin-top:6px">${esc((f.lines || []).map((l) => {
          const it = (facts.inventory || []).find((i) => Number(i.id) === Number(l.item_id));
          return `${it ? it.name : l.item_id} ×${num(l.qty)}`;
        }).join(", "))}</div>`;
      break;

    /* A whole new trip to site. The outcome dropdown is the point of this card: fn_chotu_context
     * works out the visit number, so the only thing a person has to decide is what to mark - and
     * validate() puts "status" in need[] whenever they did not say, which blocks Commit until they
     * pick one. Recording visit 2 or later also auto-proposes the additional-visit charge, which is
     * exactly what should happen and is why skip_visit_charge is NOT set on this path. */
    case "add_visit":
      fields = `
        <div class="grid2">
          <div><label class="f">${esc(tr("st.visit", { n: "" })).trim()}</label>
            <input type="number" name="visit_no" min="1" max="10" step="1"
                   value="${esc(f.visit_no ?? facts.next_visit_no ?? "")}"></div>
          <div><label class="f">${esc(tr("st.visitDate"))}</label>
            <input type="date" name="visit_date" value="${esc(f.visit_date || facts.today || "")}"></div>
        </div>
        <label class="f" style="margin-top:8px">${esc(tr("st.visitStatus"))}</label>
        <select name="status">
          <option value="">${esc(tr("chotu.pickStatus"))}</option>
          ${opts(ORDER_STATUSES.map((s) => ({ value: s, label: s })), f.status)}</select>
        <label class="f" style="margin-top:8px">${esc(tr("st.members"))}</label>
        <div class="memgrid">${[0, 1, 2, 3, 4, 5].map((i) => `
          <select name="vm${i}"><option value="">${esc(tr("st.memberNone"))}</option>${
            opts((facts.people || []).map((p) => ({ value: p, label: p })), (f.members || [])[i])
          }</select>`).join("")}</div>
        <label class="f" style="margin-top:8px">${esc(tr("act.comment"))}</label>
        <textarea name="comment" rows="2">${esc(f.comment || "")}</textarea>`;
      break;

    /* Chargeable work beyond the PO. The amount box starts from whatever the model proposed but is
     * overwritten by fn_ops_rate_for as soon as the card is on screen - the rate card is the one
     * place rates live, and a remembered rate is how 100 and 150 end up on the same invoice. */
    case "adjustment":
      fields = `
        <div class="grid2">
          <div><label class="f">${esc(tr("adj.type"))}</label>
            <select name="charge_type">${opts(
              CHARGE_TYPES.map((c) => ({ value: c.value, label: tr(c.key) })), f.charge_type)}</select></div>
          <div><label class="f">${esc(tr("adj.qty"))}</label>
            <input type="number" name="qty" min="1" step="1" value="${esc(f.qty ?? 1)}"></div>
          <div><label class="f">${esc(tr("adj.amount"))}</label>
            <input type="number" name="amount" step="0.01" inputmode="decimal"
                   value="${esc(f.amount ?? "")}">
            <div class="muted" data-rate style="margin-top:4px"></div></div>
          <div><label class="f">${esc(tr("st.visit", { n: "" })).trim()}</label>
            <input type="number" name="visit_no" min="1" max="10" step="1"
                   value="${esc(f.visit_no ?? "")}"></div>
        </div>
        <label class="f" style="margin-top:8px">${esc(tr("adj.reason"))}</label>
        <textarea name="reason" rows="2">${esc(f.reason || "")}</textarea>
        <div class="muted" style="margin-top:4px">${esc(tr("adj.reasonRequired"))}</div>
        <label class="f" style="margin-top:8px">${esc(tr("adj.chargeable"))}</label>
        <select name="chargeable">
          <option value="true"${f.chargeable === false ? "" : " selected"}>${esc(tr("adj.chargeable"))}</option>
          <option value="false"${f.chargeable === false ? " selected" : ""}>${esc(tr("adj.dropped"))}</option>
        </select>`;
      break;

    case "order_edit":
      fields = `
        <div class="grid2">
          <div><label class="f">${esc(tr("st.alteration"))}</label>
            <select name="alteration">
              <option value="">—</option>
              <option value="false"${f.alteration === false ? " selected" : ""}>${esc(tr("t.no"))}</option>
              <option value="true"${f.alteration === true ? " selected" : ""}>${esc(tr("t.yes"))}</option>
            </select></div>
          <div><label class="f">${esc(tr("st.removalCount"))}</label>
            <input type="number" name="removal_count" min="0" step="1"
                   value="${esc(f.removal_count ?? "")}"></div>
        </div>
        <label class="f" style="margin-top:8px">${esc(tr("st.alterationNote"))}</label>
        <input type="text" name="alteration_note" value="${esc(f.alteration_note || "")}">
        <label class="f" style="margin-top:8px">${esc(tr("act.comment"))}</label>
        <textarea name="comment" rows="2">${esc(f.comment || "")}</textarea>`;
      break;

    /* Nothing to change in the order tables - this exists so what somebody said is kept anyway.
     * It is also where an unmatched order number lands, which is the whole reason it exists. */
    case "log_note":
      fields = `<label class="f">${esc(tr("act.comment"))}</label>
        <textarea name="note" rows="3">${esc(f.note || "")}</textarea>`;
      break;

    default: break;
  }

  const blocked = need.length > 0 || isViewer();
  /* An order number nobody recognises is not a failure to capture - what they said is still kept,
   * in chotu_log and from there in the Google Doc, so somebody can match it up later. The button
   * says so plainly rather than promising a save that will not touch the order. */
  const unmatched = res.order_known === false && !!res.order_id;

  const box = el(`
    <div class="card chotucard ${blocked ? "blocked" : ""}">
      <div class="spread" style="margin-bottom:9px">
        <h4>${esc(tr("chotu.check"))}</h4>
        <span class="muted">${esc(tr("chotu.speaker"))}: ${esc(speaker())}</span>
      </div>
      <div class="muted" style="margin-bottom:9px">${esc(tr("chotu.editHint"))}</div>

      <label class="f">${esc(tr("chotu.action"))}</label>
      <select name="intent">${opts(
        INTENT_OPTIONS.map((o) => ({ value: o.value, label: tr(o.key) })), res.intent)}</select>

      <label class="f" style="margin-top:8px">${esc(tr("col.order"))}</label>
      <input type="text" name="order_id" inputmode="numeric" value="${esc(res.order_id || "")}">

      <div data-fields style="margin-top:8px">${fields}</div>

      <div class="dsec" style="margin:12px 0 0">
        <label class="f">${esc(tr("photo.title"))}</label>
        <div data-photos></div>
      </div>

      ${unmatched ? `<div class="banner warn" style="margin-top:10px">${
        esc(tr("chotu.unmatched", { id: res.order_id }))}</div>` : ""}
      ${need.length ? `<div class="banner warn" style="margin-top:10px">${
        esc(tr("chotu.missing", { what: need.join(", ") }))}</div>` : ""}
      ${isViewer() ? `<div class="banner warn" style="margin-top:10px">${
        esc(tr("role.readOnly"))}</div>` : ""}
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="btn ghost" data-drop>${esc(tr("act.cancel"))}</button>
        <button class="btn primary" data-commit${blocked ? " disabled" : ""}>${
          esc(unmatched ? tr("chotu.saveLogOnly") : tr("chotu.commit"))}</button>
      </div>
    </div>`);

  /* Photos and FILES attach to the ORDER, so they survive whatever this capture turns out to be - a
   * damaged roll photographed on arrival is evidence whether the write lands as a receipt or as an
   * issue. files:true adds the ordinary picker beside the camera, because a supplier's PDF or a
   * photo already in the gallery is not reachable from a capture="environment" button. */
  box.querySelector("[data-photos]").appendChild(photoStrip({
    context: "other", order_id: res.order_id || null, context_label: labelOf(res.intent),
  }, { files: true }));

  /* The rate card decides the money, not the model. Asked as soon as the card is drawn and again
   * whenever type or quantity changes, so removal of 4 prices at 100 and of 2 at nothing. */
  if (res.intent === "adjustment") wireRate(box, f);

  // changing the action redraws the fields under it, keeping whatever still applies
  box.querySelector('[name="intent"]').addEventListener("change", (e) => {
    readCard(box, res);
    res.intent = e.target.value;
    res.need = [];                       // a hand-picked action is not the model's guess any more
    paintProposal(mount, res);
  });

  box.querySelector("[data-drop]").addEventListener("click", () => {
    PROPOSAL = null;
    card.innerHTML = "";
    HISTORY.push({ who: "it", text: tr("chotu.dropped") });
    paintLog(mount);
  });

  const go = box.querySelector("[data-commit]");
  if (!blocked) {
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        readCard(box, res);              // whatever they corrected is what gets written
        await commit(res);
        PROPOSAL = null;
        card.innerHTML = "";
        const done = queueDepth() ? tr("t.queued") : tr("chotu.saved");
        HISTORY.push({ who: "it", text: done });
        paintLog(mount);
        say(done);
        toast(done, "ok");
      } catch (e) {
        go.disabled = false;
        toast(e.message, "bad");
      }
    });
  }

  card.appendChild(box);
}

/* Which tailors this order is actually with, read at commit time rather than carried in the facts.
 * One small request, and it cannot be stale the way a snapshot taken before the conversation can. */
async function currentTailors(orderId) {
  if (!orderId) return [];
  try {
    const rows = await api(
      `/rest/v1/order_dispatch?select=contractor&order_id=eq.${encodeURIComponent(orderId)}`);
    return Array.from(new Set((rows || []).map((r) => r.contractor).filter(Boolean)));
  } catch (e) { return []; }
}

/* Read the card back into the proposal, so a correction is what commits rather than the model's
 * original guess. Only fields the current action actually draws are read; the rest are left alone. */
function readCard(box, res) {
  const v = (n) => { const e = box.querySelector(`[name="${n}"]`); return e ? e.value : undefined; };
  const picked = () => Array.from(box.querySelectorAll("[data-pick]:checked")).map((c) => Number(c.value));
  const f = res.fields || (res.fields = {});
  const oid = v("order_id");
  if (oid !== undefined) res.order_id = oid.trim() || null;

  switch (res.intent) {
    case "order_status": f.status = v("status"); f.note = v("note"); break;
    case "tailor_state": f.state = v("state"); f.contractor = v("contractor") || null; break;
    case "fabric_received":
    case "material_received": f.ids = picked(); break;
    case "rail_done": f.line_ids = picked(); break;
    case "prep_stage": f.stage = v("stage"); break;
    case "stack_location":
      f.floor = v("floor"); f.rack = v("rack"); f.shelf = v("shelf"); f.zone = v("zone"); break;
    case "order_issue": f.note = v("note"); break;
    case "inventory_move":
      f.item_id = Number(v("item_id")); f.qty_delta = Number(v("qty_delta")); break;
    case "low_stock": f.item_id = Number(v("item_id")); break;
    case "handover": f.from = v("from"); f.to = v("to"); break;

    case "add_visit":
      f.visit_no = Number(v("visit_no")) || null;
      f.visit_date = v("visit_date") || null;
      f.status = v("status") || null;
      f.comment = v("comment") || null;
      // de-duplicated and blanks dropped, so the six slots can be filled in any order
      f.members = Array.from(new Set([0, 1, 2, 3, 4, 5]
        .map((i) => { const e = box.querySelector(`[name="vm${i}"]`); return e ? e.value.trim() : ""; })
        .filter(Boolean)));
      break;

    case "adjustment": {
      f.charge_type = v("charge_type");
      f.qty = Number(v("qty")) || 1;
      const amt = v("amount");
      f.amount = (amt === "" || amt === undefined) ? null : Number(amt);
      f.reason = (v("reason") || "").trim();
      f.visit_no = Number(v("visit_no")) || null;
      f.chargeable = v("chargeable") !== "false";
      break;
    }

    case "order_edit": {
      // "—" means leave it alone, which is a third state and not the same as No
      const alt = v("alteration");
      if (alt === "") delete f.alteration; else if (alt !== undefined) f.alteration = alt === "true";
      const rc = v("removal_count");
      f.removal_count = (rc === "" || rc === undefined) ? null : Number(rc);
      f.alteration_note = v("alteration_note") || null;
      f.comment = v("comment") || null;
      break;
    }

    case "log_note": f.note = v("note"); break;

    default: break;
  }
}

/* The banded rate for the chosen charge type and quantity, from adjustment_rate_card via the same
 * fn_ops_rate_for the Installation module's adjustment sheet calls - so the two screens can never
 * quote different money for the same work. Typing in the box wins from then on: the card is a
 * starting point, and a coordinator who has agreed a figure with a client is not to be overruled. */
async function wireRate(box, f) {
  const typeSel = box.querySelector('[name="charge_type"]');
  const qtyIn = box.querySelector('[name="qty"]');
  const amtIn = box.querySelector('[name="amount"]');
  const lbl = box.querySelector("[data-rate]");
  if (!typeSel || !amtIn || !lbl) return;

  let touched = f.amount != null && f.amount !== "";
  amtIn.addEventListener("input", () => { touched = true; });

  const refresh = async () => {
    try {
      const res = await rpc("fn_ops_rate_for", {
        p_charge_type: typeSel.value, p_qty: Number(qtyIn ? qtyIn.value : 1) || 1,
      });
      const row = Array.isArray(res) ? res[0] : res;
      if (!row) { lbl.textContent = ""; return; }
      lbl.textContent = `${tr("adj.suggested")}: ${row.label} — ${aed(row.amount_aed)}`;
      if (!touched) amtIn.value = Number(row.amount_aed).toFixed(2);
    } catch (e) { lbl.textContent = ""; }
  };
  typeSel.addEventListener("change", () => { touched = false; refresh(); });
  if (qtyIn) qtyIn.addEventListener("change", refresh);
  refresh();
}

/* ------------------------------------------------------------------ commit
 *
 * TWO WRITES, ALWAYS. The action goes to the RPC that owns it, and the capture itself goes to
 * chotu_log - what was said, by whom, against which order, and whether the action landed. The log
 * is written even when the action fails and even when there is no action to run at all, which is
 * what makes an unrecognised order number recoverable instead of lost: the note survives, somebody
 * reads it in the Google Doc later, and matches it to the real order.
 *
 * Both go through submit(), so both survive a lift.
 */
async function commit(res) {
  const actor = currentActor();
  let ok = false;
  try {
    await commitAction(res, actor);
    ok = true;
  } finally {
    await submit("fn_chotu_log", {
      p_said: res.said || res.say || "",
      p_order_id: res.order_id || null,
      p_order_known: res.order_known !== false,
      p_say: res.say || null,
      p_intent: res.intent || null,
      p_fields: res.fields || {},
      p_committed: ok,
      p_actor: actor,
      p_speaker: speaker(),
      p_lang: getLang(),
      // generated once and stored WITH the queued item, so a replay reuses it and cannot double up
      p_op: crypto.randomUUID(),
    });
  }
}

/* Every branch calls an RPC this app already had, through the same queue as every other screen. The
 * note records that it arrived by voice and who said it, so a row captured here is traceable to a
 * person in the same way a typed one is. */
async function commitAction(res, actor) {
  const f = res.fields || {};
  /* The actor is exactly what every other screen writes - no decoration. A Chotu row and a typed
   * row are attributable the same way, so "who recorded this" never depends on which door it came
   * through. The note is what marks it as spoken rather than typed. */
  const note = tr("chotu.viaChotu", { who: speaker() || "—" });

  switch (res.intent) {
    case "fabric_received":
    case "material_received":
      return submit("fn_ops_set_receiving", {
        p_ids: f.ids, p_status: "received", p_qc: null, p_actor: actor, p_note: note,
      });

    case "stack_location":
      return submit("fn_ops_apply_prep", {
        p_order_id: res.order_id, p_stage: "stacking",
        // an empty unit list means the whole order, which is what fn_ops_apply_prep's null does
        p_units: (f.units && f.units.length) ? f.units : null,
        p_qc: null, p_actor: actor, p_note: note, p_op: crypto.randomUUID(),
        p_floor: f.floor, p_rack: f.rack, p_shelf: f.shelf, p_zone: f.zone,
      });

    case "prep_stage":
      return submit("fn_ops_apply_prep", {
        p_order_id: res.order_id, p_stage: f.stage, p_units: null, p_qc: null,
        p_actor: actor, p_note: note, p_op: crypto.randomUUID(),
        p_floor: null, p_rack: null, p_shelf: null, p_zone: null,
      });

    case "rail_done":
      for (const id of f.line_ids) {
        await submit("fn_ops_set_rail_mark", {
          p_line_id: id, p_on: true, p_actor: actor, p_op: crypto.randomUUID(),
        });
      }
      return null;

    case "order_status":
      /* The same write the Installation module makes: order status lives on the visit payload, and
       * skip_visit_charge stops recording an outcome from inventing a chargeable revisit. */
      return submit("fn_ops_save_visit", {
        p_order_id: res.order_id, p_visit_no: 1,
        p_payload: {
          status: f.status,
          comment: [f.note, note].filter(Boolean).join(" — "),
          input_method: "chotu", lang: getLang(), skip_visit_charge: true,
        },
        p_actor: actor,
      });

    case "tailor_state": {
      /* No tailor named means every tailor this order is already with - the same rule as the
       * Production module's bulk action, because "it came back" is about the work, not the person.
       * With none on record there is nothing to move, so say so rather than inventing one. */
      const list = f.contractor ? [f.contractor] : await currentTailors(res.order_id);
      if (!list.length) throw new Error(tr("bulk.tailorNone"));
      for (const c of list) {
        await submit("fn_ops_set_dispatch", {
          p_order_id: res.order_id, p_contractor: c, p_substate: f.state,
          p_other_name: null, p_actor: actor, p_note: note, p_items: null,
          p_qc_note: (f.state === "qc_failed" || f.state === "issue") ? (f.note || note) : null,
        });
      }
      return null;
    }

    case "order_issue":
      /* order_comments through fn_ops_save_visit, never order_lines_final: fn_rebuild_order
       * recomputes that table wholesale on every PO revision and a note written there disappears. */
      return submit("fn_ops_save_visit", {
        p_order_id: res.order_id, p_visit_no: 1,
        p_payload: {
          internal_comment: `${f.note}${f.mark ? ` [${f.mark}]` : ""} — ${note}`,
          input_method: "chotu", lang: getLang(), skip_visit_charge: true,
        },
        p_actor: actor,
      });

    case "inventory_move":
      return submit("fn_ops_inventory_move", {
        p_item_id: f.item_id, p_qty_delta: f.qty_delta, p_reason: f.reason || "adjustment",
        p_order_id: res.order_id || null, p_location_code: null, p_note: note, p_actor: actor,
      });

    case "low_stock":
      return submit("fn_ops_set_reorder_flag", {
        p_item_ids: [f.item_id], p_on: true, p_actor: actor,
      });

    case "handover":
      return submit("fn_ops_save_handover", {
        p_kind: f.kind, p_from_person: f.from, p_to_person: f.to,
        p_order_id: f.kind === "order" ? res.order_id : null,
        p_location_code: null, p_note: note,
        p_lines: (f.lines || []).map((l) => {
          const item = ((res.facts || {}).inventory || []).find((i) => Number(i.id) === Number(l.item_id));
          return { item_id: l.item_id, qty: l.qty,
                   description: item ? `${item.code} — ${item.name}` : "Item",
                   uom: item ? item.uom : "pc" };
        }),
        p_actor: actor, p_op: crypto.randomUUID(),
      });

    /* A whole new trip to site. skip_visit_charge is deliberately NOT set: fn_ops_save_visit
     * auto-proposes the additional_visit charge on visit 2 and later, and a revisit somebody
     * bothered to record by voice is exactly the one that should reach the finance team. */
    case "add_visit":
      return submit("fn_ops_save_visit", {
        p_order_id: res.order_id,
        p_visit_no: Number(f.visit_no) || 1,
        p_payload: {
          visit_date: f.visit_date || null,
          visit_status: f.status || null,
          visit_comment: f.comment || null,
          internal_comment: [f.comment, note].filter(Boolean).join(" — "),
          member_names: f.members || [],
          input_method: "chotu", lang: getLang(),
        },
        p_actor: actor,
      });

    case "adjustment":
      return submit("fn_ops_add_adjustment", {
        p_order_id: res.order_id,
        p_charge_type: f.charge_type,
        p_reason: f.reason,
        p_quantity: Number(f.qty) || 1,
        p_visit_no: Number(f.visit_no) || null,
        p_chargeable: f.chargeable !== false,
        // null lets fn_ops_add_adjustment fall back to the rate card itself
        p_amount: (f.amount === null || f.amount === undefined || f.amount === "")
          ? null : Number(f.amount),
        p_actor: actor,
        p_window_name: null,
        p_notes: note,
        p_status: "new",
      });

    /* Order-level fields rather than an event. Keys are spread in conditionally because
     * fn_ops_save_visit coalesces an ABSENT key against the stored value - so leaving one out is
     * how "do not touch this" is expressed, and sending null would be the same but sending false
     * would not. */
    case "order_edit":
      return submit("fn_ops_save_visit", {
        p_order_id: res.order_id,
        p_visit_no: 1,
        p_payload: {
          ...(typeof f.alteration === "boolean" ? { alteration: f.alteration } : {}),
          ...(f.removal_count != null ? { removal_curtain_count: f.removal_count } : {}),
          ...(f.alteration_note ? { alteration_special_requirement: f.alteration_note } : {}),
          comment: [f.comment, note].filter(Boolean).join(" — "),
          input_method: "chotu", lang: getLang(),
          skip_visit_charge: true,   // editing order-level fields must not invent a visit charge
        },
        p_actor: actor,
      });

    // nothing to change in the order tables; the chotu_log row written by commit() IS the write
    case "log_note":
      return null;

    default:
      throw new Error(tr("chotu.unsure"));
  }
}
