// =====================================================
// FRITZ!Box CallMonitor -> LastEvent + LastCall Kontext
// =====================================================
// version 2025-12-27
//
// Dieses Script verbindet sich mit dem FRITZ!Box CallMonitor 
// (Port 1012) und schreibt die letzten Events in Datenpunkte.
// Wichtig: Der CallMonitor muss in der FRITZ!Box aktiviert sein!
// (Telefonie -> Ereignisse -> CallMonitor aktivieren)
// Eine Authentifizierung ist nicht notwendig.
//
// Es werden zwei Datenpunkte gepflegt: 
//  
// DP_LAST_EVENT:  letztes Event (JSON string)
// DP_LAST_CALL:   aktueller/letzter Call-Kontext (JSON string)
//
// Call-Kontext wird nach Call-ID (id) gepflegt:
// - RING / CALL starten Kontext
// - CONNECT ergänzt Kontext (z.B. connectedNumber / extension)
// - DISCONNECT finalisiert Kontext (durationSec, endedAt)
//
// =====================================================

const net = require("net");

const DP_LAST_EVENT = "0_userdata.0.Fritzbox.Fritzbox_CallMonitor";
const DP_LAST_CALL  = "0_userdata.0.Fritzbox.Fritzbox_LastCall";
const fritzIP = "192.168.246.4";
const CM_PORT = 1012;

let client = null;
let buffer = "";
let reconnectTimer = null;
let reconnectDelayMs = 1000;

// In-Memory Call-Map: id -> callContext
const callsById = Object.create(null);

// Wie lange wir alte Call-IDs im Speicher behalten (falls Events verspätet kommen)
const CALL_TTL_MS = 10 * 60 * 1000; // 10 Minuten

function ensureDatapoint(id, name) {
  if (!existsState(id)) {
    createState(id, "", {
      name,
      type: "string",
      role: "text",
      read: true,
      write: false,
      desc: name,
    });
  }
}

function parseCallMonitorLine(line) {
  const parts = line.split(";");
  const dt = (parts[0] || "").trim();
  const type = (parts[1] || "").trim();

  const evt = {
    ts: new Date().toISOString(),
    raw: line,
    fritzDateTime: dt,
    type,
  };

  if (type === "RING") {
    // RING;id;caller;called;line
    evt.id = parts[2] || "";
    evt.caller = parts[3] || "";
    evt.called = parts[4] || "";
    evt.line = parts[5] || "";
  } else if (type === "CALL") {
    // CALL;id;extension;called;caller;line
    evt.id = parts[2] || "";
    evt.extension = parts[3] || "";
    evt.called = parts[4] || "";
    evt.caller = parts[5] || "";
    evt.line = parts[6] || "";
  } else if (type === "CONNECT") {
    // CONNECT;id;extension;number;
    evt.id = parts[2] || "";
    evt.extension = parts[3] || "";
    evt.number = parts[4] || "";
  } else if (type === "DISCONNECT") {
    // DISCONNECT;id;duration;
    evt.id = parts[2] || "";
    evt.durationSec = parts[3] ? Number(parts[3]) : null;
  }

  return evt;
}

function writeJsonState(id, obj) {
  setState(id, JSON.stringify(obj), true);
}

function cleanupOldCalls() {
  const cutoff = Date.now() - CALL_TTL_MS;
  for (const id of Object.keys(callsById)) {
    if ((callsById[id].updatedAtMs || 0) < cutoff) {
      delete callsById[id];
    }
  }
}

function portHintFromExtension(ext) {
  // Du hattest erwähnt: Ports 40-49 -> AB (TAM)
  // Wir können hier nur einen Hinweis liefern (Heuristik).
  const n = Number(ext);
  if (Number.isFinite(n) && n >= 40 && n <= 49) return "TAM";
  return null;
}

