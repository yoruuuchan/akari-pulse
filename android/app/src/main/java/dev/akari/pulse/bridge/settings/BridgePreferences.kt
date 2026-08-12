package dev.akari.pulse.bridge.settings

import android.content.Context
import dev.akari.pulse.bridge.network.ServerUrlPolicy
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class BridgeConfigSummary(
    val serverBaseUrl: String,
    val allowTailnetHttp: Boolean,
    val receiverBindAddress: String,
    val receiverPort: Int,
    val hasServerToken: Boolean,
    val hasReceiverToken: Boolean,
    val hasRpcEncryption: Boolean,
)

data class BridgeConfig(
    val serverBaseUrl: String,
    val allowTailnetHttp: Boolean,
    val receiverBindAddress: String,
    val receiverPort: Int,
    val serverToken: String?,
    val receiverToken: String?,
    val rpcEncryption: String?,
)

class BridgePreferences(context: Context) {
    private val preferences = context.getSharedPreferences("akari-pulse-settings", Context.MODE_PRIVATE)
    private val secrets = SecretStore(context)
    private val mutableSummary = MutableStateFlow(loadSummary())

    val summary: StateFlow<BridgeConfigSummary> = mutableSummary.asStateFlow()

    fun load(): BridgeConfig = BridgeConfig(
        serverBaseUrl = preferences.getString(KEY_SERVER_URL, "").orEmpty(),
        allowTailnetHttp = preferences.getBoolean(KEY_ALLOW_TAILNET_HTTP, false),
        receiverBindAddress = preferences.getString(KEY_RECEIVER_BIND_ADDRESS, DEFAULT_RECEIVER_BIND_ADDRESS)
            .orEmpty(),
        receiverPort = preferences.getInt(KEY_RECEIVER_PORT, DEFAULT_RECEIVER_PORT),
        serverToken = secrets.get(KEY_SERVER_TOKEN),
        receiverToken = secrets.get(KEY_RECEIVER_TOKEN),
        rpcEncryption = secrets.get(KEY_RPC_ENCRYPTION),
    )

    fun save(
        serverBaseUrl: String,
        allowTailnetHttp: Boolean,
        receiverBindAddress: String,
        receiverPort: Int,
        serverTokenUpdate: String?,
        receiverTokenUpdate: String?,
        rpcEncryptionUpdate: String?,
    ) {
        require(receiverPort in 1024..65535) { "receiver port must be between 1024 and 65535" }
        val normalizedBindAddress = receiverBindAddress.trim()
        require(normalizedBindAddress.isNotEmpty() && normalizedBindAddress.length <= 255) {
            "receiver bind address is required"
        }
        require(normalizedBindAddress.none { it.isWhitespace() }) { "receiver bind address cannot contain spaces" }
        val normalizedUrl = if (serverBaseUrl.isBlank()) {
            ""
        } else {
            ServerUrlPolicy.validate(serverBaseUrl, allowTailnetHttp)
        }
        secrets.put(KEY_SERVER_TOKEN, serverTokenUpdate)
        secrets.put(KEY_RECEIVER_TOKEN, receiverTokenUpdate)
        secrets.put(KEY_RPC_ENCRYPTION, rpcEncryptionUpdate)
        preferences.edit()
            .putString(KEY_SERVER_URL, normalizedUrl)
            .putBoolean(KEY_ALLOW_TAILNET_HTTP, allowTailnetHttp)
            .putString(KEY_RECEIVER_BIND_ADDRESS, normalizedBindAddress)
            .putInt(KEY_RECEIVER_PORT, receiverPort)
            .apply()
        mutableSummary.value = loadSummary()
    }

    private fun loadSummary(): BridgeConfigSummary = BridgeConfigSummary(
        serverBaseUrl = preferences.getString(KEY_SERVER_URL, "").orEmpty(),
        allowTailnetHttp = preferences.getBoolean(KEY_ALLOW_TAILNET_HTTP, false),
        receiverBindAddress = preferences.getString(KEY_RECEIVER_BIND_ADDRESS, DEFAULT_RECEIVER_BIND_ADDRESS)
            .orEmpty(),
        receiverPort = preferences.getInt(KEY_RECEIVER_PORT, DEFAULT_RECEIVER_PORT),
        hasServerToken = secrets.contains(KEY_SERVER_TOKEN),
        hasReceiverToken = secrets.contains(KEY_RECEIVER_TOKEN),
        hasRpcEncryption = secrets.contains(KEY_RPC_ENCRYPTION),
    )

    companion object {
        const val DEFAULT_RECEIVER_PORT = 23102
        const val DEFAULT_RECEIVER_BIND_ADDRESS = "127.0.0.1"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_ALLOW_TAILNET_HTTP = "allow_tailnet_http"
        private const val KEY_RECEIVER_BIND_ADDRESS = "receiver_bind_address"
        private const val KEY_RECEIVER_PORT = "receiver_port"
        private const val KEY_SERVER_TOKEN = "server_token"
        private const val KEY_RECEIVER_TOKEN = "receiver_token"
        private const val KEY_RPC_ENCRYPTION = "rpc_encryption"
    }
}
