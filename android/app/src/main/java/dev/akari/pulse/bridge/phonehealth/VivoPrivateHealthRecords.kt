package dev.akari.pulse.bridge.phonehealth

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A locally produced health event, already shaped like the wire contract. */
data class LocalHealthEvent(
    val eventId: String,
    val timestamp: Long,
    val metric: String,
    val hasValue: Boolean,
    val valueJson: String?,
    val unit: String?,
    val sourceDevice: String,
    val sourceModule: String?,
    val sourceApi: String?,
    val quality: String?,
    val status: String,
    val rawErrorCode: String?,
    val rawErrorMessage: String?,
) {
    /**
     * Field order matches `HealthContract.canonicalEventJson` and the service-side payload,
     * so a replayed event serializes identically everywhere.
     */
    fun toWireJson(): JsonObject = buildJsonObject {
        put("event_id", eventId)
        put("timestamp", timestamp)
        put("sample_timestamp", JsonNullValue)
        put("metric", metric)
        put("unit", unit?.let(::JsonPrimitive) ?: JsonNullValue)
        put("source_device", sourceDevice)
        put("source_module", sourceModule?.let(::JsonPrimitive) ?: JsonNullValue)
        put("source_api", sourceApi?.let(::JsonPrimitive) ?: JsonNullValue)
        put("quality", quality?.let(::JsonPrimitive) ?: JsonNullValue)
        put("status", status)
        put("session_id", JsonNullValue)
        put("callback_delta_ms", JsonNullValue)
        put("raw_error_code", rawErrorCode?.let(::JsonPrimitive) ?: JsonNullValue)
        put("raw_error_message", rawErrorMessage?.let(::JsonPrimitive) ?: JsonNullValue)
        if (hasValue) put("value", checkNotNull(valueJson).toJsonValue())
    }
}

data class SleepSummaryRecord(
    val source: String,
    val sourceDay: String,
    val sourceTimezone: String,
    val sourceDayStart: Long?,
    val sleepStart: Long,
    val sleepEnd: Long,
    val sampledAt: Long,
    val sampledAtText: String,
    val status: String,
    val outcome: String,
    val verification: String,
    val recorderGeneration: Int?,
    val lowAccuracy: Boolean?,
    val score: Int?,
    val deepSleepContinuity: Int?,
    val totalDurationMs: Long,
    val nightSleepDurationMs: Long?,
    val napDurationMs: Long?,
    val chartTotalDurationMs: Long?,
    val lightSleepDurationMs: Long?,
    val deepSleepDurationMs: Long?,
    val remSleepDurationMs: Long?,
    val awakeDurationMs: Long?,
    val awakeEpisodeCount: Int?,
    val awakeEpisodeDurationMs: Long?,
    val stagesJson: String,
) {
    fun toWireJson(): JsonObject = buildJsonObject {
        put("source", source)
        put("source_day", sourceDay)
        put("source_timezone", sourceTimezone)
        sourceDayStart?.let { put("source_day_start", it) }
        put("sleep_start", sleepStart)
        put("sleep_end", sleepEnd)
        put("sampled_at", sampledAtText)
        put("status", status)
        put("outcome", outcome)
        put("verification", verification)
        recorderGeneration?.let { put("recorder_generation", it) }
        lowAccuracy?.let { put("low_accuracy", it) }
        score?.let { put("score", it) }
        deepSleepContinuity?.let { put("deep_sleep_continuity", it) }
        put("total_duration_ms", totalDurationMs)
        nightSleepDurationMs?.let { put("night_sleep_duration_ms", it) }
        napDurationMs?.let { put("nap_duration_ms", it) }
        chartTotalDurationMs?.let { put("chart_total_duration_ms", it) }
        lightSleepDurationMs?.let { put("light_sleep_duration_ms", it) }
        deepSleepDurationMs?.let { put("deep_sleep_duration_ms", it) }
        remSleepDurationMs?.let { put("rem_sleep_duration_ms", it) }
        awakeDurationMs?.let { put("awake_duration_ms", it) }
        awakeEpisodeCount?.let { put("awake_episode_count", it) }
        awakeEpisodeDurationMs?.let { put("awake_episode_duration_ms", it) }
        put("stages", stagesJson.toJsonValue())
    }
}