function updateCallContextFromEvent(evt) {
  if (!evt.id) return null;

  cleanupOldCalls();

  const id = evt.id;
  const existing = callsById[id] || {
    id,
    createdAt: evt.ts,
    createdAtMs: Date.now(),
  };

  existing.updatedAt = evt.ts;
  existing.updatedAtMs = Date.now();
  existing.lastType = evt.type;

  if (evt.type === "RING") {
    // eingehend
    existing.direction = "inbound";
    existing.caller = evt.caller || existing.caller || "";
    existing.called = evt.called || existing.called || "";
    existing.line = evt.line || existing.line || "";
  }

  if (evt.type === "CALL") {
    // ausgehend
    existing.direction = "outbound";
    existing.extension = evt.extension || existing.extension || "";
    existing.called = evt.called || existing.called || "";
    existing.caller = evt.caller || existing.caller || "";
    existing.line = evt.line || existing.line || "";
    existing.connectPortHint = portHintFromExtension(existing.extension);
  }

  if (evt.type === "CONNECT") {
    existing.extension = evt.extension || existing.extension || "";
    existing.connectedNumber = evt.number || existing.connectedNumber || "";
    existing.connectedAt = evt.ts;
    existing.connectPortHint = portHintFromExtension(existing.extension);
  }

  if (evt.type === "DISCONNECT") {
    existing.durationSec = (evt.durationSec !== undefined) ? evt.durationSec : existing.durationSec;
    existing.endedAt = evt.ts;
    existing.endedAtMs = Date.now();
  }

  callsById[id] = existing;
  return existing;
}

function handleEventLine(line) {
  const evt = parseCallMonitorLine(line);

  // 1) Last raw event
  writeJsonState(DP_LAST_EVENT, evt);

  // 2) Update call context + write LastCall (für CONNECT/DISCONNECT besonders wichtig)
  const ctx = updateCallContextFromEvent(evt);
  if (ctx) {
    writeJsonState(DP_LAST_CALL, ctx);
  }
}

// ---------- Socket/Connection ----------
function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  log(`[CallMonitor] Reconnect geplant in ${reconnectDelayMs}ms (${reason})`, "warn");

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000);
  }, reconnectDelayMs);
}

function connect() {
  try { if (client) client.destroy(); } catch (_) {}
  client = null;
  buffer = "";

  client = new net.Socket();
  client.setKeepAlive(true, 10000);

  client.on("connect", () => {
    log(`[CallMonitor] Verbunden mit ${fritzIP}:${CM_PORT}`, "info");
    reconnectDelayMs = 1000;
  });

  client.on("data", (data) => {
    buffer += data.toString("utf8");

    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);

      line = line.replace(/\r$/, "").trim();
      if (!line) continue;

      try {
        handleEventLine(line);
      } catch (e) {
        log(`[CallMonitor] Fehler beim Verarbeiten der Zeile: ${e.message || e} | line=${line}`, "warn");
      }
    }
  });

  client.on("error", (err) => {
    log(`[CallMonitor] Socket error: ${err.message || err}`, "warn");
    scheduleReconnect("error");
  });

  client.on("close", (hadError) => {
    log(`[CallMonitor] Verbindung geschlossen (hadError=${hadError})`, "warn");
    scheduleReconnect("close");
  });

  client.connect(CM_PORT, fritzIP);
}

function shutdown() {
  try { if (reconnectTimer) clearTimeout(reconnectTimer); } catch (_) {}
  reconnectTimer = null;

  try {
    if (client) {
      client.removeAllListeners();
      client.destroy();
    }
  } catch (_) {}
  client = null;

  log("[CallMonitor] Skript beendet, Socket geschlossen.", "info");
}

// ---------- Start ----------
ensureDatapoint(DP_LAST_EVENT, "FRITZ!Box CallMonitor - letzter Event");
ensureDatapoint(DP_LAST_CALL,  "FRITZ!Box CallMonitor - letzter Call Kontext");
connect();

onStop(shutdown, 2000);

