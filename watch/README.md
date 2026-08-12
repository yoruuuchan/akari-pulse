# Akari Pulse for BlueOS

This directory is the watch-side health probe and transport producer for the `WA2456C` baseline. It never creates a synthetic health value: `PASS` is emitted only from a real BlueOS callback containing a value. Missing data and failures remain explicit as `NO_DATA`, `DENIED`, `UNSUPPORTED`, `API_MISSING`, or `ERROR`.

## Current delivery boundary

- The source compiles with the current official BlueOS Studio 2.0.5 bundled toolchain.
- Since `0.1.3` the default transport is the HTTPS adapter against the Cloudflare relay `https://pulse.yoru-and-akari.dev/v1/health/batches`, authenticated with the ingest token from `relay/.secrets.local` compiled into `src/config.js`. The BlueXlink RPC adapter remains in the tree for the `transport init` diagnostic only: on the real `WA2456C` it fails with `onError code=1001 "interconnectfeature error"` and the channel is closed (see `../docs/RESEARCH.md`). The `phoneSha256` pairing notes below apply only if that channel is ever revisited.
- The `0.1.2` isolation run on the named watch (2026-08-12) passed the entire health chain — `queue + persist`, `hr invoke only`, `hr callback only`, `hr direct ui`, and three consecutive cold-start `hr full pipeline` passes — with no reboot. The `0.1.0`/`0.1.1` reboot class remains unexplained but is not currently reproducible under isolation.
- `0.1.3` adds two one-per-launch network tests: `net probe` (three sequential GETs: third-party `generate_204` control, relay HTTPS, relay HTTP; the HTTP status code is embedded in the stage name) and `send batch https` (queue load, one marker event, production `makeBatch` → POST → strict acknowledgement → dequeue). Whether a sideloaded quick-app `fetch` reaches the internet through the paired phone is the single remaining real-device transport gate.
- `0.1.4` wires the proven health-API and HTTPS-transport pieces into three one-per-launch collect buttons: `collect hr live` (60 s HR live subscription, up to five nonzero PASS events + layer diagnostics + sync), `collect recents` (heart rate, resting HR, SpO2, stress via `getRecentSamples`, one event per metric + layer diagnostics + sync), and `collect stats` (`getTodayStatistic` for step_count / distance / calories / standing / intensity_sport SUM and heart-rate MAX/MIN + layer diagnostics + sync). Real values only; the device recent-sample zero-shape `value: 0, sample_timestamp: 0` is mapped to `NO_DATA` at watch parse time (contract decision documented in `../docs/DIAGNOSTICS.md` and `../docs/REAL_DEVICE_RESULTS.md`). A `watch_transport` PASS diagnostic describing an ACK'd batch is enqueued after the ACK and rides the next sync, so the layer summary in the store reflects verified past success rather than a claim in advance.

## Source layout

```text
watch/
├─ .ide/settings.json          watch-square preview at 390 × 450
├─ package.json                Studio-terminal convenience commands
├─ README.md                   evidence, build, signing, and probe boundary
└─ src/
   ├─ app.ux                   BlueOS app entry
   ├─ config.js                device and transport configuration
   ├─ manifest.json            features and health/sensor permissions
   ├─ assets/images/logo.png   114 × 114 Akari/Yoru project asset
   ├─ lib/
   │  ├─ collect-runs.js       0.1.4 collect+sync orchestrators (hr live, recents, stats)
   │  ├─ collector.js          reference health probes, HR live subscription, step counter
   │  ├─ hr-diagnostics.js     one-test-per-launch HR/control isolation harness
   │  ├─ events.js             locked event envelope, failure mapping, zero-shape helper
   │  ├─ queue.js              persistent bounded unsent queue and stable retry batch
   │  ├─ net-diagnostics.js    0.1.3 net probe + send batch https harness
   │  ├─ rpc-adapter.js        official BlueXlink connection/send/onMessage adapter
   │  ├─ http-adapter.js       relay HTTPS adapter with strict ACK validation
   │  └─ transport.js          adapter selection, ACK gate, transport-success diagnostic
   └─ pages/home/index.ux      single-page diagnostics UI
```

