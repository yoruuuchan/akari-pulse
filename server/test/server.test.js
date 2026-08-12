import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHealthService } from "../src/app.js";
import { loadConfig } from "../src/config.js";

async function withService(run) {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "akari-health-test-"));
  const fixedNow = 1_786_245_300_000;
  const service = createHealthService(
    {
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      databasePath: path.join(temporaryDirectory, "health.sqlite"),
      maxBodyBytes: 1024 * 1024,
    },
    { now: () => fixedNow },
  );
  const address = await service.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (route, options = {}) => {
    const headers = {
      authorization: "Bearer test-token",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    };
    const response = await fetch(`${baseUrl}${route}`, { ...options, headers });
    return { response, body: await response.json() };
  };
  try {
    await run({ request, baseUrl, fixedNow });
  } finally {
    await service.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("non-loopback binding requires an explicit token", () => {
  assert.throws(
    () => loadConfig({ AKARI_HEALTH_HOST: "0.0.0.0", AKARI_HEALTH_PORT: "8787" }),
    /AKARI_HEALTH_TOKEN is required/,
  );
});

test("health ingest is authenticated, append-only, idempotent, and queryable", async () => {
  await withService(async ({ request, baseUrl, fixedNow }) => {
    const liveness = await fetch(`${baseUrl}/healthz`);
    assert.equal(liveness.status, 200);

    const unauthorized = await fetch(`${baseUrl}/v1/status`);
    assert.equal(unauthorized.status, 401);

    const sessionStart = fixedNow - 120_000;
    const sessionResponse = await request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        session_id: "session-alpha",
        source_device: "WA2456C",
        label: "message response",
        started_at: sessionStart,
      }),
    });
    assert.equal(sessionResponse.response.status, 201);
    assert.equal(sessionResponse.body.data.session.status, "OPEN");

    const correlationAt = sessionStart + 60_000;
    const batch = {
      batch_id: "batch-001",
      producer: "android-bridge-test",
      sent_at: fixedNow - 1_000,
      events: [
        {
          event_id: "hr-1",
          timestamp: sessionStart + 10_000,
          metric: "heart_rate",
          value: 70,
          unit: "bpm",
          source_device: "WA2456C",
          source_module: "@blueos.health.health",
          source_api: "health.subscribeSample",
          status: "PASS",
          callback_delta_ms: 5_000,
        },
        {
          event_id: "hr-2",
          timestamp: sessionStart + 30_000,
          metric: "heart_rate",
          value: 72,
          unit: "bpm",
          source_device: "WA2456C",
          source_module: "@blueos.health.health",
          source_api: "health.subscribeSample",
          status: "PASS",
          callback_delta_ms: 20_000,
        },
        {
          event_id: "hr-3",
          timestamp: correlationAt + 10_000,
          metric: "heart_rate",
          value: 80,
          unit: "bpm",
          source_device: "WA2456C",
          source_module: "@blueos.health.health",
          source_api: "health.subscribeSample",
          status: "PASS",
          callback_delta_ms: 40_000,
        },
        {
          event_id: "hr-4",
          timestamp: correlationAt + 30_000,
          metric: "heart_rate",
          value: 88,
          unit: "bpm",
          source_device: "WA2456C",
          source_module: "@blueos.health.health",
          source_api: "health.subscribeSample",
          status: "PASS",
          callback_delta_ms: 20_000,
        },
        {
          event_id: "spo2-denied",
          timestamp: sessionStart + 20_000,
          metric: "spo2",
          unit: "%",
          source_device: "WA2456C",
          source_module: "@blueos.health.health",
          source_api: "health.getRecentSamples",
          status: "DENIED",
          raw_error_code: 400,
          raw_error_message: "permission denied fixture",
        },
      ],
    };

    const ingest = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify(batch),
    });
    assert.equal(ingest.response.status, 202);
    assert.deepEqual(
      { accepted: ingest.body.data.accepted, duplicates: ingest.body.data.duplicates, replayed: ingest.body.data.replayed },
      { accepted: 5, duplicates: 0, replayed: false },
    );

    const replay = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify(batch),
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.data.replayed, true);

    const conflictingBatch = structuredClone(batch);
    conflictingBatch.events[0].value = 999;
    const batchConflict = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify(conflictingBatch),
    });
    assert.equal(batchConflict.response.status, 409);
    assert.equal(batchConflict.body.error.code, "BATCH_ID_CONFLICT");

    const eventConflict = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "batch-with-conflicting-event",
        producer: "android-bridge-test",
        events: [
          {
            ...batch.events[0],
            value: 999,
          },
        ],
      }),
    });
    assert.equal(eventConflict.response.status, 409);
    assert.equal(eventConflict.body.error.code, "EVENT_ID_CONFLICT");

    const latestHeartRate = await request("/v1/health/latest?metric=heart_rate");
    assert.equal(latestHeartRate.body.status, "PASS");
    assert.equal(latestHeartRate.body.data.records[0].value, 88);
    assert.equal(latestHeartRate.body.data.records[0].session_id, "session-alpha");
    assert.equal(latestHeartRate.body.data.records[0].session_assignment, "TIME_WINDOW");

    const denied = await request("/v1/health/latest?metric=spo2&status=ALL");
    assert.equal(denied.body.data.records[0].status, "DENIED");
    assert.equal(Object.hasOwn(denied.body.data.records[0], "value"), false);
    assert.equal(denied.body.data.records[0].raw_error_code, "400");

    const correlation = await request("/v1/events", {
      method: "POST",
      body: JSON.stringify({
        event_id: "chat-message-001",
        timestamp: correlationAt,
        source: "chatgpt",
        event_type: "message",
        session_id: "session-alpha",
        metadata: { role: "assistant" },
      }),
    });
    assert.equal(correlation.response.status, 201);

    const correlationReplay = await request("/v1/events", {
      method: "POST",
      body: JSON.stringify({
        event_id: "chat-message-001",
        timestamp: correlationAt,
        source: "chatgpt",
        event_type: "message",
        session_id: "session-alpha",
        metadata: { role: "assistant" },
      }),
    });
    assert.equal(correlationReplay.response.status, 200);
    assert.equal(correlationReplay.body.data.duplicate, true);

    const correlationConflict = await request("/v1/events", {
      method: "POST",
      body: JSON.stringify({
        event_id: "chat-message-001",
        timestamp: correlationAt,
        source: "chatgpt",
        event_type: "message",
        session_id: "session-alpha",
        metadata: { role: "user" },
      }),
    });
    assert.equal(correlationConflict.response.status, 409);
    assert.equal(correlationConflict.body.error.code, "CORRELATION_EVENT_ID_CONFLICT");

    const stop = await request("/v1/sessions/session-alpha/stop", {
      method: "POST",
      body: JSON.stringify({ ended_at: sessionStart + 110_000 }),
    });
    assert.equal(stop.body.data.session.status, "CLOSED");

    const summary = await request("/v1/sessions/session-alpha/summary");
    assert.equal(summary.body.status, "PASS");
    assert.equal(summary.body.data.coverage.heart_rate_samples, 4);
    assert.equal(summary.body.data.heart_rate.maximum_bpm, 88);
    assert.equal(summary.body.data.correlations[0].baseline_bpm, 71);
    assert.equal(summary.body.data.correlations[0].delta_bpm, 17);
    assert.equal(summary.body.data.correlations[0].latency_to_rise_ms, 10_000);
    assert.equal(summary.body.data.correlations[0].time_to_peak_ms, 30_000);
    assert.match(summary.body.data.interpretation, /does not establish/);

    const status = await request("/v1/status");
    assert.equal(status.body.data.database.record_count, 5);
    assert.equal(status.body.data.database.counts_by_status.DENIED, 1);
    assert.equal(status.body.data.layers.backend_ingest.status, "PASS");
  });
});

