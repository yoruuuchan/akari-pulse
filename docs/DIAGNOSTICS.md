# Diagnostics guide

## WA2456C evidence and boundary tests (`0.1.5`, verified 2026-08-12)

`0.1.5` keeps every `0.1.4` / `0.1.3` / `0.1.2` button unchanged. It tightens
the existing `collect stats` behavior and adds one new one-per-launch button.

### Tightened contracts in existing buttons

**`collect stats`** — the `getTodayStatistic` success handler now records the
raw payload of every call (`JSON.stringify`, truncated to 1500 chars) so one
on-device run yields conclusive evidence of the actual result shape. The 2026-
08-12 empty-SUM observation had no such dump; 0.1.5 fixes that. Two new
per-metric status rules for HEART_RATE MAX/MIN:

- Value === 0 for `heart_rate_today_max` or `heart_rate_today_min` is the
  ZERO_SENTINEL case (0 bpm is physiologically impossible; MIN aggregates
  include non-wear windows on this firmware). The event becomes `NO_DATA`
  with `raw_error_code: ZERO_SENTINEL` and the raw payload preserved in
  `raw_error_message`.
- Empty result (missing/null `.value`) is now recorded with
  `raw_error_code: EMPTY_STAT_RESULT` and the raw payload in
  `raw_error_message`, instead of a bare `NO_DATA`. Statistical zeros for
  `step_count`, `distance`, `calories`, `standing`, `intensity_sport` remain
  meaningful daily totals — the ZERO_SENTINEL rule does NOT apply to them.

The `sample_acquisition` layer diagnostic now carries a per-metric breakdown
message instead of the earlier `"N PASS of M"` summary. Format:
`"PASS: hr_today_max; NO_DATA: hr_today_min, step_count, distance, calories,
standing, intensity_sport (SUM stats device boundary if empty)"`. Same rule
otherwise: PASS if at least one real observation, NO_DATA if zero
observations and no failure, failure statuses win otherwise. Fits well
under the 2048-char raw_error_message limit.

### New button: `probe sleep`

Real-device evidence for the sleep API surface on WA2456C. Per official docs
(see `RESEARCH.md`), SLEEP_STATUS (=13) is supported (0 awake, 1 sleeping)
but SLEEP_UNIT (=11) and SLEEP_STAGES (=12) are marked "temporarily
unsupported" on this device class. The probe records that on device with
raw-payload evidence so the MCP `health_sleep` tool's `UNSUPPORTED` and
`NO_DATA` semantics are grounded in real observed results, not documentation
alone.

Stages: `QUEUE_LOAD_PASS` → per-type `BEGIN_<TYPE>` → `<TYPE>_PASS` /
`<TYPE>_NO_DATA` / `<TYPE>_FAIL` for SLEEP_STATUS, SLEEP_UNIT, SLEEP_STAGES
via `getRecentSamples` → `BEGIN_SLEEP_STATUS_RANGED` →
`SLEEP_STATUS_RANGED_PASS` / `_NO_DATA` / `_FAIL` (only when
`health.getStatistic` exists, per the language-server feature list) →
`BEGIN_HTTPS_POST` → `ACK_VALID` / `SEND_FAIL`. Each recent-sample probe
enqueues one event; the ranged probe enqueues one event with metric
`sleep_status_ranged` carrying the last-night window
(yesterday 18:00 → today 12:00, device-local watch clock). Layer diags
reflect real observations. Expected event count per run: 7-9.

### Bridge-only layer semantics (server-side)

On the current relay-only route the `phone_receive`, `phone_persistence`, and
`uplink` layers structurally never receive events. `/v1/status.data.layers`
now reports them as `NOT_APPLICABLE` (with a `note` field explaining the
bridge fallback context) instead of `NO_DATA` when zero records exist for
that layer, so `health_status` reads correctly on this route. If any real
record ever arrives (bridge is re-enabled), the real status takes over.

### Query validity rule (server-side)

Under a PASS filter, records with metric in
`{heart_rate, heart_rate_resting, heart_rate_today_max, heart_rate_today_min}`
AND value 0 are excluded. Enforced once at the database query layer via a
named `BPM_METRICS_ZERO_INVALID` constant. `status=ALL` reads still return
these records for diagnostics. The append-only store is untouched. This
stops legacy zero-shape PASS records from `0.1.2/0.1.3` era from surfacing
as legal observations without any data mutation.

## WA2456C collect-and-sync tests (`0.1.4`)

