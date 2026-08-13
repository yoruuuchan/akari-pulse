package dev.akari.pulse.bridge.phonehealth

import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.core.content.ContextCompat
import java.time.Instant
import java.time.ZoneId
import kotlin.math.max

internal data class RawProviderBundle(
    val keys: List<String>,
    val values: Map<String, Any?>,
)

internal class ProviderBundleParseException(cause: Throwable) :
    IllegalStateException("provider Bundle could not be decoded", cause)

internal interface VivoAssistantStepGateway {
    fun permissionGranted(): Boolean
    fun readRealtimeStepsSetting(): String?
    fun callCapability(): RawProviderBundle?
    fun callTodayActivity(): RawProviderBundle?
}

internal class AndroidVivoAssistantStepGateway(context: Context) : VivoAssistantStepGateway {
    private val applicationContext = context.applicationContext
    private val resolver = applicationContext.contentResolver

    override fun permissionGranted(): Boolean =
        ContextCompat.checkSelfPermission(applicationContext, PERMISSION) == PackageManager.PERMISSION_GRANTED

    override fun readRealtimeStepsSetting(): String? =
        Settings.System.getString(resolver, SETTINGS_REALTIME_STEPS)

    override fun callCapability(): RawProviderBundle? = snapshot(
        resolver.call(PROVIDER_URI, METHOD_CAN_STEP, null, null),
    )

    override fun callTodayActivity(): RawProviderBundle? {
        val extras = Bundle().apply { putBoolean(KEY_IGNORE, true) }
        return snapshot(resolver.call(PROVIDER_URI, METHOD_TODAY_ACTIVITY, null, extras))
    }

    @Suppress("DEPRECATION")
    private fun snapshot(bundle: Bundle?): RawProviderBundle? {
        if (bundle == null) return null
        return try {
            val keys = bundle.keySet().sorted()
            RawProviderBundle(keys, keys.associateWith { key -> bundle.get(key) })
        } catch (error: Exception) {
            throw ProviderBundleParseException(error)
        }
    }

    companion object {
        const val PERMISSION = "com.vivo.assistant.StepProvider"
        const val SETTINGS_REALTIME_STEPS = "vivo_settings_realtime_steps"
        const val METHOD_CAN_STEP = "canJoviStep"
        const val METHOD_TODAY_ACTIVITY = "updateTodaySportAIDLBean"
        const val KEY_IGNORE = "ignore"

        val PROVIDER_URI: Uri = Uri.parse("content://com.vivo.assistant.step.provider")
    }
}

