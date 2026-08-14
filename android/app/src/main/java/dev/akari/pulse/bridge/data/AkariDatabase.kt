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
    ],
    version = 2,
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
                .addMigrations(MIGRATION_1_2)
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
    }
}
