# Real-device verification results

This document records **capability evidence**, not the operator's personal health log.

Exact heart-rate, SpO2, stress, step, distance, calorie, sleep, account, token, private endpoint, batch-ID, and device-identifier values are intentionally omitted from the public repository. A real-device result is considered verified when the source/API/provider, status semantics, and UI or downstream contract behavior were observed on the named device.

## Verified baseline

### Watch

- Device family: vivo WATCH GT, first-generation Bluetooth model `WA2456C`
- OS: BlueOS 3.0
- Verified firmware baseline: `DPD2346C_A_1.54.5`
- Watch app line: `0.1.2` through `0.1.5`

### Phone

- vivo X200 Pro (`V2405A` / `PD2405`, Android 15) used as the verified phone baseline
- Android bridge installed in place across schema migration tests
- vivo Health / assistant provider behavior verified on the physical phone
- vivo private health providers verified on this device only, behind an explicit owner ADB grant

Compatibility on other vivo/iQOO models or firmware remains unverified until tested. The private-provider route is additionally ROM-dependent: a firmware that refuses the permission grant reports `NOT_GRANTED`, and that is treated as the honest answer rather than something to work around.

## Watch health chain

The physical watch verified the following path end to end:

```text
BlueOS health callback
  -> watch parser
  -> immutable queued event
  -> HTTPS relay transport
  -> durable relay buffer
  -> Akari Health service
  -> SQLite
  -> MCP query
```

### Confirmed PASS capabilities

- live heart-rate collection through the BlueOS health callback;
- recent resting-heart-rate observation when the firmware exposes one;
- recent SpO2 observation when available;
- recent stress observation when available;
- watch-side health/permission/sample-acquisition diagnostics;
- durable queued retries across a transport failure;
- relay acknowledgement validation before dequeuing;
- backend ingest and MCP visibility of the same physical-watch record.

Real nonzero values were observed and compared across device/UI/backend/MCP during verification. Their numeric values are deliberately redacted from this public report.

### Zero and missing-data semantics

A callback shape representing no physiological sample is normalized to `NO_DATA`, not to a successful numeric zero when zero is not physiologically valid for that metric.

This distinction was verified on the physical device and remains part of the contract. A later valid nonzero observation does not retroactively change an earlier `NO_DATA` record.

## Watch daily activity boundary

On the verified `WA2456C` firmware, BlueOS daily SUM statistic calls for step count, distance, calories, standing, and sport intensity returned successful callbacks with an empty result object.

The public conclusion is therefore:

- watch-side live/recent vital data: available for the verified metrics;
- watch-side daily activity totals through this sideloaded quick-app API: `NO_DATA` / capability boundary;
- do not fabricate daily totals from unrelated sensor counters.

Phone daily summaries are kept as a separate source rather than being used to overwrite the watch source.

## Watch sleep boundary

On the verified watch firmware:

- instantaneous sleep status could be observed;
- sleep unit/stage recent-sample calls failed on device;
- the ranged statistic API expected from SDK metadata was not available at runtime.

Therefore the watch quick-app path does **not** claim last-night duration or sleep-stage history.

Any phone-local sleep integration must be represented as its own source and verified independently. That independent verification was completed on 2026-08-14 through the vivo private providers described below; it does not change this watch boundary, and neither source overwrites the other.

## Watch transport verification

### HTTPS over paired-phone connectivity

The sideloaded watch app successfully reached an operator-owned HTTPS relay through the paired phone's network proxy. TLS and application-level acknowledgement were both observed on the physical watch.

### Retry behavior

A controlled transport failure left the frozen batch queued. After connectivity was restored, the same immutable batch was resent and accepted without data loss.

This is the required behavior: a transport callback alone is not success; the watch dequeues only after a matching business acknowledgement.

## Official BlueXlink / device RPC verdict

The official BlueXlink/device-RPC candidate was exercised on the verified watch and failed at runtime with the documented `code=1001 interconnectfeature error` condition.

Combined with the public compatibility evidence recorded in [RESEARCH.md](RESEARCH.md), the route is classified as:

`UNSUPPORTED_OR_CREDENTIAL_BLOCKED`

The repository keeps the diagnostic path buildable, but production does not depend on it.

## Vivo phone daily activity

A phone-local provider path was verified for three natural-day cumulative metrics:

- `phone_step_count` (`count`)
- `phone_distance` (`m`)
- `phone_calories` (`kcal`)

Canonical source:

`vivo_phone`

Provider-derived source metadata is preserved:

- `source_day`
- `source_timezone`
- observation-only `sampled_at`
- `source_timestamp_available=false` when the provider does not expose the event timestamp
- `PASS`, `NO_DATA`, and `ERROR` remain distinct
- a legitimate numeric zero remains `PASS`

### UI verification

Multiple physical-phone reads were compared with the vivo Health / assistant UI. Nonzero daily values matched the UI at verification time. The public repository records the match, not the operator's exact values.

No Settings value or stale cache was used to manufacture success.

## Vivo private health providers (sleep and latest vitals)

Verified on 2026-08-14 on the vivo X200 Pro (`V2405A` / `PD2405`, Android 15). This route is **not** ADB-free: it depends on an explicit owner grant described under "Owner ADB bootstrap" below.

