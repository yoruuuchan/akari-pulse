package dev.akari.pulse.bridge.phonehealth

import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Fixtures are synthetic. They reproduce the verified cursor shape (38 sleep columns addressed by
 * name, `MYSELF_DATA` as a HealthDetailBean JSON string) and the identities that were confirmed
 * against the vivo Health UI, without carrying anyone's real health values into a public repo.
 */
class VivoPrivateHealthReaderTest {
    @Test
    fun sleepDayIsParsedByColumnNameAndKeepsTheProviderDayAttribution() {
        val result = reader(FakeGateway(sleep = sleepRow(), care = careRow())).read()

        assertEquals(VivoPrivateHealthCapability.GRANTED, result.capability)
        val sleep = result.sleep
        assertEquals(PhoneHealthStatus.PASS, sleep.status)
        assertEquals(VivoPrivateOutcome.PROVIDER_CALL_SUCCEEDED, sleep.outcome)
        assertEquals("2026-01-02", sleep.sourceDay)
        assertEquals(DAY_START, sleep.sourceDayStartEpochMs)
        assertEquals(ENTER, sleep.sleepStartEpochMs)
        assertEquals(EXIT, sleep.sleepEndEpochMs)
        assertEquals(TOTAL, sleep.totalDurationMs)
        assertEquals(NIGHT, sleep.nightSleepDurationMs)
        assertEquals(0L, sleep.napDurationMs)
        assertEquals(EXIT - ENTER, sleep.chartTotalDurationMs)
        assertEquals(LIGHT, sleep.lightSleepDurationMs)
        assertEquals(DEEP, sleep.deepSleepDurationMs)
        assertEquals(REM, sleep.remSleepDurationMs)
        assertEquals(AWAKE_TOTAL, sleep.awakeDurationMs)
        assertEquals(64, sleep.score)
        assertEquals(90, sleep.deepSleepContinuity)
        assertEquals(false, sleep.lowAccuracy)
        assertEquals(2, sleep.recorderGeneration)
        assertEquals(2, sleep.deepSleepIntervals?.size)
        assertEquals(4, sleep.awakeIntervals?.size)

        // The verified identities hold on the parsed values.
        assertEquals(sleep.totalDurationMs, LIGHT + DEEP + REM)
        assertEquals(sleep.chartTotalDurationMs, EXIT - ENTER)
        assertEquals(sleep.nightSleepDurationMs, (EXIT - ENTER) - AWAKE_TOTAL)
    }

    @Test
    fun wakeUpCountUsesOnlyAwakeIntervalsStrictlyInsideTheSleepSpan() {
        val sleep = reader(FakeGateway(sleep = sleepRow(), care = careRow())).read().sleep

        // Four awake intervals are returned; the leading and trailing edges are not wake-ups.
        assertEquals(2, sleep.awakeEpisodeCount)
        assertEquals(1_200_000L, sleep.awakeEpisodeDurationMs)
    }

    @Test
    fun eachVitalKeepsItsOwnSourceTimestampAndUnit() {
        val vitals = reader(FakeGateway(sleep = sleepRow(), care = careRow())).read().vitals

        assertEquals(PhoneHealthStatus.PASS, vitals.status)
        assertEquals("VIVO_WATCH", vitals.providerSourceFrom)
        assertEquals(70.0, vitals.heartRate.value)
        assertEquals("bpm", vitals.heartRate.unit)
        assertEquals(HEART_AT, vitals.heartRate.sourceEpochMs)
        assertEquals(96.0, vitals.spo2.value)
        assertEquals("%", vitals.spo2.unit)
        assertEquals(SPO2_AT, vitals.spo2.sourceEpochMs)
        assertEquals(30.0, vitals.stress.value)
        assertEquals("score", vitals.stress.unit)
        assertEquals(STRESS_AT, vitals.stress.sourceEpochMs)
        assertEquals(0, vitals.heartRate.abnormalFlag)
    }

