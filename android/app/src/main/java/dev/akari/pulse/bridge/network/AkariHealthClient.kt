package dev.akari.pulse.bridge.network

import dev.akari.pulse.bridge.contract.HealthContract
import dev.akari.pulse.bridge.settings.BridgePreferences
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

data class UploadAcknowledgement(
    val batchId: String,
    val accepted: Int,
    val duplicates: Int,
    val receivedAt: Long,
    val replayed: Boolean,
)

data class DailySummaryUploadAcknowledgement(
    val batchId: String,
    val accepted: Int,
    val duplicates: Int,
    val stale: Int,
    val receivedAt: Long,
    val replayed: Boolean,
)

class ApiFailure(
    val retryable: Boolean,
    message: String,
) : IOException(message)

class AkariHealthClient(
    private val preferences: BridgePreferences,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    private val mediaType = "application/json; charset=utf-8".toMediaType()

    suspend fun upload(payload: JsonObject): UploadAcknowledgement = withContext(Dispatchers.IO) {
        val config = preferences.load()
        val baseUrl = ServerUrlPolicy.validate(config.serverBaseUrl, config.allowTailnetHttp)
        val expectedBatchId = payload.getValue("batch_id").jsonPrimitive.content
        val request = Request.Builder()
            .url("$baseUrl/v1/health/batches")
            .post(payload.toString().toRequestBody(mediaType))
            .header("Accept", "application/json")
            .apply {
                // The relay authenticates with X-Akari-Bridge-Token and the local or VPS service
                // with the bearer header. One stored credential, both headers, so the same build
                // works against either target.
                config.serverToken?.takeIf { it.isNotEmpty() }?.let { token ->
                    header("Authorization", "Bearer $token")
                    header("X-Akari-Bridge-Token", token)
                }
            }
            .build()
        executeJson(request).let { root ->
            val ok = root["ok"]?.jsonPrimitive?.booleanOrNull == true
            if (!ok) throw ApiFailure(false, "server response did not confirm success")
            val data = root["data"]?.jsonObject
                ?: throw ApiFailure(false, "server response is missing data")
            val batchId = data["batch_id"]?.jsonPrimitive?.content
                ?: throw ApiFailure(false, "server response is missing batch_id")
            if (batchId != expectedBatchId) {
                throw ApiFailure(false, "server acknowledged a different batch_id")
            }
            UploadAcknowledgement(
                batchId = batchId,
                accepted = data["accepted"]?.jsonPrimitive?.intOrNull
                    ?: throw ApiFailure(false, "server response is missing accepted"),
                duplicates = data["duplicates"]?.jsonPrimitive?.intOrNull
                    ?: throw ApiFailure(false, "server response is missing duplicates"),
                receivedAt = data["received_at"]?.jsonPrimitive?.longOrNull
                    ?: throw ApiFailure(false, "server response is missing received_at"),
                replayed = data["replayed"]?.jsonPrimitive?.booleanOrNull
                    ?: throw ApiFailure(false, "server response is missing replayed"),
            )
        }
    }

    suspend fun activeSessionCount(): Int = withContext(Dispatchers.IO) {
        val config = preferences.load()
        val baseUrl = ServerUrlPolicy.validate(config.serverBaseUrl, config.allowTailnetHttp)
        val request = Request.Builder()
            .url("$baseUrl/v1/sessions/active")
            .get()
            .header("Accept", "application/json")
            .apply {
                config.serverToken?.takeIf { it.isNotEmpty() }?.let { token ->
                    header("Authorization", "Bearer $token")
                }
            }
            .build()
        val root = executeJson(request)
        if (root["ok"]?.jsonPrimitive?.booleanOrNull != true) {
            throw ApiFailure(false, "server response did not confirm success")
        }
        root["data"]?.jsonObject?.get("sessions")?.jsonArray?.size
            ?: throw ApiFailure(false, "server response is missing active sessions")
    }

    suspend fun uploadDailySummaries(payload: JsonObject): DailySummaryUploadAcknowledgement =
        uploadSummaryBatch("/v1/health/daily-summaries", payload)

    suspend fun uploadSleepSummaries(payload: JsonObject): DailySummaryUploadAcknowledgement =
        uploadSummaryBatch("/v1/health/sleep-summaries", payload)

    private suspend fun uploadSummaryBatch(path: String, payload: JsonObject): DailySummaryUploadAcknowledgement =
        withContext(Dispatchers.IO) {
            val config = preferences.load()
            val baseUrl = ServerUrlPolicy.validate(config.serverBaseUrl, config.allowTailnetHttp)
            val expectedBatchId = payload.getValue("batch_id").jsonPrimitive.content
            val request = Request.Builder()
                .url("$baseUrl$path")
                .post(payload.toString().toRequestBody(mediaType))
                .header("Accept", "application/json")
                .apply {
                    config.serverToken?.takeIf { it.isNotEmpty() }?.let { token ->
                        header("Authorization", "Bearer $token")
                        header("X-Akari-Bridge-Token", token)
                    }
                }
                .build()
            executeJson(request).let { root ->
                if (root["ok"]?.jsonPrimitive?.booleanOrNull != true) {
                    throw ApiFailure(false, "server response did not confirm success")
                }
                val data = root["data"]?.jsonObject
                    ?: throw ApiFailure(false, "server response is missing data")
                val batchId = data["batch_id"]?.jsonPrimitive?.content
                    ?: throw ApiFailure(false, "server response is missing batch_id")
                if (batchId != expectedBatchId) {
                    throw ApiFailure(false, "server acknowledged a different batch_id")
                }
                DailySummaryUploadAcknowledgement(
                    batchId = batchId,
                    accepted = data["accepted"]?.jsonPrimitive?.intOrNull
                        ?: throw ApiFailure(false, "server response is missing accepted"),
                    duplicates = data["duplicates"]?.jsonPrimitive?.intOrNull
                        ?: throw ApiFailure(false, "server response is missing duplicates"),
                    stale = data["stale"]?.jsonPrimitive?.intOrNull
                        ?: throw ApiFailure(false, "server response is missing stale"),
                    receivedAt = data["received_at"]?.jsonPrimitive?.longOrNull
                        ?: throw ApiFailure(false, "server response is missing received_at"),
                    replayed = data["replayed"]?.jsonPrimitive?.booleanOrNull
                        ?: throw ApiFailure(false, "server response is missing replayed"),
                )
            }
        }

    private fun executeJson(request: Request): JsonObject {
        try {
            client.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    val retryable = response.code == 408 || response.code == 425 ||
                        response.code == 429 || response.code in 500..599
                    throw ApiFailure(
                        retryable,
                        "server returned HTTP ${response.code}: ${errorSummary(body)}",
                    )
                }
                return try {
                    HealthContract.json.parseToJsonElement(body).jsonObject
                } catch (error: Exception) {
                    throw ApiFailure(false, "server returned invalid JSON")
                }
            }
        } catch (error: ApiFailure) {
            throw error
        } catch (error: IOException) {
            throw ApiFailure(true, error.message ?: error.javaClass.simpleName)
        }
    }

    private fun errorSummary(body: String): String = try {
        val root = HealthContract.json.parseToJsonElement(body).jsonObject
        val error = root["error"]?.jsonObject
        val code = error?.get("code")?.jsonPrimitive?.content
        val message = error?.get("message")?.jsonPrimitive?.content
        listOfNotNull(code, message).joinToString(" · ").ifBlank { body.take(512) }
    } catch (error: Exception) {
        body.take(512).ifBlank { "empty response" }
    }
}