test("invalid PASS observations are rejected instead of becoming zero", async () => {
  await withService(async ({ request, fixedNow }) => {
    const result = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "invalid-batch",
        producer: "test",
        events: [
          {
            event_id: "missing-value",
            timestamp: fixedNow,
            metric: "heart_rate",
            source_device: "WA2456C",
            status: "PASS",
          },
        ],
      }),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.code, "INVALID_REQUEST");

    const nullValue = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "invalid-null-batch",
        producer: "test",
        events: [
          {
            event_id: "null-value",
            timestamp: fixedNow,
            metric: "heart_rate",
            value: null,
            source_device: "WA2456C",
            status: "PASS",
          },
        ],
      }),
    });
    assert.equal(nullValue.response.status, 400);
    assert.equal(nullValue.body.error.code, "INVALID_REQUEST");

    const status = await request("/v1/status");
    assert.equal(status.body.data.database.record_count, 0);
  });
});

test("JSON ingress accepts parameters but rejects media-type prefixes", async () => {
  await withService(async ({ request }) => {
    const body = JSON.stringify({ source_device: "WA2456C" });
    const accepted = await request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
    });
    assert.equal(accepted.response.status, 201);

    const rejected = await request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/jsonx" },
      body,
    });
    assert.equal(rejected.response.status, 415);
    assert.equal(rejected.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });
});
