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

- vivo Android phone used as the verified phone baseline
- Android bridge installed in place across schema migration tests
- vivo Health / assistant provider behavior verified on the physical phone

Compatibility on other vivo/iQOO models or firmware remains unverified until tested.

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

Any phone-local sleep integration must be represented as its own source and verified independently.

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

## Android Room and immutable outbox

Room schema v2 was verified on a physical phone with an in-place migration.

The migration preserved existing watch records and added:

- current phone daily-summary rows keyed by `(source, metric, source_day)`;
- immutable phone daily-summary upload batches.

Each real phone read performs one transaction that updates the current rows and creates an immutable outbox payload.

For the same source/day, later cumulative observations replace the current value; they are not added together. Synthetic integration tests cover increasing cumulative values to verify replacement semantics.

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

## MCP verification

A real MCP client, using the project's Streamable HTTP transport, verified that production queries can expose phone and watch sources side by side.

Confirmed behavior:

- `health_status` reports backend/database/MCP layers explicitly;
- `health_today` returns phone daily summaries with their original source day/timezone semantics;
- `health_steps` can return a phone `PASS` next to a watch `NO_DATA` without merging or precedence;
- `health_latest(metric=heart_rate)` continues to return the verified watch source after phone daily-summary support is enabled.

No MCP tool rewrites a phone value as a watch value.

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
- private-provider access on a phone that has not been tested.

A host build, emulator run, successful `/healthz`, or transport callback must never be promoted to a device capability `PASS` without physical-device evidence.

## Public evidence policy

Future updates to this document should preserve enough information to reproduce the capability result while keeping personal health data private. See [../PRIVACY.md](../PRIVACY.md) and [../CONTRIBUTING.md](../CONTRIBUTING.md).
