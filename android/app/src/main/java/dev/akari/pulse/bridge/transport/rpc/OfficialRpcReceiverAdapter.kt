package dev.akari.pulse.bridge.transport.rpc

import android.content.Context
import com.vivo.health.deviceRpcSdk.Constant
import com.vivo.health.deviceRpcSdk.DeviceRpcManager
import com.vivo.health.deviceRpcSdk.ErrorCode
import com.vivo.health.deviceRpcSdk.client.RpcClient
import com.vivo.health.deviceRpcSdk.data.Notification
import com.vivo.health.deviceRpcSdk.data.Request
import com.vivo.health.deviceRpcSdk.data.Response
import com.vivo.health.deviceRpcSdk.service.IDataReceiver
import dev.akari.pulse.bridge.BuildConfig
import dev.akari.pulse.bridge.contract.ContractViolation
import dev.akari.pulse.bridge.contract.HealthContract
import dev.akari.pulse.bridge.data.BridgeRepository
import dev.akari.pulse.bridge.data.IngressAcknowledgement
import dev.akari.pulse.bridge.diagnostics.DiagnosticsStore
import dev.akari.pulse.bridge.diagnostics.TransportKind
import dev.akari.pulse.bridge.settings.BridgePreferences
import dev.akari.pulse.bridge.sync.SyncScheduler
import dev.akari.pulse.bridge.transport.AdapterStartResult
import dev.akari.pulse.bridge.transport.WatchTransportAdapter
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

data class RpcNotificationDispatch(
    val action: String,
    val targetPackage: String,
    val dispatchedAt: Long,
    val executionConfirmed: Boolean = false,
)