`0.1.4` keeps every `0.1.2` and `0.1.3` button unchanged and adds three
one-per-launch tests that produce real health observations plus per-layer
diagnostic events and immediately push them through the same HTTPS transport
that `0.1.3` verified. One test per cold launch still applies.

- `collect hr live` initializes the HTTPS transport observer, opens a live
  heart-rate subscription, runs a 60 s observation window, and unsubscribes.
  Stages: `QUEUE_LOAD_PASS` → `BEGIN_LIVE_SUBSCRIBE` → `SUBSCRIBE_RETURNED` →
  per-callback `HR_CALLBACK_PASS_1..5` / `HR_CALLBACK_ZERO_SHAPE` /
  `HR_CALLBACK_EMPTY` / `HR_CALLBACK_CAPPED` → `UNSUBSCRIBED` →
  `BEGIN_HTTPS_POST` → `ACK_VALID` or `SEND_FAIL`. Up to five nonzero callbacks
  become real `heart_rate` PASS events (real callback timestamp,
  `callback_delta_ms`); if the window ends with zero nonzero callbacks,
  exactly one `heart_rate` NO_DATA event is enqueued. `diagnostic_watch_module_api`,
  `diagnostic_permission`, and `diagnostic_sample_acquisition` events are
  enqueued with their real observed status (permission DENIED / API_MISSING is
  never softened). Expected event count per run: at most nine.
- `collect recents` runs `getRecentSamples` for `HEART_RATE`,
  `HEART_RATE_RESTING`, `SPO2`, and `STRESS`. Stages: `QUEUE_LOAD_PASS` →
  per-metric `BEGIN_<TYPE>` → `<TYPE>_PASS` / `<TYPE>_NO_DATA` /
  `<TYPE>_ZERO_SHAPE` (heart-rate family only) / `<TYPE>_FAIL` →
  `BEGIN_HTTPS_POST` → `ACK_VALID` or `SEND_FAIL`. Each metric produces one
  event with its real status. The three layer diagnostics reflect real
  observations (permission DENIED if any metric returned code 400,
  sample_acquisition PASS if at least one metric returned a real value).
  Expected event count per run: seven.
- `collect stats` runs `getTodayStatistic` for the published support-matrix
  combinations documented in `../watch/README.md`: SUM for `STEP_COUNT`,
  `DISTANCE`, `CALORIES`, `STANDING`, and `INTENSITY_SPORT`, plus MAX and MIN
  for `HEART_RATE`. Stages mirror `collect recents` with
  `<TYPE>_<STATISTIC>_...` names. Zero-shape mapping is not applied here — a
  step count of zero is a meaningful daily total. Expected event count per run:
  at most ten.

Zero-shape contract decision (locked in `0.1.4`): the vivo watch health API
returns a raw recent-sample or live callback with `value === 0` and
`timeStamp === 0` when its internal heart-rate buffer holds no reading. That
is not a real bpm of zero. `watch/src/lib/events.js#isZeroHrSampleShape` detects
this exact shape and `hr full pipeline`, `collect hr live`, and `collect recents`
map it to `NO_DATA` with `raw_error_code: ZERO_SHAPE` and a preserved raw
message. Daily statistics (`step_count`, `distance`, `calories`, `standing`,
`intensity_sport`) are unaffected because their zero values are meaningful.

`watch_transport` diagnostic behavior: after an ACK is verified
(`accepted + duplicates == events.length` with matching `batch_id`), the watch
enqueues a `diagnostic_watch_transport` PASS event carrying the acknowledged
`batch_id`, `accepted`, and `duplicates`. That event rides the next sync — on
a queue with no prior sync history, the layer summary shows `watch_transport`
`NO_DATA` after the first collect run and PASS after the second successful
collect run. This is deliberate: no PASS is claimed before an ACK actually
arrives.

Android-bridge-only layers (`phone_receive`, `phone_persistence`, `uplink`)
are structurally N/A on the current relay-only route. The watch never enqueues
diagnostic events for those layers because there is no Android bridge in the
path. Since 0.1.5 the server reports them as `NOT_APPLICABLE` (with a note
`"android bridge fallback; not on the active relay route"`) in
`/v1/status.data.layers` when zero records exist, so `health_status` no
longer reads them as `NO_DATA` failures on this route. If the Android bridge
is ever re-enabled as a fallback receiver, those layers will begin producing
evidence and the real status takes over from the next request.

## WA2456C network relay tests (`0.1.3`)

