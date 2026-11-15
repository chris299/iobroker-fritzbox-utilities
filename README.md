# FRITZ!Box scripts for ioBroker

This repository contains JavaScript scripts intended to run inside the **ioBroker JavaScript adapter**. They integrate a FRITZ!Box via **TR-064 SOAP** (and optionally **IGD / UPnP**) and add some higher-level features such as Internet traffic counters and answering machine (TAM) transcription.

## Scripts (and dependencies)

- `FRITZ_SOAP_communication.js`  
  **SOAP worker / prerequisite for all SOAP-based scripts.**  
  Provides a simple queue-based interface via two datapoints:
  - `0_userdata.0.Fritzbox.SOAP_command` (clients write JSON, `ack=false`)
  - `0_userdata.0.Fritzbox.SOAP_result` (worker writes JSON, `ack=true`)

- `FRITZ_SOAP_UsageSamples.js`  
  Example client code showing how to send commands to the SOAP worker and wait for results.

- `FRITZ_SOAP_InternetUsage.js`  
  Internet traffic counters (day/month) using the SOAP worker with `authMode: "none"` and IGD service discovery (`/igddesc.xml`).

- `FRITZ_CallMonitor.js`  
  Independent CallMonitor client (TCP to FRITZ!Box port `1012`) that writes the last events / call context to:
  - `0_userdata.0.Fritzbox.CallMonitor`
  - `0_userdata.0.Fritzbox.LastCall`

- `FRITZ_TAM_transcribe.js`  
  Answering machine (TAM) workflow + Azure transcription.  
  **Prerequisites:** `FRITZ_SOAP_communication.js` **and** `FRITZ_CallMonitor.js`.

- `TAM_transcribe.js`  
  Legacy/older variant that talks to the `tr-064` adapter datapoints (not the SOAP worker). Use only if you know you need that approach.

## Prerequisites

- ioBroker **JavaScript adapter** installed and running.
- The scripts use `require()` for npm modules. Install at least:
  - `axios`
  - `form-data` (needed for `FRITZ_TAM_transcribe.js`)
  - `xml2js` (needed for `FRITZ_TAM_transcribe.js`)
- FRITZ!Box configuration:
  - Enable **TR-064** (often: *Home Network → Network → Network Settings → “Allow access for applications”*).
  - Create a FRITZ!Box user for TR-064 and grant the needed permissions (telephony / call list / TAM).
  - Enable **CallMonitor** (often: *Telephony → Calls → “CallMonitor enabled”*).
- Network access from ioBroker host to the FRITZ!Box:
  - TR-064: port `49000` (HTTP) or `49443` (HTTPS)
  - CallMonitor: port `1012`

## Recommended setup order (ioBroker)

1. Import/create the script `FRITZ_SOAP_communication.js` and configure it (see below). Start it first.
2. (If you use TAM features) import `FRITZ_CallMonitor.js`, configure and start it.
3. Import and start any “client” scripts:
   - `FRITZ_SOAP_InternetUsage.js`
   - `FRITZ_TAM_transcribe.js`
   - your own scripts based on `FRITZ_SOAP_UsageSamples.js`

## Configuration notes

### 1) SOAP worker (`FRITZ_SOAP_communication.js`)

Edit the config constants at the top:

- `fritzIP`, `USE_TLS`, `tr64Port`, `tr64sPort`
- `FRITZ_USER`, `FRITZ_PASS`

The worker performs service discovery on startup (`/tr64desc.xml` and `/igddesc.xml`). Client scripts send commands as JSON, e.g.:

```json
{
  "requestId": "any_unique_id",
  "service": "urn:dslforum-org:service:X_AVM-DE_TAM:1",
  "action": "GetMessageList",
  "params": { "NewIndex": "1" },
  "timeoutMs": 10000,
  "authMode": "tr64"
}
```

`authMode`:

- `"tr64"`: TR-064 digest challenge (needs user/pass)
- `"none"`: no authentication (used for IGD / UPnP calls like traffic counters)

### 2) CallMonitor (`FRITZ_CallMonitor.js`)

Edit:

- `fritzIP`
- ensure the FRITZ!Box CallMonitor feature is enabled

The script connects to port `1012` and writes the most recent event and a derived “call context” to the two datapoints listed above.

### 3) Internet usage (`FRITZ_SOAP_InternetUsage.js`)

No FRITZ!Box credentials are required here (it uses IGD with `authMode: "none"`), but it **does require the SOAP worker**.

Outputs are created under `0_userdata.0.Fritzbox.InternetTraffic.*` (day/month totals, raw counters, last error, …).  
You can trigger an immediate poll by writing `true` to:

- `0_userdata.0.Fritzbox.InternetTraffic.pollNow`

### 4) TAM + transcription (`FRITZ_TAM_transcribe.js`)

Requires:

- SOAP worker datapoints (`0_userdata.0.Fritzbox.SOAP_command`, `0_userdata.0.Fritzbox.SOAP_result`)
- CallMonitor datapoints (`0_userdata.0.Fritzbox.CallMonitor`, `0_userdata.0.Fritzbox.LastCall`)

Configure at least:

- `AZURE_KEY`
- `AZURE_TRANSCRIBE_URL` (region-specific)
- `DEFAULT_TAM_INDEX` (fallback TAM)

for Azure configuration, see here: https://github.com/chris299/IOBrokerFritzboxTAMHandling/blob/main/README.md

Behavior:

- Manually trigger by toggling `0_userdata.0.Fritzbox.Anrufbeantworter.<DEFAULT_TAM_INDEX>.Fritzbox_AnrufbeantworterDatenAktualisieren` (the script creates its output datapoints for `DEFAULT_TAM_INDEX`)
- Automatically triggers on CallMonitor `DISCONNECT` events when the script detects a TAM port (heuristic: extensions `40..49`)
- Processes **every message not processed yet**, oldest first, not just the newest one. Processed messages are remembered in `…Fritzbox_AnrufbeantworterProcessedMessages` by the key `Date|Index|Number|Duration` (the FRITZ!Box reuses message indexes after a while, and its `New` flag is reset when someone listens on the phone).
- On the very first start, all messages already on the TAM are marked as processed, so no old messages get transcribed. On later starts, messages that arrived while the script was stopped are picked up.
- After a TAM call ends, the message sometimes shows up in the FRITZ!Box list only a few seconds later. The script polls the list every `POLL_INTERVAL_MS` (5 s) for up to `POLL_MAX_MS` (60 s).
- After each message it writes `…Fritzbox_AnrufbeantworterLastProcessedMessage` (JSON: date, name, number, transcript, local WAV path, …). Trigger notifications on this datapoint: it changes for every message, while `…LatestMessageTranskript` does not change when two transcripts are identical (e.g. empty messages).
- At most `MAX_NEW_PER_RUN` (10) messages are transcribed per run, the newest ones. This guards against a flood of notifications if the list of processed messages gets lost.

## Security

- Do not commit real credentials/API keys. Prefer ioBroker script globals, encrypted objects, or environment-based secrets.
- If you use TLS (`49443`), the worker uses an HTTPS agent with `rejectUnauthorized: false` (self-signed certs). If you want strict TLS verification, adjust this.

## License

See `LICENSE.txt`.
