# akari pulse android bridge

This module is the Android persistence and uplink bridge between the BlueOS watch producer and the Akari Health service. It also contains a phone-local reader for vivo Health's current-day activity summary. The watch route is unchanged: every validated watch event is stored in Room before acknowledgement, upload batches remain stable across retries, and missing or failed readings never become `0` or another synthetic value.

The generated APK is sideloadable, but the official vivo path remains a real-device gate. A successful local build does not prove that vivo WATCH GT `WA2456C` supports the device RPC channel.

## verified build stack

| component | pinned version |
|---|---:|
| Android Gradle Plugin | 8.13.2 |
| Gradle wrapper | 8.13, SHA-256 pinned |
| JDK | 17 |
| Kotlin / Compose compiler plugin | 2.3.0 |
| KSP | 2.3.11 |
| compile / target / minimum SDK | 35 / 35 / 28 |
| build tools | 36.1.0 |
| Compose BOM | 2025.06.01 |
| Room | 2.8.4 |
| WorkManager | 2.11.2 |
| vivo device RPC AAR | 1.0.0.17 |

The deliberately older AndroidX core, activity, lifecycle, and Compose pins are the newest combination in this environment that compiles against API 35 with AGP 8.13. Newer releases observed during setup require API 37 and/or AGP 9.1.

## source layout

```text
android/
  app/libs/                         pinned vivo device RPC AAR and checksum
  app/schemas/                      exported Room schema
  app/src/main/java/dev/akari/pulse/bridge/
    contract/                       strict watch batch parsing and normalization
    data/                           Room entities, transactions, idempotence, upload batching
    diagnostics/                    adapter and uplink runtime state
    network/                        server client and HTTPS/tailnet URL policy
    phonehealth/                    vivo phone-local today activity reader and state
    settings/                       preferences and Android Keystore-backed secrets
    sync/                           WorkManager periodic and immediate uplink
    transport/http/                 explicit foreground HTTP probe receiver
    transport/rpc/                  official vivo device RPC adapter
    ui/                             Compose console and calm akari/yoru theme
  scripts/verify-device-rpc.ps1     vendor AAR integrity check
```

## local configuration

Create `local.properties`; it is ignored by version control. On Windows, escape the drive-letter colon as required by Java properties files:

```properties
sdk.dir=C\:/Users/your-name/AppData/Local/Android/Sdk
VIVO_RPC_APP_ID=123456
```

`VIVO_RPC_APP_ID` must be the integer issued for the package/signing-certificate pairing. When it is absent, the build uses `0` and the official adapter reports `API_MISSING`; it does not simulate initialization.

Enter these secrets through the in-app settings screen:

- Akari Health bearer token for a direct service URL, or the separate phone ingest token when the URL is the Cloudflare relay;
- `X-Akari-Bridge-Token` for a non-loopback HTTP receiver;
- vivo intelligent-terminal SDK `encryStr`.

They are encrypted with an Android Keystore AES/GCM key. They are not read from source files, shown back in the UI, or written to diagnostics. Blank secret fields keep an existing value.

The manifest publishes both `vivo.health.rpc.appid` (the first key read by AAR 1.0.0.17) and the documented `appid` fallback, plus `health.device.manager.version=1`.

## vivo phone-local today activity

The phone reader is independent of Health Kit registration and the BlueXlink watch receiver. It declares vivo's normal `com.vivo.assistant.StepProvider` permission and calls:

```text
content://com.vivo.assistant.step.provider
method = updateTodaySportAIDLBean
extras.ignore = true
```

`ignore=true` is invariant: it prevents caller-supplied step, distance, or calorie values from entering vivo's explicit sync/setter branch. The provider's returned `step` is already the current local-calendar-day cumulative summary and is never summed again. This is a read operation from Akari's boundary, but it is not described as absolutely side-effect-free: when vivo's cached day is stale, the vendor service may perform its own day-rollover maintenance. `Settings.System["vivo_settings_realtime_steps"]` is captured only as a secondary diagnostic; it is never promoted to `PASS` when the provider is absent or fails.

