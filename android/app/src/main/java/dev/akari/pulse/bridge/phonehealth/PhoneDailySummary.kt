package dev.akari.pulse.bridge.phonehealth

import kotlinx.serialization.json.JsonPrimitive

data class PhoneDailySummaryRecord(
    val source: String,
    val metric: String,
    val sourceDay: String,
    val sourceTimezone: String,
    val valueJson: String?,
    val unit: String,
    val sampledAt: Long,
    val sampledAtText: String,
    val sourceTimestampAvailable: Boolean,
    val status: String,
    val outcome: String,
    val verification: String,
    val rawErrorCode: String?,
    val rawErrorMessage: String?,
)

fun PhoneTodayActivity.toDailySummaryRecords(): List<PhoneDailySummaryRecord> = listOf(
    dailySummary(
        metric = PHONE_STEP_COUNT,
        value = steps,
        unit = "count",
        fieldVerification = verification.steps,
    ),
    dailySummary(
        metric = PHONE_DISTANCE,
        value = distanceMeters,
        unit = "m",
        fieldVerification = verification.distanceMeters,
    ),
    dailySummary(
        metric = PHONE_CALORIES,
        value = caloriesKilocalories,
        unit = "kcal",
        fieldVerification = verification.caloriesKilocalories,
    ),
)

private fun PhoneTodayActivity.dailySummary(
    metric: String,
    value: Number?,
    unit: String,
    fieldVerification: FieldVerification,
): PhoneDailySummaryRecord {
    val storedValue = if (status == PhoneHealthStatus.PASS) {
        JsonPrimitive(checkNotNull(value) { "$metric is missing from a PASS provider result" }).toString()
    } else {
        null
    }
    val errorMessage = listOfNotNull(
        diagnostics.exceptionType,
        diagnostics.exceptionMessage,
    ).joinToString(": ").takeIf { it.isNotBlank() }
    return PhoneDailySummaryRecord(
        source = PHONE_SOURCE,
        metric = metric,
        sourceDay = day,
        sourceTimezone = timezone,
        valueJson = storedValue,
        unit = unit,
        sampledAt = sampleEpochMs,
        sampledAtText = sampledAt,
        sourceTimestampAvailable = diagnostics.sourceTimestampAvailable,
        status = status.name,
        outcome = outcome.name,
        verification = fieldVerification.name,
        rawErrorCode = diagnostics.failureStage,
        rawErrorMessage = errorMessage,
    )
}

const val PHONE_SOURCE = "vivo_phone"
const val PHONE_STEP_COUNT = "phone_step_count"
const val PHONE_DISTANCE = "phone_distance"
const val PHONE_CALORIES = "phone_calories"
