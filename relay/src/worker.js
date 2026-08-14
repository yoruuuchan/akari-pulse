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

const DAILY_SUMMARY_KEYS = new Set([
  "source",
  "metric",
  "source_day",
  "source_timezone",
  "value",
  "unit",
  "sampled_at",
  "source_timestamp_available",
  "status",
  "outcome",
  "verification",
  "raw_error_code",
  "raw_error_message",
]);

const PHONE_DAILY_METRICS = new Map([
  ["phone_step_count", "count"],
  ["phone_distance", "m"],
  ["phone_calories", "kcal"],
]);
const PHONE_DAILY_STATUSES = new Set(["PASS", "NO_DATA", "ERROR"]);
const PHONE_DAILY_OUTCOMES_BY_STATUS = new Map([
  ["PASS", new Set(["PROVIDER_CALL_SUCCEEDED"])],
  ["NO_DATA", new Set(["PROVIDER_NO_DATA"])],
  ["ERROR", new Set(["PROVIDER_CALL_FAILED", "PARSE_FAILED"])],
]);
const PHONE_DAILY_VERIFICATIONS = new Set([
  "VERIFIED",
  "VERIFIED_FORMATTED_DISPLAY",
  "UNVERIFIED",
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

function expectSourceDay(value, path) {
  expectString(value, path, { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} must be a valid calendar date`);
  }
  return value;
}

function expectSourceTimezone(value, path) {
  expectString(value, path, { max: 64 });
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
  } catch {
    throw new HttpError(400, "INVALID_REQUEST", `${path} must be an IANA timezone`);
  }
  return value;
}

function expectSampledAt(value, path) {
  expectString(value, path, { max: 64 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} must be ISO-8601 with an explicit offset`);
  }
  if (!Number.isSafeInteger(Date.parse(value)) || Date.parse(value) < 0) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} must be a valid timestamp`);
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

function validateDailySummary(input, path) {
  if (!isPlainObject(input)) throw new HttpError(400, "INVALID_REQUEST", `${path} must be an object`);
  const unknown = Object.keys(input).filter((key) => !DAILY_SUMMARY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} contains unknown fields: ${unknown.sort().join(", ")}`);
  }
  if (input.source !== "vivo_phone") {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.source must be vivo_phone`);
  }
  const metric = expectString(input.metric, `${path}.metric`, { max: 64 });
  const expectedUnit = PHONE_DAILY_METRICS.get(metric);
  if (!expectedUnit) throw new HttpError(400, "INVALID_REQUEST", `${path}.metric is not supported`);
  if (input.unit !== expectedUnit) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.unit must be ${expectedUnit} for ${metric}`);
  }
  expectSourceDay(input.source_day, `${path}.source_day`);
  expectSourceTimezone(input.source_timezone, `${path}.source_timezone`);
  expectSampledAt(input.sampled_at, `${path}.sampled_at`);
  if (input.source_timestamp_available !== false) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.source_timestamp_available must be false`);
  }
  if (!PHONE_DAILY_STATUSES.has(input.status)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.status is not supported`);
  }
  if (!PHONE_DAILY_OUTCOMES_BY_STATUS.get(input.status).has(input.outcome)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.outcome does not match status ${input.status}`);
  }
  if (!PHONE_DAILY_VERIFICATIONS.has(input.verification)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.verification is not supported`);
  }
  const hasValue = Object.hasOwn(input, "value");
  if (input.status === "PASS") {
    if (!hasValue || typeof input.value !== "number" || !Number.isFinite(input.value) || input.value < 0) {
      throw new HttpError(400, "INVALID_REQUEST", `${path}.value must be a non-negative number when status is PASS`);
    }
    if (metric === "phone_step_count" && !Number.isSafeInteger(input.value)) {
      throw new HttpError(400, "INVALID_REQUEST", `${path}.value must be an integer for phone_step_count`);
    }
  } else if (hasValue) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.value must be absent unless status is PASS`);
  }
  if (input.raw_error_code !== undefined && input.raw_error_code !== null) {
    expectString(input.raw_error_code, `${path}.raw_error_code`, { max: 128 });
  }
  if (input.raw_error_message !== undefined && input.raw_error_message !== null) {
    expectString(input.raw_error_message, `${path}.raw_error_message`, { max: 2048 });
  }
}

function validateDailySummaryBatch(input) {
  if (!isPlainObject(input)) throw new HttpError(400, "INVALID_REQUEST", "body must be an object");
  const allowed = new Set(["batch_id", "producer", "sent_at", "summaries"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", `body contains unknown fields: ${unknown.sort().join(", ")}`);
  }
  expectString(input.batch_id, "body.batch_id");
  expectString(input.producer, "body.producer");
  if (input.sent_at !== undefined && input.sent_at !== null) expectEpoch(input.sent_at, "body.sent_at");
  if (!Array.isArray(input.summaries) || input.summaries.length < 1 || input.summaries.length > 50) {
    throw new HttpError(400, "INVALID_REQUEST", "body.summaries must contain between 1 and 50 summaries");
  }
  input.summaries.forEach((summary, index) => validateDailySummary(summary, `body.summaries[${index}]`));
  const keys = input.summaries.map((summary) => `${summary.source}\u0000${summary.metric}\u0000${summary.source_day}`);
  if (new Set(keys).size !== keys.length) {
    throw new HttpError(400, "INVALID_REQUEST", "body.summaries contains duplicate source/metric/source_day keys");
  }
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

async function handleIngest(request, env, now, { validate, targetPath, itemKey }) {
  const token = request.headers.get("x-akari-bridge-token") || "";
  const expectedToken = itemKey === "summaries" ? env.PHONE_INGEST_TOKEN : env.INGEST_TOKEN;
  if (!expectedToken || token !== expectedToken) {
    return failure(401, "UNAUTHORIZED", "a valid X-Akari-Bridge-Token is required", now);
  }
  const { raw, parsed } = await readBody(request);
  const batch = validate(parsed);
  const itemCount = batch[itemKey].length;
  const payloadHash = await sha256Hex(raw);

  const existing = await env.DB.prepare(
    "SELECT payload_hash, received_at, target_path FROM relay_batches WHERE batch_id = ?"
  ).bind(batch.batch_id).first();

  if (existing) {
    if (existing.payload_hash !== payloadHash || existing.target_path !== targetPath) {
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
        accepted: itemCount,
        duplicates: 0,
        ...(itemKey === "summaries" ? { stale: 0 } : {}),
        received_at: existing.received_at,
        replayed: true,
      },
    });
  }

  await env.DB.prepare(
    "INSERT INTO relay_batches (batch_id, producer, sent_at, received_at, payload_hash, payload, target_path) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(batch.batch_id, batch.producer, batch.sent_at ?? null, now, payloadHash, raw, targetPath).run();

  return json(202, {
    ok: true,
    status: "PASS",
    generated_at: now,
    data: {
      batch_id: batch.batch_id,
      accepted: itemCount,
      duplicates: 0,
      ...(itemKey === "summaries" ? { stale: 0 } : {}),
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
    "SELECT row_id, batch_id, producer, sent_at, received_at, payload, target_path FROM relay_batches ORDER BY row_id ASC LIMIT ?"
  ).bind(limit).all();
  const batches = (rows.results || []).map((row) => ({
    row_id: row.row_id,
    batch_id: row.batch_id,
    producer: row.producer,
    sent_at: row.sent_at,
    received_at: row.received_at,
    payload: JSON.parse(row.payload),
    target_path: row.target_path,
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
        return await handleIngest(request, env, now, {
          validate: validateBatch,
          targetPath: "/v1/health/batches",
          itemKey: "events",
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/health/daily-summaries") {
        return await handleIngest(request, env, now, {
          validate: validateDailySummaryBatch,
          targetPath: "/v1/health/daily-summaries",
          itemKey: "summaries",
        });
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
