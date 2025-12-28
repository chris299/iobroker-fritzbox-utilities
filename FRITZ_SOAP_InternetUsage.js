/*******************************************************
 * ioBroker Script: FRITZ!Box Internetverbrauch (Tag/Monat) via SOAP Worker
 * version: 2025-12-28
 *
 * Benötigt den SOAP Worker (as configued in FRITZ_SOAP_communication.js)
 *   - 0_userdata.0.Fritzbox.SOAP_command
 *   - 0_userdata.0.Fritzbox.SOAP_result
 *
 * Datenquelle:
 *   IGD / UPnP: urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1
 *   Action: GetAddonInfos
 *   Liefert u.a.:
 *     - NewX_AVM_DE_TotalBytesSent64
 *     - NewX_AVM_DE_TotalBytesReceived64
 *
 * WICHTIG:
 *   Der Worker muss /igddesc.xml discovern und authMode:"none" unterstützen
 *   (siehe FRITZ_SOAP_communication.js >= 2025-12-28).
 *******************************************************/

const debug = false;

// SOAP Worker DPs
const DP_SOAP_COMMAND = "0_userdata.0.Fritzbox.SOAP_command";
const DP_SOAP_RESULT = "0_userdata.0.Fritzbox.SOAP_result";

// Ausgabe DPs
const DP_BASE = "0_userdata.0.Fritzbox.InternetTraffic.";

const DP_POLL_NOW = DP_BASE + "pollNow";
const DP_LAST_POLL = DP_BASE + "lastPoll";
const DP_LAST_OK = DP_BASE + "lastOk";
const DP_LAST_ERROR = DP_BASE + "lastError";

const DP_RAW_SENT64 = DP_BASE + "raw.totalBytesSent64";
const DP_RAW_RECV64 = DP_BASE + "raw.totalBytesReceived64";
const DP_RAW_SENDRATE = DP_BASE + "raw.byteSendRate";
const DP_RAW_RECVRATE = DP_BASE + "raw.byteReceiveRate";

const DP_VIRTUAL_SENT = DP_BASE + "calc.virtualBytesSent";
const DP_VIRTUAL_RECV = DP_BASE + "calc.virtualBytesReceived";

const DP_DAY_SENT = DP_BASE + "day.bytesSent";
const DP_DAY_RECV = DP_BASE + "day.bytesReceived";
const DP_DAY_TOTAL = DP_BASE + "day.bytesTotal";
const DP_MONTH_SENT = DP_BASE + "month.bytesSent";
const DP_MONTH_RECV = DP_BASE + "month.bytesReceived";
const DP_MONTH_TOTAL = DP_BASE + "month.bytesTotal";

// Snapshot DPs (written once per day/month on rollover)
const DP_SNAPSHOT_BASE = DP_BASE + "snapshot.";
const DP_SNAP_YESTERDAY_DAYKEY = DP_SNAPSHOT_BASE + "yesterday.dayKey";
const DP_SNAP_YESTERDAY_VALID = DP_SNAPSHOT_BASE + "yesterday.valid";
const DP_SNAP_YESTERDAY_TS = DP_SNAPSHOT_BASE + "yesterday.ts";
const DP_SNAP_YESTERDAY_SENT = DP_SNAPSHOT_BASE + "yesterday.bytesSent";
const DP_SNAP_YESTERDAY_RECV = DP_SNAPSHOT_BASE + "yesterday.bytesReceived";
const DP_SNAP_YESTERDAY_TOTAL = DP_SNAPSHOT_BASE + "yesterday.bytesTotal";

const DP_SNAP_LAST_MONTH_MONTHKEY = DP_SNAPSHOT_BASE + "last_month.monthKey";
const DP_SNAP_LAST_MONTH_VALID = DP_SNAPSHOT_BASE + "last_month.valid";
const DP_SNAP_LAST_MONTH_TS = DP_SNAPSHOT_BASE + "last_month.ts";
const DP_SNAP_LAST_MONTH_SENT = DP_SNAPSHOT_BASE + "last_month.bytesSent";
const DP_SNAP_LAST_MONTH_RECV = DP_SNAPSHOT_BASE + "last_month.bytesReceived";
const DP_SNAP_LAST_MONTH_TOTAL = DP_SNAPSHOT_BASE + "last_month.bytesTotal";