class VivoTodayActivityReader internal constructor(
    private val gateway: VivoAssistantStepGateway,
    private val now: () -> Long = System::currentTimeMillis,
    private val zoneId: () -> ZoneId = ZoneId::systemDefault,
) {
    constructor(context: Context) : this(AndroidVivoAssistantStepGateway(context))

    fun read(): PhoneTodayActivity {
        val startedAt = now()
        val zone = zoneId()
        val settings = readSettingsObservation()
        val permissionGranted = gateway.permissionGranted()
        if (!permissionGranted) {
            return result(
                status = PhoneHealthStatus.ERROR,
                outcome = PhoneHealthOutcome.PROVIDER_CALL_FAILED,
                startedAt = startedAt,
                zone = zone,
                settings = settings,
                permissionGranted = false,
                failureStage = "permission",
                error = SecurityException("${AndroidVivoAssistantStepGateway.PERMISSION} is not granted"),
            )
        }

        val capability = try {
            gateway.callCapability()
        } catch (error: ProviderBundleParseException) {
            return parseFailure(startedAt, zone, settings, "capability_bundle", error)
        } catch (error: Exception) {
            return callFailure(startedAt, zone, settings, "capability_call", error)
        }
        if (capability == null) {
            return noData(startedAt, zone, settings, failureStage = "capability_call")
        }
        if (KEY_CAN_STEP !in capability.values) {
            return noData(
                startedAt = startedAt,
                zone = zone,
                settings = settings,
                failureStage = "capability_can_step",
                capability = capability,
            )
        }

        val canStep = try {
            capability.requiredInt(KEY_CAN_STEP)
        } catch (error: ProviderValueParseException) {
            return parseFailure(
                startedAt = startedAt,
                zone = zone,
                settings = settings,
                failureStage = "capability_bundle",
                error = error,
                capability = capability,
            )
        }
        if (canStep != 1) {
            return noData(
                startedAt = startedAt,
                zone = zone,
                settings = settings,
                failureStage = "capability_can_step",
                capability = capability,
                rawCanStep = canStep,
            )
        }

        val provider = try {
            gateway.callTodayActivity()
        } catch (error: ProviderBundleParseException) {
            return parseFailure(
                startedAt,
                zone,
                settings,
                "provider_bundle",
                error,
                capability,
                canStep,
            )
        } catch (error: Exception) {
            return callFailure(
                startedAt,
                zone,
                settings,
                "provider_call",
                error,
                capability,
                canStep,
            )
        }
        if (provider == null) {
            return noData(
                startedAt = startedAt,
                zone = zone,
                settings = settings,
                failureStage = "provider_call",
                capability = capability,
                rawCanStep = canStep,
            )
        }

        val parsed = try {
            ParsedActivity(
                steps = provider.requiredInt(KEY_STEP).also { value ->
                    if (value < 0) throw ProviderValueParseException("step must be non-negative")
                },
                distanceMeters = provider.requiredNonNegativeDouble(KEY_DISTANCE),
                caloriesKilocalories = provider.requiredNonNegativeDouble(KEY_CALORIE),
            )
        } catch (error: ProviderValueParseException) {
            return parseFailure(
                startedAt,
                zone,
                settings,
                "provider_bundle",
                error,
                capability,
                canStep,
                provider,
            )
        }

        return result(
            status = PhoneHealthStatus.PASS,
            outcome = PhoneHealthOutcome.PROVIDER_CALL_SUCCEEDED,
            startedAt = startedAt,
            zone = zone,
            settings = settings,
            permissionGranted = true,
            capability = capability,
            provider = provider,
            rawCanStep = canStep,
            steps = parsed.steps,
            distanceMeters = parsed.distanceMeters,
            caloriesKilocalories = parsed.caloriesKilocalories,
        )
    }

    private fun readSettingsObservation(): SettingsObservation = try {
        SettingsObservation(rawValue = gateway.readRealtimeStepsSetting())
    } catch (error: Exception) {
        SettingsObservation(
            exceptionType = error.javaClass.name,
            exceptionMessage = error.message?.take(MAX_DIAGNOSTIC_LENGTH),
        )
    }

    private fun noData(
        startedAt: Long,
        zone: ZoneId,
        settings: SettingsObservation,
        failureStage: String,
        capability: RawProviderBundle? = null,
        rawCanStep: Int? = null,
    ): PhoneTodayActivity = result(
        status = PhoneHealthStatus.NO_DATA,
        outcome = PhoneHealthOutcome.PROVIDER_NO_DATA,
        startedAt = startedAt,
        zone = zone,
        settings = settings,
        permissionGranted = true,
        capability = capability,
        rawCanStep = rawCanStep,
        failureStage = failureStage,
    )

    private fun callFailure(
        startedAt: Long,
        zone: ZoneId,
        settings: SettingsObservation,
        failureStage: String,
        error: Throwable,
        capability: RawProviderBundle? = null,
        rawCanStep: Int? = null,
    ): PhoneTodayActivity = result(
        status = PhoneHealthStatus.ERROR,
        outcome = PhoneHealthOutcome.PROVIDER_CALL_FAILED,
        startedAt = startedAt,
        zone = zone,
        settings = settings,
        permissionGranted = true,
        capability = capability,
        rawCanStep = rawCanStep,
        failureStage = failureStage,
        error = error,
    )

    private fun parseFailure(
        startedAt: Long,
        zone: ZoneId,
        settings: SettingsObservation,
        failureStage: String,
        error: Throwable,
        capability: RawProviderBundle? = null,
        rawCanStep: Int? = null,
        provider: RawProviderBundle? = null,
    ): PhoneTodayActivity = result(
        status = PhoneHealthStatus.ERROR,
        outcome = PhoneHealthOutcome.PARSE_FAILED,
        startedAt = startedAt,
        zone = zone,
        settings = settings,
        permissionGranted = true,
        capability = capability,
        provider = provider,
        rawCanStep = rawCanStep,
        failureStage = failureStage,
        error = error,
    )

    private fun result(
        status: PhoneHealthStatus,
        outcome: PhoneHealthOutcome,
        startedAt: Long,
        zone: ZoneId,
        settings: SettingsObservation,
        permissionGranted: Boolean,
        capability: RawProviderBundle? = null,
        provider: RawProviderBundle? = null,
        rawCanStep: Int? = null,
        failureStage: String? = null,
        error: Throwable? = null,
        steps: Int? = null,
        distanceMeters: Double? = null,
        caloriesKilocalories: Double? = null,
    ): PhoneTodayActivity {
        val receivedAt = now()
        val zonedSample = Instant.ofEpochMilli(receivedAt).atZone(zone)
        val retCodeBundle = provider?.takeIf { KEY_RET_CODE in it.values }
            ?: capability?.takeIf { KEY_RET_CODE in it.values }
        return PhoneTodayActivity(
            status = status,
            outcome = outcome,
            day = zonedSample.toLocalDate().toString(),
            timezone = zone.id,
            steps = steps,
            distanceMeters = distanceMeters,
            caloriesKilocalories = caloriesKilocalories,
            sampleEpochMs = receivedAt,
            sampledAt = zonedSample.toOffsetDateTime().toString(),
            diagnostics = PhoneHealthDiagnostics(
                permissionGranted = permissionGranted,
                capabilityBundleKeys = capability?.keys.orEmpty(),
                providerBundleKeys = provider?.keys.orEmpty(),
                rawCanStep = rawCanStep,
                rawRetCode = (retCodeBundle?.values?.get(KEY_RET_CODE) as? Number)?.toInt(),
                retCodeAvailable = retCodeBundle != null,
                settingsRealtimeStepsRaw = settings.rawValue,
                settingsExceptionType = settings.exceptionType,
                settingsExceptionMessage = settings.exceptionMessage,
                requestStartedEpochMs = startedAt,
                responseReceivedEpochMs = receivedAt,
                callDurationMs = max(0, receivedAt - startedAt),
                failureStage = failureStage,
                exceptionType = error?.javaClass?.name,
                exceptionMessage = error?.message?.take(MAX_DIAGNOSTIC_LENGTH),
            ),
        )
    }

    private data class SettingsObservation(
        val rawValue: String? = null,
        val exceptionType: String? = null,
        val exceptionMessage: String? = null,
    )

    private data class ParsedActivity(
        val steps: Int,
        val distanceMeters: Double,
        val caloriesKilocalories: Double,
    )

    private class ProviderValueParseException(message: String) : IllegalArgumentException(message)

    private fun RawProviderBundle.requiredInt(key: String): Int {
        if (key !in values) throw ProviderValueParseException("provider Bundle is missing $key")
        val value = values[key] as? Number
            ?: throw ProviderValueParseException("provider Bundle $key is not numeric")
        val asDouble = value.toDouble()
        if (!asDouble.isFinite() || asDouble % 1.0 != 0.0 || asDouble !in Int.MIN_VALUE.toDouble()..Int.MAX_VALUE.toDouble()) {
            throw ProviderValueParseException("provider Bundle $key is not an integer")
        }
        return asDouble.toInt()
    }

    private fun RawProviderBundle.requiredNonNegativeDouble(key: String): Double {
        if (key !in values) throw ProviderValueParseException("provider Bundle is missing $key")
        val value = (values[key] as? Number)?.toDouble()
            ?: throw ProviderValueParseException("provider Bundle $key is not numeric")
        if (!value.isFinite() || value < 0) {
            throw ProviderValueParseException("provider Bundle $key must be finite and non-negative")
        }
        return value
    }

    companion object {
        private const val KEY_CAN_STEP = "can_step"
        private const val KEY_STEP = "step"
        private const val KEY_DISTANCE = "distance"
        private const val KEY_CALORIE = "calorie"
        private const val KEY_RET_CODE = "ret_code"
        private const val MAX_DIAGNOSTIC_LENGTH = 2048
    }
}
