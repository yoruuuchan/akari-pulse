import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { HealthDatabase } from "./database.js";
import {
  HEALTH_CALENDAR_OFFSET_MINUTES,
  HEALTH_CALENDAR_TIMEZONE,
  HEALTH_STATUSES,
  HttpError,
  PHONE_DAILY_METRICS,
  SOURCE_STALE_AFTER_MS,
  parseCorrelationEvent,
  parseHealthBatch,
  parseIntegerQuery,
  parseMetricList,
  parsePhoneDailySummaryBatch,
  parseSession,
  parseSleepSummaryBatch,
  parseStopSession,
} from "./validation.js";

function sendJson(response, statusCode, body) {
  const data = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(data);
}

function secureTokenEquals(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAuthorized(request, token) {
  if (!token) return true;
  const header = request.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  return secureTokenEquals(header.slice(7), token);
}

async function readJson(request, maxBytes, { allowEmpty = false } = {}) {
  const contentType = request.headers["content-type"] || "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const chunks = [];
  let length = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, "BODY_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`);
  if (length === 0) {
    if (allowEmpty) return null;
    throw new HttpError(400, "INVALID_JSON", "Request body is empty");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

// Three different clocks get confused with each other constantly, so every read
// carries all three apart: generated_at (when this response was built) stays on
// the envelope, while data_as_of (when the returned values were observed) and
// received_at (when the backend took them in) live here. Observations are
// {metric, source, observed_at, received_at}: for a raw record observed_at is
// its own timestamp, for a phone summary it is the provider read that produced
// the value. by_source additionally carries how fresh that source is overall —
// a deliberately historical query returns old rows from a perfectly live source,
// which is not the same thing as a source that stopped reporting.
function buildFreshness(observations, sourceFreshness, now) {
  const observedTimes = observations.map((o) => o.observed_at).filter((t) => typeof t === "number");
  const receivedTimes = observations.map((o) => o.received_at).filter((t) => typeof t === "number");
  const byMetric = {};
  const bySource = {};
  for (const observation of observations) {
    if (typeof observation.observed_at !== "number") continue;
    if (!(observation.metric in byMetric) || observation.observed_at > byMetric[observation.metric]) {
      byMetric[observation.metric] = observation.observed_at;
    }
    const source = bySource[observation.source] ?? (bySource[observation.source] = {
      data_as_of: null,
      received_at: null,
      age_ms: null,
      ...(sourceFreshness[observation.source] ?? { source_latest_at: null, source_age_ms: null, state: "UNKNOWN" }),
    });
    if (source.data_as_of === null || observation.observed_at > source.data_as_of) {
      source.data_as_of = observation.observed_at;
      source.age_ms = Math.max(0, now - observation.observed_at);
    }
    if (typeof observation.received_at === "number" && (source.received_at === null || observation.received_at > source.received_at)) {
      source.received_at = observation.received_at;
    }
  }
  const entries = Object.entries(bySource);
  return {
    data_as_of: observedTimes.length > 0 ? Math.max(...observedTimes) : null,
    received_at: receivedTimes.length > 0 ? Math.max(...receivedTimes) : null,
    data_as_of_by_metric: byMetric,
    by_source: bySource,
    stale_sources: entries.filter(([, s]) => s.state === "STALE").map(([name]) => name),
    historical_sources: entries.filter(([, s]) => s.lifecycle === "HISTORICAL").map(([name]) => name),
    degraded_sources: entries
      .filter(([, s]) => s.state === "STALE" && s.counts_toward_production_health)
      .map(([name]) => name),
    stale_after_ms: SOURCE_STALE_AFTER_MS,
    semantics:
      "data_as_of is the newest observation in this response; age_ms is how old that value is now. source_latest_at/source_age_ms/state describe the source itself, whatever window was asked for. A source is STALE once its newest observation is older than stale_after_ms, and stale_sources lists every one of them. Only an ACTIVE source's staleness is a fault: degraded_sources drives the status, while a HISTORICAL source is read on demand, keeps its real age here, and is not a production-health signal.",
  };
}

// PASS only when everything returned comes from a source that was supposed to
// keep reporting and did. Old data is still returned with its real timestamps
// either way — the response just refuses to present it as a current reading, and
// refuses equally to call a manual source's silence an outage.
function freshnessStatus(freshness, hasData) {
  if (!hasData) return "NO_DATA";
  return freshness.degraded_sources.length > 0 ? "DEGRADED" : "PASS";
}

function recordObservations(records) {
  return records.map((record) => ({
    metric: record.metric,
    source: record.source_device,
    observed_at: record.timestamp,
    received_at: record.received_at,
  }));
}

function dateBounds(date, offsetMinutes, now = Date.now()) {
  const localNow = new Date(now + offsetMinutes * 60000);
  const effectiveDate = date || localNow.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    throw new HttpError(400, "INVALID_QUERY", "date must use YYYY-MM-DD");
  }
  const parsedUtc = Date.parse(`${effectiveDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsedUtc) || new Date(parsedUtc).toISOString().slice(0, 10) !== effectiveDate) {
    throw new HttpError(400, "INVALID_QUERY", "date is not a valid calendar date");
  }
  const start = parsedUtc - offsetMinutes * 60000;
  return { date: effectiveDate, start, end: start + 86400000 - 1 };
}

function summarizeRecords(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.metric)) groups.set(record.metric, []);
    groups.get(record.metric).push(record);
  }
  const summary = {};
  for (const [metric, metricRecords] of groups) {
    const numeric = metricRecords
      .map((record) => record.value)
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    const latest = metricRecords.at(-1);
    const metricSummary = {
      sample_count: metricRecords.length,
      latest,
    };
    if (numeric.length > 0) {
      metricSummary.minimum = Math.min(...numeric);
      metricSummary.maximum = Math.max(...numeric);
      metricSummary.average = Math.round((numeric.reduce((sum, value) => sum + value, 0) / numeric.length) * 100) / 100;
      if (metric === "step_count_sensor") {
        metricSummary.daily_value = Math.max(...numeric);
        metricSummary.daily_value_semantics =
          "maximum observed cumulative-since-boot value; not a calendar-day total and may reset on device reboot";
      } else if (["step_count", "distance", "calories", "standing", "intensity_sport", "energy"].includes(metric)) {
        metricSummary.daily_value = Math.max(...numeric);
        metricSummary.daily_value_semantics = "maximum observed cumulative value; source semantics require device verification";
      }
    }
    summary[metric] = metricSummary;
  }
  return summary;
}

function groupDailySummaries(records) {
  const sources = {};
  for (const record of records) {
    if (!sources[record.source]) sources[record.source] = {};
    sources[record.source][record.metric] = record;
  }
  return sources;
}

function watchStepSource(summary, metric) {
  if (!summary) return { status: "NO_DATA", metric, value: null };
  return {
    status: "PASS",
    metric,
    value: summary.daily_value ?? summary.latest?.value ?? null,
    unit: summary.latest?.unit ?? null,
    daily_value_semantics: summary.daily_value_semantics ?? null,
    summary,
  };
}

function buildStepSources(metricSummaries, dailySummaries, sourceDay) {
  const official = watchStepSource(metricSummaries.step_count, "step_count");
  const sensor = watchStepSource(metricSummaries.step_count_sensor, "step_count_sensor");
  const phoneSummary = dailySummaries.vivo_phone?.phone_step_count;
  return {
    watch: {
      status: official.status === "PASS" || sensor.status === "PASS" ? "PASS" : "NO_DATA",
      step_count: official,
      step_count_sensor: sensor,
    },
    phone: phoneSummary
      ? { ...phoneSummary, value: Object.hasOwn(phoneSummary, "value") ? phoneSummary.value : null }
      : {
          source: "vivo_phone",
          metric: "phone_step_count",
          source_day: sourceDay,
          source_timezone: null,
          status: "NO_DATA",
          value: null,
          sampled_at: null,
          source_timestamp_available: false,
        },
  };
}

function todayStatus(watchRecords, dailySummaryRecords) {
  if (watchRecords.length > 0 || dailySummaryRecords.some((summary) => summary.status === "PASS")) {
    return "PASS";
  }
  if (dailySummaryRecords.some((summary) => summary.status === "ERROR")) return "ERROR";
  return "NO_DATA";
}

function parseRangeQuery(url) {
  const from = parseIntegerQuery(url.searchParams.get("from"), "from", { defaultValue: 0 });
  const to = parseIntegerQuery(url.searchParams.get("to"), "to", { defaultValue: Number.MAX_SAFE_INTEGER });
  if (from > to) throw new HttpError(400, "INVALID_QUERY", "from cannot be after to");
  const limit = parseIntegerQuery(url.searchParams.get("limit"), "limit", {
    min: 1,
    max: 5000,
    defaultValue: 500,
  });
  const statusParameter = url.searchParams.get("status");
  const status = statusParameter === "ALL" ? null : statusParameter || "PASS";
  if (status && !HEALTH_STATUSES.has(status)) {
    throw new HttpError(400, "INVALID_QUERY", "status is not supported");
  }
  return {
    metrics: parseMetricList(url.searchParams.get("metrics") || url.searchParams.get("metric")),
    from,
    to,
    limit,
    status,
    ascending: url.searchParams.get("order") !== "desc",
  };
}

function decodePathId(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 128) throw new Error("invalid");
    return decoded;
  } catch {
    throw new HttpError(400, "INVALID_PATH", "Path identifier is invalid");
  }
}

export function createHealthService(config, { now = () => Date.now() } = {}) {
  const database = new HealthDatabase(config.databasePath);

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://akari-health.local");
      if (request.method === "GET" && requestUrl.pathname === "/healthz") {
        sendJson(response, 200, {
          ok: true,
          service: "akari-health",
          status: "PASS",
          generated_at: now(),
        });
        return;
      }

      if (!isAuthorized(request, config.token)) {
        response.setHeader("www-authenticate", "Bearer");
        throw new HttpError(401, "UNAUTHORIZED", "A valid bearer token is required");
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/status") {
        const status = database.status(now());
        sendJson(response, 200, {
          ok: true,
          status: status.freshness.degraded_sources.length > 0 ? "DEGRADED" : "PASS",
          generated_at: now(),
          data: status,
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/health/batches") {
        const batch = parseHealthBatch(await readJson(request, config.maxBodyBytes));
        const result = database.ingestBatch(batch, now());
        sendJson(response, result.replayed ? 200 : 202, {
          ok: true,
          status: "PASS",
          generated_at: now(),
          data: result,
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/health/daily-summaries") {
        const batch = parsePhoneDailySummaryBatch(await readJson(request, config.maxBodyBytes));
        const result = database.ingestDailySummaryBatch(batch, now());
        sendJson(response, result.replayed ? 200 : 202, {
          ok: true,
          status: "PASS",
          generated_at: now(),
          data: result,
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/health/sleep-summaries") {
        const batch = parseSleepSummaryBatch(await readJson(request, config.maxBodyBytes));
        const result = database.ingestSleepSummaryBatch(batch, now());
        sendJson(response, result.replayed ? 200 : 202, {
          ok: true,
          status: "PASS",
          generated_at: now(),
          data: result,
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/health/sleep-summaries") {
        const sourceDay = requestUrl.searchParams.get("source_day");
        if (sourceDay !== null && !/^\d{4}-\d{2}-\d{2}$/.test(sourceDay)) {
          throw new HttpError(400, "INVALID_QUERY", "source_day must use YYYY-MM-DD");
        }
        const limit = parseIntegerQuery(requestUrl.searchParams.get("limit"), "limit", {
          min: 1,
          max: 60,
          defaultValue: 7,
        });
        const from = parseIntegerQuery(requestUrl.searchParams.get("from"), "from", { defaultValue: null });
        const to = parseIntegerQuery(requestUrl.searchParams.get("to"), "to", { defaultValue: null });
        if (from !== null && to !== null && from > to) {
          throw new HttpError(400, "INVALID_QUERY", "from cannot be after to");
        }
        const summaries = database.sleepSummaries({ sourceDay, from, to, limit });
        const freshness = buildFreshness(
          summaries.map((summary) => ({
            metric: "phone_sleep",
            source: summary.source,
            observed_at: summary.sampled_at_ms,
            received_at: summary.received_at,
          })),
          database.sourceFreshness(now()),
          now(),
        );
        sendJson(response, 200, {
          ok: true,
          status: freshnessStatus(freshness, summaries.length > 0),
          generated_at: now(),
          data: {
            summaries,
            query: { source_day: sourceDay, from, to, limit },
            freshness,
            semantics:
              "one row per observed sleep session, keyed by source, source_day, sleep_start: a day holds its night sleep and any naps side by side; source_day is the local calendar day the wake-up time falls in, taken from the vivo provider and never re-bucketed; limit counts distinct sleep days; from/to select sessions whose real [sleep_start, sleep_end] interval overlaps the window, so a window containing no sleep returns none",
          },
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/health/latest") {
        const metrics = parseMetricList(requestUrl.searchParams.get("metrics") || requestUrl.searchParams.get("metric"));
        const statusParameter = requestUrl.searchParams.get("status");
        const status = statusParameter === "ALL" ? null : statusParameter || "PASS";
        if (status && !HEALTH_STATUSES.has(status)) {
          throw new HttpError(400, "INVALID_QUERY", "status is not supported");
        }
        const records = database.latest({ metrics, status });
        // records is newest-first, so the first row seen for a source is that
        // source's latest. `latest` is the newest observation overall: callers
        // read it instead of guessing a precedence out of records[0].
        const latestBySource = {};
        for (const record of records) {
          if (!(record.source_device in latestBySource)) latestBySource[record.source_device] = record;
        }
        const freshness = buildFreshness(recordObservations(records), database.sourceFreshness(now()), now());
        sendJson(response, 200, {
          ok: true,
          status: freshnessStatus(freshness, records.length > 0),
          generated_at: now(),
          data: {
            records,
            latest: records[0] ?? null,
            latest_by_source: latestBySource,
            ordering:
              "records are sorted by observation timestamp, newest first, one row per metric; no source outranks another",
            freshness,
          },
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/health/range") {
        const query = parseRangeQuery(requestUrl);
        const records = database.queryRange(query);
        const freshness = buildFreshness(recordObservations(records), database.sourceFreshness(now()), now());
        sendJson(response, 200, {
          ok: true,
          status: freshnessStatus(freshness, records.length > 0),
          generated_at: now(),
          data: { records, query, freshness },
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/health/today") {
        const offsetOverride = requestUrl.searchParams.get("timezone_offset_minutes");
        const rawOffset = offsetOverride ?? String(HEALTH_CALENDAR_OFFSET_MINUTES);
        if (!/^[+-]?\d+$/.test(rawOffset)) {
          throw new HttpError(400, "INVALID_QUERY", "timezone_offset_minutes must be an integer");
        }
        const signedOffset = Number(rawOffset);
        if (!Number.isInteger(signedOffset) || signedOffset < -720 || signedOffset > 840) {
          throw new HttpError(400, "INVALID_QUERY", "timezone_offset_minutes must be between -720 and 840");
        }
        const bounds = dateBounds(requestUrl.searchParams.get("date"), signedOffset, now());
        const metrics = parseMetricList(requestUrl.searchParams.get("metrics"));
        const watchMetrics = metrics.filter((metric) => !PHONE_DAILY_METRICS.has(metric));
        const phoneMetrics = metrics.filter((metric) => PHONE_DAILY_METRICS.has(metric));
        const includeWatch = metrics.length === 0 || watchMetrics.length > 0;
        const includePhone = metrics.length === 0 || phoneMetrics.length > 0;
        const records = includeWatch
          ? database.queryRange({
              metrics: watchMetrics,
              from: bounds.start,
              to: bounds.end,
              status: "PASS",
              limit: 5000,
              ascending: true,
            })
          : [];
        const dailySummaryRecords = includePhone
          ? database.dailySummaries({
              sourceDay: bounds.date,
              metrics: phoneMetrics,
            })
          : [];
        const metricSummaries = summarizeRecords(records);
        const dailySummaries = groupDailySummaries(dailySummaryRecords);
        const freshness = buildFreshness(
          [
            ...recordObservations(records),
            ...dailySummaryRecords.map((summary) => ({
              metric: summary.metric,
              source: summary.source,
              observed_at: summary.sampled_at_ms,
              received_at: summary.received_at,
            })),
          ],
          database.sourceFreshness(now()),
          now(),
        );
        const status = todayStatus(records, dailySummaryRecords);
        sendJson(response, 200, {
          ok: true,
          status: status === "PASS" ? freshnessStatus(freshness, true) : status,
          generated_at: now(),
          data: {
            date: bounds.date,
            timezone_offset_minutes: signedOffset,
            timezone: offsetOverride === null ? HEALTH_CALENDAR_TIMEZONE : null,
            timezone_source: offsetOverride === null ? "provider_default" : "caller_override",
            timezone_semantics:
              `calendar days default to the vivo provider's own zone (${HEALTH_CALENDAR_TIMEZONE}, UTC+${HEALTH_CALENDAR_OFFSET_MINUTES / 60}), the zone its summaries are stamped with — never the MCP client's local zone`,
            from: bounds.start,
            to: bounds.end,
            metrics: metricSummaries,
            daily_summaries: dailySummaries,
            steps: buildStepSources(metricSummaries, dailySummaries, bounds.date),
            freshness,
          },
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/events") {
        const event = parseCorrelationEvent(await readJson(request, config.maxBodyBytes));
        const result = database.addCorrelationEvent(event, now());
        sendJson(response, result.duplicate ? 200 : 201, {
          ok: true,
          status: "PASS",
          generated_at: now(),
          data: result,
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/events") {
        const from = parseIntegerQuery(requestUrl.searchParams.get("from"), "from", { defaultValue: 0 });
        const to = parseIntegerQuery(requestUrl.searchParams.get("to"), "to", { defaultValue: Number.MAX_SAFE_INTEGER });
        if (from > to) throw new HttpError(400, "INVALID_QUERY", "from cannot be after to");
        const limit = parseIntegerQuery(requestUrl.searchParams.get("limit"), "limit", {
          min: 1,
          max: 5000,
          defaultValue: 500,
        });
        const events = database.listCorrelationEvents({
          from,
          to,
          sessionId: requestUrl.searchParams.get("session_id"),
          limit,
        });
        sendJson(response, 200, {
          ok: true,
          status: events.length > 0 ? "PASS" : "NO_DATA",
          generated_at: now(),
          data: { events },
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/sessions") {
        const session = database.createSession(parseSession(await readJson(request, config.maxBodyBytes)), now());
        sendJson(response, 201, {
          ok: true,
          status: "PASS",
          generated_at: now(),
          data: { session },
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/sessions") {
        const from = parseIntegerQuery(requestUrl.searchParams.get("from"), "from", { defaultValue: 0 });
        const to = parseIntegerQuery(requestUrl.searchParams.get("to"), "to", { defaultValue: Number.MAX_SAFE_INTEGER });
        if (from > to) throw new HttpError(400, "INVALID_QUERY", "from cannot be after to");
        const limit = parseIntegerQuery(requestUrl.searchParams.get("limit"), "limit", {
          min: 1,
          max: 1000,
          defaultValue: 100,
        });
        const sessionStatus = requestUrl.searchParams.get("status");
        if (sessionStatus && !["OPEN", "CLOSED"].includes(sessionStatus)) {
          throw new HttpError(400, "INVALID_QUERY", "session status must be OPEN or CLOSED");
        }
        const sessions = database.listSessions({ from, to, status: sessionStatus, limit });
        sendJson(response, 200, {
          ok: true,
          status: sessions.length > 0 ? "PASS" : "NO_DATA",
          generated_at: now(),
          data: { sessions },
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/sessions/active") {
        const sessions = database.activeSessions();
        sendJson(response, 200, {
          ok: true,
          status: sessions.length > 0 ? "PASS" : "NO_DATA",
          generated_at: now(),
          data: { sessions },
        });
        return;
      }

      const stopMatch = requestUrl.pathname.match(/^\/v1\/sessions\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopMatch) {
        const sessionId = decodePathId(stopMatch[1]);
        const body = await readJson(request, config.maxBodyBytes, { allowEmpty: true });
        const { ended_at: endedAt } = parseStopSession(body);
        const session = database.stopSession(sessionId, endedAt, now());
        sendJson(response, 200, {
          ok: true,
          status: "PASS",
          generated_at: now(),
          data: { session },
        });
        return;
      }

      const summaryMatch = requestUrl.pathname.match(/^\/v1\/sessions\/([^/]+)\/summary$/);
      if (request.method === "GET" && summaryMatch) {
        const sessionId = decodePathId(summaryMatch[1]);
        const baselineWindowMs = parseIntegerQuery(requestUrl.searchParams.get("baseline_window_ms"), "baseline_window_ms", {
          min: 1000,
          max: 3600000,
          defaultValue: 60000,
        });
        const responseWindowMs = parseIntegerQuery(requestUrl.searchParams.get("response_window_ms"), "response_window_ms", {
          min: 1000,
          max: 3600000,
          defaultValue: 300000,
        });
        const riseThresholdBpm = parseIntegerQuery(requestUrl.searchParams.get("rise_threshold_bpm"), "rise_threshold_bpm", {
          min: 1,
          max: 100,
          defaultValue: 5,
        });
        const summary = database.sessionSummary(
          sessionId,
          { baselineWindowMs, responseWindowMs, riseThresholdBpm },
          now(),
        );
        sendJson(response, 200, {
          ok: true,
          status: summary.coverage.heart_rate_samples > 0 ? "PASS" : "NO_DATA",
          generated_at: now(),
          data: summary,
        });
        return;
      }

      throw new HttpError(404, "NOT_FOUND", "Route not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, {
          ok: false,
          status: "ERROR",
          generated_at: now(),
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        });
        return;
      }
      console.error("akari-health unhandled request error", error);
      sendJson(response, 500, {
        ok: false,
        status: "ERROR",
        generated_at: now(),
        error: { code: "INTERNAL_ERROR", message: "Internal service error" },
      });
    }
  });

  return {
    database,
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      if (server.listening) {
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
      database.close();
    },
  };
}
