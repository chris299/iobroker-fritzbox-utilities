/**
 * version 2026-11-20
 *
 * ioBroker Script C: Meldung neuer Anrufbeantworter-Nachrichten per E-Mail und WhatsApp
 *
 * Reagiert auf ...Fritzbox_AnrufbeantworterLastProcessedMessage aus
 * FRITZ_TAM_transcribe.js. Dieser DP enthält alle Daten einer Nachricht in
 * einem JSON und ändert sich bei jeder Nachricht. Wer stattdessen auf das
 * Transkript reagiert und LatestMessageData dazuliest, verpasst gleich
 * lautende Transkripte und kann bei mehreren Nachrichten die Daten der
 * nächsten erwischen.
 *
 * - E-Mail sofort, mit der WAV-Datei als Anhang
 * - WhatsApp (CallMeBot, Adapter whatsapp-cmb) erst ab WHATSAPP_FROM. Was
 *   vorher kommt, wird gesammelt und um WHATSAPP_FROM nachgeschickt, auch
 *   nach einem Neustart.
 * - Wird der AB voll (...Fritzbox_AnrufbeantworterVoll), einmal E-Mail und
 *   WhatsApp, denn dann kommen keine Nachrichten mehr an.
 */

// ===============================
// Konfiguration
// ===============================
const debug = true;

const DP_ROOT_TAM = "0_userdata.0.Fritzbox.Anrufbeantworter.1";
const DP_EVENT = DP_ROOT_TAM + ".Fritzbox_AnrufbeantworterLastProcessedMessage";
const DP_WHATSAPP_QUEUE = DP_ROOT_TAM + ".Fritzbox_AnrufbeantworterWhatsAppQueue";
const DP_FULL = DP_ROOT_TAM + ".Fritzbox_AnrufbeantworterVoll";

// >>> HIER EINTRAGEN <<<
const EMAIL_INSTANCE = "email.0";
const EMAIL_TO = "you@example.com";
const EMAIL_SUBJECT = "AB message transkript";

const WHATSAPP_INSTANCE = "whatsapp-cmb.0"; // "" = keine WhatsApp
const WHATSAPP_FROM = "09:30"; // vorher nicht stören, sondern sammeln
// CallMeBot mag keine Serien im Sekundentakt
const WHATSAPP_PAUSE_MS = 5000;

// ===============================
// Setup
// ===============================
function messageText(m) {
  // gleicher Wortlaut wie im früheren Blockly-Script
  return ["Transkript der Nachricht von: ", m.name, " Nummer : ", m.number, " Nachricht : ", m.transcript].join("");
}

function loadQueue() {
  const arr = (() => {
    try {
      return JSON.parse(String(getState(DP_WHATSAPP_QUEUE)?.val || "[]"));
    } catch (_) {
      return [];
    }
  })();
  return Array.isArray(arr) ? arr : [];
}

function saveQueue(queue) {
  setState(DP_WHATSAPP_QUEUE, JSON.stringify(queue), true);
}

function sendWhatsApp(text) {
  sendTo(WHATSAPP_INSTANCE, "send", { text });
}

// Ab WHATSAPP_FROM sofort, vorher in die Warteschlange
function sendWhatsAppNowOrLater(text) {
  if (!WHATSAPP_INSTANCE) return;
  if (compareTime(WHATSAPP_FROM, null, ">")) {
    sendWhatsApp(text);
  } else {
    const queue = loadQueue();
    queue.push(text);
    saveQueue(queue);
    if (debug) console.log(`[TAM-Meldung] WhatsApp bis ${WHATSAPP_FROM} zurückgestellt (${queue.length} wartend)`);
  }
}

let flushing = false;

async function flushWhatsAppQueue() {
  if (!WHATSAPP_INSTANCE || flushing) return;
  flushing = true;
  try {
    let queue = loadQueue();
    while (queue.length > 0) {
      sendWhatsApp("(nachgeholt) " + queue[0]);
      // erst nach dem Senden entfernen: Ein Neustart mittendrin verliert nichts
      queue = loadQueue().slice(1);
      saveQueue(queue);
      if (queue.length > 0) await wait(WHATSAPP_PAUSE_MS);
    }
  } finally {
    flushing = false;
  }
}

(async () => {
  if (!(await existsState(DP_WHATSAPP_QUEUE))) {
    await createStateAsync(DP_WHATSAPP_QUEUE, "[]", false, {
      name: "WhatsApp-Meldungen, die vor " + WHATSAPP_FROM + " kamen und danach verschickt werden",
      type: "string",
      role: "json",
      def: "[]",
      read: true,
      write: true,
    });
  }

  // Server war um WHATSAPP_FROM aus oder das Script gestoppt: jetzt nachholen
  if (compareTime(WHATSAPP_FROM, null, ">")) await flushWhatsAppQueue();
})();

// ===============================
// Neue Nachricht
// ===============================
on({ id: DP_EVENT, change: "any" }, (obj) => {
  let m;
  try {
    m = JSON.parse(String(obj?.state?.val || ""));
  } catch (_) {
    return;
  }
  if (!m || !m.key) return;

  const text = messageText(m);
  if (debug) console.log(`[TAM-Meldung] Nachricht ${m.index} vom ${m.date}`);

  sendTo(EMAIL_INSTANCE, "send", {
    text,
    to: EMAIL_TO,
    subject: EMAIL_SUBJECT,
    attachments: m.localPath ? [{ path: m.localPath, cid: "file1" }] : [],
  });

  sendWhatsAppNowOrLater(text);
});

// ===============================
// AB voll: einmal melden (beim Wechsel auf true, nicht bei jedem Neustart)
// ===============================
on({ id: DP_FULL, change: "ne", val: true, ack: true }, () => {
  const text =
    "Der Anrufbeantworter ist voll. Anrufer können keine Nachricht mehr hinterlassen. " +
    "Bitte alte Nachrichten löschen.";
  log("[TAM-Meldung] AB voll, melde per E-Mail und WhatsApp", "info");

  sendTo(EMAIL_INSTANCE, "send", { text, to: EMAIL_TO, subject: "Anrufbeantworter voll" });
  sendWhatsAppNowOrLater(text);
});

// ===============================
// Um WHATSAPP_FROM die gesammelten Meldungen schicken
// ===============================
const [fromHour, fromMinute] = WHATSAPP_FROM.split(":").map((x) => parseInt(x, 10));
schedule(`${fromMinute} ${fromHour} * * *`, () => {
  flushWhatsAppQueue();
});
