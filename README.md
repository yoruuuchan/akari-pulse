# Akari Pulse

Research notes and a working reference implementation for getting health data off a vivo WATCH GT (first-generation Bluetooth model, `WA2456C`, BlueOS 3.0) into a self-hosted backend and MCP server. The full chain — watch RPK → Cloudflare relay → drain into a local Node.js service → SQLite → MCP over stdio and Streamable HTTP — was verified end-to-end on a real device on 2026-08-12; the exact evidence is in [docs/REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md).

Status: reference / research. Published as-is with no maintenance or support promise. Not affiliated with, endorsed by, or sponsored by vivo. Every endpoint, database ID, and token in the runnable code and configs has been replaced with a placeholder (`REPLACE_WITH_*` or `pulse.example.com`) — bring your own Cloudflare Worker, D1 database, VPS, and tunnel; nothing points at anyone else's infrastructure by default. Narrative documentation still names the domains the author's own deployment used (`pulse.yoru-and-akari.dev`, `pulse-mcp.yoru-and-akari.dev`) because they are part of the verified-deployment story on 2026-08-12.

Privacy note: this project handles real personal health data. Run your own relay, database, and MCP; do not point this at a third party's infrastructure or someone else's watch. RPK binaries are deliberately not shipped because they bake the private ingest token in — see [artifacts/README.md](artifacts/README.md).

The RPK sideloading path relies on the OrbitV community's work; without it the watch could not receive an unsigned developer build at all.

Akari Pulse is a private, inspectable health-data path for Yoru's first-generation Bluetooth vivo WATCH GT:

```text
WA2456C / BlueOS 3.0
  -> BlueOS health + sensor APIs
  -> Akari Pulse Bridge for Android
  -> Akari Health HTTP service + SQLite
  -> independent Akari Health MCP
  -> ChatGPT / Claude
```

The repository contains real watch, Android, service, and MCP implementations. It does not contain demo health values, vivo developer credentials, account tokens, or private signing keys. A host build is not reported as a real-watch success. Confirmed `WA2456C / DPD2346C_A_1.54.5` observations and unresolved reboot boundaries are recorded separately from host evidence in [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md).

## Current delivery status

| Layer | Host result | Real-device result |
|---|---|---|
| BlueOS watch app | `0.1.4` collect-and-sync RPK built with the BlueOS Studio toolchain (superset of `0.1.3`) | `0.1.2` passed the full isolated health chain (3/3 cold-start full-pipeline passes, no reboot); `0.1.3` `net probe` and `send batch https` passed on 2026-08-12; `0.1.4` all three collect+sync buttons verified 2026-08-12 — real nonzero HR, SpO2, stress, resting HR landed in the VPS store end-to-end (see [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md)) |
| Watch health chain | one-test-per-launch harness | `PASS` — `getRecentSamples([HEART_RATE])` → callback → parse → UI → queue → snapshot → storage is stable; do not rework without new failing evidence |
| Official BlueXlink RPC | public watch API and official Android AAR integrated | **closed**: `transport init` fails with `code=1001 interconnectfeature error`; support table lists only WATCH 3; vivo `appid`/`encryStr` unobtainable — see [RESEARCH.md](docs/RESEARCH.md) |
| Cloudflare relay | deployed at `https://pulse.yoru-and-akari.dev`; ingest/replay/conflict/auth smoke-tested | `PASS` 2026-08-12 — the real watch reached the relay over HTTPS (~4 s TLS) and its batch was stored and acknowledged 3 s after `sent_at` |
| Akari Health service | authenticated routes tested against temporary databases | `PASS` 2026-08-12 — the drained physical-watch batch (2 events) is in the local SQLite store of record |
| Akari Health MCP | official SDK client lists and invokes all 14 tools | `PASS` 2026-08-12 — `health_latest` returned the physical-watch record through the real stdio MCP |
| Always-on VPS + remote MCP | deployed on the Tokyo VPS (systemd: service, 2-min drain timer, Streamable-HTTP MCP, Cloudflare Tunnel) | `PASS` 2026-08-12 — official `StreamableHTTPClientTransport` listed 14 tools and returned the watch record via `https://pulse-mcp.yoru-and-akari.dev/mcp/<secret>`; see [deploy/tokyo](deploy/tokyo/README.md) |
| Android bridge | debug APK built, unit-tested, linted, and signature-checked | fallback only; not on the active path |

