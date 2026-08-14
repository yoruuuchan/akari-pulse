import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

class FakeD1 {
  constructor() {
    this.rows = [];
    this.nextRowId = 1;
  }

  prepare(sql) {
    const database = this;
    let parameters = [];
    return {
      bind(...values) {
        parameters = values;
        return this;
      },
      async first() {
        if (sql.includes("WHERE batch_id = ?")) {
          return database.rows.find((row) => row.batch_id === parameters[0]) || null;
        }
        if (sql.includes("COUNT(*) AS pending")) {
          const times = database.rows.map((row) => row.received_at);
          return {
            pending: database.rows.length,
            oldest: times.length > 0 ? Math.min(...times) : null,
            newest: times.length > 0 ? Math.max(...times) : null,
          };
        }
        throw new Error(`unsupported first query: ${sql}`);
      },
      async all() {
        if (!sql.includes("ORDER BY row_id ASC")) throw new Error(`unsupported all query: ${sql}`);
        return { results: database.rows.slice(0, parameters[0]) };
      },
      async run() {
        if (sql.startsWith("INSERT INTO relay_batches")) {
          const [batchId, producer, sentAt, receivedAt, payloadHash, payload, targetPath] = parameters;
          database.rows.push({
            row_id: database.nextRowId++,
            batch_id: batchId,
            producer,
            sent_at: sentAt,
            received_at: receivedAt,
            payload_hash: payloadHash,
            payload,
            target_path: targetPath,
          });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM relay_batches")) {
          const priorCount = database.rows.length;
          const ids = new Set(parameters);
          database.rows = database.rows.filter((row) => !ids.has(row.row_id));
          return { meta: { changes: priorCount - database.rows.length } };
        }
        throw new Error(`unsupported run query: ${sql}`);
      },
    };
  }
}

const env = () => ({
  DB: new FakeD1(),
  INGEST_TOKEN: "watch-token",
  PHONE_INGEST_TOKEN: "phone-token",
  ADMIN_TOKEN: "admin-token",
});

