# Cross-layer contract

The watch, Android bridge, Akari Health service, and MCP use one event vocabulary. Producers do not translate missing data into zero and do not replace a raw device timestamp with receipt time.

## Watch to Android

The production-candidate adapter uses BlueOS `@blueos.bluexlink.connectionManager` on the watch and vivo's `device-rpc.aar` on Android. The watch sends this outer message through `connect.send`:

```json
{
  "type": "akari.health.batch.v1",
  "data": {
    "batch_id": "watch-batch-id",
    "producer": "akari-pulse-watch",
    "sent_at": 1786245212000,
    "events": []
  }
}
```

`data` follows [`watch-batch.schema.json`](watch-batch.schema.json). Android validates the complete envelope and batch and commits accepted events to Room before producing a business acknowledgement:

```json
{
  "code": 0,
  "result": {
    "batch_id": "watch-batch-id",
    "accepted": 8,
    "duplicates": 2,
    "replayed": false
  }
}
```

The watch removes a sent queue segment only when it receives that acknowledgement through `connect.onMessage`, the returned `batch_id` matches, and `accepted + duplicates` equals the number of events in the batch. The success callback of `connect.send` has no result payload and proves only that the send call completed; it is never treated as persistence acknowledgement.

The official channel remains a real-device gate because it requires a vivo developer `appid`, an intelligent-terminal SDK key, the APK package/signing fingerprint pairing, and proof that `WA2456C` supports the channel. Missing credentials or runtime support is `API_MISSING` or `UNSUPPORTED`, never a mock success.

### HTTPS relay (primary since 0.1.3) and HTTP probe/fallback

The watch network-request adapter exercises this same contract against the Cloudflare relay, which buffers batches until the local service drains them:

```text
POST https://pulse.example.com/v1/health/batches
Content-Type: application/json
X-Akari-Bridge-Token: <ingest token>
```

The identical request shape also works against the explicitly reachable Android phone listener kept as fallback:

```text
POST http://<phone-address>:23102/v1/health/batches
Content-Type: application/json
X-Akari-Bridge-Token: <bridge token>
```

The Android receiver is a user-started foreground diagnostic service, not evidence that BlueXlink works. It validates the entire request and commits accepted events to its local database before returning success.

Success has the same shape as the backend:

```json
{
  "ok": true,
  "status": "PASS",
  "generated_at": 1786245212500,
  "data": {
    "batch_id": "watch-batch-id",
    "accepted": 8,
    "duplicates": 2,
    "received_at": 1786245212500,
    "replayed": false
  }
}
```

For this adapter, the watch removes a sent queue segment only when:

- the HTTP response is successful;
- `ok` is `true`;
- the returned `batch_id` matches; and
- `accepted + duplicates` equals the number of events in that batch.

Any parse, network, authentication, acknowledgement, or count mismatch keeps the events queued and records a `diagnostic_watch_transport` failure with the raw error. A simulator LAN address or OrbitV loopback experiment is not treated as proof that this route reaches a real watch.

## Android to service

The bridge uploads the same stable event IDs and original event JSON to:

```text
POST <AKARI_HEALTH_URL>/v1/health/batches
Authorization: Bearer <AKARI_HEALTH_TOKEN>
Content-Type: application/json
```

The Android queue marks an event uploaded only after a matching successful acknowledgement. WorkManager retry/backoff never fabricates an acknowledgement. A `409 BATCH_ID_CONFLICT` or `409 EVENT_ID_CONFLICT` is a visible terminal diagnostic requiring investigation, not an automatic drop.

## Phone daily summary to service

The vivo phone provider returns one cumulative summary for a source calendar day, not an event stream. Android therefore persists and uploads it under the separate contracts [`phone-daily-summary.schema.json`](phone-daily-summary.schema.json) and [`phone-daily-summary-batch.schema.json`](phone-daily-summary-batch.schema.json):

```json
{
  "batch_id": "phone-daily-<stable UUID>",
  "producer": "akari-pulse-android",
  "sent_at": 1786674600000,
  "summaries": [
    {
      "source": "vivo_phone",
      "metric": "phone_step_count",
      "source_day": "2026-08-14",
      "source_timezone": "Asia/Shanghai",
      "value": 3200,
      "unit": "count",
      "sampled_at": "2026-08-14T10:00:00+08:00",
      "source_timestamp_available": false,
      "status": "PASS",
      "outcome": "PROVIDER_CALL_SUCCEEDED",
      "verification": "VERIFIED"
    }
  ]
}
```

