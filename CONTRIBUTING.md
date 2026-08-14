# Contributing

Akari Pulse welcomes compatibility fixes, new device evidence, documentation improvements, and narrowly scoped transport or MCP changes.

## Before opening a PR

1. Keep real health values, tokens, private URLs, account identifiers, serial numbers, MAC addresses, cookies, and database dumps out of the repository.
2. Use synthetic fixtures in automated tests.
3. If a change depends on a physical vivo device, report the model, firmware, source/API/provider, exact status/error semantics, and whether the result matched the device UI. Redact the measured value itself.
4. Do not turn unsupported or missing data into a successful value. Preserve `PASS`, `NO_DATA`, `DENIED`, `UNSUPPORTED`, `API_MISSING`, and `ERROR` semantics.
5. Keep phone and watch sources distinct unless the contract explicitly defines a merge rule.
6. Do not add silent fallbacks for permission, network, provider, or device-capability failures.

## Reverse-engineering notes

Compatibility research should document interfaces, field semantics, observed permission behavior, and minimal reproducible evidence. Do not commit vivo APKs, proprietary binaries without redistribution rights, or large verbatim decompilations of third-party code.

## Validation

Run the checks relevant to the changed layer. At minimum, repository-wide Node tests should continue to pass:

```bash
npm test
```

Android changes should also run the documented Gradle unit/build/lint checks. A host-side build is only build evidence; do not mark a device capability `PASS` without real-device verification.

## Public issues

Before attaching screenshots or logs, read [PRIVACY.md](PRIVACY.md). For security-sensitive reports, use [SECURITY.md](SECURITY.md) instead of a public issue.
