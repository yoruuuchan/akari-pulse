package dev.akari.pulse.bridge.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface HealthDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertEvents(events: List<HealthEventEntity>): List<Long>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertUploadBatch(batch: UploadBatchEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertWatchBatch(batch: WatchBatchEntity)

    @Query("SELECT * FROM watch_batches WHERE batch_id = :batchId")
    suspend fun watchBatch(batchId: String): WatchBatchEntity?

    @Query(
        "SELECT event_id AS eventId, raw_event_json AS rawEventJson FROM health_events WHERE event_id IN (:eventIds)",
    )
    suspend fun storedEventPayloads(eventIds: List<String>): List<StoredEventPayload>

    @Query(
        """
        SELECT
          (SELECT COUNT(*) FROM health_events WHERE synced_at_ms IS NULL) AS pendingCount,
          (SELECT COUNT(*) FROM health_events WHERE synced_at_ms IS NOT NULL) AS syncedCount,
          (SELECT COUNT(*) FROM health_events) AS totalCount,
          (SELECT MAX(received_at_ms) FROM health_events) AS lastReceivedAt,
          (SELECT MAX(synced_at_ms) FROM health_events) AS lastSyncedAt,
          (SELECT last_error FROM upload_batches WHERE last_error IS NOT NULL ORDER BY last_attempt_at_ms DESC LIMIT 1) AS lastError
        """,
    )
    fun observeQueueStats(): Flow<QueueStats>

    @Query("SELECT * FROM health_events ORDER BY received_at_ms DESC, event_id DESC LIMIT :limit")
    fun observeRecentEvents(limit: Int): Flow<List<HealthEventEntity>>

    @Query(
        "SELECT * FROM upload_batches WHERE completed_at_ms IS NULL ORDER BY created_at_ms ASC LIMIT 1",
    )
    suspend fun oldestOpenUploadBatch(): UploadBatchEntity?

    @Query(
        "SELECT * FROM health_events WHERE synced_at_ms IS NULL AND upload_batch_id IS NULL ORDER BY received_at_ms ASC, event_id ASC LIMIT :limit",
    )
    suspend fun unassignedEvents(limit: Int): List<HealthEventEntity>

    @Query("UPDATE health_events SET upload_batch_id = :batchId WHERE event_id IN (:eventIds) AND upload_batch_id IS NULL")
    suspend fun assignEventsToBatch(eventIds: List<String>, batchId: String): Int

    @Query("SELECT * FROM health_events WHERE upload_batch_id = :batchId ORDER BY received_at_ms ASC, event_id ASC")
    suspend fun eventsForBatch(batchId: String): List<HealthEventEntity>

    @Query(
        "UPDATE upload_batches SET attempt_count = attempt_count + 1, last_attempt_at_ms = :attemptedAt, last_error = NULL WHERE batch_id = :batchId",
    )
    suspend fun markBatchAttempted(batchId: String, attemptedAt: Long)

    @Query(
        "UPDATE upload_batches SET last_error = :message, last_attempt_at_ms = :attemptedAt WHERE batch_id = :batchId",
    )
    suspend fun markBatchError(batchId: String, attemptedAt: Long, message: String)

    @Query(
        "UPDATE upload_batches SET completed_at_ms = :completedAt, last_error = NULL WHERE batch_id = :batchId",
    )
    suspend fun markBatchComplete(batchId: String, completedAt: Long)

    @Query(
        "UPDATE health_events SET synced_at_ms = :syncedAt WHERE upload_batch_id = :batchId AND synced_at_ms IS NULL",
    )
    suspend fun markBatchEventsSynced(batchId: String, syncedAt: Long): Int
}
