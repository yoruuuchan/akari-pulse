# Real-device results

This file is the durable source of truth for physical-watch observations. A host build, package audit, simulator result, OrbitV progress indicator, or API documentation entry is not a device pass.

## Device baseline

- watch: vivo WATCH GT, first-generation Bluetooth model `WA2456C`
- BlueOS: `3.0`
- watch software: `DPD2346C_A_1.54.5`
- watch hardware previously reported: `MP_0.1`
- installation path: OrbitV
- phone: vivo X200 Pro with vivo Health installed

Do not include a MAC address, serial number, account identifier, token, SDK key, or authentication cookie in this file.

## Confirmed version history

| Version | Package evidence | Physical-watch result |
|---|---|---|
| `0.1.0` / code 1 | SHA-256 `FEE05DE3F475BC8CA021AEED38D69682C84C2EA2467648CA6A35DF3A1B0ADE0E`; compiled `appCategory=sports` | Installed through OrbitV. `READ_HEALTH_DATA` prompted and was allowed. The old aggregate Run probe displayed a real `82 bpm`, then the whole watch black-screen rebooted. The probe had already issued 19 native health requests without awaiting callbacks, so this event cannot identify one offending API. |
| `0.1.1` / code 2 | SHA-256 `CD858F1C7A2F1D30F2B6A16B6EC3D5D4F8083E38534C904971E6F963BFD42A0C`; local OrbitV copy was byte-identical | Installed successfully. Stable at idle for at least one minute. One `Recent HR` tap produced no new visible value; the watch later black-screen rebooted. `0.1.1` initialized the queue and the BlueXlink connection at startup, so the reboot cannot be pinned to one layer. |
| `0.1.2` / code 3 | SHA-256 `D5A368469F556A379575178ACFA57530D35546D44742433788F13ED8EE0E98C6`; 69,649 bytes | Installed successfully. Isolated results below (operator-reported, recorded 2026-08-12): the complete health chain passed, including three consecutive cold-start full-pipeline passes, with no reboot. `transport init` failed with BlueXlink `code=1001`. |
| `0.1.3` / code 4 | SHA-256 `BFCCEA5B7181BFE20C7B547EA05E5025DC7DE76703A98A60D75BF95D1328E0A1`; 75,466 bytes | Installed through OrbitV. `net probe` and `send batch https` both passed on 2026-08-12; the first real watch batch traversed relay → drain → local service → MCP the same day. Details below. |
| `0.1.4` / code 5 | SHA-256 `AF16F9E39CEBB67AB79408B03668907CD40BBBFB6F6705599A9C8808FC63372B`; 84,899 bytes | Verified 2026-08-12 (operator-run, afternoon/evening UTC+8). All three collect+sync buttons passed end-to-end; real nonzero HR (62 bpm live, 61 bpm resting), SpO2 (99 %), stress (35) landed in the VPS store and are queryable via the remote MCP. Zero-shape → NO_DATA mapping confirmed on device. Daily SUM statistics identified as a device capability boundary (all returned empty). Details below. |
| `0.1.5` / code 6 | SHA-256 `C8AFBE32446E30D745CBCFE68C8C7D5DA101B7B58DD78CCD52167C2D7343AE76`; 89,461 bytes | Verified 2026-08-12 (operator-run, evening UTC+8). Sentinel rule confirmed on device, SUM-stats conclusively empty-object, sleep boundaries established, NOT_APPLICABLE layer semantics live. Details below. |

## `0.1.2` isolated results (operator-reported, recorded 2026-08-12)

Each row started from a cold app launch with one test per process.

| Test | Last visible stage | Result | Alive after 60 s | Reboot observed |
|---|---|---|---|---|
| `queue + persist` | `QUEUE_PERSIST_PASS` | `PASS` | yes | no |
| `hr invoke only` | `HEALTH_CALL_RETURNED` | stable invoke | yes (60 s stable) | no |
| `hr callback only` | `CALLBACK_ENTERED_SUCCESS` | success callback really entered | yes | no |
| `hr direct ui` | parse + direct UI | `PASS` | yes | no |
| `hr full pipeline` | `STORAGE_SUCCESS` | `PASS` — 3 of 3 consecutive cold starts | yes | no |
| `transport init` | `FAIL transport code=1001` | `ERROR` — `interconnectfeature error` | yes | no |

Established by these runs:

