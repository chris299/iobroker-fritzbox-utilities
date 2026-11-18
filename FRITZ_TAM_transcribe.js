/**
 * version 2026-11-18
 *
 * ioBroker Script B: FRITZ!Box Anrufbeantworter mit Azure Transkription (via SOAP Worker)
 *
 * Verarbeitet werden alle Nachrichten, die noch nicht verarbeitet wurden, nicht
 * nur die neueste. Welche schon dran waren, steht in
 * ...Fritzbox_AnrufbeantworterProcessedMessages. Nach jeder Nachricht wird
 * ...Fritzbox_AnrufbeantworterLastProcessedMessage geschrieben (JSON mit
 * Metadaten und Transkript), darauf kann ein Benachrichtigungs-Script reagieren.
 *
 * Dieses Script nutzt:
 * - Trigger: CallMonitor (Port 1012) DPs aus  CallMonitor-Script
 * - SOAP: via SOAP Worker DPs (Queue + XML->JSON)
 *
 * Benötigte DPs (existieren bereits aus deinen anderen Scripts):
 *   CallMonitor:
 *     0_userdata.0.Fritzbox.CallMonitor
 *     0_userdata.0.Fritzbox.LastCall
 *   SOAP Worker:
 *     0_userdata.0.Fritzbox.SOAP_command
 *     0_userdata.0.Fritzbox.SOAP_result
 *
 * Dieses Script legt seine TAM-Output-DPs an wenn nicht vorhanden.
 */

const { URL } = require("url");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("node:fs");
const https = require("node:https");

// ===============================
// Konfiguration
// ===============================
const debug = true;

// Azure Speech (Transcribe)
const ENABLE_TRANSCRIBE_DEFAULT = true;
// const ENABLE_SEND_AUDIO_DEFAULT = false;

// >>> HIER EINTRAGEN <<<
const AZURE_KEY = "fill_your_own_key_here";
const AZURE_TRANSCRIBE_URL =
  "https://westeurope.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15";
const TAM_EXPECTED_LANGUAGE = "de-DE";

// Azure (westeurope, germanywestcentral) bricht seit 2026-11-18 den TLS-Aufbau
// ab ("Client network socket disconnected before secure TLS connection was
// established"), wenn der Client den Post-Quanten-Schlüsselaustausch
// X25519MLKEM768 anbietet. Node 22 mit OpenSSL 3.5 tut das von sich aus, das
// ClientHello wird dadurch groß. curl (OpenSSL 3.0) und Node mit den
// klassischen Kurven kommen durch. Deshalb ein eigener Agent nur für Azure.
const AZURE_HTTPS_AGENT = new https.Agent({ ecdhCurve: "X25519:P-256:P-384" });

// Netzfehler und vorübergehende Azure-Antworten (429, 5xx) wiederholen,
// bevor "Transkription fehlgeschlagen" gemeldet wird.
const AZURE_RETRY_DELAYS_MS = [5000, 15000];

// Standard-TAM (Fallback), falls kein ext 40-49 erkennbar
const DEFAULT_TAM_INDEX = 1;

// Nach dem Auflegen steht die neue Nachricht manchmal erst nach einigen
// Sekunden in der Liste der FRITZ!Box. Deshalb wiederholt nachsehen statt
// einmal fest zu warten.
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_MS = 60000;

// Sicherung gegen eine Flut von Transkripten und Meldungen, falls die Liste
// der verarbeiteten Nachrichten verloren geht: höchstens so viele pro Lauf,
// die neuesten. Ältere werden ohne Transkript als verarbeitet gemerkt.
const MAX_NEW_PER_RUN = 10;

// Pause zwischen zwei Nachrichten eines Laufs. Scripts, die auf das Transkript
// reagieren und dann LatestMessageData/LocalPath lesen, sollen noch die Werte
// derselben Nachricht sehen, nicht schon die der nächsten.
const PAUSE_BETWEEN_MESSAGES_MS = 2000;

// Direkt nach einem Neustart des javascript-Adapters starten dieses Script und
// der SOAP Worker gleichzeitig. Dessen TR-064-Discovery braucht ein paar
// Sekunden, bis dahin antwortet er DISCOVERY_NOT_READY. Dann später erneut
// versuchen, statt den Lauf (und nachzuholende Nachrichten) fallen zu lassen.
const WORKFLOW_RETRY_MS = 15000;
const WORKFLOW_RETRY_MAX = 8;

// ===============================
// SST DPs (CallMonitor + SOAP Worker)
// ===============================
const DP_ROOT_Fritzbox = "0_userdata.0.Fritzbox";

const DP_CM_EVENT    = DP_ROOT_Fritzbox + ".CallMonitor";
const DP_CM_LASTCALL = DP_ROOT_Fritzbox + ".LastCall";

