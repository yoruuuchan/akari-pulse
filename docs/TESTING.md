# Testing and verification

This file separates host-verifiable results from the device evidence that is still unavailable. Commands are run from `E:\BlueOS\akari-pulse` unless a different working directory is shown. Test fixtures use temporary databases and are never inserted into the production database.

## Verified host environment

| Tool | Verified value |
|---|---|
| Node.js | `v24.14.0` |
| npm | `11.9.0` |
| Java | JDK 17 |
| Android SDK | API 35 available |
| Android build tools | 36.1.0 available |
| BlueOS build | BlueOS Studio 2.0.5 bundled Node 18.20.3 and `blueos-pack` 1.0.9-beta.24 |
| Tailscale | local CLI 1.102.2; existing Serve/Funnel state left unchanged |

## Service unit/integration tests

```powershell
npm --workspace @akari-pulse/server test
```

Verified result: 4 tests passed. Coverage includes non-loopback token enforcement, authenticated ingest, append-only/idempotent replay, batch/event ID conflicts, correlation-event replay/conflict, queries, session summaries, rejection of missing or null `PASS` values, and exact JSON media-type enforcement.

Node prints its current `node:sqlite` experimental warning. The project leaves that warning visible; it is not a test failure.

## MCP process E2E

```powershell
npm --workspace @akari-pulse/mcp test
```

Verified result: 1 end-to-end test passed. It starts an isolated HTTP service, launches the real stdio MCP entry as a child process, connects with the official MCP TypeScript client, negotiates protocol `2026-07-28`, lists all 14 tools, invokes status/latest/steps/start/stop/summary, verifies the explicit cumulative-since-boot step fallback, validates structured output, and rejects an ambiguous timestamp without an explicit timezone.

## Dependency audit

```powershell
npm audit --omit=dev
```

Verified result: 0 known production dependency vulnerabilities (`info`, `low`, `moderate`, `high`, and `critical` all zero) at the time recorded in this delivery.

## Real service process smoke

```powershell
.\scripts\verify-service.ps1
```

The script chooses a free candidate port, creates a new directory beneath the system temporary directory, starts the real service process with a random token and file-backed SQLite database, waits for `/healthz`, queries authenticated `/v1/status`, confirms an unauthenticated status request is rejected, stops the process, and removes only its verified temporary directory.

Expected fields:

```text
health               PASS
database             PASS
backend_ingest       NO_DATA
unauthorized_request Unauthorized
```

`backend_ingest=NO_DATA` is correct for an empty, non-fixture smoke database.

The same process was also bound to the machine's exact Tailscale IPv4 and passed liveness, database, and authentication checks locally. This proves exact-interface binding and auth enforcement only; remote phone reachability and Windows Firewall policy remain a real-environment gate. No Tailscale, Serve/Funnel, grant, or firewall setting was changed.

## Android build and validation

Use the low-memory invocation that was proven on this Windows host:

```powershell
Set-Location .\android
.\gradlew.bat testDebugUnitTest assembleDebug lintDebug --no-daemon --max-workers=1
```

The project pins one worker and in-process Kotlin settings in `gradle.properties`. An earlier parallel build exhausted Windows commit/pagefile during Kotlin compilation; rerunning with the constrained settings completed, so that failure was environmental rather than a source/dependency error.

Unit coverage includes the strict cross-layer batch parser and the service URL security policy. Lint must complete with no blocking issue. Validate the official AAR and APK after building:

```powershell
Set-Location .\android
.\scripts\verify-device-rpc.ps1
$sdk = (Get-Content .\local.properties | Where-Object { $_ -like 'sdk.dir=*' } | Select-Object -First 1).Substring(8).Replace('\\:', ':').Replace('\\\\', '\\')
& (Get-ChildItem "$sdk\build-tools" -Recurse -Filter apksigner.bat | Sort-Object FullName -Descending | Select-Object -First 1).FullName verify --verbose --print-certs .\app\build\outputs\apk\debug\app-debug.apk
```

Final result on 2026-08-11: `BUILD SUCCESSFUL` in 1 minute 7 seconds; 57 actionable Gradle tasks completed, including `testDebugUnitTest`, `assembleDebug`, and `lintDebug`. The two unit suites ran 14 tests (9 contract tests and 5 URL-policy tests) with zero failures/errors/skips. Lint reported 0 errors and 13 non-blocking warnings: deliberate API/dependency version pins plus KTX style suggestions. The application-icon, Android 12+ data-extraction, and ViewModel context warnings were resolved before this build.

Final APK verification:

```text
source path:    android/app/build/outputs/apk/debug/app-debug.apk
artifact path:  artifacts/akari-pulse-android-debug-0.1.0.apk
size:           31,164,014 bytes
SHA-256:        D5F43C1D2F0468DF7CF71594320DE9E9748DB2410D480361E825A3ACC570C6D5
package:        dev.akari.pulse.bridge
version:        versionCode 1 / versionName 0.1.0
SDK:            min 28 / target 35 / compile 35
signature:      APK Signature Scheme v2, one signer
certificate:    d856396dcd991afdda0045df334b5845ee633eacb03787a2d6d908709ef13a44
```

