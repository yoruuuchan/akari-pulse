package dev.akari.pulse.bridge.phonehealth

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Read models for the vivo private health providers.
 *
 * These two providers are protected by `com.vivo.health.widget.permission`
 * (`signature|privileged`). A store-installed third party is never granted it; the owner
 * grants it once over ADB (see `scripts/bootstrap-vivo-private-health.ps1`). Reinstalling the
 * APK resets the grant, so the capability verdict below is a first-class result, never a
 * silent fallback.
 *
 * Verified on one vivo X200 Pro (V2405A / PD2405, Android 15) against the vivo Health UI.
 * Other vivo or iQOO models and firmware are unverified.
 */
@Serializable
enum class VivoPrivateHealthCapability {
    /** The permission is held and both provider authorities resolve. */
    GRANTED,

    /** The providers exist but `com.vivo.health.widget.permission` is not granted to this app. */
    NOT_GRANTED,

    /** At least one provider authority does not exist on this device. */
    UNSUPPORTED,

    /** The capability probe itself failed. */
    ERROR,
}

@Serializable
enum class VivoPrivateOutcome {
    PROVIDER_CALL_SUCCEEDED,
    PROVIDER_NO_DATA,
    PROVIDER_CALL_FAILED,
    PARSE_FAILED,
    PERMISSION_NOT_GRANTED,
    PROVIDER_UNSUPPORTED,
    CAPABILITY_PROBE_FAILED,
}

@Serializable
data class SleepStageInterval(
    @SerialName("start_epoch_ms")
    val startEpochMs: Long,
    @SerialName("end_epoch_ms")
    val endEpochMs: Long,
)

/**
 * One vivo sleep day, keyed by the local calendar day the wake-up time falls in.
 *
 * vivo attributes a sleep record to the calendar day of `EXIT_TIME`, with a zero day offset.
 * `sourceDay` / `sourceDayStartEpochMs` are the provider's own `DATE` / `TIMESTAMP` columns and
 * are never recomputed here.
 */
@Serializable
data class VivoSleepDay(
    val status: PhoneHealthStatus,
    val outcome: VivoPrivateOutcome,
    @SerialName("source_day")
    val sourceDay: String? = null,
    @SerialName("source_day_start_epoch_ms")
    val sourceDayStartEpochMs: Long? = null,
    @SerialName("sleep_start_epoch_ms")
    val sleepStartEpochMs: Long? = null,
    @SerialName("sleep_end_epoch_ms")
    val sleepEndEpochMs: Long? = null,
    @SerialName("total_duration_ms")
    val totalDurationMs: Long? = null,
    @SerialName("night_sleep_duration_ms")
    val nightSleepDurationMs: Long? = null,
    @SerialName("nap_duration_ms")
    val napDurationMs: Long? = null,
    /** vivo's chart-span field; equals `sleep_end − sleep_start` in the paired sample. */
    @SerialName("chart_total_duration_ms")
    val chartTotalDurationMs: Long? = null,
    @SerialName("light_sleep_duration_ms")
    val lightSleepDurationMs: Long? = null,
    @SerialName("deep_sleep_duration_ms")
    val deepSleepDurationMs: Long? = null,
    @SerialName("rem_sleep_duration_ms")
    val remSleepDurationMs: Long? = null,
    @SerialName("awake_duration_ms")
    val awakeDurationMs: Long? = null,
    /** Derived: awake intervals strictly inside the sleep span. Matches the vivo UI wake-up count. */
    @SerialName("awake_episode_count")
    val awakeEpisodeCount: Int? = null,
    @SerialName("awake_episode_duration_ms")
    val awakeEpisodeDurationMs: Long? = null,
    val score: Int? = null,
    @SerialName("deep_sleep_continuity")
    val deepSleepContinuity: Int? = null,
    @SerialName("low_accuracy")
    val lowAccuracy: Boolean? = null,
    /** vivo `WATCH_GENERATION`: `-1` phone detection, `1`/`2`/`3` watch generation. */
    @SerialName("recorder_generation")
    val recorderGeneration: Int? = null,
    @SerialName("light_sleep_intervals")
    val lightSleepIntervals: List<SleepStageInterval>? = null,
    @SerialName("deep_sleep_intervals")
    val deepSleepIntervals: List<SleepStageInterval>? = null,
    @SerialName("rem_sleep_intervals")
    val remSleepIntervals: List<SleepStageInterval>? = null,
    @SerialName("awake_intervals")
    val awakeIntervals: List<SleepStageInterval>? = null,
    @SerialName("failure_stage")
    val failureStage: String? = null,
    @SerialName("exception_type")
    val exceptionType: String? = null,
    @SerialName("exception_message")
    val exceptionMessage: String? = null,
)

/**
 * One latest vital point from `content://com.vivo.health.provider.care/healthCare`.
 *
 * This provider exposes the newest single sample only. It carries no daily minimum, maximum,
 * average, or resting heart rate, so nothing here may be presented as a daily aggregate.
 */
@Serializable
data class VivoLatestVital(
    val status: PhoneHealthStatus,
    val outcome: VivoPrivateOutcome,
    val value: Double? = null,
    val unit: String,
    @SerialName("source_epoch_ms")
    val sourceEpochMs: Long? = null,
    @SerialName("source_time")
    val sourceTime: String? = null,
    @SerialName("abnormal_flag")
    val abnormalFlag: Int? = null,
)

@Serializable
data class VivoLatestVitals(
    val status: PhoneHealthStatus,
    val outcome: VivoPrivateOutcome,
    @SerialName("heart_rate")
    val heartRate: VivoLatestVital,
    val spo2: VivoLatestVital,
    val stress: VivoLatestVital,
    /** vivo `sourceFrom`, e.g. `VIVO_WATCH`: which device family produced these samples. */
    @SerialName("provider_source_from")
    val providerSourceFrom: String? = null,
    @SerialName("failure_stage")
    val failureStage: String? = null,
    @SerialName("exception_type")
    val exceptionType: String? = null,
    @SerialName("exception_message")
    val exceptionMessage: String? = null,
)

@Serializable
data class VivoPrivateHealthSnapshot(
    val capability: VivoPrivateHealthCapability,
    val source: String = SOURCE,
    @SerialName("read_at_epoch_ms")
    val readAtEpochMs: Long,
    @SerialName("read_at")
    val readAt: String,
    val timezone: String,
    @SerialName("permission_granted")
    val permissionGranted: Boolean,
    @SerialName("providers_resolved")
    val providersResolved: Boolean,
    @SerialName("sleep_cursor_columns")
    val sleepCursorColumns: List<String> = emptyList(),
    @SerialName("care_cursor_columns")
    val careCursorColumns: List<String> = emptyList(),
    val sleep: VivoSleepDay,
    val vitals: VivoLatestVitals,
) {
    fun toJson(): String = JSON.encodeToString(this)

    companion object {
        const val SOURCE = "vivo_phone"
        const val REQUIRED_PERMISSION = "com.vivo.health.widget.permission"

        const val HEART_RATE_METRIC = "phone_heart_rate"
        const val SPO2_METRIC = "phone_spo2"
        const val STRESS_METRIC = "phone_stress"
        const val CAPABILITY_METRIC = "diagnostic_vivo_private_health"

        const val HEART_RATE_UNIT = "bpm"
        const val SPO2_UNIT = "%"
        const val STRESS_UNIT = "score"

        private val JSON = Json {
            encodeDefaults = true
            explicitNulls = true
        }
    }
}