`0.1.3` keeps the entire `0.1.2` isolation harness (all rows below passed on the real watch on the 2026-08-12 baseline; see [REAL_DEVICE_RESULTS.md](REAL_DEVICE_RESULTS.md)) and adds two network tests for the Cloudflare relay route. The phone must be paired, connected, and online. One test per cold launch still applies.

- `net probe` sends three sequential GETs and records each raw outcome without letting a later probe overwrite an earlier one: `CONTROL_HTTP_204` (third-party `generate_204`, plain HTTP — proves or disproves any internet path), `RELAY_HTTPS` (`https://pulse.example.com/healthz` — the operator-owned route the data needs), `RELAY_HTTP` (same host over plain HTTP — protocol comparison). Overall `PASS` requires the relay HTTPS probe to return 200 with the relay body marker.
- `send batch https` loads the saved diagnostic queue, persists one non-health marker event, then runs the production transport: `makeBatch` → HTTPS POST → strict acknowledgement check (`ok`, matching `batch_id`, `accepted + duplicates == events`) → dequeue only on a full match. Stages: `QUEUE_LOAD_PASS`, `MARKER_PERSISTED`, `BEGIN_HTTPS_POST`, then `ACK_VALID` or `SEND_FAIL` with the raw code. A failure keeps the queue intact.

After an on-watch `ACK_VALID`, complete the chain from the desktop with `node scripts/drain-relay.mjs` (admin token from `relay/.secrets.local`) and verify the event through `GET /v1/health/latest`. The relay-to-service leg was host-verified on 2026-08-12; `watch_transport` failures before `ACK_VALID` are watch-side, `uplink`-style failures after it belong to the drain client or the local service.

Real-device quirks observed 2026-08-12 (details in [REAL_DEVICE_RESULTS.md](REAL_DEVICE_RESULTS.md)): the fetch `timeout` parameter is not honored on this firmware — a failing request can take ~40 s to report (`code=0 "generic error"`), so a silent-looking probe may simply still be waiting; and a device heart-rate callback with no recent sample yields raw `value: 0, sample_timestamp: 0`, which analysis must treat as "no valid sample", not a reading.

## WA2456C Recent HR isolation (`0.1.2`)

The current watch build is a one-test-per-process diagnostic harness. Its startup path registers only in-memory observers. It does not call health or sensor APIs, read or write storage, initialize BlueXlink, start a subscription, send a batch, or schedule a retry. Static module imports remain, but no imported native method is invoked until the matching button is tapped.

The four Recent HR buttons all preserve the official singleton call shape `health.getRecentSamples({dataTypes: [health.DATA_TYPES.HEART_RATE], success, fail})`. They differ only in callback work:

| Button | Work included | Work deliberately excluded | Interpretation if this is the first layer that reboots |
|---|---|---|---|
| `hr invoke only` | native call plus required empty success/fail functions | callback logging, payload access, parsing, queue, storage, transport | strongest evidence for the native health invocation/callback-dispatch boundary or firmware; it still does not prove the health service is the root cause without device logs |
| `hr callback only` | invocation plus first-statement callback-entry UI marker; fail preserves raw code/message | success payload access/parsing, queue, storage, transport | callback entry/publication or its minimal UI/log reaction, after invoke-only survived |
| `hr direct ui` | callback entry, the existing singleton-sample selection, minimal value/timestamp parse, direct UI result | event creation, queue, storage, transport | payload parsing or reactive value rendering, after callback-only survived |
| `hr full pipeline` | callback entry, parse, event creation, isolated queue, JSON snapshot, `storage.set`, direct result only after `set.success` | automatic transport initialization and all sending/retry | queue serialization/storage after a health callback, after direct UI survived |

Every stage is emitted before the next risky operation. Important full-pipeline stages are `CALLBACK_ENTERED_SUCCESS/FAIL`, `PARSE_PASS/NO_DATA`, `QUEUE_MEMORY`, `BEGIN_SNAPSHOT`, `SNAPSHOT_READY`, `BEGIN_STORAGE_SET`, and `STORAGE_SUCCESS`. The screen shows the last in-memory stage. Only a successfully persisted full-pipeline event can survive a reboot; after relaunch, use `load saved queue state` and then relaunch again before any new isolation test.

Control buttons provide the non-health side of the binary split:

