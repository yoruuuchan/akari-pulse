# Privacy

Akari Pulse is designed for self-hosted personal health data. The intended operator is the person who owns the phone/watch and the infrastructure receiving the data.

## Data flow

A normal deployment keeps health data inside infrastructure controlled by the operator:

```text
owned vivo phone/watch
  -> owned Android / watch bridge
  -> operator-controlled relay or private network
  -> operator-controlled Akari Health service + SQLite
  -> operator-controlled MCP endpoint
  -> the AI client chosen by the operator
```

This repository does not provide a shared Akari Pulse cloud, telemetry service, analytics endpoint, or central health-data database.

## Health data

Depending on the device capability and enabled sources, records can contain health and activity information such as heart rate, blood oxygen, stress, steps, distance, calories, timestamps, daily summaries, and diagnostic status. Treat these records as sensitive personal data.

Enabling the vivo private sleep provider adds a full night's stage timeline — when you fell asleep, when you woke, and every light/deep/REM/awake interval in between. That is a detailed record of when you are home and unconscious, so treat it as more sensitive than a daily step count, not less.

Akari Pulse preserves source semantics rather than silently merging data from different devices. Missing data stays explicit (`NO_DATA`, `DENIED`, `UNSUPPORTED`, `API_MISSING`, or `ERROR`) and is never replaced with cached or invented values.

## Secrets

Do not commit or publish:

- relay, backend, MCP, or bearer tokens;
- vivo developer credentials or signing keys;
- Android Keystore exports or encrypted secret backups;
- VPS `.env` files, database backups, or Cloudflare secret files;
- unredacted device logs containing account identifiers, serial numbers, MAC addresses, cookies, or private URLs.

The repository intentionally ignores common secret and build-output paths. Runtime secrets should stay in environment variables, Cloudflare secrets, Android Keystore-backed storage, or another operator-controlled secret store.

## Public bug reports and verification evidence

Do not attach raw health databases, complete logcat dumps, screenshots containing health values, or real daily summaries to public issues.

When reporting a compatibility result, prefer a redacted capability statement such as:

- device model and firmware;
- data source / API / provider used;
- `PASS`, `NO_DATA`, or the exact error class/code;
- whether the value matched the device UI;
- whether the test required ADB or another owner-controlled setup step.

Synthetic fixtures are preferred for automated tests. Real-device verification can state that a nonzero value matched the UI without publishing the value itself.

## ADB and device permissions

Some vivo firmware may expose owner-controlled diagnostic or provider access only after an explicit ADB setup step. Such behavior is device- and firmware-specific. Do not assume it works on another phone, and do not package privileged permission changes as a silent fallback. If a required permission is absent, report that state explicitly.

## Third-party AI clients

Akari Pulse can expose data through MCP, but the privacy behavior of the AI client is outside this repository. Configure the MCP endpoint only in clients and accounts you intend to trust with the returned health data.
