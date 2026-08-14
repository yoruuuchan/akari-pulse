# Akari Pulse relay (Cloudflare Worker)

The relay is the public HTTPS ingest point for the watch and the Android phone daily-summary uplink. After BlueXlink was ruled out on `WA2456C` (see [../docs/RESEARCH.md](../docs/RESEARCH.md)), both producers use durable D1 buffering and the same authenticated single drain client. The relay records the target backend path with each batch; it never rewrites, merges, or acknowledges data it has not durably stored.

```text
watch @blueos.network.fetch
  -> POST https://pulse.example.com/v1/health/batches   (X-Akari-Bridge-Token)
Android vivo today reader
  -> POST https://pulse.example.com/v1/health/daily-summaries (separate X-Akari-Bridge-Token)
Android vivo private sleep reader
  -> POST https://pulse.example.com/v1/health/sleep-summaries (same phone token)
Android vivo private vitals reader
  -> POST https://pulse.example.com/v1/health/batches          (same phone token)
  -> D1 relay_batches row (INSERT before ACK)
  -> scripts/drain-relay.mjs pulls /v1/relay/pending            (Bearer ADMIN_TOKEN)
  -> POST the row's recorded target_path on the backend
  -> POST /v1/relay/drained deletes only locally-acknowledged rows
```

The phone's latest vitals are ordinary timestamped health events, so they use the existing
event route rather than a fourth one. That route therefore accepts either producer credential:
the watch's `INGEST_TOKEN` or the phone's `PHONE_INGEST_TOKEN`. The summary routes remain
phone-only.

## Routes

| Route | Auth | Behavior |
|---|---|---|
| `GET /healthz` | none | liveness JSON; used by the watch `net probe` |
| `POST /v1/health/batches` | `X-Akari-Bridge-Token` (watch **or** phone token) | strict watch-batch validation; insert-then-ACK; idempotent replay by `batch_id`+payload hash; differing reuse returns `409 BATCH_ID_CONFLICT` |
| `POST /v1/health/daily-summaries` | phone `X-Akari-Bridge-Token` | strict phone daily-summary validation; preserves source day/timezone and buffers the unchanged batch for the backend daily-summary route |
| `POST /v1/health/sleep-summaries` | phone `X-Akari-Bridge-Token` | strict phone sleep-summary validation; preserves the provider's source day, timezone, interval boundaries, and stage lists unchanged |
| `GET /v1/relay/pending?limit=N` | `Bearer ADMIN_TOKEN` | oldest-first stored batches with `row_id` |
| `POST /v1/relay/drained {row_ids}` | `Bearer ADMIN_TOKEN` | deletes confirmed rows |
| `GET /v1/relay/status` | `Bearer ADMIN_TOKEN` | pending count and age range |

The ingest acknowledgement is exactly the shape the watch HTTP adapter verifies before it
dequeues: 2xx, `ok === true`, matching `data.batch_id`, and non-negative integer
`accepted`/`duplicates` summing to the submitted event count. The relay itself always
reports `accepted = events.length, duplicates = 0`; real event-level dedup happens in the
local service, which is the durable store of record.

Daily-summary and sleep-summary ACKs add `stale` and require `accepted + duplicates + stale` to equal the submitted summary count. The relay initially reports all items accepted and `stale = 0`; the backend decides whether an older observation is stale when the VPS drains it.

## Deploy

```powershell
Set-Location .\relay
$env:CLOUDFLARE_API_TOKEN = '<token>'
$env:CLOUDFLARE_ACCOUNT_ID = 'YOUR_ACCOUNT_ID'
# Existing v1 D1: apply the one-time migration below.
npx wrangler d1 execute akari-pulse-relay --remote --file migrations/0002-daily-summary-target.sql -y
# A brand-new D1 uses schema.sql instead of the migration.
# npx wrangler d1 execute akari-pulse-relay --remote --file schema.sql -y
npx wrangler deploy
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put PHONE_INGEST_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

Secrets live in Cloudflare and in untracked operator state. `INGEST_TOKEN` is compiled into the watch RPK (`watch/src/config.js`); `PHONE_INGEST_TOKEN` is stored by the Android app through its Keystore-backed secret field. They are deliberately independent, so adding or rotating phone uplink credentials does not require a watch rebuild.

## Drain

**Since 2026-08-12 the only drain client is the systemd timer on the Tokyo VPS**
(`akari-drain.timer`, every 2 minutes — see [../deploy/tokyo/README.md](../deploy/tokyo/README.md)).
Do not run `scripts/drain-relay.mjs` anywhere else while that timer is active: whichever
client drains first keeps the batch, so a second drainer silently splits the record
across databases.

Manual drain (only if the VPS timer is stopped):

```powershell
$env:AKARI_RELAY_ADMIN_TOKEN = '<ADMIN_TOKEN from relay/.secrets.local>'
$env:AKARI_HEALTH_URL = '<target service URL>'
$env:AKARI_HEALTH_TOKEN = '<that service token>'
node .\scripts\drain-relay.mjs
```

The drain client deletes a relay row only after the target service acknowledged that exact `batch_id` with a full count: `accepted + duplicates` for watch events, or `accepted + duplicates + stale` for daily summaries. Replayed ingests (`replayed: true`) are normal after an interrupted earlier drain.

## Privacy boundary

The relay buffers real health events, phone daily summaries, and phone sleep summaries on Cloudflare (APAC D1) until the next drain. A sleep summary is a full night's stage timeline, so treat this buffer as carrying sensitive data even though it is short-lived. Rows are
deleted on drain confirmation; nothing else reads them. Do not add query routes to the
relay — reads belong to the local service and MCP.
