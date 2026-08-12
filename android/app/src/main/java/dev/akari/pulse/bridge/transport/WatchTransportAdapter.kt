package dev.akari.pulse.bridge.transport

import dev.akari.pulse.bridge.diagnostics.TransportKind

sealed interface AdapterStartResult {
    data object Running : AdapterStartResult
    data class ConfigurationMissing(val message: String) : AdapterStartResult
    data class Unsupported(val message: String) : AdapterStartResult
    data class Failed(val message: String) : AdapterStartResult
}

interface WatchTransportAdapter {
    val kind: TransportKind

    suspend fun start(): AdapterStartResult

    suspend fun stop()
}