// Meta (persistente Berechnung)
const DP_META_DAYKEY = DP_BASE + "meta.dayKey";
const DP_META_MONTHKEY = DP_BASE + "meta.monthKey";
const DP_META_OFFSET_SENT = DP_BASE + "meta.offsetSent";
const DP_META_OFFSET_RECV = DP_BASE + "meta.offsetReceived";
const DP_META_LAST_CUR_SENT = DP_BASE + "meta.lastCurrentSent";
const DP_META_LAST_CUR_RECV = DP_BASE + "meta.lastCurrentReceived";
const DP_META_BASELINE_DAY_SENT = DP_BASE + "meta.baselineDaySent";
const DP_META_BASELINE_DAY_RECV = DP_BASE + "meta.baselineDayReceived";
const DP_META_BASELINE_MONTH_SENT = DP_BASE + "meta.baselineMonthSent";
const DP_META_BASELINE_MONTH_RECV = DP_BASE + "meta.baselineMonthReceived";

// Polling
const POLL_EVERY_MINUTES = 5;
const POLL_TIMEOUT_MS = 10000;
const POLL_WAIT_TIMEOUT_MS = 15000;

// IGD Service (ohne TR-064 Auth)
const IGD_WANCOMMON = "urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1";

// -------------------------------
// Helpers
// -------------------------------
function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(s) {
  try {
    return JSON.parse(String(s || ""));
  } catch (_) {
    return null;
  }
}

async function assertSoapWorkerInterface() {
  const cmdExists = await existsState(DP_SOAP_COMMAND);
  const resExists = await existsState(DP_SOAP_RESULT);
  if (cmdExists && resExists) return true;

  const missing = [];
  if (!cmdExists) missing.push(DP_SOAP_COMMAND);
  if (!resExists) missing.push(DP_SOAP_RESULT);

  const msg =
    `Missing SOAP worker interface datapoints: ${missing.join(", ")}. ` +
    `Start/configure the SOAP worker script (FRITZ_SOAP_communication.js) first.`;

  try { setState(DP_LAST_OK, false, true); } catch (_) {}
  try { setState(DP_LAST_ERROR, msg, true); } catch (_) {}
  log(`[InternetTraffic] ${msg}`, "error");
  return false;
}

function newRequestId(prefix = "soap") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

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

function toBigIntOrZero(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.floor(v));
  const s = String(v ?? "").trim();
  if (!s) return 0n;
  try {
    return BigInt(s);
  } catch (_) {
    return 0n;
  }
}

function biToString(v) {
  try { return (typeof v === "bigint") ? v.toString() : String(v); } catch (_) { return String(v); }
}

function biToNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseDayKey(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return new Date(y, mo - 1, d, 0, 0, 0, 0); // local midnight
}

function parseMonthKey(monthKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return null;
  return new Date(y, mo - 1, 1, 0, 0, 0, 0); // local first day
}

