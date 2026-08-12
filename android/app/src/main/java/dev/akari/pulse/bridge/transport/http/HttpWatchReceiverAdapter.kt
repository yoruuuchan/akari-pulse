package dev.akari.pulse.bridge.transport.http

import dev.akari.pulse.bridge.contract.ContractViolation
import dev.akari.pulse.bridge.contract.HealthContract
import dev.akari.pulse.bridge.data.BridgeRepository
import dev.akari.pulse.bridge.data.IngressAcknowledgement
import dev.akari.pulse.bridge.diagnostics.DiagnosticsStore
import dev.akari.pulse.bridge.diagnostics.TransportKind
import dev.akari.pulse.bridge.sync.SyncScheduler
import dev.akari.pulse.bridge.transport.AdapterStartResult
import dev.akari.pulse.bridge.transport.WatchTransportAdapter
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class HttpWatchReceiverAdapter(
    private val applicationContext: android.content.Context,
    private val bindAddress: String,
    private val port: Int,
    private val bridgeToken: String?,
    private val repository: BridgeRepository,
    private val diagnostics: DiagnosticsStore,
    private val scope: CoroutineScope,
) : WatchTransportAdapter {
    override val kind = TransportKind.HTTP_RECEIVER

    private var serverSocket: ServerSocket? = null
    private var acceptJob: Job? = null

    override suspend fun start(): AdapterStartResult {
        if (serverSocket != null) return AdapterStartResult.Running
        diagnostics.transportStarting(kind, port, bindAddress)
        return try {
            val address = InetAddress.getByName(bindAddress)
            require(!address.isAnyLocalAddress) {
                "choose a specific local address; wildcard 0.0.0.0/:: is not allowed"
            }
            val localProbe = address.isLoopbackAddress && bridgeToken.isNullOrBlank()
            if (!address.isLoopbackAddress) {
                require(!bridgeToken.isNullOrBlank() && bridgeToken.length >= 16) {
                    "a bridge token of at least 16 characters is required outside loopback"
                }
            }
            val socket = ServerSocket().apply {
                reuseAddress = true
                bind(InetSocketAddress(address, port), 8)
            }
            serverSocket = socket
            acceptJob = scope.launch { acceptLoop(socket) }
            diagnostics.transportListening(
                kind,
                port = port,
                detail = "$bindAddress:$port${if (localProbe) " · local probe without token" else " · token required"}",
                insecureLocalProbe = localProbe,
            )
            AdapterStartResult.Running
        } catch (error: Exception) {
            val message = "http receiver start failed: ${error.message ?: error.javaClass.simpleName}"
            diagnostics.transportFailed(kind, message)
            AdapterStartResult.Failed(message)
        }
    }

    override suspend fun stop() {
        serverSocket?.close()
        serverSocket = null
        acceptJob?.cancelAndJoin()
        acceptJob = null
        diagnostics.transportStopped(kind)
    }

    private suspend fun acceptLoop(listener: ServerSocket) {
        try {
            while (scope.isActive && !listener.isClosed) {
                val socket = listener.accept()
                handleConnection(socket)
            }
        } catch (error: SocketException) {
            if (!listener.isClosed) diagnostics.transportFailed(kind, "http receiver socket failed: ${error.message}")
        } catch (error: Exception) {
            diagnostics.transportFailed(kind, "http receiver failed: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    private suspend fun handleConnection(socket: Socket) {
        socket.use {
            socket.soTimeout = 15_000
            val output = BufferedOutputStream(socket.getOutputStream())
            try {
                val request = readRequest(BufferedInputStream(socket.getInputStream()))
                authorize(request.headers)
                if (request.method != "POST") throw HttpIngressFailure(405, "METHOD_NOT_ALLOWED", "use POST")
                if (request.path != PATH) throw HttpIngressFailure(404, "NOT_FOUND", "route not found")
                val mediaType = request.headers["content-type"].orEmpty().substringBefore(';').trim().lowercase()
                if (mediaType != "application/json") {
                    throw HttpIngressFailure(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json")
                }
                val acknowledgement = repository.ingestWatchBatch(request.body, kind)
                SyncScheduler.enqueueNow(applicationContext, expedited = true)
                writeResponse(output, if (acknowledgement.replayed) 200 else 202, successBody(acknowledgement))
            } catch (error: Exception) {
                val failure = when (error) {
                    is HttpIngressFailure -> error
                    is ContractViolation -> HttpIngressFailure(
                        if (error.errorCode == "EVENT_ID_CONFLICT" || error.errorCode == "BATCH_ID_CONFLICT") 409 else 400,
                        error.errorCode,
                        error.message,
                    )
                    else -> HttpIngressFailure(
                        500,
                        "PHONE_PERSISTENCE_ERROR",
                        error.message ?: error.javaClass.simpleName,
                    )
                }
                diagnostics.transportEventError(kind, failure.message)
                writeResponse(output, failure.statusCode, errorBody(failure.code, failure.message))
            }
        }
    }

    private fun authorize(headers: Map<String, String>) {
        if (bridgeToken.isNullOrBlank()) return
        val actual = headers[TOKEN_HEADER]
            ?: throw HttpIngressFailure(401, "UNAUTHORIZED", "bridge token is required")
        val matches = MessageDigest.isEqual(
            actual.toByteArray(StandardCharsets.UTF_8),
            bridgeToken.toByteArray(StandardCharsets.UTF_8),
        )
        if (!matches) throw HttpIngressFailure(401, "UNAUTHORIZED", "bridge token is invalid")
    }

    private fun readRequest(input: BufferedInputStream): IngressRequest {
        val requestLine = readAsciiLine(input, 8_192)
            ?: throw HttpIngressFailure(400, "INVALID_REQUEST", "request line is missing")
        val parts = requestLine.split(' ')
        if (parts.size != 3 || !parts[2].startsWith("HTTP/1.")) {
            throw HttpIngressFailure(400, "INVALID_REQUEST", "request line is invalid")
        }
        val headers = linkedMapOf<String, String>()
        var totalHeaderBytes = requestLine.length
        while (true) {
            val line = readAsciiLine(input, 8_192)
                ?: throw HttpIngressFailure(400, "INVALID_REQUEST", "headers ended unexpectedly")
            if (line.isEmpty()) break
            totalHeaderBytes += line.length
            if (totalHeaderBytes > 32_768) {
                throw HttpIngressFailure(431, "HEADERS_TOO_LARGE", "request headers are too large")
            }
            val separator = line.indexOf(':')
            if (separator <= 0) throw HttpIngressFailure(400, "INVALID_REQUEST", "header is invalid")
            headers[line.substring(0, separator).trim().lowercase()] = line.substring(separator + 1).trim()
        }
        if (headers.containsKey("transfer-encoding")) {
            throw HttpIngressFailure(400, "UNSUPPORTED_TRANSFER", "chunked transfer encoding is not supported")
        }
        val length = headers["content-length"]?.toIntOrNull()
            ?: throw HttpIngressFailure(411, "LENGTH_REQUIRED", "Content-Length is required")
        if (length <= 0 || length > HealthContract.MAX_BODY_BYTES) {
            throw HttpIngressFailure(413, "BODY_TOO_LARGE", "body must contain 1..${HealthContract.MAX_BODY_BYTES} bytes")
        }
        val body = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val read = input.read(body, offset, length - offset)
            if (read < 0) throw HttpIngressFailure(400, "INVALID_REQUEST", "body ended unexpectedly")
            offset += read
        }
        return IngressRequest(parts[0], parts[1], headers, body.toString(StandardCharsets.UTF_8))
    }

    private fun readAsciiLine(input: BufferedInputStream, maxLength: Int): String? {
        val builder = StringBuilder()
        while (builder.length <= maxLength) {
            val value = input.read()
            if (value < 0) return if (builder.isEmpty()) null else builder.toString()
            if (value == '\n'.code) {
                if (builder.isNotEmpty() && builder.last() == '\r') builder.setLength(builder.length - 1)
                return builder.toString()
            }
            if (value > 0x7f) throw HttpIngressFailure(400, "INVALID_REQUEST", "HTTP headers must be ASCII")
            builder.append(value.toChar())
        }
        throw HttpIngressFailure(431, "HEADERS_TOO_LARGE", "header line is too long")
    }

    private fun writeResponse(output: BufferedOutputStream, statusCode: Int, body: String) {
        val reason = when (statusCode) {
            200 -> "OK"
            202 -> "Accepted"
            400 -> "Bad Request"
            401 -> "Unauthorized"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            409 -> "Conflict"
            411 -> "Length Required"
            413 -> "Payload Too Large"
            415 -> "Unsupported Media Type"
            431 -> "Request Header Fields Too Large"
            else -> "Internal Server Error"
        }
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        val headers = buildString {
            append("HTTP/1.1 $statusCode $reason\r\n")
            append("Content-Type: application/json; charset=utf-8\r\n")
            append("Content-Length: ${bytes.size}\r\n")
            append("Cache-Control: no-store\r\n")
            append("Connection: close\r\n\r\n")
        }.toByteArray(StandardCharsets.US_ASCII)
        output.write(headers)
        output.write(bytes)
        output.flush()
    }

    private fun successBody(ack: IngressAcknowledgement): String = buildJsonObject {
        put("ok", true)
        put("status", "PASS")
        put("generated_at", System.currentTimeMillis())
        put("data", buildJsonObject {
            put("batch_id", ack.batchId)
            put("accepted", ack.accepted)
            put("duplicates", ack.duplicates)
            put("received_at", ack.receivedAt)
            put("replayed", ack.replayed)
        })
    }.toString()

    private fun errorBody(code: String, message: String): String = buildJsonObject {
        put("ok", false)
        put("status", "ERROR")
        put("error", buildJsonObject {
            put("code", code)
            put("message", message.take(2048))
        })
    }.toString()

    private data class IngressRequest(
        val method: String,
        val path: String,
        val headers: Map<String, String>,
        val body: String,
    )

    private class HttpIngressFailure(
        val statusCode: Int,
        val code: String,
        override val message: String,
    ) : Exception(message)

    companion object {
        const val PATH = "/v1/health/batches"
        const val TOKEN_HEADER = "x-akari-bridge-token"
    }
}
