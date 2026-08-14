package dev.akari.pulse.bridge.data

import androidx.room.withTransaction
import dev.akari.pulse.bridge.contract.ContractViolation
import dev.akari.pulse.bridge.contract.HealthContract
import dev.akari.pulse.bridge.contract.IncomingHealthBatch
import dev.akari.pulse.bridge.diagnostics.DiagnosticsStore
import dev.akari.pulse.bridge.diagnostics.TransportKind
import dev.akari.pulse.bridge.network.AkariHealthClient
import dev.akari.pulse.bridge.network.ApiFailure
import dev.akari.pulse.bridge.phonehealth.PhoneTodayActivity
import dev.akari.pulse.bridge.phonehealth.VivoPrivateHealthSnapshot
import dev.akari.pulse.bridge.phonehealth.toDailySummaryRecords
import dev.akari.pulse.bridge.phonehealth.toHealthEvents
import dev.akari.pulse.bridge.phonehealth.toSleepSummaryRecord
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

data class IngressAcknowledgement(
    val batchId: String,
    val accepted: Int,
    val duplicates: Int,
    val receivedAt: Long,
    val replayed: Boolean,
)

data class ClaimedUpload(
    val batch: UploadBatchEntity,
    val events: List<HealthEventEntity>,
)

sealed interface SyncOneResult {
    data object NoWork : SyncOneResult
    data class Success(val eventCount: Int) : SyncOneResult
    data class Failure(val retryable: Boolean, val message: String) : SyncOneResult
}

