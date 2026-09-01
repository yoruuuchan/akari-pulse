import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { HealthApi, HealthApiError, loadApiConfig } from "./health-api.js";

const metricName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const timeInput = z.union([
  z.number().int().nonnegative(),
  z.string().min(1).describe("ISO-8601 timestamp, including an offset when not UTC"),
]);
// DEGRADED: the read succeeded and the data is returned, but an active
// production source behind it stopped reporting. Reaching the database is not
// the same as the health data being current, and the two must not collapse into
// one PASS. A source read on demand rather than on a schedule is HISTORICAL and
// does not trigger this — its real age still travels in freshness.
const statusSchema = z.enum(["PASS", "DEGRADED", "NO_DATA", "DENIED", "UNSUPPORTED", "API_MISSING", "ERROR"]);
const outputSchema = z.object({
  ok: z.boolean(),
  status: statusSchema,
  generated_at: z.number().int().nonnegative(),
  data: z.unknown(),
});

// All four hints are stated outright on every tool. Left unset, a client falls
// back on the spec defaults — destructiveHint and openWorldHint both true — and
// neither of those is right for anything here.
//
// openWorldHint is false throughout: every tool talks to exactly one place, the
// Akari Health HTTP service named by AKARI_HEALTH_URL, backed by its own SQLite
// store. No tool accepts a URL or reaches a third party, so the domain of
// interaction is a closed, enumerable set of metrics, records and sessions.
const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// The vivo provider stamps every daily summary with source_timezone
// "Asia/Shanghai" and decides in that zone which calendar day a value belongs
// to. Calendar tools therefore default to +480 rather than to wherever the
// client runs, so the same date means the same health day from any machine,
// VPN or not. Callers can still override it explicitly.
const CALENDAR_TIMEZONE = "Asia/Shanghai";
const CALENDAR_OFFSET_MINUTES = 480;
// Left optional rather than defaulted here: when it is omitted the backend
// applies the provider zone itself, so there is one authority for the default
// and the response can say whether the caller overrode it.
const calendarOffset = z
  .number()
  .int()
  .min(-720)
  .max(840)
  .optional()
  .describe(
    `Calendar-day offset in minutes. Omit it and the vivo provider's own zone is used (${CALENDAR_TIMEZONE}, +${CALENDAR_OFFSET_MINUTES}) — never the client's local zone.`,
  );

