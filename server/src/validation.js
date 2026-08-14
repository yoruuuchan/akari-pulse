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

export const PHONE_DAILY_METRICS = new Map([
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
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} must be a valid timestamp`);
  }
  return { text: value, epoch };
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

export function parsePhoneDailySummary(input, path = "summary") {
  const value = expectObject(input, path);
  const unknown = Object.keys(value).filter((key) => !DAILY_SUMMARY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} contains unknown fields`, { fields: unknown });
  }
  if (value.source !== "vivo_phone") {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.source must be vivo_phone`);
  }
  const metric = expectString(value.metric, `${path}.metric`, {
    max: 64,
    pattern: /^[a-z][a-z0-9_]{0,63}$/,
  });
  const expectedUnit = PHONE_DAILY_METRICS.get(metric);
  if (!expectedUnit) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.metric is not supported`);
  }
  if (value.unit !== expectedUnit) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.unit must be ${expectedUnit} for ${metric}`);
  }
  const status = expectString(value.status, `${path}.status`, { max: 32 });
  if (!PHONE_DAILY_STATUSES.has(status)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.status is not supported`);
  }
  const outcome = expectString(value.outcome, `${path}.outcome`, { max: 64 });
  if (!PHONE_DAILY_OUTCOMES_BY_STATUS.get(status).has(outcome)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.outcome does not match status ${status}`);
  }
  const verification = expectString(value.verification, `${path}.verification`, { max: 64 });
  if (!PHONE_DAILY_VERIFICATIONS.has(verification)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.verification is not supported`);
  }
  if (value.source_timestamp_available !== false) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.source_timestamp_available must be false`);
  }
  const hasValue = Object.hasOwn(value, "value");
  if (status === "PASS") {
    if (!hasValue || typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0) {
      throw new HttpError(400, "INVALID_REQUEST", `${path}.value must be a non-negative number when status is PASS`);
    }
    if (metric === "phone_step_count" && !Number.isSafeInteger(value.value)) {
      throw new HttpError(400, "INVALID_REQUEST", `${path}.value must be an integer for phone_step_count`);
    }
  } else if (hasValue) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.value must be absent unless status is PASS`);
  }
  const sampledAt = expectSampledAt(value.sampled_at, `${path}.sampled_at`);
  return {
    source: value.source,
    metric,
    source_day: expectSourceDay(value.source_day, `${path}.source_day`),
    source_timezone: expectSourceTimezone(value.source_timezone, `${path}.source_timezone`),
    has_value: hasValue,
    value: hasValue ? value.value : null,
    unit: value.unit,
    sampled_at: sampledAt.text,
    sampled_at_ms: sampledAt.epoch,
    source_timestamp_available: false,
    status,
    outcome,
    verification,
    raw_error_code: optionalString(value.raw_error_code, `${path}.raw_error_code`, 128),
    raw_error_message: optionalString(value.raw_error_message, `${path}.raw_error_message`, 2048),
  };
}