`source_day` is the immutable partition key. `sampled_at` is only the time Akari observed the provider result; it is never treated as the last-step time or re-bucketed through a caller timezone. `phone_step_count`, `phone_distance`, and `phone_calories` remain distinct from watch metrics.

Android uses `source + metric + source_day` as the Room key. A later observation for the same key replaces the current summary: `5 → 100 → 3200` ends at `3200`, never `3305`. A successful zero remains `PASS` with value `0`; `NO_DATA` and `ERROR` omit `value`. Every read also creates an immutable outbox batch so retries use the same `batch_id` and byte-stable JSON.

Production upload is:

```text
POST https://pulse.example.com/v1/health/daily-summaries
X-Akari-Bridge-Token: <PHONE_INGEST_TOKEN>
```

The relay stores the batch before acknowledging it and the single VPS drain forwards it unchanged to the same backend path. A daily-summary acknowledgement satisfies `accepted + duplicates + stale == summaries.length`; `stale` means a delayed older observation was durably accepted as a batch but did not replace a newer backend row.

## Phone sleep summary to service

A night is a bounded interval with stages, not a natural-day cumulative counter, so the vivo private sleep provider gets its own contracts — [`sleep-summary.schema.json`](sleep-summary.schema.json) and [`sleep-summary-batch.schema.json`](sleep-summary-batch.schema.json) — rather than being forced into `phone_daily_summary`:

```json
{
  "batch_id": "phone-sleep-<stable UUID>",
  "producer": "akari-pulse-android",
  "sent_at": 1772000000000,
  "summaries": [
    {
      "source": "vivo_phone",
      "source_day": "2026-03-05",
      "source_timezone": "Asia/Shanghai",
      "sleep_start": 1772000000000,
      "sleep_end": 1772027000000,
      "sampled_at": "2026-03-05T08:15:00.000+08:00",
      "status": "PASS",
      "outcome": "PROVIDER_CALL_SUCCEEDED",
      "verification": "VERIFIED",
      "total_duration_ms": 25200000,
      "stages": {
        "light": [{ "start": 1772000000000, "end": 1772003600000 }],
        "deep": [],
        "rem": [],
        "awake": []
      }
    }
  ]
}
```

Every number above is invented and the stage lists are truncated. This example shows the
shape only; it is not anyone's sleep record.

`source_day` is the immutable partition key: it is the local calendar day the wake-up time falls in, taken from the provider's own columns and never re-bucketed from `sampled_at` or a caller timezone. `sampled_at` is only the time Akari observed the provider.

Only `PASS` / `PROVIDER_CALL_SUCCEEDED` produces a sleep summary. A night the provider did not report is absent, not a zero-duration row.

The cursor is read **by column name, never by ordinal position**, and only columns with confirmed semantics are mapped. A stage the provider did not report stays absent rather than becoming an empty list, so "no REM recorded" and "REM list is empty" remain distinguishable. Duration fields and the stage interval lists are carried through unchanged; Akari does not recompute them, and does not infer a stage it was not given.

Three provider identities hold on the verified ROM and are preserved rather than enforced: `light + deep + rem == total_duration_ms`, `sleep_end - sleep_start == chart_total_duration_ms`, and `chart_total_duration_ms - awake == night_sleep_duration_ms`. Wake-up counts include only awake intervals lying strictly inside `[sleep_start, sleep_end]`.

Android keys the current row on `source + source_day` and inserts an immutable outbox batch in the same transaction. Production upload is:

```text
POST https://pulse.example.com/v1/health/sleep-summaries
X-Akari-Bridge-Token: <PHONE_INGEST_TOKEN>
```

Acknowledgement satisfies `accepted + duplicates + stale == summaries.length`, matching the daily-summary rule. Repeated reads of the same night are separate immutable batches that each update the one current row for that `source_day`.

## Phone latest vitals to service

The vivo private care provider exposes `MYSELF_DATA` as the newest single observation for heart rate, SpO2, and stress. Each carries **its own provider measurement timestamp**, which is distinct from Akari's read time, plus an abnormality flag and the source vivo recorded.

