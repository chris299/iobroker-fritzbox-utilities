/**
 * version 2025-12-27
 *
 * ioBroker Script B: FRITZ!Box Anrufbeantworter mit Azure Transkription (via SOAP Worker)
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

// Standard-TAM (Fallback), falls kein ext 40-49 erkennbar
const DEFAULT_TAM_INDEX = 1;

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

  if (!getState(DP_Fritzbox_AnrufbeantworterLatestMessageEnableTranskription).val) {
    setState(DP_Fritzbox_AnrufbeantworterLatestMessageTranskript, "Transkription deaktiviert", true);
  }

  await logMissingPrerequisiteDatapoints();
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
function setSelectOptionsEmpty() {
  setState(DP_Fritzbox_AnrufbeantworterIndexMessage_json, "", true);
}

function pushSelectOption(text, subText = "", value = "", icon = "phone-message-outline", iconColor = "red") {
  let json = getState(DP_Fritzbox_AnrufbeantworterIndexMessage_json).val;
  let arr = [];
  if (json) {
    try {
      arr = JSON.parse(json);
      if (!Array.isArray(arr)) arr = [];
    } catch (_) {
      arr = [];
    }
  }
  arr.push({ text, subText, value, icon, iconColor });
  setState(DP_Fritzbox_AnrufbeantworterIndexMessage_json, JSON.stringify(arr), true);
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
// TAM: parse newest message
// ===============================
function getNewestMessageIndexByDate(data) {
  const messages = data?.Root?.Message;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  let newestMessage = null;
  let newestDate = null;

  messages.forEach((msg) => {
    const dateStr = msg?.Date?.[0];
    if (!dateStr) return;

    // Format: "08.06.25 19:02"
    const [datePart, timePart] = dateStr.split(" ");
    if (!datePart || !timePart) return;

    const [day, month, year] = datePart.split(".");
    const [hour, minute] = timePart.split(":");
    if (!day || !month || !year || !hour || !minute) return;

    const fullYear = parseInt("20" + year, 10);
    const date = new Date(fullYear, parseInt(month, 10) - 1, parseInt(day, 10), parseInt(hour, 10), parseInt(minute, 10));

    if (!newestDate || date > newestDate) {
      newestDate = date;
      newestMessage = msg;
    }
  });

  if (debug) console.log(`[TAM] latest Message: ${newestDate ? newestDate.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : "N/A"}`);
  
  return newestMessage ? parseInt(newestMessage.Index[0], 10) : null;
}

// ===============================
// TAM Workflow Engine (Mutex gegen Parallelität)
// ===============================
let workflowRunning = false;

async function runTamWorkflow(tamIndex) {
  if (workflowRunning) {
    if (debug) console.log(`[TAM] Workflow läuft bereits, skip (tamIndex=${tamIndex})`);
    return;
  }
  workflowRunning = true;

  try {
    await refreshTamMessageListAndMaybeTranscribe(tamIndex);
  } catch (e) {
    log(`[TAM] Workflow Fehler: ${String(e.message || e)}`, "error");
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
// Kernfunktion: GetMessageList -> calllist.xml -> parse -> newest -> download -> transcribe
// ===============================
async function refreshTamMessageListAndMaybeTranscribe(tamIndex) {
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

  if (debug) console.log(`[TAM] NewURL=${newUrl}`);
  if (debug) console.log(`[TAM] baseUrl=${baseUrl} sid=${sid} tamIndex=${tamIndex}`);

  // 3) calllist.xml holen (FRITZ!Box docu verlangt POST sid + tamindex, geht aber auch per GET)
  setSelectOptionsEmpty();

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

  //if (debug) console.log("[TAM] Get tam CallList response raw:");
  //if (debug) console.log(xml);


  // Anzahl Calls aus Kommentar "<!-- tam calls:X -->"
  const m = /<!--\s*tam calls:\s*(\d+)\s*-->/i.exec(xml);
  const tamCalls = m ? parseInt(m[1], 10) : 0;

  if (debug) console.log(`[TAM] tam calls=${tamCalls}`);
  setState(DP_Fritzbox_AnrufbeantworterGesamtAnzahlNachrichten, tamCalls, true);

  // 4) XML -> JSON (xml2js)
  const parsed = await new Promise((resolve, reject) => {
    parseString(
      xml,
      { explicitArray: true, mergeAttrs: true },
      (err, result) => (err ? reject(err) : resolve(result))
    );
  });

  if (debug) console.log("[TAM] calllist JSON:"+  JSON.stringify(parsed));

  // 5) Wenn keine Nachrichten
  if (!tamCalls || tamCalls === 0 || !parsed?.Root?.Message) {
    const placeholder =
      '[{"Index":["---"],"Tam":["---"],"Called":["---"],"Date":["---"],"Duration":["---"],"Inbook":["---"],"Name":["---"],"New":["---"],"Number":["---"],"Path":["---"]}]';

    setState(DP_Fritzbox_AnrufbeantworterAnzahlNeueNachrichten, 0, true);
    setState(DP_Fritzbox_AnrufbeantworterDaten_json, placeholder, true);
    pushSelectOption("Keine Nachricht vorhanden", "", "", "phone-message-outline", "red");
    return;
  }

  // 6) Daten setzen (vereinfachter als früher: wir speichern das komplette parsed JSON als string)
  setState(DP_Fritzbox_AnrufbeantworterDaten_json, JSON.stringify(parsed), true);

  // 7) Neueste Message finden
  const newestIndex = getNewestMessageIndexByDate(parsed);
  if (newestIndex === null || newestIndex === undefined) {
    throw new Error("Konnte neueste Message nicht bestimmen (Date parsing?)");
  }

  setState(DP_Fritzbox_AnrufbeantworterLatestMessageIndex, newestIndex, true);

  const latestMsg = parsed.Root.Message.find((msg) => msg?.Index?.[0] === String(newestIndex));
  if (!latestMsg) throw new Error("Latest message not found in parsed list");

  // flatten arrays (Key -> first element)
  const flattened = Object.fromEntries(Object.entries(latestMsg).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  setState(DP_Fritzbox_AnrufbeantworterLatestMessageData, JSON.stringify(flattened), true);

  const pathRel = latestMsg?.Path?.[0];
  if (!pathRel) throw new Error("Latest message Path missing");

  // Download URL (Message) – host aus calllist URL
  const latestMessageUrl = `${fullCalllistUrl.origin}${pathRel}`;
  setState(DP_Fritzbox_AnrufbeantworterLatestMessagePath, latestMessageUrl, true);

  if (debug) console.log(`[TAM] Latest message index=${newestIndex} url=${latestMessageUrl}`);

  // 8) Index-Liste für UI + Anzahl neue Nachrichten
  let newCount = 0;

  // optional: sortiere nach Datum absteigend (neueste oben)
  const messages = Array.isArray(parsed?.Root?.Message) ? parsed.Root.Message.slice() : [];
  messages.sort((a, b) => {
    const da = String(a?.Date?.[0] || "");
    const db = String(b?.Date?.[0] || "");
    // simple: lexikalisch ist bei "DD.MM.YY HH:MM" NICHT sicher korrekt,
    // daher grob: wir parsen wie in getNewestMessageIndexByDate
    const toDate = (s) => {
      const [d, t] = s.split(" ");
      if (!d || !t) return 0;
      const [day, mon, yy] = d.split(".");
      const [hh, mm] = t.split(":");
      if (!day || !mon || !yy || !hh || !mm) return 0;
      const fullYear = parseInt("20" + yy, 10);
      return new Date(fullYear, parseInt(mon, 10) - 1, parseInt(day, 10), parseInt(hh, 10), parseInt(mm, 10)).getTime();
    };
  return toDate(db) - toDate(da);
  });

  for (const msg of messages) {
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

    pushSelectOption(text, subText, idx, "phone-message-outline", iconColor);
  }

  setState(DP_Fritzbox_AnrufbeantworterAnzahlNeueNachrichten, newCount, true);


  // 9) WAV herunterladen
  const wavResp = await httpPostP(
    latestMessageUrl,
    `sid=${encodeURIComponent(sid)}`,
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

  const tempFilePath = createTempFileSafe("message.wav", wavResp.data);
  setState(DP_Fritzbox_AnrufbeantworterLatestMessageLocalPath, tempFilePath, true);
  if (debug) console.log(`[TAM] WAV gespeichert: ${tempFilePath}`);

  // 10) Optional: Transcribe
  const transcribeEnabled = !!getState(DP_Fritzbox_AnrufbeantworterLatestMessageEnableTranskription).val;
  if (!transcribeEnabled) {
    setState(DP_Fritzbox_AnrufbeantworterLatestMessageTranskript, "Transkription deaktiviert", true);
    if (debug) console.log("[TAM] Transkription deaktiviert");
    return;
  }

  if (!AZURE_KEY || AZURE_KEY === "PUT_YOUR_KEY_HERE") {
    setState(DP_Fritzbox_AnrufbeantworterLatestMessageTranskript, "Azure Key fehlt – Transkription nicht möglich", true);
    return;
  }

  await transcribeWithAzure(tempFilePath);
}

// ===============================
// Azure Transcribe
// ===============================
async function transcribeWithAzure(tempFilePath) {
  const data = new FormData();
  data.append("definitions", JSON.stringify({ locales: [TAM_EXPECTED_LANGUAGE], profanityFilterMode: "None" }));
  data.append("audio", fs.createReadStream(tempFilePath));

  if (debug) console.log("[TAM] Azure transcribe POST...");

  try {
    const response = await axios({
      method: "post",
      url: AZURE_TRANSCRIBE_URL,
      headers: {
        "Ocp-Apim-Subscription-Key": AZURE_KEY,
        "User-Agent": "iobroker-javascript",
        "Accept": "*/*",
        "Connection": "keep-alive",
        ...data.getHeaders(),
      },
      data,
      timeout: 60000,
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      const details = JSON.stringify(response.data);
      log(`[TAM] Azure HTTP ${response.status} data=${details}`, "error");
      if (response.status === 401) {
        setState(DP_Fritzbox_AnrufbeantworterLatestMessageTranskript, "Azure permission denied; Transkription fehlgeschlagen", true);
      } else if (response.status === 400) {
        setState(DP_Fritzbox_AnrufbeantworterLatestMessageTranskript, "Ungültige Anfrage (400); Transkription fehlgeschlagen", true);
      } else {
        setState(DP_Fritzbox_AnrufbeantworterLatestMessageTranskript, "Transkription fehlgeschlagen (Azure HTTP Fehler)", true);
      }
      return;
    }

    const text = response.data?.combinedPhrases?.[0]?.text || "";
    if (debug) console.log("[TAM] Azure transcript:" + text);

    setState(
      DP_Fritzbox_AnrufbeantworterLatestMessageTranskript,
      text === "" ? "Transkript leer" : text,
      true
    );
  } catch (e) {
    log(`[TAM] Azure Request Fehler: ${String(e.message || e)}`, "error");
    setState(DP_Fritzbox_AnrufbeantworterLatestMessageTranskript, "Transkription fehlgeschlagen (Request Error)", true);
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
    await runTamWorkflow(DEFAULT_TAM_INDEX);
  } catch (e) {
    log(`[TAM] DeleteMessage Fehler: ${String(e.message || e)}`, "error");
  }
});

// ===============================
// Trigger: Manueller Button "DatenAktualisieren"
// ===============================
on({ id: DP_Fritzbox_AnrufbeantworterDatenAktualisieren, change: "any" }, async () => {
  await runTamWorkflow(DEFAULT_TAM_INDEX);
});

// ===============================
// Trigger: CallMonitor DISCONNECT -> wenn TAM (Port 40-49) -> Workflow
// ===============================
on({ id: DP_CM_EVENT, change: "ne" }, async (obj) => {
  const evt = safeJsonParse(obj?.state?.val);
  if (!evt) return;

  if (evt.type !== "DISCONNECT") return;

  // kleine Verzögerung, damit LastCall sicher geschrieben ist
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

  await runTamWorkflow(tamIndex);
});