    @Test
    fun zeroValueAndZeroTimestampAreNoDataRatherThanAPhysiologicalZero() {
        val care = careRow(
            """
            {"heartValue":0.0,"heartTimeStamp":0,"heartAbnormalType":0,
             "saO2Value":96.0,"saO2TimeStamp":$SPO2_AT,"oxygenAbnormal":0,
             "pressureValue":0.0,"pressureTimeStamp":$STRESS_AT,"pressAbnormal":0,
             "sourceFrom":"VIVO_WATCH"}
            """.trimIndent(),
        )

        val vitals = reader(FakeGateway(sleep = sleepRow(), care = care)).read().vitals

        assertEquals(PhoneHealthStatus.NO_DATA, vitals.heartRate.status)
        assertNull(vitals.heartRate.value)
        assertEquals(PhoneHealthStatus.NO_DATA, vitals.stress.status)
        assertEquals(PhoneHealthStatus.PASS, vitals.spo2.status)
        assertEquals(PhoneHealthStatus.PASS, vitals.status)
    }

    @Test
    fun missingPermissionIsNotGrantedAndNeverSubstitutesData() {
        val gateway = FakeGateway(sleep = sleepRow(), care = careRow(), permission = false)

        val result = reader(gateway).read()

        assertEquals(VivoPrivateHealthCapability.NOT_GRANTED, result.capability)
        assertEquals(PhoneHealthStatus.ERROR, result.sleep.status)
        assertEquals(VivoPrivateOutcome.PERMISSION_NOT_GRANTED, result.sleep.outcome)
        assertEquals(PhoneHealthStatus.ERROR, result.vitals.status)
        assertFalse(gateway.sleepQueried)
        assertFalse(gateway.careQueried)
        assertNull(result.toSleepSummaryRecord())

        val events = result.toHealthEvents()
        assertEquals(1, events.size)
        assertEquals("DENIED", events.single().status)
        assertEquals("PERMISSION_NOT_GRANTED", events.single().rawErrorCode)
    }

    @Test
    fun absentProviderIsUnsupported() {
        val result = reader(FakeGateway(sleep = sleepRow(), care = careRow(), providers = false)).read()

        assertEquals(VivoPrivateHealthCapability.UNSUPPORTED, result.capability)
        assertEquals("UNSUPPORTED", result.toHealthEvents().single().status)
    }

    @Test
    fun emptySleepCursorIsNoDataAndWritesNoSleepDay() {
        val result = reader(FakeGateway(sleep = null, care = careRow())).read()

        assertEquals(PhoneHealthStatus.NO_DATA, result.sleep.status)
        assertEquals(VivoPrivateOutcome.PROVIDER_NO_DATA, result.sleep.outcome)
        assertNull(result.toSleepSummaryRecord())
    }

    @Test
    fun unparseableSourceDayIsAParseFailureRatherThanARecomputedDay() {
        val result = reader(FakeGateway(sleep = sleepRow(date = "01/02/2026"), care = careRow())).read()

        assertEquals(PhoneHealthStatus.ERROR, result.sleep.status)
        assertEquals(VivoPrivateOutcome.PARSE_FAILED, result.sleep.outcome)
        assertNull(result.toSleepSummaryRecord())
    }

    @Test
    fun aStageListTheProviderDidNotReturnStaysAbsentInsteadOfBecomingZero() {
        val row = sleepRow().toMutableMap().apply {
            remove("REM_SLEEP_DURATION")
            remove("REM_SLEEP_LIST")
        }

        val sleep = reader(FakeGateway(sleep = row, care = careRow())).read().sleep

        assertEquals(PhoneHealthStatus.PASS, sleep.status)
        assertNull(sleep.remSleepDurationMs)
        assertNull(sleep.remSleepIntervals)
        assertFalse(assertNotNull(sleep.toRecordStages()).contains("\"rem\""))
    }