The merged manifest contains the non-exported HTTP foreground receiver service, exported official `DeviceRpcService`, action `com.vivo.health.device.rpc.channel`, both app-ID metadata keys, and `health.device.manager.version=1`. This credential-free host build uses app ID `0`, so official RPC correctly remains `API_MISSING` at runtime. The vendored AAR independently matched SHA-256 `38B9C774B7C52B16F2BA7018C37864529E8656166E3DB438C864EBC6043C95DE`.

No private key is copied into the repository; the debug APK uses the host's normal Android debug signing path.

`adb devices` returned no connected device during host verification. Therefore APK install, launch, official RPC initialization, vivo OEM background policy, and disconnect/retry behavior are not marked passed.

### 2026-08-14 phone daily-summary extension

The phone persistence/uplink extension was verified separately from the older Android host-build record above:

```powershell
Set-Location .\android
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:lintDebug :app:compileDebugAndroidTestKotlin --console=plain
```

Result: `BUILD SUCCESSFUL`; 68 Gradle tasks completed. The root `npm test` run also passed all three workspaces: server 11/11, real stdio MCP 1/1, and Cloudflare relay 2/2. The server suite includes same-day cumulative replacement (`5 -> 100 -> 3200`, final value 3200), stale retry, exact duplicate, real-zero PASS, NO_DATA/ERROR, caller-timezone non-rebucketing, and simultaneous phone/watch visibility.

The latest debug APK was installed with `adb install -r`, preserving the original install time and application data. A stopped-app version-1 database backup was captured before installation. Opening the upgraded app migrated that database to version 2 without destructive fallback. The compiled instrumentation APK was then run directly so the test harness did not clear the configured application data:

```powershell
adb install -r .\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk
adb shell am instrument -w -r dev.akari.pulse.bridge.test/androidx.test.runner.AndroidJUnitRunner
```

Result: `OK (1 test)`. The migration test preserves a schema-1 watch row and validates schema-2 phone upsert semantics. The first two real provider reads created two completed immutable outboxes and one later current row per phone metric; a subsequent third real refresh advanced the production current values through a third distinct batch. Relay drain, production SQLite fields, official Streamable HTTP MCP calls, and the unchanged watch record count are documented in [REAL_DEVICE_RESULTS.md](REAL_DEVICE_RESULTS.md).

### 2026-08-14 vivo private sleep and vitals extension

```powershell
Set-Location .\android
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:lintDebug :app:assembleDebugAndroidTest `
  --no-daemon --max-workers=1 --console=plain
