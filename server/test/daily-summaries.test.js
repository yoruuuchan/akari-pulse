import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createHealthService } from "../src/app.js";
import { HealthDatabase } from "../src/database.js";

async function withService(run, { now = "2026-08-15T03:00:00Z" } = {}) {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "akari-daily-summary-test-"));
  const service = createHealthService(
    {
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      databasePath: path.join(temporaryDirectory, "health.sqlite"),
      maxBodyBytes: 1024 * 1024,
    },
    { now: () => Date.parse(now) },
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

function phoneBatch({
  batchId,
  sourceDay,
  sampledAt,
  status = "PASS",
  steps = 0,
  distance = 0,
  calories = 0,
}) {
  const outcome = status === "PASS"
    ? "PROVIDER_CALL_SUCCEEDED"
    : status === "NO_DATA"
      ? "PROVIDER_NO_DATA"
      : "PROVIDER_CALL_FAILED";
  return {
    batch_id: batchId,
    producer: "akari-pulse-android-test",
    sent_at: Date.parse(sampledAt),
    summaries: [
      ["phone_step_count", "count", steps, "VERIFIED"],
      ["phone_distance", "m", distance, "VERIFIED_FORMATTED_DISPLAY"],
      ["phone_calories", "kcal", calories, "VERIFIED_FORMATTED_DISPLAY"],
    ].map(([metric, unit, value, verification]) => ({
      source: "vivo_phone",
      metric,
      source_day: sourceDay,
      source_timezone: "Asia/Shanghai",
      ...(status === "PASS" ? { value } : {}),
      unit,
      sampled_at: sampledAt,
      source_timestamp_available: false,
      status,
      outcome,
      verification,
      ...(status === "PASS" ? {} : { raw_error_code: "provider_call" }),
    })),
  };
}

test("phone daily summaries replace by source day, never sum, and remain beside watch steps", async () => {
  await withService(async ({ request }) => {
    for (const [index, steps] of [5, 100, 3200].entries()) {
      const batch = phoneBatch({
        batchId: `phone-day-14-${steps}`,
        sourceDay: "2026-08-14",
        sampledAt: `2026-08-14T${String(index + 1).padStart(2, "0")}:00:00+08:00`,
        steps,
        distance: steps / 2,
        calories: steps / 100,
      });
      const ingest = await request("/v1/health/daily-summaries", {
        method: "POST",
        body: JSON.stringify(batch),
      });
      assert.equal(ingest.response.status, 202);
      assert.deepEqual(
        {
          accepted: ingest.body.data.accepted,
          duplicates: ingest.body.data.duplicates,
          stale: ingest.body.data.stale,
        },
        { accepted: 3, duplicates: 0, stale: 0 },
      );
      if (steps === 3200) {
        const replay = await request("/v1/health/daily-summaries", {
          method: "POST",
          body: JSON.stringify(batch),
        });
        assert.equal(replay.response.status, 200);
        assert.equal(replay.body.data.replayed, true);
      }
    }

    const stale = await request("/v1/health/daily-summaries", {
      method: "POST",
      body: JSON.stringify(phoneBatch({
        batchId: "phone-day-14-stale-retry",
        sourceDay: "2026-08-14",
        sampledAt: "2026-08-14T00:30:00+08:00",
        steps: 7,
        distance: 3,
        calories: 1,
      })),
    });
    assert.equal(stale.body.data.stale, 3);
    assert.equal(stale.body.data.accepted, 0);

    const watchIngest = await request("/v1/health/batches", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "watch-steps-day-14",
        producer: "watch-test",
        events: [
          {
            event_id: "watch-sensor-steps-day-14",
            timestamp: Date.parse("2026-08-14T12:00:00+08:00"),
            metric: "step_count_sensor",
            value: 4567,
            unit: "step",
            source_device: "WA2456C",
            status: "PASS",
          },
        ],
      }),
    });
    assert.equal(watchIngest.response.status, 202);

    const today = await request(
      "/v1/health/today?date=2026-08-14&timezone_offset_minutes=480&metrics=step_count,step_count_sensor,phone_step_count,phone_distance,phone_calories",
    );
    // The newest phone read in this fixture is 32 hours before the injected now,
    // so the phone source is past stale_after_ms: the data is returned in full,
    // and the response says it is not current instead of calling it PASS.
    assert.equal(today.body.status, "DEGRADED");
    assert.deepEqual(today.body.data.freshness.stale_sources, ["vivo_phone"]);
    assert.equal(today.body.data.freshness.by_source.WA2456C.state, "FRESH");
    assert.equal(
      today.body.data.freshness.data_as_of_by_metric.phone_step_count,
      Date.parse("2026-08-14T03:00:00+08:00"),
    );
    assert.equal(today.body.data.timezone, null);
    assert.equal(today.body.data.timezone_source, "caller_override");
    assert.equal(today.body.data.daily_summaries.vivo_phone.phone_step_count.value, 3200);
    assert.equal(today.body.data.daily_summaries.vivo_phone.phone_step_count.source_day, "2026-08-14");
    assert.equal(today.body.data.daily_summaries.vivo_phone.phone_step_count.source_timezone, "Asia/Shanghai");
    assert.equal(today.body.data.daily_summaries.vivo_phone.phone_step_count.source_timestamp_available, false);
    assert.equal(today.body.data.steps.phone.value, 3200);
    assert.equal(today.body.data.steps.watch.step_count_sensor.value, 4567);
    assert.equal(today.body.data.steps.watch.step_count.status, "NO_DATA");

    const zero = await request("/v1/health/daily-summaries", {
      method: "POST",
      body: JSON.stringify(phoneBatch({
        batchId: "phone-day-15-zero",
        sourceDay: "2026-08-15",
        sampledAt: "2026-08-15T00:01:00+08:00",
        steps: 0,
        distance: 0,
        calories: 0,
      })),
    });
    assert.equal(zero.response.status, 202);

    const crossTimezone = await request(
      "/v1/health/today?date=2026-08-15&timezone_offset_minutes=-720&metrics=phone_step_count",
    );
    assert.equal(crossTimezone.body.status, "PASS");
    assert.equal(crossTimezone.body.data.steps.phone.value, 0);
    assert.equal(crossTimezone.body.data.steps.phone.source_day, "2026-08-15");
    assert.equal(crossTimezone.body.data.steps.phone.sampled_at, "2026-08-15T00:01:00+08:00");
  });
});

