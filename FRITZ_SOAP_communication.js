/*******************************************************
 * ioBroker Script A: FRITZ!Box SOAP Worker (Queue + Discovery + XML->JSON)
 * version: 2025-12-28
 * Interface via zwei Datenpunkte:
 *   - 0_userdata.0.Fritzbox.SOAP_command  (Clients schreiben; Worker ACKt)
 *   - 0_userdata.0.Fritzbox.SOAP_result   (Worker schreibt; Clients lesen)
 *
 * Command JSON (Beispiel):
 * {"requestId":"...","service":"urn:dslforum-org:service:X_AVM-DE_TAM:1","action":"GetMessageList","params":{"NewIndex":"1"},"timeoutMs":10000,"authMode":"tr64"}
 *
 * IGD / UPnP (z.B. Traffic Counter) ohne TR-064 Auth:
 * {"requestId":"...","service":"urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1","action":"GetAddonInfos","params":{},"timeoutMs":10000,"authMode":"none"}
 *
 * Result JSON (Beispiel):
 * {"requestId":"...","ok":true,"data":{...},"ts":"..."}
 *******************************************************/

const axios = require("axios");
const https = require("https");
const crypto = require("crypto");

// --------- Anpassung (deine globals dürfen auch verwendet werden) ----------
const fritzIP   =  "192.168.246.4";
const tr64Port  =  "49000";
const tr64sPort =  "49443";

// TR-064 User (muss Rechte haben, z.B. Telefon)
const FRITZ_USER = "iobroker";
const FRITZ_PASS = "fill_your_own_password";

// TR-064 Transport
const USE_TLS   = true;
const HOST_NAME = fritzIP;

// Datenpunkte (Schnittstelle)
const DP_COMMAND = "0_userdata.0.Fritzbox.SOAP_command";
const DP_RESULT  = "0_userdata.0.Fritzbox.SOAP_result";

// Auth Cache / Retry
const NONCE_CACHE_TTL_MS = 60 * 1000;
const NONCE_ONE_SHOT = true;

// Discovery Retry beim Start
const DISCOVERY_RETRY_MS = 30 * 1000;

// Discovery Quellen (TR-064 + optional IGD)
const DISCOVERY_URLS = ["/tr64desc.xml", "/igddesc.xml"];

// Queue
const MAX_QUEUE_LEN = 50;

// ------------------------------------------------------
const httpsAgent = USE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined;

const tr64 = {
  discovered: false,
  servicesByUrn: {}, // urn -> { controlPath, scpdPath }
  authCache: { byKey: {} },
};

const queue = [];
let workerRunning = false;
let discoveryRunning = false;

// ---------- DP Ensure ----------
function ensureDatapoint(id, name, writable) {
  if (!existsState(id)) {
    createState(id, "", {
      name,
      type: "string",
      role: "text",
      read: true,
      write: !!writable,
      desc: name,
    });
  }
}

// ---------- Utils ----------
function nowIso() { return new Date().toISOString(); }

