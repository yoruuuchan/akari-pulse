# Akari Pulse architecture

## System boundary

```text
vivo WATCH GT (WA2456C)                 vivo phone providers
  health + sensor APIs                    StepProvider  -> daily summaries
  durable unsent queue                    private sleep -> sleep summary
                                          private care  -> latest vitals
                                        Android Room v3 current rows
                                          + immutable outboxes
        |                                       |
        | @blueos.network.fetch                 | Android HTTPS uplink
        | X-Akari-Bridge-Token                  | separate phone X-Akari-Bridge-Token
        +-------------------+   +---------------+
                            |   |
                            v   v
akari-pulse-relay (Cloudflare Worker + D1 buffer)
  strict watch-event / phone-summary / sleep-summary validation, insert-then-ACK
  https://pulse.example.com
        |
        | akari-drain.timer on the Tokyo VPS, every 2 min
        | (Bearer ADMIN_TOKEN pull, delete only after acknowledgement)
        v
Akari Health service  (Tokyo VPS, 127.0.0.1:28787, systemd)
  append-only health records
  idempotently updated phone daily summaries keyed by source day
  one sleep summary row per phone sleep session (night sleep and naps side by side)
  sessions + correlation events
  SQLite
        |
        | loopback authenticated HTTP
        v
Akari Health MCP
  14 narrow tools
  stdio (local dev)  /  Streamable HTTP 127.0.0.1:28788 (production)
        |
        | Cloudflare Tunnel (remotely-managed connector)
        v
https://pulse-mcp.example.com/mcp/<secret>
  Claude / ChatGPT custom connectors, any compatible MCP client
```

Addresses above are placeholders. The reference deployment puts the store of record on an
always-on VPS so queries still work with the developer's PC off, leaving the desktop
service as a development instance; running everything on one machine is equally valid.
Whichever you choose, exactly one process may drain the relay (single-drainer rule — a
second drainer would steal batches into a different database and split the record). See
[../deploy/tokyo/README.md](../deploy/tokyo/README.md).

The Android bridge's BlueXlink receiver and LAN HTTP listener remain fallback/diagnostic watch layers: BlueXlink is closed as unsupported/credential-blocked on `WA2456C` (see [RESEARCH.md](RESEARCH.md) 2026-08-12), and the LAN listener matters only if the watch relay route fails the `net probe` gate. The same APK is now an active, independent producer for the vivo phone's today-activity daily summaries; that path does not pass through BlueXlink or the LAN listener.

The watch and Android components are private sideloaded applications. The health service is local-first and binds to loopback by default. It may bind to one exact Tailscale address only when a bearer token is configured. The MCP is an independent process.

## Watch collection

The watch declares the official health and step-counter features and permissions and invokes the official APIs directly. Each callback becomes one immutable event with a stable ID, producer timestamp, source API, status, and optional raw error. A `PASS` event must contain a real value. Failure and empty states have no invented zero.

Heart-rate subscription callbacks preserve both their callback timestamp and the elapsed time since the preceding callback. Recent/history results preserve the device sample timestamp when the API supplies one. The watch queue keeps unsent events across retries and deletes only an acknowledged prefix.

The watch's local start/stop control governs its live heart-rate subscription. MCP-created sessions are also useful when a watch-side session ID is absent: the backend associates heart-rate events with a matching session and source-device time window and exposes `session_assignment: TIME_WINDOW`.

## Watch egress transport

### Primary: HTTPS to the Cloudflare relay

The watch HTTP adapter POSTs the unchanged batch contract to an operator-owned endpoint such as `https://pulse.example.com/v1/health/batches` with `X-Akari-Bridge-Token`. The relay validates the entire batch with the same rules as the local service, stores it in D1 before acknowledging, and answers with the exact acknowledgement shape the watch verifies: 2xx, `ok === true`, matching `batch_id`, and non-negative `accepted`/`duplicates` summing to the submitted event count. Anything else keeps the events queued on the watch.

The relay is a buffer, not a store of record. `scripts/drain-relay.mjs` pulls pending batches with a separate admin token, re-POSTs each unchanged payload to the target path stored with its row (`/v1/health/batches` or `/v1/health/daily-summaries`), and deletes a relay row only after the local service acknowledged that exact batch. Event-level and daily-summary idempotence stay in the local service. Relay routes, semantics, and deploy steps are in [../relay/README.md](../relay/README.md).

