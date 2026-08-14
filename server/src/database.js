import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HttpError, SLEEP_DURATION_KEYS } from "./validation.js";

const DIAGNOSTIC_LAYERS = [
  "watch_module_api",
  "permission",
  "sample_acquisition",
  "watch_transport",
  "phone_receive",
  "phone_persistence",
  "uplink",
  "vivo_private_health",
];

// These diagnostic event metrics belong to the Android watch-receiver fallback.
// The independent phone daily-summary path reports its state through daily-summary
// records and last_daily_summary_ingest instead. When zero receiver diagnostics
// exist, `/v1/status` reports NOT_APPLICABLE rather than the misleading NO_DATA.
const WATCH_BRIDGE_ONLY_LAYERS = new Set(["phone_receive", "phone_persistence", "uplink"]);
const WATCH_BRIDGE_LAYER_NOTE =
  "watch receiver bridge fallback; not on the active watch relay route";

// Contract decision (0.1.5): the vivo watch health API can surface a raw value
// of 0 bpm from bpm-family reads (recent-sample zero shape, or getTodayStatistic
// MIN aggregating non-wear/empty periods). 0 bpm is physiologically impossible
// and is a sentinel/aggregate artifact, not an observation. PASS-filtered reads
// (latest/range/today — the routes the MCP consumes) exclude records whose
// metric is in this set AND whose numeric_value === 0. Under status=ALL and
// diagnostics the raw records remain fully visible. The append-only store is
// untouched — this is a query-time validity rule.
const BPM_METRICS_ZERO_INVALID = new Set([
  "heart_rate",
  "heart_rate_resting",
  "heart_rate_today_max",
  "heart_rate_today_min",
]);
const BPM_ZERO_INVALID_METRIC_LIST = Array.from(BPM_METRICS_ZERO_INVALID);

function parseJson(text) {
  if (text === null || text === undefined) return null;
  return JSON.parse(text);
}

function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toHealthRecord(row) {
  if (!row) return null;
  return {
    event_id: row.event_id,
    timestamp: row.timestamp_ms,
    sample_timestamp: row.sample_timestamp_ms,
    metric: row.metric,
    value: row.value_json === null ? undefined : parseJson(row.value_json),
    unit: row.unit,
    source_device: row.source_device,
    source_module: row.source_module,
    source_api: row.source_api,
    quality: row.quality,
    status: row.status,
    received_at: row.received_at_ms,
    session_id: row.session_id,
    session_assignment: row.session_assignment,
    callback_delta_ms: row.callback_delta_ms,
    raw_error_code: row.raw_error_code,
    raw_error_message: row.raw_error_message,
  };
}

function toDailySummary(row) {
  if (!row) return null;
  return {
    source: row.source,
    metric: row.metric,
    source_day: row.source_day,
    source_timezone: row.source_timezone,
    ...(row.value_json === null ? {} : { value: parseJson(row.value_json) }),
    unit: row.unit,
    sampled_at: row.sampled_at,
    source_timestamp_available: Boolean(row.source_timestamp_available),
    status: row.status,
    outcome: row.outcome,
    verification: row.verification,
    raw_error_code: row.raw_error_code,
    raw_error_message: row.raw_error_message,
    received_at: row.received_at_ms,
  };
}

const SLEEP_NULLABLE_NUMBERS = [
  "source_day_start_ms",
  "recorder_generation",
  "score",
  "deep_sleep_continuity",
  "night_sleep_duration_ms",
  "nap_duration_ms",
  "chart_total_duration_ms",
  "light_sleep_duration_ms",
  "deep_sleep_duration_ms",
  "rem_sleep_duration_ms",
  "awake_duration_ms",
  "awake_episode_count",
  "awake_episode_duration_ms",
];

function toSleepSummary(row) {
  if (!row) return null;
  const summary = {
    source: row.source,
    source_day: row.source_day,
    source_timezone: row.source_timezone,
    sleep_start: row.sleep_start_ms,
    sleep_end: row.sleep_end_ms,
    sampled_at: row.sampled_at,
    status: row.status,
    outcome: row.outcome,
    verification: row.verification,
    low_accuracy: row.low_accuracy === null ? null : Boolean(row.low_accuracy),
    total_duration_ms: row.total_duration_ms,
    stages: parseJson(row.stages_json),
    received_at: row.received_at_ms,
  };
  for (const key of SLEEP_NULLABLE_NUMBERS) summary[key] = row[key];
  return summary;
}

function sleepSummaryPayload(summary) {
  const payload = {
    source: summary.source,
    source_day: summary.source_day,
    source_timezone: summary.source_timezone,
    source_day_start: summary.source_day_start,
    sleep_start: summary.sleep_start,
    sleep_end: summary.sleep_end,
    sampled_at: summary.sampled_at,
    status: summary.status,
    outcome: summary.outcome,
    verification: summary.verification,
    recorder_generation: summary.recorder_generation,
    low_accuracy: summary.low_accuracy,
    score: summary.score,
    deep_sleep_continuity: summary.deep_sleep_continuity,
    awake_episode_count: summary.awake_episode_count,
    stages: summary.stages,
  };
  for (const key of SLEEP_DURATION_KEYS) payload[key] = summary[key];
  return payload;
}

function toSession(row) {
  if (!row) return null;
  return {
    session_id: row.session_id,
    source_device: row.source_device,
    label: row.label,
    status: row.status,
    started_at: row.started_at_ms,
    ended_at: row.ended_at_ms,
    created_at: row.created_at_ms,
    updated_at: row.updated_at_ms,
  };
}