The structured result distinguishes `PROVIDER_CALL_SUCCEEDED`, `PROVIDER_NO_DATA`, `PROVIDER_CALL_FAILED`, and `PARSE_FAILED`. It includes the actual timezone/day, bridge observation time, permission state, capability/result Bundle keys, raw `can_step`, the unavailable `ret_code` as explicit `null`, Settings observation, and exception type/message. The vivo call does not expose a source timestamp, so `sample_epoch_ms` and `sampled_at` are labelled as observation time only.

On a debug APK, trigger one read and print exactly one JSON object under log tag `AkariPhoneHealth`:

```powershell
adb shell am start -S `
  -a dev.akari.pulse.bridge.action.DEBUG_READ_PHONE_HEALTH `
  -n dev.akari.pulse.bridge/.ui.MainActivity
adb logcat -d -s AkariPhoneHealth:I '*:S'
```

The bridge screen exposes the same operation as `read today activity`. A completed read now writes three Room v2 rows under `source=vivo_phone`: `phone_step_count`, `phone_distance`, and `phone_calories`. Their composite key is `source + metric + source_day`, so repeated reads replace the current summary for that day instead of summing it. `PASS` is the only state that stores a value; a real zero remains `PASS`, while `NO_DATA` and `ERROR` remain valueless and overwrite any older state rather than using a hidden cache.

The same transaction inserts an immutable outbox batch containing the exact `source_day`, IANA `source_timezone`, observation-only `sampled_at`, `source_timestamp_available=false`, outcome, and verification state. WorkManager retries the stable payload at `POST /v1/health/daily-summaries`. When pointed at the production relay, the configured secret is sent as `X-Akari-Bridge-Token`; when pointed directly at Akari Health it is also sent as the normal bearer credential. A batch is complete only after `accepted + duplicates + stale` equals its three summaries. Watch event persistence and `/v1/health/batches` uplink remain unchanged.

## official vivo RPC boundary

The vendored AAR is downloaded from `https://h5.vivo.com.cn/health/rpcsdk/new/device-rpc.aar`. Verify it before building:

```powershell
.\scripts\verify-device-rpc.ps1
```

Expected SHA-256:

```text
38b9c774b7c52b16f2ba7018c37864529e8656166e3db438c864ebc6043c95de
```

`OfficialRpcReceiverAdapter` uses the APIs that are actually present in AAR 1.0.0.17:

- `DeviceRpcManager.init`;
- `DeviceRpcManager.registerDataReceiver` with `IDataReceiver.onReceiveRequest` and `onReceiveNotification`;
- `DeviceRpcManager.onResponse` for a correlated request response;
- `RpcClient.notify` for best-effort phone-to-watch session control.

It does not call the obsolete/nonexistent `startDataReceiver` or `onReceiveData` APIs.

After initialization, the adapter requires `getHealthDeviceVersion() >= 2`. Version `-1` is `API_MISSING`; version `0` or `1` is `UNSUPPORTED`. In all of those cases it unregisters the receiver and never displays `LISTENING`. Passing this gate still does not establish `WA2456C` support.

When the process is created by vivo Health or another background component, `Application.onCreate` automatically retries official registration only if a nonzero build-time app ID and a stored `encryStr` already exist. The same capability gate applies, and missing/unsupported state remains visible rather than becoming a background success. Manual start, retry, and stop remain available in the console.

Incoming business requests must use the AAR action `Constant.Action.ACTION_DEVICE_BUSINESS_DATA`. The request data must be exactly this outer envelope, with no additional envelope fields:

```json
{
  "type": "akari.health.batch.v1",
  "data": {
    "batch_id": "<stable watch batch id>",
    "producer": "<watch producer>",
    "sent_at": "<epoch milliseconds or omit>",
    "events": ["<one to 500 real event objects>"]
  }
}
```

The `data` object is checked against the shared health event contract. Room commits both the events and the inbound batch receipt in one transaction before the adapter calls `onResponse`. A matching retransmission returns the original counts with `replayed: true`; reuse of a `batch_id` with a different payload returns `BATCH_ID_CONFLICT`.

The business acknowledgement contained in the response data is:

