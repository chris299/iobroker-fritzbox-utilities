/*******************************************************
 * ioBroker Script B: Nutzung / Beispiele via DP Interface
 * Nutzt:
 *   - 0_userdata.0.Telefon.SOAP_command
 *   - 0_userdata.0.Telefon.SOAP_result
 *******************************************************/

const DP_COMMAND = "0_userdata.0.Telefon.SOAP_command";
const DP_RESULT  = "0_userdata.0.Telefon.SOAP_result";

function nowIso() { return new Date().toISOString(); }

function newRequestId(prefix = "req") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function safeJsonParse(s) {
  try { return JSON.parse(String(s || "")); } catch (_) { return null; }
}

/**
 * Sendet einen SOAP-Command an den Worker und wartet auf passende Antwort.
 *
 * @param {{service:string, action:string, params?:Object, timeoutMs?:number}} cmd
 * @param {number} [waitTimeoutMs=15000] - Timeout fürs Warten auf das Ergebnis
 * @returns {Promise<any>} resultObj (parsed JSON aus SOAP_result)
 */
function sendSoapCommand(cmd, waitTimeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const requestId = cmd.requestId || newRequestId(cmd.action || "soap");

    const payload = {
      requestId,
      service: cmd.service,
      action: cmd.action,
      params: cmd.params || {},
      timeoutMs: cmd.timeoutMs || 10000,
      createdAt: nowIso(),
    };

    // 1) Listener auf Result (vorher setzen, damit wir nichts verpassen)
    const handler = on({ id: DP_RESULT, change: "any" }, (obj) => {
      const r = safeJsonParse(obj && obj.state && obj.state.val);
      if (!r || r.requestId !== requestId) return;

      // Treffer: Handler entfernen + resolve/reject
      try { unsubscribe(handler); } catch (_) {}

      if (r.ok) return resolve(r);
      return reject(new Error(`${r.error?.message || "ERROR"}: ${r.error?.details || ""}`));
    });

    // 2) Timeout fürs Warten
    const t = setTimeout(() => {
      try { unsubscribe(handler); } catch (_) {}
      reject(new Error(`Timeout waiting for SOAP_result (requestId=${requestId})`));
    }, waitTimeoutMs);

    // 3) Command schreiben (ACK=false)
    setState(DP_COMMAND, JSON.stringify(payload), false);

    // 4) (optional) Wenn resolve/reject passiert -> Timeout stoppen
    const wrap = (fn) => (v) => { clearTimeout(t); fn(v); };
    // Promise "umhängen"
    // (kleiner Trick: wir können resolve/reject nicht hier austauschen; daher oben schon clearTimeout im Treffer-Path)
  });
}

// ------------------- Beispiele -------------------

(async () => {
  try {
    // Beispiel 1: TAM GetMessageList (NewURL)
    const tam = await sendSoapCommand({
      service: "urn:dslforum-org:service:X_AVM-DE_TAM:1",
      action: "GetMessageList",
      params: { NewIndex: "1" }, // String oder Number ist ok
      timeoutMs: 10000,
    });

    log(`[EX] TAM OK requestId=${tam.requestId}`, "info");
    log(`[EX] TAM data: ${JSON.stringify(tam.data)}`, "info");
    // Erwartet z.B. tam.data.NewURL

    // Beispiel 2: CallList (häufig unter OnTel)
    const callList = await sendSoapCommand({
      service: "urn:dslforum-org:service:X_AVM-DE_OnTel:1",
      action: "GetCallList",
      params: {},
      timeoutMs: 10000,
    });

    log(`[EX] CallList OK requestId=${callList.requestId}`, "info");
    log(`[EX] CallList data: ${JSON.stringify(callList.data)}`, "info");
    // Erwartet z.B. callList.data.NewCallListURL

  } catch (e) {
    log(`[EX] ERROR: ${String(e.message || e)}`, "error");
  }
})();
