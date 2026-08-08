/* Speech to text, in English / Hindi / Bengali.
 *
 * Two paths, chosen by FEATURE DETECTION, never by sniffing the user agent:
 *
 *   A. Web Speech API - Android Chrome, desktop Chrome/Edge. Free, on-device, streams interim
 *      results as you speak.
 *   B. MediaRecorder -> the `transcribe` Edge Function -> Gemini. iOS Safari has no
 *      webkitSpeechRecognition at all, so without this path every iPhone user would have to type.
 *
 * Both paths report which one produced the text, so order_comments.input_method records whether a
 * comment was typed, dictated on-device, or transcribed server-side.
 *
 * getUserMedia requires a secure context: https, or http://localhost. A LAN IP is NOT secure, so
 * path B must be tested on the deployed URL rather than over the network from a phone.
 */
import { SB_URL, SB_KEY } from "./config.js";
import { getLang, SPEECH_LOCALE, tr } from "./i18n.js";
import { getSession } from "./api.js";
import { toast } from "./ui.js";

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function speechAvailable() {
  return !!SR || !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

/* Attach a mic button that dictates into `target` (an input or textarea).
 * onResult(text, method) fires when text lands, so the caller can record input_method/lang. */
export function attachMic(btn, target, onResult) {
  if (!speechAvailable()) { btn.disabled = true; btn.title = "Speech input is not available on this device"; return; }

  let active = null;   // the running recogniser or recorder

  btn.addEventListener("click", async () => {
    if (active) { stop(); return; }
    if (SR) startSpeechApi(); else await startRecording();
  });

  function stop() {
    if (!active) return;
    try { active.stop(); } catch (e) {}
    active = null;
    btn.classList.remove("on");
    btn.textContent = "🎤";
  }

  function append(text, method) {
    if (!text) return;
    const sep = target.value && !/\s$/.test(target.value) ? " " : "";
    target.value = target.value + sep + text;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    if (onResult) onResult(target.value, method);
  }

  /* ---- path A: on-device */
  function startSpeechApi() {
    const rec = new SR();
    rec.lang = SPEECH_LOCALE[getLang()] || "en-IN";
    rec.interimResults = true;
    rec.continuous = true;
    let finalText = "";

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      btn.title = interim || finalText;
    };
    rec.onerror = (e) => {
      // "no-speech" and "aborted" are normal when the user stops; don't shout about them
      if (e.error && e.error !== "no-speech" && e.error !== "aborted") toast(String(e.error), "bad");
      stop();
    };
    rec.onend = () => { append(finalText.trim(), "speech_api"); stop(); };

    try {
      rec.start();
      active = rec;
      btn.classList.add("on");
      btn.textContent = "■";
    } catch (e) { toast(String(e.message || e), "bad"); }
  }

  /* ---- path B: record, then transcribe server-side */
  async function startRecording() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      toast("Microphone permission is needed to dictate.", "bad");
      return;
    }

    // iOS Safari only produces audio/mp4; Chrome prefers opus in webm
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"]
      .find((m) => window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m)) || "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];

    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
      if (!blob.size) return;
      btn.textContent = "…";
      try {
        const text = await transcribe(blob, getLang());
        append(text, "gemini");
      } catch (e) {
        toast(String(e.message || e), "bad");
      } finally {
        btn.textContent = "🎤";
      }
    };

    rec.start();
    active = rec;
    btn.classList.add("on");
    btn.textContent = "■";
  }
}

async function transcribe(blob, lang) {
  const session = getSession();
  if (!session || !session.access_token) throw new Error(tr("auth.required"));

  const b64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("Could not read the recording"));
    r.readAsDataURL(blob);
  });

  const r = await fetch(SB_URL + "/functions/v1/transcribe", {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: "Bearer " + session.access_token,   // the function runs with verify_jwt = true
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ audio: b64, mime: blob.type, lang }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Transcription failed");
  return (j.text || "").trim();
}

/* Convenience: a textarea/input with a mic button beside it. */
export function micField(inputHtml, id) {
  return `<div class="withmic">${inputHtml}
    <button type="button" class="mic" data-mic="${id}" title="${tr("act.speak")}">🎤</button></div>`;
}

export function wireMics(root, onResult) {
  root.querySelectorAll("[data-mic]").forEach((btn) => {
    const target = root.querySelector(`[name="${btn.dataset.mic}"]`);
    if (target) attachMic(btn, target, onResult);
  });
}
