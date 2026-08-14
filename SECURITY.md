# Security

Akari Pulse handles health data and authentication material. Treat a deployment as private infrastructure, not as a public demo service.

## Supported security model

- Prefer loopback, Tailscale, Cloudflare Tunnel, or another authenticated private path for the backend and MCP.
- Any listener bound beyond loopback must require a strong bearer/token credential.
- Watch ingest, phone ingest, relay administration, backend access, and MCP access should use separate credentials where the architecture supports it.
- Do not commit live credentials. Use environment variables, Cloudflare secrets, Android Keystore-backed storage, or another operator-controlled secret store.
- Do not use a successful build, transport callback, cached value, or fallback value as proof that a health record was collected.

## Credentials in this architecture

| Credential | Lives in | Notes |
|---|---|---|
| Relay `INGEST_TOKEN` (watch) | Cloudflare secret + compiled into the watch RPK | Rotating it requires a watch rebuild. **A built RPK carries this token — never publish one.** |
| Relay `PHONE_INGEST_TOKEN` | Cloudflare secret + Android Keystore | Keep separate from the watch token. |
| Relay `ADMIN_TOKEN` | Cloudflare secret + the drain host's `.env` | Only the single drain client should hold it. |
| `AKARI_HEALTH_TOKEN` | backend and MCP process environment | Never reaches an external caller. |
| Remote MCP path (`AKARI_MCP_HTTP_PATH`) | backend `.env` + the AI client's connector config | **Treat the full MCP URL as a password.** |

The remote MCP URL deserves emphasis: connector UIs cannot send custom auth headers without
OAuth, so the unguessable TLS-protected path *is* the authentication. Anyone who obtains
that URL can read your health data. Do not paste it into issues, screenshots, chat logs, or
support requests, and rotate it if it is ever exposed.

Never publish the SQLite database, a database backup, a relay D1 export, or an unredacted
application/device log. Any of those contains raw health records regardless of how the
endpoints are protected.

## Device permissions

Owner-controlled ADB setup may be used on firmware where the operator has explicitly chosen that route. Permission state must be observable and diagnosable. A missing permission must fail explicitly rather than silently falling back to stale data.

Understand what the bootstrap in `scripts/bootstrap-vivo-private-health.ps1` actually does
before running it:

- it grants **one** permission, `com.vivo.health.widget.permission`, to **one** package;
- that permission lets Akari Pulse read your sleep record and your latest heart rate, SpO2,
  and stress from vivo's private providers — read-only;
- it does not modify vivo Health, its database, or any system component, and it grants
  nothing to any other app;
- it is reversible with `-Revoke`, and the revocation is verified the same way the grant is;
- enabling USB debugging to run it is itself a security-relevant state. Turn it back off
  afterwards if you do not otherwise need it, and do not authorize an untrusted computer.

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
