package dev.akari.pulse.bridge.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import dev.akari.pulse.bridge.AkariPulseApplication
import dev.akari.pulse.bridge.transport.http.WatchReceiverService
import dev.akari.pulse.bridge.ui.theme.AkariPulseTheme

class MainActivity : ComponentActivity() {
    private val bridgeViewModel: BridgeViewModel by viewModels {
        val runtime = (application as AkariPulseApplication).runtime
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                BridgeViewModel(application, runtime) as T
        }
    }

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        WatchReceiverService.start(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AkariPulseTheme {
                AkariPulseScreen(
                    viewModel = bridgeViewModel,
                    onStartHttpReceiver = ::startHttpReceiver,
                    onStopHttpReceiver = { WatchReceiverService.stop(this) },
                )
            }
        }
    }

    private fun startHttpReceiver() {
        if (
            Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            WatchReceiverService.start(this)
        }
    }
}