const DP_SOAP_COMMAND = DP_ROOT_Fritzbox + ".SOAP_command";
const DP_SOAP_RESULT  = DP_ROOT_Fritzbox + ".SOAP_result";

// ===============================
// Eigene TAM-Output-DPs
// ===============================
const DP_Fritzbox_SessionId = DP_ROOT_Fritzbox + ".SessionId";
const DP_base_Fritzbox_TAM  = DP_ROOT_Fritzbox + ".Anrufbeantworter.";

// ===============================
// Prerequisite checks (startup)
// ===============================
async function logMissingPrerequisiteDatapoints() {
  const required = [
    DP_CM_EVENT,
    DP_CM_LASTCALL,
    DP_SOAP_COMMAND,
    DP_SOAP_RESULT,
  ];

  const missing = [];
  for (const id of required) {
    try {
      const ok = await existsState(id);
      if (!ok) missing.push(id);
    } catch (_) {
      missing.push(id);
    }
  }

  if (missing.length === 0) return true;

  log(
    `[TAM] Missing required datapoints at startup: ${missing.join(", ")}. ` +
      `Please start/configure FRITZ_CallMonitor.js and FRITZ_SOAP_communication.js first.`,
    "error"
  );
  return false;
}

const DP_Fritzbox_AnrufbeantworterDaten_json =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterDaten_json";
const DP_Fritzbox_AnrufbeantworterDatenAktualisieren =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterDatenAktualisieren";
const DP_Fritzbox_AnrufbeantworterGesamtAnzahlNachrichten =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterGesamtAnzahlNachrichten";
const DP_Fritzbox_AnrufbeantworterAnzahlNeueNachrichten =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterAnzahlNeueNachrichten";
const DP_Fritzbox_AnrufbeantworterDeleteMessage =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterDeleteMessage";
const DP_Fritzbox_AnrufbeantworterIndexMessage_json =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterIndexMessage_json";

const DP_Fritzbox_AnrufbeantworterLatestMessageIndex =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterLatestMessageIndex";
const DP_Fritzbox_AnrufbeantworterLatestMessageData =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterLatestMessageData";
const DP_Fritzbox_AnrufbeantworterLatestMessagePath =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterLatestMessagePath";
const DP_Fritzbox_AnrufbeantworterLatestMessageLocalPath =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterLatestMessageLocalPath";
const DP_Fritzbox_AnrufbeantworterLatestMessageEnableTranskription =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterLatestMessageEnableTranskription";
const DP_Fritzbox_AnrufbeantworterLatestMessageTranskript =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterLatestMessageTranskript";
const DP_Fritzbox_AnrufbeantworterProcessedMessages =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterProcessedMessages";
const DP_Fritzbox_AnrufbeantworterLastProcessedMessage =
  DP_base_Fritzbox_TAM + DEFAULT_TAM_INDEX + ".Fritzbox_AnrufbeantworterLastProcessedMessage";

// ===============================
// State Setup
// ===============================
async function ensureStateExists(id, initialValue, common) {
  try {
    const exists = await existsState(id);
    if (!exists) {
      await createStateAsync(id, initialValue, false, common);
      if (debug) console.log("created state: " + id);
    }
  } catch (e) {
    console.log(`Fehler bei createState ${id}: ${e.message || e}`);
  }
}

