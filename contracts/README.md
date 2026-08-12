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
POST https://pulse.yoru-and-akari.dev/v1/health/batches
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

Diagnostics use metrics named `diagnostic_<layer>`, including `diagnostic_watch_module_api`, `diagnostic_permission`, `diagnostic_sample_acquisition`, `diagnostic_watch_transport`, `diagnostic_phone_receive`, `diagnostic_phone_persistence`, and `diagnostic_uplink`.

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

The `phone_receive`, `phone_persistence`, and `uplink` layers only ever
produce diagnostic records when the Android bridge is on the active path.
On the current relay-only route they are structurally never populated.
`/v1/status.data.layers.<layer>` reports `NOT_APPLICABLE` (with an
explanatory `note`) when zero records exist for such a layer, instead of the
misleading `NO_DATA`. If a real record ever arrives (the bridge is re-enabled
as a fallback receiver), the real status takes over from the next request.

## Timestamps

- `timestamp`: producer callback/event time in Unix epoch milliseconds.
- `sample_timestamp`: device-health API sample time when distinct.
- `received_at`: assigned independently by each receiving layer; producers never send it as authoritative.
- `callback_delta_ms`: elapsed time since the prior callback in the same live subscription.

Clock skew remains visible. No layer silently rewrites a producer timestamp to make it look current.
