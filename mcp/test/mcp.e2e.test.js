import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHealthService } from "../../server/src/app.js";

const mcpEntry = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("official MCP client lists and invokes the Akari Health stdio tools", async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "akari-mcp-test-"));
  const token = "mcp-test-token";
  const service = createHealthService({
    host: "127.0.0.1",
    port: 0,
    token,
    databasePath: path.join(temporaryDirectory, "health.sqlite"),
    maxBodyBytes: 1024 * 1024,
  });
  const address = await service.listen();
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  const ingestResponse = await fetch(`${serviceUrl}/v1/health/batches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      batch_id: "mcp-fixture-batch",
      producer: "mcp-e2e-fixture",
      events: [
        {
          event_id: "mcp-fixture-hr",
          timestamp: 1_786_245_212_000,
          metric: "heart_rate",
          value: 78,
          unit: "bpm",
          source_device: "WA2456C",
          status: "PASS",
        },
        {
          event_id: "mcp-fixture-steps",
          timestamp: 1_786_245_213_000,
          metric: "step_count_sensor",
          value: 3456,
          unit: "step",
          source_device: "WA2456C",
          source_module: "@blueos.hardware.sensor.sensor",
          source_api: "sensor.subscribeStepCounter",
          quality: "cumulative_since_boot",
          status: "PASS",
        },
      ],
    }),
  });
  assert.equal(ingestResponse.status, 202);

  const phoneIngestResponse = await fetch(`${serviceUrl}/v1/health/daily-summaries`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      batch_id: "mcp-phone-daily-fixture",
      producer: "akari-pulse-android-fixture",
      summaries: [
        ["phone_step_count", "count", 4000, "VERIFIED"],
        ["phone_distance", "m", 2800.5, "VERIFIED_FORMATTED_DISPLAY"],
        ["phone_calories", "kcal", 180.25, "VERIFIED_FORMATTED_DISPLAY"],
      ].map(([metric, unit, value, verification]) => ({
        source: "vivo_phone",
        metric,
        source_day: "2026-08-09",
        source_timezone: "Asia/Shanghai",
        value,
        unit,
        sampled_at: "2026-08-09T11:15:00+08:00",
        source_timestamp_available: false,
        status: "PASS",
        outcome: "PROVIDER_CALL_SUCCEEDED",
        verification,
      })),
    }),
  });
  assert.equal(phoneIngestResponse.status, 202);

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
  environment.AKARI_HEALTH_URL = serviceUrl;
  environment.AKARI_HEALTH_TOKEN = token;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    env: environment,
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  const client = new Client(
    { name: "akari-health-e2e-test", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );

  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "health_activity",
      "health_heart_rate",
      "health_heart_rate_range",
      "health_latest",
      "health_session_summary",
      "health_sessions",
      "health_sleep",
      "health_spo2",
      "health_start_session",
      "health_status",
      "health_steps",
      "health_stop_session",
      "health_stress",
      "health_today",
    ]);
    // Every tool has to state all four hints outright. An absent hint is not
    // neutral: the client falls back on the spec defaults, which read
    // destructiveHint and openWorldHint as true for tools that are neither.
    const readToolHints = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    const writeToolHints = {
      health_start_session: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      health_stop_session: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };
    for (const tool of listed.tools) {
      const expected = writeToolHints[tool.name] ?? readToolHints;
      for (const [hint, value] of Object.entries(expected)) {
        assert.equal(Object.hasOwn(tool.annotations, hint), true, `${tool.name} must declare ${hint}`);
        assert.equal(tool.annotations[hint], value, `${tool.name} ${hint}`);
      }
    }

    // A numeric JSON Schema `default` is auto-filled by LLM clients and generated
    // callers, which would turn every call into a caller_override and quietly
    // defeat the provider zone. The parameter stays optional with no default, and
    // the runtime applies Asia/Shanghai when it is absent.
    for (const name of ["health_today", "health_steps", "health_activity"]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      const offset = tool.inputSchema.properties.timezone_offset_minutes;
      assert.equal(Object.hasOwn(offset, "default"), false, `${name} must not advertise a default offset`);
      assert.equal(
        tool.inputSchema.required?.includes("timezone_offset_minutes") ?? false,
        false,
        `${name} offset must stay optional`,
      );
      assert.match(offset.description, /Asia\/Shanghai/, `${name} offset description names the provider zone`);
      assert.match(tool.description, /Asia\/Shanghai/, `${name} description names the provider zone`);
      assert.equal(JSON.stringify(tool.inputSchema).includes("540"), false, `${name} schema must not mention 540`);
    }

    const status = await client.callTool({ name: "health_status", arguments: {} });
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.data.database.record_count, 2);
    assert.equal(status.structuredContent.data.database.daily_summary_count, 3);
    assert.equal(status.structuredContent.data.layers.mcp_query.status, "PASS");

    const latest = await client.callTool({
      name: "health_latest",
      arguments: { metric: "heart_rate" },
    });
    // This read touches only the watch, a HISTORICAL source: the value is
    // genuinely five days old and says so, but a source that is read on demand
    // rather than on a schedule cannot be late, so the read itself passes.
    assert.equal(latest.structuredContent.status, "PASS");
    assert.equal(latest.structuredContent.data.records[0].value, 78);
    assert.equal(latest.structuredContent.data.latest.value, 78);
    assert.deepEqual(latest.structuredContent.data.freshness.stale_sources, ["WA2456C"]);
    assert.deepEqual(latest.structuredContent.data.freshness.historical_sources, ["WA2456C"]);
    assert.deepEqual(latest.structuredContent.data.freshness.degraded_sources, []);
    assert.equal(latest.structuredContent.data.freshness.by_source.WA2456C.state, "STALE");
    assert.equal(latest.structuredContent.data.freshness.by_source.WA2456C.lifecycle, "HISTORICAL");
    assert.equal(latest.structuredContent.data.freshness.data_as_of, 1_786_245_212_000);
    assert.match(latest.content[0].text, /HISTORICAL SOURCE, read on demand/);
    assert.match(latest.content[0].text, /not a current reading/);

    const steps = await client.callTool({ name: "health_steps", arguments: {} });
    assert.equal(steps.structuredContent.status, "PASS");
    assert.equal(steps.structuredContent.data.records[0].metric, "step_count_sensor");
    assert.equal(steps.structuredContent.data.steps.watch.freshness.by_source.WA2456C.state, "STALE");
    assert.equal(steps.structuredContent.data.steps.watch.freshness.by_source.WA2456C.lifecycle, "HISTORICAL");
    assert.match(steps.content[0].text, /cumulative since boot; not a calendar-day total/);

    const datedSteps = await client.callTool({
      name: "health_steps",
      arguments: { date: "2026-08-09", timezone_offset_minutes: 480 },
    });
    assert.equal(datedSteps.structuredContent.status, "DEGRADED");
    assert.equal(datedSteps.structuredContent.data.steps.watch.step_count_sensor.value, 3456);
    assert.equal(datedSteps.structuredContent.data.steps.phone.value, 4000);
    assert.equal(datedSteps.structuredContent.data.steps.phone.source_day, "2026-08-09");
    assert.match(datedSteps.content[0].text, /sources are returned side by side; no merge or precedence/);

    const today = await client.callTool({
      name: "health_today",
      arguments: {
        date: "2026-08-09",
        timezone_offset_minutes: 480,
        metrics: ["step_count_sensor", "phone_step_count", "phone_distance", "phone_calories"],
      },
    });
    assert.equal(today.structuredContent.data.metrics.step_count_sensor.daily_value, 3456);
    assert.equal(today.structuredContent.data.daily_summaries.vivo_phone.phone_step_count.value, 4000);
    assert.equal(today.structuredContent.data.daily_summaries.vivo_phone.phone_distance.value, 2800.5);

    const ambiguousTime = await client.callTool({
      name: "health_heart_rate",
      arguments: { at: "August 9, 2026" },
    });
    assert.equal(ambiguousTime.isError, true);
    assert.match(ambiguousTime.content[0].text, /explicit UTC offset/);

    const start = await client.callTool({
      name: "health_start_session",
      arguments: { source_device: "WA2456C", label: "MCP e2e fixture" },
    });
    assert.equal(start.structuredContent.data.session.status, "OPEN");
    const sessionId = start.structuredContent.data.session.session_id;

    const stop = await client.callTool({
      name: "health_stop_session",
      arguments: { session_id: sessionId },
    });
    assert.equal(stop.structuredContent.data.session.status, "CLOSED");

    const summary = await client.callTool({
      name: "health_session_summary",
      arguments: { session_id: sessionId },
    });
    assert.equal(summary.structuredContent.status, "NO_DATA");
    assert.match(summary.structuredContent.data.interpretation, /does not establish/);
  } finally {
    await client.close();
    await service.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  assert.ok(stderr.some((line) => line.includes("MCP listening on stdio")));
});

test("MCP answers phone sleep and phone vitals beside the watch, with explicit sources", async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "akari-mcp-vivo-test-"));
  const token = "mcp-vivo-token";
  const service = createHealthService({
    host: "127.0.0.1",
    port: 0,
    token,
    databasePath: path.join(temporaryDirectory, "health.sqlite"),
    maxBodyBytes: 1024 * 1024,
  });
  const address = await service.listen();
  const serviceUrl = `http://127.0.0.1:${address.port}`;
  const post = async (route, body) => {
    const response = await fetch(`${serviceUrl}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 202);
  };

  // Synthetic fixture values: the shape is the verified one, the numbers are not anyone's.
  const sleepStart = Date.parse("2026-01-02T01:00:00+08:00");
  const sleepEnd = Date.parse("2026-01-02T09:00:00+08:00");
  const watchAt = Date.parse("2026-01-02T18:00:00+08:00");
  const phoneAt = Date.parse("2026-01-02T19:30:00+08:00");

  await post("/v1/health/sleep-summaries", {
    batch_id: "mcp-sleep-fixture",
    producer: "akari-pulse-android-fixture",
    summaries: [{
      source: "vivo_phone",
      source_day: "2026-01-02",
      source_timezone: "Asia/Shanghai",
      source_day_start: Date.parse("2026-01-02T00:00:00+08:00"),
      sleep_start: sleepStart,
      sleep_end: sleepEnd,
      sampled_at: "2026-01-02T20:00:00+08:00",
      status: "PASS",
      outcome: "PROVIDER_CALL_SUCCEEDED",
      verification: "VERIFIED",
      recorder_generation: 2,
      low_accuracy: false,
      score: 64,
      deep_sleep_continuity: 90,
      total_duration_ms: 26_400_000,
      night_sleep_duration_ms: 26_400_000,
      nap_duration_ms: 0,
      chart_total_duration_ms: 28_800_000,
      light_sleep_duration_ms: 17_400_000,
      deep_sleep_duration_ms: 3_600_000,
      rem_sleep_duration_ms: 5_400_000,
      awake_duration_ms: 2_400_000,
      awake_episode_count: 2,
      awake_episode_duration_ms: 1_200_000,
      stages: { deep: [{ start: sleepStart + 3_600_000, end: sleepStart + 7_200_000 }] },
    }],
  });

  // A nap read later the same day is a second session and must not displace the night row.
  const napStart = Date.parse("2026-01-02T15:20:00+08:00");
  const napEnd = Date.parse("2026-01-02T16:03:00+08:00");
  await post("/v1/health/sleep-summaries", {
    batch_id: "mcp-nap-fixture",
    producer: "akari-pulse-android-fixture",
    summaries: [{
      source: "vivo_phone",
      source_day: "2026-01-02",
      source_timezone: "Asia/Shanghai",
      source_day_start: Date.parse("2026-01-02T00:00:00+08:00"),
      sleep_start: napStart,
      sleep_end: napEnd,
      sampled_at: "2026-01-02T16:30:00+08:00",
      status: "PASS",
      outcome: "PROVIDER_CALL_SUCCEEDED",
      verification: "VERIFIED",
      recorder_generation: 2,
      low_accuracy: false,
      score: 0,
      deep_sleep_continuity: 0,
      total_duration_ms: 2_580_000,
      night_sleep_duration_ms: 0,
      nap_duration_ms: 2_580_000,
      chart_total_duration_ms: 2_580_000,
      light_sleep_duration_ms: 0,
      deep_sleep_duration_ms: 0,
      rem_sleep_duration_ms: 0,
      awake_duration_ms: 0,
      awake_episode_count: 0,
      awake_episode_duration_ms: 0,
      stages: { light: [], deep: [], rem: [], awake: [] },
    }],
  });

  await post("/v1/health/batches", {
    batch_id: "mcp-vivo-vitals-fixture",
    producer: "akari-pulse-android-fixture",
    events: [
      ["heart_rate", 71, "bpm", "WA2456C", watchAt],
      ["spo2", 98, "%", "WA2456C", watchAt],
      ["stress", 41, "", "WA2456C", watchAt],
      ["phone_heart_rate", 70, "bpm", "vivo_phone", phoneAt],
      ["phone_spo2", 96, "%", "vivo_phone", phoneAt - 600_000],
      ["phone_stress", 30, "score", "vivo_phone", phoneAt - 300_000],
    ].map(([metric, value, unit, device, timestamp]) => ({
      event_id: `${metric}-${timestamp}`,
      timestamp,
      metric,
      value,
      ...(unit === "" ? {} : { unit }),
      source_device: device,
      ...(device === "vivo_phone"
        ? {
            source_module: "VIVO_WATCH",
            source_api: "com.vivo.health.provider.care/healthCare#MYSELF_DATA",
            quality: "latest_snapshot",
          }
        : {}),
      status: "PASS",
    })),
  });

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
  environment.AKARI_HEALTH_URL = serviceUrl;
  environment.AKARI_HEALTH_TOKEN = token;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "akari-health-vivo-e2e-test", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );

  try {
    await client.connect(transport);

    const sleep = await client.callTool({ name: "health_sleep", arguments: {} });
    assert.equal(sleep.structuredContent.status, "DEGRADED");
    const daySummaries = sleep.structuredContent.data.phone_sleep.summaries;
    assert.equal(daySummaries.length, 2);
    const night = daySummaries[0];
    assert.equal(night.source, "vivo_phone");
    assert.equal(night.source_day, "2026-01-02");
    assert.equal(night.sleep_start, sleepStart);
    assert.equal(night.sleep_end, sleepEnd);
    assert.equal(night.total_duration_ms, 26_400_000);
    assert.equal(night.deep_sleep_duration_ms, 3_600_000);
    assert.equal(night.light_sleep_duration_ms, 17_400_000);
    assert.equal(night.rem_sleep_duration_ms, 5_400_000);
    assert.equal(night.awake_episode_count, 2);
    assert.equal(night.awake_episode_duration_ms, 1_200_000);
    assert.equal(night.score, 64);
    assert.equal(night.deep_sleep_continuity, 90);
    const nap = daySummaries[1];
    assert.equal(nap.sleep_start, napStart);
    assert.equal(nap.total_duration_ms, 2_580_000);
    assert.equal(nap.nap_duration_ms, 2_580_000);
    assert.match(sleep.content[0].text, /2026-01-02 night/);
    assert.match(sleep.content[0].text, /2026-01-02 nap/);
    assert.match(sleep.content[0].text, /sources are returned side by side; no merge or precedence/);

    const datedSleep = await client.callTool({
      name: "health_sleep",
      arguments: { date: "2026-01-03" },
    });
    assert.deepEqual(datedSleep.structuredContent.data.phone_sleep.summaries, []);

    // A window holding no sleep returns none. The night ended hours earlier and
    // is outside the window — being the most recent stored night does not put it
    // back in. Midday with no nap is an empty answer, not last night's answer.
    const middayWindow = await client.callTool({
      name: "health_sleep",
      arguments: { from: "2026-01-02T12:00:00+08:00", to: "2026-01-02T13:00:00+08:00" },
    });
    assert.deepEqual(middayWindow.structuredContent.data.phone_sleep.summaries, []);
    assert.match(middayWindow.content[0].text, /no vivo sleep session in the requested scope/);

    // Overlap decides membership, so each window returns the session it actually
    // covers: the afternoon nap, or the tail of the night, never both.
    const napWindow = await client.callTool({
      name: "health_sleep",
      arguments: { from: "2026-01-02T15:30:00+08:00", to: "2026-01-02T15:45:00+08:00" },
    });
    assert.equal(napWindow.structuredContent.data.phone_sleep.summaries.length, 1);
    assert.equal(napWindow.structuredContent.data.phone_sleep.summaries[0].sleep_start, napStart);

    const morningWindow = await client.callTool({
      name: "health_sleep",
      arguments: { from: "2026-01-02T08:30:00+08:00", to: "2026-01-02T10:00:00+08:00" },
    });
    assert.equal(morningWindow.structuredContent.data.phone_sleep.summaries.length, 1);
    assert.equal(morningWindow.structuredContent.data.phone_sleep.summaries[0].sleep_start, sleepStart);

    for (const [tool, watchMetric, phoneMetric, watchValue, phoneValue] of [
      ["health_heart_rate", "heart_rate", "phone_heart_rate", 71, 70],
      ["health_spo2", "spo2", "phone_spo2", 98, 96],
      ["health_stress", "stress", "phone_stress", 41, 30],
    ]) {
      const result = await client.callTool({ name: tool, arguments: {} });
      const { records, latest, latest_by_source: latestBySource } = result.structuredContent.data;
      const byMetric = Object.fromEntries(records.map((record) => [record.metric, record]));
      assert.equal(byMetric[watchMetric].value, watchValue, `${tool} watch value`);
      assert.equal(byMetric[watchMetric].source_device, "WA2456C");
      assert.equal(byMetric[phoneMetric].value, phoneValue, `${tool} phone value`);
      assert.equal(byMetric[phoneMetric].source_device, "vivo_phone");
      // Every phone reading in this fixture is newer than its watch counterpart,
      // so the newest observation is named outright and sits first. No caller
      // should have to infer a source precedence from record order.
      assert.deepEqual(
        records.map((record) => record.timestamp),
        [...records.map((record) => record.timestamp)].sort((a, b) => b - a),
        `${tool} newest first`,
      );
      assert.equal(latest.metric, phoneMetric, `${tool} latest metric`);
      assert.equal(latest.value, phoneValue, `${tool} latest value`);
      assert.equal(latestBySource.WA2456C.metric, watchMetric);
      assert.equal(latestBySource.vivo_phone.metric, phoneMetric);
      assert.match(result.content[0].text, /side by side, newest first/);
    }

    const windowed = await client.callTool({
      name: "health_heart_rate",
      arguments: { at: watchAt, window_ms: 60_000 },
    });
    assert.equal(windowed.structuredContent.data.record.value, 71);
    assert.equal(windowed.structuredContent.data.phone_latest_snapshot.value, 70);
    assert.match(
      windowed.structuredContent.data.phone_latest_snapshot_semantics,
      /not a daily aggregate/,
    );

    const status = await client.callTool({ name: "health_status", arguments: {} });
    // Counts session rows: the fixture day stores its night sleep and its nap.
    assert.equal(status.structuredContent.data.database.sleep_summary_count, 2);
    assert.equal(status.structuredContent.data.database.sleep_summary_latest_day, "2026-01-02");
    assert.equal(status.structuredContent.data.layers.vivo_private_health.status, "NO_DATA");
  } finally {
    await client.close();
    await service.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

// health_activity used to ask /v1/health/today for watch metrics only, and that
// route reads phone daily summaries only for the phone metrics it was asked for.
// So on a day the phone had steps, distance and calories stored — and
// health_today returned them — health_activity answered NO_DATA with an empty
// daily_summaries. The fixture is stamped at the current moment so the live path
// is exercised: a reporting source, PASS, and no staleness anywhere.
test("health_activity returns the live phone daily summaries with their source semantics", async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "akari-mcp-activity-test-"));
  const token = "mcp-activity-token";
  const service = createHealthService({
    host: "127.0.0.1",
    port: 0,
    token,
    databasePath: path.join(temporaryDirectory, "health.sqlite"),
    maxBodyBytes: 1024 * 1024,
  });
  const address = await service.listen();
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  // Synthetic fixture values: the shape is the verified one, the numbers are not
  // anyone's. Whole seconds — the provider's sampled_at carries no sub-second component.
  const sampledAtMs = Math.floor((Date.now() - 300_000) / 1000) * 1000;
  const shanghai = new Date(sampledAtMs + 480 * 60_000);
  const sourceDay = shanghai.toISOString().slice(0, 10);
  const sampledAt = `${shanghai.toISOString().slice(0, 19)}+08:00`;

  const ingest = await fetch(`${serviceUrl}/v1/health/daily-summaries`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      batch_id: "mcp-activity-fixture",
      producer: "akari-pulse-android-fixture",
      summaries: [
        ["phone_step_count", "count", 4200, "VERIFIED"],
        ["phone_distance", "m", 3120.75, "VERIFIED_FORMATTED_DISPLAY"],
        ["phone_calories", "kcal", 205.4, "VERIFIED_FORMATTED_DISPLAY"],
      ].map(([metric, unit, value, verification]) => ({
        source: "vivo_phone",
        metric,
        source_day: sourceDay,
        source_timezone: "Asia/Shanghai",
        value,
        unit,
        sampled_at: sampledAt,
        source_timestamp_available: false,
        status: "PASS",
        outcome: "PROVIDER_CALL_SUCCEEDED",
        verification,
      })),
    }),
  });
  assert.equal(ingest.status, 202);

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
  environment.AKARI_HEALTH_URL = serviceUrl;
  environment.AKARI_HEALTH_TOKEN = token;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "akari-health-activity-e2e-test", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );

  try {
    await client.connect(transport);

    const activity = await client.callTool({
      name: "health_activity",
      arguments: { date: sourceDay, timezone_offset_minutes: 480 },
    });
    assert.equal(activity.structuredContent.status, "PASS");
    const phone = activity.structuredContent.data.daily_summaries.vivo_phone;
    assert.equal(phone.phone_distance.value, 3120.75);
    assert.equal(phone.phone_calories.value, 205.4);
    assert.equal(phone.phone_step_count.value, 4200);
    // Provenance travels with the value, not just the number.
    assert.equal(phone.phone_distance.source, "vivo_phone");
    assert.equal(phone.phone_distance.source_day, sourceDay);
    assert.equal(phone.phone_distance.source_timezone, "Asia/Shanghai");
    assert.equal(phone.phone_distance.sampled_at, sampledAt);
    assert.equal(phone.phone_distance.verification, "VERIFIED_FORMATTED_DISPLAY");
    assert.equal(phone.phone_step_count.verification, "VERIFIED");
    assert.match(activity.content[0].text, /vivo_phone phone_distance: 3120\.75 m/);

    // A live source is PASS, and data_as_of is the provider read behind it —
    // not the moment this response happened to be generated.
    assert.deepEqual(activity.structuredContent.data.freshness.stale_sources, []);
    assert.equal(activity.structuredContent.data.freshness.by_source.vivo_phone.state, "FRESH");
    assert.equal(activity.structuredContent.data.freshness.data_as_of, sampledAtMs);
    assert.ok(activity.structuredContent.generated_at >= sampledAtMs);

    // With no arguments at all the calendar day still resolves in the provider's
    // zone, so the same summaries come back without the caller naming a date.
    const undated = await client.callTool({ name: "health_activity", arguments: {} });
    assert.equal(undated.structuredContent.data.timezone, "Asia/Shanghai");
    assert.equal(undated.structuredContent.data.timezone_offset_minutes, 480);
    assert.equal(undated.structuredContent.data.timezone_source, "provider_default");
    assert.equal(undated.structuredContent.data.date, sourceDay);
    assert.equal(undated.structuredContent.data.daily_summaries.vivo_phone.phone_calories.value, 205.4);
  } finally {
    await client.close();
    await service.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