function eventPayload(event) {
  const payload = {
    event_id: event.event_id,
    timestamp: event.timestamp,
    sample_timestamp: event.sample_timestamp,
    metric: event.metric,
    unit: event.unit,
    source_device: event.source_device,
    source_module: event.source_module,
    source_api: event.source_api,
    quality: event.quality,
    status: event.status,
    session_id: event.session_id,
    callback_delta_ms: event.callback_delta_ms,
    raw_error_code: event.raw_error_code,
    raw_error_message: event.raw_error_message,
  };
  if (event.has_value) payload.value = event.value;
  return payload;
}

function dailySummaryPayload(summary) {
  const payload = {
    source: summary.source,
    metric: summary.metric,
    source_day: summary.source_day,
    source_timezone: summary.source_timezone,
    unit: summary.unit,
    sampled_at: summary.sampled_at,
    source_timestamp_available: summary.source_timestamp_available,
    status: summary.status,
    outcome: summary.outcome,
    verification: summary.verification,
    raw_error_code: summary.raw_error_code,
    raw_error_message: summary.raw_error_message,
  };
  if (summary.has_value) payload.value = summary.value;
  return payload;
}

export class HealthDatabase {
  constructor(databasePath) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath, { timeout: 5000 });
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (databasePath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.#migrate();
    this.#prepare();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');

      CREATE TABLE IF NOT EXISTS health_records (
        event_id TEXT PRIMARY KEY,
        timestamp_ms INTEGER NOT NULL,
        sample_timestamp_ms INTEGER,
        metric TEXT NOT NULL,
        value_json TEXT,
        numeric_value REAL,
        unit TEXT,
        source_device TEXT NOT NULL,
        source_module TEXT,
        source_api TEXT,
        quality TEXT,
        status TEXT NOT NULL CHECK (status IN ('PASS','NO_DATA','DENIED','UNSUPPORTED','API_MISSING','ERROR')),
        received_at_ms INTEGER NOT NULL,
        session_id TEXT,
        session_assignment TEXT CHECK (session_assignment IN ('PRODUCER','TIME_WINDOW') OR session_assignment IS NULL),
        callback_delta_ms INTEGER,
        raw_error_code TEXT,
        raw_error_message TEXT,
        payload_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS health_records_metric_time
        ON health_records(metric, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS health_records_session_time
        ON health_records(session_id, timestamp_ms ASC);
      CREATE INDEX IF NOT EXISTS health_records_device_time
        ON health_records(source_device, timestamp_ms DESC);

      CREATE TABLE IF NOT EXISTS sync_batches (
        batch_id TEXT PRIMARY KEY,
        producer TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        sent_at_ms INTEGER,
        received_at_ms INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        accepted_count INTEGER NOT NULL,
        duplicate_count INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS sync_batches_received
        ON sync_batches(received_at_ms DESC);

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        source_device TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms)
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open_per_device
        ON sessions(source_device) WHERE status = 'OPEN';
      CREATE INDEX IF NOT EXISTS sessions_started
        ON sessions(started_at_ms DESC);

      CREATE TABLE IF NOT EXISTS correlation_events (
        event_id TEXT PRIMARY KEY,
        timestamp_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        session_id TEXT,
        metadata_json TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS correlation_events_session_time
        ON correlation_events(session_id, timestamp_ms ASC);
      CREATE INDEX IF NOT EXISTS correlation_events_time
        ON correlation_events(timestamp_ms ASC);
    `);

    const versionRow = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get();
    const version = Number(versionRow?.value);
    if (!Number.isInteger(version) || version < 1 || version > 3) {
      throw new Error(`Unsupported Akari Health schema version: ${versionRow?.value ?? "missing"}`);
    }
    if (version < 2) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`
          CREATE TABLE daily_summaries (
            source TEXT NOT NULL,
            metric TEXT NOT NULL,
            source_day TEXT NOT NULL,
            source_timezone TEXT NOT NULL,
            value_json TEXT,
            numeric_value REAL,
            unit TEXT NOT NULL,
            sampled_at TEXT NOT NULL,
            sampled_at_ms INTEGER NOT NULL,
            source_timestamp_available INTEGER NOT NULL CHECK (source_timestamp_available = 0),
            status TEXT NOT NULL CHECK (status IN ('PASS','NO_DATA','ERROR')),
            outcome TEXT NOT NULL,
            verification TEXT NOT NULL,
            raw_error_code TEXT,
            raw_error_message TEXT,
            received_at_ms INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (source, metric, source_day)
          ) STRICT;

          CREATE INDEX daily_summaries_day_source
            ON daily_summaries(source_day, source, metric);
          CREATE INDEX daily_summaries_sampled
            ON daily_summaries(sampled_at_ms DESC);

          CREATE TABLE daily_summary_batches (
            batch_id TEXT PRIMARY KEY,
            producer TEXT NOT NULL,
            payload_digest TEXT NOT NULL,
            sent_at_ms INTEGER,
            received_at_ms INTEGER NOT NULL,
            summary_count INTEGER NOT NULL,
            accepted_count INTEGER NOT NULL,
            duplicate_count INTEGER NOT NULL,
            stale_count INTEGER NOT NULL
          ) STRICT;

          CREATE INDEX daily_summary_batches_received
            ON daily_summary_batches(received_at_ms DESC);

          UPDATE schema_meta SET value = '2' WHERE key = 'schema_version';
        `);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 3) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`
          CREATE TABLE sleep_summaries (
            source TEXT NOT NULL,
            source_day TEXT NOT NULL,
            source_timezone TEXT NOT NULL,
            source_day_start_ms INTEGER,
            sleep_start_ms INTEGER NOT NULL,
            sleep_end_ms INTEGER NOT NULL,
            sampled_at TEXT NOT NULL,
            sampled_at_ms INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status = 'PASS'),
            outcome TEXT NOT NULL,
            verification TEXT NOT NULL,
            recorder_generation INTEGER,
            low_accuracy INTEGER,
            score INTEGER,
            deep_sleep_continuity INTEGER,
            total_duration_ms INTEGER NOT NULL,
            night_sleep_duration_ms INTEGER,
            nap_duration_ms INTEGER,
            chart_total_duration_ms INTEGER,
            light_sleep_duration_ms INTEGER,
            deep_sleep_duration_ms INTEGER,
            rem_sleep_duration_ms INTEGER,
            awake_duration_ms INTEGER,
            awake_episode_count INTEGER,
            awake_episode_duration_ms INTEGER,
            stages_json TEXT NOT NULL,
            received_at_ms INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (source, source_day)
          ) STRICT;

          CREATE INDEX sleep_summaries_day
            ON sleep_summaries(source_day DESC, source);
          CREATE INDEX sleep_summaries_sampled
            ON sleep_summaries(sampled_at_ms DESC);

          CREATE TABLE sleep_summary_batches (
            batch_id TEXT PRIMARY KEY,
            producer TEXT NOT NULL,
            payload_digest TEXT NOT NULL,
            sent_at_ms INTEGER,
            received_at_ms INTEGER NOT NULL,
            summary_count INTEGER NOT NULL,
            accepted_count INTEGER NOT NULL,
            duplicate_count INTEGER NOT NULL,
            stale_count INTEGER NOT NULL
          ) STRICT;

          CREATE INDEX sleep_summary_batches_received
            ON sleep_summary_batches(received_at_ms DESC);

          UPDATE schema_meta SET value = '3' WHERE key = 'schema_version';
        `);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  #prepare() {
    this.findSessionForSample = this.db.prepare(`
      SELECT session_id
      FROM sessions
      WHERE source_device = ?
        AND started_at_ms <= ?
        AND (ended_at_ms IS NULL OR ended_at_ms >= ?)
      ORDER BY started_at_ms DESC
      LIMIT 1
    `);
    this.insertRecord = this.db.prepare(`
      INSERT INTO health_records (
        event_id, timestamp_ms, sample_timestamp_ms, metric, value_json,
        numeric_value, unit, source_device, source_module, source_api,
        quality, status, received_at_ms, session_id, session_assignment,
        callback_delta_ms, raw_error_code, raw_error_message, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `);
    this.getRecordPayload = this.db.prepare("SELECT payload_json FROM health_records WHERE event_id = ?");
    this.getBatch = this.db.prepare("SELECT * FROM sync_batches WHERE batch_id = ?");
    this.insertBatch = this.db.prepare(`
      INSERT INTO sync_batches (
        batch_id, producer, payload_digest, sent_at_ms, received_at_ms,
        event_count, accepted_count, duplicate_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getDailySummaryBatch = this.db.prepare(
      "SELECT * FROM daily_summary_batches WHERE batch_id = ?",
    );
    this.insertDailySummaryBatch = this.db.prepare(`
      INSERT INTO daily_summary_batches (
        batch_id, producer, payload_digest, sent_at_ms, received_at_ms,
        summary_count, accepted_count, duplicate_count, stale_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getDailySummary = this.db.prepare(`
      SELECT * FROM daily_summaries
      WHERE source = ? AND metric = ? AND source_day = ?
    `);
    this.insertDailySummary = this.db.prepare(`
      INSERT INTO daily_summaries (
        source, metric, source_day, source_timezone, value_json,
        numeric_value, unit, sampled_at, sampled_at_ms,
        source_timestamp_available, status, outcome, verification,
        raw_error_code, raw_error_message, received_at_ms, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateDailySummary = this.db.prepare(`
      UPDATE daily_summaries SET
        source_timezone = ?, value_json = ?, numeric_value = ?, unit = ?,
        sampled_at = ?, sampled_at_ms = ?, source_timestamp_available = ?,
        status = ?, outcome = ?, verification = ?, raw_error_code = ?,
        raw_error_message = ?, received_at_ms = ?, payload_json = ?
      WHERE source = ? AND metric = ? AND source_day = ?
    `);
    this.getSleepSummaryBatch = this.db.prepare(
      "SELECT * FROM sleep_summary_batches WHERE batch_id = ?",
    );
    this.insertSleepSummaryBatch = this.db.prepare(`
      INSERT INTO sleep_summary_batches (
        batch_id, producer, payload_digest, sent_at_ms, received_at_ms,
        summary_count, accepted_count, duplicate_count, stale_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getSleepSummary = this.db.prepare(
      "SELECT * FROM sleep_summaries WHERE source = ? AND source_day = ?",
    );
    this.upsertSleepSummary = this.db.prepare(`
      INSERT INTO sleep_summaries (
        source, source_day, source_timezone, source_day_start_ms, sleep_start_ms,
        sleep_end_ms, sampled_at, sampled_at_ms, status, outcome, verification,
        recorder_generation, low_accuracy, score, deep_sleep_continuity,
        total_duration_ms, night_sleep_duration_ms, nap_duration_ms,
        chart_total_duration_ms, light_sleep_duration_ms, deep_sleep_duration_ms,
        rem_sleep_duration_ms, awake_duration_ms, awake_episode_count,
        awake_episode_duration_ms, stages_json, received_at_ms, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_day) DO UPDATE SET
        source_timezone = excluded.source_timezone,
        source_day_start_ms = excluded.source_day_start_ms,
        sleep_start_ms = excluded.sleep_start_ms,
        sleep_end_ms = excluded.sleep_end_ms,
        sampled_at = excluded.sampled_at,
        sampled_at_ms = excluded.sampled_at_ms,
        status = excluded.status,
        outcome = excluded.outcome,
        verification = excluded.verification,
        recorder_generation = excluded.recorder_generation,
        low_accuracy = excluded.low_accuracy,
        score = excluded.score,
        deep_sleep_continuity = excluded.deep_sleep_continuity,
        total_duration_ms = excluded.total_duration_ms,
        night_sleep_duration_ms = excluded.night_sleep_duration_ms,
        nap_duration_ms = excluded.nap_duration_ms,
        chart_total_duration_ms = excluded.chart_total_duration_ms,
        light_sleep_duration_ms = excluded.light_sleep_duration_ms,
        deep_sleep_duration_ms = excluded.deep_sleep_duration_ms,
        rem_sleep_duration_ms = excluded.rem_sleep_duration_ms,
        awake_duration_ms = excluded.awake_duration_ms,
        awake_episode_count = excluded.awake_episode_count,
        awake_episode_duration_ms = excluded.awake_episode_duration_ms,
        stages_json = excluded.stages_json,
        received_at_ms = excluded.received_at_ms,
        payload_json = excluded.payload_json
    `);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }

  ingestBatch(batch, receivedAt = Date.now()) {
    const payloadDigest = createHash("sha256")
      .update(JSON.stringify({
        batch_id: batch.batch_id,
        producer: batch.producer,
        sent_at: batch.sent_at,
        events: batch.events.map(eventPayload),
      }))
      .digest("hex");
    const prior = this.getBatch.get(batch.batch_id);
    if (prior) {
      if (prior.payload_digest !== payloadDigest) {
        throw new HttpError(409, "BATCH_ID_CONFLICT", "batch_id was already used for a different payload");
      }
      return {
        batch_id: prior.batch_id,
        accepted: prior.accepted_count,
        duplicates: prior.duplicate_count,
        received_at: prior.received_at_ms,
        replayed: true,
      };
    }

    let accepted = 0;
    let duplicates = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of batch.events) {
        const serializedPayload = JSON.stringify(eventPayload(event));
        const priorEvent = this.getRecordPayload.get(event.event_id);
        if (priorEvent) {
          if (priorEvent.payload_json !== serializedPayload) {
            throw new HttpError(409, "EVENT_ID_CONFLICT", "event_id was already used for a different observation", {
              event_id: event.event_id,
            });
          }
          duplicates += 1;
          continue;
        }
        let sessionId = event.session_id;
        let sessionAssignment = sessionId ? "PRODUCER" : null;
        if (!sessionId && event.metric === "heart_rate") {
          const match = this.findSessionForSample.get(
            event.source_device,
            event.timestamp,
            event.timestamp,
          );
          if (match) {
            sessionId = match.session_id;
            sessionAssignment = "TIME_WINDOW";
          }
        }

        const result = this.insertRecord.run(
          event.event_id,
          event.timestamp,
          event.sample_timestamp,
          event.metric,
          event.has_value ? JSON.stringify(event.value) : null,
          event.has_value && typeof event.value === "number" ? event.value : null,
          event.unit,
          event.source_device,
          event.source_module,
          event.source_api,
          event.quality,
          event.status,
          receivedAt,
          sessionId,
          sessionAssignment,
          event.callback_delta_ms,
          event.raw_error_code,
          event.raw_error_message,
          serializedPayload,
        );
        if (result.changes === 1) accepted += 1;
        else duplicates += 1;
      }

      this.insertBatch.run(
        batch.batch_id,
        batch.producer,
        payloadDigest,
        batch.sent_at,
        receivedAt,
        batch.events.length,
        accepted,
        duplicates,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      batch_id: batch.batch_id,
      accepted,
      duplicates,
      received_at: receivedAt,
      replayed: false,
    };
  }

  ingestDailySummaryBatch(batch, receivedAt = Date.now()) {
    const payloadDigest = createHash("sha256")
      .update(JSON.stringify({
        batch_id: batch.batch_id,
        producer: batch.producer,
        sent_at: batch.sent_at,
        summaries: batch.summaries.map(dailySummaryPayload),
      }))
      .digest("hex");
    const priorBatch = this.getDailySummaryBatch.get(batch.batch_id);
    if (priorBatch) {
      if (priorBatch.payload_digest !== payloadDigest) {
        throw new HttpError(409, "BATCH_ID_CONFLICT", "batch_id was already used for a different daily-summary payload");
      }
      return {
        batch_id: priorBatch.batch_id,
        accepted: priorBatch.accepted_count,
        duplicates: priorBatch.duplicate_count,
        stale: priorBatch.stale_count,
        received_at: priorBatch.received_at_ms,
        replayed: true,
      };
    }

    let accepted = 0;
    let duplicates = 0;
    let stale = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const summary of batch.summaries) {
        const serializedPayload = JSON.stringify(dailySummaryPayload(summary));
        const prior = this.getDailySummary.get(summary.source, summary.metric, summary.source_day);
        if (prior && summary.sampled_at_ms < prior.sampled_at_ms) {
          stale += 1;
          continue;
        }
        if (prior && summary.sampled_at_ms === prior.sampled_at_ms) {
          if (prior.payload_json !== serializedPayload) {
            throw new HttpError(
              409,
              "DAILY_SUMMARY_VERSION_CONFLICT",
              "the same source/metric/source_day and sampled_at was used for different content",
              { source: summary.source, metric: summary.metric, source_day: summary.source_day },
            );
          }
          duplicates += 1;
          continue;
        }
        const valueJson = summary.has_value ? JSON.stringify(summary.value) : null;
        const numericValue = summary.has_value ? summary.value : null;
        if (prior) {
          this.updateDailySummary.run(
            summary.source_timezone,
            valueJson,
            numericValue,
            summary.unit,
            summary.sampled_at,
            summary.sampled_at_ms,
            summary.source_timestamp_available ? 1 : 0,
            summary.status,
            summary.outcome,
            summary.verification,
            summary.raw_error_code,
            summary.raw_error_message,
            receivedAt,
            serializedPayload,
            summary.source,
            summary.metric,
            summary.source_day,
          );
        } else {
          this.insertDailySummary.run(
            summary.source,
            summary.metric,
            summary.source_day,
            summary.source_timezone,
            valueJson,
            numericValue,
            summary.unit,
            summary.sampled_at,
            summary.sampled_at_ms,
            summary.source_timestamp_available ? 1 : 0,
            summary.status,
            summary.outcome,
            summary.verification,
            summary.raw_error_code,
            summary.raw_error_message,
            receivedAt,
            serializedPayload,
          );
        }
        accepted += 1;
      }

      this.insertDailySummaryBatch.run(
        batch.batch_id,
        batch.producer,
        payloadDigest,
        batch.sent_at,
        receivedAt,
        batch.summaries.length,
        accepted,
        duplicates,
        stale,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      batch_id: batch.batch_id,
      accepted,
      duplicates,
      stale,
      received_at: receivedAt,
      replayed: false,
    };
  }

  ingestSleepSummaryBatch(batch, receivedAt = Date.now()) {
    const payloadDigest = createHash("sha256")
      .update(JSON.stringify({
        batch_id: batch.batch_id,
        producer: batch.producer,
        sent_at: batch.sent_at,
        summaries: batch.summaries.map(sleepSummaryPayload),
      }))
      .digest("hex");
    const priorBatch = this.getSleepSummaryBatch.get(batch.batch_id);
    if (priorBatch) {
      if (priorBatch.payload_digest !== payloadDigest) {
        throw new HttpError(409, "BATCH_ID_CONFLICT", "batch_id was already used for a different sleep-summary payload");
      }
      return {
        batch_id: priorBatch.batch_id,
        accepted: priorBatch.accepted_count,
        duplicates: priorBatch.duplicate_count,
        stale: priorBatch.stale_count,
        received_at: priorBatch.received_at_ms,
        replayed: true,
      };
    }

    let accepted = 0;
    let duplicates = 0;
    let stale = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const summary of batch.summaries) {
        const serializedPayload = JSON.stringify(sleepSummaryPayload(summary));
        const prior = this.getSleepSummary.get(summary.source, summary.source_day);
        if (prior && summary.sampled_at_ms < prior.sampled_at_ms) {
          stale += 1;
          continue;
        }
        if (prior && summary.sampled_at_ms === prior.sampled_at_ms) {
          if (prior.payload_json !== serializedPayload) {
            throw new HttpError(
              409,
              "SLEEP_SUMMARY_VERSION_CONFLICT",
              "the same source/source_day and sampled_at was used for different content",
              { source: summary.source, source_day: summary.source_day },
            );
          }
          duplicates += 1;
          continue;
        }
        this.upsertSleepSummary.run(
          summary.source,
          summary.source_day,
          summary.source_timezone,
          summary.source_day_start,
          summary.sleep_start,
          summary.sleep_end,
          summary.sampled_at,
          summary.sampled_at_ms,
          summary.status,
          summary.outcome,
          summary.verification,
          summary.recorder_generation,
          summary.low_accuracy === null ? null : summary.low_accuracy ? 1 : 0,
          summary.score,
          summary.deep_sleep_continuity,
          summary.total_duration_ms,
          summary.night_sleep_duration_ms,
          summary.nap_duration_ms,
          summary.chart_total_duration_ms,
          summary.light_sleep_duration_ms,
          summary.deep_sleep_duration_ms,
          summary.rem_sleep_duration_ms,
          summary.awake_duration_ms,
          summary.awake_episode_count,
          summary.awake_episode_duration_ms,
          JSON.stringify(summary.stages),
          receivedAt,
          serializedPayload,
        );
        accepted += 1;
      }

      this.insertSleepSummaryBatch.run(
        batch.batch_id,
        batch.producer,
        payloadDigest,
        batch.sent_at,
        receivedAt,
        batch.summaries.length,
        accepted,
        duplicates,
        stale,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      batch_id: batch.batch_id,
      accepted,
      duplicates,
      stale,
      received_at: receivedAt,
      replayed: false,
    };
  }

  sleepSummaries({ sourceDay = null, limit = 7 } = {}) {
    const clauses = [];
    const parameters = [];
    if (sourceDay) {
      clauses.push("source_day = ?");
      parameters.push(sourceDay);
    }
    parameters.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`
        SELECT * FROM sleep_summaries
        ${where}
        ORDER BY source_day DESC, source ASC
        LIMIT ?
      `)
      .all(...parameters)
      .map(toSleepSummary);
  }

  dailySummaries({ sourceDay, metrics = [] }) {
    const clauses = ["source_day = ?"];
    const parameters = [sourceDay];
    if (metrics.length > 0) {
      clauses.push(`metric IN (${metrics.map(() => "?").join(",")})`);
      parameters.push(...metrics);
    }
    const rows = this.db
      .prepare(`
        SELECT * FROM daily_summaries
        WHERE ${clauses.join(" AND ")}
        ORDER BY source ASC, metric ASC
      `)
      .all(...parameters);
    return rows.map(toDailySummary);
  }

  queryRange({ metrics = [], from = 0, to = Number.MAX_SAFE_INTEGER, status = "PASS", limit = 500, ascending = true } = {}) {
    const clauses = ["timestamp_ms >= ?", "timestamp_ms <= ?"];
    const parameters = [from, to];
    if (metrics.length > 0) {
      clauses.push(`metric IN (${metrics.map(() => "?").join(",")})`);
      parameters.push(...metrics);
    }
    if (status) {
      clauses.push("status = ?");
      parameters.push(status);
    }
    // Query-time validity rule: under a PASS filter, exclude bpm-family records
    // whose numeric value is 0. See BPM_METRICS_ZERO_INVALID above. The rule
    // does not apply to status=ALL, other statuses, or diagnostics.
    if (status === "PASS") {
      const placeholders = BPM_ZERO_INVALID_METRIC_LIST.map(() => "?").join(",");
      clauses.push(`NOT (metric IN (${placeholders}) AND numeric_value = 0)`);
      parameters.push(...BPM_ZERO_INVALID_METRIC_LIST);
    }
    parameters.push(limit);
    const order = ascending ? "ASC" : "DESC";
    const rows = this.db
      .prepare(`
        SELECT * FROM health_records
        WHERE ${clauses.join(" AND ")}
        ORDER BY timestamp_ms ${order}, received_at_ms ${order}
        LIMIT ?
      `)
      .all(...parameters);
    return rows.map(toHealthRecord);
  }

  latest({ metrics = [], status = "PASS" } = {}) {
    const clauses = [];
    const parameters = [];
    if (metrics.length > 0) {
      clauses.push(`metric IN (${metrics.map(() => "?").join(",")})`);
      parameters.push(...metrics);
    }
    if (status) {
      clauses.push("status = ?");
      parameters.push(status);
    }
    // Query-time validity rule: same as queryRange — see BPM_METRICS_ZERO_INVALID.
    if (status === "PASS") {
      const placeholders = BPM_ZERO_INVALID_METRIC_LIST.map(() => "?").join(",");
      clauses.push(`NOT (metric IN (${placeholders}) AND numeric_value = 0)`);
      parameters.push(...BPM_ZERO_INVALID_METRIC_LIST);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`
        SELECT * FROM (
          SELECT health_records.*,
            ROW_NUMBER() OVER (
              PARTITION BY metric
              ORDER BY timestamp_ms DESC, received_at_ms DESC
            ) AS row_number
          FROM health_records
          ${where}
        )
        WHERE row_number = 1
        ORDER BY metric ASC
      `)
      .all(...parameters);
    return rows.map(toHealthRecord);
  }

  status(now = Date.now()) {
    const recordCounts = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM health_records GROUP BY status ORDER BY status")
      .all();
    const dailySummaryCounts = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM daily_summaries GROUP BY status ORDER BY status")
      .all();
    const metricFreshness = this.db
      .prepare(`
        SELECT metric, MAX(timestamp_ms) AS latest_timestamp, COUNT(*) AS sample_count
        FROM health_records
        WHERE status = 'PASS'
        GROUP BY metric
        ORDER BY metric
      `)
      .all()
      .map((row) => ({
        metric: row.metric,
        latest_timestamp: row.latest_timestamp,
        age_ms: Math.max(0, now - row.latest_timestamp),
        sample_count: row.sample_count,
      }));
    const lastBatch = this.db
      .prepare("SELECT * FROM sync_batches ORDER BY received_at_ms DESC LIMIT 1")
      .get();
    const lastDailySummaryBatch = this.db
      .prepare("SELECT * FROM daily_summary_batches ORDER BY received_at_ms DESC LIMIT 1")
      .get();
    const lastSleepSummaryBatch = this.db
      .prepare("SELECT * FROM sleep_summary_batches ORDER BY received_at_ms DESC LIMIT 1")
      .get();
    const sleepSummaryCount = this.db
      .prepare("SELECT COUNT(*) AS count, MAX(source_day) AS latest_day FROM sleep_summaries")
      .get();
    const latestDiagnostics = this.latest({
      metrics: DIAGNOSTIC_LAYERS.map((layer) => `diagnostic_${layer}`),
      status: null,
    });
    const diagnosticByMetric = new Map(latestDiagnostics.map((record) => [record.metric, record]));
    const layers = {};
    for (const layer of DIAGNOSTIC_LAYERS) {
      const record = diagnosticByMetric.get(`diagnostic_${layer}`);
      if (record) {
        layers[layer] = {
          status: record.status,
          timestamp: record.timestamp,
          code: record.raw_error_code,
          message: record.raw_error_message,
          source_device: record.source_device,
        };
      } else if (WATCH_BRIDGE_ONLY_LAYERS.has(layer)) {
        // Zero records ever seen for this bridge-only layer — the relay-only
        // route never produces them. Distinguish this structural absence from
        // NO_DATA (which means "the producer ran but reported nothing").
        layers[layer] = {
          status: "NOT_APPLICABLE",
          timestamp: null,
          note: WATCH_BRIDGE_LAYER_NOTE,
        };
      } else {
        layers[layer] = { status: "NO_DATA", timestamp: null };
      }
    }
    layers.backend_ingest = lastBatch
      ? { status: "PASS", timestamp: lastBatch.received_at_ms, batch_id: lastBatch.batch_id }
      : { status: "NO_DATA", timestamp: null };
    layers.database = { status: "PASS", timestamp: now };

    return {
      database: {
        status: "PASS",
        record_count: recordCounts.reduce((sum, row) => sum + row.count, 0),
        counts_by_status: Object.fromEntries(recordCounts.map((row) => [row.status, row.count])),
        daily_summary_count: dailySummaryCounts.reduce((sum, row) => sum + row.count, 0),
        daily_summary_counts_by_status: Object.fromEntries(
          dailySummaryCounts.map((row) => [row.status, row.count]),
        ),
        sleep_summary_count: sleepSummaryCount.count,
        sleep_summary_latest_day: sleepSummaryCount.latest_day,
      },
      last_ingest: lastBatch
        ? {
            batch_id: lastBatch.batch_id,
            producer: lastBatch.producer,
            received_at: lastBatch.received_at_ms,
            accepted: lastBatch.accepted_count,
            duplicates: lastBatch.duplicate_count,
          }
        : null,
      last_daily_summary_ingest: lastDailySummaryBatch
        ? {
            batch_id: lastDailySummaryBatch.batch_id,
            producer: lastDailySummaryBatch.producer,
            received_at: lastDailySummaryBatch.received_at_ms,
            accepted: lastDailySummaryBatch.accepted_count,
            duplicates: lastDailySummaryBatch.duplicate_count,
            stale: lastDailySummaryBatch.stale_count,
          }
        : null,
      last_sleep_summary_ingest: lastSleepSummaryBatch
        ? {
            batch_id: lastSleepSummaryBatch.batch_id,
            producer: lastSleepSummaryBatch.producer,
            received_at: lastSleepSummaryBatch.received_at_ms,
            accepted: lastSleepSummaryBatch.accepted_count,
            duplicates: lastSleepSummaryBatch.duplicate_count,
            stale: lastSleepSummaryBatch.stale_count,
          }
        : null,
      metric_freshness: metricFreshness,
      layers,
    };
  }

  createSession(session, now = Date.now()) {
    const existing = this.db
      .prepare("SELECT * FROM sessions WHERE source_device = ? AND status = 'OPEN'")
      .get(session.source_device);
    if (existing) {
      throw new HttpError(409, "SESSION_ALREADY_OPEN", "An open session already exists for this source device", {
        session_id: existing.session_id,
      });
    }
    const sessionId = session.session_id || randomUUID();
    try {
      this.db
        .prepare(`
          INSERT INTO sessions (
            session_id, source_device, label, status,
            started_at_ms, ended_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 'OPEN', ?, NULL, ?, ?)
        `)
        .run(sessionId, session.source_device, session.label, session.started_at, now, now);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed: sessions.session_id")) {
        throw new HttpError(409, "SESSION_ID_EXISTS", "The requested session_id already exists");
      }
      throw error;
    }
    return this.getSession(sessionId);
  }

  getSession(sessionId) {
    return toSession(this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId));
  }

  listSessions({ from = 0, to = Number.MAX_SAFE_INTEGER, status = null, limit = 100 } = {}) {
    const clauses = ["started_at_ms >= ?", "started_at_ms <= ?"];
    const parameters = [from, to];
    if (status) {
      clauses.push("status = ?");
      parameters.push(status);
    }
    parameters.push(limit);
    return this.db
      .prepare(`
        SELECT * FROM sessions
        WHERE ${clauses.join(" AND ")}
        ORDER BY started_at_ms DESC
        LIMIT ?
      `)
      .all(...parameters)
      .map(toSession);
  }

  activeSessions() {
    return this.db
      .prepare("SELECT * FROM sessions WHERE status = 'OPEN' ORDER BY started_at_ms DESC")
      .all()
      .map(toSession);
  }

  stopSession(sessionId, endedAt, now = Date.now()) {
    const session = this.getSession(sessionId);
    if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "Session not found");
    if (endedAt < session.started_at) {
      throw new HttpError(400, "INVALID_SESSION_END", "ended_at cannot be before started_at");
    }
    if (session.status === "CLOSED") return { ...session, replayed: true };
    this.db
      .prepare(`
        UPDATE sessions
        SET status = 'CLOSED', ended_at_ms = ?, updated_at_ms = ?
        WHERE session_id = ? AND status = 'OPEN'
      `)
      .run(endedAt, now, sessionId);
    return { ...this.getSession(sessionId), replayed: false };
  }

  addCorrelationEvent(event, receivedAt = Date.now()) {
    const serializedMetadata = JSON.stringify(event.metadata);
    const prior = this.db
      .prepare("SELECT * FROM correlation_events WHERE event_id = ?")
      .get(event.event_id);
    if (prior) {
      if (
        prior.timestamp_ms !== event.timestamp ||
        prior.source !== event.source ||
        prior.event_type !== event.event_type ||
        prior.session_id !== event.session_id ||
        prior.metadata_json !== serializedMetadata
      ) {
        throw new HttpError(409, "CORRELATION_EVENT_ID_CONFLICT", "event_id was already used for a different correlation event", {
          event_id: event.event_id,
        });
      }
      return {
        event: {
          event_id: prior.event_id,
          timestamp: prior.timestamp_ms,
          source: prior.source,
          event_type: prior.event_type,
          session_id: prior.session_id,
          metadata: parseJson(prior.metadata_json),
          received_at: prior.received_at_ms,
        },
        duplicate: true,
      };
    }

    const result = this.db
      .prepare(`
        INSERT INTO correlation_events (
          event_id, timestamp_ms, source, event_type,
          session_id, metadata_json, received_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO NOTHING
      `)
      .run(
        event.event_id,
        event.timestamp,
        event.source,
        event.event_type,
        event.session_id,
        serializedMetadata,
        receivedAt,
      );
    const row = this.db
      .prepare("SELECT * FROM correlation_events WHERE event_id = ?")
      .get(event.event_id);
    return {
      event: {
        event_id: row.event_id,
        timestamp: row.timestamp_ms,
        source: row.source,
        event_type: row.event_type,
        session_id: row.session_id,
        metadata: parseJson(row.metadata_json),
        received_at: row.received_at_ms,
      },
      duplicate: result.changes === 0,
    };
  }

  listCorrelationEvents({ from = 0, to = Number.MAX_SAFE_INTEGER, sessionId = null, limit = 500 } = {}) {
    const clauses = ["timestamp_ms >= ?", "timestamp_ms <= ?"];
    const parameters = [from, to];
    if (sessionId) {
      clauses.push("session_id = ?");
      parameters.push(sessionId);
    }
    parameters.push(limit);
    return this.db
      .prepare(`
        SELECT * FROM correlation_events
        WHERE ${clauses.join(" AND ")}
        ORDER BY timestamp_ms ASC
        LIMIT ?
      `)
      .all(...parameters)
      .map((row) => ({
        event_id: row.event_id,
        timestamp: row.timestamp_ms,
        source: row.source,
        event_type: row.event_type,
        session_id: row.session_id,
        metadata: parseJson(row.metadata_json),
        received_at: row.received_at_ms,
      }));
  }

  sessionSummary(
    sessionId,
    { baselineWindowMs = 60000, responseWindowMs = 300000, riseThresholdBpm = 5 } = {},
    now = Date.now(),
  ) {
    const session = this.getSession(sessionId);
    if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "Session not found");
    const end = session.ended_at ?? now;
    const rows = this.db
      .prepare(`
        SELECT * FROM health_records
        WHERE metric = 'heart_rate'
          AND status = 'PASS'
          AND numeric_value IS NOT NULL
          AND numeric_value != 0
          AND source_device = ?
          AND timestamp_ms >= ?
          AND timestamp_ms <= ?
          AND (session_id = ? OR session_id IS NULL)
        ORDER BY timestamp_ms ASC
      `)
      .all(session.source_device, session.started_at, end, sessionId);
    const samples = rows.map((row) => ({
      timestamp: row.timestamp_ms,
      value: row.numeric_value,
      callback_delta_ms: row.callback_delta_ms,
      event_id: row.event_id,
      assignment: row.session_assignment,
    }));
    const values = samples.map((sample) => sample.value);
    const callbackDeltas = samples
      .map((sample) => sample.callback_delta_ms)
      .filter((value) => value !== null);
    const peakSample = samples.reduce(
      (peak, sample) => (!peak || sample.value > peak.value ? sample : peak),
      null,
    );

    const events = this.db
      .prepare(`
        SELECT * FROM correlation_events
        WHERE timestamp_ms >= ?
          AND timestamp_ms <= ?
          AND (session_id = ? OR session_id IS NULL)
        ORDER BY timestamp_ms ASC
      `)
      .all(session.started_at, end, sessionId)
      .map((row) => ({
        event_id: row.event_id,
        timestamp: row.timestamp_ms,
        source: row.source,
        event_type: row.event_type,
        session_id: row.session_id,
        metadata: parseJson(row.metadata_json),
      }));

    const correlations = events.map((event) => {
      const baselineSamples = samples.filter(
        (sample) => sample.timestamp >= event.timestamp - baselineWindowMs && sample.timestamp < event.timestamp,
      );
      const responseSamples = samples.filter(
        (sample) => sample.timestamp >= event.timestamp && sample.timestamp <= event.timestamp + responseWindowMs,
      );
      const baseline = mean(baselineSamples.map((sample) => sample.value));
      const peak = responseSamples.reduce(
        (current, sample) => (!current || sample.value > current.value ? sample : current),
        null,
      );
      const firstRise =
        baseline === null
          ? null
          : responseSamples.find((sample) => sample.value >= baseline + riseThresholdBpm) ?? null;
      return {
        event,
        coverage: {
          baseline_samples: baselineSamples.length,
          response_samples: responseSamples.length,
        },
        baseline_bpm: round(baseline),
        peak_bpm: peak?.value ?? null,
        delta_bpm: baseline === null || !peak ? null : round(peak.value - baseline),
        latency_to_rise_ms: firstRise ? firstRise.timestamp - event.timestamp : null,
        time_to_peak_ms: peak ? peak.timestamp - event.timestamp : null,
      };
    });

    return {
      session,
      coverage: {
        heart_rate_samples: samples.length,
        first_sample_at: samples[0]?.timestamp ?? null,
        last_sample_at: samples.at(-1)?.timestamp ?? null,
        correlation_events: events.length,
      },
      heart_rate: {
        minimum_bpm: values.length ? Math.min(...values) : null,
        maximum_bpm: values.length ? Math.max(...values) : null,
        average_bpm: round(mean(values)),
        peak_at: peakSample?.timestamp ?? null,
        average_callback_delta_ms: round(mean(callbackDeltas)),
      },
      correlation_parameters: {
        baseline_window_ms: baselineWindowMs,
        response_window_ms: responseWindowMs,
        rise_threshold_bpm: riseThresholdBpm,
      },
      correlations,
      interpretation: "Temporal association only. This summary does not establish that an event caused a heart-rate change.",
    };
  }
}