Two private providers were read:

| Provider | Content | Akari source |
|---|---|---|
| `content://com.vivo.health.provider/sleep` | latest sleep record only (one session) | `vivo_phone` |
| `content://com.vivo.health.provider.care/healthCare` | `MYSELF_DATA` HealthDetailBean JSON | `vivo_phone` |

### Sleep

The real cursor exposed **38 columns**. The reader addresses every field by column name and never by ordinal position, so a firmware that reorders or extends the cursor cannot silently shift a value into the wrong field. Only columns whose semantics were confirmed against the vivo Health UI are mapped; unconfirmed columns are ignored rather than guessed.

Day attribution, timezone, and event timestamps come from the provider's own columns. Akari does not re-bucket a sleep day from its own observation time, and it does not infer a missing stage.

Three arithmetic identities were confirmed to hold exactly in the stored production record:

```text
light + deep + rem            == total sleep duration
wake time - sleep-onset time  == chart total duration
chart total duration - awake  == night sleep duration
```

Wake-up counting matches the vivo UI only when awake intervals are restricted to those lying **strictly inside** the sleep-onset/wake window; boundary intervals are excluded. Both the count and the aggregate awake duration produced by that rule matched the UI at verification time.

The stored record carries sleep onset, wake time, total/light/deep/REM/awake durations, wake-up count, nap duration, sleep score, deep-sleep continuity, the provider's recorder generation, and the per-stage interval lists.

### Latest vitals

`MYSELF_DATA` parses to the newest single observation for heart rate, SpO2, and stress, each with **its own measurement timestamp** and abnormality flag, plus the originating source recorded by vivo.

These are explicitly *latest single points*. The contract does not expose a daily minimum, maximum, average, or resting value derived from them, and downstream tools state that semantic in their own output. A latest point is never presented as a daily statistic.

The measurement timestamps are demonstrably distinct from Akari's read time: in the verified reads the three vitals carried three different provider timestamps, none of which equalled the moment Akari performed the read.

### UI pairing

A physical read was performed within seconds of reading the vivo Health UI on the same phone. Heart rate, SpO2, stress, and last-night total sleep duration each matched the UI value **and** the UI's stated observation time. The public repository records that the pairing matched; the operator's numeric values are intentionally omitted.

No UI text scrape, OCR, Settings value, or cached response was used at any point. The reader has no such fallback path.

## Owner ADB bootstrap

`com.vivo.health.widget.permission` is declared `signature|privileged`, so a third-party build never receives it at install time. On the verified device the owner can grant it once over ADB with `scripts/bootstrap-vivo-private-health.ps1`.

Verified script behavior on the physical phone:

- missing adb, no authorized device, ambiguous multi-device attach, and a package that is not installed each produce an explicit `FAIL` and no state change;
- a missing provider authority reports the route as `UNSUPPORTED` on that device rather than attempting the grant;
- the verdict is read back from `dumpsys package`, never inferred from the `pm grant` exit code, because a ROM can accept the command without changing anything;
- vivo clone-app / private-space users appear as additional `granted=false` entries under their own user IDs; only the primary user's entry decides the verdict;
- `-Revoke` was verified: after revocation the entry disappears from the granted list entirely, and that absence is correctly read as "not granted" rather than as an error;
- re-running the grant on an already-granted device is idempotent and still reports `PASS`.

**Reinstalling the APK clears the grant.** This was demonstrated rather than assumed: an in-place `adb install -r` left the app reporting `NOT_GRANTED` until the bootstrap was re-run.

### Capability state, not silent fallback

Akari exposes a `vivo_private_health_provider` capability with four distinct states: `GRANTED`, `NOT_GRANTED`, `UNSUPPORTED`, and `ERROR`.

A read taken *before* the bootstrap was verified to report `NOT_GRANTED` with the provider authorities resolved and **every value null**. It did not return a cached value, an older observation, or a substituted source. Losing the permission produces an honest negative state, never a disguised success.

The capability result is uploaded as its own diagnostic observation, so `/v1/status` reports the private-provider layer independently of the watch layers. On the verified device that layer reported `PASS` with sleep and vitals outcomes recorded separately.

### Scope of this result

Verified on the vivo X200 Pro (`V2405A` / `PD2405`, Android 15) with the ROM installed on that device at the time of testing.

No claim is made that other vivo or iQOO models, or other firmware versions, expose these providers or permit this grant. A ROM that refuses the grant yields `FAIL` from the script and `NOT_GRANTED` in the app; neither is worked around. A system update, a device change, or an APK reinstall may require re-authorization or full re-verification.

The officially supported, ADB-free third-party route remains vivo's Health Kit. This private-provider route is an owner-controlled path for the operator's own device, not a distribution mechanism.

## Android Room and immutable outbox

Room schema v2 was verified on a physical phone with an in-place migration.

The migration preserved existing watch records and added:

- current phone daily-summary rows keyed by `(source, metric, source_day)`;
- immutable phone daily-summary upload batches.

Each real phone read performs one transaction that updates the current rows and creates an immutable outbox payload.