- The chain `getRecentSamples([HEART_RATE])` → native callback → payload parse → UI → queue → snapshot → `storage.set` is stable on this watch across repeated cold starts. Do not re-litigate or rewrite this chain without new failing evidence.
- `interconnect.instance({package, fingerprint})` returns an instance, and the connection then fails asynchronously with `onError code=1001, message="interconnectfeature error"` before any `onOpen`. No message was ever sent.
- The `0.1.1` whole-watch reboots were not reproduced by any isolated `0.1.2` test. `0.1.1` differed by initializing BlueXlink at startup, which makes transport/runtime interaction a plausible-but-unproven factor; the reboot root cause remains unresolved and is no longer blocking (the `0.1.2/0.1.3` harness never initializes BlueXlink at startup).

### BlueXlink verdict for `WA2456C`

Combining the device result with the research recorded in [RESEARCH.md](RESEARCH.md): the official BlueXlink support table lists only vivo WATCH 3; the official watch-side error table defines `1001` as "phone APP not installed", which for this pairing also matches the phone bridge never being registered with vivo Health (no vivo `appid`/`encryStr` exists for it); and the raw message `interconnectfeature error` comes from the native watch runtime, not from any layer this project controls. Whether the terminal cause is missing device support or missing vivo credentials cannot be separated without enterprise credentials or a WATCH 3, and both fixes are outside this project's reach. BlueXlink on `WA2456C` is therefore closed as `UNSUPPORTED_OR_CREDENTIAL_BLOCKED`; the `transport init` button remains only as an evidence generator.

## `0.1.3` network relay results (2026-08-12)

Phone paired, connected over Bluetooth, and online. Each test from a cold app launch.

| Test | Date/time | Observed stages | Result | Reboot |
|---|---|---|---|---|
| `net probe` | 2026-08-12 13:50 local | `CONTROL_HTTP_204` FAIL `code=0 message=generic error` after ~40 s → `RELAY_HTTPS_RESPONSE_200` (~4 s) → `RELAY_HTTP_RESPONSE_200` (~8 s) → `PASS net probe` | `PASS` — the sideloaded quick app reaches the internet through the paired phone, and the relay answers over both HTTPS and HTTP | no |
| `send batch https` | 2026-08-12 13:53 local | relay received batch `wa2456c-batch-1786510408808-3` (producer `akari-pulse-blueos-watch`, 2 events) 3 s after the watch `sent_at`; the relay stored it and returned the full acknowledgement | `PASS` on the server-verified leg | no |

Facts established:

- `@blueos.network.fetch` from a sideloaded quick app has internet access via the paired phone. HTTPS to `pulse.yoru-and-akari.dev` works, including TLS, with ~4 s first-connection latency. **The transport gate is open.**
- The third-party plain-HTTP `generate_204` control failed with `code=0 "generic error"` after ~40 seconds despite `timeout: 10000` — the fetch `timeout` parameter is not honored on this firmware. Plan retry/UI expectations around ≥40 s worst-case fetch failure latency, and do not use that miui endpoint as a control in future builds.
- The uploaded batch carried a **real earlier heart-rate event** from the durable diagnostic queue (`hr full pipeline` era) plus the send-control marker: queued history leaves the watch automatically on the first successful sync, as designed.
- Same day, `node scripts/drain-relay.mjs` drained that batch into the local service (`accepted=2 duplicates=0`), the relay row was deleted (`pending_batches=0`), and the record was returned end-to-end by the real stdio MCP (`health_latest`, 14 tools listed). The complete pipeline **watch → relay → drain → Akari Health → MCP** has now run once with physical-watch data.

Data-quality caveat recorded from the drained batch: the carried heart-rate event has `value: 0, sample_timestamp: 0` with `status: PASS`. Those zeros are the device's own raw callback content when no recent sample exists — they were preserved, not invented. Treat `heart_rate` value `0` (especially with `sample_timestamp` `0`) as "no valid sample" in analysis. This is the exact code path fixed in `0.1.4`: `watch/src/lib/hr-diagnostics.js#parseRecentHeartRate` (and the equivalent parse in `0.1.4` `collect hr live` / `collect recents`) now uses `events.js#isZeroHrSampleShape` to detect that shape and produce `NO_DATA` with `raw_error_code: ZERO_SHAPE`.

Watch-side display of `ACK_VALID` and the emptied queue counter were not photographed; the relay-side receipt, acknowledgement response, and subsequent successful drain are server-verified. On the next launch, the `saved diagnostic queue` card should show the queue empty — record it then.

## `0.1.4` collect-and-sync results (operator-run, 2026-08-12 afternoon/evening UTC+8)