class BridgeRepository(
    private val database: AkariDatabase,
    private val client: AkariHealthClient,
    private val diagnostics: DiagnosticsStore,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val dao = database.healthDao()

    fun observeQueueStats(): Flow<QueueStats> = dao.observeQueueStats()

    fun observeRecentEvents(limit: Int = 20): Flow<List<HealthEventEntity>> = dao.observeRecentEvents(limit)

    suspend fun persistPhoneDailySummary(activity: PhoneTodayActivity) {
        val summaries = activity.toDailySummaryRecords()
        val createdAt = now()
        val batchId = "phone-daily-${UUID.randomUUID()}"
        val payload = buildJsonObject {
            put("batch_id", batchId)
            put("producer", PRODUCER)
            put("sent_at", createdAt)
            put(
                "summaries",
                JsonArray(
                    summaries.map { summary ->
                        buildJsonObject {
                            put("source", summary.source)
                            put("metric", summary.metric)
                            put("source_day", summary.sourceDay)
                            put("source_timezone", summary.sourceTimezone)
                            summary.valueJson?.let { valueJson ->
                                put("value", HealthContract.json.parseToJsonElement(valueJson))
                            }
                            put("unit", summary.unit)
                            put("sampled_at", summary.sampledAtText)
                            put("source_timestamp_available", summary.sourceTimestampAvailable)
                            put("status", summary.status)
                            put("outcome", summary.outcome)
                            put("verification", summary.verification)
                            summary.rawErrorCode?.let { put("raw_error_code", it) }
                            summary.rawErrorMessage?.let { put("raw_error_message", it) }
                        }
                    },
                ),
            )
        }
        database.withTransaction {
            dao.upsertPhoneDailySummaries(
                summaries.map { summary ->
                    PhoneDailySummaryEntity(
                        source = summary.source,
                        metric = summary.metric,
                        sourceDay = summary.sourceDay,
                        sourceTimezone = summary.sourceTimezone,
                        valueJson = summary.valueJson,
                        unit = summary.unit,
                        sampledAt = summary.sampledAt,
                        sampledAtText = summary.sampledAtText,
                        sourceTimestampAvailable = summary.sourceTimestampAvailable,
                        status = summary.status,
                        outcome = summary.outcome,
                        verification = summary.verification,
                        rawErrorCode = summary.rawErrorCode,
                        rawErrorMessage = summary.rawErrorMessage,
                    )
                },
            )
            dao.insertPhoneDailySummaryUpload(
                PhoneDailySummaryUploadEntity(
                    batchId = batchId,
                    createdAt = createdAt,
                    sentAt = createdAt,
                    source = summaries.first().source,
                    sourceDay = summaries.first().sourceDay,
                    sampledAt = summaries.first().sampledAt,
                    summaryCount = summaries.size,
                    payloadJson = payload.toString(),
                ),
            )
        }
    }

    /**
     * Persists one vivo private-provider read.
     *
     * The capability verdict and the three latest vitals are ordinary health events, so they reuse
     * the existing immutable outbox and upload route. The sleep day is a structured per-day record
     * with its own contract, so it gets its own outbox row. A sleep read that did not observe a
     * real sleep day writes nothing to the sleep table — the capability event carries that outcome
     * instead, and a stored day is never displaced by a placeholder.
     */
    suspend fun persistVivoPrivateHealth(snapshot: VivoPrivateHealthSnapshot) {
        val events = snapshot.toHealthEvents()
        val sleep = snapshot.toSleepSummaryRecord()
        val createdAt = now()
        // Locally produced events still belong to an ingress batch; there is no inbound watch
        // batch to replay-protect, so no watch_batches row is written for them.
        val ingressBatchId = "vivo-private-${UUID.randomUUID()}"
        val sleepBatchId = "phone-sleep-${UUID.randomUUID()}"
        val sleepPayload = sleep?.let { record ->
            buildJsonObject {
                put("batch_id", sleepBatchId)
                put("producer", PRODUCER)
                put("sent_at", createdAt)
                put("summaries", JsonArray(listOf(record.toWireJson())))
            }
        }
        database.withTransaction {
            dao.insertEvents(
                events.map { event ->
                    HealthEventEntity(
                        eventId = event.eventId,
                        timestamp = event.timestamp,
                        sampleTimestamp = null,
                        metric = event.metric,
                        hasValue = event.hasValue,
                        valueJson = event.valueJson,
                        unit = event.unit,
                        sourceDevice = event.sourceDevice,
                        sourceModule = event.sourceModule,
                        sourceApi = event.sourceApi,
                        quality = event.quality,
                        status = event.status,
                        sessionId = null,
                        callbackDeltaMs = null,
                        rawErrorCodeJson = event.rawErrorCode?.let { JsonPrimitive(it).toString() },
                        rawErrorMessage = event.rawErrorMessage,
                        rawEventJson = event.toWireJson().toString(),
                        watchBatchId = ingressBatchId,
                        watchProducer = VIVO_PRIVATE_PRODUCER,
                        receivedAt = createdAt,
                    )
                },
            )
            if (sleep != null && sleepPayload != null) {
                dao.upsertSleepSummary(
                    SleepSummaryEntity(
                        source = sleep.source,
                        sourceDay = sleep.sourceDay,
                        sourceTimezone = sleep.sourceTimezone,
                        sourceDayStart = sleep.sourceDayStart,
                        sleepStart = sleep.sleepStart,
                        sleepEnd = sleep.sleepEnd,
                        sampledAt = sleep.sampledAt,
                        sampledAtText = sleep.sampledAtText,
                        status = sleep.status,
                        outcome = sleep.outcome,
                        verification = sleep.verification,
                        recorderGeneration = sleep.recorderGeneration,
                        lowAccuracy = sleep.lowAccuracy,
                        score = sleep.score,
                        deepSleepContinuity = sleep.deepSleepContinuity,
                        totalDurationMs = sleep.totalDurationMs,
                        nightSleepDurationMs = sleep.nightSleepDurationMs,
                        napDurationMs = sleep.napDurationMs,
                        chartTotalDurationMs = sleep.chartTotalDurationMs,
                        lightSleepDurationMs = sleep.lightSleepDurationMs,
                        deepSleepDurationMs = sleep.deepSleepDurationMs,
                        remSleepDurationMs = sleep.remSleepDurationMs,
                        awakeDurationMs = sleep.awakeDurationMs,
                        awakeEpisodeCount = sleep.awakeEpisodeCount,
                        awakeEpisodeDurationMs = sleep.awakeEpisodeDurationMs,
                        stagesJson = sleep.stagesJson,
                    ),
                )
                dao.insertSleepSummaryUpload(
                    SleepSummaryUploadEntity(
                        batchId = sleepBatchId,
                        createdAt = createdAt,
                        sentAt = createdAt,
                        source = sleep.source,
                        sourceDay = sleep.sourceDay,
                        sampledAt = sleep.sampledAt,
                        summaryCount = 1,
                        payloadJson = sleepPayload.toString(),
                    ),
                )
            }
        }
    }

    suspend fun ingestWatchBatch(rawJson: String, sourceAdapter: TransportKind): IngressAcknowledgement {
        val batch = HealthContract.parseBatch(rawJson)
        val receivedAt = now()
        val payloadDigest = digest(batch)
        val result = database.withTransaction {
            val priorBatch = dao.watchBatch(batch.batchId)
            if (priorBatch != null) {
                if (priorBatch.payloadDigest != payloadDigest) {
                    throw ContractViolation(
                        "BATCH_ID_CONFLICT",
                        "batch_id ${batch.batchId} was already used for a different payload",
                    )
                }
                return@withTransaction IngressAcknowledgement(
                    batchId = priorBatch.batchId,
                    accepted = priorBatch.acceptedCount,
                    duplicates = priorBatch.duplicateCount,
                    receivedAt = priorBatch.receivedAt,
                    replayed = true,
                )
            }
            rejectConflictsWithin(batch)
            val storedById = dao.storedEventPayloads(batch.events.map { it.eventId })
                .associateBy { it.eventId }
            for (event in batch.events) {
                val stored = storedById[event.eventId] ?: continue
                if (stored.rawEventJson != event.rawEventJson) {
                    throw ContractViolation(
                        "EVENT_ID_CONFLICT",
                        "event_id ${event.eventId} was already used for a different observation",
                    )
                }
            }
            val rows = batch.events.map { event ->
                HealthEventEntity(
                    eventId = event.eventId,
                    timestamp = event.timestamp,
                    sampleTimestamp = event.sampleTimestamp,
                    metric = event.metric,
                    hasValue = event.hasValue,
                    valueJson = event.valueJson,
                    unit = event.unit,
                    sourceDevice = event.sourceDevice,
                    sourceModule = event.sourceModule,
                    sourceApi = event.sourceApi,
                    quality = event.quality,
                    status = event.status.name,
                    sessionId = event.sessionId,
                    callbackDeltaMs = event.callbackDeltaMs,
                    rawErrorCodeJson = event.rawErrorCodeJson,
                    rawErrorMessage = event.rawErrorMessage,
                    rawEventJson = event.rawEventJson,
                    watchBatchId = batch.batchId,
                    watchProducer = batch.producer,
                    receivedAt = receivedAt,
                )
            }
            val inserted = dao.insertEvents(rows).count { it != -1L }
            val acknowledgement = IngressAcknowledgement(
                batchId = batch.batchId,
                accepted = inserted,
                duplicates = rows.size - inserted,
                receivedAt = receivedAt,
                replayed = false,
            )
            dao.insertWatchBatch(
                WatchBatchEntity(
                    batchId = batch.batchId,
                    producer = batch.producer,
                    payloadDigest = payloadDigest,
                    sentAt = batch.sentAt,
                    receivedAt = receivedAt,
                    eventCount = rows.size,
                    acceptedCount = acknowledgement.accepted,
                    duplicateCount = acknowledgement.duplicates,
                ),
            )
            acknowledgement
        }
        diagnostics.watchBatchAccepted(
            sourceAdapter,
            now(),
            if (result.replayed) 0 else result.accepted,
            if (result.replayed) 0 else result.duplicates,
        )
        return result
    }

    suspend fun syncOne(): SyncOneResult {
        val claimed = claimNextUpload() ?: return SyncOneResult.NoWork
        val attemptedAt = now()
        dao.markBatchAttempted(claimed.batch.batchId, attemptedAt)
        diagnostics.syncAttempt(attemptedAt)
        val payload = buildUploadPayload(claimed)
        return try {
            val acknowledgement = client.upload(payload)
            if (acknowledgement.accepted + acknowledgement.duplicates != claimed.events.size) {
                throw ApiFailure(false, "server acknowledgement count does not match the batch")
            }
            val completedAt = now()
            database.withTransaction {
                dao.markBatchEventsSynced(claimed.batch.batchId, completedAt)
                dao.markBatchComplete(claimed.batch.batchId, completedAt)
            }
            diagnostics.syncSucceeded(completedAt)
            SyncOneResult.Success(claimed.events.size)
        } catch (error: Exception) {
            val retryable = (error as? ApiFailure)?.retryable == true
            val message = (error.message ?: error.javaClass.simpleName).take(2048)
            dao.markBatchError(claimed.batch.batchId, now(), message)
            diagnostics.syncFailed(now(), message)
            SyncOneResult.Failure(retryable, message)
        }
    }

    suspend fun syncOnePhoneDailySummary(): SyncOneResult {
        val batch = dao.oldestOpenPhoneDailySummaryUpload() ?: return SyncOneResult.NoWork
        val attemptedAt = now()
        dao.markPhoneDailySummaryUploadAttempted(batch.batchId, attemptedAt)
        diagnostics.syncAttempt(attemptedAt)
        return try {
            val payload = HealthContract.json.parseToJsonElement(batch.payloadJson).jsonObject
            val acknowledgement = client.uploadDailySummaries(payload)
            if (
                acknowledgement.accepted < 0 ||
                acknowledgement.duplicates < 0 ||
                acknowledgement.stale < 0 ||
                acknowledgement.accepted + acknowledgement.duplicates + acknowledgement.stale != batch.summaryCount
            ) {
                throw ApiFailure(false, "server acknowledgement count does not match the daily-summary batch")
            }
            val completedAt = now()
            database.withTransaction {
                dao.markPhoneDailySummariesSynced(
                    source = batch.source,
                    sourceDay = batch.sourceDay,
                    sampledAt = batch.sampledAt,
                    syncedAt = completedAt,
                )
                dao.markPhoneDailySummaryUploadComplete(batch.batchId, completedAt)
            }
            diagnostics.syncSucceeded(completedAt)
            SyncOneResult.Success(batch.summaryCount)
        } catch (error: Exception) {
            val retryable = (error as? ApiFailure)?.retryable == true
            val message = (error.message ?: error.javaClass.simpleName).take(2048)
            dao.markPhoneDailySummaryUploadError(batch.batchId, now(), message)
            diagnostics.syncFailed(now(), message)
            SyncOneResult.Failure(retryable, message)
        }
    }

    suspend fun syncOneSleepSummary(): SyncOneResult {
        val batch = dao.oldestOpenSleepSummaryUpload() ?: return SyncOneResult.NoWork
        val attemptedAt = now()
        dao.markSleepSummaryUploadAttempted(batch.batchId, attemptedAt)
        diagnostics.syncAttempt(attemptedAt)
        return try {
            val payload = HealthContract.json.parseToJsonElement(batch.payloadJson).jsonObject
            val acknowledgement = client.uploadSleepSummaries(payload)
            if (
                acknowledgement.accepted < 0 ||
                acknowledgement.duplicates < 0 ||
                acknowledgement.stale < 0 ||
                acknowledgement.accepted + acknowledgement.duplicates + acknowledgement.stale != batch.summaryCount
            ) {
                throw ApiFailure(false, "server acknowledgement count does not match the sleep-summary batch")
            }
            val completedAt = now()
            database.withTransaction {
                dao.markSleepSummarySynced(
                    source = batch.source,
                    sourceDay = batch.sourceDay,
                    sampledAt = batch.sampledAt,
                    syncedAt = completedAt,
                )
                dao.markSleepSummaryUploadComplete(batch.batchId, completedAt)
            }
            diagnostics.syncSucceeded(completedAt)
            SyncOneResult.Success(batch.summaryCount)
        } catch (error: Exception) {
            val retryable = (error as? ApiFailure)?.retryable == true
            val message = (error.message ?: error.javaClass.simpleName).take(2048)
            dao.markSleepSummaryUploadError(batch.batchId, now(), message)
            diagnostics.syncFailed(now(), message)
            SyncOneResult.Failure(retryable, message)
        }
    }

    suspend fun refreshActiveSessions(): Result<Int> = runCatching {
        val count = client.activeSessionCount()
        diagnostics.activeSessionsChecked(now(), count)
        count
    }.onFailure { error ->
        diagnostics.syncFailed(now(), error.message ?: error.javaClass.simpleName)
    }

    private suspend fun claimNextUpload(): ClaimedUpload? = database.withTransaction {
        val open = dao.oldestOpenUploadBatch()
        if (open != null) {
            return@withTransaction ClaimedUpload(open, dao.eventsForBatch(open.batchId))
        }
        val candidates = dao.unassignedEvents(HealthContract.MAX_BATCH_EVENTS)
        if (candidates.isEmpty()) return@withTransaction null
        val selected = mutableListOf<HealthEventEntity>()
        var payloadBytes = 256
        for (candidate in candidates) {
            val eventBytes = candidate.rawEventJson.toByteArray(Charsets.UTF_8).size + 1
            if (selected.isNotEmpty() && payloadBytes + eventBytes > MAX_UPLINK_PAYLOAD_BYTES) break
            selected += candidate
            payloadBytes += eventBytes
        }
        val createdAt = now()
        val batch = UploadBatchEntity(
            batchId = "android-${UUID.randomUUID()}",
            createdAt = createdAt,
            sentAt = createdAt,
            eventCount = selected.size,
        )
        dao.insertUploadBatch(batch)
        val assigned = dao.assignEventsToBatch(selected.map { it.eventId }, batch.batchId)
        check(assigned == selected.size) { "pending queue changed while assigning an upload batch" }
        ClaimedUpload(batch, dao.eventsForBatch(batch.batchId))
    }

    private fun buildUploadPayload(claimed: ClaimedUpload): JsonObject = buildJsonObject {
        put("batch_id", claimed.batch.batchId)
        put("producer", PRODUCER)
        put("sent_at", claimed.batch.sentAt)
        put(
            "events",
            JsonArray(
                claimed.events.map { event ->
                    HealthContract.json.parseToJsonElement(event.rawEventJson)
                },
            ),
        )
    }

    private fun rejectConflictsWithin(batch: IncomingHealthBatch) {
        for ((eventId, events) in batch.events.groupBy { it.eventId }) {
            if (events.map { it.rawEventJson }.distinct().size > 1) {
                throw ContractViolation(
                    "EVENT_ID_CONFLICT",
                    "event_id $eventId occurs more than once with different observations",
                )
            }
        }
    }

    private fun digest(batch: IncomingHealthBatch): String {
        val canonical = buildJsonObject {
            put("batch_id", batch.batchId)
            put("producer", batch.producer)
            if (batch.sentAt == null) put("sent_at", kotlinx.serialization.json.JsonNull)
            else put("sent_at", batch.sentAt)
            put(
                "events",
                JsonArray(batch.events.map { HealthContract.json.parseToJsonElement(it.rawEventJson) }),
            )
        }.toString()
        return MessageDigest.getInstance("SHA-256")
            .digest(canonical.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> (byte.toInt() and 0xff).toString(16).padStart(2, '0') }
    }

    companion object {
        private const val PRODUCER = "akari-pulse-android"
        private const val VIVO_PRIVATE_PRODUCER = "akari-pulse-android-vivo-private"
        private const val MAX_UPLINK_PAYLOAD_BYTES = 900_000
    }
}
