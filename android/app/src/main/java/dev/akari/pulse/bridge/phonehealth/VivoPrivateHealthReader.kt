package dev.akari.pulse.bridge.phonehealth

import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import androidx.core.content.ContextCompat
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** One provider row, always addressed by column name. Column order is not part of the contract. */
internal data class ProviderRow(
    val columns: List<String>,
    val values: Map<String, String?>,
)

internal class ProviderParseException(message: String) : IllegalArgumentException(message)

internal interface VivoPrivateHealthGateway {
    fun permissionGranted(): Boolean
    fun providersResolved(): Boolean
    fun querySleep(): ProviderRow?
    fun queryCare(): ProviderRow?
}

internal class AndroidVivoPrivateHealthGateway(context: Context) : VivoPrivateHealthGateway {
    private val applicationContext = context.applicationContext
    private val resolver = applicationContext.contentResolver
    private val packageManager = applicationContext.packageManager

    override fun permissionGranted(): Boolean =
        ContextCompat.checkSelfPermission(applicationContext, VivoPrivateHealthSnapshot.REQUIRED_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED

    override fun providersResolved(): Boolean =
        packageManager.resolveContentProvider(SLEEP_AUTHORITY, 0) != null &&
            packageManager.resolveContentProvider(CARE_AUTHORITY, 0) != null

    override fun querySleep(): ProviderRow? = firstRow(SLEEP_URI)

    override fun queryCare(): ProviderRow? = firstRow(CARE_URI)

    private fun firstRow(uri: Uri): ProviderRow? =
        resolver.query(uri, null, null, null, null)?.use { cursor -> readFirstRow(cursor) }

    private fun readFirstRow(cursor: Cursor): ProviderRow? {
        if (!cursor.moveToFirst()) return null
        val columns = cursor.columnNames.toList()
        return ProviderRow(
            columns = columns,
            values = columns.associateWith { column -> cursor.getString(cursor.getColumnIndexOrThrow(column)) },
        )
    }

    companion object {
        const val SLEEP_AUTHORITY = "com.vivo.health.provider"
        const val CARE_AUTHORITY = "com.vivo.health.provider.care"

        val SLEEP_URI: Uri = Uri.parse("content://$SLEEP_AUTHORITY/sleep")
        val CARE_URI: Uri = Uri.parse("content://$CARE_AUTHORITY/healthCare")
    }
}

/**
 * Reads the two vivo private providers that were verified against the vivo Health UI:
 * `content://com.vivo.health.provider/sleep` (one sleep day, 38 columns) and
 * `content://com.vivo.health.provider.care/healthCare` (latest heart rate, SpO2, stress).
 *
 * The reader never falls back to UI scraping, Settings mirrors, or a cached value. A missing
 * permission produces `NOT_GRANTED`, a missing provider produces `UNSUPPORTED`, and both are
 * reported instead of any substituted data.
 */
class VivoPrivateHealthReader internal constructor(
    private val gateway: VivoPrivateHealthGateway,
    private val now: () -> Long = System::currentTimeMillis,
    private val zoneId: () -> ZoneId = ZoneId::systemDefault,
) {
    constructor(context: Context) : this(AndroidVivoPrivateHealthGateway(context))

    fun read(): VivoPrivateHealthSnapshot {
        val readAt = now()
        val zone = zoneId()

        val permissionGranted: Boolean
        val providersResolved: Boolean
        try {
            permissionGranted = gateway.permissionGranted()
            providersResolved = gateway.providersResolved()
        } catch (error: Exception) {
            return unavailable(
                capability = VivoPrivateHealthCapability.ERROR,
                outcome = VivoPrivateOutcome.CAPABILITY_PROBE_FAILED,
                readAt = readAt,
                zone = zone,
                permissionGranted = false,
                providersResolved = false,
                failureStage = "capability_probe",
                error = error,
            )
        }

        if (!providersResolved) {
            return unavailable(
                capability = VivoPrivateHealthCapability.UNSUPPORTED,
                outcome = VivoPrivateOutcome.PROVIDER_UNSUPPORTED,
                readAt = readAt,
                zone = zone,
                permissionGranted = permissionGranted,
                providersResolved = false,
                failureStage = "provider_resolve",
            )
        }
        if (!permissionGranted) {
            return unavailable(
                capability = VivoPrivateHealthCapability.NOT_GRANTED,
                outcome = VivoPrivateOutcome.PERMISSION_NOT_GRANTED,
                readAt = readAt,
                zone = zone,
                permissionGranted = false,
                providersResolved = true,
                failureStage = "permission",
            )
        }

        val sleepRow = runCatching { gateway.querySleep() }
        val careRow = runCatching { gateway.queryCare() }

        return VivoPrivateHealthSnapshot(
            capability = VivoPrivateHealthCapability.GRANTED,
            readAtEpochMs = readAt,
            readAt = isoTime(readAt, zone),
            timezone = zone.id,
            permissionGranted = true,
            providersResolved = true,
            sleepCursorColumns = sleepRow.getOrNull()?.columns.orEmpty(),
            careCursorColumns = careRow.getOrNull()?.columns.orEmpty(),
            sleep = parseSleep(sleepRow),
            vitals = parseVitals(careRow, zone),
        )
    }

    private fun parseSleep(query: Result<ProviderRow?>): VivoSleepDay {
        val row = query.getOrElse { error ->
            return VivoSleepDay(
                status = PhoneHealthStatus.ERROR,
                outcome = VivoPrivateOutcome.PROVIDER_CALL_FAILED,
                failureStage = "sleep_query",
                exceptionType = error.javaClass.name,
                exceptionMessage = error.message?.take(MAX_DIAGNOSTIC_LENGTH),
            )
        } ?: return VivoSleepDay(
            status = PhoneHealthStatus.NO_DATA,
            outcome = VivoPrivateOutcome.PROVIDER_NO_DATA,
            failureStage = "sleep_row",
        )

        return try {
            val sourceDay = row.requiredString(COLUMN_DATE)
            if (!SOURCE_DAY.matches(sourceDay)) {
                throw ProviderParseException("$COLUMN_DATE is not a yyyy-MM-dd calendar day")
            }
            val sleepStart = row.requiredLong(COLUMN_ENTER_TIME)
            val sleepEnd = row.requiredLong(COLUMN_EXIT_TIME)
            if (sleepStart <= 0 || sleepEnd <= sleepStart) {
                throw ProviderParseException("$COLUMN_ENTER_TIME/$COLUMN_EXIT_TIME are not an ordered span")
            }
            val totalDuration = row.requiredLong(COLUMN_TOTAL_DURATION)
            if (totalDuration < 0) throw ProviderParseException("$COLUMN_TOTAL_DURATION is negative")
            val awakeIntervals = row.optionalIntervals(COLUMN_AWAKE_LIST)
            // vivo counts a wake-up only when the awake interval lies strictly inside the sleep
            // span; the leading and trailing awake edges are not wake-ups. This reproduces the
            // vivo Health "中途醒来" count and duration exactly.
            val interiorAwake = awakeIntervals
                ?.filter { it.startEpochMs > sleepStart && it.endEpochMs < sleepEnd }
            VivoSleepDay(
                status = PhoneHealthStatus.PASS,
                outcome = VivoPrivateOutcome.PROVIDER_CALL_SUCCEEDED,
                sourceDay = sourceDay,
                sourceDayStartEpochMs = row.requiredLong(COLUMN_TIMESTAMP),
                sleepStartEpochMs = sleepStart,
                sleepEndEpochMs = sleepEnd,
                totalDurationMs = totalDuration,
                nightSleepDurationMs = row.optionalNonNegativeLong(COLUMN_NIGHT_SLEEP_TOTAL),
                napDurationMs = row.optionalNonNegativeLong(COLUMN_NAP_TOTAL),
                chartTotalDurationMs = row.optionalNonNegativeLong(COLUMN_CHARVIEW_TOTAL),
                lightSleepDurationMs = row.optionalNonNegativeLong(COLUMN_LIGHT_DURATION),
                deepSleepDurationMs = row.optionalNonNegativeLong(COLUMN_DEEP_DURATION),
                remSleepDurationMs = row.optionalNonNegativeLong(COLUMN_REM_DURATION),
                awakeDurationMs = row.optionalNonNegativeLong(COLUMN_AWAKE_DURATION),
                awakeEpisodeCount = interiorAwake?.size,
                awakeEpisodeDurationMs = interiorAwake?.sumOf { it.endEpochMs - it.startEpochMs },
                score = row.optionalInt(COLUMN_SCORE),
                deepSleepContinuity = row.optionalInt(COLUMN_DEEP_CONTINUITY),
                lowAccuracy = row.optionalInt(COLUMN_LOW_ACCURACY)?.let { it != 0 },
                recorderGeneration = row.optionalInt(COLUMN_WATCH_GENERATION),
                lightSleepIntervals = row.optionalIntervals(COLUMN_LIGHT_LIST),
                deepSleepIntervals = row.optionalIntervals(COLUMN_DEEP_LIST),
                remSleepIntervals = row.optionalIntervals(COLUMN_REM_LIST),
                awakeIntervals = awakeIntervals,
            )
        } catch (error: Exception) {
            VivoSleepDay(
                status = PhoneHealthStatus.ERROR,
                outcome = VivoPrivateOutcome.PARSE_FAILED,
                failureStage = "sleep_cursor",
                exceptionType = error.javaClass.name,
                exceptionMessage = error.message?.take(MAX_DIAGNOSTIC_LENGTH),
            )
        }
    }

    private fun parseVitals(query: Result<ProviderRow?>, zone: ZoneId): VivoLatestVitals {
        val row = query.getOrElse { error ->
            return vitalsFailure(
                outcome = VivoPrivateOutcome.PROVIDER_CALL_FAILED,
                failureStage = "care_query",
                error = error,
            )
        } ?: return vitalsFailure(
            status = PhoneHealthStatus.NO_DATA,
            outcome = VivoPrivateOutcome.PROVIDER_NO_DATA,
            failureStage = "care_row",
        )

        val myself = row.values[COLUMN_MYSELF_DATA]
            ?: return vitalsFailure(
                status = PhoneHealthStatus.NO_DATA,
                outcome = VivoPrivateOutcome.PROVIDER_NO_DATA,
                failureStage = "care_myself_data",
            )

        val detail = try {
            JSON.parseToJsonElement(myself).jsonObject
        } catch (error: Exception) {
            return vitalsFailure(
                outcome = VivoPrivateOutcome.PARSE_FAILED,
                failureStage = "care_myself_data",
                error = error,
            )
        }

        val heartRate = detail.vital(
            valueKey = "heartValue",
            timestampKey = "heartTimeStamp",
            abnormalKey = "heartAbnormalType",
            unit = VivoPrivateHealthSnapshot.HEART_RATE_UNIT,
            zone = zone,
        )
        val spo2 = detail.vital(
            valueKey = "saO2Value",
            timestampKey = "saO2TimeStamp",
            abnormalKey = "oxygenAbnormal",
            unit = VivoPrivateHealthSnapshot.SPO2_UNIT,
            zone = zone,
        )
        val stress = detail.vital(
            valueKey = "pressureValue",
            timestampKey = "pressureTimeStamp",
            abnormalKey = "pressAbnormal",
            unit = VivoPrivateHealthSnapshot.STRESS_UNIT,
            zone = zone,
        )
        val anyPass = listOf(heartRate, spo2, stress).any { it.status == PhoneHealthStatus.PASS }
        return VivoLatestVitals(
            status = if (anyPass) PhoneHealthStatus.PASS else PhoneHealthStatus.NO_DATA,
            outcome = if (anyPass) {
                VivoPrivateOutcome.PROVIDER_CALL_SUCCEEDED
            } else {
                VivoPrivateOutcome.PROVIDER_NO_DATA
            },
            heartRate = heartRate,
            spo2 = spo2,
            stress = stress,
            providerSourceFrom = detail["sourceFrom"]?.jsonPrimitive?.contentOrNullSafe(),
        )
    }

    /**
     * A vital point is only real when both the value and its own source timestamp are positive.
     * vivo fills the absent case with `0` in both fields, which is not a physiological zero.
     */
    private fun JsonObject.vital(
        valueKey: String,
        timestampKey: String,
        abnormalKey: String,
        unit: String,
        zone: ZoneId,
    ): VivoLatestVital {
        val value = this[valueKey]?.jsonPrimitive?.doubleOrNull
        val timestamp = this[timestampKey]?.jsonPrimitive?.longOrNull
        val abnormal = this[abnormalKey]?.jsonPrimitive?.intOrNull
        if (value == null || timestamp == null || !value.isFinite() || value <= 0.0 || timestamp <= 0L) {
            return VivoLatestVital(
                status = PhoneHealthStatus.NO_DATA,
                outcome = VivoPrivateOutcome.PROVIDER_NO_DATA,
                unit = unit,
                abnormalFlag = abnormal,
            )
        }
        return VivoLatestVital(
            status = PhoneHealthStatus.PASS,
            outcome = VivoPrivateOutcome.PROVIDER_CALL_SUCCEEDED,
            value = value,
            unit = unit,
            sourceEpochMs = timestamp,
            sourceTime = isoTime(timestamp, zone),
            abnormalFlag = abnormal,
        )
    }

    private fun unavailable(
        capability: VivoPrivateHealthCapability,
        outcome: VivoPrivateOutcome,
        readAt: Long,
        zone: ZoneId,
        permissionGranted: Boolean,
        providersResolved: Boolean,
        failureStage: String,
        error: Throwable? = null,
    ): VivoPrivateHealthSnapshot = VivoPrivateHealthSnapshot(
        capability = capability,
        readAtEpochMs = readAt,
        readAt = isoTime(readAt, zone),
        timezone = zone.id,
        permissionGranted = permissionGranted,
        providersResolved = providersResolved,
        sleep = VivoSleepDay(
            status = PhoneHealthStatus.ERROR,
            outcome = outcome,
            failureStage = failureStage,
            exceptionType = error?.javaClass?.name,
            exceptionMessage = error?.message?.take(MAX_DIAGNOSTIC_LENGTH),
        ),
        vitals = vitalsFailure(outcome = outcome, failureStage = failureStage, error = error),
    )

    private fun vitalsFailure(
        status: PhoneHealthStatus = PhoneHealthStatus.ERROR,
        outcome: VivoPrivateOutcome,
        failureStage: String,
        error: Throwable? = null,
    ): VivoLatestVitals = VivoLatestVitals(
        status = status,
        outcome = outcome,
        heartRate = absentVital(status, outcome, VivoPrivateHealthSnapshot.HEART_RATE_UNIT),
        spo2 = absentVital(status, outcome, VivoPrivateHealthSnapshot.SPO2_UNIT),
        stress = absentVital(status, outcome, VivoPrivateHealthSnapshot.STRESS_UNIT),
        failureStage = failureStage,
        exceptionType = error?.javaClass?.name,
        exceptionMessage = error?.message?.take(MAX_DIAGNOSTIC_LENGTH),
    )

    private fun absentVital(
        status: PhoneHealthStatus,
        outcome: VivoPrivateOutcome,
        unit: String,
    ): VivoLatestVital = VivoLatestVital(status = status, outcome = outcome, unit = unit)

    private fun isoTime(epochMs: Long, zone: ZoneId): String =
        Instant.ofEpochMilli(epochMs).atZone(zone).toOffsetDateTime().toString()

    private fun ProviderRow.requiredString(column: String): String =
        values[column]?.takeIf { it.isNotBlank() }
            ?: throw ProviderParseException("cursor column $column is missing")

    private fun ProviderRow.requiredLong(column: String): Long =
        requiredString(column).toLongOrNull()
            ?: throw ProviderParseException("cursor column $column is not an integer")

    private fun ProviderRow.optionalNonNegativeLong(column: String): Long? {
        val raw = values[column] ?: return null
        val parsed = raw.toLongOrNull() ?: throw ProviderParseException("cursor column $column is not an integer")
        if (parsed < 0) throw ProviderParseException("cursor column $column is negative")
        return parsed
    }

    private fun ProviderRow.optionalInt(column: String): Int? {
        val raw = values[column] ?: return null
        return raw.toIntOrNull() ?: throw ProviderParseException("cursor column $column is not an integer")
    }

    private fun ProviderRow.optionalIntervals(column: String): List<SleepStageInterval>? {
        val raw = values[column] ?: return null
        val elements = try {
            JSON.parseToJsonElement(raw).jsonArray
        } catch (error: Exception) {
            throw ProviderParseException("cursor column $column is not a JSON array")
        }
        return elements.map { element ->
            val interval = element.jsonObject
            val start = interval["enterTime"]?.jsonPrimitive?.longOrNull
            val end = interval["exitTime"]?.jsonPrimitive?.longOrNull
            if (start == null || end == null || start <= 0 || end < start) {
                throw ProviderParseException("cursor column $column holds an invalid interval")
            }
            SleepStageInterval(startEpochMs = start, endEpochMs = end)
        }
    }

    private companion object {
        const val COLUMN_DATE = "DATE"
        const val COLUMN_TIMESTAMP = "TIMESTAMP"
        const val COLUMN_ENTER_TIME = "ENTER_TIME"
        const val COLUMN_EXIT_TIME = "EXIT_TIME"
        const val COLUMN_TOTAL_DURATION = "TOTAL_DURATION"
        const val COLUMN_NIGHT_SLEEP_TOTAL = "NIGHT_SLEEP_TOTAL"
        const val COLUMN_NAP_TOTAL = "NAP_TOTAL"
        const val COLUMN_CHARVIEW_TOTAL = "CHARVIEW_TOTAL_DURATION"
        const val COLUMN_LIGHT_DURATION = "LIGHT_SLEEP_DURATION"
        const val COLUMN_DEEP_DURATION = "DEEP_SLEEP_DURATION"
        const val COLUMN_REM_DURATION = "REM_SLEEP_DURATION"
        const val COLUMN_AWAKE_DURATION = "AWAKE_SLEEP_DURATION"
        const val COLUMN_LIGHT_LIST = "LIGHT_SLEEP_LIST"
        const val COLUMN_DEEP_LIST = "DEEP_SLEEP_LIST"
        const val COLUMN_REM_LIST = "REM_SLEEP_LIST"
        const val COLUMN_AWAKE_LIST = "AWAKE_SLEEP_LIST"
        const val COLUMN_SCORE = "SCORE"
        const val COLUMN_DEEP_CONTINUITY = "DEEP_SLEEP_CONTINUITY"
        const val COLUMN_LOW_ACCURACY = "SLEEP_LOW_ACCURACY"
        const val COLUMN_WATCH_GENERATION = "WATCH_GENERATION"
        const val COLUMN_MYSELF_DATA = "MYSELF_DATA"

        const val MAX_DIAGNOSTIC_LENGTH = 2048

        val SOURCE_DAY = Regex("""^\d{4}-\d{2}-\d{2}$""")
        val JSON = Json { ignoreUnknownKeys = true }
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
    if (this is kotlinx.serialization.json.JsonNull) null else content.takeIf { it.isNotBlank() }
