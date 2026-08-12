const HEALTH_STATUSES = new Set([
  "PASS",
  "NO_DATA",
  "DENIED",
  "UNSUPPORTED",
  "API_MISSING",
  "ERROR",
]);

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

export class HttpError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectObject(value, path) {
  if (!isPlainObject(value)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} must be an object`);
  }
  return value;
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

function optionalString(value, path, max = 128) {
  if (value === undefined || value === null) return null;
  return expectString(value, path, { min: 0, max });
}

function expectEpoch(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} must be a non-negative Unix epoch millisecond integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value, path) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} must be a non-negative integer`);
  }
  return value;
}

function assertJsonValue(value, path, depth = 0) {
  if (depth > 12) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} is nested too deeply`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new HttpError(400, "INVALID_REQUEST", `${path} contains a non-finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonValue(value[index], `${path}[${index}]`, depth + 1);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new HttpError(400, "INVALID_REQUEST", `${path} must be valid JSON data`);
}

export function parseHealthEvent(input, path = "event") {
  const value = expectObject(input, path);
  const unknown = Object.keys(value).filter((key) => !EVENT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} contains unknown fields`, { fields: unknown });
  }

  const status = expectString(value.status, `${path}.status`, { max: 32 });
  if (!HEALTH_STATUSES.has(status)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.status is not a supported diagnostic status`);
  }
  const hasValue = Object.hasOwn(value, "value");
  if (status === "PASS" && !hasValue) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.value is required when status is PASS`);
  }
  if (hasValue && value.value === null) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.value must not be null`);
  }
  if (hasValue) assertJsonValue(value.value, `${path}.value`);

  const rawErrorCode = value.raw_error_code;
  if (
    rawErrorCode !== undefined &&
    rawErrorCode !== null &&
    typeof rawErrorCode !== "string" &&
    (typeof rawErrorCode !== "number" || !Number.isFinite(rawErrorCode))
  ) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.raw_error_code must be a string, number, or null`);
  }

  return {
    event_id: expectString(value.event_id, `${path}.event_id`, { max: 128 }),
    timestamp: expectEpoch(value.timestamp, `${path}.timestamp`),
    sample_timestamp:
      value.sample_timestamp === undefined || value.sample_timestamp === null
        ? null
        : expectEpoch(value.sample_timestamp, `${path}.sample_timestamp`),
    metric: expectString(value.metric, `${path}.metric`, {
      max: 64,
      pattern: /^[a-z][a-z0-9_]{0,63}$/,
    }),
    has_value: hasValue,
    value: hasValue ? value.value : null,
    unit: optionalString(value.unit, `${path}.unit`, 32),
    source_device: expectString(value.source_device, `${path}.source_device`, { max: 128 }),
    source_module: optionalString(value.source_module, `${path}.source_module`, 128),
    source_api: optionalString(value.source_api, `${path}.source_api`, 128),
    quality: optionalString(value.quality, `${path}.quality`, 64),
    status,
    session_id: optionalString(value.session_id, `${path}.session_id`, 128),
    callback_delta_ms: optionalNonNegativeInteger(value.callback_delta_ms, `${path}.callback_delta_ms`),
    raw_error_code: rawErrorCode === undefined || rawErrorCode === null ? null : String(rawErrorCode),
    raw_error_message: optionalString(value.raw_error_message, `${path}.raw_error_message`, 2048),
  };
}

export function parseHealthBatch(input) {
  const value = expectObject(input, "body");
  const allowed = new Set(["batch_id", "producer", "sent_at", "events"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", "body contains unknown fields", { fields: unknown });
  }
  if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > 500) {
    throw new HttpError(400, "INVALID_REQUEST", "body.events must contain between 1 and 500 events");
  }
  return {
    batch_id: expectString(value.batch_id, "body.batch_id", { max: 128 }),
    producer: expectString(value.producer, "body.producer", { max: 128 }),
    sent_at: value.sent_at === undefined || value.sent_at === null ? null : expectEpoch(value.sent_at, "body.sent_at"),
    events: value.events.map((event, index) => parseHealthEvent(event, `body.events[${index}]`)),
  };
}

export function parseCorrelationEvent(input) {
  const value = expectObject(input, "body");
  const allowed = new Set(["event_id", "timestamp", "source", "event_type", "session_id", "metadata"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", "body contains unknown fields", { fields: unknown });
  }
  const metadata = value.metadata ?? {};
  assertJsonValue(metadata, "body.metadata");
  return {
    event_id: expectString(value.event_id, "body.event_id", { max: 128 }),
    timestamp: expectEpoch(value.timestamp, "body.timestamp"),
    source: expectString(value.source, "body.source", { max: 64 }),
    event_type: expectString(value.event_type, "body.event_type", {
      max: 64,
      pattern: /^[a-z][a-z0-9_.-]{0,63}$/,
    }),
    session_id: optionalString(value.session_id, "body.session_id", 128),
    metadata,
  };
}

export function parseSession(input) {
  const value = expectObject(input, "body");
  const allowed = new Set(["session_id", "source_device", "label", "started_at"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", "body contains unknown fields", { fields: unknown });
  }
  return {
    session_id:
      value.session_id === undefined
        ? null
        : expectString(value.session_id, "body.session_id", { max: 128 }),
    source_device: expectString(value.source_device, "body.source_device", { max: 128 }),
    label: optionalString(value.label, "body.label", 256),
    started_at: value.started_at === undefined ? Date.now() : expectEpoch(value.started_at, "body.started_at"),
  };
}

export function parseStopSession(input) {
  if (input === undefined || input === null) return { ended_at: Date.now() };
  const value = expectObject(input, "body");
  const unknown = Object.keys(value).filter((key) => key !== "ended_at");
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", "body contains unknown fields", { fields: unknown });
  }
  return {
    ended_at: value.ended_at === undefined ? Date.now() : expectEpoch(value.ended_at, "body.ended_at"),
  };
}

export function parseIntegerQuery(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, defaultValue = undefined } = {}) {
  if (value === null || value === undefined || value === "") return defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, "INVALID_QUERY", `${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, "INVALID_QUERY", `${name} is outside the supported range`);
  }
  return parsed;
}

export function parseMetricList(value) {
  if (!value) return [];
  const metrics = value.split(",").filter(Boolean);
  if (metrics.length > 32) {
    throw new HttpError(400, "INVALID_QUERY", "metrics supports at most 32 values");
  }
  return metrics.map((metric) =>
    expectString(metric, "metrics", { max: 64, pattern: /^[a-z][a-z0-9_]{0,63}$/ }),
  );
}

export { HEALTH_STATUSES };