See [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md) and [DIAGNOSTICS.md](docs/DIAGNOSTICS.md) for the exact evidence and adaptive one-test-per-launch sequence.

**Current artifact (`0.1.4`, device-verified 2026-08-12)**: keeps every `0.1.3` button
unchanged and adds three one-per-launch collect+sync buttons — `collect hr live`
(60 s live HR subscription), `collect recents` (heart rate, resting HR, SpO2,
stress via `getRecentSamples`), and `collect stats` (`getTodayStatistic` for
step_count / distance / calories / standing / intensity_sport SUM and heart-rate
MAX/MIN). All three passed end-to-end on the real watch: real nonzero HR (62 bpm
live, 61 resting), SpO2 (99 %), stress (35) landed in the VPS store and are
queryable via the remote MCP. The zero-shape → NO_DATA mapping was confirmed on
device. Daily SUM statistics all returned empty (device capability boundary).
See [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md) for the full evidence.

Final host-built deliverables (2026-08-11, watch `0.1.3` added 2026-08-12, watch `0.1.4` added 2026-08-12):

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| [Android debug APK](artifacts/akari-pulse-android-debug-0.1.0.apk) | 31,164,014 | `D5F43C1D2F0468DF7CF71594320DE9E9748DB2410D480361E825A3ACC570C6D5` |
| [BlueOS debug RPK 0.1.4](artifacts/akari-pulse-watch-debug-0.1.4.rpk) | 84,899 | `AF16F9E39CEBB67AB79408B03668907CD40BBBFB6F6705599A9C8808FC63372B` |
| [BlueOS debug RPK 0.1.3](artifacts/akari-pulse-watch-debug-0.1.3.rpk) | 75,466 | `BFCCEA5B7181BFE20C7B547EA05E5025DC7DE76703A98A60D75BF95D1328E0A1` |
| [BlueOS debug RPK 0.1.2](artifacts/akari-pulse-watch-debug-0.1.2.rpk) | 69,649 | `D5A368469F556A379575178ACFA57530D35546D44742433788F13ED8EE0E98C6` |
| [Akari Health service](artifacts/akari-pulse-server-0.1.0.tgz) | 15,674 | `58AEC6FC70C221D0E910AB2820CA2512AE4F058F1E29E0B18532A19E88C2A07C` |
| [Akari Health MCP](artifacts/akari-pulse-mcp-0.1.0.tgz) | 8,757 | `7D7DA216EBF343045282EB335863184E5DAC23BF289452CA03B76FD3409DD3C1` |

The Cloudflare relay is deployed from [relay/](relay/README.md) (Worker `akari-pulse-relay`, D1 `akari-pulse-relay`, custom domain `pulse.yoru-and-akari.dev`); its tokens live in Cloudflare secrets and the untracked `relay/.secrets.local`.

The machine-readable list, APK signer certificate digest, and vendored AAR digest are in [SHA256SUMS.txt](artifacts/SHA256SUMS.txt).

## Repository

