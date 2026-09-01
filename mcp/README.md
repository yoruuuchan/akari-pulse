# Akari Health MCP

This is an independent, tool-only MCP server. It runs as its own process and does not open the SQLite file directly; all reads and session-metadata writes go through the Akari Health HTTP service, so adding it alongside your other MCP servers changes none of them.

It uses the official MCP TypeScript SDK v2 and negotiates the `2026-07-28` protocol over stdio. Standard output is reserved for MCP JSON-RPC; diagnostics go to standard error.

## Run

Start the HTTP service first, then:

```powershell
$env:AKARI_HEALTH_URL = 'http://127.0.0.1:8787'
$env:AKARI_HEALTH_TOKEN = '<same token as the service>' # omit only when the service has none
.\scripts\start-mcp.ps1
```

Ready-to-edit client configurations:

- [`config/codex.example.toml`](config/codex.example.toml)
- [`config/claude-desktop.example.json`](config/claude-desktop.example.json)

The Codex example forwards `AKARI_HEALTH_TOKEN` from the local environment through `env_vars`, so the token is not embedded in TOML. The Claude example contains an explicit placeholder because client-side environment forwarding differs by installation; replace it locally and do not commit the resulting secret.

## Tools

| Tool | Behavior |
|---|---|
| `health_status` | pipeline, database, last ingest, metric freshness, per-layer diagnostics |
| `health_latest` | latest successful observation for one or all metrics |
| `health_today` | legacy watch metric summaries plus phone summaries selected by their immutable source day |
| `health_heart_rate` | latest HR or nearest real sample around a timestamp |
| `health_heart_rate_range` | bounded raw HR samples |
| `health_steps` | watch official/sensor and phone daily steps side by side, without merging or source precedence |
| `health_sleep` | watch sleep observations plus the phone's sleep sessions — onset, wake, total, deep, light, REM, wake-ups, score, deep-sleep continuity — bounded by `from`/`to` through interval overlap, including explicit unsupported/denied/missing diagnostics |
| `health_activity` | watch distance, calories, intensity, energy, standing, walking and speed beside the phone daily summaries (steps, distance, calories) with their source semantics |
| `health_spo2` | latest or bounded SpO2 observations for watch and phone, preserving non-`PASS` diagnostic status |
| `health_stress` | latest or bounded stress observations for watch and phone, preserving non-`PASS` diagnostic status |
| `health_sessions` | read session metadata |
| `health_start_session` | create session metadata only |
| `health_stop_session` | close session metadata only |
| `health_session_summary` | descriptive HR coverage and temporal event associations |

### Tool annotations

All four MCP hints are declared explicitly on every tool. Leaving one unset is not neutral — a client then falls back on the spec defaults, which read `destructiveHint` and `openWorldHint` as `true`, and neither is true of anything here.

| Tools | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---|---|---|---|
| the twelve read tools | `true` | `false` | `true` | `false` |
| `health_start_session` | `false` | `false` | `false` | `false` |
| `health_stop_session` | `false` | `false` | `true` | `false` |

`openWorldHint` is `false` on all fourteen: every tool talks to exactly one place, the Akari Health HTTP service named by `AKARI_HEALTH_URL`, backed by its own SQLite store. No tool accepts a URL or reaches a third party, so the domain of interaction is a closed, enumerable set of metrics, records and sessions.

Session metadata is the only thing any tool writes; there is no MCP route that updates or deletes a raw health record, which is why both writes are `destructiveHint: false`. They differ in repeat behavior: starting appends another open session every call, while stopping is a one-way `OPEN` → `CLOSED` transition and the backend replays an already-closed session unchanged rather than restamping it.

## Verification

```powershell
npm --workspace @akari-pulse/mcp test
```

The test launches the MCP entry as a real child process through the official SDK client, negotiates the current protocol, lists all 14 tools, calls status/latest/today/steps/start/stop/summary, verifies the cumulative-since-boot label, and proves phone/watch coexist in structured output. It also pins the query semantics: newest-first ordering with `latest`/`latest_by_source`, `DEGRADED` and named stale sources for a source that stopped reporting, sleep windows selected by interval overlap, and — against a fixture stamped at the current moment — `health_activity` returning the live phone daily summaries under `PASS` with the calendar day resolved in the provider's zone.

`health_today` preserves the server's existing `data.metrics` shape for watch clients and adds `data.daily_summaries` and `data.steps`. `source_day`, not `sampled_at` or the tool's `timezone_offset_minutes`, selects phone records. `health_steps` reports `steps.watch.step_count`, `steps.watch.step_count_sensor`, and `steps.phone` together. A phone `PASS`, `NO_DATA`, or `ERROR` never overwrites a watch result, and the reverse is also true. Calls without an explicit date retain the legacy `data.records` field containing latest watch step records.

