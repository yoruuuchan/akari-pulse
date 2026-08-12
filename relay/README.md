# Akari Pulse relay (Cloudflare Worker)

The relay is the public HTTPS ingest point for the watch after BlueXlink was ruled out on
`WA2456C` (see [../docs/RESEARCH.md](../docs/RESEARCH.md)). It accepts the unchanged
watch-batch contract, buffers each batch in D1, and hands it to the local Akari Health
service only through an authenticated drain client. It never rewrites, merges, or
acknowledges data it has not durably stored.

```text
watch @blueos.network.fetch
  -> POST https://pulse.yoru-and-akari.dev/v1/health/batches   (X-Akari-Bridge-Token)
  -> D1 relay_batches row (INSERT before ACK)
  -> scripts/drain-relay.mjs pulls /v1/relay/pending            (Bearer ADMIN_TOKEN)
  -> POST http://127.0.0.1:8787/v1/health/batches               (existing local contract)
  -> POST /v1/relay/drained deletes only locally-acknowledged rows
```

## Routes

| Route | Auth | Behavior |
|---|---|---|
| `GET /healthz` | none | liveness JSON; used by the watch `net probe` |
| `POST /v1/health/batches` | `X-Akari-Bridge-Token` | strict watch-batch validation; insert-then-ACK; idempotent replay by `batch_id`+payload hash; differing reuse returns `409 BATCH_ID_CONFLICT` |
| `GET /v1/relay/pending?limit=N` | `Bearer ADMIN_TOKEN` | oldest-first stored batches with `row_id` |
| `POST /v1/relay/drained {row_ids}` | `Bearer ADMIN_TOKEN` | deletes confirmed rows |
| `GET /v1/relay/status` | `Bearer ADMIN_TOKEN` | pending count and age range |

The ingest acknowledgement is exactly the shape the watch HTTP adapter verifies before it
dequeues: 2xx, `ok === true`, matching `data.batch_id`, and non-negative integer
`accepted`/`duplicates` summing to the submitted event count. The relay itself always
reports `accepted = events.length, duplicates = 0`; real event-level dedup happens in the
local service, which is the durable store of record.

## Deploy

```powershell
Set-Location .\relay
$env:CLOUDFLARE_API_TOKEN = '<token>'
$env:CLOUDFLARE_ACCOUNT_ID = 'YOUR_ACCOUNT_ID'
npx wrangler d1 execute akari-pulse-relay --remote --file schema.sql -y
npx wrangler deploy
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

Secrets live in Cloudflare and in the untracked `relay/.secrets.local`; the ingest token is
also compiled into the watch RPK (`watch/src/config.js`). Rotating either token means
`wrangler secret put` plus, for the ingest token, a watch rebuild.

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

The drain client deletes a relay row only after the target service acknowledged that exact
`batch_id` with a full `accepted + duplicates` count. Replayed ingests (`replayed:
true`) are normal after an interrupted earlier drain.

## Privacy boundary

The relay buffers real health events on Cloudflare (APAC D1) until the next drain. Rows are
deleted on drain confirmation; nothing else reads them. Do not add query routes to the
relay — reads belong to the local service and MCP.
