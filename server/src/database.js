import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./validation.js";

const DIAGNOSTIC_LAYERS = [
  "watch_module_api",
  "permission",
  "sample_acquisition",
  "watch_transport",
  "phone_receive",
  "phone_persistence",
  "uplink",
];

// Layers that only ever produce records when the Android bridge is on the active
// path. On the relay-only route they are structurally never populated. When
// zero records exist for one of these layers, `/v1/status` reports NOT_APPLICABLE
// with an explanatory note instead of the misleading NO_DATA. If a real record
// ever arrives (the bridge is re-enabled), the real status takes over.
const ANDROID_BRIDGE_ONLY_LAYERS = new Set(["phone_receive", "phone_persistence", "uplink"]);
const ANDROID_BRIDGE_LAYER_NOTE =
  "android bridge fallback; not on the active relay route";

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
      } else if (ANDROID_BRIDGE_ONLY_LAYERS.has(layer)) {
        // Zero records ever seen for this bridge-only layer — the relay-only
        // route never produces them. Distinguish this structural absence from
        // NO_DATA (which means "the producer ran but reported nothing").
        layers[layer] = {
          status: "NOT_APPLICABLE",
          timestamp: null,
          note: ANDROID_BRIDGE_LAYER_NOTE,
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