// 2026-08-14T15:30:00Z is 23:30 on the 14th in Asia/Shanghai and 00:30 on the
// 15th in JST: the hour where a client-side default silently moves a Chinese
// health day. The provider decided the day in +08, so that is what an undated
// read must use, whatever zone the caller runs in.
test("an undated calendar read buckets on the provider's zone, not the client's", async () => {
  await withService(async ({ request }) => {
    const ingest = await request("/v1/health/daily-summaries", {
      method: "POST",
      body: JSON.stringify(phoneBatch({
        batchId: "phone-late-evening",
        sourceDay: "2026-08-14",
        sampledAt: "2026-08-14T23:20:00+08:00",
        steps: 8123,
        distance: 6100,
        calories: 240,
      })),
    });
    assert.equal(ingest.response.status, 202);

    const provided = await request("/v1/health/today?metrics=phone_step_count");
    assert.equal(provided.body.data.date, "2026-08-14");
    assert.equal(provided.body.data.timezone, "Asia/Shanghai");
    assert.equal(provided.body.data.timezone_offset_minutes, 480);
    assert.equal(provided.body.data.timezone_source, "provider_default");
    assert.equal(provided.body.status, "PASS");
    assert.equal(provided.body.data.daily_summaries.vivo_phone.phone_step_count.value, 8123);

    // The old default put the same moment on the next day, where the value the
    // provider recorded does not exist.
    const jst = await request("/v1/health/today?timezone_offset_minutes=540&metrics=phone_step_count");
    assert.equal(jst.body.data.date, "2026-08-15");
    assert.equal(jst.body.data.timezone_source, "caller_override");
    assert.equal(jst.body.status, "NO_DATA");
    assert.deepEqual(jst.body.data.daily_summaries, {});
  }, { now: "2026-08-14T15:30:00Z" });
});

