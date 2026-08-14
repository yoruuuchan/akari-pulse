package dev.akari.pulse.bridge.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        HealthEventEntity::class,
        UploadBatchEntity::class,
        WatchBatchEntity::class,
        PhoneDailySummaryEntity::class,
        PhoneDailySummaryUploadEntity::class,
        SleepSummaryEntity::class,
        SleepSummaryUploadEntity::class,
    ],
    version = 4,
    exportSchema = true,
)
abstract class AkariDatabase : RoomDatabase() {
    abstract fun healthDao(): HealthDao

    companion object {
        fun create(context: Context): AkariDatabase =
            Room.databaseBuilder(
                context.applicationContext,
                AkariDatabase::class.java,
                "akari-pulse.db",
            )
                .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
                .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
                .build()

        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `phone_daily_summaries` (
                        `source` TEXT NOT NULL,
                        `metric` TEXT NOT NULL,
                        `source_day` TEXT NOT NULL,
                        `source_timezone` TEXT NOT NULL,
                        `value_json` TEXT,
                        `unit` TEXT NOT NULL,
                        `sampled_at_ms` INTEGER NOT NULL,
                        `sampled_at` TEXT NOT NULL,
                        `source_timestamp_available` INTEGER NOT NULL,
                        `status` TEXT NOT NULL,
                        `outcome` TEXT NOT NULL,
                        `verification` TEXT NOT NULL,
                        `raw_error_code` TEXT,
                        `raw_error_message` TEXT,
                        `synced_at_ms` INTEGER,
                        PRIMARY KEY(`source`, `metric`, `source_day`)
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_phone_daily_summaries_source_day` ON `phone_daily_summaries` (`source_day`)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_phone_daily_summaries_sampled_at_ms` ON `phone_daily_summaries` (`sampled_at_ms`)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_phone_daily_summaries_synced_at_ms` ON `phone_daily_summaries` (`synced_at_ms`)",
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `phone_daily_summary_uploads` (
                        `batch_id` TEXT NOT NULL,
                        `created_at_ms` INTEGER NOT NULL,
                        `sent_at_ms` INTEGER NOT NULL,
                        `source` TEXT NOT NULL,
                        `source_day` TEXT NOT NULL,
                        `sampled_at_ms` INTEGER NOT NULL,
                        `summary_count` INTEGER NOT NULL,
                        `payload_json` TEXT NOT NULL,
                        `attempt_count` INTEGER NOT NULL,
                        `last_attempt_at_ms` INTEGER,
                        `last_error` TEXT,
                        `completed_at_ms` INTEGER,
                        PRIMARY KEY(`batch_id`)
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_phone_daily_summary_uploads_completed_at_ms` ON `phone_daily_summary_uploads` (`completed_at_ms`)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_phone_daily_summary_uploads_created_at_ms` ON `phone_daily_summary_uploads` (`created_at_ms`)",
                )
            }
        }

        // Adds the vivo private-provider sleep day and its outbox. Existing watch events and
        // phone daily summaries are untouched; nothing is dropped or recreated.
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `sleep_summaries` (
                        `source` TEXT NOT NULL,
                        `source_day` TEXT NOT NULL,
                        `source_timezone` TEXT NOT NULL,
                        `source_day_start_ms` INTEGER,
                        `sleep_start_ms` INTEGER NOT NULL,
                        `sleep_end_ms` INTEGER NOT NULL,
                        `sampled_at_ms` INTEGER NOT NULL,
                        `sampled_at` TEXT NOT NULL,
                        `status` TEXT NOT NULL,
                        `outcome` TEXT NOT NULL,
                        `verification` TEXT NOT NULL,
                        `recorder_generation` INTEGER,
                        `low_accuracy` INTEGER,
                        `score` INTEGER,
                        `deep_sleep_continuity` INTEGER,
                        `total_duration_ms` INTEGER NOT NULL,
                        `night_sleep_duration_ms` INTEGER,
                        `nap_duration_ms` INTEGER,
                        `chart_total_duration_ms` INTEGER,
                        `light_sleep_duration_ms` INTEGER,
                        `deep_sleep_duration_ms` INTEGER,
                        `rem_sleep_duration_ms` INTEGER,
                        `awake_duration_ms` INTEGER,
                        `awake_episode_count` INTEGER,
                        `awake_episode_duration_ms` INTEGER,
                        `stages_json` TEXT NOT NULL,
                        `synced_at_ms` INTEGER,
                        PRIMARY KEY(`source`, `source_day`)
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_sleep_summaries_sampled_at_ms` ON `sleep_summaries` (`sampled_at_ms`)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_sleep_summaries_synced_at_ms` ON `sleep_summaries` (`synced_at_ms`)",
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `sleep_summary_uploads` (
                        `batch_id` TEXT NOT NULL,
                        `created_at_ms` INTEGER NOT NULL,
                        `sent_at_ms` INTEGER NOT NULL,
                        `source` TEXT NOT NULL,
                        `source_day` TEXT NOT NULL,
                        `sampled_at_ms` INTEGER NOT NULL,
                        `summary_count` INTEGER NOT NULL,
                        `payload_json` TEXT NOT NULL,
                        `attempt_count` INTEGER NOT NULL,
                        `last_attempt_at_ms` INTEGER,
                        `last_error` TEXT,
                        `completed_at_ms` INTEGER,
                        PRIMARY KEY(`batch_id`)
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_sleep_summary_uploads_completed_at_ms` ON `sleep_summary_uploads` (`completed_at_ms`)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_sleep_summary_uploads_created_at_ms` ON `sleep_summary_uploads` (`created_at_ms`)",
                )
            }
        }

        // Rekeys sleep rows by (source, source_day, sleep_start_ms). The vivo provider
        // exposes only its latest sleep record, so a nap read after the night sleep is a
        // second session of the same source_day and must not replace it. Existing rows
        // are carried over unchanged; SQLite cannot alter a primary key in place, so the
        // table is rebuilt.
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `sleep_summaries_v4` (
                        `source` TEXT NOT NULL,
                        `source_day` TEXT NOT NULL,
                        `source_timezone` TEXT NOT NULL,
                        `source_day_start_ms` INTEGER,
                        `sleep_start_ms` INTEGER NOT NULL,
                        `sleep_end_ms` INTEGER NOT NULL,
                        `sampled_at_ms` INTEGER NOT NULL,
                        `sampled_at` TEXT NOT NULL,
                        `status` TEXT NOT NULL,
                        `outcome` TEXT NOT NULL,
                        `verification` TEXT NOT NULL,
                        `recorder_generation` INTEGER,
                        `low_accuracy` INTEGER,
                        `score` INTEGER,
                        `deep_sleep_continuity` INTEGER,
                        `total_duration_ms` INTEGER NOT NULL,
                        `night_sleep_duration_ms` INTEGER,
                        `nap_duration_ms` INTEGER,
                        `chart_total_duration_ms` INTEGER,
                        `light_sleep_duration_ms` INTEGER,
                        `deep_sleep_duration_ms` INTEGER,
                        `rem_sleep_duration_ms` INTEGER,
                        `awake_duration_ms` INTEGER,
                        `awake_episode_count` INTEGER,
                        `awake_episode_duration_ms` INTEGER,
                        `stages_json` TEXT NOT NULL,
                        `synced_at_ms` INTEGER,
                        PRIMARY KEY(`source`, `source_day`, `sleep_start_ms`)
                    )
                    """.trimIndent(),
                )
                db.execSQL("INSERT INTO `sleep_summaries_v4` SELECT * FROM `sleep_summaries`")
                db.execSQL("DROP TABLE `sleep_summaries`")
                db.execSQL("ALTER TABLE `sleep_summaries_v4` RENAME TO `sleep_summaries`")
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_sleep_summaries_sampled_at_ms` ON `sleep_summaries` (`sampled_at_ms`)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_sleep_summaries_synced_at_ms` ON `sleep_summaries` (`synced_at_ms`)",
                )
            }
        }
    }
}