async function post(path, token, body, environment) {
  const response = await worker.fetch(new Request(`https://pulse.example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-akari-bridge-token": token,
    },
    body: JSON.stringify(body),
  }), environment);
  return { response, body: await response.json() };
}

test("relay keeps watch and phone contracts on distinct durable target paths", async () => {
  const environment = env();
  const watch = {
    batch_id: "watch-batch",
    producer: "watch-test",
    events: [{
      event_id: "watch-event",
      timestamp: 1_786_674_000_000,
      metric: "heart_rate",
      value: 72,
      unit: "bpm",
      source_device: "WA2456C",
      status: "PASS",
    }],
  };
  const watchIngest = await post("/v1/health/batches", "watch-token", watch, environment);
  assert.equal(watchIngest.response.status, 202);
  assert.equal(watchIngest.body.data.accepted, 1);

  const phone = {
    batch_id: "phone-batch",
    producer: "android-test",
    summaries: [{
      source: "vivo_phone",
      metric: "phone_step_count",
      source_day: "2026-08-14",
      source_timezone: "Asia/Shanghai",
      value: 3200,
      unit: "count",
      sampled_at: "2026-08-14T10:00:00+08:00",
      source_timestamp_available: false,
      status: "PASS",
      outcome: "PROVIDER_CALL_SUCCEEDED",
      verification: "VERIFIED",
    }],
  };
  const phoneIngest = await post("/v1/health/daily-summaries", "phone-token", phone, environment);
  assert.equal(phoneIngest.response.status, 202);
  assert.deepEqual(
    {
      accepted: phoneIngest.body.data.accepted,
      duplicates: phoneIngest.body.data.duplicates,
      stale: phoneIngest.body.data.stale,
    },
    { accepted: 1, duplicates: 0, stale: 0 },
  );

  const replay = await post("/v1/health/daily-summaries", "phone-token", phone, environment);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.data.replayed, true);

  const pendingResponse = await worker.fetch(new Request(
    "https://pulse.example.com/v1/relay/pending?limit=50",
    { headers: { authorization: "Bearer admin-token" } },
  ), environment);
  const pending = await pendingResponse.json();
  assert.deepEqual(
    pending.data.batches.map((batch) => batch.target_path),
    ["/v1/health/batches", "/v1/health/daily-summaries"],
  );
});

test("phone token and status semantics are enforced before durable acknowledgement", async () => {
  const environment = env();
  const invalid = {
    batch_id: "invalid-phone-batch",
    producer: "android-test",
    summaries: [{
      source: "vivo_phone",
      metric: "phone_step_count",
      source_day: "2026-08-14",
      source_timezone: "Asia/Shanghai",
      unit: "count",
      sampled_at: "2026-08-14T10:00:00+08:00",
      source_timestamp_available: false,
      status: "ERROR",
      outcome: "PROVIDER_NO_DATA",
      verification: "VERIFIED",
    }],
  };

  const wrongToken = await post("/v1/health/daily-summaries", "watch-token", invalid, environment);
  assert.equal(wrongToken.response.status, 401);

  const invalidStatus = await post("/v1/health/daily-summaries", "phone-token", invalid, environment);
  assert.equal(invalidStatus.response.status, 400);
  assert.equal(environment.DB.rows.length, 0);
});

const sleepSummary = (overrides = {}) => ({
  source: "vivo_phone",
  source_day: "2026-01-02",
  source_timezone: "Asia/Shanghai",
  source_day_start: 1_767_283_200_000,
  sleep_start: 1_767_310_000_000,
  sleep_end: 1_767_338_800_000,
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
  stages: { deep: [{ start: 1_767_313_600_000, end: 1_767_317_200_000 }] },
  ...overrides,
});

test("sleep summaries buffer on their own target path under the phone token", async () => {
  const environment = env();
  const batch = { batch_id: "sleep-batch", producer: "android-test", summaries: [sleepSummary()] };

  const wrongToken = await post("/v1/health/sleep-summaries", "watch-token", batch, environment);
  assert.equal(wrongToken.response.status, 401);
  assert.equal(environment.DB.rows.length, 0);

  const ingest = await post("/v1/health/sleep-summaries", "phone-token", batch, environment);
  assert.equal(ingest.response.status, 202);
  assert.deepEqual(
    {
      accepted: ingest.body.data.accepted,
      duplicates: ingest.body.data.duplicates,
      stale: ingest.body.data.stale,
    },
    { accepted: 1, duplicates: 0, stale: 0 },
  );

  const replay = await post("/v1/health/sleep-summaries", "phone-token", batch, environment);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.data.replayed, true);

  const pendingResponse = await worker.fetch(new Request(
    "https://pulse.example.com/v1/relay/pending?limit=50",
    { headers: { authorization: "Bearer admin-token" } },
  ), environment);
  const pending = await pendingResponse.json();
  assert.deepEqual(pending.data.batches.map((row) => row.target_path), ["/v1/health/sleep-summaries"]);
});

test("a sleep summary that is not an observed day is rejected before it is buffered", async () => {
  const environment = env();
  for (const overrides of [
    { status: "NO_DATA" },
    { outcome: "PARSE_FAILED" },
    { sleep_end: 1_767_309_000_000 },
    { stages: { snore: [] } },
    { source: "wa2456c" },
  ]) {
    const rejected = await post(
      "/v1/health/sleep-summaries",
      "phone-token",
      { batch_id: `sleep-invalid-${JSON.stringify(overrides).length}`, producer: "android-test", summaries: [sleepSummary(overrides)] },
      environment,
    );
    assert.equal(rejected.response.status, 400);
  }
  assert.equal(environment.DB.rows.length, 0);
});

test("the event route accepts either producer credential and still refuses an unknown one", async () => {
  const environment = env();
  const phoneEvents = {
    batch_id: "phone-events",
    producer: "akari-pulse-android-vivo-private",
    events: [{
      event_id: "phone_heart_rate-1767354000000",
      timestamp: 1_767_354_000_000,
      metric: "phone_heart_rate",
      value: 70,
      unit: "bpm",
      source_device: "vivo_phone",
      quality: "latest_snapshot",
      status: "PASS",
    }],
  };

  const withPhoneToken = await post("/v1/health/batches", "phone-token", phoneEvents, environment);
  assert.equal(withPhoneToken.response.status, 202);

  const watchEvents = { ...phoneEvents, batch_id: "watch-events" };
  const withWatchToken = await post("/v1/health/batches", "watch-token", watchEvents, environment);
  assert.equal(withWatchToken.response.status, 202);

  const unknown = await post("/v1/health/batches", "not-a-token", { ...phoneEvents, batch_id: "rejected" }, environment);
  assert.equal(unknown.response.status, 401);
  assert.equal(environment.DB.rows.length, 2);

  // The summary routes stay scoped to the phone credential.
  const watchTokenOnSummaries = await post(
    "/v1/health/sleep-summaries",
    "watch-token",
    { batch_id: "sleep-wrong-token", producer: "android-test", summaries: [sleepSummary()] },
    environment,
  );
  assert.equal(watchTokenOnSummaries.response.status, 401);
});