(async () => {
  await ensureStateExists(DP_Fritzbox_AnrufbeantworterDaten_json, "{}", {
    name: "JSON Struktur mit den Daten vom Anrufbeantworter aus der FritzBox",
    type: "string",
    role: "value",
    def: "{}",
    read: true,
    write: false,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterDatenAktualisieren, false, {
    name: "Manueller Trigger um die Daten aus dem Anrufbeantworter auszulesen",
    type: "boolean",
    role: "button",
    def: false,
    read: true,
    write: true,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterGesamtAnzahlNachrichten, 0, {
    name: "Gesamtanzahl der Nachrichten auf dem Anrufbeantworter",
    type: "number",
    role: "value",
    def: 0,
    read: true,
    write: false,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterAnzahlNeueNachrichten, 0, {
    name: "Anzahl der neuen Nachrichten auf dem Anrufbeantworter",
    type: "number",
    role: "value",
    def: 0,
    read: true,
    write: false,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterDeleteMessage, "", {
    name: "Zum loeschen ausgewaehlter Eintrag vom Anrufbeantworter",
    type: "string",
    role: "value",
    def: "",
    read: true,
    write: true,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterIndexMessage_json, "", {
    name: 'JSON Struktur für "materialdesign - Select" (Index Einträge)',
    type: "string",
    role: "value",
    def: "",
    read: true,
    write: true,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterLatestMessageIndex, 0, {
    name: "Index Nummer der letzten Anrufbeantworter Nachricht",
    type: "number",
    role: "value",
    def: 0,
    read: true,
    write: false,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterLatestMessageData, "{}", {
    name: "Metadaten der letzten Anrufbeantworter Nachricht",
    type: "string",
    role: "value",
    def: "{}",
    read: true,
    write: false,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterLatestMessagePath, "", {
    name: "Pfad auf der Fritzbox zur letzten Anrufbeantworter Nachricht",
    type: "string",
    role: "value",
    def: "",
    read: true,
    write: false,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterLatestMessageLocalPath, "", {
    name: "Lokaler Pfad zur WAV-Datei der runtergeladenen Nachricht",
    type: "string",
    role: "value",
    def: "",
    read: true,
    write: false,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterLatestMessageEnableTranskription, ENABLE_TRANSCRIBE_DEFAULT, {
    name: "Ein-/Ausschalten der Transkribierung",
    type: "boolean",
    role: "value",
    def: ENABLE_TRANSCRIBE_DEFAULT,
    read: true,
    write: true,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterLatestMessageTranskript, "", {
    name: "Transkript zur letzten Anrufbeantworter Nachricht",
    type: "string",
    role: "value",
    def: "",
    read: true,
    write: true,
  });

  await ensureStateExists(DP_Fritzbox_SessionId, "", {
    name: "SessionId (aus URL sid extrahiert)",
    type: "string",
    role: "value",
    def: "",
    read: true,
    write: true,
  });

  // Leer = noch nie initialisiert. Der erste Lauf markiert dann alles, was
  // schon auf dem AB liegt, als verarbeitet.
  await ensureStateExists(DP_Fritzbox_AnrufbeantworterProcessedMessages, "", {
    name: "Schlüssel der schon verarbeiteten Nachrichten (JSON-Array)",
    type: "string",
    role: "json",
    def: "",
    read: true,
    write: true,
  });

  await ensureStateExists(DP_Fritzbox_AnrufbeantworterLastProcessedMessage, "", {
    name: "Zuletzt verarbeitete Nachricht mit Transkript (JSON), ändert sich bei jeder Nachricht",
    type: "string",
    role: "json",
    def: "",
    read: true,
    write: false,
  });

  if (!getState(DP_Fritzbox_AnrufbeantworterLatestMessageEnableTranskription).val) {
    setState(DP_Fritzbox_AnrufbeantworterLatestMessageTranskript, "Transkription deaktiviert", true);
  }

  if (await logMissingPrerequisiteDatapoints()) {
    // Gleich beim Start einmal durchlaufen: Beim allerersten Start wird
    // initialisiert (sonst ginge ausgerechnet die erste echte neue Nachricht
    // in der Erstmarkierung unter), danach werden Nachrichten nachgeholt, die
    // ankamen, während das Script nicht lief.
    await runTamWorkflow(DEFAULT_TAM_INDEX, false);
  }
})();

// ===============================
// Helper: JSON safe parse
// ===============================
function safeJsonParse(s) {
  try {
    return JSON.parse(String(s || ""));
  } catch (_) {
    return null;
  }
}

// ===============================
// SOAP Client über DP Interface
// ===============================
function newRequestId(prefix = "soap") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

// Worker liefert komplexes JSON (z.B. "#text"). Das reduzieren wir rekursiv.
function simplifyXmlJson(x) {
  if (x === null || x === undefined) return x;
  if (typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(simplifyXmlJson);

  const keys = Object.keys(x);
  if (keys.length === 1 && keys[0] === "#text") return x["#text"];

  const out = {};
  for (const k of keys) out[k] = simplifyXmlJson(x[k]);
  return out;
}

function soapCall({ service, action, params = {}, timeoutMs = 10000 }, waitTimeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const requestId = newRequestId(action || "call");

    const payload = {
      requestId,
      service,
      action,
      params,
      timeoutMs,
      createdAt: new Date().toISOString(),
    };

    const handler = on({ id: DP_SOAP_RESULT, change: "any" }, (obj) => {
      const r = safeJsonParse(obj?.state?.val);
      if (!r || r.requestId !== requestId) return;

      clearTimeout(t);
      try {
        unsubscribe(handler);
      } catch (_) {}

      if (r.ok) {
        r.data = simplifyXmlJson(r.data);
        return resolve(r);
      }
      return reject(new Error(`${r.error?.message || "SOAP_ERROR"}: ${r.error?.details || ""}`));
    });

    const t = setTimeout(() => {
      try {
        unsubscribe(handler);
      } catch (_) {}
      reject(new Error(`Timeout waiting for SOAP_result (requestId=${requestId})`));
    }, waitTimeoutMs);

    setState(DP_SOAP_COMMAND, JSON.stringify(payload), false);
  });
}

// ===============================
// HTTP wrapper für ioBroker httpPost (Promise)
// ===============================
function httpPostP(url, body, options) {
  return new Promise((resolve, reject) => {
    httpPost(url, body, options, (error, response) => {
      if (error) return reject(error);
      return resolve(response);
    });
  });
}

// ===============================
// UI helper: Select JSON bauen (Material Design Select)
// ===============================
// Einmal pro Abruf schreiben: Die Liste wird beim Warten auf eine neue
// Nachricht mehrfach geholt, ein Schreibvorgang pro Eintrag wäre zu viel.
function selectOption(text, subText = "", value = "", icon = "phone-message-outline", iconColor = "red") {
  return { text, subText, value, icon, iconColor };
}

function setSelectOptions(options) {
  setState(DP_Fritzbox_AnrufbeantworterIndexMessage_json, JSON.stringify(options), true);
}

// ===============================
// WAV helper
// ===============================
function isValidWav(wavBytes) {
  if (!(wavBytes instanceof Uint8Array) || wavBytes.length < 44) return false;
  function readAscii(offset, length) {
    return String.fromCharCode(...wavBytes.slice(offset, offset + length));
  }
  const riff = readAscii(0, 4);
  const wave = readAscii(8, 4);
  const fmt = readAscii(12, 4);
  let dataChunkOffset = -1;
  for (let i = 0; i < wavBytes.length - 4; i++) {
    if (readAscii(i, 4) === "data") {
      dataChunkOffset = i;
      break;
    }
  }
  return riff === "RIFF" && wave === "WAVE" && fmt === "fmt " && dataChunkOffset !== -1;
}

// ioBroker helper: Tempfile (kommt aus deinem ursprünglichen Script-Kontext; falls vorhanden)
function createTempFileSafe(filename, data) {
  // Falls du schon createTempFile() in deinem System hast, nutze die:
  if (typeof createTempFile === "function") return createTempFile(filename, data);

  // Fallback: in /tmp schreiben (kann je nach ioBroker Umgebung variieren)
  const tmp = `/tmp/${Date.now()}_${filename}`;
  fs.writeFileSync(tmp, Buffer.from(data));
  return tmp;
}

// ===============================
// TAM: Nachrichten-Helfer
// ===============================
// Datum der FRITZ!Box im Format "08.06.25 19:02" -> Millisekunden (0 wenn unlesbar)
function parseTamDate(dateStr) {
  const [datePart, timePart] = String(dateStr || "").trim().split(" ");
  if (!datePart || !timePart) return 0;

  const [day, month, year] = datePart.split(".");
  const [hour, minute] = timePart.split(":");
  if (!day || !month || !year || !hour || !minute) return 0;

  const fullYear = parseInt("20" + year, 10);
  return new Date(fullYear, parseInt(month, 10) - 1, parseInt(day, 10), parseInt(hour, 10), parseInt(minute, 10)).getTime();
}

// Eindeutiger Schlüssel einer Nachricht. Der Index allein reicht nicht, die
// FRITZ!Box vergibt ihn nach einiger Zeit neu (beobachtet: Sprung von 242 auf
// 154). Das Feld "New" taugt auch nicht: Es wird beim Abhören am Telefon
// zurückgesetzt.
function messageKey(msg) {
  return ["Date", "Index", "Number", "Duration"].map((f) => String(msg?.[f]?.[0] ?? "").trim()).join("|");
}

// ===============================
// Verarbeitete Nachrichten merken
// ===============================
// null = noch nie initialisiert (oder unlesbar)
function loadProcessedKeys() {
  const raw = getState(DP_Fritzbox_AnrufbeantworterProcessedMessages)?.val;
  if (raw === null || raw === undefined || raw === "") return null;

  const arr = safeJsonParse(raw);
  if (!Array.isArray(arr)) {
    log("[TAM] Liste der verarbeiteten Nachrichten unlesbar, wird neu angelegt", "warn");
    return null;
  }
  return new Set(arr);
}

function saveProcessedKeys(processed, messages) {
  let keys = [...processed];
  // Nur Schlüssel behalten, die noch auf dem AB liegen: Gelöschte Nachrichten
  // kommen nicht wieder, so wächst die Liste nicht unbegrenzt. Bei einer leeren
  // Liste nichts wegwerfen, die könnte auch ein Aussetzer der FRITZ!Box sein.
  if (messages.length > 0) {
    const current = new Set(messages.map(messageKey));
    keys = keys.filter((k) => current.has(k));
  }
  setState(DP_Fritzbox_AnrufbeantworterProcessedMessages, JSON.stringify(keys), true);
}

// ===============================
// TAM Workflow Engine (Mutex gegen Parallelität)
// ===============================
let workflowRunning = false;
// Aufruf, der während eines Laufs kam. Nicht verwerfen: Ein zweiter Anruf,
// während der erste noch auf seine Nachricht wartet, bringt eine weitere.
let workflowRerun = null;
let workflowRetries = 0;
let workflowRetryTimer = null;

async function runTamWorkflow(tamIndex, waitForNew = false) {
  if (workflowRunning) {
    workflowRerun = { tamIndex, waitForNew: waitForNew || !!workflowRerun?.waitForNew };
    if (debug) console.log(`[TAM] Workflow läuft bereits, danach erneut (tamIndex=${tamIndex})`);
    return;
  }
  workflowRunning = true;

  try {
    let next = { tamIndex, waitForNew };
    while (next) {
      workflowRerun = null;
      try {
        await processNewTamMessages(next.tamIndex, next.waitForNew);
        workflowRetries = 0;
      } catch (e) {
        const msg = String(e.message || e);
        const soapNichtBereit = /DISCOVERY_NOT_READY|Timeout waiting for SOAP_result/.test(msg);
        if (soapNichtBereit && workflowRetries < WORKFLOW_RETRY_MAX) {
          workflowRetries++;
          log(
            `[TAM] SOAP Worker noch nicht bereit (${msg.split(":")[0]}), neuer Versuch in ${WORKFLOW_RETRY_MS / 1000} s ` +
              `(${workflowRetries}/${WORKFLOW_RETRY_MAX})`,
            "info"
          );
          const again = next;
          if (!workflowRetryTimer) {
            workflowRetryTimer = setTimeout(() => {
              workflowRetryTimer = null;
              runTamWorkflow(again.tamIndex, again.waitForNew);
            }, WORKFLOW_RETRY_MS);
          }
        } else {
          log(`[TAM] Workflow Fehler: ${msg}`, "error");
        }
      }
      next = workflowRerun;
    }
  } finally {
    workflowRunning = false;
  }
}

// ===============================
// SOAP: DeleteMessage (optional genutzt)
// ===============================
async function deleteTamMessage(tamIndex, messageIndex) {
  const cmd = {
    service: "urn:dslforum-org:service:X_AVM-DE_TAM:1",
    action: "DeleteMessage",
    params: {
      NewIndex: String(tamIndex),
      NewMessageIndex: String(messageIndex),
    },
    timeoutMs: 10000,
  };

  const r = await soapCall(cmd, 15000);
  if (debug) console.log("[TAM] DeleteMessage result:", JSON.stringify(r.data));
  return r.data;
}

// ===============================
// Kernfunktion: alle noch nicht verarbeiteten Nachrichten abarbeiten
// ===============================
async function processNewTamMessages(tamIndex, waitForNew) {
  const deadline = Date.now() + (waitForNew ? POLL_MAX_MS : 0);
  let list;
  let processed;
  let pending;

  for (;;) {
    list = await fetchTamMessageList(tamIndex);

    processed = loadProcessedKeys();
    if (processed === null) {
      // Erster Lauf: Alles, was schon auf dem AB liegt, gilt als verarbeitet.
      // Sonst kämen Transkripte und Meldungen für alle alten Nachrichten.
      processed = new Set(list.messages.map(messageKey));
      saveProcessedKeys(processed, list.messages);
      log(`[TAM] Erster Lauf: ${processed.size} vorhandene Nachrichten als verarbeitet markiert`, "info");
      return;
    }

    pending = list.messages.filter((msg) => !processed.has(messageKey(msg)));
    if (pending.length > 0 || Date.now() >= deadline) break;
    await wait(POLL_INTERVAL_MS);
  }

  if (pending.length === 0) {
    if (debug && waitForNew) console.log("[TAM] Keine neue Nachricht gefunden (vor dem Signalton aufgelegt?)");
    return;
  }

  // Älteste zuerst, damit die Meldungen in der richtigen Reihenfolge kommen
  pending.sort((a, b) => parseTamDate(a?.Date?.[0]) - parseTamDate(b?.Date?.[0]));

  if (pending.length > MAX_NEW_PER_RUN) {
    const skipped = pending.splice(0, pending.length - MAX_NEW_PER_RUN);
    skipped.forEach((msg) => processed.add(messageKey(msg)));
    log(
      `[TAM] ${skipped.length + pending.length} unverarbeitete Nachrichten, nur die neuesten ${pending.length} werden transkribiert`,
      "warn"
    );
  }

  for (const [i, msg] of pending.entries()) {
    if (i > 0) await wait(PAUSE_BETWEEN_MESSAGES_MS);
    try {
      await processTamMessage(msg, list);
      processed.add(messageKey(msg));
      saveProcessedKeys(processed, list.messages);
    } catch (e) {
      // Nicht als verarbeitet merken, beim nächsten Lauf gibt es einen neuen Versuch
      log(`[TAM] Nachricht ${msg?.Index?.[0]} nicht verarbeitet: ${String(e.message || e)}`, "error");
    }
  }

  saveProcessedKeys(processed, list.messages);
}

// ===============================
// GetMessageList -> calllist.xml -> parse, dazu die Anzeige-DPs aktualisieren
// ===============================
async function fetchTamMessageList(tamIndex) {
  const parseString = require("xml2js").parseString;

  // 1) SOAP GetMessageList via Worker
  const cmd = {
    service: "urn:dslforum-org:service:X_AVM-DE_TAM:1",
    action: "GetMessageList",
    params: { NewIndex: String(tamIndex) }, // !!! ohne trailing space
    timeoutMs: 10000,
  };

  if (debug) console.log("[TAM] SOAP GetMessageList cmd:" + JSON.stringify(cmd));
  const soapRes = await soapCall(cmd, 15000);

  // Worker liefert JSON. Wir erwarten NewURL als String.
  const newUrl = soapRes?.data?.NewURL;
  if (!newUrl) {
    throw new Error(`GetMessageList: NewURL fehlt. data=${JSON.stringify(soapRes.data)}`);
  }

  // 2) sid/tamindex extrahieren
  const fullCalllistUrl = new URL(String(newUrl));
  const sid = fullCalllistUrl.searchParams.get("sid");
  if (sid) setState(DP_Fritzbox_SessionId, sid, true);

  const baseUrl = fullCalllistUrl.origin + fullCalllistUrl.pathname; // ohne Query

  if (debug) console.log(`[TAM] baseUrl=${baseUrl} tamIndex=${tamIndex}`);

  // 3) calllist.xml holen (FRITZ!Box docu verlangt POST sid + tamindex, geht aber auch per GET)
  const postBody = `sid=${encodeURIComponent(sid)}&tamindex=${encodeURIComponent(tamIndex)}`;

  const callListResp = await httpPostP(
    baseUrl, // robust: lieber baseUrl nutzen statt full newUrl
    postBody,
    {
      timeout: 10000,
      validateCertificate: false,
      headers: {
        "User-Agent": "iobroker-javascript",
        "Accept": "*/*",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  if (callListResp.statusCode !== 200) {
    throw new Error(`CallList HTTP ${callListResp.statusCode}`);
  }

  const xml = String(callListResp.data || "");

  // Anzahl Calls aus Kommentar "<!-- tam calls:X -->"
  const m = /<!--\s*tam calls:\s*(\d+)\s*-->/i.exec(xml);
  const tamCalls = m ? parseInt(m[1], 10) : 0;

  setState(DP_Fritzbox_AnrufbeantworterGesamtAnzahlNachrichten, tamCalls, true);

  // 4) XML -> JSON (xml2js)
  const parsed = await new Promise((resolve, reject) => {
    parseString(
      xml,
      { explicitArray: true, mergeAttrs: true },
      (err, result) => (err ? reject(err) : resolve(result))
    );
  });

  // Nicht die ganze Liste loggen: Sie enthält Namen und Nummern aller Anrufer,
  // und beim Warten auf eine neue Nachricht wird sie mehrfach geholt.
  const messages = Array.isArray(parsed?.Root?.Message) ? parsed.Root.Message.slice() : [];
  if (debug) console.log(`[TAM] tam calls=${tamCalls}, Nachrichten in der Liste: ${messages.length}`);

  const list = { messages, sid, origin: fullCalllistUrl.origin };

  // 5) Wenn keine Nachrichten
  if (!tamCalls || tamCalls === 0 || messages.length === 0) {
    const placeholder =
      '[{"Index":["---"],"Tam":["---"],"Called":["---"],"Date":["---"],"Duration":["---"],"Inbook":["---"],"Name":["---"],"New":["---"],"Number":["---"],"Path":["---"]}]';

    setState(DP_Fritzbox_AnrufbeantworterAnzahlNeueNachrichten, 0, true);
    setState(DP_Fritzbox_AnrufbeantworterDaten_json, placeholder, true);
    setSelectOptions([selectOption("Keine Nachricht vorhanden", "", "", "phone-message-outline", "red")]);
    list.messages = [];
    return list;
  }

  // 6) Daten setzen (vereinfachter als früher: wir speichern das komplette parsed JSON als string)
  setState(DP_Fritzbox_AnrufbeantworterDaten_json, JSON.stringify(parsed), true);

  // 7) Index-Liste für UI + Anzahl neue Nachrichten, neueste oben
  let newCount = 0;
  const options = [];
  const sorted = messages.slice().sort((a, b) => parseTamDate(b?.Date?.[0]) - parseTamDate(a?.Date?.[0]));

  for (const msg of sorted) {
    const idx = String(msg?.Index?.[0] || "").trim();
    if (!idx) continue;

    const name = String(msg?.Name?.[0] || "").trim();
    const number = String(msg?.Number?.[0] || "").trim();
    const date = String(msg?.Date?.[0] || "").trim();
    const duration = String(msg?.Duration?.[0] || "").trim();
    const isNew = String(msg?.New?.[0] || "0") === "1";

    if (isNew) newCount++;

    // text: bevorzugt Name, sonst Nummer, sonst "Unbekannt"
    const text = name || number || `Nachricht ${idx}`;

    // subText: Datum + Dauer + Marker
    const flags = [];
    if (isNew) flags.push("NEU");
    const subText = [date, duration, flags.join(" ")].filter(Boolean).join(" • ");

    // farblich neu/alt unterscheiden
    const iconColor = isNew ? "red" : "gray";

    options.push(selectOption(text, subText, idx, "phone-message-outline", iconColor));
  }

  setSelectOptions(options);
  setState(DP_Fritzbox_AnrufbeantworterAnzahlNeueNachrichten, newCount, true);

  return list;
}

// ===============================
// Eine Nachricht: Latest-DPs setzen -> WAV herunterladen -> transkribieren
// ===============================
async function processTamMessage(msg, list) {
  const index = parseInt(msg?.Index?.[0], 10);
  setState(DP_Fritzbox_AnrufbeantworterLatestMessageIndex, index, true);

  // flatten arrays (Key -> first element)
  const flattened = Object.fromEntries(Object.entries(msg).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  setState(DP_Fritzbox_AnrufbeantworterLatestMessageData, JSON.stringify(flattened), true);

  const pathRel = msg?.Path?.[0];
  if (!pathRel) throw new Error("Message Path missing");

  // Download URL (Message) – host aus calllist URL
  const messageUrl = `${list.origin}${pathRel}`;
  setState(DP_Fritzbox_AnrufbeantworterLatestMessagePath, messageUrl, true);

  if (debug) console.log(`[TAM] Verarbeite Nachricht index=${index} vom ${flattened.Date}`);

  // WAV herunterladen
  const wavResp = await httpPostP(
    messageUrl,
    `sid=${encodeURIComponent(list.sid)}`,
    {
      timeout: 10000,
      responseType: "arraybuffer",
      validateCertificate: false,
      headers: {
        "User-Agent": "iobroker-javascript",
        "Accept": "*/*",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  if (wavResp.statusCode !== 200) {
    throw new Error(`WAV download HTTP ${wavResp.statusCode}`);
  }

  const byteArray = new Uint8Array(wavResp.data);
  if (!isValidWav(byteArray)) {
    log("[TAM] Download scheint keine gültige WAV zu sein (Header-Check fehlgeschlagen)", "warn");
  } else if (debug) {
    log("[TAM] WAV Header OK", "info");
  }

  // Eigener Dateiname je Nachricht: Werden mehrere nacheinander verarbeitet,
  // darf die nächste die Datei nicht überschreiben, bevor sie verschickt ist.
  const tempFilePath = createTempFileSafe(`message_${index}_${Date.now()}.wav`, wavResp.data);
  setState(DP_Fritzbox_AnrufbeantworterLatestMessageLocalPath, tempFilePath, true);
  if (debug) console.log(`[TAM] WAV gespeichert: ${tempFilePath}`);

  // Optional: Transcribe
  let transcript;
  const transcribeEnabled = !!getState(DP_Fritzbox_AnrufbeantworterLatestMessageEnableTranskription).val;
  if (!transcribeEnabled) {
    transcript = "Transkription deaktiviert";
    if (debug) console.log("[TAM] Transkription deaktiviert");
  } else if (!AZURE_KEY || AZURE_KEY === "PUT_YOUR_KEY_HERE" || AZURE_KEY === "fill_your_own_key_here") {
    transcript = "Azure Key fehlt – Transkription nicht möglich";
  } else {
    transcript = await transcribeWithAzure(tempFilePath);
  }

  // Erst die Metadaten, dann das Transkript: Wer auf das Transkript reagiert,
  // liest die Metadaten im selben Moment.
  setState(DP_Fritzbox_AnrufbeantworterLatestMessageTranskript, transcript, true);

  // Ändert sich bei jeder Nachricht, auch wenn zwei Transkripte gleich lauten
  // (z. B. "Transkript leer").
  setState(
    DP_Fritzbox_AnrufbeantworterLastProcessedMessage,
    JSON.stringify({
      key: messageKey(msg),
      index,
      date: flattened.Date,
      name: flattened.Name,
      number: flattened.Number,
      duration: flattened.Duration,
      transcript,
      localPath: tempFilePath,
      url: messageUrl,
      processedAt: new Date().toISOString(),
    }),
    true
  );
}

// ===============================
// Azure Transcribe
// ===============================
// Liefert das Transkript oder eine Fehlermeldung als Text.
async function transcribeWithAzure(tempFilePath) {
  for (let versuch = 0; ; versuch++) {
    const nochmal = versuch < AZURE_RETRY_DELAYS_MS.length;
    const pause = AZURE_RETRY_DELAYS_MS[versuch];

    // Das Formular je Versuch neu bauen: Der Datei-Stream ist nach einem
    // Versuch verbraucht.
    const data = new FormData();
    data.append("definitions", JSON.stringify({ locales: [TAM_EXPECTED_LANGUAGE], profanityFilterMode: "None" }));
    data.append("audio", fs.createReadStream(tempFilePath));

    if (debug) console.log(`[TAM] Azure transcribe POST...${versuch ? ` (Versuch ${versuch + 1})` : ""}`);

    let response;
    try {
      response = await axios({
        method: "post",
        url: AZURE_TRANSCRIBE_URL,
        headers: {
          "Ocp-Apim-Subscription-Key": AZURE_KEY,
          "User-Agent": "iobroker-javascript",
          "Accept": "*/*",
          ...data.getHeaders(),
        },
        data,
        httpsAgent: AZURE_HTTPS_AGENT,
        timeout: 60000,
        validateStatus: () => true,
      });
    } catch (e) {
      if (nochmal) {
        log(`[TAM] Azure Request Fehler: ${String(e.message || e)}, neuer Versuch in ${pause / 1000} s`, "warn");
        await wait(pause);
        continue;
      }
      log(`[TAM] Azure Request Fehler: ${String(e.message || e)}`, "error");
      return "Transkription fehlgeschlagen (Request Error)";
    }

    if ((response.status === 429 || response.status >= 500) && nochmal) {
      log(`[TAM] Azure HTTP ${response.status}, neuer Versuch in ${pause / 1000} s`, "warn");
      await wait(pause);
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      const details = JSON.stringify(response.data);
      log(`[TAM] Azure HTTP ${response.status} data=${details}`, "error");
      if (response.status === 401) return "Azure permission denied; Transkription fehlgeschlagen";
      if (response.status === 400) return "Ungültige Anfrage (400); Transkription fehlgeschlagen";
      return "Transkription fehlgeschlagen (Azure HTTP Fehler)";
    }

    const text = response.data?.combinedPhrases?.[0]?.text || "";
    if (debug) console.log("[TAM] Azure transcript:" + text);

    return text === "" ? "Transkript leer" : text;
  }
}

// ===============================
// Trigger: DeleteMessage DP
// ===============================
on({ id: DP_Fritzbox_AnrufbeantworterDeleteMessage, change: "any" }, async () => {
  const val = String(getState(DP_Fritzbox_AnrufbeantworterDeleteMessage).val || "").trim();
  if (!val) return;

  const idx = parseInt(val, 10);
  if (!Number.isFinite(idx)) {
    log(`[TAM] DeleteMessage: ungültiger Index '${val}'`, "warn");
    return;
  }

  try {
    await deleteTamMessage(DEFAULT_TAM_INDEX, idx);
    await runTamWorkflow(DEFAULT_TAM_INDEX, false);
  } catch (e) {
    log(`[TAM] DeleteMessage Fehler: ${String(e.message || e)}`, "error");
  }
});

// ===============================
// Trigger: Manueller Button "DatenAktualisieren"
// ===============================
on({ id: DP_Fritzbox_AnrufbeantworterDatenAktualisieren, change: "any" }, async () => {
  await runTamWorkflow(DEFAULT_TAM_INDEX, false);
});

// ===============================
// Trigger: CallMonitor DISCONNECT -> wenn TAM (Port 40-49) -> Workflow
// ===============================
on({ id: DP_CM_EVENT, change: "ne" }, async (obj) => {
  const evt = safeJsonParse(obj?.state?.val);
  if (!evt) return;

  if (evt.type !== "DISCONNECT") return;

  // kleine Verzögerung, damit LastCall sicher geschrieben ist. Auf die neue
  // Nachricht selbst wartet runTamWorkflow (POLL_INTERVAL_MS/POLL_MAX_MS),
  // dafür war hier zwischenzeitlich wait(5000) eingebaut.
  await wait(300);

  const lastCall = safeJsonParse(getState(DP_CM_LASTCALL).val) || {};

  // TAM-Erkennung: extension 40..49 oder connectPortHint === "TAM"
  const ext = Number(lastCall.extension);
  const isTAM = lastCall.connectPortHint === "TAM" || (Number.isFinite(ext) && ext >= 40 && ext <= 49);

  if (!isTAM) {
    if (debug) {
      const caller = lastCall.caller || lastCall.connectedNumber || "";
      console.log(`[CM] DISCONNECT (non-TAM) ext=${lastCall.extension} caller=${caller} dur=${lastCall.durationSec}`);
    }
    return;
  }

  const tamIndex = Number.isFinite(ext) ? (ext - 40) : DEFAULT_TAM_INDEX;

  if (debug) {
    const caller = lastCall.caller || lastCall.connectedNumber || "";
    console.log(`[CM] DISCONNECT (TAM) ext=${lastCall.extension} -> tamIndex=${tamIndex} caller=${caller}`);
  }

  await runTamWorkflow(tamIndex, true);
});