This route depends on one real-device fact confirmed on 2026-08-12: a sideloaded quick app's `@blueos.network.fetch` receives internet access through the paired phone. The `0.1.3` `net probe` proved it (relay HTTPS 200, ~4 s TLS), and a controlled `0.1.4` attribution experiment isolated the mechanism: with only the phone paired, fetch succeeded in 3 s; with only the PC Bluetooth link active (no phone), it failed instantly (`code=-6`). The internet path runs through the paired phone's vivo Health Bluetooth proxy.

### Closed: official BlueXlink pair

The BlueXlink pair (`@blueos.bluexlink.connectionManager` on the watch, `device-rpc.aar` on Android) was the original production candidate. On `WA2456C` it fails at connection time with `onError code=1001 "interconnectfeature error"` after `instance()` returns; the official support table lists only vivo WATCH 3, the official meaning of `1001` ("phone APP not installed") equally matches the missing vivo `appid`/`encryStr` registration, and neither blocker is fixable within this project. The full evidence and classification are in [RESEARCH.md](RESEARCH.md) and [REAL_DEVICE_RESULTS.md](REAL_DEVICE_RESULTS.md). The watch keeps the `transport init` diagnostic and the Android receiver code remains buildable, but no further work targets this channel.

### Fallback: Android LAN HTTP listener

The Android HTTP receiver is a user-started foreground diagnostic service accepting the same batch contract with a separate bridge token, committing before responding. It becomes relevant only if `net probe` proves that the watch has no internet path; a simulator request to a LAN IP or an OrbitV-local path is still not promoted to an end-to-end `PASS`.

## Android durability

Android has three independent boundaries:

1. receiver transaction: validate the outer message and every event, detect stable-ID conflicts, write accepted records and queue state atomically, then acknowledge;
2. uplink transaction: send a stable batch to Akari Health, verify the matching response and total count, then mark only those records uploaded.
3. phone-summary transaction: replace the three current `source + metric + source_day` rows and insert one immutable outbox batch atomically; a later read never mutates an in-flight payload.

WorkManager retries transient uplink failure with backoff. A batch/event ID conflict is terminal and remains visible for investigation. Bridge settings keep service and bridge tokens in Android Keystore-backed encrypted storage; source files and diagnostics do not print them.

## Phone-local today activity boundary

The Android bridge now has a separate `VivoTodayActivityReader` for the vivo phone's current-day activity summary. It reads `com.vivo.assistant.step.provider` through `ContentProvider.call("updateTodaySportAIDLBean")` with the hard invariant `ignore=true`. Akari does not enter the provider's explicit sync/setter branch, although a stale vivo cache may cause the vendor service to perform its own day-rollover maintenance. It does not replace, stop, or modify the watch → relay → backend route.

The runtime state and debug JSON retain four distinct outcomes: provider success, provider `NO_DATA`, provider call failure, and result parse failure. A real zero from a successful provider Bundle remains `PASS`; Settings `vivo_settings_realtime_steps` is diagnostics only and never acts as fallback. The provider exposes the final calendar-day cumulative `step`, not a delta, and does not expose the source timestamp. The reader therefore reports the phone's actual timezone and local day plus an explicitly observation-only `sample_epoch_ms`.

Room v2 persists the three results as `phone_step_count`, `phone_distance`, and `phone_calories`, separate from every watch event metric. `source_day` and IANA `source_timezone` are immutable source semantics; `sampled_at` is only the bridge observation time and `source_timestamp_available` remains false. A later read for the same day replaces the current summary, including explicit `NO_DATA` or `ERROR`; no earlier value is used as fallback.

Each read also creates a stable outbox batch. Production uses a phone-specific relay credential and `POST /v1/health/daily-summaries`; the existing D1 relay records the target path and the single Tokyo drain forwards the unchanged batch. This adds no phone logic to the watch event endpoint and does not alter watch transport.

The service schema v2 keeps `daily_summaries` mutable only at the composite key `source + metric + source_day` and keeps every inbound daily-summary batch immutable for idempotence. A newer `sampled_at` updates the current row, an exact same observation is a duplicate, an older delayed batch is `stale`, and same-time different content is a conflict. These rules order observations but never derive the day from `sampled_at`.

