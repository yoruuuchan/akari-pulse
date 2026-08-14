package dev.akari.pulse.bridge.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.WorkerParameters
import dev.akari.pulse.bridge.AkariPulseApplication
import dev.akari.pulse.bridge.data.SyncOneResult

class UplinkWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val application = applicationContext as AkariPulseApplication
        while (true) {
            when (val result = application.runtime.repository.syncOne()) {
                SyncOneResult.NoWork -> Unit
                is SyncOneResult.Success -> continue
                is SyncOneResult.Failure -> {
                    if (result.retryable) return Result.retry()
                    return Result.failure(
                        Data.Builder().putString("error", result.message.take(1024)).build(),
                    )
                }
            }
            when (val result = application.runtime.repository.syncOnePhoneDailySummary()) {
                SyncOneResult.NoWork -> Unit
                is SyncOneResult.Success -> continue
                is SyncOneResult.Failure -> {
                    if (result.retryable) return Result.retry()
                    return Result.failure(
                        Data.Builder().putString("error", result.message.take(1024)).build(),
                    )
                }
            }
            when (val result = application.runtime.repository.syncOneSleepSummary()) {
                SyncOneResult.NoWork -> return Result.success()
                is SyncOneResult.Success -> Unit
                is SyncOneResult.Failure -> {
                    if (result.retryable) return Result.retry()
                    return Result.failure(
                        Data.Builder().putString("error", result.message.take(1024)).build(),
                    )
                }
            }
        }
    }
}