`health_activity` asks for the phone daily metrics by name alongside the watch ones, because `/v1/health/today` reads daily summaries only for the phone metrics it was given. Its `data.daily_summaries` carries each value with `source`, `source_day`, `source_timezone`, `sampled_at`, `status`, `outcome` and `verification` intact.

`health_sleep` attaches `data.phone_sleep` beside the watch records and accepts an optional `date` (a specific `source_day`) or `sleep_days` (how many recent days to return). An explicit `from`/`to` bounds the phone sessions too: a session is returned only when its real `[sleep_start, sleep_end]` interval overlaps the window, so a midday hour with no nap returns nothing rather than last night. Only a call with neither `from` nor `to` falls back to the most recent sleep days.

`health_heart_rate`, `health_spo2`, and `health_stress` query the watch metric together with its `phone_` counterpart and return both, each labelled with its own source device and source time. The phone value is the vivo provider's newest single observation, so the timestamped `health_heart_rate` mode returns it as `phone_latest_snapshot` with a machine-readable note that it is neither a windowed sample nor a daily aggregate. No tool merges the two sources or assigns precedence between them.

## Ordering, freshness, and the calendar zone

Records come back newest first, one row per metric, and `data.latest` plus `data.latest_by_source` name the newest observation outright. No caller has to infer a source precedence from `records[0]`.

Every read carries `data.freshness`, which keeps three clocks apart:

| Field | Meaning |
|---|---|
| `generated_at` (envelope) | when this MCP response was built |
| `freshness.data_as_of` | when the newest returned value was observed — for a phone summary, the provider read that produced it |
| `freshness.received_at` | when the backend took that observation in |
| `freshness.data_as_of_by_metric` | the same, per metric, when one number would be ambiguous |
| `freshness.by_source[*].age_ms` | how old the returned value from that source is now |
| `freshness.by_source[*].source_latest_at` / `source_age_ms` / `state` | how fresh that source is in itself, whatever window was asked for |
| `freshness.stale_after_ms` | the threshold behind `state` (24 h) |

A source whose newest observation is older than `stale_after_ms` is `STALE`, and `stale_sources` lists every one of them. The data still comes back in full, with real timestamps — the response just refuses to present a five-day-old sample as a current reading. `health_status` reports the same split across all known sources and puts an age on each diagnostic layer, so a `PASS` recorded days ago cannot read as a live one.

## Source lifecycle

Whether staleness is a *fault* depends on what the source is, so each one carries a `lifecycle`:

| Lifecycle | Meaning |
|---|---|
| `ACTIVE` | the continuous production feed — the Android `UplinkWorker` reads the vivo providers and uploads on its own schedule. Silence here is a real fault. |
| `HISTORICAL` | read on demand, never on a schedule. The BlueOS watch quick app has no scheduler and no background service: every `WA2456C` observation came from someone opening the sideloaded app and pressing a collect button, one run per launch. It cannot be late, because nothing asked it to report. |

Only an `ACTIVE` source's staleness degrades the pipeline: `degraded_sources` (`ACTIVE` ∩ `STALE`) drives the status, while `stale_sources` stays literal and `historical_sources` names the rest. A `HISTORICAL` source's records remain fully queryable, keep their real `age_ms` and `state`, and its ingest route stays live — press a collect button on the watch and the data flows again. Unknown sources default to `ACTIVE`, so a new feed that goes quiet is flagged rather than silently excused.

## The calendar zone

Calendar tools (`health_today`, `health_steps`, `health_activity`) resolve the day in the vivo provider's own zone, `Asia/Shanghai` (+480) — the zone its summaries are stamped with and decided their `source_day` in — never the client's local zone, which would shift a Chinese health day across midnight from a machine in JST or behind a VPN.

`timezone_offset_minutes` is therefore **optional with no JSON Schema `default`**. A numeric `default` in the descriptor is auto-filled by LLM clients and generated callers, which would make every call a `caller_override` and defeat the provider zone; the runtime, not the schema, owns the default. Responses echo `timezone`, `timezone_offset_minutes` and `timezone_source` (`provider_default` or `caller_override`). Passing the parameter explicitly still overrides it.

Connector clients cache the tool list. After changing a descriptor, re-sync or re-add the connector in claude.ai / ChatGPT — an old cached schema will otherwise keep showing the previous parameter shape.