The UI follows the local Yoru/Akari console vocabulary: lowercase labels, midnight/indigo surfaces, sparse ember accents, error-only status dots, and diagnostics collapsed by default. The runtime and compiler constraints take precedence over decorative behavior.

## Manifest and imports verified against current official pages

The source uses these exact declarations and imports:

| Capability | Manifest feature | Import | Permission |
|---|---|---|---|
| Health | `blueos.health.health` | `@blueos.health.health` | `watch.permission.READ_HEALTH_DATA` |
| Step sensor | `blueos.hardware.sensor.sensor` | `@blueos.hardware.sensor.sensor` | `watch.permission.STEP_COUNTER` |
| K-V queue | `blueos.storage.storage` | `@blueos.storage.storage` | none documented |
| HTTP fallback | `blueos.network.fetch` | `@blueos.network.fetch` | none documented |
| Official RPC | `blueos.bluexlink.connectionManager` | `@blueos.bluexlink.connectionManager` | none documented |

Primary official evidence:

- [Health API](https://developers-watch.vivo.com.cn/api/health/health/) (page update `2025/06/30 19:53:14`) specifies `dataTypes: DataType[]`, `success(recentSamples: RecentSample[])`, `subscribeSample.callback(sample: Sample)`, `getTodayStatistic.success(statistic: Statistic)`, and `fail(data: string, code: number)`.
- [Sensor API](https://developers-watch.vivo.com.cn/api/system/sensor/) (page update `2024/11/21 17:51:08`) specifies `subscribeStepCounter({callback, fail})`, callback property `steps`, unsupported code `1000`, cumulative steps since reboot, and `unsubscribeStepCounter()` with no arguments.
- [K-V storage](https://developers-watch.vivo.com.cn/api/storage/localstorage) (page update `2025/10/09 11:25:10`) specifies `getSync({key})`, asynchronous `set({key,value,success,fail})`, and storage-full code `302`.
- [Fetch API](https://developers-watch.vivo.com.cn/api/system/fetch/) (page update `2024/10/11 11:55:18`) specifies `fetch.fetch({url,data,header,method,responseType,timeout,success,fail})`; the success object contains HTTP `code`, `data`, and `headers`, while API failure is `fail(data, code)`.
- [BlueXlink watch API](https://developers-watch.vivo.com.cn/api/connect/interconnect/) (page update `2025/01/17 11:58:56`) specifies `interconnect.instance({package,fingerprint})`, `connect.send({data,success,fail})`, `onOpen`, `onClose`, `onMessage`, and `onError`.
- [BlueXlink phone SDK guidance](https://developers-watch.vivo.com.cn/api/connect/development-guidance/rpc-sdk-guidance) describes the Android SDK initialization and is the authority for the phone companion requirements.
- [Current manifest reference](https://developers-watch.vivo.com.cn/reference/configuration/manifest/) explains feature and permission arrays.
- [Current quick start](https://developers-watch.vivo.com.cn/reference/quickstart/quick-start/) describes Studio debug/release packaging and the `dist` output.

The old 2023 BlueXlink guidance page spells the property `onmessage`; the current API page and the distributed upstream declaration use `onMessage`. This implementation uses current `onMessage`. The current online page documents `getReadyState.status` as `1` connected and `2` disconnected, while the available SDK declaration still says `0/1`; Akari does not infer business delivery from that disputed value and instead treats `onOpen`, send failure, and a correlated business ACK as the observable boundaries.

## Health API shapes and metric mapping

Official `Sample` is `{timeStamp, value}`. Official `RecentSample` is `{dataType, data: Sample}`. Official `Statistic` is `{value, statisticType, startTime, endTime}`.

The current official `DATA_TYPES` values are:

| Constant | Value | Official unit/notes | Akari metric |
|---|---:|---|---|
| `HEART_RATE` | 0 | bpm | `heart_rate` |
| `HEART_RATE_STEP` | 1 | bpm | `heart_rate_step` |
| `HEART_RATE_RESTING` | 2 | bpm | `heart_rate_resting` |
| `STANDING` | 3 | hour; statistics only | `standing` |
| `INTENSITY_SPORT` | 4 | minutes; statistics only | `intensity_sport` |
| `STEP_COUNT` | 5 | steps; statistics only | `step_count` |
| `SPO2` | 6 | % | `spo2` |
| `DISTANCE` | 7 | m; statistics only | `distance` |
| `CALORIES` | 8 | kcal; statistics only | `calories` |
| `STRESS` | 9 | no unit | `stress` |
| `WALKING_SPEED` | 10 | steps/min | `walking_speed` |
| `SLEEP_UNIT` | 11 | temporarily unsupported | `sleep_unit` with `UNSUPPORTED` |
| `SLEEP_STAGES` | 12 | temporarily unsupported | `sleep_stages` with `UNSUPPORTED` |
| `SLEEP_STATUS` | 13 | 0 awake, 1 sleeping | `sleep_status` |
| `ENERGY` | 14 | temporarily unsupported | `energy` with `UNSUPPORTED` |
| `WALKING_STATUS` | 15 | 0 not walking, 1 walking | `walking_status` |
| `SPEED` | 16 | temporarily unsupported | `speed` with `UNSUPPORTED` |

Official statistic constants are `AVERAGE=0`, `SUM=1`, `MAX=2`, and `MIN=3`. The published support matrix permits max/min for heart rate, SpO2, and stress, and sum for standing, intensity sport, step count, distance, and calories. The probe uses only those published combinations.

## Isolated probe behavior

Version `0.1.2` is a diagnostic harness, not the full capability screen. Startup only registers two in-memory observers. It does not read or write storage, initialize BlueXlink, call health/sensor methods, start a subscription, send a batch, or schedule a retry. One test is allowed per app process; relaunch before every row.

| Button | Included boundary | Explicitly excluded |
|---|---|---|
| `ui control` | handler, observer, reactive UI and log | every native module |
| `storage set + read` | small string `storage.set.success` followed by exact `getSync` match | health, queue, transport |
| `queue + persist` | non-health event, event ID/time, queue snapshot clone, `storage.set.success` | health and transport |
| `hr invoke only` | one official singleton Recent HR call with empty success/fail functions | callback logging, payload access, parse, queue, storage, transport |
| `hr callback only` | the same call plus a first-statement callback-entry marker | success payload access/parse, queue, storage, transport |
| `hr direct ui` | callback marker, singleton sample selection, value/timestamp parse, direct UI | queue, storage, transport |
| `hr full pipeline` | callback, parse, event, isolated queue, snapshot, `storage.set`, UI only after exact persist success | automatic transport and all sending |
| `transport init` | manual `interconnect.instance` and `onOpen` observation | send, sync, health |

Every Recent HR path calls exactly `health.getRecentSamples({dataTypes: [health.DATA_TYPES.HEART_RATE], success, fail})`; it does not use `complete` as evidence. `success([])` or a callback without a usable value is `NO_DATA`. The 60-second survival marker is process evidence, not a health result. `hr invoke only` intentionally cannot reveal whether its empty callback ran.

The full path exposes `CALLBACK_ENTERED_*`, `PARSE_*`, `QUEUE_MEMORY`, `BEGIN_SNAPSHOT`, `SNAPSHOT_READY`, `BEGIN_STORAGE_SET`, and `STORAGE_SUCCESS`. Use `load saved queue state` after a reboot to inspect the last successfully persisted diagnostic event, then relaunch again before another test. The adaptive test order and interpretation are in `../docs/DIAGNOSTICS.md` and `../docs/REAL_DEVICE_RESULTS.md`.

The old `0.1.0` Run probe synchronously issued eight singleton `getRecentSamples` calls followed by eleven `getTodayStatistic` calls without awaiting any callback. Source order was `HEART_RATE`, `HEART_RATE_STEP`, `HEART_RATE_RESTING`, `SPO2`, `STRESS`, `WALKING_SPEED`, `SLEEP_STATUS`, `WALKING_STATUS`, then `HEART_RATE/MAX`, `HEART_RATE/MIN`, `SPO2/MAX`, `SPO2/MIN`, `STRESS/MAX`, `STRESS/MIN`, `STANDING/SUM`, `INTENSITY_SPORT/SUM`, `STEP_COUNT/SUM`, `DISTANCE/SUM`, and `CALORIES/SUM`. It then recorded local unsupported observations for `SLEEP_UNIT`, `SLEEP_STAGES`, `ENERGY`, and `SPEED`; those four did not make health API calls. Consequently, seeing `82 bpm` did not mean the other eighteen native calls had not already been dispatched.

Failure mapping is deliberate:

- health/sensor code `400` → `DENIED`;
- code `402` (permission was not declared/configured) → `API_MISSING`;
- step sensor code `1000` → `UNSUPPORTED`;
- absent module/function/enum → `API_MISSING`;
- successful callback without a value → `NO_DATA`;
- another callback failure or thrown external call → `ERROR`.

Layer observations use the shared `diagnostic_<layer>` names: `diagnostic_watch_module_api`, `diagnostic_permission`, `diagnostic_sample_acquisition`, and `diagnostic_watch_transport`.

## Queue and acknowledgement rules

The `0.1.2` diagnostic queue key is `akari.pulse.unsent.diagnostic.v1`. The earlier `akari.pulse.unsent.v1` queue is deliberately not loaded, overwritten, or deleted, so old burst-probe events cannot contaminate health/storage isolation. The active queue holds at most 200 ordinary events plus dedicated transport/overflow diagnostics. If the bound is reached, the oldest ordinary event is replaced, `dropped_count` is persisted and shown in the UI, and a `diagnostic_watch_transport` overflow event remains pending; overflow is never silent.

Each event satisfies the locked contract: required `event_id`, epoch-ms `timestamp`, lower-snake `metric`, `source_device`, and `status`; `PASS` always carries `value`. Device sample time is preserved as `sample_timestamp`. Live callback spacing is preserved as `callback_delta_ms`.

`makeBatch()` persists the exact pending batch, including its `batch_id`, before transport. A failure, timeout, process restart, or invalid ACK retries that stable batch. New events stay queued behind it. A matching ACK removes only the IDs in that batch.

The HTTP adapter removes a batch only when all of these hold:

1. the HTTP status is 2xx;
2. parsed body `ok === true`;
3. `data.batch_id` equals the submitted batch ID;
4. `accepted` and `duplicates` are non-negative integers; and
5. `accepted + duplicates === batch.events.length`.

The RPC adapter sends exactly:

```json
{
  "type": "akari.health.batch.v1",
  "data": { "batch_id": "...", "producer": "...", "sent_at": 0, "events": [] }
}
```

Official `connect.send.success()` has no response argument and is not a business acknowledgement. The queue remains intact after that callback. Akari waits for `connect.onMessage` to deliver a decoded object with `code === 0`, matching `result.batch_id`, valid non-negative `result.accepted`/`result.duplicates`, and a full count match. Whether the current phone SDK response reaches this watch callback on `WA2456C` is still a real-device question.

Phone-to-watch controls are accepted only as:

```json
{"type":"akari.session.start","data":{"session_id":"...","started_at":1786245212500}}
{"type":"akari.session.stop","data":{"session_id":"...","ended_at":1786245312500}}
```

The session ID and timestamps are persisted. A remote start records the session but deliberately does not start any health or sensor subscription; subscriptions now require the corresponding on-watch button. Stop verifies the active session, cleans up any active subscriptions, and clears it. The official Android `notify` call is one-way, so the phone may report only dispatched/pending confirmation, never “watch executed”, without separate observed evidence.

## Upstream skeleton evidence

The three requested upstream repositories were read at fixed commits:

- [`Star7-Github/watch-demo@469f353`](https://github.com/Star7-Github/watch-demo/tree/469f353385004dafb7861313dfe7860978cbf252): its [README lines 5–20](https://github.com/Star7-Github/watch-demo/blob/469f353385004dafb7861313dfe7860978cbf252/README.md#L5-L20) defines the `sign/`, `src/assets`, `src/pages`, `app.ux`, and manifest skeleton; [manifest lines 27–34](https://github.com/Star7-Github/watch-demo/blob/469f353385004dafb7861313dfe7860978cbf252/src/manifest.json#L27-L34) demonstrate watch device types and 466 design width. Its [package lines 1–8](https://github.com/Star7-Github/watch-demo/blob/469f353385004dafb7861313dfe7860978cbf252/package.json#L1-L8) contain no build tool dependency or build script.
- [`Star7-Github/vbook-master@dfbfe35`](https://github.com/Star7-Github/vbook-master/tree/dfbfe35bf272cdd42046680c610e66c028e54adf): [manifest lines 10–50](https://github.com/Star7-Github/vbook-master/blob/dfbfe35bf272cdd42046680c610e66c028e54adf/src/manifest.json#L10-L50) show real feature declarations and watch targets; Transfer [lines 88–93](https://github.com/Star7-Github/vbook-master/blob/dfbfe35bf272cdd42046680c610e66c028e54adf/src/pages/Transfer/index.ux#L88-L93) and [210–220](https://github.com/Star7-Github/vbook-master/blob/dfbfe35bf272cdd42046680c610e66c028e54adf/src/pages/Transfer/index.ux#L210-L220) import and select `@blueos.network.fetch`. The repository tracks round and square release RPKs, demonstrating the real output layout, but it also tracks a public `sign/private.pem`; Akari does not copy or trust that key.
- [`EvilIrving/vivo-watch-crawler@62b3784`](https://github.com/EvilIrving/vivo-watch-crawler/tree/62b3784eaa4cb36807127351e18dac7f405a892b): its generated health declaration is useful as historical evidence but stale. [health.d.ts lines 22–50](https://github.com/EvilIrving/vivo-watch-crawler/blob/62b3784eaa4cb36807127351e18dac7f405a892b/data/api/health/health.d.ts#L22-L50) incorrectly says singular `dataType` and an object success result; [lines 69–85](https://github.com/EvilIrving/vivo-watch-crawler/blob/62b3784eaa4cb36807127351e18dac7f405a892b/data/api/health/health.d.ts#L69-L85) incorrectly types the sample callback as `Array<string>`. Current live official HTML is the implementation authority.

The vbook sensor declaration is consistent with the current live sensor page: [sensor.d.ts lines 80–109](https://github.com/Star7-Github/vbook-master/blob/dfbfe35bf272cdd42046680c610e66c028e54adf/node_modules/@types/blue-os/hardware/sensor/sensor.d.ts#L80-L109) has `callback({steps})` and argument-free unsubscribe.

## Build and signing

Open this directory in BlueOS Studio and choose a `watch-square` debug package, or run the compiler bundled with Studio. The exact command used on this machine was:

```powershell
$studio = "$env:TEMP\bos205\resources\app\extensions\blueos-debugger"
& "$studio\media\node\node.exe" `
  "$studio\node_modules\blueos-pack\bin\index.js" `
  build --device-type watch-square -f
```

Before a final rebuild after changing source or the companion certificate fingerprint, remove the generated `build/` directory and `node_modules/.cache/`. The tested `blueos-pack ... build -f` path did not invalidate every cached page/module by itself on this machine.

Verified compiler identity:

```text
BlueOS Studio 2.0.5
blueos-pack 1.0.9-beta.24
compiler commit 2b772929
Node.js 18.20.3
Windows x64
```

The bundled package also documents `jax build` and `jax release`; the package scripts are convenience commands for a Studio terminal where `jax` is available. `blueos-pack` was not available from the public npm registry during verification, so `pnpm install` alone is not claimed to install the compiler.

The successful debug build creates:

```text
dist/watch-square/debug/com.akaripulse.watch.debug.0.1.2.rpk
```

The final clean-cache layered-diagnostic build on 2026-08-11 is also copied to `../artifacts/akari-pulse-watch-debug-0.1.2.rpk`:

```text
size:       69,649 bytes
SHA-256:    D5A368469F556A379575178ACFA57530D35546D44742433788F13ED8EE0E98C6
package:    com.akaripulse.watch
version:    versionCode 3 / versionName 0.1.2
debug/min:  true / minPlatformVersion 1070
```

The relay-route build on 2026-08-12 (same toolchain, clean `build/` and cache) is copied to `../artifacts/akari-pulse-watch-debug-0.1.3.rpk`:

```text
size:       75,466 bytes
SHA-256:    BFCCEA5B7181BFE20C7B547EA05E5025DC7DE76703A98A60D75BF95D1328E0A1
package:    com.akaripulse.watch
version:    versionCode 4 / versionName 0.1.3
debug/min:  true / minPlatformVersion 1070
```

The 0.1.4 collect-and-sync build on 2026-08-12 (same toolchain, clean `build/`, `dist/`, and `node_modules/.cache`) is copied to `../artifacts/akari-pulse-watch-debug-0.1.4.rpk`:

```text
size:       84,899 bytes
SHA-256:    AF16F9E39CEBB67AB79408B03668907CD40BBBFB6F6705599A9C8808FC63372B
package:    com.akaripulse.watch
version:    versionCode 5 / versionName 0.1.4
debug/min:  true / minPlatformVersion 1070
```

The 0.1.5 evidence-and-boundary build on 2026-08-12 (same toolchain, clean `build/`, `dist/`, and `node_modules/.cache`) is copied to `../artifacts/akari-pulse-watch-debug-0.1.5.rpk`:

```text
size:       89,461 bytes
SHA-256:    C8AFBE32446E30D745CBCFE68C8C7D5DA101B7B58DD78CCD52167C2D7343AE76
package:    com.akaripulse.watch
version:    versionCode 6 / versionName 0.1.5
debug/min:  true / minPlatformVersion 1070
```

`0.1.5` keeps every `0.1.4` button unchanged and:

- Tightens `collect stats`: the `getTodayStatistic` success handler records
  the raw payload of every call (`JSON.stringify`, truncated to 1500 chars)
  as `raw_error_message` on `NO_DATA`/`ZERO_SENTINEL` events, and always as
  an on-screen `note` extra so one on-device run produces conclusive
  evidence of the SUM result shape.
- Adds the `ZERO_SENTINEL` rule for `heart_rate_today_max/min`: value 0
  becomes `NO_DATA` with `raw_error_code: ZERO_SENTINEL` (0 bpm is
  physiologically impossible; MIN aggregates include non-wear windows on
  this firmware). Applies ONLY to bpm-family metrics; step/distance/calorie
  zeros remain valid daily totals.
- Changes the `sample_acquisition` layer diag to a per-metric breakdown
  message (`"PASS: hr_today_max; NO_DATA: hr_today_min, step_count, ..."`)
  instead of the previous `"N PASS of M"` summary.
- Adds one new one-per-launch button `probe sleep` that runs
  `getRecentSamples` for `SLEEP_STATUS`, `SLEEP_UNIT`, `SLEEP_STAGES` and,
  if `health.getStatistic` exists at runtime, one ranged probe on
  `SLEEP_STATUS` over a last-night device-local window
  (yesterday 18:00 → today 12:00). Every call records its raw payload as
  evidence.

`0.1.5` was device-verified on 2026-08-12 — see
`../docs/REAL_DEVICE_RESULTS.md` for the full acceptance results.

The packaged manifest contains `appCategory: [sports]`, `debug: true`, compiler-derived `minPlatformVersion: 1070`, both `watch-square` and `watch-round`, the two required health/sensor permissions, and compiled feature aliases for health, sensor, storage, fetch, and interconnect. Independent audit verified the outer and nested ZIP CRCs, both Pair1 and Pair2 RSA signatures, both chunked content digests, certificate/public-key equality, all five outer resource digests, and all four nested `hash.json` resource digests. The automatic debug certificate is `CN=RPKDebug, O=RPK, C=CN`, SHA-256 `6D3E6A3DCBDADB0AA94F64E33A36B01254CB6EF7E14BE282D885CD95AEB952E0`.

There is intentionally no `sign/` directory in this source. The official compiler's debug build created `META-INF/CERT` automatically. That is a tool-generated debug package signature, not production developer signing, not the Android APK fingerprint, and not evidence of store eligibility. A release build requires the owner's own certificate/private key generated through BlueOS Studio; do not commit `private.pem`. No upstream demo private key is used or delivered.

## Proven versus real-device work

Proven by host inspection or the recorded named-watch observations:

- current official module names, features, permissions, callbacks, error signatures, data type table, and statistic support matrix;
- current official BlueXlink watch-side `instance`/`send`/event API shape;
- real upstream BlueOS project structure, device targets, network module usage, signing-directory convention, and tracked RPK layout at the fixed commits above;
- compilation of this source into a debug watch-square RPK with the official Studio 2.0.5 toolchain;
- package inspection showing the compiled manifest, `META-INF/CERT`, app bytecode, logo, and build metadata;
- source has no `sign/` directory or private key;
- successful OrbitV installation of `0.1.0`, approval of `READ_HEALTH_DATA`, and one real `getRecentSamples([HEART_RATE])` result of `82 bpm` on the named watch;
- successful OrbitV installation of byte-identified `0.1.1`, at least one minute of idle stability, and a later full-watch reboot after the only tap was `Recent HR`, with no new value visible;
- the host-side OrbitV installation records completed successfully while the available encrypted application log and absent device-log pull did not identify either watch reboot reason.

Requires the physical `WA2456C` running the stated BlueOS 3.0 baseline:

- whether the layered `0.1.2` RPK installs and which first isolated boundary, if any, reproduces the reboot;
- whether the empty-callback Recent HR invocation survives for 60 seconds, and whether callback entry, parse/direct UI, or queue/storage changes that outcome;
- whether `STEP_COUNTER` is granted and usable; `READ_HEALTH_DATA` was granted once for `0.1.0` but should be rechecked after updating;
- which current data types produce values, `NO_DATA`, `DENIED`, or runtime errors on this model;
- real HR/step callback timing, step reset behavior across a reboot, and power cost;
- whether `blueos.bluexlink.connectionManager` exists and pairs with `dev.akari.pulse.bridge` on this watch;
- BlueXlink enforcement of the configured current debug APK signer SHA-256 fingerprint on this watch; the fingerprint itself was obtained from the delivered APK and compiled into this RPK, but the pairing remains a real-device test;
- whether Android `DeviceRpcManager.onResponse(...)` appears on the watch as `connect.onMessage`, and the exact real-device acknowledgement timing;
- whether the HTTP `127.0.0.1:23102` fallback reaches the Android bridge on a real watch;
- background lifetime, process death, OEM battery policy, and reconnection behavior.

Do not report any item in the second list as passed until logs from the named watch and matching Android APK demonstrate it.