`/v1/health/today` preserves the legacy watch `metrics` object and adds phone `daily_summaries` plus a source-parallel `steps` object. Phone/watch values are never merged and neither is assigned precedence. Distance/calorie verification state remains attached to the phone records rather than making them interchangeable with watch metrics.

## Vivo private health providers

A second phone-local boundary reads two private vivo providers under `source=vivo_phone`, alongside — never instead of — the today-activity path:

| Provider | Shape | Akari contract |
|---|---|---|
| `content://com.vivo.health.provider/sleep` | only the latest sleep record (a nap read replaces the night sleep in the cursor), 38 columns on the verified ROM | its own sleep-summary contract, one row per session so sessions accumulate downstream |
| `content://com.vivo.health.provider.care/healthCare` | `MYSELF_DATA` HealthDetailBean JSON | three timestamped observations in the existing health-event outbox |

Both providers sit behind `com.vivo.health.widget.permission`, which is declared `signature|privileged`. A third-party build never receives it at install time; it is granted once by the device owner over ADB through `scripts/bootstrap-vivo-private-health.ps1`. This is deliberately an owner bootstrap and not a distributable capability — vivo's Health Kit remains the ADB-free third-party route.

### Capability, not fallback

`vivo_private_health_provider` has four states: `GRANTED`, `NOT_GRANTED`, `UNSUPPORTED`, and `ERROR`. The reader distinguishes them structurally: `packageManager.resolveContentProvider` separates a device that has no such authority (`UNSUPPORTED`) from one that has it but refuses this caller (`NOT_GRANTED`). Reinstalling the APK clears the grant, so the app must be able to report `NOT_GRANTED` at any time — and does, with every value null. There is no cached, stale, UI-scraped, or Settings-derived substitute anywhere on this path.

The capability outcome is itself uploaded as a diagnostic observation, so `/v1/status` reports this layer independently of the watch layers and of the today-activity path.

### Sleep semantics

The sleep cursor is read **by column name only**, never by ordinal position, so a firmware that reorders or extends the cursor cannot shift a value into the wrong field. Only columns with confirmed semantics are mapped; the rest are ignored rather than guessed, and a stage the provider did not report stays absent rather than becoming zero.

Day attribution, timezone, and event timestamps are taken from the provider's own columns. Akari never re-buckets a sleep day from its own observation time. Three identities hold on the verified ROM and are preserved end to end: light + deep + REM equals total sleep; wake minus onset equals the chart total; the chart total minus awake equals night sleep.

Wake-up counts include only awake intervals lying strictly inside the onset/wake window, which is what reproduces the vivo UI's own count and duration.

Sleep gets its own contract rather than being forced into `phone_daily_summary`, because a night is a bounded interval with stages, not a natural-day cumulative counter. Room v3 keys the current row on `(source, source_day)` and backs it with immutable upload batches; the service applies the same newer-observation-wins, duplicate, stale, and conflict rules used for daily summaries.

### Latest-vitals semantics

`MYSELF_DATA` yields the newest single heart-rate, SpO2, and stress observation, each with its own provider measurement timestamp and abnormality flag. These are modelled as timestamped observations in the existing health-event outbox — `phone_heart_rate`, `phone_spo2`, `phone_stress` — rather than as a natural-day summary, because a latest point is not a daily aggregate.

The contract therefore exposes no phone-side daily minimum, maximum, average, or resting value derived from them, and MCP output states that limit explicitly. Event IDs are derived from the provider timestamp on `PASS` and from the read time otherwise, so a non-`PASS` state can never collide with a real observation.

Room v3 is reached through an explicit `MIGRATION_2_3`; the database registers no destructive fallback.

## Service durability and queries

The Node.js service uses `node:sqlite` in WAL mode for file-backed databases. `health_records` and `sync_batches` are append-only through the HTTP API. Batch and event IDs are idempotent only for identical payloads; reusing an ID for different content returns `409` without choosing either interpretation.

The service also owns mutable session metadata and immutable correlation events. Session summaries calculate descriptive baseline, peak, delta, latency-to-rise, and time-to-peak only when real samples cover the relevant windows. Every summary states that temporal association does not establish causality.

## MCP boundary

The stdio MCP calls the authenticated service rather than opening SQLite. It exposes read-only health tools plus two non-destructive session-metadata writes. Raw samples cannot be updated or deleted through MCP. Standard output is reserved for JSON-RPC; process diagnostics use standard error.