export function parsePhoneDailySummaryBatch(input) {
  const value = expectObject(input, "body");
  const allowed = new Set(["batch_id", "producer", "sent_at", "summaries"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", "body contains unknown fields", { fields: unknown });
  }
  if (!Array.isArray(value.summaries) || value.summaries.length < 1 || value.summaries.length > 50) {
    throw new HttpError(400, "INVALID_REQUEST", "body.summaries must contain between 1 and 50 summaries");
  }
  const summaries = value.summaries.map((summary, index) =>
    parsePhoneDailySummary(summary, `body.summaries[${index}]`),
  );
  const keys = summaries.map((summary) => `${summary.source}\u0000${summary.metric}\u0000${summary.source_day}`);
  if (new Set(keys).size !== keys.length) {
    throw new HttpError(400, "INVALID_REQUEST", "body.summaries contains duplicate source/metric/source_day keys");
  }
  return {
    batch_id: expectString(value.batch_id, "body.batch_id", { max: 128 }),
    producer: expectString(value.producer, "body.producer", { max: 128 }),
    sent_at: value.sent_at === undefined || value.sent_at === null ? null : expectEpoch(value.sent_at, "body.sent_at"),
    summaries,
  };
}

const SLEEP_SUMMARY_KEYS = new Set([
  "source",
  "source_day",
  "source_timezone",
  "source_day_start",
  "sleep_start",
  "sleep_end",
  "sampled_at",
  "status",
  "outcome",
  "verification",
  "recorder_generation",
  "low_accuracy",
  "score",
  "deep_sleep_continuity",
  "total_duration_ms",
  "night_sleep_duration_ms",
  "nap_duration_ms",
  "chart_total_duration_ms",
  "light_sleep_duration_ms",
  "deep_sleep_duration_ms",
  "rem_sleep_duration_ms",
  "awake_duration_ms",
  "awake_episode_count",
  "awake_episode_duration_ms",
  "stages",
]);

export const SLEEP_DURATION_KEYS = [
  "total_duration_ms",
  "night_sleep_duration_ms",
  "nap_duration_ms",
  "chart_total_duration_ms",
  "light_sleep_duration_ms",
  "deep_sleep_duration_ms",
  "rem_sleep_duration_ms",
  "awake_duration_ms",
  "awake_episode_duration_ms",
];

const SLEEP_COUNT_KEYS = ["score", "deep_sleep_continuity", "awake_episode_count"];
const SLEEP_STAGE_KEYS = new Set(["light", "deep", "rem", "awake"]);
const SLEEP_VERIFICATIONS = new Set(["VERIFIED", "UNVERIFIED"]);

function parseSleepStages(input, path) {
  const value = expectObject(input, path);
  const unknown = Object.keys(value).filter((key) => !SLEEP_STAGE_KEYS.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} contains unknown sleep stages`, { fields: unknown });
  }
  const stages = {};
  for (const [stage, intervals] of Object.entries(value)) {
    if (!Array.isArray(intervals) || intervals.length > 500) {
      throw new HttpError(400, "INVALID_REQUEST", `${path}.${stage} must be an array of at most 500 intervals`);
    }
    stages[stage] = intervals.map((interval, index) => {
      const entry = expectObject(interval, `${path}.${stage}[${index}]`);
      const unknownKeys = Object.keys(entry).filter((key) => key !== "start" && key !== "end");
      if (unknownKeys.length > 0) {
        throw new HttpError(400, "INVALID_REQUEST", `${path}.${stage}[${index}] contains unknown fields`, {
          fields: unknownKeys,
        });
      }
      const start = expectEpoch(entry.start, `${path}.${stage}[${index}].start`);
      const end = expectEpoch(entry.end, `${path}.${stage}[${index}].end`);
      if (end < start) {
        throw new HttpError(400, "INVALID_REQUEST", `${path}.${stage}[${index}].end is before start`);
      }
      return { start, end };
    });
  }
  return stages;
}

export function parseSleepSummary(input, path = "summary") {
  const value = expectObject(input, path);
  const unknown = Object.keys(value).filter((key) => !SLEEP_SUMMARY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", `${path} contains unknown fields`, { fields: unknown });
  }
  if (value.source !== "vivo_phone") {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.source must be vivo_phone`);
  }
  // Only observed sleep days are transmitted. Absence and failure travel on the
  // diagnostic_vivo_private_health event, so a placeholder row can never displace a real one.
  if (value.status !== "PASS") {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.status must be PASS`);
  }
  if (value.outcome !== "PROVIDER_CALL_SUCCEEDED") {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.outcome must be PROVIDER_CALL_SUCCEEDED`);
  }
  const verification = expectString(value.verification, `${path}.verification`, { max: 64 });
  if (!SLEEP_VERIFICATIONS.has(verification)) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.verification is not supported`);
  }
  const sleepStart = expectEpoch(value.sleep_start, `${path}.sleep_start`);
  const sleepEnd = expectEpoch(value.sleep_end, `${path}.sleep_end`);
  if (sleepStart === 0 || sleepEnd <= sleepStart) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.sleep_end must be after sleep_start`);
  }
  const sampledAt = expectSampledAt(value.sampled_at, `${path}.sampled_at`);

  const durations = {};
  for (const key of SLEEP_DURATION_KEYS) {
    durations[key] = optionalNonNegativeInteger(value[key], `${path}.${key}`);
  }
  if (durations.total_duration_ms === null) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.total_duration_ms is required`);
  }
  const counts = {};
  for (const key of SLEEP_COUNT_KEYS) {
    counts[key] = optionalNonNegativeInteger(value[key], `${path}.${key}`);
  }
  if (value.low_accuracy !== undefined && value.low_accuracy !== null && typeof value.low_accuracy !== "boolean") {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.low_accuracy must be a boolean`);
  }
  if (
    value.recorder_generation !== undefined &&
    value.recorder_generation !== null &&
    !Number.isSafeInteger(value.recorder_generation)
  ) {
    throw new HttpError(400, "INVALID_REQUEST", `${path}.recorder_generation must be an integer`);
  }

  return {
    source: value.source,
    source_day: expectSourceDay(value.source_day, `${path}.source_day`),
    source_timezone: expectSourceTimezone(value.source_timezone, `${path}.source_timezone`),
    source_day_start:
      value.source_day_start === undefined || value.source_day_start === null
        ? null
        : expectEpoch(value.source_day_start, `${path}.source_day_start`),
    sleep_start: sleepStart,
    sleep_end: sleepEnd,
    sampled_at: sampledAt.text,
    sampled_at_ms: sampledAt.epoch,
    status: value.status,
    outcome: value.outcome,
    verification,
    recorder_generation:
      value.recorder_generation === undefined || value.recorder_generation === null
        ? null
        : value.recorder_generation,
    low_accuracy:
      value.low_accuracy === undefined || value.low_accuracy === null ? null : value.low_accuracy,
    ...counts,
    ...durations,
    stages: parseSleepStages(value.stages, `${path}.stages`),
  };
}

export function parseSleepSummaryBatch(input) {
  const value = expectObject(input, "body");
  const allowed = new Set(["batch_id", "producer", "sent_at", "summaries"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpError(400, "INVALID_REQUEST", "body contains unknown fields", { fields: unknown });
  }
  if (!Array.isArray(value.summaries) || value.summaries.length < 1 || value.summaries.length > 30) {
    throw new HttpError(400, "INVALID_REQUEST", "body.summaries must contain between 1 and 30 summaries");
  }
  const summaries = value.summaries.map((summary, index) =>
    parseSleepSummary(summary, `body.summaries[${index}]`),
  );
  const keys = summaries.map((summary) => `${summary.source} ${summary.source_day} ${summary.sleep_start}`);
  if (new Set(keys).size !== keys.length) {
    throw new HttpError(400, "INVALID_REQUEST", "body.summaries contains duplicate source/source_day/sleep_start keys");
  }
  return {
    batch_id: expectString(value.batch_id, "body.batch_id", { max: 128 }),
    producer: expectString(value.producer, "body.producer", { max: 128 }),
    sent_at: value.sent_at === undefined || value.sent_at === null ? null : expectEpoch(value.sent_at, "body.sent_at"),
    summaries,
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