These travel as ordinary timestamped health events under `phone_heart_rate`, `phone_spo2`, and `phone_stress` — not as daily summaries, because a latest point is not a daily aggregate. The contract exposes no phone-side daily minimum, maximum, average, or resting value derived from them.

`quality` records that the observation is a latest snapshot, `source_api` records the provider and payload key, and `source_module` carries vivo's own reported origin. Event IDs derive from the provider timestamp on `PASS` and from the read time otherwise, so a `NO_DATA` or `ERROR` state can never collide with a real observation.

The capability itself is uploaded as `diagnostic_vivo_private_health` with one of `GRANTED`, `NOT_GRANTED`, `UNSUPPORTED`, or `ERROR`. The capability event is always sent; the three vital events are sent only when the capability is `GRANTED`. Losing the permission produces an explicit negative state and never a cached or substituted value.

## Status vocabulary

| Status | Meaning |
|---|---|
| `PASS` | the producer obtained a real value; `value` is required |
| `NO_DATA` | the API call succeeded but returned no observation |
| `DENIED` | a permission or policy denied access |
| `UNSUPPORTED` | the device/runtime reports the capability unsupported |
| `API_MISSING` | the expected module or function is absent |
| `ERROR` | another explicit failure; retain raw code/message |

The event-level `status` vocabulary is closed. Layer summaries in `/v1/status`
may additionally report `NOT_APPLICABLE` for bridge-only layers when zero
records exist for them (see the query rule below).

Diagnostics use metrics named `diagnostic_<layer>`, including `diagnostic_watch_module_api`, `diagnostic_permission`, `diagnostic_sample_acquisition`, `diagnostic_watch_transport`, `diagnostic_phone_receive`, `diagnostic_phone_persistence`, `diagnostic_uplink`, and `diagnostic_vivo_private_health`.

## Query validity rule: bpm-family value 0

Contract decision (0.1.5, documented not silent): under a PASS filter, the
Akari Health service excludes records whose metric is in
`{heart_rate, heart_rate_resting, heart_rate_today_max, heart_rate_today_min}`
AND whose numeric value is `0`. Rationale: 0 bpm is physiologically impossible
and is a sentinel/aggregate artifact — a recent-sample zero shape
(`value: 0, timeStamp: 0`) or a `getTodayStatistic` MIN aggregate that includes
non-wear/empty windows on WA2456C.

The rule is applied at the query layer only. Under `status=ALL` (and in the
raw diagnostics, and in `/v1/status.database.counts_by_status`) these records
remain fully visible. The append-only store is untouched — no record is
mutated, replaced, or deleted. Legacy zero records from `0.1.2/0.1.3` still
exist in the store; they just no longer surface through the routes the MCP
consumes.

The watch side (0.1.5) also refuses to accept these zeros as observations at
parse time: recent-sample zero shape maps to `NO_DATA` with `raw_error_code:
ZERO_SHAPE` (0.1.4 rule, retained), and `getTodayStatistic` MAX/MIN for
HEART_RATE with `value === 0` maps to `NO_DATA` with `raw_error_code:
ZERO_SENTINEL`, preserving the raw payload in `raw_error_message` as evidence.

## Layer summary: `NOT_APPLICABLE`

The `diagnostic_phone_receive`, `diagnostic_phone_persistence`, and
`diagnostic_uplink` event metrics describe the Android watch-receiver fallback.
On the active watch-direct relay route they are structurally never populated.
`/v1/status.data.layers.<layer>` reports `NOT_APPLICABLE` (with an
explanatory `note`) when zero records exist for such a layer, instead of the
misleading `NO_DATA`. If a real record ever arrives (the bridge is re-enabled
as a fallback receiver), the real status takes over from the next request.
The independent phone daily-summary path exposes its per-metric state and
`last_daily_summary_ingest`; it does not fabricate watch-receiver diagnostics.

## Timestamps

- `timestamp`: producer callback/event time in Unix epoch milliseconds.
- `sample_timestamp`: device-health API sample time when distinct.
- `received_at`: assigned independently by each receiving layer; producers never send it as authoritative.
- `callback_delta_ms`: elapsed time since the prior callback in the same live subscription.

Clock skew remains visible. No layer silently rewrites a producer timestamp to make it look current.
