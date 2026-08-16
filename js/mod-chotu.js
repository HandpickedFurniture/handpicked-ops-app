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
import { submit, currentActor, queueDepth, isSignedIn, isViewer, getSession } from "./api.js";
import { SB_URL, SB_KEY } from "./config.js";
import { tr, getLang, SPEECH_LOCALE } from "./i18n.js";
import { $, esc, el, chip, num, toast } from "./ui.js";
import { attachMic, speechAvailable } from "./voice.js";

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
   * facts.order comes back null for an id the roster does not have, which is the test. */
  if (res.facts && res.facts.order) {
    if (res.order_id && res.order_id !== ORDER) { ORDER = String(res.order_id); paintOrder(mount); }
  } else if (guessed) {
    ORDER = null;
    paintOrder(mount);
  }

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
function paintProposal(mount, res) {
  const card = $("#chotucard", mount);
  const facts = res.facts || {};
  const f = res.fields || {};
  const need = res.need || [];

  const label = {
    fabric_received: tr("chotu.iFabric"), material_received: tr("chotu.iMaterial"),
    stack_location: tr("chotu.iLocation"), prep_stage: tr("chotu.iStage"),
    rail_done: tr("chotu.iRail"), order_issue: tr("chotu.iIssue"),
    inventory_move: tr("chotu.iInventory"), handover: tr("chotu.iHandover"),
    low_stock: tr("chotu.iLowStock"),
  }[res.intent] || res.intent;

  const rows = [];
  const add = (k, v) => { if (v !== null && v !== undefined && v !== "") rows.push([k, v]); };
  const named = (list, ids, key, idField = "id") =>
    (facts[list] || []).filter((r) => (ids || []).includes(Number(r[idField])))
      .map((r) => r[key] || r.description || r.name).join(", ");

  add(tr("chotu.action"), label);
  if (res.order_id) add(tr("col.order"), res.order_id);

  switch (res.intent) {
    case "fabric_received":
      add(tr("col.fabrics"), named("fabrics", f.ids, "fabric_code")); break;
    case "material_received":
      add(tr("col.special"), named("materials", f.ids, "description")); break;
    case "stack_location":
      add(tr("stack.title"), [f.floor, f.rack, f.shelf, f.zone].filter(Boolean).join("-"));
      add(tr("col.windows"), f.all_units ? tr("chotu.allWindows")
        : (f.units || []).map((u) => `${u.w} L${u.l}`).join(", "));
      break;
    case "prep_stage":
      add(tr("col.prep"), f.stage === "cutting" ? tr("prep.started") : tr("prep.packed")); break;
    case "rail_done":
      add(tr("rep.railing"), named("rails", f.line_ids, "window_ref", "line_id")); break;
    case "order_issue":
      add(tr("act.comment"), f.note); break;
    case "inventory_move":
      add(tr("inv.title"), named("inventory", [f.item_id], "name"));
      add(tr("inv.qty"), f.qty_delta);
      break;
    case "low_stock":
      add(tr("inv.title"), named("inventory", [f.item_id], "name")); break;
    case "handover":
      add(tr("hnd.kind"), f.kind === "order" ? tr("hnd.kindOrder") : tr("hnd.kindInventory"));
      add(tr("hnd.from"), f.from);
      add(tr("hnd.to"), f.to);
      add(tr("hnd.what"), (f.lines || [])
        .map((l) => `${named("inventory", [l.item_id], "name")} ×${num(l.qty)}`).join(", "));
      break;
    default: break;
  }
  add(tr("chotu.speaker"), speaker());

  const blocked = need.length > 0 || isViewer();

  const box = el(`
    <div class="card chotucard ${blocked ? "blocked" : ""}">
      <div class="spread" style="margin-bottom:9px">
        <h4>${esc(tr("chotu.check"))}</h4>
        ${chip(label, blocked ? "warn" : "ok", blocked ? "?" : "✓")}
      </div>
      <table class="chotufields">
        ${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`).join("")}
      </table>
      ${need.length ? `<div class="banner warn" style="margin-top:10px">${
        esc(tr("chotu.missing", { what: need.join(", ") }))}</div>` : ""}
      ${isViewer() ? `<div class="banner warn" style="margin-top:10px">${
        esc(tr("role.readOnly"))}</div>` : ""}
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="btn ghost" data-drop>${esc(tr("act.cancel"))}</button>
        <button class="btn primary" data-commit${blocked ? " disabled" : ""}>${
          esc(tr("chotu.commit"))}</button>
      </div>
    </div>`);

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

/* ------------------------------------------------------------------ commit
 * Every branch calls an RPC this app already had, through the same queue as every other screen. The
 * note records that it arrived by voice and who said it, so a row captured here is traceable to a
 * person in the same way a typed one is. */
async function commit(res) {
  const f = res.fields || {};
  /* Exactly the actor every other screen writes - no decoration. A Chotu row and a typed row are
   * attributable the same way, so "who recorded this" never depends on which door it came through.
   * The note is what marks it as spoken rather than typed. */
  const actor = currentActor();
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

    default:
      throw new Error(tr("chotu.unsure"));
  }
}