/**
 * Only an observed sleep day is transmitted. A permission, provider, or parse failure has no
 * calendar day to attach itself to, so it is reported by the capability event instead of writing
 * a placeholder row that could displace a real one.
 */
fun VivoPrivateHealthSnapshot.toSleepSummaryRecord(): SleepSummaryRecord? {
    if (sleep.status != PhoneHealthStatus.PASS) return null
    return SleepSummaryRecord(
        source = source,
        sourceDay = checkNotNull(sleep.sourceDay),
        sourceTimezone = timezone,
        sourceDayStart = sleep.sourceDayStartEpochMs,
        sleepStart = checkNotNull(sleep.sleepStartEpochMs),
        sleepEnd = checkNotNull(sleep.sleepEndEpochMs),
        sampledAt = readAtEpochMs,
        sampledAtText = readAt,
        status = sleep.status.name,
        outcome = sleep.outcome.name,
        verification = SLEEP_VERIFICATION,
        recorderGeneration = sleep.recorderGeneration,
        lowAccuracy = sleep.lowAccuracy,
        score = sleep.score,
        deepSleepContinuity = sleep.deepSleepContinuity,
        totalDurationMs = checkNotNull(sleep.totalDurationMs),
        nightSleepDurationMs = sleep.nightSleepDurationMs,
        napDurationMs = sleep.napDurationMs,
        chartTotalDurationMs = sleep.chartTotalDurationMs,
        lightSleepDurationMs = sleep.lightSleepDurationMs,
        deepSleepDurationMs = sleep.deepSleepDurationMs,
        remSleepDurationMs = sleep.remSleepDurationMs,
        awakeDurationMs = sleep.awakeDurationMs,
        awakeEpisodeCount = sleep.awakeEpisodeCount,
        awakeEpisodeDurationMs = sleep.awakeEpisodeDurationMs,
        // A stage key is present only when the provider actually returned that interval list;
        // an absent list stays absent instead of becoming an empty stage.
        stagesJson = buildJsonObject {
            sleep.lightSleepIntervals?.let { put("light", it.toJsonArray()) }
            sleep.deepSleepIntervals?.let { put("deep", it.toJsonArray()) }
            sleep.remSleepIntervals?.let { put("rem", it.toJsonArray()) }
            sleep.awakeIntervals?.let { put("awake", it.toJsonArray()) }
        }.toString(),
    )
}

/**
 * The capability verdict, plus one event per vital. The vitals are latest single points with
 * their own vivo source timestamps; they are never presented as daily aggregates, and they use
 * their own metric names so that a watch reading and a phone reading never overwrite each other.
 */
fun VivoPrivateHealthSnapshot.toHealthEvents(): List<LocalHealthEvent> {
    val events = mutableListOf(capabilityEvent())
    if (capability != VivoPrivateHealthCapability.GRANTED) return events
    events += vitalEvent(VivoPrivateHealthSnapshot.HEART_RATE_METRIC, vitals.heartRate)
    events += vitalEvent(VivoPrivateHealthSnapshot.SPO2_METRIC, vitals.spo2)
    events += vitalEvent(VivoPrivateHealthSnapshot.STRESS_METRIC, vitals.stress)
    return events
}