```json
{
  "code": 0,
  "result": {
    "batch_id": "<matching watch batch id>",
    "accepted": 8,
    "duplicates": 2,
    "replayed": false
  }
}
```

An incoming notification can be persisted, but the notification channel has no correlated business response. It is therefore recorded as an actual transport diagnostic and is not presented as reliable delivery.

Phone-to-watch session start/stop uses the same fixed AAR action and fixed `pkgName=com.vivo.health`. Its data is an outer envelope with type `akari.session.start` or `akari.session.stop` and a real caller-provided `session_id` plus `started_at` or `ended_at`. `RpcClient.notify` returns no execution acknowledgement, so the UI says only `notification dispatched; watch execution is unconfirmed`. The bridge does not create or invent a backend session.

## HTTP receiver probe

The HTTP receiver is an explicit diagnostic fallback, not evidence that BlueXlink works. It is stopped by default and starts only after the user presses `start receiver`, which launches a connected-device foreground service.

Defaults:

```text
bind address: 127.0.0.1
port:         23102
route:        POST /v1/health/batches
header:       X-Akari-Bridge-Token
```

The listener rejects `0.0.0.0` and `::`. A token of at least 16 characters is mandatory for every non-loopback bind address. Tokenless loopback is allowed only as a simulator/local probe and is displayed as `insecure local probe`, never `PASS`.

To exercise it with real captured data, save a valid shared-contract batch as `real-watch-batch.json` and run:

```powershell
$headers = @{ 'X-Akari-Bridge-Token' = '<the stored bridge token>' }
Invoke-WebRequest `
  -Method Post `
  -Uri 'http://<selected-phone-address>:23102/v1/health/batches' `
  -ContentType 'application/json' `
  -Headers $headers `
  -InFile .\real-watch-batch.json
```

The response is written only after the Room transaction commits and contains a matching `batch_id`, `accepted`, `duplicates`, `received_at`, and `replayed`. A socket/LAN/simulator probe does not prove that a physical watch can reach that address.

## Room and batch uplink

Room uses write-ahead logging and no destructive migration fallback. It stores:

- the normalized event payload, including producer timestamp, sample timestamp, status, quality, session ID, callback delta, and raw error code/message;
- whether `value` was present, so missing data remains distinct from a real numeric zero;
- a `PASS` value must be present and non-null; valid values such as numeric `0` and boolean `false` remain intact;
- inbound watch batch digest and acknowledgement counts for idempotent replay;
- stable Android watch upload batch ID, `sent_at`, event assignment, attempts, and terminal error text;
- current phone daily summaries keyed by `source + metric + source_day`, including timezone, observation time, explicit status/outcome, and nullable sync time;
- immutable phone daily-summary outbox JSON so a retry never changes the content behind a `batch_id`.

The worker drains watch batches first and then phone daily-summary batches without changing either contract. Watch events require `accepted + duplicates == event_count`; phone summaries require `accepted + duplicates + stale == summary_count`. A completed older phone outbox batch marks the current row synced only if its `sampled_at` still matches, so it cannot mark a newer local read complete. Network failures, HTTP 408/425/429, and 5xx responses are retryable. Contract conflicts and other permanent failures remain visible and do not delete queued data.

`GET <server>/v1/sessions/active` is a read-only status check. Heart-rate/session correlation remains a backend time-window decision; Android does not fabricate a session association.

## network security

- HTTPS is accepted for every valid server host and is the production default.
- Release builds reject/block cleartext HTTP.
- Debug builds allow HTTP only after explicit user consent and only for loopback, a full `.ts.net` name, or a Tailscale `100.64.0.0/10` address.
- Redirects are disabled so an authenticated request cannot silently move to another origin.
- A bearer token is added only from Keystore-backed settings.
- Cloud backup and device-to-device transfer explicitly exclude files, databases, shared preferences, root storage, and external app storage so health records and encrypted secret blobs are not migrated by Android backup.
- Prefer Tailscale HTTPS, for example an HTTPS name published through Tailscale Serve, over raw tailnet HTTP. Tailscale must be connected on the phone when that route is used.

## permissions and background limits

The app declares only the permissions needed by this implementation:

- `INTERNET` and `ACCESS_NETWORK_STATE` for uplink;
- `CHANGE_NETWORK_STATE` as the connected-device foreground-service prerequisite;
- `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_CONNECTED_DEVICE` for the user-started HTTP listener;
- `POST_NOTIFICATIONS` on Android 13+ so that foreground-service state is visible;
- vivo's normal `com.vivo.assistant.StepProvider` permission for the phone-local summary read.

The AAR and WorkManager merge their own `com.vivo.devicerpc.notify`, `WAKE_LOCK`, and `RECEIVE_BOOT_COMPLETED` declarations. The app does not request Bluetooth, location, body-sensor, or Health Connect permissions because this bridge does not access those APIs directly.

WorkManager periodic work has Android's 15-minute minimum and is not an exact timer. Immediate work requests are expedited when quota permits and fall back to normal work when quota is exhausted. Network constraints, Doze, OEM battery policy, force-stop, or disabled vivo background/autostart permission can delay work. On the target vivo phone, verify the app's background/autostart and battery settings instead of assuming a desktop build proves execution.

The HTTP service is `START_NOT_STICKY`: Android or user termination stops the listener, and the user must start it again. This avoids opening a receiver implicitly after boot or process restart.

## build, test, and sideload

PowerShell:

```powershell
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot'

