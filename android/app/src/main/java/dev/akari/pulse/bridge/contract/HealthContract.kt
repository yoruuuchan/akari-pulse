package dev.akari.pulse.bridge.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

enum class HealthStatus {
    PASS,
    NO_DATA,
    DENIED,
    UNSUPPORTED,
    API_MISSING,
    ERROR,
}

class ContractViolation(
    val errorCode: String,
    override val message: String,
) : IllegalArgumentException(message)

data class IncomingHealthEvent(
    val eventId: String,
    val timestamp: Long,
    val sampleTimestamp: Long?,
    val metric: String,
    val hasValue: Boolean,
    val valueJson: String?,
    val unit: String?,
    val sourceDevice: String,
    val sourceModule: String?,
    val sourceApi: String?,
    val quality: String?,
    val status: HealthStatus,
    val sessionId: String?,
    val callbackDeltaMs: Long?,
    val rawErrorCodeJson: String?,
    val rawErrorMessage: String?,
    val rawEventJson: String,
)

data class IncomingHealthBatch(
    val batchId: String,
    val producer: String,
    val sentAt: Long?,
    val events: List<IncomingHealthEvent>,
)

object HealthContract {
    const val MAX_BATCH_EVENTS = 500
    const val MAX_BODY_BYTES = 1_048_576

    val json = Json {
        ignoreUnknownKeys = false
        isLenient = false
        explicitNulls = true
    }

    private val batchKeys = setOf("batch_id", "producer", "sent_at", "events")
    private val eventKeys = setOf(
        "event_id",
        "timestamp",
        "sample_timestamp",
        "metric",
        "value",
        "unit",
        "source_device",
        "source_module",
        "source_api",
        "quality",
        "status",
        "session_id",
        "callback_delta_ms",
        "raw_error_code",
        "raw_error_message",
    )
    private val metricPattern = Regex("^[a-z][a-z0-9_]{0,63}$")
    private const val MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991L

    fun parseBatch(rawJson: String): IncomingHealthBatch {
        if (rawJson.toByteArray(Charsets.UTF_8).size > MAX_BODY_BYTES) {
            throw ContractViolation("BODY_TOO_LARGE", "request body exceeds $MAX_BODY_BYTES bytes")
        }
        val root = try {
            json.parseToJsonElement(rawJson).jsonObject
        } catch (error: Exception) {
            throw ContractViolation("INVALID_JSON", "request body must be a JSON object")
        }
        rejectUnknown(root, batchKeys, "body")
        val events = requiredArray(root, "events", "body.events")
        if (events.isEmpty() || events.size > MAX_BATCH_EVENTS) {
            throw ContractViolation(
                "INVALID_REQUEST",
                "body.events must contain between 1 and $MAX_BATCH_EVENTS events",
            )
        }
        return IncomingHealthBatch(
            batchId = requiredString(root, "batch_id", 128, "body.batch_id"),
            producer = requiredString(root, "producer", 128, "body.producer"),
            sentAt = optionalEpoch(root["sent_at"], "body.sent_at"),
            events = events.mapIndexed { index, element -> parseEvent(element, index) },
        )
    }

    private fun parseEvent(element: JsonElement, index: Int): IncomingHealthEvent {
        val path = "body.events[$index]"
        val event = try {
            element.jsonObject
        } catch (error: Exception) {
            throw ContractViolation("INVALID_REQUEST", "$path must be an object")
        }
        rejectUnknown(event, eventKeys, path)
        val statusName = requiredString(event, "status", 32, "$path.status")
        val status = HealthStatus.entries.firstOrNull { it.name == statusName }
            ?: throw ContractViolation("INVALID_REQUEST", "$path.status is not supported")
        val hasValue = event.containsKey("value")
        if (status == HealthStatus.PASS && (!hasValue || event["value"] is JsonNull)) {
            throw ContractViolation("INVALID_REQUEST", "$path.value must be non-null when status is PASS")
        }
        if (hasValue) validateJsonValue(event.getValue("value"), "$path.value", 0)

        val metric = requiredString(event, "metric", 64, "$path.metric")
        if (!metricPattern.matches(metric)) {
            throw ContractViolation("INVALID_REQUEST", "$path.metric must be lower_snake_case")
        }
        val rawErrorCode = event["raw_error_code"]
        if (rawErrorCode != null && rawErrorCode !is JsonNull) {
            val primitive = rawErrorCode as? JsonPrimitive
                ?: throw ContractViolation("INVALID_REQUEST", "$path.raw_error_code must be a string, number, or null")
            val numeric = primitive.doubleOrNull
            if (!primitive.isString && (numeric == null || !numeric.isFinite())) {
                throw ContractViolation("INVALID_REQUEST", "$path.raw_error_code must be a string, number, or null")
            }
        }

        return IncomingHealthEvent(
            eventId = requiredString(event, "event_id", 128, "$path.event_id"),
            timestamp = requiredEpoch(event, "timestamp", "$path.timestamp"),
            sampleTimestamp = optionalEpoch(event["sample_timestamp"], "$path.sample_timestamp"),
            metric = metric,
            hasValue = hasValue,
            valueJson = if (hasValue) event.getValue("value").toString() else null,
            unit = optionalString(event["unit"], 32, "$path.unit"),
            sourceDevice = requiredString(event, "source_device", 128, "$path.source_device"),
            sourceModule = optionalString(event["source_module"], 128, "$path.source_module"),
            sourceApi = optionalString(event["source_api"], 128, "$path.source_api"),
            quality = optionalString(event["quality"], 64, "$path.quality"),
            status = status,
            sessionId = optionalString(event["session_id"], 128, "$path.session_id"),
            callbackDeltaMs = optionalEpoch(event["callback_delta_ms"], "$path.callback_delta_ms"),
            rawErrorCodeJson = if (rawErrorCode == null || rawErrorCode is JsonNull) null else rawErrorCode.toString(),
            rawErrorMessage = optionalString(event["raw_error_message"], 2048, "$path.raw_error_message"),
            rawEventJson = canonicalEventJson(event, hasValue),
        )
    }

