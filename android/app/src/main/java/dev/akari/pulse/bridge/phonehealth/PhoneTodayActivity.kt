package dev.akari.pulse.bridge.phonehealth

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
enum class PhoneHealthStatus {
    PASS,
    NO_DATA,
    ERROR,
}

@Serializable
enum class PhoneHealthOutcome {
    PROVIDER_CALL_SUCCEEDED,
    PROVIDER_NO_DATA,
    PROVIDER_CALL_FAILED,
    PARSE_FAILED,
}

@Serializable
enum class FieldVerification {
    VERIFIED,
    VERIFIED_FORMATTED_DISPLAY,
    UNVERIFIED,
}

@Serializable
data class PhoneActivityVerification(
    val steps: FieldVerification = FieldVerification.VERIFIED,
    @SerialName("distance_m")
    val distanceMeters: FieldVerification = FieldVerification.VERIFIED_FORMATTED_DISPLAY,
    @SerialName("calories_kcal")
    val caloriesKilocalories: FieldVerification = FieldVerification.VERIFIED_FORMATTED_DISPLAY,
)

@Serializable
data class PhoneHealthDiagnostics(
    @SerialName("permission_granted")
    val permissionGranted: Boolean,
    @SerialName("request_ignore")
    val requestIgnore: Boolean = true,
    @SerialName("settings_used_as_fallback")
    val settingsUsedAsFallback: Boolean = false,
    @SerialName("capability_bundle_keys")
    val capabilityBundleKeys: List<String> = emptyList(),
    @SerialName("provider_bundle_keys")
    val providerBundleKeys: List<String> = emptyList(),
    @SerialName("raw_can_step")
    val rawCanStep: Int? = null,
    @SerialName("raw_ret_code")
    val rawRetCode: Int? = null,
    @SerialName("ret_code_available")
    val retCodeAvailable: Boolean = false,
    @SerialName("settings_realtime_steps_raw")
    val settingsRealtimeStepsRaw: String? = null,
    @SerialName("settings_exception_type")
    val settingsExceptionType: String? = null,
    @SerialName("settings_exception_message")
    val settingsExceptionMessage: String? = null,
    @SerialName("request_started_epoch_ms")
    val requestStartedEpochMs: Long,
    @SerialName("response_received_epoch_ms")
    val responseReceivedEpochMs: Long,
    @SerialName("call_duration_ms")
    val callDurationMs: Long,
    @SerialName("failure_stage")
    val failureStage: String? = null,
    @SerialName("exception_type")
    val exceptionType: String? = null,
    @SerialName("exception_message")
    val exceptionMessage: String? = null,
    @SerialName("source_timestamp_available")
    val sourceTimestampAvailable: Boolean = false,
)

@Serializable
data class PhoneTodayActivity(
    val status: PhoneHealthStatus,
    val outcome: PhoneHealthOutcome,
    val source: String = SOURCE,
    val day: String,
    val timezone: String,
    val steps: Int? = null,
    @SerialName("distance_m")
    val distanceMeters: Double? = null,
    @SerialName("calories_kcal")
    val caloriesKilocalories: Double? = null,
    @SerialName("sample_epoch_ms")
    val sampleEpochMs: Long,
    @SerialName("sampled_at")
    val sampledAt: String,
    val freshness: String = FRESHNESS,
    val verification: PhoneActivityVerification = PhoneActivityVerification(),
    val diagnostics: PhoneHealthDiagnostics,
) {
    fun toJson(): String = JSON.encodeToString(this)

    companion object {
        const val SOURCE = "vivo_assistant_step_provider"
        const val FRESHNESS = "SAMPLE_TIME_ONLY_SOURCE_TIMESTAMP_UNAVAILABLE"

        private val JSON = Json {
            encodeDefaults = true
            explicitNulls = true
        }
    }
}
