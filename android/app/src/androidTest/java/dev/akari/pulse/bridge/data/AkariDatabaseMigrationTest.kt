package dev.akari.pulse.bridge.data

import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AkariDatabaseMigrationTest {
    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        AkariDatabase::class.java,
    )

    @Test
    fun migrationOneToTwoPreservesWatchRowsAndUpsertsDailySummaryBySourceMetricDay() {
        helper.createDatabase(TEST_DATABASE, 1).apply {
            execSQL(
                """
                INSERT INTO health_events (
                    event_id, timestamp_ms, metric, has_value, value_json,
                    source_device, status, raw_event_json, watch_batch_id,
                    watch_producer, received_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf<Any?>(
                    "existing-watch-event",
                    1_786_674_000_000,
                    "heart_rate",
                    1,
                    "72",
                    "WA2456C",
                    "PASS",
                    "{}",
                    "existing-watch-batch",
                    "watch-fixture",
                    1_786_674_000_100,
                ),
            )
            close()
        }

        helper.runMigrationsAndValidate(
            TEST_DATABASE,
            2,
            true,
            AkariDatabase.MIGRATION_1_2,
        ).apply {
            query("SELECT value_json FROM health_events WHERE event_id = 'existing-watch-event'").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("72", cursor.getString(0))
            }

            for ((sampledAt, value) in listOf(
                1_786_670_000_000L to "5",
                1_786_673_000_000L to "100",
                1_786_676_000_000L to "3200",
            )) {
                execSQL(
                    """
                    INSERT OR REPLACE INTO phone_daily_summaries (
                        source, metric, source_day, source_timezone, value_json,
                        unit, sampled_at_ms, sampled_at, source_timestamp_available,
                        status, outcome, verification, raw_error_code,
                        raw_error_message, synced_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
                    """.trimIndent(),
                    arrayOf<Any?>(
                        "vivo_phone",
                        "phone_step_count",
                        "2026-08-14",
                        "Asia/Shanghai",
                        value,
                        "count",
                        sampledAt,
                        "2026-08-14T10:00:00+08:00",
                        0,
                        "PASS",
                        "PROVIDER_CALL_SUCCEEDED",
                        "VERIFIED",
                    ),
                )
            }

            query(
                "SELECT COUNT(*), value_json FROM phone_daily_summaries " +
                    "WHERE source = 'vivo_phone' AND metric = 'phone_step_count' AND source_day = '2026-08-14'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(1, cursor.getInt(0))
                assertEquals("3200", cursor.getString(1))
            }
            close()
        }
    }

    companion object {
        private const val TEST_DATABASE = "akari-migration-test"
    }
}