```text
akari-pulse/
|-- watch/       BlueOS health collection, durable queue, HTTPS/RPC adapters, diagnostics UI
|-- relay/       Cloudflare Worker ingest buffer (pulse.yoru-and-akari.dev) and D1 schema
|-- android/     fallback bridge: Room inbox/outbox, official vivo RPC receiver, HTTP probe receiver
|-- server/      Node.js 24 HTTP service and SQLite persistence
|-- mcp/         independent MCP (stdio + Streamable HTTP) using the official TypeScript SDK
|-- deploy/      Tokyo VPS systemd units and runbook (always-on store + remote MCP)
|-- contracts/   strict shared event and batch schemas
|-- scripts/     install, start, smoke, relay-drain, and exact-tailnet-bind scripts
|-- docs/        architecture, research, diagnostics, testing, and real-device evidence
`-- artifacts/   built deliverables and SHA-256 manifest
```

## Architecture choice

The production route is watch-direct HTTPS: `@blueos.network.fetch` POSTs the batch contract to the Cloudflare relay at `pulse.yoru-and-akari.dev`, which buffers in D1 and is drained into the local Akari Health service by `scripts/drain-relay.mjs`. vivo's official BlueXlink/device RPC pair was the original candidate and is now closed on this hardware: the real `WA2456C` fails at `interconnect` connection time with `code=1001 interconnectfeature error`, the official support table lists only vivo WATCH 3, and the required vivo `appid`/`encryStr` are not obtainable for this project. Evidence and classification live in [RESEARCH.md](docs/RESEARCH.md); the Android bridge remains buildable as a fallback receiver. OrbitV is used for RPK sideloading only and is not treated as a generic bridge API.

Every transport shares one durable contract. A receiver acknowledges a watch batch only after durable storage (relay: D1 insert; Android: Room transaction), and the watch dequeues only after a matching `batch_id` plus exact accepted/duplicate counts. The relay is drained — rows deleted — only after the local service acknowledges the same batch, so no layer drops data it has not handed off.

The backend is a local Node.js 24 service backed by `node:sqlite`. The MCP calls that service rather than opening the database, exposes read-only raw-health tools plus non-destructive start/stop session metadata actions, and does not modify the existing Akari Surface Desktop MCP.

Details and evidence are in [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [RESEARCH.md](docs/RESEARCH.md).

## Prerequisites

- Windows PowerShell 7 or Windows PowerShell 5.1.
- Node.js 24 or newer for the service and MCP.
- JDK 17 and Android SDK API 35 for rebuilding the Android app.
- BlueOS Studio 2.x, including its bundled Node.js and `blueos-pack`, for rebuilding the RPK.
- Optional: Tailscale for phone-to-Windows private-network access.
- For official vivo RPC at runtime: a vivo developer `appid`, intelligent-terminal SDK key (`encryStr`), vivo Health on the phone, and a package/signing-fingerprint pair accepted by the watch.

## Install and verify the service/MCP

From `E:\BlueOS\akari-pulse`:

```powershell
.\scripts\install.ps1
.\scripts\verify-service.ps1
```

Start the loopback service:

```powershell
.\scripts\start-server.ps1
```

To bind only the machine's current Tailscale IPv4, first provide a strong bearer token:

```powershell
$env:AKARI_HEALTH_TOKEN = '<strong-random-token>'
.\scripts\start-server-tailnet.ps1
```

The tailnet script reads the exact IPv4 from `tailscale ip -4`. It does not run `tailscale up`, alter grants, change Windows Firewall, or modify an existing Serve/Funnel configuration.

Start the independent MCP in another terminal:

```powershell
$env:AKARI_HEALTH_URL = 'http://127.0.0.1:8787'
$env:AKARI_HEALTH_TOKEN = '<same-token-if-configured>'
.\scripts\start-mcp.ps1
```

Ready-to-edit client examples are [codex.example.toml](mcp/config/codex.example.toml) and [claude-desktop.example.json](mcp/config/claude-desktop.example.json). Keep the bearer token in the local environment/config only; do not commit it.

## Build and configure Android

The official public AAR is vendored at `android/app/libs/device-rpc-1.0.0.17.aar` with its SHA-256 sidecar. To rebuild, put only local machine values in the ignored `android/local.properties`:

```properties
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
VIVO_RPC_APP_ID=<numeric-vivo-appid>
```

If no app ID is available, omit the second line; the APK still builds and the UI truthfully reports official RPC as `API_MISSING`. Build and validate:

```powershell
Set-Location .\android
.\gradlew.bat testDebugUnitTest assembleDebug lintDebug --no-daemon --max-workers=1
.\scripts\verify-device-rpc.ps1
```

Install the resulting debug APK with Android Studio or:

```powershell
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
```

In the app, configure the Akari Health base URL/token. Enter `encryStr` in the secure runtime field only; Android Keystore encrypts it at rest. Start `official vivo rpc` only after the app ID and key exist. The `session notification` controls are explicitly best-effort: dispatch does not confirm watch execution or create the backend session.

The debug-only HTTP receiver permits cleartext for a controlled loopback/tailnet probe. A non-loopback listener requires a separate bridge token of at least 16 characters. Release builds reject cleartext service URLs.

## Build and configure the watch

The watch app calls the current official modules directly:

- `@blueos.health.health` with `watch.permission.READ_HEALTH_DATA`;
- `@blueos.hardware.sensor.sensor` with `watch.permission.STEP_COUNTER`;
- `@blueos.bluexlink.connectionManager` for the production RPC candidate;
- `@blueos.network.fetch` for the explicit HTTP probe.

Before a paired RPC build, set `watch/src/config.js` `phonePackage` to `dev.akari.pulse.bridge` and `phoneSha256` to the SHA-256 signer fingerprint of the exact APK being installed. Rebuilding the APK with a different debug/developer certificate changes that fingerprint and requires rebuilding the RPK.

Use the build command documented in [watch/README.md](watch/README.md), then install the RPK through the current OrbitV sideload flow. The checked-in project never carries a watch signing private key. BlueOS Studio's debug builder may generate a local debug signature; a release RPK requires the operator's own developer certificate and key.

Since `0.1.3` the watch adapter defaults to `http` against the relay endpoint `https://pulse.yoru-and-akari.dev/v1/health/batches` with the ingest token from `relay/.secrets.local` compiled in via `watch/src/config.js`. Rotating that token requires `wrangler secret put INGEST_TOKEN` (or the REST equivalent) plus a watch rebuild. Pointing the adapter at the Android LAN listener instead is a fallback: set an address the physical watch can actually reach and the Android bridge token; `127.0.0.1:23102` is deliberately not claimed to map to the phone on a real watch.

