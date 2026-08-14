# Contributing

Akari Pulse welcomes compatibility fixes, new device evidence, documentation improvements, and narrowly scoped transport or MCP changes.

## Never post real health data

**Do not attach your own health records to an issue or a PR.** Not as a screenshot, not as
a logcat dump, not as a database or D1 export, not as a "here is what my night looked like"
paste. This applies to your data and to anyone else's.

That rule does not weaken your bug report, because the value itself is never the evidence.
What a maintainer needs is:

| Instead of | Report |
|---|---|
| your sleep record | model + firmware, provider, the status returned, whether it matched the vivo UI |
| a screenshot with numbers on it | the same screenshot with the values covered, or just the field names |
| a real cursor/payload dump | a **synthetic fixture** with the same structure and invented numbers |
| "my heart rate read 6X" | "a real nonzero heart rate was returned and matched the UI" |

Automated tests must use synthetic fixtures only. Every reader test in this repository
already works that way — structurally identical cursors and payloads with invented values —
so there is a working pattern to copy.

If you have already posted real data, edit or delete the comment and say so; GitHub keeps
edit history, so an early fix matters.

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

Redact endpoints too, not only health values. A private relay hostname or a remote MCP URL
is a live credential; see [SECURITY.md](SECURITY.md).

## License

Akari Pulse is licensed under [AGPL-3.0](LICENSE). By contributing, you agree that your
contribution is licensed under the same terms.