Same discipline as prior versions: cold app launch before each row, one test per process. Phone paired, connected over Bluetooth, and online.

| Test | Observed stages | Result | Store effect |
|---|---|---|---|
| `collect hr live` (first attempt) | Cold launch, watch worn. HR live subscription ran 60 s: >5 nonzero callbacks (`HR_CALLBACK_PASS_1..5` then repeated `HR_CALLBACK_CAPPED` at ~1-2 s intervals; server data shows `callback_delta_ms` 998, i.e. ~1 Hz). Layer diags enqueued: `watch_module_api` PASS, `permission` PASS, `sample_acquisition` PASS ("5 nonzero, 0 zero-shape"). HTTPS sync then FAILED instantly (same-second): `SEND_FAIL code=-6 message="generic error"`. | **SEND_FAIL** — see network-path attribution below | Queue kept all 8 events durably; frozen pending batch preserved for idempotent retry. This is the designed store-then-forward behavior. |
| `send batch https` (retry of first attempt) | Operator turned PC Bluetooth OFF, confirmed phone paired and online, cold-launched, pressed `send batch https`. `BEGIN_HTTPS_POST` → `ACK_VALID` in 3 s. The retry re-sent the SAME frozen batch (`batch_id` `wa2456c-batch-1786521945414-12`, created ~11.5 min earlier during the failed attempt). Server: accepted=8 duplicates=0, `received_at` 1786522638291. | **PASS** | 5 `heart_rate` PASS events in VPS store: latest value 62 bpm, unit bpm, timestamp 1786521891324 (epoch ms, watch clock), `sample_timestamp` 1786521891, `source_api` `health.subscribeSample`, quality `live_sample_collect`, `callback_delta_ms` 998. `health_status` layers `watch_module_api` / `permission` / `sample_acquisition` all turned PASS. Store record_count 3 → 11. |
| `collect recents` | Cold launch. All four recent-sample metrics returned: `heart_rate` ZERO SHAPE (value 0 + timeStamp 0) → recorded as NO_DATA per the `0.1.4` contract (first on-device demonstration of zero-shape → NO_DATA mapping); `heart_rate_resting` PASS 61 bpm (`sample_timestamp` 1786520700, epoch seconds — see [DIAGNOSTICS.md](DIAGNOSTICS.md) device quirks); `spo2` PASS 99 % (`sample_timestamp` 1786513540, an older stored sample); `stress` PASS 35 (unitless index, `sample_timestamp` 1786522798). `sample_acquisition` evidence: "3 PASS of 4". ACK_VALID ~5 s. Batch `wa2456c-batch-1786522798397-23` accepted=9 (4 metric events + 3 layer diags + `watch_transport` PASS receipt from the previous ACK + send-batch marker). | **PASS** | Store 11 → 20. `watch_transport` layer turned PASS in the store (receipt timestamp 1786522505977) — confirming the ride-next-sync receipt design. |
| `collect recents` relaunch guard | Operator pressed the next button in the same process 12 s after the first test completed. | **FAIL relaunch required** — the one-test-per-cold-start lock working; no data effect. | No change. |
| `collect stats` (run 1) | Cold launch. `heart_rate_today_max` PASS 178 bpm; `heart_rate_today_min` PASS 0 bpm (see [DIAGNOSTICS.md](DIAGNOSTICS.md) device quirks). `step_count`, `distance`, `calories`, `standing`, `intensity_sport` (all SUM statistics): ALL NO_DATA — the device returned empty results despite the operator having walked that day while wearing the watch. | **PASS** (transport); per-metric results honestly reflect device behavior | Store 20 → 31 (7 metric events + 3 layer diags + `watch_transport` PASS receipt). |
| `collect stats` (run 2, independent cold launch) | Identical per-metric results as run 1; harmless duplication of observations, both recorded honestly. | **PASS** | Store 31 → 42. |

### Network-path attribution (controlled experiment, 2026-08-12 evening)

During the first `collect hr live` run, the watch's only active Bluetooth link was the operator's Windows PC (used for OrbitV sideloading). The HTTPS sync failed instantly: `SEND_FAIL code=-6 message="generic error"` (same-second rejection — contrast with the known ~40 s `code=0` timeout shape when a network path exists but stalls). The PC Bluetooth link provides no internet proxy.

Attribution step: operator turned the PC's Bluetooth OFF entirely, confirmed the vivo Health app on the paired phone showed the watch connected and the phone was online, cold-launched, pressed `send batch https`. Result: `BEGIN_HTTPS_POST` → `ACK_VALID` in 3 s. The frozen batch from the failed attempt was accepted.

