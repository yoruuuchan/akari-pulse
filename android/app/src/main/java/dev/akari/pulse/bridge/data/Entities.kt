package dev.akari.pulse.bridge.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "health_events",
    indices = [
        Index(value = ["timestamp_ms"]),
        Index(value = ["received_at_ms"]),
        Index(value = ["upload_batch_id"]),
        Index(value = ["synced_at_ms"]),
    ],
)
data class HealthEventEntity(
    @PrimaryKey
    @ColumnInfo(name = "event_id")
    val eventId: String,
    @ColumnInfo(name = "timestamp_ms")
    val timestamp: Long,
    @ColumnInfo(name = "sample_timestamp_ms")
    val sampleTimestamp: Long?,
    val metric: String,
    @ColumnInfo(name = "has_value")
    val hasValue: Boolean,
    @ColumnInfo(name = "value_json")
    val valueJson: String?,
    val unit: String?,
    @ColumnInfo(name = "source_device")
    val sourceDevice: String,
    @ColumnInfo(name = "source_module")
    val sourceModule: String?,
    @ColumnInfo(name = "source_api")
    val sourceApi: String?,
    val quality: String?,
    val status: String,
    @ColumnInfo(name = "session_id")
    val sessionId: String?,
    @ColumnInfo(name = "callback_delta_ms")
    val callbackDeltaMs: Long?,
    @ColumnInfo(name = "raw_error_code_json")
    val rawErrorCodeJson: String?,
    @ColumnInfo(name = "raw_error_message")
    val rawErrorMessage: String?,
    @ColumnInfo(name = "raw_event_json")
    val rawEventJson: String,
    @ColumnInfo(name = "watch_batch_id")
    val watchBatchId: String,
    @ColumnInfo(name = "watch_producer")
    val watchProducer: String,
    @ColumnInfo(name = "received_at_ms")
    val receivedAt: Long,
    @ColumnInfo(name = "upload_batch_id")
    val uploadBatchId: String? = null,
    @ColumnInfo(name = "synced_at_ms")
    val syncedAt: Long? = null,
)

@Entity(
    tableName = "upload_batches",
    indices = [Index(value = ["completed_at_ms"]), Index(value = ["created_at_ms"])],
)
data class UploadBatchEntity(
    @PrimaryKey
    @ColumnInfo(name = "batch_id")
    val batchId: String,
    @ColumnInfo(name = "created_at_ms")
    val createdAt: Long,
    @ColumnInfo(name = "sent_at_ms")
    val sentAt: Long,
    @ColumnInfo(name = "event_count")
    val eventCount: Int,
    @ColumnInfo(name = "attempt_count")
    val attemptCount: Int = 0,
    @ColumnInfo(name = "last_attempt_at_ms")
    val lastAttemptAt: Long? = null,
    @ColumnInfo(name = "last_error")
    val lastError: String? = null,
    @ColumnInfo(name = "completed_at_ms")
    val completedAt: Long? = null,
)

@Entity(tableName = "watch_batches")
data class WatchBatchEntity(
    @PrimaryKey
    @ColumnInfo(name = "batch_id")
    val batchId: String,
    val producer: String,
    @ColumnInfo(name = "payload_digest")
    val payloadDigest: String,
    @ColumnInfo(name = "sent_at_ms")
    val sentAt: Long?,
    @ColumnInfo(name = "received_at_ms")
    val receivedAt: Long,
    @ColumnInfo(name = "event_count")
    val eventCount: Int,
    @ColumnInfo(name = "accepted_count")
    val acceptedCount: Int,
    @ColumnInfo(name = "duplicate_count")
    val duplicateCount: Int,
)

@Entity(
    tableName = "phone_daily_summaries",
    primaryKeys = ["source", "metric", "source_day"],
    indices = [
        Index(value = ["source_day"]),
        Index(value = ["sampled_at_ms"]),
        Index(value = ["synced_at_ms"]),
    ],
)
data class PhoneDailySummaryEntity(
    val source: String,
    val metric: String,
    @ColumnInfo(name = "source_day")
    val sourceDay: String,
    @ColumnInfo(name = "source_timezone")
    val sourceTimezone: String,
    @ColumnInfo(name = "value_json")
    val valueJson: String?,
    val unit: String,
    @ColumnInfo(name = "sampled_at_ms")
    val sampledAt: Long,
    @ColumnInfo(name = "sampled_at")
    val sampledAtText: String,
    @ColumnInfo(name = "source_timestamp_available")
    val sourceTimestampAvailable: Boolean,
    val status: String,
    val outcome: String,
    val verification: String,
    @ColumnInfo(name = "raw_error_code")
    val rawErrorCode: String?,
    @ColumnInfo(name = "raw_error_message")
    val rawErrorMessage: String?,
    @ColumnInfo(name = "synced_at_ms")
    val syncedAt: Long? = null,
)

