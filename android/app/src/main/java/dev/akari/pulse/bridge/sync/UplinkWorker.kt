package dev.akari.pulse.bridge.sync

import android.content.Context
import android.util.Log
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
        // Collect fresh provider readings before uploading, so the periodic sync ships current
        // data instead of only draining whatever a manual button press left in the outbox.
        // A failed collection never blocks the upload of already-persisted records.
        runCatching { application.runtime.phoneHealth.refresh() }
            .onFailure { Log.w(LOG_TAG, "phone health collection failed", it) }
        runCatching { application.runtime.vivoPrivateHealth.refresh() }
            .onFailure { Log.w(LOG_TAG, "vivo private health collection failed", it) }
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

    private companion object {
        const val LOG_TAG = "AkariUplinkWorker"
    }
}
