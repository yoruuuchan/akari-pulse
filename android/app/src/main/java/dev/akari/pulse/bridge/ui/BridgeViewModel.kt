package dev.akari.pulse.bridge.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.akari.pulse.bridge.BridgeRuntime
import dev.akari.pulse.bridge.BuildConfig
import dev.akari.pulse.bridge.data.HealthEventEntity
import dev.akari.pulse.bridge.data.QueueStats
import dev.akari.pulse.bridge.diagnostics.SyncDiagnostics
import dev.akari.pulse.bridge.diagnostics.TransportDiagnostics
import dev.akari.pulse.bridge.phonehealth.PhoneHealthStatus
import dev.akari.pulse.bridge.phonehealth.PhoneTodayActivity
import dev.akari.pulse.bridge.settings.BridgeConfigSummary
import dev.akari.pulse.bridge.sync.SyncScheduler
import dev.akari.pulse.bridge.transport.AdapterStartResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class UiNotice(
    val text: String,
    val isError: Boolean,
)

data class BridgeUiState(
    val config: BridgeConfigSummary = BridgeConfigSummary(
        serverBaseUrl = "",
        allowTailnetHttp = false,
        receiverBindAddress = "127.0.0.1",
        receiverPort = 23102,
        hasServerToken = false,
        hasReceiverToken = false,
        hasRpcEncryption = false,
    ),
    val queue: QueueStats = QueueStats(0, 0, 0, null, null, null),
    val recentEvents: List<HealthEventEntity> = emptyList(),
    val phoneHealth: PhoneTodayActivity? = null,
    val sync: SyncDiagnostics = SyncDiagnostics(),
    val transport: TransportDiagnostics = TransportDiagnostics(),
    val notice: UiNotice? = null,
    val rpcAppIdConfigured: Boolean = BuildConfig.VIVO_RPC_APP_ID > 0,
)

class BridgeViewModel(
    application: Application,
    private val runtime: BridgeRuntime,
) : AndroidViewModel(application) {
    private val notice = MutableStateFlow<UiNotice?>(null)
    private val repositoryState = combine(
        runtime.repository.observeQueueStats(),
        runtime.repository.observeRecentEvents(),
        runtime.phoneHealth.state,
    ) { queue, events, phoneHealth -> Triple(queue, events, phoneHealth) }

    val uiState: StateFlow<BridgeUiState> = combine(
        runtime.preferences.summary,
        runtime.diagnostics.sync,
        runtime.diagnostics.transport,
        repositoryState,
        notice,
    ) { config, sync, transport, repository, currentNotice ->
        BridgeUiState(
            config = config,
            queue = repository.first,
            recentEvents = repository.second,
            phoneHealth = repository.third,
            sync = sync,
            transport = transport,
            notice = currentNotice,
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = BridgeUiState(),
    )

    fun startOfficialRpc() {
        viewModelScope.launch {
            notice.value = when (val result = runtime.officialRpc.start()) {
                AdapterStartResult.Running -> UiNotice(
                    "official rpc listening; WA2456C support remains unverified",
                    false,
                )
                is AdapterStartResult.ConfigurationMissing -> UiNotice(result.message, false)
                is AdapterStartResult.Unsupported -> UiNotice(result.message, false)
                is AdapterStartResult.Failed -> UiNotice(result.message, true)
            }
        }
    }

    fun stopOfficialRpc() {
        viewModelScope.launch {
            runtime.officialRpc.stop()
            notice.value = UiNotice("official rpc stopped", false)
        }
    }

    fun syncNow() {
        SyncScheduler.enqueueNow(getApplication(), expedited = true)
        notice.value = UiNotice("uplink work queued", false)
    }

    fun readPhoneHealth() {
        viewModelScope.launch {
            try {
                val result = runtime.phoneHealth.refresh()
                SyncScheduler.enqueueNow(getApplication(), expedited = true)
                notice.value = UiNotice(
                    "phone health ${result.status.name} · persisted and uplink queued",
                    result.status == PhoneHealthStatus.ERROR,
                )
            } catch (error: Exception) {
                notice.value = UiNotice(
                    "phone health persistence failed · ${error.message ?: error.javaClass.simpleName}",
                    true,
                )
            }
        }
    }

    fun refreshActiveSessions() {
        viewModelScope.launch {
            val result = runtime.repository.refreshActiveSessions()
            notice.value = result.fold(
                onSuccess = { count -> UiNotice("active sessions: $count", false) },
                onFailure = { error -> UiNotice(error.message ?: "session status request failed", true) },
            )
        }
    }

    fun dispatchSessionStart(sessionId: String, label: String?) {
        viewModelScope.launch {
            val result = runtime.officialRpc.sendSessionStart(sessionId.trim(), label?.trim())
            notice.value = notificationNotice(result.exceptionOrNull())
        }
    }

    fun dispatchSessionStop(sessionId: String) {
        viewModelScope.launch {
            val result = runtime.officialRpc.sendSessionStop(sessionId.trim())
            notice.value = notificationNotice(result.exceptionOrNull())
        }
    }

    fun saveSettings(
        serverBaseUrl: String,
        allowTailnetHttp: Boolean,
        receiverBindAddress: String,
        receiverPort: String,
        serverToken: String,
        receiverToken: String,
        rpcEncryption: String,
    ) {
        viewModelScope.launch {
            notice.value = try {
                val port = receiverPort.toIntOrNull()
                    ?: throw IllegalArgumentException("receiver port must be an integer")
                withContext(Dispatchers.IO) {
                    runtime.preferences.save(
                        serverBaseUrl = serverBaseUrl,
                        allowTailnetHttp = allowTailnetHttp,
                        receiverBindAddress = receiverBindAddress,
                        receiverPort = port,
                        serverTokenUpdate = serverToken.takeIf { it.isNotBlank() },
                        receiverTokenUpdate = receiverToken.takeIf { it.isNotBlank() },
                        rpcEncryptionUpdate = rpcEncryption.takeIf { it.isNotBlank() },
                    )
                }
                UiNotice("settings saved; restart a running receiver to apply listener changes", false)
            } catch (error: Exception) {
                UiNotice(error.message ?: "settings could not be saved", true)
            }
        }
    }

    fun clearNotice() {
        notice.value = null
    }

    private fun notificationNotice(error: Throwable?): UiNotice = if (error == null) {
        UiNotice("notification dispatched; watch execution is unconfirmed", false)
    } else {
        val message = error.message ?: "notification dispatch failed"
        UiNotice(message, !message.contains("API_MISSING") && !message.contains("UNSUPPORTED"))
    }
}
