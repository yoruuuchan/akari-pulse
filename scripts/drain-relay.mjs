// Drain the Cloudflare relay buffer into the local Akari Health service.
// Pulls pending watch-event or phone daily-summary batches from the relay, re-POSTs
// each unchanged payload to its recorded local route, and deletes a relay row only
// after the local service acknowledged that exact batch. Run it manually or from a
// scheduled task.
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
  const targetPath = batch.target_path || "/v1/health/batches";
  if (!["/v1/health/batches", "/v1/health/daily-summaries"].includes(targetPath)) {
    throw new Error(`relay returned unsupported target path for ${batch.batch_id}: ${targetPath}`);
  }
  const isDailySummary = targetPath === "/v1/health/daily-summaries";
  const itemCount = isDailySummary ? batch.payload.summaries?.length : batch.payload.events?.length;
  if (!Number.isInteger(itemCount) || itemCount < 1) {
    throw new Error(`relay returned an invalid payload for ${batch.batch_id}`);
  }
  const headers = { "content-type": "application/json" };
  if (healthToken) headers.authorization = `Bearer ${healthToken}`;
  const response = await fetch(`${healthUrl}${targetPath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(batch.payload),
  });
  const body = await readJson(response);
  const data = body && body.data;
  const accepted = data && data.accepted;
  const duplicates = data && data.duplicates;
  const stale = isDailySummary ? data && data.stale : 0;
  const countsValid =
    Number.isInteger(accepted) && accepted >= 0 &&
    Number.isInteger(duplicates) && duplicates >= 0 &&
    Number.isInteger(stale) && stale >= 0;
  if (
    !response.ok ||
    body.ok !== true ||
    !data ||
    data.batch_id !== batch.payload.batch_id ||
    !countsValid ||
    accepted + duplicates + stale !== itemCount
  ) {
    throw new Error(
      `local ingest not acknowledged for ${batch.payload.batch_id} (${response.status}): ${JSON.stringify(body.error || body).slice(0, 300)}`
    );
  }
  return { accepted, duplicates, stale, replayed: Boolean(data.replayed), targetPath, itemCount };
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
let totalItems = 0;

for (;;) {
  const pending = await fetchPending();
  if (pending.length === 0) break;

  const drainedRowIds = [];
  for (const batch of pending) {
    const ack = await ingestLocally(batch);
    drainedRowIds.push(batch.row_id);
    totalBatches += 1;
    totalItems += ack.itemCount;
    console.log(
      `ingested ${batch.payload.batch_id}: target=${ack.targetPath} items=${ack.itemCount} accepted=${ack.accepted} duplicates=${ack.duplicates} stale=${ack.stale}${ack.replayed ? " (replayed)" : ""}`
    );
  }
  const deleted = await confirmDrained(drainedRowIds);
  console.log(`relay rows deleted: ${deleted}`);
  if (pending.length < 50) break;
}

console.log(`drain complete: ${totalBatches} batch(es), ${totalItems} item(s)`);
