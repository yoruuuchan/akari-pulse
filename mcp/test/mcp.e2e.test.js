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