- `ui control` performs only the handler/observer/reactive UI path;
- `storage set + read` writes a small nonempty string, waits for `set.success`, then requires an exact `getSync` match;
- `queue + persist` loads the new diagnostic queue, constructs a non-health event, clones the queue snapshot, and requires `storage.set.success`;
- `transport init` manually calls `interconnect.instance` and observes `onOpen`, but sends no message and touches no health API.

The diagnostic queue key is `akari.pulse.unsent.diagnostic.v1`. The earlier production key `akari.pulse.unsent.v1` is not read, overwritten, or deleted by startup or these controls, preventing old `0.1.0/0.1.1` events from contaminating the result.

Shortest adaptive sequence:

1. Cold launch, run `queue + persist`, and observe for 60 seconds. If it fails or reboots, use cold-launch `ui control` and `storage set + read` to split UI from storage/queue.
2. Cold launch, run `hr invoke only`, and wait for `survived 60 s after invoke` or a reboot.
3. Only if it survives, cold launch and run `hr callback only`.
4. Only if that survives, cold launch and run `hr direct ui`.
5. Only if that survives, cold launch and run `hr full pipeline`; after a reboot, relaunch and use `load saved queue state` once.

Do not press another test button in the same process. Do not treat the 60-second survival marker as a health-data PASS. `hr invoke only` deliberately cannot report whether its empty callback ran. `NO_CALLBACK_WITHIN_60S` is a local timeout observation; vivo publishes no callback latency guarantee for this API.

Akari Pulse reports the first failing layer without replacing it with a downstream success. Start at the top of this table and stop at the first non-`PASS` result.

| Layer | Evidence | Typical failure meaning | Next check |
|---|---|---|---|
| `watch_module_api` | watch diagnostics | module/function missing at runtime | confirm the installed RPK and BlueOS version; retain `API_MISSING` |
| `permission` | watch diagnostics | permission denied or not declared | inspect raw code; code `400` is denial and `402` is declaration/configuration for the health API |
| `sample_acquisition` | watch values and callback timestamps | supported call returned empty, unsupported type, or callback failed | wear the watch, enable the system measurement, then retry without substituting zero |
| `watch_transport` | watch queue depth, connection state, last ACK | no verified phone acknowledgement | verify package/fingerprint, connection, credentials, and matching batch ACK |
| `phone_receive` | Android diagnostics and inbox count | outer envelope/auth/contract rejection or receiver inactive | inspect the named adapter and raw safe error; start HTTP receiver only for the HTTP probe |
| `phone_persistence` | Android Room queue counts | local transaction failed or ID conflict | inspect the preserved conflict; do not drop the record |
| `uplink` | Android outbox and worker state | backend unavailable, authentication failed, or ACK mismatch | verify service URL/token and the exact returned `batch_id` and counts |
| `backend_ingest` | `GET /v1/status` | no batch has arrived or ingest failed | query service logs and submit a controlled batch |
| `database` | `GET /v1/status` | local SQLite unavailable | inspect the configured database path and process error |
| `mcp_query` | `health_status` | MCP cannot reach/authenticate to the service | verify MCP URL/token environment and keep stdout free of logs |

## Status interpretation

- `NO_DATA` is not an error and not a zero. It means the call completed without a usable observation.
- `DENIED` is a permission or policy decision; retrying silently is not a fix.
- `UNSUPPORTED` is based on an explicit runtime/device response, not on a missing credential.
- `API_MISSING` includes an absent required module/function or required deployment configuration such as unprovided official RPC credentials.
- `ERROR` retains safe raw code and message. Authentication tokens and device identifiers are never included.

## Useful checks