`health_steps` returns watch `step_count`, watch `step_count_sensor`, and phone `phone_step_count` side by side. It does not merge sources or state a phone/watch preference; the sensor record remains explicitly labeled as cumulative-since-boot rather than a calendar-day total. Sleep, SpO2, and stress tools include non-`PASS` diagnostic records so `DENIED`, `UNSUPPORTED`, and `API_MISSING` are not hidden as empty data.

`health_sleep` answers last night from the phone's stored sleep sessions — the night sleep and any naps side by side, each with onset, wake, total, deep, light, REM, wake-ups, score, deep-sleep continuity — beside the watch's sleep observations, and says so explicitly when no phone sleep day is stored rather than reaching for an adjacent day. `health_heart_rate`, `health_spo2`, and `health_stress` return the watch metric and its `phone_` counterpart together, each labelled with its own source device and source time. When a tool returns the phone vital next to a windowed watch query, it also returns the machine-readable note that the phone value is a single latest snapshot rather than a windowed sample or a daily aggregate.

No tool merges the two sources or assigns precedence between them.

## Status and diagnostic model

All producers use one status vocabulary:

| Status | Meaning |
|---|---|
| `PASS` | a real operation/value succeeded; value-bearing observations contain `value` |
| `NO_DATA` | the operation succeeded but returned no observation |
| `DENIED` | permission or policy denied access |
| `UNSUPPORTED` | the runtime/device explicitly lacks the capability |
| `API_MISSING` | the expected module, function, configuration, or credential is absent |
| `ERROR` | another explicit failure; raw code/message are retained |

Layer diagnostics are independent: `watch_module_api`, `permission`, `sample_acquisition`, `watch_transport`, `phone_receive`, `phone_persistence`, `uplink`, `vivo_private_health`, `backend_ingest`, `database`, and `mcp_query`. A later healthy layer never overwrites an earlier failure.

The event-level status vocabulary above is closed. Layer summaries in
`/v1/status` may additionally report `NOT_APPLICABLE` for
`phone_receive`/`phone_persistence`/`uplink` when zero records exist for
them: these diagnostic event metrics describe the Android watch-receiver
fallback, and the current watch route is watch → relay → drain → service.
The status distinguishes structural absence ("bridge is not in the path")
from `NO_DATA` ("a producer for this layer ran and reported nothing"). If a
real record ever arrives from a re-enabled bridge, the real status takes
over from the next request.

Phone daily summaries do not fabricate those watch-receiver diagnostics.
Their per-metric status/outcome and `last_daily_summary_ingest` report the
independent phone pipeline instead.

### Query validity rule: bpm-family value 0

Under a PASS filter, the service excludes records whose metric is in
`{heart_rate, heart_rate_resting, heart_rate_today_max, heart_rate_today_min}`
AND whose numeric value is `0`. 0 bpm is physiologically impossible; it is a
device sentinel/aggregate artifact (recent-sample zero shape, or
`getTodayStatistic` MIN including non-wear windows on WA2456C). The append-
only store is untouched; the raw records remain visible under `status=ALL`.
See `contracts/README.md` for the full contract decision.

## Security and privacy

- Non-loopback service binding is refused without a bearer token.
- The Tailscale script binds the exact current tailnet IPv4 and does not change Tailscale, Serve/Funnel, grants, or Windows Firewall state.
- The HTTP watch probe has a separate bridge token.
- No vivo account token, MAC address, serial number, cookie, developer SDK key, or private signing key is committed or logged.
- The private-provider grant is an explicit, reversible owner action on the owner's own device. The bootstrap script changes permission state for Akari Pulse only; it does not modify vivo Health, its database, or any system component, and `-Revoke` undoes it.
- `/healthz` is unauthenticated but contains liveness only; all data/status routes honor configured authentication.
- Health records have no update/delete route.

## Acceptance boundary

A valid `.rpk` and `.apk` prove host-side buildability and packaging only. They do not prove health permission, BlueXlink support, background behavior, or successful sideload on `WA2456C / BlueOS 3.0 / DPD2346C_A_1.54.5` and the vivo X200 Pro. Those results remain in `REAL_DEVICE_RESULTS.md` until observed on the named devices.