    @Test
    fun vitalEventsUseDistinctPhoneMetricsAndDeterministicIdentifiers() {
        val result = reader(FakeGateway(sleep = sleepRow(), care = careRow())).read()

        val events = result.toHealthEvents().associateBy { it.metric }
        assertEquals(
            setOf("diagnostic_vivo_private_health", "phone_heart_rate", "phone_spo2", "phone_stress"),
            events.keys,
        )
        val heartRate = events.getValue("phone_heart_rate")
        assertEquals("phone_heart_rate-$HEART_AT", heartRate.eventId)
        assertEquals(HEART_AT, heartRate.timestamp)
        assertEquals("PASS", heartRate.status)
        assertEquals("vivo_phone", heartRate.sourceDevice)
        assertEquals("VIVO_WATCH", heartRate.sourceModule)
        assertEquals("latest_snapshot", heartRate.quality)
        assertEquals("PASS", events.getValue("diagnostic_vivo_private_health").status)

        // Re-reading the same unchanged snapshot produces the same identifiers, so a replay
        // deduplicates instead of creating a second observation.
        val replay = reader(FakeGateway(sleep = sleepRow(), care = careRow())).read()
        assertEquals(
            result.toHealthEvents().filter { it.metric != "diagnostic_vivo_private_health" }.map { it.eventId },
            replay.toHealthEvents().filter { it.metric != "diagnostic_vivo_private_health" }.map { it.eventId },
        )
    }

    @Test
    fun sleepRecordCarriesTheProviderDayAndDerivedWakeUps() {
        val record = assertNotNull(reader(FakeGateway(sleep = sleepRow(), care = careRow())).read().toSleepSummaryRecord())

        assertEquals("vivo_phone", record.source)
        assertEquals("2026-01-02", record.sourceDay)
        assertEquals("Asia/Shanghai", record.sourceTimezone)
        assertEquals("PASS", record.status)
        assertEquals(2, record.awakeEpisodeCount)
        assertTrue(record.stagesJson.contains("\"deep\""))
        assertTrue(record.toWireJson().toString().contains("\"source_day\":\"2026-01-02\""))
    }

    private fun VivoSleepDay.toRecordStages(): String? =
        VivoPrivateHealthSnapshot(
            capability = VivoPrivateHealthCapability.GRANTED,
            readAtEpochMs = READ_AT,
            readAt = "2026-01-02T20:00:00+08:00",
            timezone = "Asia/Shanghai",
            permissionGranted = true,
            providersResolved = true,
            sleep = this,
            vitals = VivoLatestVitals(
                status = PhoneHealthStatus.NO_DATA,
                outcome = VivoPrivateOutcome.PROVIDER_NO_DATA,
                heartRate = VivoLatestVital(PhoneHealthStatus.NO_DATA, VivoPrivateOutcome.PROVIDER_NO_DATA, unit = "bpm"),
                spo2 = VivoLatestVital(PhoneHealthStatus.NO_DATA, VivoPrivateOutcome.PROVIDER_NO_DATA, unit = "%"),
                stress = VivoLatestVital(PhoneHealthStatus.NO_DATA, VivoPrivateOutcome.PROVIDER_NO_DATA, unit = "score"),
            ),
        ).toSleepSummaryRecord()?.stagesJson

    private fun reader(gateway: FakeGateway) = VivoPrivateHealthReader(
        gateway = gateway,
        now = { READ_AT },
        zoneId = { ZoneId.of("Asia/Shanghai") },
    )

    private class FakeGateway(
        private val sleep: Map<String, String?>?,
        private val care: Map<String, String?>?,
        private val permission: Boolean = true,
        private val providers: Boolean = true,
    ) : VivoPrivateHealthGateway {
        var sleepQueried = false
            private set
        var careQueried = false
            private set

        override fun permissionGranted(): Boolean = permission

        override fun providersResolved(): Boolean = providers

        override fun querySleep(): ProviderRow? {
            sleepQueried = true
            return sleep?.let { ProviderRow(it.keys.toList(), it) }
        }

        override fun queryCare(): ProviderRow? {
            careQueried = true
            return care?.let { ProviderRow(it.keys.toList(), it) }
        }
    }