## Data and failure semantics

Every observation is one immutable event containing the producer timestamp, metric, source device, status, and optional real value/sample timestamp/callback delta/session/error. `PASS` requires a real value. Missing or failed measurements remain `NO_DATA`, `DENIED`, `UNSUPPORTED`, `API_MISSING`, or `ERROR`; no layer substitutes zero or a stale value.

Failures are attributed to `watch_module_api`, `permission`, `sample_acquisition`, `watch_transport`, `phone_receive`, `phone_persistence`, `uplink`, `backend_ingest`, `database`, or `mcp_query`. Follow [DIAGNOSTICS.md](docs/DIAGNOSTICS.md) from the first non-`PASS` layer.

Raw health records have no update/delete HTTP or MCP route. Session summaries may calculate baseline, peak, delta, latency-to-rise, and time-to-peak from real samples and timestamped events, but they state that temporal association does not establish causality.

## Tests and artifacts

The complete reproducible verification record is [TESTING.md](docs/TESTING.md). Built files and their checksums are under [artifacts](artifacts); use `SHA256SUMS.txt` rather than assuming similarly named local builds are identical.

Do not interpret an RPK/APK build, an RPC send callback, a simulator request, or `/healthz` as a physical-watch end-to-end pass. Only update [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md) after capturing evidence from the named baseline without including tokens, SDK keys, serial numbers, MAC addresses, cookies, or account identifiers.