function diffDays(aDayKey, bDayKey) {
  const a = parseDayKey(aDayKey);
  const b = parseDayKey(bDayKey);
  if (!a || !b) return null;
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function diffMonths(aMonthKey, bMonthKey) {
  const a = parseMonthKey(aMonthKey);
  const b = parseMonthKey(bMonthKey);
  if (!a || !b) return null;
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function dayKeyLocal(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function monthKeyLocal(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

async function ensureStateExists(id, initialValue, common) {
  const exists = await existsState(id);
  if (!exists) {
    await createStateAsync(id, initialValue, false, common);
    return;
  }

  // Best effort: keep object metadata in sync (unit/role/name), and optionally migrate types.
  try {
    const obj = await getObjectAsync(id);
    if (!obj || !obj.common) return;

    const desiredType = common?.type;
    const currentType = obj.common.type;
    const typeMismatch = !!desiredType && !!currentType && desiredType !== currentType;

    if (typeMismatch) {
      // Recreate state with desired type (keeps same id; history can continue).
      const cur = await getStateAsync(id);
      await delObjectAsync(id);
      await createStateAsync(id, initialValue, false, common);

      // Restore value if it can be converted.
      if (cur && cur.val !== undefined) {
        const v = desiredType === "number" ? Number(cur.val) : String(cur.val);
        if (desiredType !== "number" || Number.isFinite(v)) {
          setState(id, v, true);
        }
      }
      return;
    }

    const nextCommon = { ...obj.common, ...common };
    await setObjectAsync(id, { ...obj, common: nextCommon });
  } catch (_) {
    // ignore
  }
}

function soapCall({ service, action, params = {}, timeoutMs = 10000, authMode = "tr64" }, waitTimeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const requestId = newRequestId(action || "call");

    const payload = {
      requestId,
      service,
      action,
      params,
      timeoutMs,
      authMode,
      createdAt: nowIso(),
    };

    const handler = on({ id: DP_SOAP_RESULT, change: "any" }, (obj) => {
      const r = safeJsonParse(obj?.state?.val);
      if (!r || r.requestId !== requestId) return;

      clearTimeout(t);
      try { unsubscribe(handler); } catch (_) {}

      if (r.ok) {
        r.data = simplifyXmlJson(r.data);
        return resolve(r);
      }
      return reject(new Error(`${r.error?.message || "SOAP_ERROR"}: ${r.error?.details || ""}`));
    });

    const t = setTimeout(() => {
      try { unsubscribe(handler); } catch (_) {}
      reject(new Error(`Timeout waiting for SOAP_result (requestId=${requestId})`));
    }, waitTimeoutMs);

    setState(DP_SOAP_COMMAND, JSON.stringify(payload), false);
  });
}

let pollRunning = false;

async function pollTraffic({ forceDayBaseline = false, forceMonthBaseline = false } = {}) {
  if (pollRunning) return;
  pollRunning = true;
  setState(DP_LAST_POLL, nowIso(), true);

  if (!(await assertSoapWorkerInterface())) {
    pollRunning = false;
    return;
  }

  try {
    const res = await soapCall(
      { service: IGD_WANCOMMON, action: "GetAddonInfos", params: {}, timeoutMs: POLL_TIMEOUT_MS, authMode: "none" },
      POLL_WAIT_TIMEOUT_MS
    );

    const d = res.data || {};

    const curSent = toBigIntOrZero(d.NewX_AVM_DE_TotalBytesSent64 ?? d.NewTotalBytesSent);
    const curRecv = toBigIntOrZero(d.NewX_AVM_DE_TotalBytesReceived64 ?? d.NewTotalBytesReceived);

    const byteSendRate = Number(d.NewByteSendRate ?? 0);
    const byteReceiveRate = Number(d.NewByteReceiveRate ?? 0);

    // Meta laden
    const offsetSent = toBigIntOrZero((await getStateAsync(DP_META_OFFSET_SENT)).val);
    const offsetRecv = toBigIntOrZero((await getStateAsync(DP_META_OFFSET_RECV)).val);
    const lastCurSent = toBigIntOrZero((await getStateAsync(DP_META_LAST_CUR_SENT)).val);
    const lastCurRecv = toBigIntOrZero((await getStateAsync(DP_META_LAST_CUR_RECV)).val);

    let nextOffsetSent = offsetSent;
    let nextOffsetRecv = offsetRecv;

    // Counter-Reset/Reconnect erkennen (Current springt zurück) => Offset erhöhen
    if (curSent < lastCurSent && lastCurSent > 0n) nextOffsetSent = offsetSent + lastCurSent;
    if (curRecv < lastCurRecv && lastCurRecv > 0n) nextOffsetRecv = offsetRecv + lastCurRecv;

    const virtSent = nextOffsetSent + curSent;
    const virtRecv = nextOffsetRecv + curRecv;

    // Perioden prüfen
    const dk = dayKeyLocal();
    const mk = monthKeyLocal();

    const storedDayKey = String((await getStateAsync(DP_META_DAYKEY)).val || "");
    const storedMonthKey = String((await getStateAsync(DP_META_MONTHKEY)).val || "");

    let baselineDaySent = toBigIntOrZero((await getStateAsync(DP_META_BASELINE_DAY_SENT)).val);
    let baselineDayRecv = toBigIntOrZero((await getStateAsync(DP_META_BASELINE_DAY_RECV)).val);
    let baselineMonthSent = toBigIntOrZero((await getStateAsync(DP_META_BASELINE_MONTH_SENT)).val);
    let baselineMonthRecv = toBigIntOrZero((await getStateAsync(DP_META_BASELINE_MONTH_RECV)).val);

    const dayChanged = dk !== storedDayKey;
    const monthChanged = mk !== storedMonthKey;

    // Snapshot (yesterday / last_month) BEFORE baseline changes
    if (dayChanged && storedDayKey) {
      const daySentPrev = virtSent - baselineDaySent;
      const dayRecvPrev = virtRecv - baselineDayRecv;
      const deltaDays = diffDays(storedDayKey, dk);
      const valid = deltaDays === 1;

      setState(DP_SNAP_YESTERDAY_DAYKEY, storedDayKey, true);
      setState(DP_SNAP_YESTERDAY_VALID, valid, true);
      setState(DP_SNAP_YESTERDAY_TS, nowIso(), true);
      if (valid) {
        if (debug) {
          log(
            `[InternetTraffic] Snapshot yesterday dayKey=${storedDayKey} sent=${daySentPrev} recv=${dayRecvPrev} total=${daySentPrev + dayRecvPrev}`,
            "info"
          );
        }
        setState(DP_SNAP_YESTERDAY_SENT, biToNumber(daySentPrev), true);
        setState(DP_SNAP_YESTERDAY_RECV, biToNumber(dayRecvPrev), true);
        setState(DP_SNAP_YESTERDAY_TOTAL, biToNumber(daySentPrev + dayRecvPrev), true);
      } else {
        log(`[InternetTraffic] Missed days (storedDayKey=${storedDayKey} now=${dk}); yesterday snapshot not reliable`, "warn");
      }
    }

    if (monthChanged && storedMonthKey) {
      const monthSentPrev = virtSent - baselineMonthSent;
      const monthRecvPrev = virtRecv - baselineMonthRecv;
      const deltaMonths = diffMonths(storedMonthKey, mk);
      const valid = deltaMonths === 1;

      setState(DP_SNAP_LAST_MONTH_MONTHKEY, storedMonthKey, true);
      setState(DP_SNAP_LAST_MONTH_VALID, valid, true);
      setState(DP_SNAP_LAST_MONTH_TS, nowIso(), true);
      if (valid) {
        if (debug) {
          log(
            `[InternetTraffic] Snapshot last_month monthKey=${storedMonthKey} sent=${monthSentPrev} recv=${monthRecvPrev} total=${monthSentPrev + monthRecvPrev}`,
            "info"
          );
        }
        setState(DP_SNAP_LAST_MONTH_SENT, biToNumber(monthSentPrev), true);
        setState(DP_SNAP_LAST_MONTH_RECV, biToNumber(monthRecvPrev), true);
        setState(DP_SNAP_LAST_MONTH_TOTAL, biToNumber(monthSentPrev + monthRecvPrev), true);
      } else {
        log(`[InternetTraffic] Missed months (storedMonthKey=${storedMonthKey} now=${mk}); last_month snapshot not reliable`, "warn");
      }
    }

    if (dayChanged || forceDayBaseline || !storedDayKey) {
      baselineDaySent = virtSent;
      baselineDayRecv = virtRecv;
      setState(DP_META_DAYKEY, dk, true);
      setState(DP_META_BASELINE_DAY_SENT, biToString(baselineDaySent), true);
      setState(DP_META_BASELINE_DAY_RECV, biToString(baselineDayRecv), true);
    }

    if (monthChanged || forceMonthBaseline || !storedMonthKey) {
      baselineMonthSent = virtSent;
      baselineMonthRecv = virtRecv;
      setState(DP_META_MONTHKEY, mk, true);
      setState(DP_META_BASELINE_MONTH_SENT, biToString(baselineMonthSent), true);
      setState(DP_META_BASELINE_MONTH_RECV, biToString(baselineMonthRecv), true);
    }

    const daySent = virtSent - baselineDaySent;
    const dayRecv = virtRecv - baselineDayRecv;
    const monthSent = virtSent - baselineMonthSent;
    const monthRecv = virtRecv - baselineMonthRecv;

    // Meta speichern
    setState(DP_META_OFFSET_SENT, biToString(nextOffsetSent), true);
    setState(DP_META_OFFSET_RECV, biToString(nextOffsetRecv), true);
    setState(DP_META_LAST_CUR_SENT, biToString(curSent), true);
    setState(DP_META_LAST_CUR_RECV, biToString(curRecv), true);

    // Raw / Calc speichern
    setState(DP_RAW_SENT64, biToNumber(curSent), true);
    setState(DP_RAW_RECV64, biToNumber(curRecv), true);
    setState(DP_RAW_SENDRATE, Number.isFinite(byteSendRate) ? byteSendRate : 0, true);
    setState(DP_RAW_RECVRATE, Number.isFinite(byteReceiveRate) ? byteReceiveRate : 0, true);

    setState(DP_VIRTUAL_SENT, biToNumber(virtSent), true);
    setState(DP_VIRTUAL_RECV, biToNumber(virtRecv), true);

    setState(DP_DAY_SENT, biToNumber(daySent), true);
    setState(DP_DAY_RECV, biToNumber(dayRecv), true);
    setState(DP_DAY_TOTAL, biToNumber(daySent + dayRecv), true);

    setState(DP_MONTH_SENT, biToNumber(monthSent), true);
    setState(DP_MONTH_RECV, biToNumber(monthRecv), true);
    setState(DP_MONTH_TOTAL, biToNumber(monthSent + monthRecv), true);

    setState(DP_LAST_OK, true, true);
    setState(DP_LAST_ERROR, "", true);
    if (debug) {
      log(
        `[InternetTraffic] OK rawSent64=${curSent} rawRecv64=${curRecv} ` +
          `daySent=${daySent} dayRecv=${dayRecv} dayTotal=${daySent + dayRecv} ` +
          `monthSent=${monthSent} monthRecv=${monthRecv} monthTotal=${monthSent + monthRecv}`,
        "info"
      );
    }
  } catch (e) {
    setState(DP_LAST_OK, false, true);
    setState(DP_LAST_ERROR, String(e.message || e), true);
    log(`[InternetTraffic] ERROR: ${String(e.message || e)}`, "warn");
  } finally {
    pollRunning = false;
  }
}

// -------------------------------
// State setup + schedules
// -------------------------------
(async () => {
  await ensureStateExists(DP_POLL_NOW, false, { name: "Poll now", type: "boolean", role: "button", read: true, write: true });
  await ensureStateExists(DP_LAST_POLL, "", { name: "Last poll ISO", type: "string", role: "date", read: true, write: false });
  await ensureStateExists(DP_LAST_OK, false, { name: "Last poll ok", type: "boolean", role: "indicator", read: true, write: false });
  await ensureStateExists(DP_LAST_ERROR, "", { name: "Last error", type: "string", role: "text", read: true, write: false });

  // Early warning if SOAP worker isn't running / datapoints are missing.
  await assertSoapWorkerInterface();

  await ensureStateExists(DP_RAW_SENT64, 0, { name: "Raw total bytes sent (64)", type: "number", role: "value", unit: "byte", read: true, write: false });
  await ensureStateExists(DP_RAW_RECV64, 0, { name: "Raw total bytes received (64)", type: "number", role: "value", unit: "byte", read: true, write: false });
  await ensureStateExists(DP_RAW_SENDRATE, 0, { name: "Current byte send rate", type: "number", role: "value", unit: "byte/s", read: true, write: false });
  await ensureStateExists(DP_RAW_RECVRATE, 0, { name: "Current byte receive rate", type: "number", role: "value", unit: "byte/s", read: true, write: false });

  await ensureStateExists(DP_VIRTUAL_SENT, 0, { name: "Virtual bytes sent", type: "number", role: "value", unit: "byte", read: true, write: false });
  await ensureStateExists(DP_VIRTUAL_RECV, 0, { name: "Virtual bytes received", type: "number", role: "value", unit: "byte", read: true, write: false });

  await ensureStateExists(DP_DAY_SENT, 0, { name: "Day bytes sent", type: "number", role: "value", unit: "byte", read: true, write: false });
  await ensureStateExists(DP_DAY_RECV, 0, { name: "Day bytes received", type: "number", role: "value", unit: "byte", read: true, write: false });
  await ensureStateExists(DP_DAY_TOTAL, 0, { name: "Day bytes total", type: "number", role: "value", unit: "byte", read: true, write: false });

  await ensureStateExists(DP_MONTH_SENT, 0, { name: "Month bytes sent", type: "number", role: "value", unit: "byte", read: true, write: false });
  await ensureStateExists(DP_MONTH_RECV, 0, { name: "Month bytes received", type: "number", role: "value", unit: "byte", read: true, write: false });
  await ensureStateExists(DP_MONTH_TOTAL, 0, { name: "Month bytes total", type: "number", role: "value", unit: "byte", read: true, write: false });

  // Snapshots (yesterday / last_month)
  await ensureStateExists(DP_SNAP_YESTERDAY_DAYKEY, "", { name: "Yesterday dayKey (YYYY-MM-DD)", type: "string", role: "text", read: true, write: false });
  await ensureStateExists(DP_SNAP_YESTERDAY_VALID, false, { name: "Yesterday snapshot valid", type: "boolean", role: "indicator", read: true, write: false });
  await ensureStateExists(DP_SNAP_YESTERDAY_TS, "", { name: "Yesterday snapshot written at (ISO)", type: "string", role: "date", read: true, write: false });
  await ensureStateExists(DP_SNAP_YESTERDAY_SENT, 0, { name: "Yesterday bytes sent", type: "number", role: "value", unit: "byte", read: true, write: false });
  await ensureStateExists(DP_SNAP_YESTERDAY_RECV, 0, { name: "Yesterday bytes received", type: "number", role: "value", unit: "byte", read: true, write: false });
  await ensureStateExists(DP_SNAP_YESTERDAY_TOTAL, 0, { name: "Yesterday bytes total", type: "number", role: "value", unit: "byte", read: true, write: false });

  await ensureStateExists(DP_SNAP_LAST_MONTH_MONTHKEY, "", { name: "Last month monthKey (YYYY-MM)", type: "string", role: "text", read: true, write: false });
  await ensureStateExists(DP_SNAP_LAST_MONTH_VALID, false, { name: "Last month snapshot valid", type: "boolean", role: "indicator", read: true, write: false });
  await ensureStateExists(DP_SNAP_LAST_MONTH_TS, "", { name: "Last month snapshot written at (ISO)", type: "string", role: "date", read: true, write: false });
  await ensureStateExists(DP_SNAP_LAST_MONTH_SENT, 0, { name: "Last month bytes sent", type: "number", role: "value", unit: "byte", read: true, write: false });
  await ensureStateExists(DP_SNAP_LAST_MONTH_RECV, 0, { name: "Last month bytes received", type: "number", role: "value", unit: "byte", read: true, write: false });
  await ensureStateExists(DP_SNAP_LAST_MONTH_TOTAL, 0, { name: "Last month bytes total", type: "number", role: "value", unit: "byte", read: true, write: false });

  await ensureStateExists(DP_META_DAYKEY, "", { name: "Meta dayKey", type: "string", role: "text", read: true, write: false });
  await ensureStateExists(DP_META_MONTHKEY, "", { name: "Meta monthKey", type: "string", role: "text", read: true, write: false });
  await ensureStateExists(DP_META_OFFSET_SENT, "0", { name: "Meta offset sent", type: "string", role: "value", read: true, write: false });
  await ensureStateExists(DP_META_OFFSET_RECV, "0", { name: "Meta offset received", type: "string", role: "value", read: true, write: false });
  await ensureStateExists(DP_META_LAST_CUR_SENT, "0", { name: "Meta last current sent", type: "string", role: "value", read: true, write: false });
  await ensureStateExists(DP_META_LAST_CUR_RECV, "0", { name: "Meta last current received", type: "string", role: "value", read: true, write: false });
  await ensureStateExists(DP_META_BASELINE_DAY_SENT, "0", { name: "Meta baseline day sent", type: "string", role: "value", read: true, write: false });
  await ensureStateExists(DP_META_BASELINE_DAY_RECV, "0", { name: "Meta baseline day received", type: "string", role: "value", read: true, write: false });
  await ensureStateExists(DP_META_BASELINE_MONTH_SENT, "0", { name: "Meta baseline month sent", type: "string", role: "value", read: true, write: false });
  await ensureStateExists(DP_META_BASELINE_MONTH_RECV, "0", { name: "Meta baseline month received", type: "string", role: "value", read: true, write: false });

  // Manual trigger
  on({ id: DP_POLL_NOW, change: "any" }, async (obj) => {
    if (!obj?.state) return;
    if (obj.state.ack) return;
    if (obj.state.val === true) {
      try { setState(DP_POLL_NOW, false, true); } catch (_) {}
      await pollTraffic();
    }
  });

  // Periodic poll
  schedule(`*/${POLL_EVERY_MINUTES} * * * *`, () => pollTraffic());

  // Midnight baseline (day)
  schedule("0 0 * * *", () => pollTraffic({ forceDayBaseline: true }));

  // Month baseline (1st day)
  schedule("0 0 1 * *", () => pollTraffic({ forceMonthBaseline: true }));

  // Initial poll shortly after start
  setTimeout(() => pollTraffic(), 5000);
})();

onStop(() => {
  // nothing
}, 1000);
