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

Diagnostics use metrics named `diagnostic_<layer>`, including `diagnostic_watch_module_api`, `diagnostic_permission`, `diagnostic_sample_acquisition`, `diagnostic_watch_transport`, `diagnostic_phone_receive`, `diagnostic_phone_persistence`, and `diagnostic_uplink`.

## Timestamps

- `timestamp`: producer callback/event time in Unix epoch milliseconds.
- `sample_timestamp`: device-health API sample time when distinct.
- `received_at`: assigned independently by each receiving layer; producers never send it as authoritative.
- `callback_delta_ms`: elapsed time since the prior callback in the same live subscription.

Clock skew remains visible. No layer silently rewrites a producer timestamp to make it look current.