class OfficialRpcReceiverAdapter(
    context: Context,
    private val preferences: BridgePreferences,
    private val repository: BridgeRepository,
    private val diagnostics: DiagnosticsStore,
) : WatchTransportAdapter {
    override val kind = TransportKind.OFFICIAL_RPC

    private val applicationContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val startMutex = Mutex()
    private val started = AtomicBoolean(false)
    private val manager = DeviceRpcManager.getInstance()
    private val receiver = object : IDataReceiver {
        override fun onReceiveRequest(request: Request) {
            if (request.action != Constant.Action.ACTION_DEVICE_BUSINESS_DATA) return
            scope.launch { receiveRequest(request) }
        }

        override fun onReceiveNotification(notification: Notification) {
            if (notification.action != Constant.Action.ACTION_DEVICE_BUSINESS_DATA) return
            scope.launch {
                try {
                    repository.ingestWatchBatch(extractHealthBatch(notification.data.orEmpty()), kind)
                    SyncScheduler.enqueueNow(applicationContext, expedited = true)
                    diagnostics.transportEventError(
                        kind,
                        "notification persisted without transport ACK; use an RPC request for reliable delivery",
                    )
                } catch (error: Exception) {
                    diagnostics.transportEventError(kind, error.message ?: error.javaClass.simpleName)
                }
            }
        }
    }

    override suspend fun start(): AdapterStartResult = startMutex.withLock {
        if (started.get()) return@withLock AdapterStartResult.Running
        if (BuildConfig.VIVO_RPC_APP_ID <= 0) {
            return@withLock configurationMissing("API_MISSING · VIVO_RPC_APP_ID is missing from local.properties")
        }
        val encryption = try {
            preferences.load().rpcEncryption
        } catch (error: Exception) {
            return@withLock configurationMissing("API_MISSING · rpc encryption credential could not be loaded")
        }
        if (encryption.isNullOrBlank()) {
            return@withLock configurationMissing("API_MISSING · rpc encryStr is missing from secure runtime settings")
        }
        diagnostics.transportStarting(kind, detail = "device-rpc 1.0.0.17")
        try {
            val initialization = withTimeout(15_000) {
                suspendCancellableCoroutine<Pair<Boolean, String>> { continuation ->
                    manager.init(
                        applicationContext,
                        encryption,
                        DeviceRpcManager.InitCallBack { success, message ->
                            if (continuation.isActive) continuation.resume(success to message.orEmpty())
                        },
                    )
                }
            }
            if (!initialization.first) {
                val message = "official rpc initialization failed: ${initialization.second.ifBlank { "unknown error" }}"
                diagnostics.transportFailed(kind, message)
                AdapterStartResult.Failed(message)
            } else {
                val version = manager.getHealthDeviceVersion()
                if (version < 0) {
                    manager.registerDataReceiver(null)
                    configurationMissing(
                        "API_MISSING · health device manager version is unavailable; version 2 or newer is required",
                    )
                } else if (version < MIN_HEALTH_DEVICE_VERSION) {
                    manager.registerDataReceiver(null)
                    val message = "UNSUPPORTED · health device manager version $version; version 2 or newer is required"
                    diagnostics.transportUnsupported(kind, message)
                    AdapterStartResult.Unsupported(message)
                } else {
                    manager.registerDataReceiver(receiver)
                    started.set(true)
                    diagnostics.transportListening(
                        kind,
                        detail = "device-rpc 1.0.0.17 · health device version $version · WA2456C unverified",
                    )
                    AdapterStartResult.Running
                }
            }
        } catch (error: Exception) {
            val message = "official rpc start failed: ${error.message ?: error.javaClass.simpleName}"
            diagnostics.transportFailed(kind, message)
            AdapterStartResult.Failed(message)
        }
    }

    override suspend fun stop() {
        startMutex.withLock {
            if (started.getAndSet(false)) manager.registerDataReceiver(null)
            diagnostics.transportStopped(kind)
        }
    }

    suspend fun sendSessionStart(sessionId: String, label: String? = null): Result<RpcNotificationDispatch> {
        if (sessionId.isBlank()) return Result.failure(IllegalArgumentException("session_id is required"))
        val startedAt = System.currentTimeMillis()
        val payload = buildJsonObject {
            put("session_id", sessionId)
            put("started_at", startedAt)
            if (!label.isNullOrBlank()) put("label", label)
        }
        return sendSessionCommand(ACTION_SESSION_START, payload.toString())
    }

    suspend fun sendSessionStop(sessionId: String): Result<RpcNotificationDispatch> {
        if (sessionId.isBlank()) return Result.failure(IllegalArgumentException("session_id is required"))
        return sendSessionCommand(
            ACTION_SESSION_STOP,
            buildJsonObject {
                put("session_id", sessionId)
                put("ended_at", System.currentTimeMillis())
            }.toString(),
        )
    }

    private suspend fun sendSessionCommand(action: String, data: String): Result<RpcNotificationDispatch> = runCatching {
        when (val result = start()) {
            AdapterStartResult.Running -> Unit
            is AdapterStartResult.ConfigurationMissing -> error(result.message)
            is AdapterStartResult.Unsupported -> error(result.message)
            is AdapterStartResult.Failed -> error(result.message)
        }
        val targetPackage = HEALTH_PACKAGE
        withContext(Dispatchers.IO) {
            val client = RpcClient.getInstance()
            check(client.isConnected(targetPackage)) { "rpc target is not connected: $targetPackage" }
            val dispatchedAt = System.currentTimeMillis()
            val notification = Notification.Builder()
                .action(Constant.Action.ACTION_DEVICE_BUSINESS_DATA)
                .modelVersion(MODEL_VERSION)
                .pkgName(targetPackage)
                .originPkgName(applicationContext.packageName)
                .data(buildJsonObject {
                    put("type", action)
                    put("data", HealthContract.json.parseToJsonElement(data))
                }.toString())
                .code(ErrorCode.SUCCESS.errorCode)
                .seqId(dispatchedAt)
                .build()
            client.notify(notification)
            RpcNotificationDispatch(
                action = action,
                targetPackage = targetPackage,
                dispatchedAt = dispatchedAt,
            )
        }
    }.onFailure { error ->
        diagnostics.transportEventError(kind, error.message ?: error.javaClass.simpleName)
    }

    private suspend fun receiveRequest(request: Request) {
        val response = try {
            val acknowledgement = repository.ingestWatchBatch(extractHealthBatch(request.data.orEmpty()), kind)
            SyncScheduler.enqueueNow(applicationContext, expedited = true)
            buildResponse(request, ErrorCode.SUCCESS.errorCode, successBody(acknowledgement))
        } catch (error: Exception) {
            val code = if (error is ContractViolation) ErrorCode.DATA_ERROR.errorCode else ErrorCode.UNKNOWN.errorCode
            diagnostics.transportEventError(kind, error.message ?: error.javaClass.simpleName)
            buildResponse(request, code, errorBody(error))
        }
        try {
            manager.onResponse(response)
        } catch (error: Exception) {
            diagnostics.transportEventError(kind, "rpc ACK failed: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun buildResponse(request: Request, code: Int, data: String): Response {
        val targetPackage = request.originPkgName?.takeIf { it.isNotBlank() }
            ?: request.pkgName?.takeIf { it.isNotBlank() }
            ?: DeviceRpcManager.getHealthPackageName()
        return Response.Builder()
            .build(request.action)
            .modelVersion(request.modelVersion)
            .pkgName(targetPackage)
            .originPkgName(applicationContext.packageName)
            .seqId(request.seqId)
            .code(code)
            .data(data)
            .build()
    }

    private fun successBody(ack: IngressAcknowledgement): String = buildJsonObject {
        put("code", 0)
        put("result", buildJsonObject {
            put("batch_id", ack.batchId)
            put("accepted", ack.accepted)
            put("duplicates", ack.duplicates)
            put("replayed", ack.replayed)
        })
    }.toString()

    private fun errorBody(error: Exception): String = buildJsonObject {
        put("code", if (error is ContractViolation) ErrorCode.DATA_ERROR.errorCode else ErrorCode.UNKNOWN.errorCode)
        put("message", (error.message ?: error.javaClass.simpleName).take(2048))
        put("error", buildJsonObject {
            put("code", (error as? ContractViolation)?.errorCode ?: "PHONE_PERSISTENCE_ERROR")
            put("message", (error.message ?: error.javaClass.simpleName).take(2048))
        })
    }.toString()

    private fun configurationMissing(message: String): AdapterStartResult.ConfigurationMissing {
        diagnostics.transportFailed(kind, message, apiMissing = true)
        return AdapterStartResult.ConfigurationMissing(message)
    }

    private fun extractHealthBatch(rawEnvelope: String): String {
        val envelope = try {
            HealthContract.json.parseToJsonElement(rawEnvelope).jsonObject
        } catch (error: Exception) {
            throw ContractViolation("INVALID_RPC_ENVELOPE", "RPC data must be a JSON object envelope")
        }
        val unknown = envelope.keys - ENVELOPE_KEYS
        if (unknown.isNotEmpty()) {
            throw ContractViolation(
                "INVALID_RPC_ENVELOPE",
                "RPC envelope contains unknown fields: ${unknown.sorted().joinToString()}",
            )
        }
        val type = (envelope["type"] as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.content
            ?: throw ContractViolation("INVALID_RPC_ENVELOPE", "RPC envelope.type must be a string")
        if (type != ACTION_HEALTH_BATCH) {
            throw ContractViolation("UNSUPPORTED_MESSAGE_TYPE", "RPC envelope.type is not supported: $type")
        }
        val data = envelope["data"] as? JsonObject
            ?: throw ContractViolation("INVALID_RPC_ENVELOPE", "RPC envelope.data must be a batch object")
        return data.toString()
    }

    companion object {
        const val ACTION_HEALTH_BATCH = "akari.health.batch.v1"
        const val ACTION_SESSION_START = "akari.session.start"
        const val ACTION_SESSION_STOP = "akari.session.stop"
        private const val HEALTH_PACKAGE = "com.vivo.health"
        private const val MODEL_VERSION = 1
        private const val MIN_HEALTH_DEVICE_VERSION = 2
        private val ENVELOPE_KEYS = setOf("type", "data")
    }
}
