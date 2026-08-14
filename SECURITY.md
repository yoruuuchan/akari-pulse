# Security

Akari Pulse handles health data and authentication material. Treat a deployment as private infrastructure, not as a public demo service.

## Supported security model

- Prefer loopback, Tailscale, Cloudflare Tunnel, or another authenticated private path for the backend and MCP.
- Any listener bound beyond loopback must require a strong bearer/token credential.
- Watch ingest, phone ingest, relay administration, backend access, and MCP access should use separate credentials where the architecture supports it.
- Do not commit live credentials. Use environment variables, Cloudflare secrets, Android Keystore-backed storage, or another operator-controlled secret store.
- Do not use a successful build, transport callback, cached value, or fallback value as proof that a health record was collected.

## Device permissions

Owner-controlled ADB setup may be used on firmware where the operator has explicitly chosen that route. Permission state must be observable and diagnosable. A missing permission must fail explicitly rather than silently falling back to stale data.

Device/firmware behavior is not portable by default. A permission or provider path verified on one vivo model must remain `UNVERIFIED` on other models until tested.

## Vulnerability reports

Please use GitHub's private Security Advisory flow when possible. Do not open a public issue containing:

- working tokens or credentials;
- private endpoint URLs;
- raw health databases or backups;
- unredacted device/account identifiers;
- exploit details that would expose another person's deployment before a fix is available.

For ordinary compatibility bugs, redact health values and identifiers before posting.

## Scope

This project is a personal data bridge and research/reference implementation. It is not a medical device and must not be used as the sole source for medical diagnosis, emergency decisions, or clinical monitoring.
