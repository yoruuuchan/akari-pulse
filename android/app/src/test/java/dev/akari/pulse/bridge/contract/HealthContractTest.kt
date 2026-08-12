package dev.akari.pulse.bridge.contract

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class HealthContractTest {
    @Test
    fun passRequiresValue() {
        val error = assertFailsWith<ContractViolation> {
            HealthContract.parseBatch(batch(event("\"status\":\"PASS\"")))
        }
        assertEquals("INVALID_REQUEST", error.errorCode)
    }

    @Test
    fun passRejectsNullValue() {
        val error = assertFailsWith<ContractViolation> {
            HealthContract.parseBatch(batch(event("\"status\":\"PASS\",\"value\":null")))
        }
        assertEquals("INVALID_REQUEST", error.errorCode)
    }

    @Test
    fun falseIsPreservedAsARealPassValue() {
        val parsed = HealthContract.parseBatch(batch(event("\"status\":\"PASS\",\"value\":false")))
        val item = parsed.events.single()
        assertTrue(item.hasValue)
        assertEquals("false", item.valueJson)
    }

    @Test
    fun nonFiniteNumericValueIsRejected() {
        assertFailsWith<ContractViolation> {
            HealthContract.parseBatch(batch(event("\"status\":\"PASS\",\"value\":1e400")))
        }
    }

    @Test
    fun noDataDoesNotInventValue() {
        val parsed = HealthContract.parseBatch(batch(event("\"status\":\"NO_DATA\"")))
        val item = parsed.events.single()
        assertFalse(item.hasValue)
        assertNull(item.valueJson)
    }

    @Test
    fun zeroIsPreservedAsARealPassValue() {
        val parsed = HealthContract.parseBatch(batch(event("\"status\":\"PASS\",\"value\":0")))
        val item = parsed.events.single()
        assertTrue(item.hasValue)
        assertEquals("0", item.valueJson)
    }

    @Test
    fun statusQualitySessionAndRawErrorsArePreserved() {
        val parsed = HealthContract.parseBatch(
            batch(
                event(
                    "\"status\":\"ERROR\",\"quality\":\"sensor_unstable\"," +
                        "\"session_id\":\"session-7\",\"raw_error_code\":404," +
                        "\"raw_error_message\":\"device returned no sample\"",
                ),
            ),
        )
        val item = parsed.events.single()
        assertEquals(HealthStatus.ERROR, item.status)
        assertEquals("sensor_unstable", item.quality)
        assertEquals("session-7", item.sessionId)
        assertEquals("404", item.rawErrorCodeJson)
        assertEquals("device returned no sample", item.rawErrorMessage)
    }

    @Test
    fun canonicalEventPayloadIsIndependentOfInputKeyOrder() {
        val first = HealthContract.parseBatch(
            """{"batch_id":"b1","producer":"watch","events":[{"event_id":"e1","timestamp":1,"metric":"heart_rate","source_device":"WA2456C","status":"PASS","value":71}]}""",
        ).events.single().rawEventJson
        val second = HealthContract.parseBatch(
            """{"producer":"watch","events":[{"value":71,"status":"PASS","source_device":"WA2456C","metric":"heart_rate","timestamp":1,"event_id":"e1"}],"batch_id":"b1"}""",
        ).events.single().rawEventJson
        assertEquals(first, second)
    }

    @Test
    fun unknownEventFieldIsRejected() {
        val error = assertFailsWith<ContractViolation> {
            HealthContract.parseBatch(
                batch(event("\"status\":\"NO_DATA\",\"invented\":true")),
            )
        }
        assertEquals("INVALID_REQUEST", error.errorCode)
    }

    private fun batch(event: String): String =
        """{"batch_id":"batch-1","producer":"watch","sent_at":10,"events":[$event]}"""

    private fun event(extra: String): String =
        """{"event_id":"event-1","timestamp":9,"metric":"heart_rate","source_device":"WA2456C",$extra}"""
}
