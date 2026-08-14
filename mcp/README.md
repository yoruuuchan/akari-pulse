# Akari Health MCP

This is an independent, tool-only MCP server. It does not modify the existing Akari Surface Desktop MCP and does not open the SQLite file directly; all reads and session-metadata writes go through the Akari Health HTTP service.

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
| `health_sleep` | sleep status/unit/stage observations, including explicit unsupported/denied/missing diagnostics |
| `health_activity` | distance, calories, intensity, energy, standing, walking and speed |
| `health_spo2` | latest or bounded SpO2 observations, preserving non-`PASS` diagnostic status |
| `health_stress` | latest or bounded stress observations, preserving non-`PASS` diagnostic status |
| `health_sessions` | read session metadata |
| `health_start_session` | create session metadata only |
| `health_stop_session` | close session metadata only |
| `health_session_summary` | descriptive HR coverage and temporal event associations |

Every read tool is annotated `readOnlyHint: true`. Start/stop are non-destructive metadata writes. There is no MCP tool that updates or deletes a raw health record.

## Verification

```powershell
npm --workspace @akari-pulse/mcp test
```

The test launches the MCP entry as a real child process through the official SDK client, negotiates the current protocol, lists all 14 tools, calls status/latest/today/steps/start/stop/summary, verifies the cumulative-since-boot label, and proves phone/watch coexist in structured output.

`health_today` preserves the server's existing `data.metrics` shape for watch clients and adds `data.daily_summaries` and `data.steps`. `source_day`, not `sampled_at` or the tool's `timezone_offset_minutes`, selects phone records. `health_steps` reports `steps.watch.step_count`, `steps.watch.step_count_sensor`, and `steps.phone` together. A phone `PASS`, `NO_DATA`, or `ERROR` never overwrites a watch result, and the reverse is also true. Calls without an explicit date retain the legacy `data.records` field containing latest watch step records.