Verdict: the sideloaded quick app's internet path runs through the **paired phone** (vivo Health Bluetooth proxy), confirmed with the PC link eliminated as a single-variable controlled experiment. The earlier `0.1.3` `net probe` conclusion stands. OrbitV on the PC is the install channel only.

### `watch_transport` layer visibility

After the first successful collect ACK (the `send batch https` retry), a `diagnostic_watch_transport` PASS event was enqueued carrying the acknowledged `batch_id`. That event rode the next sync (`collect recents`). `watch_transport` turned PASS in the store after the second sync, confirming the ride-next-sync receipt design.

### `heart_rate` zero-shape mapping

The `collect recents` heart-rate result returned exactly `value: 0, sample_timestamp: 0` and was enqueued as `heart_rate` NO_DATA with `raw_error_code: ZERO_SHAPE` — the first on-device demonstration of the `0.1.4` zero-shape → NO_DATA contract. No new zero-BPM PASS records appeared in the store from `0.1.4`.

### Daily SUM statistics capability boundary

`getTodayStatistic` HEART_RATE MAX/MIN returned real values on `WA2456C / DPD2346C_A_1.54.5`. Every SUM statistic type (`STEP_COUNT`, `DISTANCE`, `CALORIES`, `STANDING`, `INTENSITY_SPORT`) returned empty to the sideloaded quick app despite the operator demonstrably having walked that day while wearing the watch. Root cause not yet investigated; candidate next step: log the raw success-callback payload shape to check whether SUM results arrive in a different field. Boundary recorded and noted for `0.1.5`.

### Final layer state (2026-08-12 end of session)

| Layer | Status | Evidence |
|---|---|---|
| `watch_module_api` | PASS | health module present, subscribe/getRecentSamples/getTodayStatistic all invoked successfully |
| `permission` | PASS | `READ_HEALTH_DATA` granted, no code 400 received |
| `sample_acquisition` | PASS | 5 nonzero live HR callbacks, 3 of 4 recent-sample metrics returned real values |
| `watch_transport` | PASS | receipt timestamp 1786522505977 |
| `backend_ingest` | PASS | relay accepted all batches |
| `database` | PASS | VPS store record_count 42 (31 PASS, 11 NO_DATA) |
| `mcp_query` | PASS | verified earlier same day via ChatGPT through the remote MCP connector |
| `phone_receive` | NO_DATA | Android-bridge-only layer, N/A on relay route |
| `phone_persistence` | NO_DATA | Android-bridge-only layer, N/A on relay route |
| `uplink` | NO_DATA | Android-bridge-only layer, N/A on relay route |

### Acceptance

All seven goals of the 2026-08-12 evening round met:

1. Real nonzero HR with real timestamps end-to-end into the store and queryable via `health_latest`.
2. Layer diagnostics reflect real execution, not stubs.
3. Three non-HR metrics verified (resting HR 61 bpm, SpO2 99 %, stress 35).
4. Zero-shape → NO_DATA mapping confirmed on device.
5. `watch_transport` ride-next-sync receipt design confirmed.
6. Store-then-forward durable queue behavior confirmed (frozen batch survived ~11.5 min and retried successfully).
7. Daily SUM statistics identified as a device capability boundary with evidence.

## `0.1.5` acceptance results (operator-run, 2026-08-12 evening UTC+8)

Same discipline as prior versions: cold app launch before each row, one test per process. Phone paired, connected over Bluetooth, and online. Build sideloaded via OrbitV (versionCode 6, SHA-256 `C8AFBE32446E30D745CBCFE68C8C7D5DA101B7B58DD78CCD52167C2D7343AE76`, 89,461 bytes).