For the same source/day, later cumulative observations replace the current value; they are not added together. Synthetic integration tests cover increasing cumulative values to verify replacement semantics.

Schema v3 was then verified the same way on 2026-08-14. It adds current sleep-summary rows keyed by `(source, source_day)` and their own immutable upload batches. The migration is an explicit `MIGRATION_2_3`; no destructive fallback is registered, so a failed migration would surface as a crash rather than as silent data loss.

Both migrations are covered by on-device instrumentation tests (`OK (2 tests)`), and the in-place upgrade was confirmed on the real phone: `firstInstallTime` was unchanged while `lastUpdateTime` advanced, and the upgraded app opened and read normally against the pre-existing database.

## Relay and backend

The phone daily-summary route is separate from the watch-event route and uses a separate ingest credential.

Verified behavior includes:

- missing credential -> `401`;
- valid credential + invalid body -> contract validation error after authentication;
- replay handling;
- stale observation handling;
- conflicting same-timestamp payload -> conflict response;
- durable relay buffering before acknowledgement;
- successful drain to the production backend;
- current phone rows stored independently of immutable historical batches.

The existing watch records were preserved while the phone route was introduced.

### Sleep-summary route

A third route, `/v1/health/sleep-summaries`, was added for the vivo private sleep day and verified end to end on 2026-08-14 with a real phone upload:

- the phone's queued health events and its sleep-summary batches were uploaded by the app itself over its own credential;
- the relay buffered both kinds durably and recorded each batch's target backend path;
- the single VPS drain forwarded every batch unchanged and deleted relay rows only after the backend acknowledged that exact batch;
- the backend stored **one row per `source_day`**: repeated reads of the same night arrived as separate immutable batches and each was accepted as a newer observation of the same day, leaving a single current row rather than duplicates.

The backend schema advanced 2 → 3 through an explicit versioned migration. Existing watch records and phone daily summaries were preserved across it.

2026-08-14 addendum: per-`source_day` keying proved lossy on a real nap day — the provider exposes only its latest record, so an afternoon nap read displaced the stored night sleep. Sleep rows are now keyed per session (`source`, `source_day`, `sleep_start`; backend schema 4, Room 4), the night sleep and naps kept side by side, newer-wins per session.

## MCP verification

A real MCP client, using the project's Streamable HTTP transport, verified that production queries can expose phone and watch sources side by side.

Confirmed behavior:

- `health_status` reports backend/database/MCP layers explicitly;
- `health_today` returns phone daily summaries with their original source day/timezone semantics;
- `health_steps` can return a phone `PASS` next to a watch `NO_DATA` without merging or precedence;
- `health_latest(metric=heart_rate)` continues to return the verified watch source after phone daily-summary support is enabled.

No MCP tool rewrites a phone value as a watch value.

### 2026-08-14 private-provider MCP verification

Re-verified against the production Streamable HTTP MCP after the private-provider work landed, using a real MCP client over the deployed endpoint:

- `health_sleep` answers last night from the phone source with sleep onset, wake time, total, deep, light, REM, wake-up count and aggregate wake duration, sleep score, and deep-sleep continuity, labelled `vivo_phone` and returned next to the watch sleep observations;
- `health_sleep` for a day with no stored phone sleep returns an explicit "no vivo sleep day stored" instead of substituting an adjacent day;
- `health_heart_rate`, `health_spo2`, and `health_stress` return the watch source and the phone source **side by side**, each with its own device label and its own source time, with an explicit statement that no merge or precedence is applied;
- the timestamped `health_heart_rate` mode returns the nearest real watch sample plus the phone's latest snapshot, carrying a machine-readable note that the phone value is a single latest point and not a windowed sample or daily aggregate;
- `health_steps` and `health_today` still return the phone daily summaries introduced earlier, unchanged;
- `health_status` reports the private-provider layer alongside the watch layers.

The watch and phone records remained fully distinct in the structured output: different `event_id`, `source_device`, `source_api`, and `quality` fields. Neither source overwrote the other, and no tool assigned a precedence between them.

## Deployment verification

The production-style deployment has been exercised with:

- Akari Health service;
- SQLite persistence;
- Streamable HTTP MCP;
- Cloudflare Tunnel / operator-owned endpoint;
- relay drain timer;
- separate watch and phone ingest credentials.

Public examples use `*.example.com`; private deployment hostnames and secrets are not part of the repository contract.

## What this evidence does not prove

These results do not prove compatibility with:

- another vivo/iQOO phone model;
- another WATCH GT firmware;
- another BlueOS device family;
- a future OriginOS/Android permission implementation;
- Health Kit developer registration;
- private-provider access on a phone that has not been tested;
- private-provider access after a system update, a device change, or an APK reinstall, each of which may require re-authorization or fresh verification.

A host build, emulator run, successful `/healthz`, or transport callback must never be promoted to a device capability `PASS` without physical-device evidence.

## Public evidence policy

Future updates to this document should preserve enough information to reproduce the capability result while keeping personal health data private. See [../PRIVACY.md](../PRIVACY.md) and [../CONTRIBUTING.md](../CONTRIBUTING.md).