@Entity(
    tableName = "phone_daily_summary_uploads",
    indices = [Index(value = ["completed_at_ms"]), Index(value = ["created_at_ms"])],
)
data class PhoneDailySummaryUploadEntity(
    @PrimaryKey
    @ColumnInfo(name = "batch_id")
    val batchId: String,
    @ColumnInfo(name = "created_at_ms")
    val createdAt: Long,
    @ColumnInfo(name = "sent_at_ms")
    val sentAt: Long,
    val source: String,
    @ColumnInfo(name = "source_day")
    val sourceDay: String,
    @ColumnInfo(name = "sampled_at_ms")
    val sampledAt: Long,
    @ColumnInfo(name = "summary_count")
    val summaryCount: Int,
    @ColumnInfo(name = "payload_json")
    val payloadJson: String,
    @ColumnInfo(name = "attempt_count")
    val attemptCount: Int = 0,
    @ColumnInfo(name = "last_attempt_at_ms")
    val lastAttemptAt: Long? = null,
    @ColumnInfo(name = "last_error")
    val lastError: String? = null,
    @ColumnInfo(name = "completed_at_ms")
    val completedAt: Long? = null,
)

@Entity(
    tableName = "sleep_summaries",
    // One row per sleep session: the vivo provider exposes only its latest record,
    // so a nap read after the night sleep is a second row of the same source_day,
    // not a replacement for it.
    primaryKeys = ["source", "source_day", "sleep_start_ms"],
    indices = [
        Index(value = ["sampled_at_ms"]),
        Index(value = ["synced_at_ms"]),
    ],
)
data class SleepSummaryEntity(
    val source: String,
    @ColumnInfo(name = "source_day")
    val sourceDay: String,
    @ColumnInfo(name = "source_timezone")
    val sourceTimezone: String,
    @ColumnInfo(name = "source_day_start_ms")
    val sourceDayStart: Long?,
    @ColumnInfo(name = "sleep_start_ms")
    val sleepStart: Long,
    @ColumnInfo(name = "sleep_end_ms")
    val sleepEnd: Long,
    @ColumnInfo(name = "sampled_at_ms")
    val sampledAt: Long,
    @ColumnInfo(name = "sampled_at")
    val sampledAtText: String,
    val status: String,
    val outcome: String,
    val verification: String,
    @ColumnInfo(name = "recorder_generation")
    val recorderGeneration: Int?,
    @ColumnInfo(name = "low_accuracy")
    val lowAccuracy: Boolean?,
    val score: Int?,
    @ColumnInfo(name = "deep_sleep_continuity")
    val deepSleepContinuity: Int?,
    @ColumnInfo(name = "total_duration_ms")
    val totalDurationMs: Long,
    @ColumnInfo(name = "night_sleep_duration_ms")
    val nightSleepDurationMs: Long?,
    @ColumnInfo(name = "nap_duration_ms")
    val napDurationMs: Long?,
    @ColumnInfo(name = "chart_total_duration_ms")
    val chartTotalDurationMs: Long?,
    @ColumnInfo(name = "light_sleep_duration_ms")
    val lightSleepDurationMs: Long?,
    @ColumnInfo(name = "deep_sleep_duration_ms")
    val deepSleepDurationMs: Long?,
    @ColumnInfo(name = "rem_sleep_duration_ms")
    val remSleepDurationMs: Long?,
    @ColumnInfo(name = "awake_duration_ms")
    val awakeDurationMs: Long?,
    @ColumnInfo(name = "awake_episode_count")
    val awakeEpisodeCount: Int?,
    @ColumnInfo(name = "awake_episode_duration_ms")
    val awakeEpisodeDurationMs: Long?,
    @ColumnInfo(name = "stages_json")
    val stagesJson: String,
    @ColumnInfo(name = "synced_at_ms")
    val syncedAt: Long? = null,
)

@Entity(
    tableName = "sleep_summary_uploads",
    indices = [Index(value = ["completed_at_ms"]), Index(value = ["created_at_ms"])],
)
data class SleepSummaryUploadEntity(
    @PrimaryKey
    @ColumnInfo(name = "batch_id")
    val batchId: String,
    @ColumnInfo(name = "created_at_ms")
    val createdAt: Long,
    @ColumnInfo(name = "sent_at_ms")
    val sentAt: Long,
    val source: String,
    @ColumnInfo(name = "source_day")
    val sourceDay: String,
    @ColumnInfo(name = "sampled_at_ms")
    val sampledAt: Long,
    @ColumnInfo(name = "summary_count")
    val summaryCount: Int,
    @ColumnInfo(name = "payload_json")
    val payloadJson: String,
    @ColumnInfo(name = "attempt_count")
    val attemptCount: Int = 0,
    @ColumnInfo(name = "last_attempt_at_ms")
    val lastAttemptAt: Long? = null,
    @ColumnInfo(name = "last_error")
    val lastError: String? = null,
    @ColumnInfo(name = "completed_at_ms")
    val completedAt: Long? = null,
)

data class QueueStats(
    val pendingCount: Long,
    val syncedCount: Long,
    val totalCount: Long,
    val lastReceivedAt: Long?,
    val lastSyncedAt: Long?,
    val lastError: String?,
)

data class StoredEventPayload(
    val eventId: String,
    val rawEventJson: String,
)