| Test | Observed stages | Result | Store effect |
|---|---|---|---|
| `collect hr live` | Fresh nonzero HR collected and synced; `health.subscribeSample`, quality `live_sample_collect`. | **PASS** | heart_rate n=11 in store, latest value 83 bpm. Independent of the prior 62 bpm run. Repeat-collection after app reinstall confirms the pipeline is not session-bound. |
| `collect recents` | Resting HR PASS 61 bpm, SpO2 PASS 99 %, stress PASS 43. heart_rate recent = zero shape → NO_DATA (rule holding). First attempt SEND_FAIL with the KNOWN `code=-6` instant-fail signature (PC BT active for OrbitV sideload, phone proxy absent — identical to the documented 2026-08-12 afternoon incident). Recovery: PC BT off, vivo Health connected, cold start → ACK_VALID ~1 s. Frozen batch replayed idempotently, zero data loss. | **PASS** (after documented recovery) | Metrics landed. The code=-6 incident is now twice-observed with identical cause and recovery. |
| `collect stats` (run 1) | On-screen raw payload photographed. SUM types (STEP_COUNT / DISTANCE / CALORIES / STANDING / INTENSITY_SPORT): success callback delivered a LITERAL EMPTY OBJECT `raw={}` for every SUM type. CONCLUSIVE: the "wrong field read" hypothesis is dead — there are no fields at all. `getTodayStatistic` SUM types genuinely return nothing to a sideloaded quick app on this firmware. Events recorded NO_DATA with `raw_error_code: EMPTY_STAT_RESULT` and `raw={}` preserved. HEART_RATE MAX: PASS `raw={"value":178,"statisticType":2,"startTime":1786464000,"endTime":1786539544}` — full shape, `startTime` = today's local midnight in epoch seconds (more evidence for the seconds quirk). HEART_RATE MIN: `raw={"value":0,"statisticType":3,...}` → correctly recorded NO_DATA with `raw_error_code: ZERO_SENTINEL` (first on-device confirmation of the 0.1.5 sentinel rule). ACK_VALID ~3 s. | **PASS** (transport); per-metric results honestly reflect device behavior | 7 metric + 3 layer diags + transport receipt. |
| `probe sleep` | On-screen raw payload photographed. SLEEP_STATUS via `getRecentSamples`: PASS `raw=[{"dataType":13,"data":{"timeStamp":1786539849,"value":0}}]` — an instantaneous awake/asleep state (value 0 = awake, operator awake at the time; `timeStamp` = current moment in epoch seconds). Not historical sleep. SLEEP_UNIT and SLEEP_STAGES via `getRecentSamples`: both hard-fail `code=200 message "getRecentSamples failed"` — the device refuses these data types outright. Both recorded as ERROR events with raw code preserved (the store's only 2 ERROR records — intentional evidence). `health.getStatistic` (the ranged statistic API listed in SDK `featureApi.js`): ABSENT at runtime — `typeof` check found no function, ranged call skipped cleanly. No path to last-night sleep aggregates for a sideloaded app. | **PASS** (probe completed; evidence recorded) | sleep_status 1 PASS; 2 ERROR records (sleep-refusal evidence). |
| `collect stats` (run 2) | Identical shape to run 1 (batch accepted=11: 7 metric + 3 layer diags + transport receipt). Full app restart between runs. | **PASS** | Confirms deterministic repeat behavior. |

### SUM statistics: conclusive verdict

The 0.1.5 raw-payload dump answered the outstanding question from 0.1.4. The `getTodayStatistic` success callback for every SUM type (`STEP_COUNT`, `DISTANCE`, `CALORIES`, `STANDING`, `INTENSITY_SPORT`) delivers a literal empty object `{}` with no fields whatsoever — not a different field name, not unexplored nesting, not a permission issue. This is a device/firmware capability boundary for sideloaded quick apps on `WA2456C / DPD2346C_A_1.54.5`. HEART_RATE MAX/MIN continue to work via the same API with a full result shape.

### ZERO_SENTINEL rule: first on-device confirmation

`heart_rate_today_min` with `raw={"value":0,...}` was correctly mapped to NO_DATA with `raw_error_code: ZERO_SENTINEL` by the 0.1.5 watch code. This is the first real-device confirmation that the sentinel rule works as designed. The 0 bpm MIN value (which was a legal PASS in 0.1.4) is now correctly classified.

### Sleep capability verdict for WA2456C

Sleep data access for sideloaded quick apps on this device:

| Data type | API | Result | Verdict |
|---|---|---|---|
| SLEEP_STATUS (=13) | `getRecentSamples` | PASS — instantaneous awake/asleep state (`value: 0` = awake) | Available; instantaneous only, not historical |
| SLEEP_UNIT (=11) | `getRecentSamples` | ERROR `code=200 "getRecentSamples failed"` | Device refuses; unavailable |
| SLEEP_STAGES (=12) | `getRecentSamples` | ERROR `code=200 "getRecentSamples failed"` | Device refuses; unavailable |
| Sleep aggregates | `health.getStatistic` | Function absent at runtime | No API path exists |

`health_sleep` returning NO_DATA for historical windows is the device's truth. The [RESEARCH.md](RESEARCH.md) prediction for this device class (SLEEP_UNIT/SLEEP_STAGES unsupported) is now device-proven.

### code=-6 incident: twice-observed pattern

The `collect recents` first attempt failed at sync with the same `code=-6` instant-fail signature observed during the 0.1.4 session. Root cause identical: the operator had re-enabled PC Bluetooth to sideload 0.1.5 through OrbitV, leaving the watch without its phone internet proxy. Recovery followed the same procedure (PC BT off, vivo Health connected, cold start, send batch HTTPS → ACK_VALID ~1 s). The frozen batch replayed idempotently with zero data loss. This is now a twice-observed, twice-recovered pattern with a known cause and a documented one-step fix.

### Server-side 0.1.5 semantics verified

Verified live on the VPS after deploying `server/src/database.js` (backup `database.js.bak-pre015` kept on the VPS):

- `/v1/status` layers: `phone_receive` / `phone_persistence` / `uplink` now report `NOT_APPLICABLE` with note `"android bridge fallback; not on the active relay route"` (zero-record condition). All four watch layers PASS. `backend_ingest` / `database` PASS.
- `heart_rate_today_min` under PASS filter: 0 records (historical PASS-0 records excluded by the bpm zero-validity query rule). Under `status=ALL` the raw records remain visible; the latest record is the new NO_DATA ZERO_SENTINEL one.
- Regression check: `heart_rate` latest still returns real values (62 → now 83 bpm).

### Final store state (2026-08-12 end of 0.1.5 session)

94 records: 67 PASS, 25 NO_DATA, 2 ERROR (the two sleep-refusal evidence records).

Metric coverage: heart_rate 11, heart_rate_resting 3, spo2 3, stress 3, heart_rate_today_max 4, heart_rate_today_min 2 (old PASS-0s) + new NO_DATA sentinels, sleep_status 1, layer diagnostics ~10 per watch layer, watch_transport receipts 7.

### Final layer state (2026-08-12 end of 0.1.5 session)

| Layer | Status | Evidence |
|---|---|---|
| `watch_module_api` | PASS | health module present, subscribe/getRecentSamples/getTodayStatistic all invoked successfully |
| `permission` | PASS | `READ_HEALTH_DATA` granted, no code 400 received |
| `sample_acquisition` | PASS | live HR collected, 3 of 4 recent-sample metrics real values, HEART_RATE MAX real, sentinel and evidence rules confirmed |
| `watch_transport` | PASS | multiple ACK_VALID receipts |
| `backend_ingest` | PASS | relay accepted all batches |
| `database` | PASS | VPS store record_count 94 (67 PASS, 25 NO_DATA, 2 ERROR) |
| `mcp_query` | PASS | operator's ChatGPT-side MCP query returned the fresh live heart rate (83 bpm) on 2026-08-12 evening — end-consumer visibility of the 0.1.5 state confirmed |
| `phone_receive` | NOT_APPLICABLE | android bridge fallback; not on the active relay route |
| `phone_persistence` | NOT_APPLICABLE | android bridge fallback; not on the active relay route |
| `uplink` | NOT_APPLICABLE | android bridge fallback; not on the active relay route |

### Acceptance

0.1.5 acceptance goals met:

1. Sentinel rule (`ZERO_SENTINEL`) confirmed on device — `heart_rate_today_min` value 0 correctly mapped to NO_DATA.
2. SUM statistics conclusively established as a device capability boundary — literal empty object `{}`, no fields.
3. Sleep boundaries established — instantaneous SLEEP_STATUS only; SLEEP_UNIT, SLEEP_STAGES, and `health.getStatistic` all unavailable.
4. Raw-payload evidence preserved in every stat and sleep event for inspection.
5. `NOT_APPLICABLE` layer semantics live on the server for bridge-only layers.
6. Per-metric `sample_acquisition` breakdown working.
7. Pipeline regression-free — live HR, recents, and stats all still pass.
8. code=-6 incident pattern twice-observed with identical cause and documented recovery.

## Still unverified on this watch

- Long-run repeated-sync stability, screen-off/background behavior, payload-size limits, and battery cost.
- Multi-day queue retention while offline.
- The historical zero-bpm PASS record from `0.1.2` remains in the store (append-only) — 0.1.5 query validity rule now excludes it from PASS reads without mutation.
- The exact `0.1.0`/`0.1.1` reboot class and offending component (historical; not currently blocking).
- Android bridge receive/uplink (fallback only; not on the active path).
