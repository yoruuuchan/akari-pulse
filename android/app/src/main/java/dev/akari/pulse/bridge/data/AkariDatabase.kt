package dev.akari.pulse.bridge.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [HealthEventEntity::class, UploadBatchEntity::class, WatchBatchEntity::class],
    version = 1,
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
                .build()
    }
}
