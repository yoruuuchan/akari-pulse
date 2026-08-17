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

test("bpm-family value 0 is excluded from PASS reads but preserved under ALL", async () => {
  await withService(async ({ request, fixedNow }) => {
    // Real store contents include a legacy zero-shape PASS record (from 0.1.2 era)
    // plus fresh nonzero readings. The zero must never surface as a legal
    // observation in latest/range/today (the routes MCP consumes), but it must
    // remain visible under status=ALL and countable in diagnostics.
    const batch = {
      batch_id: "bpm-zero-guard-batch",
      producer: "test",
      events: [
        {
          event_id: "hr-legacy-zero",
          timestamp: fixedNow - 60_000,
          metric: "heart_rate",
          value: 0,
          unit: "bpm",
          source_device: "WA2456C",
          status: "PASS",
        },
        {
          event_id: "hr-real",
          timestamp: fixedNow - 30_000,
          metric: "heart_rate",
          value: 72,
          unit: "bpm",
          source_device: "WA2456C",
          status: "PASS",
        },
        {
          event_id: "hr-today-min-sentinel",
          timestamp: fixedNow - 10_000,
          metric: "heart_rate_today_min",
          value: 0,
          unit: "bpm",
          source_device: "WA2456C",
          status: "PASS",
        },
        {
          event_id: "hr-today-max-real",
          timestamp: fixedNow - 10_000,
          metric: "heart_rate_today_max",
          value: 178,
          unit: "bpm",
          source_device: "WA2456C",
          status: "PASS",
        },
      ],
    };
    const ingest = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify(batch),
    });
    assert.equal(ingest.response.status, 202);
    assert.equal(ingest.body.data.accepted, 4);

    // Default PASS filter: only the nonzero HR record surfaces for heart_rate.
    const latestHr = await request("/v1/health/latest?metric=heart_rate");
    assert.equal(latestHr.body.status, "PASS");
    assert.equal(latestHr.body.data.records.length, 1);
    assert.equal(latestHr.body.data.records[0].value, 72);

    // heart_rate_today_min with value 0 is excluded entirely under PASS.
    const latestMin = await request("/v1/health/latest?metric=heart_rate_today_min");
    assert.equal(latestMin.body.status, "NO_DATA");
    assert.equal(latestMin.body.data.records.length, 0);

    // heart_rate_today_max nonzero remains legal.
    const latestMax = await request("/v1/health/latest?metric=heart_rate_today_max");
    assert.equal(latestMax.body.status, "PASS");
    assert.equal(latestMax.body.data.records[0].value, 178);

    // Range query is filtered the same way.
    const rangeHr = await request(`/v1/health/range?metric=heart_rate&from=0&to=${fixedNow + 1}`);
    assert.equal(rangeHr.body.data.records.length, 1);
    assert.equal(rangeHr.body.data.records[0].value, 72);

    // Under status=ALL the raw zero records remain visible for diagnostics.
    const rangeAll = await request(
      `/v1/health/range?metrics=heart_rate,heart_rate_today_min&from=0&to=${fixedNow + 1}&status=ALL`,
    );
    const returnedIds = rangeAll.body.data.records.map((record) => record.event_id).sort();
    assert.deepEqual(returnedIds, [
      "hr-legacy-zero",
      "hr-real",
      "hr-today-min-sentinel",
    ]);

    // record_count still counts every stored record (append-only store untouched).
    const status = await request("/v1/status");
    assert.equal(status.body.data.database.record_count, 4);
  });
});

test("bridge-only layers report NOT_APPLICABLE on the relay-only path", async () => {
  await withService(async ({ request }) => {
    const status = await request("/v1/status");
    const layers = status.body.data.layers;
    for (const bridgeLayer of ["phone_receive", "phone_persistence", "uplink"]) {
      assert.equal(
        layers[bridgeLayer].status,
        "NOT_APPLICABLE",
        `${bridgeLayer} should be NOT_APPLICABLE when no bridge records exist`,
      );
      assert.equal(layers[bridgeLayer].note, "watch receiver bridge fallback; not on the active watch relay route");
    }
    // Non-bridge layer without evidence remains NO_DATA (not NOT_APPLICABLE).
    assert.equal(layers.watch_module_api.status, "NO_DATA");
  });
});