    private fun canonicalEventJson(event: JsonObject, hasValue: Boolean): String = buildJsonObject {
        put("event_id", event.getValue("event_id"))
        put("timestamp", event.getValue("timestamp"))
        put("sample_timestamp", event["sample_timestamp"] ?: JsonNull)
        put("metric", event.getValue("metric"))
        put("unit", event["unit"] ?: JsonNull)
        put("source_device", event.getValue("source_device"))
        put("source_module", event["source_module"] ?: JsonNull)
        put("source_api", event["source_api"] ?: JsonNull)
        put("quality", event["quality"] ?: JsonNull)
        put("status", event.getValue("status"))
        put("session_id", event["session_id"] ?: JsonNull)
        put("callback_delta_ms", event["callback_delta_ms"] ?: JsonNull)
        put("raw_error_code", event["raw_error_code"] ?: JsonNull)
        put("raw_error_message", event["raw_error_message"] ?: JsonNull)
        if (hasValue) put("value", event.getValue("value"))
    }.toString()

    private fun rejectUnknown(value: JsonObject, allowed: Set<String>, path: String) {
        val unknown = value.keys - allowed
        if (unknown.isNotEmpty()) {
            throw ContractViolation("INVALID_REQUEST", "$path contains unknown fields: ${unknown.sorted().joinToString()}")
        }
    }

    private fun requiredArray(value: JsonObject, key: String, path: String): JsonArray =
        try {
            value[key]?.jsonArray ?: throw IllegalArgumentException()
        } catch (error: Exception) {
            throw ContractViolation("INVALID_REQUEST", "$path must be an array")
        }

    private fun requiredString(value: JsonObject, key: String, max: Int, path: String): String {
        val primitive = value[key] as? JsonPrimitive
            ?: throw ContractViolation("INVALID_REQUEST", "$path must be a string")
        if (!primitive.isString) throw ContractViolation("INVALID_REQUEST", "$path must be a string")
        return primitive.content.also {
            if (it.isEmpty() || it.length > max) {
                throw ContractViolation("INVALID_REQUEST", "$path must contain between 1 and $max characters")
            }
        }
    }

    private fun optionalString(value: JsonElement?, max: Int, path: String): String? {
        if (value == null || value is JsonNull) return null
        val primitive = value as? JsonPrimitive
            ?: throw ContractViolation("INVALID_REQUEST", "$path must be a string or null")
        if (!primitive.isString || primitive.content.length > max) {
            throw ContractViolation("INVALID_REQUEST", "$path must be a string no longer than $max characters")
        }
        return primitive.content
    }

    private fun requiredEpoch(value: JsonObject, key: String, path: String): Long =
        optionalEpoch(value[key], path)
            ?: throw ContractViolation("INVALID_REQUEST", "$path is required")

    private fun optionalEpoch(value: JsonElement?, path: String): Long? {
        if (value == null || value is JsonNull) return null
        val primitive = value as? JsonPrimitive
            ?: throw ContractViolation("INVALID_REQUEST", "$path must be a non-negative integer")
        if (primitive.isString || primitive.booleanOrNull != null) {
            throw ContractViolation("INVALID_REQUEST", "$path must be a non-negative integer")
        }
        val number = primitive.doubleOrNull
            ?: throw ContractViolation("INVALID_REQUEST", "$path must be a non-negative integer")
        if (!number.isFinite() || number < 0 || number > MAX_SAFE_JSON_INTEGER || number % 1.0 != 0.0) {
            throw ContractViolation("INVALID_REQUEST", "$path must be a non-negative safe integer")
        }
        return number.toLong()
    }

    private fun validateJsonValue(value: JsonElement, path: String, depth: Int) {
        if (depth > 12) throw ContractViolation("INVALID_REQUEST", "$path is nested too deeply")
        when (value) {
            is JsonNull -> Unit
            is JsonPrimitive -> {
                if (!value.isString && value.booleanOrNull == null) {
                    val number = value.doubleOrNull
                    if (number == null || !number.isFinite()) {
                        throw ContractViolation("INVALID_REQUEST", "$path contains an invalid JSON number")
                    }
                }
            }
            is JsonArray -> value.forEachIndexed { index, child ->
                validateJsonValue(child, "$path[$index]", depth + 1)
            }
            is JsonObject -> value.forEach { (key, child) ->
                validateJsonValue(child, "$path.$key", depth + 1)
            }
        }
    }
}
