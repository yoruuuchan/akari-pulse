# Akari Pulse

English | [中文](README.zh-CN.md)

**Akari Pulse is a self-hosted bridge that takes the health data your own vivo phone and
watch already collect, puts it in a database you control, and serves it to your own AI
assistant over MCP.**

You run every part of it. Your phone reads its own health providers, your relay buffers
the upload, your server stores it, and your MCP endpoint answers queries from ChatGPT,
Claude, or any other MCP client you point at it. There is no Akari Pulse cloud in the
middle, because no such service exists.

The reason people usually want this: an AI assistant — or an AI companion — that can
actually see how you slept and how your body is doing today, instead of asking you to
type it in every morning. That is one natural use of a personal health MCP, not the only
one; the same endpoint is just as useful for a self-tracking dashboard or your own
analysis scripts.

## What it can read today

| Source | Data |
|---|---|
| **vivo phone** | daily steps · distance · calories · last night's full sleep summary with stages, wake-ups and score · latest heart rate · latest SpO2 · latest stress |
| **vivo watch** (`WA2456C`) | heart rate · resting heart rate · SpO2 · stress · the watch-side diagnostics already supported by the collector |

Sleep and the three latest vitals come from vivo's **private** health providers, which a
sideloaded app cannot reach until you grant it access yourself over ADB — see
[the owner ADB bootstrap](#the-owner-adb-bootstrap) below. Steps, distance and calories
need no such step.

## Rules the project holds to

- **Phone and watch stay separate.** Both sources are returned side by side. Neither is
  merged into the other and neither is given precedence.
- **No silent fallback.** A failed read never becomes a cached value, a stale value, a
  UI scrape, or an invented zero.
- **Missing data stays missing, visibly.** Every observation is `PASS`, `NO_DATA`,
  `DENIED`, `UNSUPPORTED`, `API_MISSING`, or `ERROR`. A real measured zero is still
  `PASS`; an absent measurement never becomes one.
- **No shared cloud, no telemetry, no analytics.** Nothing phones home. You deploy the
  relay, the database, the backend and the MCP endpoint yourself.
- **Your AI client only ever sees the answer to the query you asked**, not the database.

This project handles sensitive personal health data, and sleep data in particular is a
detailed record of when you are home and unconscious. Read [PRIVACY.md](PRIVACY.md) and
[SECURITY.md](SECURITY.md) before you expose any endpoint beyond loopback.

## Verified environment

Compatibility here is per model **and** per firmware. A successful build proves nothing
about a device that has not been tested.

| Device | State |
|---|---|
| vivo X200 Pro (`V2405A` / `PD2405`, Android 15) | **Verified** on the ROM installed at test time, 2026-08-14. Daily activity, private sleep and latest vitals all read successfully and matched the vivo Health UI. |
| vivo WATCH GT, first-gen Bluetooth `WA2456C` (BlueOS 3.0, firmware `DPD2346C_A_1.54.5`) | **Verified** 2026-08-12 for the watch health chain end to end. |
| Any other vivo or iQOO phone, watch, ROM or firmware | **Unverified.** The private-provider route may be refused outright, in which case Akari Pulse reports `NOT_GRANTED` or `UNSUPPORTED` and does not work around it. |

vivo's official Health Kit remains the supported, ADB-free third-party route. Akari Pulse
is an owner-controlled path for the owner's own device, not a distribution mechanism.

Status: reference / research. Published as-is with no maintenance or support promise. Not
affiliated with, endorsed by, or sponsored by vivo. Every endpoint in this repository is a
placeholder — `pulse.example.com`, `pulse-mcp.example.com`, `REPLACE_WITH_*` — and there
are no real tokens, credentials, or signing keys in the tree.

The RPK sideloading path relies on the OrbitV community's work; without it the watch could
not receive an unsigned developer build at all.

## How the pieces fit together

```text
vivo phone                                      vivo WATCH GT (WA2456C)
  step provider    -> daily summaries             BlueOS health + sensor APIs
  private sleep    -> sleep summary               durable on-watch queue
  private care     -> latest HR / SpO2 / stress   HTTPS via the paired phone
      |                                                 |
      +--> Android bridge: Room + immutable outbox <-----+
                              |
                              v
              Cloudflare Worker relay (D1 buffer)      you deploy this
                              |
                              v
              Akari Health service (Node.js + SQLite)  you deploy this
                              |
                              v
              Akari Health MCP (stdio / Streamable HTTP)
                              |
                              v
                  ChatGPT / Claude / any MCP client
```

Three data shapes travel that path, deliberately kept distinct:

- **Daily activity** is a natural-day cumulative summary — one current row per
  `(source, metric, source_day)`, replaced by later reads of the same day.
- **Sleep** is a bounded interval with stages, not a day counter, so it gets its own
  contract — one current row per `(source, source_day)`.
- **Latest vitals** are single timestamped observations, each carrying the provider's own
  measurement time. They are never republished as a daily minimum, maximum, average, or
  resting value.

Every upload batch is immutable, and every receiver acknowledges only after durable
storage. The relay deletes a row only after the backend confirms that exact batch, so no
layer drops data it has not handed off.

Full detail is in [ARCHITECTURE.md](docs/ARCHITECTURE.md); the reverse-engineering
evidence is in [RESEARCH.md](docs/RESEARCH.md).

## Repository

Every component has its own README; start with the one for the layer you are touching.

| Path | What it is |
|---|---|
| [`watch/`](watch/README.md) | BlueOS health collection, durable queue, HTTPS/RPC adapters, diagnostics UI |
| [`android/`](android/README.md) | phone-local daily summaries, vivo private sleep/vitals, fallback watch receiver |
| [`relay/`](relay/README.md) | Cloudflare Worker ingest buffer and D1 schema |
| [`server/`](server/README.md) | Node.js 24 HTTP service and SQLite persistence |
| [`mcp/`](mcp/README.md) | independent MCP (stdio + Streamable HTTP) using the official TypeScript SDK |
| [`deploy/`](deploy/tokyo/README.md) | systemd units and runbook for an always-on store + remote MCP |
| [`contracts/`](contracts/README.md) | strict shared event and batch schemas |
| [`docs/`](docs/ARCHITECTURE.md) | architecture, research, diagnostics, testing, and real-device evidence |
| [`artifacts/`](artifacts/README.md) | deliverable policy and SHA-256 manifest (no binaries are published) |
| `scripts/` | install, start, smoke, relay-drain, ADB bootstrap, and tailnet-bind scripts |

[SPEC.md](SPEC.md) states the product and data-model requirements the implementation is
held to.

## Prerequisites

- Windows PowerShell 7 or Windows PowerShell 5.1.
- Node.js 24 or newer for the service and MCP.
- JDK 17 and Android SDK API 35 for rebuilding the Android app.
- Android platform-tools (`adb`) on `PATH` for the private-provider bootstrap.
- BlueOS Studio 2.x, including its bundled Node.js and `blueos-pack`, for rebuilding the RPK.
- Optional: Tailscale for phone-to-Windows private-network access.
- Optional, for vivo's official RPC at runtime: a vivo developer `appid`, an
  intelligent-terminal SDK key (`encryStr`), vivo Health on the phone, and a
  package/signing-fingerprint pair the watch accepts.

## Install and verify the service/MCP

From the repository root:

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

The tailnet script reads the exact IPv4 from `tailscale ip -4`. It does not run
`tailscale up`, alter grants, change Windows Firewall, or modify an existing Serve/Funnel
configuration.

Start the independent MCP in another terminal:

```powershell
$env:AKARI_HEALTH_URL = 'http://127.0.0.1:8787'
$env:AKARI_HEALTH_TOKEN = '<same-token-if-configured>'
.\scripts\start-mcp.ps1
```

Ready-to-edit client examples are [codex.example.toml](mcp/config/codex.example.toml) and
[claude-desktop.example.json](mcp/config/claude-desktop.example.json); adjust the paths for
your host. Keep the bearer token in the local environment/config only; do not commit it.

For an always-on deployment — so queries still work with your PC off — the systemd units
and runbook are in [deploy/tokyo](deploy/tokyo/README.md). Treat the resulting MCP URL as a
password: the unguessable path *is* the credential.

## Build and configure Android

The official public AAR is vendored at `android/app/libs/device-rpc-1.0.0.17.aar` with its
SHA-256 sidecar. To rebuild, put only local machine values in the ignored
`android/local.properties`:

```properties
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
VIVO_RPC_APP_ID=<numeric-vivo-appid>
```

If no app ID is available, omit the second line; the APK still builds and the UI truthfully
reports official RPC as `API_MISSING`. Build and validate:

```powershell
Set-Location .\android
.\gradlew.bat testDebugUnitTest assembleDebug lintDebug --no-daemon --max-workers=1
.\scripts\verify-device-rpc.ps1
```

Install the resulting debug APK with Android Studio or:

```powershell
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
```

In the app, configure the Akari Health base URL and the phone-specific upload credential in
`server bearer token`; Android Keystore encrypts it at rest. `read today activity` persists
the three phone daily-summary metrics transactionally and queues
`/v1/health/daily-summaries` through WorkManager. Keep this credential separate from the
watch relay's `INGEST_TOKEN`.

The debug-only HTTP receiver permits cleartext for a controlled loopback/tailnet probe. A
non-loopback listener requires a separate bridge token of at least 16 characters. Release
builds reject cleartext service URLs.

### The owner ADB bootstrap

Sleep and the three latest vitals live behind `com.vivo.health.widget.permission`, which
vivo declares `signature|privileged`. **An installed third-party APK never receives it**,
no matter what its manifest asks for. Until it is granted, Akari Pulse reports
`NOT_GRANTED` and returns null values.

This is not a way around vivo's permission system, and nothing about vivo Health is
modified. It is the device owner using ADB — the same tool Android ships for exactly this
purpose — to say: *this app, on my phone, may read my own health providers.* You can undo
it at any time.

Grant it once per install:

```powershell
pwsh -File .\scripts\bootstrap-vivo-private-health.ps1
```

The script does not trust the grant command. `pm grant` can exit 0 on a ROM that quietly
refuses to change anything, so the verdict is **read back from `dumpsys package`** and
printed as `PASS` or `FAIL`. It also refuses to act at all when `adb` is missing, no
authorized device is attached, several devices are attached without `-Serial`, the package
is not installed, or the provider authorities do not exist on the device.

Revoke it the same way, verified the same way:

```powershell
pwsh -File .\scripts\bootstrap-vivo-private-health.ps1 -Revoke
```

After a successful grant, use `read sleep and vitals` in the app and confirm its capability
card:

| Capability state | Meaning | What to do |
|---|---|---|
| `GRANTED` | the permission is held and both providers are readable | nothing — reads will work |
| `NOT_GRANTED` | the providers exist, but this build does not hold the permission | run the bootstrap script |
| `UNSUPPORTED` | the provider authorities do not exist on this device | this route is unavailable on this phone |
| `ERROR` | the probe itself failed; the raw reason is kept | read the reported reason |

Things to expect, all of them demonstrated on the verified device rather than assumed:

- **Reinstalling the APK clears the grant.** Re-run the script after every install.
- **A system update, factory reset, or new phone may clear or refuse it.** Re-verify;
  do not assume the previous result still holds.
- **A ROM is allowed to say no.** The script then reports `FAIL` and the app reports
  `NOT_GRANTED`. Neither is worked around, and neither falls back to stale data.
- **This is not a general Android or vivo guarantee.** It is one verified phone, one ROM,
  at one point in time.

## Build and configure the watch

The watch app calls the current official modules directly:

- `@blueos.health.health` with `watch.permission.READ_HEALTH_DATA`;
- `@blueos.hardware.sensor.sensor` with `watch.permission.STEP_COUNTER`;
- `@blueos.bluexlink.connectionManager` for the production RPC candidate;
- `@blueos.network.fetch` for the explicit HTTP probe.

Before a paired RPC build, set `watch/src/config.js` `phonePackage` to
`dev.akari.pulse.bridge` and `phoneSha256` to the SHA-256 signer fingerprint of the exact
APK being installed. Rebuilding the APK with a different debug/developer certificate
changes that fingerprint and requires rebuilding the RPK.

Use the build command documented in [watch/README.md](watch/README.md), then install the
RPK through the current OrbitV sideload flow. The checked-in project never carries a watch
signing private key. BlueOS Studio's debug builder may generate a local debug signature; a
release RPK requires the operator's own developer certificate and key.

Since `0.1.3` the watch adapter defaults to `http` against your relay's
`/v1/health/batches` endpoint with your ingest token compiled in via `watch/src/config.js`
(placeholders `pulse.example.com` / `REPLACE_WITH_YOUR_INGEST_TOKEN` in this repository).
Because the token is compiled into the package, **never publish a built RPK** — rotating it
requires `wrangler secret put INGEST_TOKEN` (or the REST equivalent) plus a watch rebuild.
Pointing the adapter at the Android LAN listener instead is a fallback: set an address the
physical watch can actually reach and the Android bridge token; `127.0.0.1:23102` is
deliberately not claimed to map to the phone on a real watch.

vivo's official BlueXlink/device RPC pair was the original watch-to-phone candidate and
remains **closed** on this hardware: the real `WA2456C` fails at `interconnect` connection
time with `code=1001 interconnectfeature error`, the official support table lists only vivo
WATCH 3, and the required vivo `appid`/`encryStr` are not obtainable for this project. The
Android watch receiver remains buildable as a fallback. OrbitV is used for RPK sideloading
only and is not treated as a generic bridge API.

## Data and failure semantics

Every watch observation is one immutable event containing the producer timestamp, metric,
source device, status, and optional real value/sample timestamp/callback delta/session/
error. A phone natural-day summary is instead a versioned current row backed by immutable
upload batches; it is never disguised as a watch event. A phone sleep night is a third
shape: one current row per source day, also backed by immutable batches. `PASS` requires a
real value, including a legitimate numeric zero. Missing or failed measurements remain
`NO_DATA`, `DENIED`, `UNSUPPORTED`, `API_MISSING`, or `ERROR`; no layer substitutes a stale
value.

Failures are attributed to `watch_module_api`, `permission`, `sample_acquisition`,
`watch_transport`, `phone_receive`, `phone_persistence`, `uplink`, `vivo_private_health`,
`backend_ingest`, `database`, or `mcp_query`. Follow [DIAGNOSTICS.md](docs/DIAGNOSTICS.md)
from the first non-`PASS` layer.

Raw health records have no update/delete HTTP or MCP route. Session summaries may calculate
baseline, peak, delta, latency-to-rise, and time-to-peak from real samples and timestamped
events, but they state that temporal association does not establish causality.

The MCP exposes 14 narrow tools. Every one declares all four MCP annotations —
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — explicitly rather than
relying on the spec defaults. The full list, their semantics, and the annotation matrix are in
[mcp/README.md](mcp/README.md).

## Current delivery status

| Layer | Host result | Real-device result |
|---|---|---|
| BlueOS watch app | `0.1.5` evidence-and-boundary RPK built with the BlueOS Studio toolchain (superset of `0.1.4`; adds ZERO_SENTINEL and raw-payload evidence in `collect stats`, per-metric layer breakdown, and a new `probe sleep` button) | `0.1.2` passed the full isolated health chain (3/3 cold-start full-pipeline passes, no reboot); `0.1.3` `net probe` and `send batch https` passed on 2026-08-12; `0.1.4` all three collect+sync buttons verified 2026-08-12 — real nonzero HR, SpO2, stress, resting HR landed in the VPS store end-to-end; `0.1.5` (versionCode 6, SHA-256 `C8AFBE32446E30D745CBCFE68C8C7D5DA101B7B58DD78CCD52167C2D7343AE76`, 89,461 bytes) device-verified 2026-08-12: sentinel rule confirmed, SUM-stats and sleep boundaries conclusively established, NOT_APPLICABLE layer semantics live (see [REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md)) |
| Watch health chain | one-test-per-launch harness | `PASS` — `getRecentSamples([HEART_RATE])` → callback → parse → UI → queue → snapshot → storage is stable; do not rework without new failing evidence |
| Official BlueXlink RPC | public watch API and official Android AAR integrated | **closed**: `transport init` fails with `code=1001 interconnectfeature error`; support table lists only WATCH 3; vivo `appid`/`encryStr` unobtainable — see [RESEARCH.md](docs/RESEARCH.md) |
| Cloudflare relay | strict watch-event, phone-daily-summary, and phone-sleep-summary ingest routes; replay/conflict/auth tests (5/5) | `PASS` — real watch HTTPS on 2026-08-12; real phone daily-summary batches on 2026-08-14; real phone event and sleep-summary batches later the same day drained back to zero pending rows |
| Akari Health service | authenticated watch-event plus idempotent daily-summary and sleep-summary routes tested against temporary databases (21/21) | `PASS` — established watch records remain untouched across the schema 2 -> 3 migration; repeated reads of one night collapse to a single current row per source day |
| Akari Health MCP | official SDK client lists and invokes all 14 tools (3/3 e2e) | `PASS` — `health_sleep`, `health_heart_rate`, `health_spo2`, and `health_stress` expose phone/watch side by side with no merge or precedence; records are newest-first with `latest`/`latest_by_source`, sleep windows filter by interval overlap, `health_activity` returns the phone daily summaries, and an ACTIVE source that stopped reporting is `DEGRADED` with its age rather than a silent `PASS`, while the manual `WA2456C` watch harness is `HISTORICAL` — still queryable, still aged honestly, but not a production-health signal |
| Always-on VPS + remote MCP | deployed on a Tokyo VPS (systemd: service, 2-min drain timer, Streamable-HTTP MCP, Cloudflare Tunnel) | `PASS` — public remote watch verification on 2026-08-12; production MCP reverified 2026-08-14 after the private-provider work and again 2026-08-17 after the query-layer fixes, both times against the live store over the public connector URL; see [deploy/tokyo](deploy/tokyo/README.md) |
| Android app | debug APK built, 35 unit tests, linted, Room 1 -> 2 and 2 -> 3 migration-tested | `PASS` 2026-08-14 — in-place vivo upgrade preserving data, repeated real provider reads, and `OK (2 tests)` on-device migration; daily-activity, sleep, and latest-vitals reads each matched the vivo Health UI; exact personal values are intentionally omitted from this public repository |
| vivo private health providers | reader unit-tested against synthetic cursors and payloads only | `PASS` 2026-08-14 on vivo X200 Pro (`V2405A` / `PD2405`, Android 15) **behind a one-time owner ADB grant** — 38-column sleep cursor read by column name, three provider identities held exactly, wake-up count matched the UI; revoking the grant correctly reported `NOT_GRANTED` with null values and no cached fallback. Other models/firmware unverified |

Exact evidence and the adaptive one-test-per-launch sequence are in
[REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md) and
[DIAGNOSTICS.md](docs/DIAGNOSTICS.md).

## Tests and artifacts

The complete reproducible verification record is [TESTING.md](docs/TESTING.md). Run the
repository-wide suite with:

```bash
npm test
```

**No binaries are distributed here** — see [artifacts/README.md](artifacts/README.md) for
why. `SHA256SUMS.txt` is kept as the historical record of what was privately built and
device-verified:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `akari-pulse-android-debug-0.1.0.apk` | 31,164,014 | `D5F43C1D2F0468DF7CF71594320DE9E9748DB2410D480361E825A3ACC570C6D5` |
| `akari-pulse-watch-debug-0.1.5.rpk` | 89,461 | `C8AFBE32446E30D745CBCFE68C8C7D5DA101B7B58DD78CCD52167C2D7343AE76` |
| `akari-pulse-watch-debug-0.1.4.rpk` | 84,899 | `AF16F9E39CEBB67AB79408B03668907CD40BBBFB6F6705599A9C8808FC63372B` |
| `akari-pulse-watch-debug-0.1.3.rpk` | 75,466 | `BFCCEA5B7181BFE20C7B547EA05E5025DC7DE76703A98A60D75BF95D1328E0A1` |
| `akari-pulse-watch-debug-0.1.2.rpk` | 69,649 | `D5A368469F556A379575178ACFA57530D35546D44742433788F13ED8EE0E98C6` |
| `akari-pulse-server-0.1.0.tgz` | 15,674 | `58AEC6FC70C221D0E910AB2820CA2512AE4F058F1E29E0B18532A19E88C2A07C` |
| `akari-pulse-mcp-0.1.0.tgz` | 8,757 | `7D7DA216EBF343045282EB335863184E5DAC23BF289452CA03B76FD3409DD3C1` |

The machine-readable list, APK signer certificate digest, and vendored AAR digest are in
[SHA256SUMS.txt](artifacts/SHA256SUMS.txt).

Do not interpret an RPK/APK build, an RPC send callback, a simulator request, or
`/healthz` as a physical-device end-to-end pass. Only update
[REAL_DEVICE_RESULTS.md](docs/REAL_DEVICE_RESULTS.md) after real-device verification, and
keep public evidence free of personal health values, tokens, SDK keys, serial numbers, MAC
addresses, cookies, private endpoint URLs, and account identifiers. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright (c) 2026 Yoru. Licensed under the
[GNU Affero General Public License v3.0](LICENSE).

AGPL-3.0 is deliberate for this kind of project: if you modify Akari Pulse and offer it to
other people over a network, those users are entitled to your modified source. Running your
own private instance for yourself imposes no obligation at all.