private fun VivoPrivateHealthSnapshot.capabilityEvent(): LocalHealthEvent {
    val status = when {
        capability == VivoPrivateHealthCapability.NOT_GRANTED -> "DENIED"
        capability == VivoPrivateHealthCapability.UNSUPPORTED -> "UNSUPPORTED"
        capability == VivoPrivateHealthCapability.ERROR -> "ERROR"
        sleep.status == PhoneHealthStatus.ERROR || vitals.status == PhoneHealthStatus.ERROR -> "ERROR"
        sleep.status == PhoneHealthStatus.PASS || vitals.status == PhoneHealthStatus.PASS -> "PASS"
        else -> "NO_DATA"
    }
    val rawErrorCode = when (capability) {
        VivoPrivateHealthCapability.GRANTED -> when {
            sleep.status == PhoneHealthStatus.ERROR -> sleep.outcome.name
            vitals.status == PhoneHealthStatus.ERROR -> vitals.outcome.name
            else -> null
        }
        else -> sleep.outcome.name
    }
    val detail = when (capability) {
        VivoPrivateHealthCapability.GRANTED ->
            "sleep=${sleep.status}/${sleep.outcome} vitals=${vitals.status}/${vitals.outcome}"
        VivoPrivateHealthCapability.NOT_GRANTED ->
            "${VivoPrivateHealthSnapshot.REQUIRED_PERMISSION} is not granted; " +
                "re-run scripts/bootstrap-vivo-private-health.ps1 (a reinstall clears the grant)"
        VivoPrivateHealthCapability.UNSUPPORTED ->
            "the vivo private health providers do not exist on this device"
        VivoPrivateHealthCapability.ERROR ->
            listOfNotNull(sleep.exceptionType, sleep.exceptionMessage).joinToString(": ")
                .ifBlank { "the capability probe failed" }
    }
    return LocalHealthEvent(
        eventId = "${VivoPrivateHealthSnapshot.CAPABILITY_METRIC}-$readAtEpochMs",
        timestamp = readAtEpochMs,
        metric = VivoPrivateHealthSnapshot.CAPABILITY_METRIC,
        hasValue = true,
        valueJson = JsonPrimitive(capability.name).toString(),
        unit = null,
        sourceDevice = source,
        sourceModule = VIVO_HEALTH_PACKAGE,
        sourceApi = CAPABILITY_SOURCE_API,
        quality = "owner_adb_bootstrap",
        status = status,
        rawErrorCode = rawErrorCode,
        rawErrorMessage = detail.take(MAX_MESSAGE_LENGTH),
    )
}

private fun VivoPrivateHealthSnapshot.vitalEvent(metric: String, vital: VivoLatestVital): LocalHealthEvent {
    val pass = vital.status == PhoneHealthStatus.PASS
    val timestamp = if (pass) checkNotNull(vital.sourceEpochMs) else readAtEpochMs
    val abnormal = vital.abnormalFlag
    return LocalHealthEvent(
        eventId = if (pass) "$metric-$timestamp" else "$metric-${vital.status.name.lowercase()}-$readAtEpochMs",
        timestamp = timestamp,
        metric = metric,
        hasValue = pass,
        valueJson = if (pass) JsonPrimitive(checkNotNull(vital.value)).toString() else null,
        unit = vital.unit,
        sourceDevice = source,
        // vivo's own `sourceFrom`, i.e. which device family produced the sample the phone stored.
        sourceModule = vitals.providerSourceFrom,
        sourceApi = CARE_SOURCE_API,
        quality = if (pass && abnormal != null && abnormal != 0) {
            "latest_snapshot_abnormal_$abnormal"
        } else if (pass) {
            "latest_snapshot"
        } else {
            null
        },
        status = if (pass) "PASS" else vital.status.name,
        rawErrorCode = if (pass) null else vital.outcome.name,
        rawErrorMessage = if (pass) {
            null
        } else {
            listOfNotNull(vitals.failureStage, vitals.exceptionType, vitals.exceptionMessage)
                .joinToString(": ")
                .ifBlank { "the care provider returned no ${metric.removePrefix("phone_")} point" }
                .take(MAX_MESSAGE_LENGTH)
        },
    )
}

private fun List<SleepStageInterval>.toJsonArray(): JsonArray = buildJsonArray {
    forEach { interval ->
        add(
            buildJsonObject {
                put("start", interval.startEpochMs)
                put("end", interval.endEpochMs)
            },
        )
    }
}

private fun String.toJsonValue() = WIRE_JSON.parseToJsonElement(this)

private val WIRE_JSON = kotlinx.serialization.json.Json
private val JsonNullValue: kotlinx.serialization.json.JsonElement = kotlinx.serialization.json.JsonNull

private const val VIVO_HEALTH_PACKAGE = "com.vivo.health"
private const val CAPABILITY_SOURCE_API = "com.vivo.health.widget.permission"
private const val CARE_SOURCE_API = "com.vivo.health.provider.care/healthCare#MYSELF_DATA"
private const val SLEEP_VERIFICATION = "VERIFIED"
private const val MAX_MESSAGE_LENGTH = 2048
