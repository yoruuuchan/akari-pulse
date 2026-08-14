import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { HealthApi, HealthApiError, loadApiConfig } from "./health-api.js";

const metricName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const timeInput = z.union([
  z.number().int().nonnegative(),
  z.string().min(1).describe("ISO-8601 timestamp, including an offset when not UTC"),
]);
const statusSchema = z.enum(["PASS", "NO_DATA", "DENIED", "UNSUPPORTED", "API_MISSING", "ERROR"]);
const outputSchema = z.object({
  ok: z.boolean(),
  status: statusSchema,
  generated_at: z.number().int().nonnegative(),
  data: z.unknown(),
});

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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
  const records = payload.data.records;
  if (records.length === 0) return `no ${metric || "health"} observations are available`;
  if (records.length === 1) {
    const record = records[0];
    const value = Object.hasOwn(record, "value") ? JSON.stringify(record.value) : record.status;
    return `${record.metric}: ${value}${record.unit ? ` ${record.unit}` : ""} · ${new Date(record.timestamp).toISOString()} · ${record.source_device}`;
  }
  return `${records.length} latest health metrics returned`;
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
  if (!summaries || summaries.length === 0) return "phone: no vivo sleep day stored";
  const day = summaries[0].source_day;
  return summaries
    .filter((summary) => summary.source_day === day)
    .map(summarizePhoneSleepSession)
    .join(" | ");
}

function summarizeSideBySide(payload, watchMetric, phoneMetric) {
  const records = payload.data.records;
  const describe = (metric, label) => {
    const record = records.find((candidate) => candidate.metric === metric);
    if (!record) return `${label}: no observation`;
    const value = Object.hasOwn(record, "value") ? JSON.stringify(record.value) : record.status;
    return `${label} (${record.source_device}): ${value}${record.unit ? ` ${record.unit}` : ""} · ${new Date(record.timestamp).toISOString()}`;
  };
  return [
    describe(watchMetric, "watch"),
    describe(phoneMetric, "phone"),
    "sources are returned side by side; no merge or precedence",
  ].join(" · ");
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
  const server = new McpServer({ name: "akari-health", version: "0.1.0" });

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
        payload.data.layers.mcp_query = { status: "PASS", timestamp: Date.now() };
        return textResult(
          payload,
          `akari health: ${payload.status} · ${payload.data.database.record_count} records · ingest ${payload.data.layers.backend_ingest.status} · mcp query PASS`,
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
      description: "Read bounded watch metrics and phone daily summaries for a calendar date. Phone records retain their source_day and are never re-bucketed from sampled_at.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        timezone_offset_minutes: z.number().int().min(-720).max(840).default(540),
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
        return textResult(
          payload,
          `${payload.data.date}: ${Object.keys(payload.data.metrics).length} watch metrics and ${phoneCount} phone daily summaries returned`,
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
          status: nearest ? "PASS" : "NO_DATA",
          generated_at: payload.generated_at,
          data: {
            requested_at: requestedAt,
            window_ms,
            record: nearest,
            distance_ms: nearest ? Math.abs(nearest.timestamp - requestedAt) : null,
            phone_latest_snapshot: phoneLatest.data.records[0] ?? null,
            phone_latest_snapshot_semantics:
              "the vivo phone provider exposes only its newest single point; it is not a windowed sample and not a daily aggregate",
          },
        };
        return textResult(
          result,
          nearest
            ? `heart_rate: ${nearest.value} ${nearest.unit || "bpm"} · ${Math.abs(nearest.timestamp - requestedAt)}ms from requested time`
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
      description: "Return watch official/sensor steps and the vivo phone daily summary side by side. Sources are never merged and neither source overrides the other.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        timezone_offset_minutes: z.number().int().min(-720).max(840).default(540),
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
            todayPayload.status = "PASS";
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
        "Read sleep from both sources side by side: raw watch sleep observations in a bounded time range, and vivo phone sleep sessions (fell asleep, woke up, total, deep, light, REM, wake-ups, score, deep-sleep continuity). A phone sleep day is attributed to the local calendar day of its wake-up time and can hold several sessions: the night sleep and any naps are separate rows keyed by their sleep_start, never merged and never displacing each other. No stage or duration is inferred when a source does not report it.",
      inputSchema: z.object({
        from: timeInput.optional(),
        to: timeInput.optional(),
        limit: z.number().int().min(1).max(2000).default(1000),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe("Phone sleep day to return. Omit for the most recent stored sleep days."),
        sleep_days: z.number().int().min(1).max(60).default(7)
          .describe("How many phone sleep days to return when no date is given."),
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
        const phone = await api.request(
          `/v1/health/sleep-summaries${queryString([
            ["source_day", date],
            ["limit", date ? 1 : sleep_days],
          ])}`,
        );
        payload.data.phone_sleep = {
          status: phone.status,
          summaries: phone.data.summaries,
          semantics: phone.data.semantics,
        };
        if (phone.data.summaries.length > 0) payload.status = "PASS";
        const statuses = [...new Set(payload.data.records.map((record) => record.status))];
        return textResult(
          payload,
          [
            `watch: ${payload.data.records.length} sleep observations${statuses.length > 0 ? ` (${statuses.join(", ")})` : ""}`,
            summarizePhoneSleep(phone.data.summaries),
            "sources are returned side by side; no merge or precedence",
          ].join(" · "),
        );
      }),
  );

  server.registerTool(
    "health_activity",
    {
      title: "Daily activity",
      description: "Read daily distance, calories, intensity, energy, standing, speed, and walking observations with explicit source semantics.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        timezone_offset_minutes: z.number().int().min(-720).max(840).default(540),
      }),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ date, timezone_offset_minutes }) =>
      invoke(async () => {
        const metrics = "distance,calories,intensity_sport,energy,standing,walking_speed,walking_status,speed";
        const payload = await api.request(
          `/v1/health/today${queryString([
            ["date", date],
            ["timezone_offset_minutes", timezone_offset_minutes],
            ["metrics", metrics],
          ])}`,
        );
        return textResult(payload, `${payload.data.date}: ${Object.keys(payload.data.metrics).length} activity metrics returned`);
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