test("a real diagnostic record for a bridge-only layer wins over NOT_APPLICABLE", async () => {
  await withService(async ({ request, fixedNow }) => {
    const batch = {
      batch_id: "bridge-diag-batch",
      producer: "android-bridge-test",
      events: [
        {
          event_id: "bridge-uplink-pass",
          timestamp: fixedNow - 5_000,
          metric: "diagnostic_uplink",
          value: "observed",
          source_device: "vivo-x200-pro",
          status: "PASS",
        },
      ],
    };
    const ingest = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify(batch),
    });
    assert.equal(ingest.response.status, 202);

    const status = await request("/v1/status");
    const layers = status.body.data.layers;
    assert.equal(layers.uplink.status, "PASS");
    assert.equal(layers.uplink.source_device, "vivo-x200-pro");
    // Other bridge-only layers still have no records → NOT_APPLICABLE.
    assert.equal(layers.phone_receive.status, "NOT_APPLICABLE");
    assert.equal(layers.phone_persistence.status, "NOT_APPLICABLE");
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

// WA2456C is the BlueOS watch quick app: it has no scheduler and no background
// service, so every observation it ever produced came from someone opening the
// sideloaded app and pressing a collect button. Its silence is the resting state
// of a manual harness, not an outage — but its data is genuinely old, and the
// response has to say both things at once.
test("a historical source's silence is visible but does not degrade production health", async () => {
  await withService(async ({ request, fixedNow }) => {
    const longAgo = fixedNow - 5 * 86_400_000;
    const ingest = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "lifecycle-watch-batch",
        producer: "watch-test",
        events: [{
          event_id: "lifecycle-watch-hr",
          timestamp: longAgo,
          metric: "heart_rate",
          value: 74,
          unit: "bpm",
          source_device: "WA2456C",
          status: "PASS",
        }],
      }),
    });
    assert.equal(ingest.response.status, 202);

    const watchOnly = await request("/v1/health/latest?metric=heart_rate");
    // The reading is still returned, still five days old, and still labelled stale.
    assert.equal(watchOnly.body.data.records[0].value, 74);
    assert.equal(watchOnly.body.data.records[0].timestamp, longAgo);
    const watchSource = watchOnly.body.data.freshness.by_source.WA2456C;
    assert.equal(watchSource.state, "STALE");
    assert.equal(watchSource.lifecycle, "HISTORICAL");
    assert.equal(watchSource.counts_toward_production_health, false);
    assert.equal(watchSource.source_age_ms, 5 * 86_400_000);
    assert.deepEqual(watchOnly.body.data.freshness.stale_sources, ["WA2456C"]);
    assert.deepEqual(watchOnly.body.data.freshness.historical_sources, ["WA2456C"]);
    // ...but a source nobody asked to report cannot be late, so the read passes.
    assert.deepEqual(watchOnly.body.data.freshness.degraded_sources, []);
    assert.equal(watchOnly.body.status, "PASS");

    const status = await request("/v1/status");
    assert.equal(status.body.status, "PASS");
    assert.deepEqual(status.body.data.freshness.stale_sources, ["WA2456C"]);
    assert.deepEqual(status.body.data.freshness.degraded_sources, []);
    assert.equal(status.body.data.layers.watch_module_api.status, "NO_DATA");

    // The active production feed is held to the opposite standard: the same age
    // on vivo_phone is a fault and does degrade the pipeline.
    const phoneIngest = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "lifecycle-phone-batch",
        producer: "phone-test",
        events: [{
          event_id: "lifecycle-phone-hr",
          timestamp: longAgo,
          metric: "phone_heart_rate",
          value: 66,
          unit: "bpm",
          source_device: "vivo_phone",
          status: "PASS",
        }],
      }),
    });
    assert.equal(phoneIngest.response.status, 202);

    const both = await request("/v1/health/latest?metrics=heart_rate,phone_heart_rate");
    assert.equal(both.body.data.records.length, 2);
    assert.equal(both.body.data.freshness.by_source.vivo_phone.lifecycle, "ACTIVE");
    assert.equal(both.body.data.freshness.by_source.vivo_phone.counts_toward_production_health, true);
    assert.deepEqual(both.body.data.freshness.degraded_sources, ["vivo_phone"]);
    assert.equal(both.body.status, "DEGRADED");

    const degradedStatus = await request("/v1/status");
    assert.equal(degradedStatus.body.status, "DEGRADED");
    assert.deepEqual(degradedStatus.body.data.freshness.degraded_sources, ["vivo_phone"]);
    assert.deepEqual(degradedStatus.body.data.freshness.stale_sources.sort(), ["WA2456C", "vivo_phone"]);
  });
});