function asEpoch(value, name) {
  if (typeof value === "number") return value;
  if (!ISO_TIMESTAMP.test(value)) {
    throw new Error(`${name} must be a valid ISO-8601 timestamp with Z or an explicit UTC offset`);
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a valid ISO-8601 timestamp or Unix epoch milliseconds`);
  }
  return parsed;
}

function queryString(entries) {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function textResult(payload, summary) {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: payload,
  };
}

function toolFailure(error) {
  const code = error instanceof HealthApiError ? error.code : "MCP_TOOL_ERROR";
  const status = error instanceof HealthApiError && error.statusCode ? `HTTP ${error.statusCode}` : "local";
  return {
    isError: true,
    content: [{ type: "text", text: `${code} (${status}): ${error.message}` }],
  };
}

function summarizeLatest(payload, metric = null) {
  const { records, freshness } = payload.data;
  if (records.length === 0) return `no ${metric || "health"} observations are available`;
  if (records.length === 1) return describeRecord(records[0], records[0].metric, freshness);
  return `${records.length} latest health metrics returned, newest first · ${summarizeSourceHealth(freshness)}`;
}

function summarizeStepSources(payload) {
  const steps = payload.data.steps;
  const parts = [];
  if (steps.watch.step_count.status === "PASS") {
    parts.push(`watch step_count: ${steps.watch.step_count.value}`);
  }
  if (steps.watch.step_count_sensor.status === "PASS") {
    parts.push(`watch step_count_sensor: ${steps.watch.step_count_sensor.value} (cumulative since boot; not a calendar-day total)`);
  }
  if (steps.phone.status === "PASS") {
    parts.push(`phone: ${steps.phone.value} (${steps.phone.source_day}, ${steps.phone.source_timezone})`);
  } else if (steps.phone.sampled_at !== null) {
    parts.push(`phone: ${steps.phone.status} (${steps.phone.source_day}, sampled ${steps.phone.sampled_at})`);
  }
  if (parts.length === 0) parts.push(`no step observations are available for ${payload.data.date}`);
  parts.push(summarizeSourceHealth(payload.data.freshness));
  return `${parts.join(" · ")} · sources are returned side by side; no merge or precedence`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "unknown";
  const minutes = Math.round(milliseconds / 60000);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// Session kind is read from the provider's own duration split, never inferred
// from clock times. A record carrying both kinds (or neither) stays unlabelled.
function sleepSessionKind(summary) {
  const night = summary.night_sleep_duration_ms ?? 0;
  const nap = summary.nap_duration_ms ?? 0;
  if (night > 0 && nap === 0) return "night";
  if (nap > 0 && night === 0) return "nap";
  return null;
}

function summarizePhoneSleepSession(summary) {
  const kind = sleepSessionKind(summary);
  const parts = [
    `phone (${summary.source}) ${summary.source_day}${kind ? ` ${kind}` : ""}`,
    `asleep ${new Date(summary.sleep_start).toISOString()} → awake ${new Date(summary.sleep_end).toISOString()}`,
    `total ${formatDuration(summary.total_duration_ms)}`,
  ];
  if (summary.deep_sleep_duration_ms !== null) parts.push(`deep ${formatDuration(summary.deep_sleep_duration_ms)}`);
  if (summary.light_sleep_duration_ms !== null) parts.push(`light ${formatDuration(summary.light_sleep_duration_ms)}`);
  if (summary.rem_sleep_duration_ms !== null) parts.push(`rem ${formatDuration(summary.rem_sleep_duration_ms)}`);
  if (summary.awake_episode_count !== null) {
    parts.push(`wake-ups ${summary.awake_episode_count} · ${formatDuration(summary.awake_episode_duration_ms)}`);
  }
  if (summary.score !== null) parts.push(`score ${summary.score}`);
  if (summary.deep_sleep_continuity !== null) parts.push(`deep continuity ${summary.deep_sleep_continuity}`);
  return parts.join(" · ");
}

// Summarizes every stored session of the most recent returned day — the night
// sleep and any naps are separate rows and all of them belong in the answer.
function summarizePhoneSleep(summaries) {
  if (!summaries || summaries.length === 0) return "phone: no vivo sleep session in the requested scope";
  const day = summaries[0].source_day;
  return summaries
    .filter((summary) => summary.source_day === day)
    .map(summarizePhoneSleepSession)
    .join(" | ");
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "unknown age";
  const hours = ageMs / 3600000;
  if (hours < 1) return `${Math.round(ageMs / 60000)}m old`;
  if (hours < 48) return `${Math.round(hours)}h old`;
  return `${Math.round(hours / 24)}d old`;
}

// A stale value is never presented as a current reading — but why it is stale
// matters: an ACTIVE feed that went quiet is a fault, a HISTORICAL source read
// on demand is simply not being used right now.
function describeSourceState(source) {
  if (!source || source.state !== "STALE") return "";
  return source.lifecycle === "HISTORICAL"
    ? " · HISTORICAL SOURCE, read on demand and not currently reporting; not a current reading"
    : " · STALE SOURCE, not a current reading";
}

function describeRecord(record, label, freshness) {
  if (!record) return `${label}: no observation`;
  const value = Object.hasOwn(record, "value") ? JSON.stringify(record.value) : record.status;
  const source = freshness?.by_source?.[record.source_device];
  const age = source ? ` · ${formatAge(source.age_ms)}` : "";
  return `${label} (${record.source_device}): ${value}${record.unit ? ` ${record.unit}` : ""} · ${new Date(record.timestamp).toISOString()}${age}${describeSourceState(source)}`;
}

// The alarm is degraded_sources, not stale_sources: a historical source's age is
// context, not a problem to report.
function summarizeSourceHealth(freshness) {
  const parts = [];
  if (freshness.degraded_sources.length > 0) {
    parts.push(`DEGRADED: ${freshness.degraded_sources.join(", ")} stopped reporting`);
  }
  const historical = freshness.historical_sources.filter((name) => freshness.stale_sources.includes(name));
  if (historical.length > 0) {
    parts.push(`historical (read on demand, not a production-health signal): ${historical.join(", ")}`);
  }
  if (parts.length === 0) parts.push("all returned sources are reporting");
  return parts.join(" · ");
}

// Names the genuinely newest observation first, then each source's own latest.
// Without this the caller has to infer a precedence from record order, which is
// how a five-day-old watch sample got read as the current heart rate.
function summarizeSideBySide(payload, watchMetric, phoneMetric) {
  const { records, latest, freshness } = payload.data;
  const newest = latest ?? records[0] ?? null;
  return [
    newest
      ? describeRecord(newest, `latest ${newest.metric}`, freshness)
      : `no ${watchMetric} observation is available from any source`,
    describeRecord(records.find((record) => record.metric === watchMetric), "watch", freshness),
    describeRecord(records.find((record) => record.metric === phoneMetric), "phone", freshness),
    "sources are returned side by side, newest first; latest / latest_by_source name the newest observation, and no source outranks another",
  ].join(" · ");
}

// Phone daily summaries keep their provenance in the summary line, not just in
// the structured payload: a total is only meaningful together with the day it
// belongs to, the zone that day was decided in, and when the provider was read.
function summarizeActivity(payload) {
  const { date, metrics, daily_summaries: dailySummaries, freshness } = payload.data;
  const parts = [`${date}: ${Object.keys(metrics).length} watch activity metrics`];
  for (const [source, summaries] of Object.entries(dailySummaries)) {
    for (const summary of Object.values(summaries)) {
      const value = Object.hasOwn(summary, "value") ? `${summary.value}${summary.unit ? ` ${summary.unit}` : ""}` : summary.status;
      parts.push(
        `${source} ${summary.metric}: ${value} (${summary.source_day} ${summary.source_timezone} · sampled ${summary.sampled_at} · ${summary.verification})`,
      );
    }
  }
  parts.push(summarizeSourceHealth(freshness));
  parts.push("sources are returned side by side; no merge or precedence");
  return parts.join(" · ");
}

function reflectRecordStatus(payload) {
  const records = payload.data.records;
  if (records.length === 0 || records.some((record) => record.status === "PASS")) return payload;
  payload.status = ["ERROR", "DENIED", "API_MISSING", "UNSUPPORTED", "NO_DATA"].find((status) =>
    records.some((record) => record.status === status),
  ) || "NO_DATA";
  return payload;
}

async function invoke(handler) {
  try {
    return await handler();
  } catch (error) {
    return toolFailure(error);
  }
}

export function createMcpServer({ api = new HealthApi(loadApiConfig()) } = {}) {
  // name is the wire identifier that connectors cache and client configs bind
  // to, so it stays "akari-health". title, description and websiteUrl are what a
  // client shows a person, and they name the same publisher as the repository
  // and the package manifests.
  const server = new McpServer({
    name: "akari-health",
    title: "Akari Health",
    version: "0.1.0",
    description:
      "Read-only queries over a self-hosted Akari Pulse health store, plus heart-rate session metadata.",
    websiteUrl: "https://github.com/yoruuuchan/akari-pulse",
  });

  server.registerTool(
    "health_status",
    {
      title: "Akari health pipeline status",
      description: "Check Akari Health reachability, database state, ingest freshness, metric freshness, and each watch-to-MCP diagnostic layer.",
      inputSchema: z.object({}),
      outputSchema,
      annotations: readAnnotations,
    },
    async () =>
      invoke(async () => {
        const payload = await api.request("/v1/status");
        payload.data.layers.mcp_query = { status: "PASS", timestamp: Date.now(), age_ms: 0, state: "FRESH" };
        const { freshness } = payload.data;
        const sources = Object.entries(freshness.by_source)
          .map(([name, source]) =>
            `${name} ${source.lifecycle.toLowerCase()}/${source.state.toLowerCase()} (${formatAge(source.source_age_ms)})`)
          .join(", ");
        return textResult(
          payload,
          [
            `akari health: ${payload.status} · ${payload.data.database.record_count} records · ingest ${payload.data.layers.backend_ingest.status} · mcp query PASS`,
            `sources: ${sources || "none"}`,
            freshness.degraded_sources.length > 0
              ? `DEGRADED: ${freshness.degraded_sources.join(", ")} is an active production source and stopped reporting; the query path is healthy but that source's data is not current`
              : "every active production source is reporting",
            freshness.historical_sources.length > 0
              ? `historical sources (read on demand, records still queryable, not a production-health signal): ${freshness.historical_sources.join(", ")}`
              : "no historical sources",
          ].join(" · "),
        );
      }),
  );

  server.registerTool(
    "health_latest",
    {
      title: "Latest health observations",
      description: "Read the latest successful observation for one metric, or one latest observation per available metric. Raw records are read-only.",
      inputSchema: z.object({ metric: metricName.optional() }),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ metric }) =>
      invoke(async () => {
        const payload = await api.request(`/v1/health/latest${queryString([["metric", metric]])}`);
        return textResult(payload, summarizeLatest(payload, metric));
      }),
  );

  server.registerTool(
    "health_today",
    {
      title: "Today's health summary",
      description:
        "Read bounded watch metrics and phone daily summaries for a calendar date. Phone records retain their source_day and are never re-bucketed from sampled_at." +
        " The calendar day defaults to the vivo provider's own zone (Asia/Shanghai, UTC+8) when timezone_offset_minutes is omitted; there is no other default and the client's local zone is never used.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        timezone_offset_minutes: calendarOffset,
        metrics: z.array(metricName).max(32).optional(),
      }),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ date, timezone_offset_minutes, metrics }) =>
      invoke(async () => {
        const payload = await api.request(
          `/v1/health/today${queryString([
            ["date", date],
            ["timezone_offset_minutes", timezone_offset_minutes],
            ["metrics", metrics?.join(",")],
          ])}`,
        );
        const phoneCount = Object.values(payload.data.daily_summaries || {})
          .reduce((count, source) => count + Object.keys(source).length, 0);
        const { freshness } = payload.data;
        return textResult(
          payload,
          [
            `${payload.data.date} (${payload.data.timezone ?? `UTC${payload.data.timezone_offset_minutes >= 0 ? "+" : ""}${payload.data.timezone_offset_minutes / 60}`}, ${payload.data.timezone_source}): ${Object.keys(payload.data.metrics).length} watch metrics and ${phoneCount} phone daily summaries returned`,
            freshness.data_as_of === null
              ? "no observation behind this response"
              : `data as of ${new Date(freshness.data_as_of).toISOString()}`,
            summarizeSourceHealth(freshness),
          ].join(" · "),
        );
      }),
  );

  server.registerTool(
    "health_heart_rate",
    {
      title: "Heart rate near a time",
      description:
        "Without a timestamp, return the latest watch heart rate and the latest vivo phone heart rate side by side. With a timestamp, return the nearest real watch sample within a bounded window, plus the phone's latest snapshot for context. The phone value is a single latest point, never a daily aggregate.",
      inputSchema: z.object({
        at: timeInput.optional(),
        window_ms: z.number().int().min(1000).max(3600000).default(300000),
      }),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ at, window_ms }) =>
      invoke(async () => {
        if (at === undefined) {
          const payload = await api.request("/v1/health/latest?metrics=heart_rate,phone_heart_rate");
          return textResult(payload, summarizeSideBySide(payload, "heart_rate", "phone_heart_rate"));
        }
        const requestedAt = asEpoch(at, "at");
        const payload = await api.request(
          `/v1/health/range${queryString([
            ["metric", "heart_rate"],
            ["from", Math.max(0, requestedAt - window_ms)],
            ["to", requestedAt + window_ms],
            ["limit", 2000],
          ])}`,
        );
        const records = payload.data.records;
        const nearest = records.reduce(
          (best, record) =>
            !best || Math.abs(record.timestamp - requestedAt) < Math.abs(best.timestamp - requestedAt)
              ? record
              : best,
          null,
        );
        const phoneLatest = await api.request("/v1/health/latest?metric=phone_heart_rate");
        const result = {
          ok: true,
          status: nearest ? payload.status : "NO_DATA",
          generated_at: payload.generated_at,
          data: {
            requested_at: requestedAt,
            window_ms,
            record: nearest,
            distance_ms: nearest ? Math.abs(nearest.timestamp - requestedAt) : null,
            phone_latest_snapshot: phoneLatest.data.records[0] ?? null,
            phone_latest_snapshot_semantics:
              "the vivo phone provider exposes only its newest single point; it is not a windowed sample and not a daily aggregate",
            // The window's own freshness, kept apart from the phone snapshot's:
            // one describes the sample nearest the requested time, the other a
            // reading taken whenever the provider last ran.
            freshness: payload.data.freshness,
            phone_latest_snapshot_freshness: phoneLatest.data.freshness,
          },
        };
        return textResult(
          result,
          nearest
            ? `heart_rate: ${nearest.value} ${nearest.unit || "bpm"} · ${Math.abs(nearest.timestamp - requestedAt)}ms from requested time · ${describeRecord(phoneLatest.data.records[0] ?? null, "phone latest snapshot", phoneLatest.data.freshness)}`
            : "no heart-rate sample exists in the requested window",
        );
      }),
  );

  server.registerTool(
    "health_heart_rate_range",
    {
      title: "Heart-rate samples in a range",
      description: "Read bounded raw heart-rate samples between two timestamps, preserving device timestamps and callback deltas.",
      inputSchema: z.object({
        from: timeInput,
        to: timeInput,
        limit: z.number().int().min(1).max(2000).default(1000),
      }),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ from, to, limit }) =>
      invoke(async () => {
        const fromEpoch = asEpoch(from, "from");
        const toEpoch = asEpoch(to, "to");
        if (fromEpoch > toEpoch) throw new Error("from cannot be after to");
        const payload = await api.request(
          `/v1/health/range${queryString([
            ["metric", "heart_rate"],
            ["from", fromEpoch],
            ["to", toEpoch],
            ["limit", limit],
          ])}`,
        );
        return textResult(payload, `${payload.data.records.length} heart-rate samples returned`);
      }),
  );

  server.registerTool(
    "health_steps",
    {
      title: "Steps",
      description:
        "Return watch official/sensor steps and the vivo phone daily summary side by side. Sources are never merged and neither source overrides the other." +
        " The calendar day defaults to the vivo provider's own zone (Asia/Shanghai, UTC+8) when timezone_offset_minutes is omitted; there is no other default and the client's local zone is never used.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        timezone_offset_minutes: calendarOffset,
      }),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ date, timezone_offset_minutes }) =>
      invoke(async () => {
        const todayPayload = await api.request(
          `/v1/health/today${queryString([
            ["date", date],
            ["timezone_offset_minutes", timezone_offset_minutes],
            ["metrics", "step_count,step_count_sensor,phone_step_count"],
          ])}`,
        );
        if (!date) {
          const legacyLatest = await api.request("/v1/health/latest?metrics=step_count,step_count_sensor");
          todayPayload.data.records = legacyLatest.data.records;
          for (const metric of ["step_count", "step_count_sensor"]) {
            if (todayPayload.data.steps.watch[metric].status === "PASS") continue;
            const record = legacyLatest.data.records.find((candidate) => candidate.metric === metric);
            if (!record) continue;
            todayPayload.data.steps.watch[metric] = {
              status: "PASS",
              metric,
              value: record.value,
              unit: record.unit ?? null,
              observation_scope: "latest_available",
              record,
            };
          }
          if (
            todayPayload.data.steps.watch.step_count.status === "PASS" ||
            todayPayload.data.steps.watch.step_count_sensor.status === "PASS"
          ) {
            todayPayload.data.steps.watch.status = "PASS";
            // The fallback reaches outside today's window, so it carries its own
            // freshness. Its staleness propagates: a step count last seen days
            // ago must not be handed back under a plain PASS.
            todayPayload.data.steps.watch.freshness = legacyLatest.data.freshness;
            if (legacyLatest.status === "DEGRADED" || todayPayload.status === "NO_DATA") {
              todayPayload.status = legacyLatest.status;
            }
          }
        }
        return textResult(todayPayload, summarizeStepSources(todayPayload));
      }),
  );

  server.registerTool(
    "health_sleep",
    {
      title: "Sleep observations",
      description:
        "Read sleep from both sources side by side: raw watch sleep observations in a bounded time range, and vivo phone sleep sessions (fell asleep, woke up, total, deep, light, REM, wake-ups, score, deep-sleep continuity). from/to bound both sources: a phone session is returned only when its real [sleep_start, sleep_end] interval overlaps the window, so a window with no sleep in it returns none rather than the most recent night. A phone sleep day is attributed to the local calendar day of its wake-up time and can hold several sessions: the night sleep and any naps are separate rows keyed by their sleep_start, never merged and never displacing each other. No stage or duration is inferred when a source does not report it.",
      inputSchema: z.object({
        from: timeInput.optional()
          .describe("Start of the window. Constrains phone sleep sessions by overlap, not only raw watch records."),
        to: timeInput.optional()
          .describe("End of the window. Constrains phone sleep sessions by overlap, not only raw watch records."),
        limit: z.number().int().min(1).max(2000).default(1000),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe("Phone sleep day to return. Omit for the most recent stored sleep days."),
        sleep_days: z.number().int().min(1).max(60).default(7)
          .describe("How many phone sleep days to return when neither a date nor a from/to window is given."),
      }),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ from, to, limit, date, sleep_days }) =>
      invoke(async () => {
        const toEpoch = to === undefined ? Date.now() : asEpoch(to, "to");
        const fromEpoch = from === undefined ? Math.max(0, toEpoch - 48 * 3600000) : asEpoch(from, "from");
        if (fromEpoch > toEpoch) throw new Error("from cannot be after to");
        const payload = await api.request(
          `/v1/health/range${queryString([
            ["metrics", "sleep_status,sleep_unit,sleep_stages"],
            ["from", fromEpoch],
            ["to", toEpoch],
            ["limit", limit],
            ["status", "ALL"],
          ])}`,
        );
        reflectRecordStatus(payload);
        // An explicit window bounds the phone sessions too. Only the untouched
        // default — no from, no to — falls back to the most recent sleep days,
        // so asking about midday no longer answers with last night.
        const windowed = from !== undefined || to !== undefined;
        const phone = await api.request(
          `/v1/health/sleep-summaries${queryString([
            ["source_day", date],
            ["from", windowed ? fromEpoch : undefined],
            ["to", windowed ? toEpoch : undefined],
            ["limit", date ? 1 : sleep_days],
          ])}`,
        );
        payload.data.phone_sleep = {
          status: phone.status,
          summaries: phone.data.summaries,
          query: phone.data.query,
          freshness: phone.data.freshness,
          semantics: phone.data.semantics,
        };
        if (phone.data.summaries.length > 0 && payload.status === "NO_DATA") {
          payload.status = phone.status;
        }
        const statuses = [...new Set(payload.data.records.map((record) => record.status))];
        return textResult(
          payload,
          [
            `watch: ${payload.data.records.length} sleep observations${statuses.length > 0 ? ` (${statuses.join(", ")})` : ""}`,
            summarizePhoneSleep(phone.data.summaries),
            windowed
              ? `window ${new Date(fromEpoch).toISOString()} → ${new Date(toEpoch).toISOString()} · phone sessions are filtered by overlap with it`
              : `no window given; the most recent ${date ? "requested day" : `${sleep_days} sleep days`} are returned`,
            "sources are returned side by side; no merge or precedence",
          ].join(" · "),
        );
      }),
  );

  server.registerTool(
    "health_activity",
    {
      title: "Daily activity",
      description:
        "Read daily activity for a calendar date from both sources side by side: bounded watch observations (distance, calories, intensity, energy, standing, speed, walking) and the vivo phone daily summaries (steps, distance, calories) with their source, source_day, source_timezone, sampled_at and verification intact." +
        " The calendar day defaults to the vivo provider's own zone (Asia/Shanghai, UTC+8) when timezone_offset_minutes is omitted; there is no other default and the client's local zone is never used.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        timezone_offset_minutes: calendarOffset,
      }),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ date, timezone_offset_minutes }) =>
      invoke(async () => {
        // The phone metrics have to be named explicitly: /v1/health/today reads
        // daily summaries only for the phone metrics it was asked for, so a
        // watch-only metric list returned an empty daily_summaries and NO_DATA
        // on days the phone had perfectly good totals stored.
        const metrics = [
          "distance,calories,intensity_sport,energy,standing,walking_speed,walking_status,speed",
          "phone_step_count,phone_distance,phone_calories",
        ].join(",");
        const payload = await api.request(
          `/v1/health/today${queryString([
            ["date", date],
            ["timezone_offset_minutes", timezone_offset_minutes],
            ["metrics", metrics],
          ])}`,
        );
        return textResult(payload, summarizeActivity(payload));
      }),
  );

  for (const [toolName, metric, title] of [
    ["health_spo2", "spo2", "Blood oxygen"],
    ["health_stress", "stress", "Stress"],
  ]) {
    const phoneMetric = `phone_${metric}`;
    server.registerTool(
      toolName,
      {
        title,
        description:
          `Read the latest watch ${metric} and the latest vivo phone ${metric} side by side, or bounded raw observations from both sources when a time range is supplied. The phone value is a single latest point, never a daily aggregate.`,
        inputSchema: z.object({
          from: timeInput.optional(),
          to: timeInput.optional(),
          limit: z.number().int().min(1).max(2000).default(500),
        }),
        outputSchema,
        annotations: readAnnotations,
      },
      async ({ from, to, limit }) =>
        invoke(async () => {
          if (from === undefined && to === undefined) {
            const payload = await api.request(`/v1/health/latest?metrics=${metric},${phoneMetric}&status=ALL`);
            reflectRecordStatus(payload);
            return textResult(payload, summarizeSideBySide(payload, metric, phoneMetric));
          }
          const toEpoch = to === undefined ? Date.now() : asEpoch(to, "to");
          const fromEpoch = from === undefined ? 0 : asEpoch(from, "from");
          if (fromEpoch > toEpoch) throw new Error("from cannot be after to");
          const payload = await api.request(
            `/v1/health/range${queryString([
              ["metrics", `${metric},${phoneMetric}`],
              ["from", fromEpoch],
              ["to", toEpoch],
              ["limit", limit],
              ["status", "ALL"],
            ])}`,
          );
          reflectRecordStatus(payload);
          return textResult(payload, `${payload.data.records.length} ${metric} observations returned`);
        }),
    );
  }

  server.registerTool(
    "health_sessions",
    {
      title: "Health sessions",
      description: "List bounded heart-rate experiment session metadata. Raw health records remain read-only.",
      inputSchema: z.object({
        from: timeInput.optional(),
        to: timeInput.optional(),
        status: z.enum(["OPEN", "CLOSED"]).optional(),
        limit: z.number().int().min(1).max(1000).default(100),
      }),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ from, to, status, limit }) =>
      invoke(async () => {
        const payload = await api.request(
          `/v1/sessions${queryString([
            ["from", from === undefined ? undefined : asEpoch(from, "from")],
            ["to", to === undefined ? undefined : asEpoch(to, "to")],
            ["status", status],
            ["limit", limit],
          ])}`,
        );
        return textResult(payload, `${payload.data.sessions.length} health sessions returned`);
      }),
  );

  server.registerTool(
    "health_start_session",
    {
      title: "Start heart-rate session",
      description: "Create one open experiment session for a source device. This writes session metadata only and does not modify raw health observations.",
      inputSchema: z.object({
        source_device: z.string().min(1).max(128).default("WA2456C"),
        label: z.string().max(256).optional(),
        started_at: timeInput.optional(),
      }),
      outputSchema,
      // Session metadata is the only thing any MCP tool writes; no route here
      // updates or deletes a raw health observation. Each call appends another
      // open session, so this is neither read-only nor idempotent — but it
      // destroys nothing.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ source_device, label, started_at }) =>
      invoke(async () => {
        const payload = await api.request("/v1/sessions", {
          method: "POST",
          body: {
            source_device,
            ...(label === undefined ? {} : { label }),
            ...(started_at === undefined ? {} : { started_at: asEpoch(started_at, "started_at") }),
          },
        });
        return textResult(payload, `session ${payload.data.session.session_id} started for ${source_device}`);
      }),
  );

  server.registerTool(
    "health_stop_session",
    {
      title: "Stop heart-rate session",
      description: "Close an open experiment session. This writes session metadata only and is idempotent for an already closed session.",
      inputSchema: z.object({
        session_id: z.string().min(1).max(128),
        ended_at: timeInput.optional(),
      }),
      outputSchema,
      // A one-way OPEN → CLOSED transition that only fills in ended_at. Nothing
      // is deleted and no observation is touched, and the backend replays an
      // already-closed session unchanged rather than restamping it, so repeat
      // calls really are idempotent.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, ended_at }) =>
      invoke(async () => {
        const payload = await api.request(`/v1/sessions/${encodeURIComponent(session_id)}/stop`, {
          method: "POST",
          body: ended_at === undefined ? {} : { ended_at: asEpoch(ended_at, "ended_at") },
        });
        return textResult(payload, `session ${session_id} closed at ${new Date(payload.data.session.ended_at).toISOString()}`);
      }),
  );

  server.registerTool(
    "health_session_summary",
    {
      title: "Heart-rate session summary",
      description: "Summarize real session samples and timestamped events. Baseline and response windows are explicit, and results never claim causality.",
      inputSchema: z.object({
        session_id: z.string().min(1).max(128),
        baseline_window_ms: z.number().int().min(1000).max(3600000).default(60000),
        response_window_ms: z.number().int().min(1000).max(3600000).default(300000),
        rise_threshold_bpm: z.number().int().min(1).max(100).default(5),
      }),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ session_id, baseline_window_ms, response_window_ms, rise_threshold_bpm }) =>
      invoke(async () => {
        const payload = await api.request(
          `/v1/sessions/${encodeURIComponent(session_id)}/summary${queryString([
            ["baseline_window_ms", baseline_window_ms],
            ["response_window_ms", response_window_ms],
            ["rise_threshold_bpm", rise_threshold_bpm],
          ])}`,
        );
        return textResult(
          payload,
          `session ${session_id}: ${payload.data.coverage.heart_rate_samples} heart-rate samples · ${payload.data.coverage.correlation_events} correlation events · temporal association only`,
        );
      }),
  );

  return server;
}
