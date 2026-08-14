# Tokyo VPS deployment (your-vps)

Since 2026-08-12 the always-on store of record runs on the AWS Lightsail Tokyo box
(`ssh your-vps`), so claude.ai / ChatGPT can query health data with the PC off:

```text
watch → https://pulse.example.com (operator-owned relay buffer, Cloudflare)
      → your-vps systemd timer drains every 2 min
      → Akari Health service (127.0.0.1:28787, /home/ubuntu/akari-pulse/data/akari-health.sqlite)
      → MCP over Streamable HTTP (127.0.0.1:28788)
      → Cloudflare Tunnel "your-tunnel-name" → https://pulse-mcp.example.com/mcp/<secret>
```

**Single-drainer rule: the VPS timer is the only drain client.** Running
`scripts/drain-relay.mjs` anywhere else (e.g. the Windows PC) would steal batches into a
different database and split the record. The PC's local service remains for development
only; the two events drained there on 2026-08-12 were re-uploaded to the VPS store
(`accepted=2`) before the timer took over.

## Layout on the box

- `/home/ubuntu/akari-pulse/` — `server/`, `mcp/` (deps installed with Node 24), `contracts/`, `scripts/drain-relay.mjs`, `data/`, `.env` (chmod 600, all secrets)
- `/opt/node24/` — isolated Node 24.14.0; the system Node stays v22 for unrelated services
- Ports: service `127.0.0.1:28787`, MCP HTTP `127.0.0.1:28788` (8787 was already taken by another service on this box; nothing binds publicly — only the tunnel reaches loopback)

## systemd units (this directory, installed to /etc/systemd/system)

| Unit | Role |
|---|---|
| `akari-health.service` | Node 24 store-of-record service |
| `akari-mcp-http.service` | remote MCP entry `mcp/src/http.js` |
| `akari-drain.service` + `akari-drain.timer` | relay drain every 2 min |
| `akari-tunnel.service` | `cloudflared tunnel run --token` (remotely-managed tunnel `your-tunnel-name`, id `REPLACE_WITH_YOUR_TUNNEL_ID`); independent of any other pre-existing `cloudflared-*.service` on the box, which should not be touched |

Manage with `sudo systemctl status|restart akari-health akari-mcp-http akari-tunnel akari-drain.timer`; drain logs via `journalctl -u akari-drain.service -n 50`.

## Secrets and rotation

All runtime secrets live in `/home/ubuntu/akari-pulse/.env` on the box and in the
untracked `relay/.secrets.local` locally; `env.template` documents the shape. Rotating:

- relay ingest/admin tokens: `relay/README.md` (Cloudflare secret + watch rebuild for ingest);
- VPS `AKARI_HEALTH_TOKEN`: edit `.env`, restart `akari-health`, `akari-mcp-http` (MCP reads it as its service credential) — external callers never see this token;
- MCP connector secret: change `AKARI_MCP_HTTP_PATH` in `.env`, restart `akari-mcp-http`, update the connector URL in claude.ai/ChatGPT;
- tunnel token: reissue via the Cloudflare API (`GET /accounts/{acct}/cfd_tunnel/{id}/token`), update `.env`, restart `akari-tunnel`.

## Connect an AI client

Add a custom connector (claude.ai: Settings → Connectors → Add custom connector;
ChatGPT: developer-mode connectors) with the remote MCP URL:

```text
https://pulse-mcp.example.com/mcp/<AKARI_MCP_HTTP_PATH token>
```

The full URL is the credential (TLS-protected, unguessable path; connector UIs cannot
send custom auth headers without OAuth). Treat it like a password; rotate as above.
Verified 2026-08-12 with the official `StreamableHTTPClientTransport`: 14 tools listed,
physical-watch records returned over the public path.
