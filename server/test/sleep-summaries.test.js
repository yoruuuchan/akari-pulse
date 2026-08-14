import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createHealthService } from "../src/app.js";
import { HealthDatabase } from "../src/database.js";

// Fixtures are synthetic. They reproduce the verified vivo sleep-day shape without carrying real
// health values into a public repository.
const DAY = "2026-01-02";
const DAY_START = Date.parse("2026-01-02T00:00:00+08:00");
const SLEEP_START = Date.parse("2026-01-02T01:00:00+08:00");
const SLEEP_END = Date.parse("2026-01-02T09:00:00+08:00");

async function withService(run) {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "akari-sleep-summary-test-"));
  const service = createHealthService(
    {
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      databasePath: path.join(temporaryDirectory, "health.sqlite"),
      maxBodyBytes: 1024 * 1024,
    },
    { now: () => Date.parse("2026-01-02T20:00:00Z") },
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
    await run({ request });
  } finally {
    await service.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function sleepBatch({ batchId, sourceDay = DAY, sampledAt, score = 64, overrides = {} }) {
  return {
    batch_id: batchId,
    producer: "akari-pulse-android-test",
    sent_at: Date.parse(sampledAt),
    summaries: [
      {
        source: "vivo_phone",
        source_day: sourceDay,
        source_timezone: "Asia/Shanghai",
        source_day_start: DAY_START,
        sleep_start: SLEEP_START,
        sleep_end: SLEEP_END,
        sampled_at: sampledAt,
        status: "PASS",
        outcome: "PROVIDER_CALL_SUCCEEDED",
        verification: "VERIFIED",
        recorder_generation: 2,
        low_accuracy: false,
        score,
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
        stages: {
          deep: [{ start: SLEEP_START + 3_600_000, end: SLEEP_START + 7_200_000 }],
          awake: [{ start: SLEEP_START + 10_000_000, end: SLEEP_START + 10_600_000 }],
        },
        ...overrides,
      },
    ],
  };
}

test("a sleep day is keyed by source_day, replaced only by a newer read, and never merged", async () => {
  await withService(async ({ request }) => {
    const first = await request("/v1/health/sleep-summaries", {
      method: "POST",
      body: JSON.stringify(sleepBatch({ batchId: "sleep-1", sampledAt: "2026-01-02T09:30:00+08:00", score: 61 })),
    });
    assert.equal(first.response.status, 202);
    assert.deepEqual(
      { accepted: first.body.data.accepted, duplicates: first.body.data.duplicates, stale: first.body.data.stale },
      { accepted: 1, duplicates: 0, stale: 0 },
    );

    const newer = sleepBatch({ batchId: "sleep-2", sampledAt: "2026-01-02T12:00:00+08:00", score: 64 });
    const second = await request("/v1/health/sleep-summaries", { method: "POST", body: JSON.stringify(newer) });
    assert.equal(second.body.data.accepted, 1);

    const replay = await request("/v1/health/sleep-summaries", { method: "POST", body: JSON.stringify(newer) });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.data.replayed, true);

    const stale = await request("/v1/health/sleep-summaries", {
      method: "POST",
      body: JSON.stringify(sleepBatch({ batchId: "sleep-3", sampledAt: "2026-01-02T08:00:00+08:00", score: 12 })),
    });
    assert.equal(stale.body.data.stale, 1);
    assert.equal(stale.body.data.accepted, 0);

    const read = await request("/v1/health/sleep-summaries");
    assert.equal(read.body.status, "PASS");
    assert.equal(read.body.data.summaries.length, 1);
    const summary = read.body.data.summaries[0];
    assert.equal(summary.source, "vivo_phone");
    assert.equal(summary.source_day, DAY);
    assert.equal(summary.score, 64);
    assert.equal(summary.sleep_start, SLEEP_START);
    assert.equal(summary.sleep_end, SLEEP_END);
    assert.equal(summary.total_duration_ms, 26_400_000);
    assert.equal(summary.awake_episode_count, 2);
    assert.equal(summary.low_accuracy, false);
    assert.equal(summary.recorder_generation, 2);
    assert.deepEqual(Object.keys(summary.stages).sort(), ["awake", "deep"]);

    const byDay = await request(`/v1/health/sleep-summaries?source_day=${DAY}&limit=1`);
    assert.equal(byDay.body.data.summaries.length, 1);
    const missingDay = await request("/v1/health/sleep-summaries?source_day=2026-01-03");
    assert.equal(missingDay.body.status, "NO_DATA");
    assert.equal(missingDay.body.data.summaries.length, 0);
  });
});