Service liveness and authenticated status:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
$headers = @{ Authorization = "Bearer $env:AKARI_HEALTH_TOKEN" }
Invoke-RestMethod http://127.0.0.1:8787/v1/status -Headers $headers
```

Or run the checked script:

```powershell
.\scripts\smoke-test-service.ps1
```

For Android, use the diagnostics card before collecting `adb logcat`; the UI deliberately shows safe state and raw non-secret error text. For the watch, expand the diagnostics section and record the exact API, status, raw code/message, callback time, queue depth, and last business ACK. Do not publish an unredacted device log until it has been checked for account or device identifiers.

## ACK troubleshooting

The following are not business acknowledgements:

- BlueXlink `connect.send.success()`;
- Android WorkManager reporting that an attempt started;
- an HTTP connection being accepted;
- a service `/healthz` response;
- a simulator-only LAN/loopback request.

A watch batch is complete only after Android commits it and the watch receives a matching business result. An Android uplink batch is complete only after Akari Health returns the matching `batch_id` and the exact accepted-plus-duplicate count.

## WA2456C device quirks (observed 2026-08-12)

Behaviors observed on `WA2456C / BlueOS 3.0 / DPD2346C_A_1.54.5` during `0.1.3` and `0.1.4` real-device testing. Not confirmed on other devices or firmware versions.

1. **fetch failure `code=-6` vs `code=0` discrimination.** `code=-6 "generic error"` is an immediate local rejection when NO network path exists (only a non-internet Bluetooth link active, e.g. the PC/OrbitV link with no phone paired). Distinct from `code=0 "generic error"` after ~40 s, which is the stall/timeout shape when a route exists but the endpoint is unreachable. Useful for telling "no route at all" apart from "dead route".

2. **Health API sample timestamps are epoch seconds, not milliseconds.** `subscribeSample` callback `timeStamp` and `getRecentSamples` result `timeStamp` are epoch seconds (observed: 1786521891 vs the same instant's 1786521891324 ms from the watch clock). `0.1.4` stores the raw value unconverted in `sample_timestamp`; the event's `timestamp` field (epoch ms, watch clock) is the reliable time. A future version may normalize with a documented multiply-by-1000 contract decision — never silently.

3. **`heart_rate_today_min` includes non-wear periods.** `getTodayStatistic` MIN for HEART_RATE returned 0 bpm — the device aggregate appears to include non-wear or empty periods. The raw device answer is stored as-is; interpret with care. The zero-shape → NO_DATA rule deliberately does NOT apply to statistics (a step count of zero is a meaningful daily total).

4. **All SUM daily statistics return empty to a sideloaded quick app.** `step_count`, `distance`, `calories`, `standing`, `intensity_sport` via `getTodayStatistic` SUM all returned empty on this firmware, while HEART_RATE MAX/MIN work. The operator demonstrably walked that day while wearing the watch. Boundary recorded 2026-08-12; root cause uninvestigated. Candidate: the SUM success-callback payload shape may differ from MAX/MIN.

5. **On-screen log clock can jump backwards around Bluetooth link changes.** The watch's formatted local time in the diagnostics list was observed jumping backwards (~50 min) around Bluetooth link changes; the epoch timestamps inside events stayed self-consistent and plausible throughout. Trust event epochs, not screen-formatted times, when correlating observations.

6. **fetch `code=-6` incident pattern: twice-observed, identical cause and recovery (0.1.5).** The 0.1.4 afternoon `code=-6` instant-fail (entry 1 above) repeated during the 0.1.5 `collect recents` first attempt under the same conditions: operator re-enabled PC Bluetooth for OrbitV sideloading, leaving the phone proxy disconnected. Recovery was the same single-step procedure: PC BT off, vivo Health connected, cold start, send batch HTTPS → ACK_VALID ~1 s. The frozen batch replayed idempotently with zero data loss both times. Treat any `code=-6` as "check whether the phone proxy link is active" before investigating deeper causes.

7. **Health API error code 200 from `getRecentSamples` = per-data-type refusal (0.1.5).** `getRecentSamples` for SLEEP_UNIT (=11) and SLEEP_STAGES (=12) both fail with `code=200 message "getRecentSamples failed"`. This is a health-API-level error code, distinct from HTTP 200. It means the device refuses to provide that data type through this API, not a transient failure. SLEEP_STATUS (=13) through the same API succeeds on the same device in the same run.

8. **`getTodayStatistic` SUM types: success callback returns literal `{}`, conclusive (0.1.5).** The 0.1.5 raw-payload dump resolved the 0.1.4 open question (entry 4 above). The success callback for every SUM type (`STEP_COUNT`, `DISTANCE`, `CALORIES`, `STANDING`, `INTENSITY_SPORT`) delivers a literal empty object with no fields — not a different field name, not unexplored nesting. This is a sideloaded-quick-app capability boundary on this firmware, not a data-absence condition. HEART_RATE MAX/MIN continue to return a full result shape through the same API.

9. **`health.getStatistic` listed in SDK `featureApi.js` but absent at runtime (0.1.5).** The SDK's `featureApi.js` lists `getStatistic` and `subscribeTodayStatistic` among the health module's public symbols. Runtime `typeof` check on `WA2456C / DPD2346C_A_1.54.5` found `health.getStatistic` absent (no function). SDK feature lists are documentation artifacts, not runtime guarantees; always probe at runtime before calling.