function md5Hex(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

function computeSoapAuth({ user, realm, pass, nonce }) {
  const a1 = md5Hex(`${user}:${realm}:${pass}`);
  return md5Hex(`${a1}:${nonce}`);
}

function escapeXml(v) {
  return String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function normalizePath(p) {
  if (!p) return p;
  p = String(p).trim();
  if (/^https?:\/\//i.test(p)) {
    try { const u = new URL(p); return u.pathname + (u.search || ""); } catch (_) { return p; }
  }
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

function extractAllBlocks(xml, blockName) {
  const re = new RegExp(`<${blockName}[^>]*>([\\s\\S]*?)</${blockName}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(String(xml || ""))) !== null) out.push(m[1]);
  return out;
}

function extractTag(xml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i");
  const m = String(xml || "").match(re);
  return m ? m[1].trim() : null;
}

function buildParamsXml(params) {
  if (!params) return "";
  return Object.entries(params).map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join("");
}

// ---------- XML -> JSON (robuster, verschachtelt, Arrays) ----------
// Einfacher XML-Parser (ohne externe Libs):
// - Tags/Attribute werden erkannt
// - gleiche Tag-Namen => Array
// - Textknoten werden als "#text" gespeichert (wenn neben children vorhanden)
// - Attribute optional als "@attr"
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseAttributes(attrStr) {
  const attrs = {};
  if (!attrStr) return attrs;
  // name="value" oder name='value'
  const re = /([a-zA-Z_:][\w:.\-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1];
    const val = decodeXmlEntities(m[3] !== undefined ? m[3] : (m[4] || ""));
    attrs[key] = val;
  }
  return attrs;
}

function addChild(obj, name, value) {
  if (obj[name] === undefined) obj[name] = value;
  else if (Array.isArray(obj[name])) obj[name].push(value);
  else obj[name] = [obj[name], value];
}

function stripNs(tagName) {
  // "u:GetInfoResponse" -> "GetInfoResponse"
  const i = tagName.indexOf(":");
  return i >= 0 ? tagName.slice(i + 1) : tagName;
}

function xmlToJsonTree(xml) {
  const s = String(xml || "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();

  const root = { _root: {} };
  const stack = [{ name: "_root", obj: root._root }];

  // Tokenizer: Tags oder Text
  const re = /<([^>]+)>|([^<]+)/g;
  let m;

  while ((m = re.exec(s)) !== null) {
    const tag = m[1];
    const text = m[2];

    if (text && text.trim() !== "") {
      const t = decodeXmlEntities(text.trim());
      const top = stack[stack.length - 1].obj;
      // Text in node:
      if (top["#text"] === undefined) top["#text"] = t;
      else top["#text"] += " " + t;
      continue;
    }

    if (!tag) continue;

    // Endtag
    if (tag.startsWith("/")) {
      stack.pop();
      continue;
    }

    // Processing instructions / doctype ignorieren
    if (tag.startsWith("!") || tag.startsWith("?")) continue;

    const selfClosing = tag.endsWith("/");

    // Tagname + Attribute split
    const tagInner = selfClosing ? tag.slice(0, -1).trim() : tag.trim();
    const spaceIdx = tagInner.search(/\s/);
    const rawName = spaceIdx >= 0 ? tagInner.slice(0, spaceIdx) : tagInner;
    const attrStr = spaceIdx >= 0 ? tagInner.slice(spaceIdx + 1) : "";

    const name = stripNs(rawName);
    const attrs = parseAttributes(attrStr);

    const node = {};
    if (Object.keys(attrs).length) node["@attr"] = attrs;

    // Anhängen an Parent
    const parent = stack[stack.length - 1].obj;
    addChild(parent, name, node);

    // Push, wenn nicht self-closing
    if (!selfClosing) {
      stack.push({ name, obj: node });
    }
  }

  return root._root;
}

// SOAP: Envelope/Body/Response-Wrapper entfernen
function soapXmlToUsefulJson(xml) {
  const tree = xmlToJsonTree(xml);

  // Versuche Body zu finden (verschiedene Prefixe schon gestripped)
  // Mögliche Namen nach stripNs: Envelope, Body
  let envelope = tree.Envelope || tree["SOAP-ENV:Envelope"] || tree["s:Envelope"] || tree;
  if (Array.isArray(envelope)) envelope = envelope[0];

  let body = envelope && (envelope.Body || envelope.body);
  if (Array.isArray(body)) body = body[0];

  // Falls kein Body: ganze Tree zurück
  if (!body || typeof body !== "object") return tree;

  // Response-Element: erster Key außer "#text"/"@attr"
  const keys = Object.keys(body).filter(k => k !== "#text" && k !== "@attr");
  if (keys.length === 0) return body;

  const responseNode = body[keys[0]];
  // Manche Antworten sind Arrays
  const resp = Array.isArray(responseNode) ? responseNode[0] : responseNode;

  // Wenn resp nur "#text" hat -> gib text
  return resp;
}

// ---------- HTTP GET helper ----------
async function tr64Get(path, timeoutMs = 10000) {
  const baseURL = USE_TLS ? `https://${HOST_NAME}:${tr64sPort}` : `http://${HOST_NAME}:${tr64Port}`;
  const url = `${baseURL}${normalizePath(path)}`;

  const res = await axios.get(url, {
    timeout: timeoutMs,
    httpsAgent,
    headers: { "User-Agent": "iobroker-javascript", "Accept": "*/*" },
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GET ${url} -> HTTP ${res.status}: ${String(res.data).slice(0, 300)}`);
  }
  return String(res.data);
}

// ---------- Discovery ----------
async function discoverServicesFromDesc(descPath, timeoutMs = 10000) {
  const xml = await tr64Get(descPath, timeoutMs);
  const serviceBlocks = extractAllBlocks(xml, "service");
  const servicesByUrn = {};
  for (const s of serviceBlocks) {
    const serviceType = extractTag(s, "serviceType");
    const controlURL  = extractTag(s, "controlURL");
    const scpdURL     = extractTag(s, "SCPDURL");
    if (!serviceType || !controlURL || !scpdURL) continue;

    servicesByUrn[serviceType] = {
      controlPath: normalizePath(controlURL),
      scpdPath: normalizePath(scpdURL),
    };
  }
  return servicesByUrn;
}

async function tr64DiscoverServices(timeoutMs = 10000) {
  const merged = {};
  const errors = [];

  for (const descPath of DISCOVERY_URLS) {
    try {
      const svcs = await discoverServicesFromDesc(descPath, timeoutMs);
      Object.assign(merged, svcs);
    } catch (e) {
      errors.push(`${descPath}: ${String(e.message || e)}`);
    }
  }

  if (Object.keys(merged).length === 0) {
    throw new Error(`Discovery failed. Errors: ${errors.join(" | ")}`);
  }

  tr64.servicesByUrn = merged;
  tr64.discovered = true;
  if (errors.length) {
    log(`[SOAP Worker] Discovery partial: ${errors.join(" | ")}`, "warn");
  }
  return merged;
}

async function ensureDiscovery() {
  if (tr64.discovered) return;
  if (discoveryRunning) return;

  discoveryRunning = true;
  try {
    await tr64DiscoverServices(10000);
    log(`[SOAP Worker] Discovery OK: ${Object.keys(tr64.servicesByUrn).length} services`, "info");
  } catch (e) {
    tr64.discovered = false;
    log(`[SOAP Worker] Discovery FAILED: ${String(e.message || e)}`, "warn");
    // Retry später
    setTimeout(() => {
      discoveryRunning = false;
      ensureDiscovery();
    }, DISCOVERY_RETRY_MS);
    return;
  } finally {
    discoveryRunning = false;
  }
}

// ---------- Auth Cache ----------
function authCacheKey(user) {
  return `${HOST_NAME}|${USE_TLS ? tr64sPort : tr64Port}|${user}`;
}
function getAuthCache(user) {
  return tr64.authCache.byKey[authCacheKey(user)] || null;
}
function setAuthCache(user, patch) {
  const k = authCacheKey(user);
  tr64.authCache.byKey[k] = { ...(tr64.authCache.byKey[k] || {}), ...patch };
}
function clearNonce(user) {
  const k = authCacheKey(user);
  if (tr64.authCache.byKey[k]) {
    delete tr64.authCache.byKey[k].nonce;
    delete tr64.authCache.byKey[k].nonceAt;
  }
}
function isFresh(ts, ttlMs) {
  return typeof ts === "number" && (Date.now() - ts) < ttlMs;
}

async function getChallengeCached({ url, soapActionHeader, user, bodyXml, timeoutMs }) {
  const cached = getAuthCache(user);
  if (cached && cached.realm && cached.nonce && isFresh(cached.nonceAt, NONCE_CACHE_TTL_MS)) {
    return { realm: cached.realm, nonce: cached.nonce, fromCache: true };
  }

  const initEnvelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Header>` +
    `<h:InitChallenge xmlns:h="http://soap-authentication.org/digest/2001/10/" s:mustUnderstand="1">` +
    `<UserID>${escapeXml(user)}</UserID>` +
    `</h:InitChallenge>` +
    `</s:Header>` +
    `<s:Body>${bodyXml}</s:Body>` +
    `</s:Envelope>`;

  const initRes = await axios.post(url, initEnvelope, {
    timeout: timeoutMs,
    httpsAgent,
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      "SOAPAction": soapActionHeader,
      "User-Agent": "iobroker-javascript",
    },
    validateStatus: () => true,
  });

  const initXml = String(initRes.data || "");
  const nonce = extractTag(initXml, "Nonce");
  const realm = extractTag(initXml, "Realm");
  if (!nonce || !realm) {
    throw new Error(`InitChallenge failed (HTTP ${initRes.status}): ${initXml.slice(0, 400)}`);
  }

  setAuthCache(user, { realm, nonce, nonceAt: Date.now() });
  return { realm, nonce, fromCache: false };
}

function normalizeAuthMode(v) {
  const m = String(v || "tr64").trim().toLowerCase();
  if (m === "tr64" || m === "digest") return "tr64";
  if (m === "none" || m === "noauth") return "none";
  throw new Error(`Invalid authMode '${v}'. Use 'tr64' or 'none'.`);
}

async function soapPostNoAuth({ url, soapActionHeader, bodyXml, timeoutMs = 10000 }) {
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body>${bodyXml}</s:Body>` +
    `</s:Envelope>`;

  const res = await axios.post(url, envelope, {
    timeout: timeoutMs,
    httpsAgent,
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      "SOAPAction": soapActionHeader,
      "User-Agent": "iobroker-javascript",
    },
    validateStatus: () => true,
  });

  const xml = String(res.data || "");
  if (res.status >= 200 && res.status < 300) return xml;
  throw new Error(`SOAP_HTTP_${res.status}: ${xml.slice(0, 500)}`);
}

// ---------- SOAP Call ----------
async function tr64SoapCall({
  serviceUrn,
  action,
  params,
  timeoutMs = 10000,
  authMode = "tr64",
  user = FRITZ_USER,
  pass = FRITZ_PASS,
}) {
  await ensureDiscovery();
  if (!tr64.discovered) throw new Error("DISCOVERY_NOT_READY");

  const svc = tr64.servicesByUrn[serviceUrn];
  if (!svc || !svc.controlPath) {
    const known = Object.keys(tr64.servicesByUrn).length;
    throw new Error(`UNKNOWN_SERVICE: ${serviceUrn} (known=${known})`);
  }

  const baseURL = USE_TLS ? `https://${HOST_NAME}:${tr64sPort}` : `http://${HOST_NAME}:${tr64Port}`;
  const url = `${baseURL}${svc.controlPath}`;
  const soapActionHeader = `"${serviceUrn}#${action}"`;

  const bodyXml = `<u:${action} xmlns:u="${escapeXml(serviceUrn)}">${buildParamsXml(params)}</u:${action}>`;

  const mode = normalizeAuthMode(authMode);
  if (mode === "none") {
    return soapPostNoAuth({ url, soapActionHeader, bodyXml, timeoutMs });
  }

  const { realm, nonce } = await getChallengeCached({ url, soapActionHeader, user, bodyXml, timeoutMs });
  const auth = computeSoapAuth({ user, realm, pass, nonce });

  const authEnvelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Header>` +
    `<h:ClientAuth xmlns:h="http://soap-authentication.org/digest/2001/10/" s:mustUnderstand="1">` +
    `<Nonce>${escapeXml(nonce)}</Nonce>` +
    `<Auth>${escapeXml(auth)}</Auth>` +
    `<UserID>${escapeXml(user)}</UserID>` +
    `<Realm>${escapeXml(realm)}</Realm>` +
    `</h:ClientAuth>` +
    `</s:Header>` +
    `<s:Body>${bodyXml}</s:Body>` +
    `</s:Envelope>`;

  const res = await axios.post(url, authEnvelope, {
    timeout: timeoutMs,
    httpsAgent,
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      "SOAPAction": soapActionHeader,
      "User-Agent": "iobroker-javascript",
    },
    validateStatus: () => true,
  });

  const xml = String(res.data || "");

  if (res.status >= 200 && res.status < 300) {
    if (NONCE_ONE_SHOT) clearNonce(user);
    return xml;
  }

  // Bei 401 einmal Nonce refresh versuchen
  if (res.status === 401) {
    clearNonce(user);
    return tr64SoapCall({ serviceUrn, action, params, timeoutMs, user, pass });
  }

  throw new Error(`SOAP_HTTP_${res.status}: ${xml.slice(0, 500)}`);
}

// ---------- Worker Queue ----------
function writeResult(obj) {
  setState(DP_RESULT, JSON.stringify(obj), true);
}

function ackCommand(cmdObj, extra = {}) {
  const acked = {
    ...cmdObj,
    status: extra.status || "accepted",
    acceptedAt: nowIso(),
    ...extra,
  };
  setState(DP_COMMAND, JSON.stringify(acked), true); // ack=true
}

function safeJsonParse(s) {
  try { return JSON.parse(String(s || "")); } catch (_) { return null; }
}

function normalizeCommand(obj) {
  const cmd = {
    requestId: obj.requestId || `req_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    service: obj.service,
    action: obj.action,
    params: obj.params || {},
    timeoutMs: obj.timeoutMs || 10000,
    authMode: obj.authMode || "tr64",
    user: obj.user,
    pass: obj.pass,
  };

  if (!cmd.service || !cmd.action) throw new Error("Command must contain 'service' and 'action'.");

  cmd.authMode = normalizeAuthMode(cmd.authMode);
  if (cmd.user !== undefined && typeof cmd.user !== "string") throw new Error("Invalid 'user' (must be string).");
  if (cmd.pass !== undefined && typeof cmd.pass !== "string") throw new Error("Invalid 'pass' (must be string).");

  // Tag-Namen müssen valide sein: keine trailing spaces
  for (const k of Object.keys(cmd.params || {})) {
    if (/\s+$/.test(k)) {
      throw new Error(`Invalid param name '${k}' (trailing whitespace). Use '${k.trim()}'`);
    }
  }

  return cmd;
}

function enqueue(cmd) {
  if (queue.length >= MAX_QUEUE_LEN) {
    throw new Error(`QUEUE_FULL (max=${MAX_QUEUE_LEN})`);
  }
  queue.push(cmd);
}

async function processQueue() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (queue.length > 0) {
      const cmd = queue.shift();

      // Discovery muss bereit sein
      await ensureDiscovery();
      if (!tr64.discovered) {
        writeResult({
          requestId: cmd.requestId,
          ok: false,
          service: cmd.service,
          action: cmd.action,
          error: { message: "DISCOVERY_NOT_READY", details: "Service discovery not ready. Retry later." },
          ts: nowIso(),
        });
        continue;
      }

      // Service Validierung (direkt hier nochmal, falls Discovery erst jetzt kam)
      if (!tr64.servicesByUrn[cmd.service]) {
        writeResult({
          requestId: cmd.requestId,
          ok: false,
          service: cmd.service,
          action: cmd.action,
          error: { message: "UNKNOWN_SERVICE", details: cmd.service },
          ts: nowIso(),
        });
        continue;
      }

      try {
        const xml = await tr64SoapCall({
          serviceUrn: cmd.service,
          action: cmd.action,
          params: cmd.params,
          timeoutMs: cmd.timeoutMs,
          authMode: cmd.authMode,
          user: cmd.user || FRITZ_USER,
          pass: cmd.pass || FRITZ_PASS,
        });

        const data = soapXmlToUsefulJson(xml);

        writeResult({
          requestId: cmd.requestId,
          ok: true,
          service: cmd.service,
          action: cmd.action,
          data,
          ts: nowIso(),
        });
      } catch (e) {
        writeResult({
          requestId: cmd.requestId,
          ok: false,
          service: cmd.service,
          action: cmd.action,
          error: { message: "SOAP_ERROR", details: String(e.message || e) },
          ts: nowIso(),
        });
      }
    }
  } finally {
    workerRunning = false;
  }
}

// ---------- Command DP Listener ----------
on({ id: DP_COMMAND, change: "any" }, async (obj) => {
  if (!obj || !obj.state) return;
  if (obj.state.ack) return; // nur neue Commands (ack=false)

  const raw = String(obj.state.val || "").trim();
  const parsed = safeJsonParse(raw);

  if (!parsed) {
    // ack trotzdem, sonst bleibt es hängen
    try { setState(DP_COMMAND, raw, true); } catch (_) {}
    writeResult({
      requestId: `parse_${Date.now()}`,
      ok: false,
      error: { message: "BAD_COMMAND", details: "Command is not valid JSON." },
      ts: nowIso(),
    });
    return;
  }

  let cmd;
  try {
    cmd = normalizeCommand(parsed);
  } catch (e) {
    ackCommand({ ...parsed, requestId: parsed.requestId || `bad_${Date.now()}` }, { status: "rejected" });
    writeResult({
      requestId: parsed.requestId || `bad_${Date.now()}`,
      ok: false,
      service: parsed.service,
      action: parsed.action,
      error: { message: "BAD_COMMAND", details: String(e.message || e) },
      ts: nowIso(),
    });
    return;
  }

  // Wenn Discovery schon da: Service sofort validieren und ggf. rejecten
  if (tr64.discovered && !tr64.servicesByUrn[cmd.service]) {
    ackCommand(cmd, { status: "rejected" });
    writeResult({
      requestId: cmd.requestId,
      ok: false,
      service: cmd.service,
      action: cmd.action,
      error: { message: "UNKNOWN_SERVICE", details: cmd.service },
      ts: nowIso(),
    });
    return;
  }

  // enqueue + ack (queued info)
  try {
    enqueue(cmd);
    ackCommand(cmd, { status: "queued", queueLen: queue.length });
    processQueue();
  } catch (e) {
    ackCommand(cmd, { status: "rejected" });
    writeResult({
      requestId: cmd.requestId,
      ok: false,
      service: cmd.service,
      action: cmd.action,
      error: { message: "QUEUE_ERROR", details: String(e.message || e) },
      ts: nowIso(),
    });
  }
});

// ---------- Start ----------
ensureDatapoint(DP_COMMAND, "TR-064 SOAP command (JSON)", true);
ensureDatapoint(DP_RESULT,  "TR-064 SOAP result (JSON)",  false);

// Discovery beim Start anstoßen
ensureDiscovery();

// Startinfo
writeResult({ ok: true, ts: nowIso(), info: "SOAP Worker started (queue enabled)" });

onStop(() => {
  // HTTP only; nothing to close
}, 1000);

