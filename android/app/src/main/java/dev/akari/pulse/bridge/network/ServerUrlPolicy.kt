package dev.akari.pulse.bridge.network

import dev.akari.pulse.bridge.BuildConfig
import java.net.URI

object ServerUrlPolicy {
    fun validate(rawValue: String, allowTailnetHttp: Boolean): String {
        val trimmed = rawValue.trim().trimEnd('/')
        require(trimmed.isNotEmpty()) { "server url is required" }
        val uri = try {
            URI(trimmed)
        } catch (error: Exception) {
            throw IllegalArgumentException("server url is invalid")
        }
        require(uri.userInfo == null && uri.query == null && uri.fragment == null) {
            "server url cannot contain credentials, a query, or a fragment"
        }
        require(uri.path.isNullOrEmpty()) { "server url must not include an endpoint path" }
        val host = uri.host?.lowercase() ?: throw IllegalArgumentException("server url must include a host")
        when (uri.scheme?.lowercase()) {
            "https" -> Unit
            "http" -> {
                require(BuildConfig.DEBUG) { "release builds require https" }
                require(allowTailnetHttp) { "enable tailnet http explicitly or use https" }
                require(isLoopback(host) || host.endsWith(".ts.net") || isTailscaleIpv4(host)) {
                    "http is restricted to loopback, a full .ts.net name, or 100.64.0.0/10"
                }
            }
            else -> throw IllegalArgumentException("server url must use https or explicitly allowed tailnet http")
        }
        return trimmed
    }

    private fun isLoopback(host: String): Boolean =
        host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"

    private fun isTailscaleIpv4(host: String): Boolean {
        val octets = host.split('.').mapNotNull { it.toIntOrNull() }
        if (octets.size != 4 || octets.any { it !in 0..255 }) return false
        return octets[0] == 100 && octets[1] in 64..127
    }
}
