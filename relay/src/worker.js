// Akari Pulse relay: public HTTPS ingest for the watch, private drain for the local service.
// The watch POSTs the exact watch-batch contract here; the local drain client pulls stored
// batches and re-POSTs them unchanged into the local Akari Health service, then confirms.
// Rows are deleted only after that confirmation, so the relay never drops an unacknowledged batch.

const HEALTH_STATUSES = new Set(["PASS", "NO_DATA", "DENIED", "UNSUPPORTED", "API_MISSING", "ERROR"]);

const EVENT_KEYS = new Set([
  "event_id",
  "timestamp",
  "sample_timestamp",
  "metric",
  "value",
  "unit",
  "source_device",
  "source_module",
  "source_api",
  "quality",
  "status",
  "session_id",
  "callback_delta_ms",
  "raw_error_code",
  "raw_error_message",
]);

const MAX_BODY_BYTES = 1_048_576;

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectString(value, path, { min = 1, max = 128, pattern } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} must be a string between ${min} and ${max} characters`);
  }
  if (pattern && !pattern.test(value)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} has an invalid format`);
  }
  return value;
}

function expectEpoch(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} must be a non-negative Unix epoch millisecond integer`);
  }
  return value;
}

function assertJsonValue(value, path, depth = 0) {
  if (depth > 12) throw new HttpError(400, "INVALID_REQUEST", `${path} is nested too deeply`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpError(400, "INVALID_REQUEST", `${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${path}.${key}`, depth + 1);
    return;
  }
  throw new HttpError(400, "INVALID_REQUEST", `${path} must be valid JSON data`);
}

function validateEvent(input, path) {
  if (!isPlainObject(input)) throw new HttpError(400, "INVALID_REQUEST", `${path} must be an object`);
  const unknown = Object.keys(input).filter((key) => !EVENT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} contains unknown fields: ${unknown.sort().join(", ")}`);
  }
  expectString(input.event_id, `${path}.event_id`);
  expectEpoch(input.timestamp, `${path}.timestamp`);
  if (input.sample_timestamp !== undefined && input.sample_timestamp !== null) {
    expectEpoch(input.sample_timestamp, `${path}.sample_timestamp`);
  }
  expectString(input.metric, `${path}.metric`, { max: 64, pattern: /^[a-z][a-z0-9_]{0,63}$/ });
  expectString(input.source_device, `${path}.source_device`);
  const status = expectString(input.status, `${path}.status`, { max: 32 });
  if (!HEALTH_STATUSES.has(status)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.status is not a supported diagnostic status`);
  }
  const hasValue = Object.hasOwn(input, "value");
  if (status === "PASS" && !hasValue) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.value is required when status is PASS`);
  }
  if (hasValue) {
    if (input.value === null) throw new HttpError(400, "INVALID_REQUEST", `${path}.value must not be null`);
    assertJsonValue(input.value, `${path}.value`);
  }
}

function validateBatch(input) {
  if (!isPlainObject(input)) throw new HttpError(400, "INVALID_REQUEST", "body must be an object");
  const allowed = new Set(["batch_id", "producer", "sent_at", "events"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", `body contains unknown fields: ${unknown.sort().join(", ")}`);
  }
  expectString(input.batch_id, "body.batch_id");
  expectString(input.producer, "body.producer");
  if (input.sent_at !== undefined && input.sent_at !== null) expectEpoch(input.sent_at, "body.sent_at");
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 500) {
    throw new HttpError(400, "INVALID_REQUEST", "body.events must contain between 1 and 500 events");
  }
  input.events.forEach((event, index) => validateEvent(event, `body.events[${index}]`));
  return input;
}

function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}

function failure(statusCode, code, message, now) {
  return json(statusCode, {
    ok: false,
    status: "ERROR",
    generated_at: now,
    error: { code, message },
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "BODY_TOO_LARGE", "request body exceeds 1 MiB");
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    throw new HttpError(400, "INVALID_JSON", "request body is not valid JSON");
  }
}

