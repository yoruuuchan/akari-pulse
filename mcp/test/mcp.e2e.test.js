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
    assert.equal(listed.tools.find((tool) => tool.name === "health_latest").annotations.readOnlyHint, true);
    assert.equal(listed.tools.find((tool) => tool.name === "health_start_session").annotations.readOnlyHint, false);

    const status = await client.callTool({ name: "health_status", arguments: {} });
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.data.database.record_count, 2);
    assert.equal(status.structuredContent.data.database.daily_summary_count, 3);
    assert.equal(status.structuredContent.data.layers.mcp_query.status, "PASS");

    const latest = await client.callTool({
      name: "health_latest",
      arguments: { metric: "heart_rate" },
    });
    assert.equal(latest.structuredContent.status, "PASS");
    assert.equal(latest.structuredContent.data.records[0].value, 78);

    const steps = await client.callTool({ name: "health_steps", arguments: {} });
    assert.equal(steps.structuredContent.status, "PASS");
    assert.equal(steps.structuredContent.data.records[0].metric, "step_count_sensor");
    assert.match(steps.content[0].text, /cumulative since boot; not a calendar-day total/);

    const datedSteps = await client.callTool({
      name: "health_steps",
      arguments: { date: "2026-08-09", timezone_offset_minutes: 480 },
    });
    assert.equal(datedSteps.structuredContent.status, "PASS");
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
    assert.equal(sleep.structuredContent.status, "PASS");
    const night = sleep.structuredContent.data.phone_sleep.summaries[0];
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
    assert.match(sleep.content[0].text, /sources are returned side by side; no merge or precedence/);

    const datedSleep = await client.callTool({
      name: "health_sleep",
      arguments: { date: "2026-01-03" },
    });
    assert.deepEqual(datedSleep.structuredContent.data.phone_sleep.summaries, []);

    for (const [tool, watchMetric, phoneMetric, watchValue, phoneValue] of [
      ["health_heart_rate", "heart_rate", "phone_heart_rate", 71, 70],
      ["health_spo2", "spo2", "phone_spo2", 98, 96],
      ["health_stress", "stress", "phone_stress", 41, 30],
    ]) {
      const result = await client.callTool({ name: tool, arguments: {} });
      const byMetric = Object.fromEntries(
        result.structuredContent.data.records.map((record) => [record.metric, record]),
      );
      assert.equal(byMetric[watchMetric].value, watchValue, `${tool} watch value`);
      assert.equal(byMetric[watchMetric].source_device, "WA2456C");
      assert.equal(byMetric[phoneMetric].value, phoneValue, `${tool} phone value`);
      assert.equal(byMetric[phoneMetric].source_device, "vivo_phone");
      assert.match(result.content[0].text, /side by side; no merge or precedence/);
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
    assert.equal(status.structuredContent.data.database.sleep_summary_count, 1);
    assert.equal(status.structuredContent.data.database.sleep_summary_latest_day, "2026-01-02");
    assert.equal(status.structuredContent.data.layers.vivo_private_health.status, "NO_DATA");
  } finally {
    await client.close();
    await service.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
