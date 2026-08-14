# Akari Health service

The service is the append-only persistence and query boundary for Akari Pulse. It uses the Node.js standard HTTP server and `node:sqlite`; there is no external database process.

## Run

From the monorepo root:

```powershell
npm install
$env:AKARI_HEALTH_TOKEN = '<strong random token>' # required beyond loopback
.\scripts\start-server.ps1
```

Defaults:

- URL: `http://127.0.0.1:8787`
- database: `server/data/akari-health.sqlite`
- authentication: disabled on loopback unless `AKARI_HEALTH_TOKEN` is set

The process refuses a non-loopback bind without `AKARI_HEALTH_TOKEN`. To bind only to this machine's Tailscale IPv4:

```powershell
$env:AKARI_HEALTH_TOKEN = '<strong random token>'
.\scripts\start-server-tailnet.ps1
```

The tailnet script reads `tailscale ip -4`; it does not run `tailscale up`, change grants, change Windows Firewall, or modify an existing Serve/Funnel configuration.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AKARI_HEALTH_HOST` | `127.0.0.1` | Exact interface to bind |
| `AKARI_HEALTH_PORT` | `8787` | HTTP port |
| `AKARI_HEALTH_DB` | `server/data/akari-health.sqlite` | SQLite file |
| `AKARI_HEALTH_TOKEN` | empty | Bearer token; mandatory beyond loopback |

Use Node.js 24 or newer. On the currently verified Node 24.14 runtime, SQLite works but Node labels `node:sqlite` experimental; current Node 24 documentation labels it release candidate. The warning is left visible rather than hidden.

## Routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/healthz` | unauthenticated process liveness; contains no records |
| `GET` | `/v1/status` | database, ingest, freshness, and layer diagnostics |
| `POST` | `/v1/health/batches` | idempotent batch ingest, 1–500 events |
| `POST` | `/v1/health/daily-summaries` | idempotent phone daily-summary ingest, 1–50 summaries |
| `GET` | `/v1/health/latest` | latest observation per metric |
| `GET` | `/v1/health/range` | bounded raw query |
| `GET` | `/v1/health/today` | local-day summary with explicit UTC offset |
| `POST` | `/v1/events` | append one timestamped correlation event |
| `GET` | `/v1/events` | query correlation events |
| `POST` | `/v1/sessions` | start one source-device session |
| `GET` | `/v1/sessions` | list session metadata |
| `GET` | `/v1/sessions/active` | list open sessions for bridge coordination |
| `POST` | `/v1/sessions/{id}/stop` | idempotently close session metadata |
| `GET` | `/v1/sessions/{id}/summary` | descriptive HR and event timing summary |

Except for `/healthz`, routes require `Authorization: Bearer <token>` whenever a token is configured.

Watch event summaries never sum cumulative observations. `step_count` is reported as the maximum observed official daily statistic. `step_count_sensor` is separately labeled as the maximum cumulative-since-boot value; it is not a calendar-day total and may reset when the watch reboots.

Phone summaries use a separate mutable-current table keyed by `source + metric + source_day`. The backend compares `sampled_at` only to decide which observation is newer; it never uses it to assign a calendar day. `/v1/health/today` keeps the legacy watch `metrics` object and adds `daily_summaries` plus `steps.watch`/`steps.phone`, so both sources remain visible without precedence or automatic merging.

## Ingest semantics

`POST /v1/health/batches` accepts the JSON contract in [`contracts/watch-batch.schema.json`](../contracts/watch-batch.schema.json). `PASS` requires a `value`; an absent measurement must use `NO_DATA` or another explicit diagnostic status. Duplicate payloads are acknowledged. Reusing a batch or event ID for different content returns `409` and stores neither interpretation.

`POST /v1/health/daily-summaries` accepts [`contracts/phone-daily-summary-batch.schema.json`](../contracts/phone-daily-summary-batch.schema.json). A new later observation replaces the current row, an exact same-time replay is a duplicate, an older delayed upload is counted as `stale`, and same-time different content returns `409 DAILY_SUMMARY_VERSION_CONFLICT`. `PASS` requires a non-negative value; `NO_DATA` and `ERROR` forbid one. The acknowledgement invariant is `accepted + duplicates + stale == summaries.length`.

Schema version 2 creates `daily_summaries` and `daily_summary_batches` in one transaction and preserves all v1 watch, batch, session, and correlation tables. There is no destructive migration fallback.

JSON request bodies require the exact `application/json` media type, with optional parameters such as `charset=utf-8`; prefix lookalikes such as `application/jsonx` are rejected with `415`.

Raw observations have no update or delete route. The only mutable records are session metadata. A missing `session_id` on a heart-rate observation is associated with a matching source-device session time window when one exists; the record reports `session_assignment: TIME_WINDOW` so that assignment is inspectable.

## Verification

```powershell
npm --workspace @akari-pulse/server test
.\scripts\verify-service.ps1
```

The test suite uses isolated temporary SQLite files. It verifies authentication, failure-state fidelity, watch append-only idempotency, daily-summary replacement/stale/replay rules, source-day queries across caller offsets, v1→v2 preservation, range/latest queries, sessions, and temporal event correlation. It never writes fixture data to the production database.
