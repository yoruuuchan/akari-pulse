// These values are compiled into the built RPK. Set your own relay domain and
// ingest token BEFORE building — the compiled package will happily POST to
// whatever is here. Rotate by regenerating the token, `wrangler secret put`
// INGEST_TOKEN on your relay, and rebuilding the watch package.
const config = {
  sourceDevice: 'WA2456C',
  producer: 'akari-pulse-blueos-watch',
  transport: {
    // 'http' targets the Cloudflare relay after BlueXlink failed on WA2456C with
    // onError code=1001 "interconnectfeature error" (see docs/RESEARCH.md).
    adapter: 'http',
    http: {
      endpoint: 'https://pulse.example.com/v1/health/batches',
      bridgeToken: 'REPLACE_WITH_YOUR_INGEST_TOKEN',
      timeoutMs: 10000,
      batchSize: 100,
    },
    rpc: {
      messageType: 'akari.health.batch.v1',
      phonePackage: 'dev.akari.pulse.bridge',
      phoneSha256: 'd856396dcd991afdda0045df334b5845ee633eacb03787a2d6d908709ef13a44',
      ackTimeoutMs: 10000,
    },
  },
  netProbe: {
    // Third-party plain-HTTP 204 endpoint: distinguishes "no internet path at all"
    // from "relay endpoint unreachable". Returns 204 with an empty body.
    controlUrl: 'http://connect.rom.miui.com/generate_204',
    relayHealthzHttps: 'https://pulse.example.com/healthz',
    relayHealthzHttp: 'http://pulse.example.com/healthz',
    timeoutMs: 10000,
  },
}

export default config
