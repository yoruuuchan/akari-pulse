# Akari Pulse product specification

## Value proposition

Akari Pulse gives an operator a private, inspectable path from owned vivo devices to conversational health queries. The verified baseline includes a `WA2456C` watch and a vivo Android phone, but the product contract is source- and capability-driven rather than tied to one person's devices.

The focused actions are:

1. collect and reliably synchronize supported watch health observations without inventing values;
2. answer bounded health queries such as latest heart rate, today's steps, sleep, SpO2, stress, activity, and session summaries;
3. start and stop explicitly named heart-rate sessions and correlate timestamped chat events without claiming causality.

## Why an LLM interface

Natural questions such as “what was my heart rate around that message?” or “summarize last night's sleep” are faster to express conversationally than through a fixed report. The LLM contributes intent parsing, time-range selection, comparison, and cautious explanation. It does not possess the owner's private watch records, reliable device status, or permission to mutate raw health data; the Akari Health MCP supplies those facts and exposes only narrow session-metadata actions.

The MCP is tool-only. It does not duplicate the Android diagnostics UI or create a dashboard inside ChatGPT. Tool results are compact structured data with human-readable text, explicit freshness, source, and diagnostic status.

## User journeys

### Routine query

The assistant checks `health_status`, calls a metric-specific read tool, and returns the values with timestamps, units, source device, quality, and freshness. Empty or failed layers remain `NO_DATA`, `DENIED`, `UNSUPPORTED`, `API_MISSING`, or `ERROR`; they are never represented as zero.

### Live heart-rate session

The assistant calls `health_start_session` with an optional label, the watch/bridge records heart-rate samples carrying that `session_id`, and the assistant later calls `health_stop_session` and `health_session_summary`. Session actions write session metadata only and never modify raw samples.

### Message correlation

A client posts a timestamped generic event. A later session summary reports baseline, peak, delta, latency-to-rise, and time-to-peak when the sample coverage permits those calculations. Results are temporal associations, not causal claims.

## Product context

- **Watch:** vivo WATCH GT first-generation Bluetooth model `WA2456C`, BlueOS 3.0, software `DPD2346C_A_1.54.5`, hardware `MP_0.1`.
- **Phone:** private sideloaded Android companion; compatibility is verified per model/firmware and is never inferred from the vivo brand alone.
- **Service:** local Node.js service with SQLite persistence, bindable to a Windows/Tailscale interface.
- **MCP:** independent local stdio / Streamable HTTP server using the MCP TypeScript SDK; it calls the HTTP service rather than opening the database directly.
- **Authentication:** an optional bearer token is mandatory whenever the service is bound beyond loopback. Secrets are supplied through environment variables and are not committed.
- **Transport:** the watch-to-phone adapter follows the strongest currently available BlueOS path. The event envelope and acknowledgement semantics do not depend on whether the adapter is official RPC/BlueXlink or the proven BlueOS network-request path.
- **Raw-data policy:** raw health records are append-only from the service/MCP perspective. Duplicate event IDs are acknowledged idempotently. Failed uplinks remain queued on the originating device.
- **Privacy:** no account tokens, serial numbers, MAC addresses, or authentication cookies enter diagnostics.

## Shared event contract

Every health observation has a stable `event_id`, `timestamp`, `metric`, `unit`, `source_device`, `status`, and `quality`. `value` may be numeric, textual, boolean, or structured JSON because sleep stages and diagnostic observations are not scalar. Optional fields preserve `session_id`, `sample_timestamp`, `callback_delta_ms`, the originating module/API, and raw error code/message.

The service stores both the normalized fields needed for queries and the original JSON payload needed for diagnostics. It assigns `received_at`; producers do not claim server receipt time.

## MCP flows and tool API

All flows are conversational and return compact text plus structured JSON. None needs an embedded MCP view.

### Check pipeline health

1. Call `health_status`.
2. Inspect service reachability, database state, last ingest, metric freshness, and per-layer diagnostics.

### Read health data

1. Call the narrowest applicable tool.
2. Return timestamped observations and an explicit empty/status result when coverage is absent.

Tools:

- `health_latest`: latest successful observation for one metric, or latest observations for all known metrics.
- `health_today`: bounded summaries for a local calendar day and explicit UTC offset.
- `health_heart_rate`: latest heart-rate observation, optionally nearest a timestamp.
- `health_heart_rate_range`: bounded raw heart-rate observations in a time range.
- `health_steps`: latest or daily step total.
- `health_sleep`: sleep status, units, and stages for a time range.
- `health_activity`: distance, calories, intensity, energy, standing, speed, and walking observations.
- `health_spo2`: bounded blood-oxygen observations.
- `health_stress`: bounded stress observations.

### Manage an experiment session

1. Call `health_start_session` with a source device and optional label.
2. Record health observations and correlation events against the returned ID.
3. Call `health_stop_session`.
4. Call `health_session_summary` to calculate descriptive timing statistics.

Tools:

- `health_sessions`: list bounded session metadata.
- `health_start_session`: create one open session; writes session metadata only.
- `health_stop_session`: close one open session; writes session metadata only.
- `health_session_summary`: return coverage, sample statistics, and temporal event correlations. Any baseline/rise calculations disclose their configured windows and never claim causality.

Every tool returns a stable envelope containing `ok`, `status`, `generated_at`, `data`, and, when relevant, `freshness` or `diagnostics`. Transport or service errors are tool errors; valid empty queries return `ok: true` with `status: "NO_DATA"`.

## Acceptance boundaries

- A built `.rpk` proves only buildability; BlueOS health support remains unverified until exercised on the named watch baseline.
- A built `.apk` proves only installability; provider access, watch reception, background behavior, and OEM battery-policy behavior remain unverified until exercised on the target phone.
- Service and MCP acceptance require real process startup, SQLite writes, HTTP query responses, MCP tool listing, and MCP tool invocation.
- Tests never insert implicit demo data into the production database. Test fixtures use isolated temporary databases and are explicitly labeled fixtures.