    private companion object {
        const val READ_AT = 1_767_355_200_000L
        const val DAY_START = 1_767_283_200_000L
        const val ENTER = 1_767_310_000_000L
        const val EXIT = ENTER + 28_800_000L
        const val DEEP = 3_600_000L
        const val REM = 5_400_000L
        const val LIGHT = 17_400_000L
        const val AWAKE_TOTAL = 2_400_000L
        const val TOTAL = LIGHT + DEEP + REM
        const val NIGHT = TOTAL
        const val HEART_AT = 1_767_354_000_000L
        const val SPO2_AT = 1_767_350_000_000L
        const val STRESS_AT = 1_767_353_000_000L

        fun sleepRow(date: String = "2026-01-02"): Map<String, String?> = mapOf(
            "UUID" to null,
            "DEVICE_ID" to null,
            "WATCH_GENERATION" to "2",
            "ENTER_TIME" to "$ENTER",
            "EXIT_TIME" to "$EXIT",
            "SCORE" to "64",
            "DATE" to date,
            "TIMESTAMP" to "$DAY_START",
            "TOTAL_DURATION" to "$TOTAL",
            "CHARVIEW_TOTAL_DURATION" to "${EXIT - ENTER}",
            "NIGHT_SLEEP_TOTAL" to "$NIGHT",
            "LIGHT_SLEEP_DURATION" to "$LIGHT",
            "LIGHT_SLEEP_LIST" to intervals(ENTER to ENTER + LIGHT),
            "SLEEP_LOW_ACCURACY" to "0",
            "DEEP_SLEEP_DURATION" to "$DEEP",
            "DEEP_SLEEP_LIST" to intervals(
                ENTER + LIGHT to ENTER + LIGHT + 1_800_000,
                ENTER + LIGHT + 1_800_000 to ENTER + LIGHT + DEEP,
            ),
            "REM_SLEEP_DURATION" to "$REM",
            "REM_SLEEP_LIST" to intervals(ENTER + LIGHT + DEEP to ENTER + LIGHT + DEEP + REM),
            "AWAKE_SLEEP_DURATION" to "$AWAKE_TOTAL",
            "AWAKE_SLEEP_LIST" to intervals(
                ENTER to ENTER + 600_000,
                ENTER + 10_000_000 to ENTER + 10_600_000,
                ENTER + 20_000_000 to ENTER + 20_600_000,
                EXIT - 600_000 to EXIT,
            ),
            "APNOEA_SLEEP_LIST" to null,
            "NAP_TOTAL" to "0",
            "INSIGHT" to "0",
            "FEEDBACK" to "0",
            "ENTER_BODY_RESOURCES" to "0",
            "EXIT_BODY_RESOURCES" to "0",
            "SLEEP_BREATHING_QUALITY" to "0",
            "DEEP_SLEEP_CONTINUITY" to "90",
            "SLEEP_BREATHING_TIMES" to "0",
            "BREATH_BREAKING_RISK_LEVEL" to "0",
            "SNORE_SLEEP_LIST" to "[]",
            "LIGHT_SLEEP_TIME" to null,
            "DEEP_SLEEP_TIME" to null,
            "REM_SLEEP_TIME" to null,
            "AWAKE_SLEEP_TIME" to null,
            "IS_UPLOADED" to null,
            "SNORE_DURATION" to null,
            "BREATH_BREAKING_PER_HOUR" to null,
        )

        fun careRow(myselfData: String? = null): Map<String, String?> = mapOf(
            "SHARE_OPENID" to "[]",
            "MYSELF_DATA" to (
                myselfData ?: """
                {"heartValue":70.0,"heartTimeStamp":$HEART_AT,"heartAbnormalType":0,
                 "saO2Value":96.0,"saO2TimeStamp":$SPO2_AT,"oxygenAbnormal":0,
                 "pressureValue":30.0,"pressureTimeStamp":$STRESS_AT,"pressAbnormal":0,
                 "sleepValue":2.64E7,"sleepTimeStamp":$EXIT,"sourceFrom":"VIVO_WATCH"}
                """.trimIndent()
                ),
            "CARE_SHARERS" to "[]",
            "CARE_SHARER_DETAIL" to "[]",
            "COLUMN_IS_LOGIN" to "1",
            "COLUMN_MYSELF_VIRTUAL_AVATAR" to null,
            "CARE_SHARER_XTC_DETAIL" to "[]",
            "COLUMN_REQUEST_MSG_NUM" to "0",
        )

        fun intervals(vararg spans: Pair<Long, Long>): String =
            spans.joinToString(",", "[", "]") { (start, end) ->
                """{"enterTime":$start,"exitTime":$end}"""
            }
    }
}