```

Result: `BUILD SUCCESSFUL`, 35 unit tests with zero failures or errors, lint with no blocking issue. The new reader tests use **synthetic fixtures only** — structurally identical cursors and payloads with invented numbers — so no personal health value enters the repository. They cover column-name addressing, an absent optional column staying null rather than becoming zero, the three provider identities, the strictly-interior wake-up rule, a non-finite or non-positive vital falling to `NO_DATA`, and each capability state.

The root `npm test` run passed all three workspaces: server 17/17, real MCP end-to-end 2/2, and Cloudflare relay 5/5. The server suite adds sleep-summary ingest, one-row-per-`source_day` upsert, the newer/duplicate/stale ordering rules, explicit absence, phone vitals staying beside watch vitals under their own metric names, the in-place v2 → v3 schema migration, and a denied capability surfacing as `DENIED` rather than as a missing layer.

Migration testing was run on the physical phone rather than an emulator. The compiled instrumentation APK is installed and invoked directly so the harness does not clear the configured application data:

```powershell
adb install -r .\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk
adb shell "am instrument -w -r dev.akari.pulse.bridge.test/androidx.test.runner.AndroidJUnitRunner"
```

Result: `OK (2 tests)` — the existing v1 → v2 test plus a new v2 → v3 test asserting that existing rows survive and that one sleep row is kept per `source_day`. Rebuild the androidTest APK with `:app:assembleDebugAndroidTest` before running; `:app:compileDebugAndroidTestKotlin` alone leaves a stale APK on disk and will silently run the old test set.

Before writing any acceptance result, confirm the phone is running the APK you just built:

```powershell
$p = (adb shell "pm path dev.akari.pulse.bridge") -replace 'package:',''
adb shell "sha256sum $($p.Trim())"
Get-FileHash .\app\build\outputs\apk\debug\app-debug.apk -Algorithm SHA256
```

The owner ADB bootstrap for the private providers is itself verified rather than assumed — it reads the grant back from `dumpsys package` instead of trusting the `pm grant` exit code. Exercise both directions:

```powershell
pwsh -File .\scripts\bootstrap-vivo-private-health.ps1 -Revoke
pwsh -File .\scripts\bootstrap-vivo-private-health.ps1
```

A revoked device must report `NOT_GRANTED` in the app with every value null, and a re-granted device must report `GRANTED` before any read result is treated as evidence. Device outcomes are in [REAL_DEVICE_RESULTS.md](REAL_DEVICE_RESULTS.md).

## BlueOS build and package validation

The watch source is compiled with the BlueOS Studio 2.0.5 bundled Node `18.20.3`, `blueos-pack 1.0.9-beta.24`, and compiler commit `2b772929`. From `watch`, the equivalent packager operation is:

```powershell
<blueos-studio-node.exe> <blueos-pack-bin> build --device-type watch-square -f
```

The `-f` debug build produces a signed debug RPK through the toolchain's local automatic debug-signing behavior. The repository does not add or copy a signing private key. Release signing is intentionally not claimed and requires the operator's own BlueOS developer certificate/key.

For `0.1.2`, the existing `watch/build`, `watch/dist`, and `watch/node_modules/.cache` directories were resolved beneath the watch root and moved to timestamped system-temporary isolation directories before compilation. Provisional `0.1.2` outputs were isolated the same way before the final compile. No prior RPK or cache directory was deleted. The final compiler run completed successfully in `17.347 s`.

Final RPK verification:

```text
source path:    watch/dist/watch-square/debug/com.akaripulse.watch.debug.0.1.2.rpk
artifact path:  artifacts/akari-pulse-watch-debug-0.1.2.rpk
size:           69,649 bytes
SHA-256:        D5A368469F556A379575178ACFA57530D35546D44742433788F13ED8EE0E98C6
package:        com.akaripulse.watch
version:        versionCode 3 / versionName 0.1.2
manifest:       debug=true / designWidth 466 / minPlatformVersion 1070
certificate:    CN=RPKDebug, O=RPK, C=CN
certificate:    SHA-256 6D3E6A3DCBDADB0AA94F64E33A36B01254CB6EF7E14BE282D885CD95AEB952E0
```

The outer and nested `META-INF/CERT` ZIP CRC checks returned no bad entry. Independent parsing of both `RPK Sig Block 42` blocks verified Pair1 and Pair2 RSA/SHA-256 signatures, certificate/public-key equality, and both signing-block sizes. The APK-style chunked content digests were independently recomputed for the outer RPK and inner CERT. All five outer Pair2 resource digests matched; all four digests in nested `hash.json` matched the packaged manifest, logo, VRU, and build metadata. The outer manifest exactly equals `watch/build/watch-square/manifest.json`.

The compiled manifest contains `appCategory=sports`, `watch-square` and `watch-round`, both health/sensor permissions, and compiler aliases for health, sensor, storage, fetch, and interconnect. Inspection of the compiled page confirms that `onInit()` only registers the queue and diagnostic observers. It contains no startup `queue.load`, `storage.getSync/set`, `transport.initialize`, health/sensor method, or subscription call. The compiled `hr invoke only` path retains empty success/fail functions around exactly one `getRecentSamples({dataTypes: [HEART_RATE]})` call.

Buildability and signature integrity do not prove health stability or identify the reboot cause on `WA2456C`. The required adaptive physical-watch sequence is recorded in [REAL_DEVICE_RESULTS.md](REAL_DEVICE_RESULTS.md) and [DIAGNOSTICS.md](DIAGNOSTICS.md).

## Clean package test

The final service and MCP archives were tested without using the working tree's installed dependencies:

```powershell
.\scripts\verify-packages.ps1
```

The script extracted both final archives into a verified temporary directory, installed the MCP archive's dependencies, ran the packaged server tests (4/4) and MCP process E2E (1/1), launched the packaged service against a new file-backed SQLite database, and confirmed liveness/database `PASS`, empty-ingest `NO_DATA`, and unauthenticated HTTP `401`. It then stopped the process and removed only its verified temporary directory.

Final archives:

```text
akari-pulse-server-0.1.0.tgz  15,674 bytes  58AEC6FC70C221D0E910AB2820CA2512AE4F058F1E29E0B18532A19E88C2A07C
akari-pulse-mcp-0.1.0.tgz      8,757 bytes  7D7DA216EBF343045282EB335863184E5DAC23BF289452CA03B76FD3409DD3C1
```

## Device acceptance still required

The watch was not directly attached to BlueOS Studio or ADB on this build host, but the user performed OrbitV tests on the named physical watch. OrbitV installation, the `READ_HEALTH_DATA` grant, one real nonzero heart-rate result in `0.1.0`, idle stability in `0.1.1`, and the two reported full-watch reboots are recorded in [REAL_DEVICE_RESULTS.md](REAL_DEVICE_RESULTS.md). There is still no device crash log or reboot reason.

The `0.1.2` isolated HR layers, live callback cadence, other health capabilities, screen-off behavior, official RPC credential acceptance, WA2456C channel support, business ACK shape, HTTP reachability from the watch, APK installation, OEM background behavior, remote tailnet upload, and MCP queries over real watch records remain unverified.

Run the short procedure in [REAL_DEVICE_RESULTS.md](REAL_DEVICE_RESULTS.md). Only record `PASS` when the observed operation returns real evidence; keep empty/denied/unsupported/missing/error outcomes distinct and retain the safe raw code/message.