async function handleIngest(request, env, now) {
  const token = request.headers.get("x-akari-bridge-token") || "";
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
    return failure(401, "UNAUTHORIZED", "a valid X-Akari-Bridge-Token is required", now);
  }
  const { raw, parsed } = await readBody(request);
  const batch = validateBatch(parsed);
  const payloadHash = await sha256Hex(raw);

  const existing = await env.DB.prepare(
    "SELECT payload_hash, received_at FROM relay_batches WHERE batch_id = ?"
  ).bind(batch.batch_id).first();

  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      return failure(
        409,
        "BATCH_ID_CONFLICT",
        "batch_id was already stored with different content; refusing both interpretations",
        now
      );
    }
    return json(200, {
      ok: true,
      status: "PASS",
      generated_at: now,
      data: {
        batch_id: batch.batch_id,
        accepted: batch.events.length,
        duplicates: 0,
        received_at: existing.received_at,
        replayed: true,
      },
    });
  }

  await env.DB.prepare(
    "INSERT INTO relay_batches (batch_id, producer, sent_at, received_at, payload_hash, payload) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(batch.batch_id, batch.producer, batch.sent_at ?? null, now, payloadHash, raw).run();

  return json(202, {
    ok: true,
    status: "PASS",
    generated_at: now,
    data: {
      batch_id: batch.batch_id,
      accepted: batch.events.length,
      duplicates: 0,
      received_at: now,
      replayed: false,
    },
  });
}

async function handlePending(request, env, url, now) {
  const rawLimit = url.searchParams.get("limit") || "50";
  if (!/^\d+$/.test(rawLimit)) return failure(400, "INVALID_QUERY", "limit must be an integer", now);
  const limit = Math.min(Math.max(Number(rawLimit), 1), 200);
  const rows = await env.DB.prepare(
    "SELECT row_id, batch_id, producer, sent_at, received_at, payload FROM relay_batches ORDER BY row_id ASC LIMIT ?"
  ).bind(limit).all();
  const batches = (rows.results || []).map((row) => ({
    row_id: row.row_id,
    batch_id: row.batch_id,
    producer: row.producer,
    sent_at: row.sent_at,
    received_at: row.received_at,
    payload: JSON.parse(row.payload),
  }));
  return json(200, {
    ok: true,
    status: batches.length > 0 ? "PASS" : "NO_DATA",
    generated_at: now,
    data: { batches },
  });
}

async function handleDrained(request, env, now) {
  const { parsed } = await readBody(request);
  if (!isPlainObject(parsed) || !Array.isArray(parsed.row_ids) || parsed.row_ids.length < 1 || parsed.row_ids.length > 200) {
    return failure(400, "INVALID_REQUEST", "body.row_ids must contain between 1 and 200 integers", now);
  }
  if (!parsed.row_ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    return failure(400, "INVALID_REQUEST", "body.row_ids must contain positive integers", now);
  }
  const placeholders = parsed.row_ids.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `DELETE FROM relay_batches WHERE row_id IN (${placeholders})`
  ).bind(...parsed.row_ids).run();
  return json(200, {
    ok: true,
    status: "PASS",
    generated_at: now,
    data: { deleted: result.meta.changes },
  });
}

async function handleStatus(env, now) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS pending, MIN(received_at) AS oldest, MAX(received_at) AS newest FROM relay_batches"
  ).first();
  return json(200, {
    ok: true,
    status: "PASS",
    generated_at: now,
    data: {
      pending_batches: row.pending,
      oldest_received_at: row.oldest,
      newest_received_at: row.newest,
    },
  });
}

export default {
  async fetch(request, env) {
    const now = Date.now();
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(200, { ok: true, service: "akari-pulse-relay", status: "PASS", generated_at: now });
      }
      if (request.method === "POST" && url.pathname === "/v1/health/batches") {
        return await handleIngest(request, env, now);
      }
      if (url.pathname.startsWith("/v1/relay/")) {
        if (!env.ADMIN_TOKEN || bearerToken(request) !== env.ADMIN_TOKEN) {
          return failure(401, "UNAUTHORIZED", "a valid bearer token is required", now);
        }
        if (request.method === "GET" && url.pathname === "/v1/relay/pending") {
          return await handlePending(request, env, url, now);
        }
        if (request.method === "POST" && url.pathname === "/v1/relay/drained") {
          return await handleDrained(request, env, now);
        }
        if (request.method === "GET" && url.pathname === "/v1/relay/status") {
          return await handleStatus(env, now);
        }
      }
      return failure(404, "NOT_FOUND", "route is not supported", now);
    } catch (error) {
      if (error instanceof HttpError) return failure(error.statusCode, error.code, error.message, now);
      return failure(500, "INTERNAL", "unexpected relay error", now);
    }
  },
};
