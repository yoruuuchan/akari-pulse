package dev.akari.pulse.bridge.phonehealth

import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class VivoTodayActivityReaderTest {
    @Test
    fun providerSummaryIsReturnedWithoutUsingTheSettingsMirrorAsFallback() {
        val gateway = FakeGateway(
            setting = "1229",
            capability = bundle("can_step" to 1),
            today = bundle(
                "ret_code" to 0,
                "step" to 1234,
                "distance" to 932.5f,
                "calorie" to 48.25f,
            ),
        )

        val result = reader(gateway).read()

        assertEquals(PhoneHealthStatus.PASS, result.status)
        assertEquals(PhoneHealthOutcome.PROVIDER_CALL_SUCCEEDED, result.outcome)
        assertEquals(1234, result.steps)
        assertEquals(932.5, result.distanceMeters)
        assertEquals(48.25, result.caloriesKilocalories)
        assertEquals("2026-08-14", result.day)
        assertEquals("Asia/Shanghai", result.timezone)
        assertEquals(1_786_638_941_815, result.sampleEpochMs)
        assertEquals("1229", result.diagnostics.settingsRealtimeStepsRaw)
        assertFalse(result.diagnostics.settingsUsedAsFallback)
        assertEquals(listOf("calorie", "distance", "ret_code", "step"), result.diagnostics.providerBundleKeys)
        assertTrue(result.diagnostics.retCodeAvailable)
        assertEquals(0, result.diagnostics.rawRetCode)
        assertFalse(result.diagnostics.sourceTimestampAvailable)
    }

    @Test
    fun nullProviderBundleIsNoDataAndDoesNotPromoteTheSettingsValue() {
        val gateway = FakeGateway(
            setting = "4321",
            capability = bundle("can_step" to 1),
            today = null,
        )

        val result = reader(gateway).read()

        assertEquals(PhoneHealthStatus.NO_DATA, result.status)
        assertEquals(PhoneHealthOutcome.PROVIDER_NO_DATA, result.outcome)
        assertNull(result.steps)
        assertEquals("4321", result.diagnostics.settingsRealtimeStepsRaw)
        assertEquals("provider_call", result.diagnostics.failureStage)
    }

    @Test
    fun disabledCapabilityIsNoDataAndSkipsTheTodayCall() {
        val gateway = FakeGateway(
            capability = bundle("can_step" to 0),
            today = bundle("step" to 999, "distance" to 1f, "calorie" to 1f),
        )

        val result = reader(gateway).read()

        assertEquals(PhoneHealthStatus.NO_DATA, result.status)
        assertEquals(0, result.diagnostics.rawCanStep)
        assertFalse(gateway.todayCalled)
    }

    @Test
    fun emptyCapabilityBundleIsNoDataAndSkipsTheTodayCall() {
        val gateway = FakeGateway(
            capability = bundle(),
            today = bundle("step" to 999, "distance" to 1f, "calorie" to 1f),
        )

        val result = reader(gateway).read()

        assertEquals(PhoneHealthStatus.NO_DATA, result.status)
        assertEquals(PhoneHealthOutcome.PROVIDER_NO_DATA, result.outcome)
        assertFalse(gateway.todayCalled)
    }

    @Test
    fun providerExceptionIsReportedAsCallFailure() {
        val gateway = FakeGateway(
            capability = bundle("can_step" to 1),
            todayError = SecurityException("permission denied by provider"),
        )

        val result = reader(gateway).read()

        assertEquals(PhoneHealthStatus.ERROR, result.status)
        assertEquals(PhoneHealthOutcome.PROVIDER_CALL_FAILED, result.outcome)
        assertEquals("provider_call", result.diagnostics.failureStage)
        assertEquals(SecurityException::class.java.name, result.diagnostics.exceptionType)
        assertNull(result.steps)
    }

    @Test
    fun malformedProviderBundleIsReportedAsParseFailure() {
        val gateway = FakeGateway(
            capability = bundle("can_step" to 1),
            today = bundle(
                "step" to "1234",
                "distance" to 932.5f,
                "calorie" to 48.25f,
            ),
        )

        val result = reader(gateway).read()

        assertEquals(PhoneHealthStatus.ERROR, result.status)
        assertEquals(PhoneHealthOutcome.PARSE_FAILED, result.outcome)
        assertEquals("provider_bundle", result.diagnostics.failureStage)
        assertTrue(result.diagnostics.exceptionMessage.orEmpty().contains("step is not numeric"))
    }

    @Test
    fun settingsReadFailureRemainsDiagnosticWhenProviderSucceeds() {
        val gateway = FakeGateway(
            settingError = IllegalStateException("settings unavailable"),
            capability = bundle("can_step" to 1),
            today = bundle("step" to 0, "distance" to 0f, "calorie" to 0f),
        )

        val result = reader(gateway).read()

        assertEquals(PhoneHealthStatus.PASS, result.status)
        assertEquals(0, result.steps)
        assertEquals(IllegalStateException::class.java.name, result.diagnostics.settingsExceptionType)
        assertEquals("settings unavailable", result.diagnostics.settingsExceptionMessage)
    }

    private fun reader(gateway: FakeGateway): VivoTodayActivityReader {
        val timestamps = ArrayDeque(listOf(1_786_638_940_000L, 1_786_638_941_815L))
        return VivoTodayActivityReader(
            gateway = gateway,
            now = { timestamps.removeFirst() },
            zoneId = { ZoneId.of("Asia/Shanghai") },
        )
    }

    private fun bundle(vararg values: Pair<String, Any?>): RawProviderBundle {
        val map = values.toMap()
        return RawProviderBundle(map.keys.sorted(), map)
    }

    private class FakeGateway(
        private val permission: Boolean = true,
        private val setting: String? = null,
        private val settingError: Exception? = null,
        private val capability: RawProviderBundle? = null,
        private val capabilityError: Exception? = null,
        private val today: RawProviderBundle? = null,
        private val todayError: Exception? = null,
    ) : VivoAssistantStepGateway {
        var todayCalled: Boolean = false
            private set

        override fun permissionGranted(): Boolean = permission

        override fun readRealtimeStepsSetting(): String? {
            settingError?.let { throw it }
            return setting
        }

        override fun callCapability(): RawProviderBundle? {
            capabilityError?.let { throw it }
            return capability
        }

        override fun callTodayActivity(): RawProviderBundle? {
            todayCalled = true
            todayError?.let { throw it }
            return today
        }
    }
}
