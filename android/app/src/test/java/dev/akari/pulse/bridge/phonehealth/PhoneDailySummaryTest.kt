package dev.akari.pulse.bridge.phonehealth

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class PhoneDailySummaryTest {
    @Test
    fun passPreservesRealZeroAndSourceCalendarSemantics() {
        val records = activity(
            status = PhoneHealthStatus.PASS,
            outcome = PhoneHealthOutcome.PROVIDER_CALL_SUCCEEDED,
            steps = 0,
            distance = 0.0,
            calories = 0.0,
        ).toDailySummaryRecords()

        assertEquals(listOf(PHONE_STEP_COUNT, PHONE_DISTANCE, PHONE_CALORIES), records.map { it.metric })
        assertEquals("0", records.first().valueJson)
        assertEquals("2026-08-14", records.first().sourceDay)
        assertEquals("Asia/Shanghai", records.first().sourceTimezone)
        assertEquals("2026-08-14T10:00:00+08:00", records.first().sampledAtText)
        assertEquals(PHONE_SOURCE, records.first().source)
        assertFalse(records.first().sourceTimestampAvailable)
    }

    @Test
    fun noDataHasNoValueAndDoesNotBecomeZero() {
        val records = activity(
            status = PhoneHealthStatus.NO_DATA,
            outcome = PhoneHealthOutcome.PROVIDER_NO_DATA,
        ).toDailySummaryRecords()

        records.forEach { record ->
            assertEquals("NO_DATA", record.status)
            assertNull(record.valueJson)
            assertEquals("provider_call", record.rawErrorCode)
        }
    }

    @Test
    fun providerErrorRemainsError() {
        val records = activity(
            status = PhoneHealthStatus.ERROR,
            outcome = PhoneHealthOutcome.PROVIDER_CALL_FAILED,
            exceptionType = SecurityException::class.java.name,
            exceptionMessage = "permission denied",
        ).toDailySummaryRecords()

        records.forEach { record ->
            assertEquals("ERROR", record.status)
            assertNull(record.valueJson)
            assertEquals("${SecurityException::class.java.name}: permission denied", record.rawErrorMessage)
        }
    }

    private fun activity(
        status: PhoneHealthStatus,
        outcome: PhoneHealthOutcome,
        steps: Int? = null,
        distance: Double? = null,
        calories: Double? = null,
        exceptionType: String? = null,
        exceptionMessage: String? = null,
    ): PhoneTodayActivity = PhoneTodayActivity(
        status = status,
        outcome = outcome,
        day = "2026-08-14",
        timezone = "Asia/Shanghai",
        steps = steps,
        distanceMeters = distance,
        caloriesKilocalories = calories,
        sampleEpochMs = 1_786_674_000_000,
        sampledAt = "2026-08-14T10:00:00+08:00",
        diagnostics = PhoneHealthDiagnostics(
            permissionGranted = true,
            requestStartedEpochMs = 1_786_673_999_900,
            responseReceivedEpochMs = 1_786_674_000_000,
            callDurationMs = 100,
            failureStage = if (status == PhoneHealthStatus.PASS) null else "provider_call",
            exceptionType = exceptionType,
            exceptionMessage = exceptionMessage,
        ),
    )
}
