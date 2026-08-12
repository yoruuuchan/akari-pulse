package dev.akari.pulse.bridge.transport.http

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import dev.akari.pulse.bridge.AkariPulseApplication
import dev.akari.pulse.bridge.diagnostics.TransportKind
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

class WatchReceiverService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var adapter: HttpWatchReceiverAdapter? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(NOTIFICATION_ID, notification("starting http receiver"))
        if (adapter == null) {
            scope.launch {
                val application = application as AkariPulseApplication
                val config = try {
                    application.runtime.preferences.load()
                } catch (error: Exception) {
                    application.runtime.diagnostics.transportFailed(
                        TransportKind.HTTP_RECEIVER,
                        "http receiver configuration could not be loaded: ${error.message}",
                    )
                    stopSelf()
                    return@launch
                }
                val candidate = HttpWatchReceiverAdapter(
                    applicationContext = applicationContext,
                    bindAddress = config.receiverBindAddress,
                    port = config.receiverPort,
                    bridgeToken = config.receiverToken,
                    repository = application.runtime.repository,
                    diagnostics = application.runtime.diagnostics,
                    scope = scope,
                )
                adapter = candidate
                when (candidate.start()) {
                    is dev.akari.pulse.bridge.transport.AdapterStartResult.Running -> {
                        val manager = getSystemService(NotificationManager::class.java)
                        manager.notify(
                            NOTIFICATION_ID,
                            notification("${config.receiverBindAddress}:${config.receiverPort}"),
                        )
                    }
                    else -> stopSelf()
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        val current = adapter
        adapter = null
        if (current != null) runBlocking { current.stop() }
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "akari pulse watch receiver",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps the explicitly enabled watch HTTP receiver active"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun notification(detail: String): Notification {
        val stopIntent = Intent(this, WatchReceiverService::class.java).setAction(ACTION_STOP)
        val stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("akari pulse bridge")
            .setContentText(detail)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, "stop receiver", stopPendingIntent)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "akari-watch-receiver"
        private const val NOTIFICATION_ID = 2301
        private const val ACTION_START = "dev.akari.pulse.bridge.action.START_HTTP_RECEIVER"
        private const val ACTION_STOP = "dev.akari.pulse.bridge.action.STOP_HTTP_RECEIVER"

        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, WatchReceiverService::class.java).setAction(ACTION_START),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, WatchReceiverService::class.java))
        }
    }
}