.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:lintDebug `
  --no-daemon --console=plain
```

The checked-in low-memory Gradle settings use one worker, a 1 GiB heap, Serial GC, and in-process Kotlin compilation. This combination is intentional for the available Windows commit limit.

The final 2026-08-11 build completed `testDebugUnitTest`, `assembleDebug`, and `lintDebug` successfully. All 14 unit tests passed. The sideloadable APK is also copied to `../artifacts/akari-pulse-android-debug-0.1.0.apk`:

```text
size:                31,164,014 bytes
APK SHA-256:         D5F43C1D2F0468DF7CF71594320DE9E9748DB2410D480361E825A3ACC570C6D5
package/version:     dev.akari.pulse.bridge / 1 / 0.1.0
signing scheme:      v2, one signer
certificate SHA-256: d856396dcd991afdda0045df334b5845ee633eacb03787a2d6d908709ef13a44
```

Verify and install:

```powershell
$apk = '.\app\build\outputs\apk\debug\app-debug.apk'
$apksigner = Join-Path $env:ANDROID_HOME 'build-tools\36.1.0\apksigner.bat'

& $apksigner verify --verbose --print-certs $apk
& 'D:\platform-tools\adb.exe' install -r $apk
```

The debug APK uses the local Android debug key. No signing private key is included or copied into this module. The watch RPC configuration must use the package `dev.akari.pulse.bridge` and the SHA-256 certificate fingerprint printed from the exact APK installed on the phone. A release build will have a different fingerprint.

The final 2026-08-14 phone-reader implementation completed 21 unit tests, `assembleDebug`, and `lintDebug`. The installed debug APK was 30,931,114 bytes with SHA-256 `6B4D9C04A2C7B13C9022B2527D224C475FE8DD19E93873FBCA81D06F5E123FC1`; it cold-started successfully on the vivo phone and produced a real nonzero `PASS` result matching the vivo Health UI. This hash is an execution record for the local debug-signed artifact, not a published release promise.

## remaining real-device gates

- The APK and phone-local today-activity reader were installed and verified on the vivo phone on 2026-08-14. Notification permission, foreground-service survival, and Funtouch OS background behavior for the fallback watch receiver remain separate unverified gates.
- No `VIVO_RPC_APP_ID` or `encryStr` is committed; official initialization cannot pass without the issued credentials and matching signing registration.
- `getHealthDeviceVersion() >= 2`, health-app permission status, BlueXlink connection, package/fingerprint pairing, request/response ACK, and session notification delivery must all be captured on the physical phone/watch pair.
- `WA2456C` support is explicitly unverified. Unsupported runtime/device behavior must remain `UNSUPPORTED` or `API_MISSING`, never a mock success.
