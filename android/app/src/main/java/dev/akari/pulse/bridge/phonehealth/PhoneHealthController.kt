package dev.akari.pulse.bridge.phonehealth

import android.util.Log
import dev.akari.pulse.bridge.data.BridgeRepository
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

class PhoneHealthController(
    private val reader: VivoTodayActivityReader,
    private val repository: BridgeRepository,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val mutableState = MutableStateFlow<PhoneTodayActivity?>(null)

    val state: StateFlow<PhoneTodayActivity?> = mutableState.asStateFlow()

    suspend fun refresh(): PhoneTodayActivity {
        val result = withContext(dispatcher) {
            reader.read().also { repository.persistPhoneDailySummary(it) }
        }
        mutableState.value = result
        Log.i(LOG_TAG, result.toJson())
        return result
    }

    companion object {
        const val LOG_TAG = "AkariPhoneHealth"
    }
}
