// Drain the Cloudflare relay buffer into the local Akari Health service.
// Pulls pending watch batches from the relay, re-POSTs each unchanged payload to the
// local /v1/health/batches route, and deletes a relay row only after the local service
// acknowledged that exact batch. Run it manually or from a scheduled task.
//
// Environment:
//   AKARI_RELAY_URL          default https://pulse.example.com
//   AKARI_RELAY_ADMIN_TOKEN  required (relay /v1/relay/* bearer token)
//   AKARI_HEALTH_URL         default http://127.0.0.1:8787
//   AKARI_HEALTH_TOKEN       optional local service bearer token

const relayUrl = (process.env.AKARI_RELAY_URL || "https://pulse.example.com").replace(/\/+$/, "");
const relayAdminToken = process.env.AKARI_RELAY_ADMIN_TOKEN || "";
const healthUrl = (process.env.AKARI_HEALTH_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const healthToken = process.env.AKARI_HEALTH_TOKEN || "";

if (!relayAdminToken) {
  console.error("AKARI_RELAY_ADMIN_TOKEN is required (see relay/.secrets.local)");
  process.exit(1);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (${response.status}): ${text.slice(0, 200)}`);
  }
}

async function fetchPending() {
  const response = await fetch(`${relayUrl}/v1/relay/pending?limit=50`, {
    headers: { authorization: `Bearer ${relayAdminToken}` },
  });
  const body = await readJson(response);
  if (!response.ok || body.ok !== true) {
    throw new Error(`relay pending failed (${response.status}): ${JSON.stringify(body.error || body)}`);
  }
  return body.data.batches;
}

async function ingestLocally(batch) {
  const headers = { "content-type": "application/json" };
  if (healthToken) headers.authorization = `Bearer ${healthToken}`;
  const response = await fetch(`${healthUrl}/v1/health/batches`, {
    method: "POST",
    headers,
    body: JSON.stringify(batch.payload),
  });
  const body = await readJson(response);
  const data = body && body.data;
  const accepted = data && data.accepted;
  const duplicates = data && data.duplicates;
  const countsValid =
    Number.isInteger(accepted) && accepted >= 0 && Number.isInteger(duplicates) && duplicates >= 0;
  if (
    !response.ok ||
    body.ok !== true ||
    !data ||
    data.batch_id !== batch.payload.batch_id ||
    !countsValid ||
    accepted + duplicates !== batch.payload.events.length
  ) {
    throw new Error(
      `local ingest not acknowledged for ${batch.payload.batch_id} (${response.status}): ${JSON.stringify(body.error || body).slice(0, 300)}`
    );
  }
  return { accepted, duplicates, replayed: Boolean(data.replayed) };
}

async function confirmDrained(rowIds) {
  const response = await fetch(`${relayUrl}/v1/relay/drained`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${relayAdminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ row_ids: rowIds }),
  });
  const body = await readJson(response);
  if (!response.ok || body.ok !== true) {
    throw new Error(`relay drained confirmation failed (${response.status}): ${JSON.stringify(body.error || body)}`);
  }
  return body.data.deleted;
}

let totalBatches = 0;
let totalEvents = 0;

for (;;) {
  const pending = await fetchPending();
  if (pending.length === 0) break;

  const drainedRowIds = [];
  for (const batch of pending) {
    const ack = await ingestLocally(batch);
    drainedRowIds.push(batch.row_id);
    totalBatches += 1;
    totalEvents += batch.payload.events.length;
    console.log(
      `ingested ${batch.payload.batch_id}: events=${batch.payload.events.length} accepted=${ack.accepted} duplicates=${ack.duplicates}${ack.replayed ? " (replayed)" : ""}`
    );
  }
  const deleted = await confirmDrained(drainedRowIds);
  console.log(`relay rows deleted: ${deleted}`);
  if (pending.length < 50) break;
}

console.log(`drain complete: ${totalBatches} batch(es), ${totalEvents} event(s)`);