test("the same source_day and sampled_at with different content is a conflict, not a silent overwrite", async () => {
  await withService(async ({ request }) => {
    await request("/v1/health/sleep-summaries", {
      method: "POST",
      body: JSON.stringify(sleepBatch({ batchId: "sleep-a", sampledAt: "2026-01-02T09:30:00+08:00", score: 61 })),
    });
    const conflict = await request("/v1/health/sleep-summaries", {
      method: "POST",
      body: JSON.stringify(sleepBatch({ batchId: "sleep-b", sampledAt: "2026-01-02T09:30:00+08:00", score: 90 })),
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, "SLEEP_SUMMARY_VERSION_CONFLICT");

    const read = await request("/v1/health/sleep-summaries");
    assert.equal(read.body.data.summaries[0].score, 61);
  });
});

test("only observed sleep days are accepted; absence never travels as a sleep row", async () => {
  await withService(async ({ request }) => {
    for (const overrides of [
      { status: "NO_DATA" },
      { status: "ERROR", outcome: "PROVIDER_CALL_FAILED" },
      { outcome: "PROVIDER_NO_DATA" },
    ]) {
      const rejected = await request("/v1/health/sleep-summaries", {
        method: "POST",
        body: JSON.stringify(sleepBatch({ batchId: `sleep-${overrides.status ?? overrides.outcome}`, sampledAt: "2026-01-02T09:30:00+08:00", overrides })),
      });
      assert.equal(rejected.response.status, 400);
      assert.equal(rejected.body.error.code, "INVALID_REQUEST");
    }

    const backwards = await request("/v1/health/sleep-summaries", {
      method: "POST",
      body: JSON.stringify(sleepBatch({
        batchId: "sleep-backwards",
        sampledAt: "2026-01-02T09:30:00+08:00",
        overrides: { sleep_end: SLEEP_START - 1 },
      })),
    });
    assert.equal(backwards.response.status, 400);
  });
});

test("phone vitals stay beside watch vitals under their own metric names and source device", async () => {
  await withService(async ({ request }) => {
    const watchAt = Date.parse("2026-01-02T18:00:00+08:00");
    const phoneAt = Date.parse("2026-01-02T19:30:00+08:00");
    const ingest = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "vitals-side-by-side",
        producer: "akari-pulse-android-test",
        events: [
          {
            event_id: "watch-hr",
            timestamp: watchAt,
            metric: "heart_rate",
            value: 71,
            unit: "bpm",
            source_device: "WA2456C",
            status: "PASS",
          },
          {
            event_id: `phone_heart_rate-${phoneAt}`,
            timestamp: phoneAt,
            metric: "phone_heart_rate",
            value: 70,
            unit: "bpm",
            source_device: "vivo_phone",
            source_module: "VIVO_WATCH",
            source_api: "com.vivo.health.provider.care/healthCare#MYSELF_DATA",
            quality: "latest_snapshot",
            status: "PASS",
          },
          {
            event_id: `diagnostic_vivo_private_health-${phoneAt}`,
            timestamp: phoneAt,
            metric: "diagnostic_vivo_private_health",
            value: "GRANTED",
            source_device: "vivo_phone",
            status: "PASS",
          },
        ],
      }),
    });
    assert.equal(ingest.response.status, 202);

    const latest = await request("/v1/health/latest?metrics=heart_rate,phone_heart_rate");
    const byMetric = Object.fromEntries(latest.body.data.records.map((record) => [record.metric, record]));
    assert.equal(byMetric.heart_rate.value, 71);
    assert.equal(byMetric.heart_rate.source_device, "WA2456C");
    assert.equal(byMetric.phone_heart_rate.value, 70);
    assert.equal(byMetric.phone_heart_rate.source_device, "vivo_phone");
    assert.equal(byMetric.phone_heart_rate.quality, "latest_snapshot");

    const status = await request("/v1/status");
    assert.equal(status.body.data.layers.vivo_private_health.status, "PASS");
    assert.equal(status.body.data.database.sleep_summary_count, 0);

    await request("/v1/health/sleep-summaries", {
      method: "POST",
      body: JSON.stringify(sleepBatch({ batchId: "sleep-status", sampledAt: "2026-01-02T09:30:00+08:00" })),
    });
    const afterSleep = await request("/v1/status");
    assert.equal(afterSleep.body.data.database.sleep_summary_count, 1);
    assert.equal(afterSleep.body.data.database.sleep_summary_latest_day, DAY);
    assert.equal(afterSleep.body.data.last_sleep_summary_ingest.accepted, 1);
  });
});

test("a version 2 database gains the sleep tables in place, keeping its existing rows", () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "akari-sleep-migration-test-"));
  const databasePath = path.join(temporaryDirectory, "health.sqlite");
  try {
    const initial = new HealthDatabase(databasePath);
    initial.ingestBatch({
      batch_id: "pre-migration-batch",
      producer: "migration-test",
      sent_at: null,
      events: [
        {
          event_id: "pre-migration-event",
          timestamp: SLEEP_END,
          sample_timestamp: null,
          metric: "heart_rate",
          has_value: true,
          value: 71,
          unit: "bpm",
          source_device: "WA2456C",
          source_module: null,
          source_api: null,
          quality: null,
          status: "PASS",
          session_id: null,
          callback_delta_ms: null,
          raw_error_code: null,
          raw_error_message: null,
        },
      ],
    });
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE sleep_summary_batches;
      DROP TABLE sleep_summaries;
      UPDATE schema_meta SET value = '2' WHERE key = 'schema_version';
    `);
    legacy.close();

    const migrated = new HealthDatabase(databasePath);
    try {
      assert.equal(migrated.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value, "3");
      assert.equal(migrated.queryRange({ metrics: ["heart_rate"] })[0].value, 71);
      assert.deepEqual(migrated.sleepSummaries({}), []);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("a denied capability is reported as DENIED and never as a missing layer", async () => {
  await withService(async ({ request }) => {
    const deniedAt = Date.parse("2026-01-02T19:00:00+08:00");
    await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "capability-denied",
        producer: "akari-pulse-android-test",
        events: [
          {
            event_id: `diagnostic_vivo_private_health-${deniedAt}`,
            timestamp: deniedAt,
            metric: "diagnostic_vivo_private_health",
            value: "NOT_GRANTED",
            source_device: "vivo_phone",
            status: "DENIED",
            raw_error_code: "PERMISSION_NOT_GRANTED",
            raw_error_message: "com.vivo.health.widget.permission is not granted",
          },
        ],
      }),
    });

    const status = await request("/v1/status");
    assert.equal(status.body.data.layers.vivo_private_health.status, "DENIED");
    assert.equal(status.body.data.layers.vivo_private_health.code, "PERMISSION_NOT_GRANTED");

    const sleep = await request("/v1/health/sleep-summaries");
    assert.equal(sleep.body.status, "NO_DATA");
  });
});
