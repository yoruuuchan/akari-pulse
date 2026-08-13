package dev.akari.pulse.bridge

import android.app.Application
import dev.akari.pulse.bridge.data.AkariDatabase
import dev.akari.pulse.bridge.data.BridgeRepository
import dev.akari.pulse.bridge.diagnostics.DiagnosticsStore
import dev.akari.pulse.bridge.network.AkariHealthClient
import dev.akari.pulse.bridge.phonehealth.PhoneHealthController
import dev.akari.pulse.bridge.phonehealth.VivoTodayActivityReader
import dev.akari.pulse.bridge.settings.BridgePreferences
import dev.akari.pulse.bridge.sync.SyncScheduler
import dev.akari.pulse.bridge.transport.rpc.OfficialRpcReceiverAdapter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class AkariPulseApplication : Application() {
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    lateinit var runtime: BridgeRuntime
        private set

    override fun onCreate() {
        super.onCreate()
        val preferences = BridgePreferences(this)
        val diagnostics = DiagnosticsStore(this)
        val database = AkariDatabase.create(this)
        val client = AkariHealthClient(preferences)
        val repository = BridgeRepository(database, client, diagnostics)
        val phoneHealth = PhoneHealthController(VivoTodayActivityReader(this))
        val officialRpc = OfficialRpcReceiverAdapter(
            context = this,
            preferences = preferences,
            repository = repository,
            diagnostics = diagnostics,
        )
        runtime = BridgeRuntime(
            preferences = preferences,
            diagnostics = diagnostics,
            database = database,
            repository = repository,
            officialRpc = officialRpc,
            phoneHealth = phoneHealth,
        )
        SyncScheduler.ensurePeriodic(this)
        if (BuildConfig.VIVO_RPC_APP_ID > 0 && preferences.summary.value.hasRpcEncryption) {
            applicationScope.launch { officialRpc.start() }
        }
    }
}

data class BridgeRuntime(
    val preferences: BridgePreferences,
    val diagnostics: DiagnosticsStore,
    val database: AkariDatabase,
    val repository: BridgeRepository,
    val officialRpc: OfficialRpcReceiverAdapter,
    val phoneHealth: PhoneHealthController,
)
