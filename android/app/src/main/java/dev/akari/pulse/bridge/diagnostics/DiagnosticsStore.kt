package dev.akari.pulse.bridge.diagnostics

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class SyncDiagnostics(
    val lastAttemptAt: Long? = null,
    val lastSuccessAt: Long? = null,
    val lastError: String? = null,
    val lastServerStatusAt: Long? = null,
    val activeSessionCount: Int? = null,
)

enum class TransportPhase {
    STOPPED,
    STARTING,
    LISTENING,
    INSECURE_LOCAL_PROBE,
    API_MISSING,
    UNSUPPORTED,
    ERROR,
}

enum class TransportKind(val label: String) {
    OFFICIAL_RPC("official vivo rpc"),
    HTTP_RECEIVER("http receiver"),
}

data class AdapterDiagnostics(
    val adapter: String,
    val phase: TransportPhase = TransportPhase.STOPPED,
    val port: Int? = null,
    val detail: String? = null,
    val acceptedEvents: Long = 0,
    val duplicateEvents: Long = 0,
    val lastBatchAt: Long? = null,
    val lastError: String? = null,
)

data class TransportDiagnostics(
    val officialRpc: AdapterDiagnostics = AdapterDiagnostics(TransportKind.OFFICIAL_RPC.label),
    val httpReceiver: AdapterDiagnostics = AdapterDiagnostics(TransportKind.HTTP_RECEIVER.label),
)

class DiagnosticsStore(context: Context) {
    private val preferences = context.getSharedPreferences("akari-pulse-diagnostics", Context.MODE_PRIVATE)
    private val mutableSync = MutableStateFlow(loadSync())
    private val mutableTransport = MutableStateFlow(TransportDiagnostics())

    val sync: StateFlow<SyncDiagnostics> = mutableSync.asStateFlow()
    val transport: StateFlow<TransportDiagnostics> = mutableTransport.asStateFlow()

    fun syncAttempt(at: Long) = updateSync(mutableSync.value.copy(lastAttemptAt = at, lastError = null))

    fun syncSucceeded(at: Long) = updateSync(
        mutableSync.value.copy(lastAttemptAt = at, lastSuccessAt = at, lastError = null),
    )

    fun syncFailed(at: Long, error: String) = updateSync(
        mutableSync.value.copy(lastAttemptAt = at, lastError = error.take(2048)),
    )

    fun activeSessionsChecked(at: Long, count: Int) = updateSync(
        mutableSync.value.copy(lastServerStatusAt = at, activeSessionCount = count, lastError = null),
    )

    fun transportStarting(kind: TransportKind, port: Int? = null, detail: String? = null) {
        updateAdapter(kind) { current -> current.copy(
            phase = TransportPhase.STARTING,
            port = port,
            detail = detail,
            lastError = null,
        ) }
    }

    fun transportListening(
        kind: TransportKind,
        port: Int? = null,
        detail: String? = null,
        insecureLocalProbe: Boolean = false,
    ) {
        updateAdapter(kind) { current -> current.copy(
            phase = if (insecureLocalProbe) TransportPhase.INSECURE_LOCAL_PROBE else TransportPhase.LISTENING,
            port = port,
            detail = detail,
            lastError = null,
        ) }
    }

    fun transportStopped(kind: TransportKind) {
        updateAdapter(kind) { current -> current.copy(
            phase = TransportPhase.STOPPED,
            port = null,
            detail = null,
            lastError = null,
        ) }
    }

    fun transportFailed(kind: TransportKind, message: String, apiMissing: Boolean = false) {
        updateAdapter(kind) { current -> current.copy(
            phase = if (apiMissing) TransportPhase.API_MISSING else TransportPhase.ERROR,
            lastError = message.take(2048),
        ) }
    }

    fun transportUnsupported(kind: TransportKind, message: String) {
        updateAdapter(kind) { current -> current.copy(
            phase = TransportPhase.UNSUPPORTED,
            lastError = null,
            detail = message.take(2048),
        ) }
    }

    fun transportEventError(kind: TransportKind, message: String) {
        updateAdapter(kind) { current -> current.copy(lastError = message.take(2048)) }
    }

    fun watchBatchAccepted(kind: TransportKind, at: Long, accepted: Int, duplicates: Int) {
        updateAdapter(kind) { current -> current.copy(
            acceptedEvents = current.acceptedEvents + accepted,
            duplicateEvents = current.duplicateEvents + duplicates,
            lastBatchAt = at,
            lastError = null,
        ) }
    }

    private fun updateAdapter(kind: TransportKind, update: (AdapterDiagnostics) -> AdapterDiagnostics) {
        mutableTransport.value = when (kind) {
            TransportKind.OFFICIAL_RPC -> mutableTransport.value.copy(
                officialRpc = update(mutableTransport.value.officialRpc),
            )
            TransportKind.HTTP_RECEIVER -> mutableTransport.value.copy(
                httpReceiver = update(mutableTransport.value.httpReceiver),
            )
        }
    }

    private fun updateSync(value: SyncDiagnostics) {
        mutableSync.value = value
        preferences.edit()
            .putLong(KEY_LAST_ATTEMPT, value.lastAttemptAt ?: -1)
            .putLong(KEY_LAST_SUCCESS, value.lastSuccessAt ?: -1)
            .putString(KEY_LAST_ERROR, value.lastError)
            .putLong(KEY_LAST_STATUS, value.lastServerStatusAt ?: -1)
            .putInt(KEY_ACTIVE_SESSIONS, value.activeSessionCount ?: -1)
            .apply()
    }

    private fun loadSync(): SyncDiagnostics = SyncDiagnostics(
        lastAttemptAt = preferences.getLong(KEY_LAST_ATTEMPT, -1).takeIf { it >= 0 },
        lastSuccessAt = preferences.getLong(KEY_LAST_SUCCESS, -1).takeIf { it >= 0 },
        lastError = preferences.getString(KEY_LAST_ERROR, null),
        lastServerStatusAt = preferences.getLong(KEY_LAST_STATUS, -1).takeIf { it >= 0 },
        activeSessionCount = preferences.getInt(KEY_ACTIVE_SESSIONS, -1).takeIf { it >= 0 },
    )

    companion object {
        private const val KEY_LAST_ATTEMPT = "last_attempt"
        private const val KEY_LAST_SUCCESS = "last_success"
        private const val KEY_LAST_ERROR = "last_error"
        private const val KEY_LAST_STATUS = "last_status"
        private const val KEY_ACTIVE_SESSIONS = "active_sessions"
    }
}