test("NO_DATA and ERROR stay distinct and never acquire a value", async () => {
  await withService(async ({ request }) => {
    for (const [sourceDay, status] of [["2026-08-16", "NO_DATA"], ["2026-08-17", "ERROR"]]) {
      const ingest = await request("/v1/health/daily-summaries", {
        method: "POST",
        body: JSON.stringify(phoneBatch({
          batchId: `phone-${status.toLowerCase()}`,
          sourceDay,
          sampledAt: `${sourceDay}T09:00:00+08:00`,
          status,
        })),
      });
      assert.equal(ingest.response.status, 202);

      const today = await request(
        `/v1/health/today?date=${sourceDay}&timezone_offset_minutes=480&metrics=phone_step_count`,
      );
      assert.equal(today.body.status, status);
      assert.equal(today.body.data.steps.phone.status, status);
      assert.equal(today.body.data.steps.phone.value, null);
      assert.equal(Object.hasOwn(today.body.data.daily_summaries.vivo_phone.phone_step_count, "value"), false);
    }
  });
});

test("daily-summary boundary rejects silent fallback shapes", async () => {
  await withService(async ({ request }) => {
    for (const mutate of [
      (summary) => { delete summary.value; },
      (summary) => { summary.status = "NO_DATA"; summary.outcome = "PROVIDER_NO_DATA"; },
      (summary) => { summary.source_timestamp_available = true; },
      (summary) => { summary.status = "ERROR"; summary.outcome = "PROVIDER_NO_DATA"; delete summary.value; },
    ]) {
      const batch = phoneBatch({
        batchId: `invalid-${crypto.randomUUID()}`,
        sourceDay: "2026-08-14",
        sampledAt: "2026-08-14T10:00:00+08:00",
        steps: 5,
      });
      mutate(batch.summaries[0]);
      const response = await request("/v1/health/daily-summaries", {
        method: "POST",
        body: JSON.stringify(batch),
      });
      assert.equal(response.response.status, 400);
      assert.equal(response.body.error.code, "INVALID_REQUEST");
    }
  });
});

test("schema version 1 migrates in place without losing watch records", () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "akari-server-migration-test-"));
  const databasePath = path.join(temporaryDirectory, "health.sqlite");
  try {
    const initial = new HealthDatabase(databasePath);
    initial.ingestBatch({
      batch_id: "existing-watch-batch",
      producer: "migration-test",
      sent_at: null,
      events: [
        {
          event_id: "existing-watch-event",
          timestamp: 1_786_674_000_000,
          sample_timestamp: null,
          metric: "heart_rate",
          has_value: true,
          value: 72,
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

    // Rewind to a genuine version-1 database: every table added after version 1 has to go,
    // otherwise this fixture would not be the shape the migration actually meets in the field.
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE sleep_summary_batches;
      DROP TABLE sleep_summaries;
      DROP TABLE daily_summary_batches;
      DROP TABLE daily_summaries;
      UPDATE schema_meta SET value = '1' WHERE key = 'schema_version';
    `);
    legacy.close();

    const migrated = new HealthDatabase(databasePath);
    try {
      assert.equal(migrated.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value, "4");
      assert.equal(migrated.queryRange({ metrics: ["heart_rate"] })[0].value, 72);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS count FROM daily_summaries").get().count, 0);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS count FROM sleep_summaries").get().count, 0);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
