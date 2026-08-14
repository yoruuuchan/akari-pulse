package dev.akari.pulse.bridge.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.akari.pulse.bridge.data.HealthEventEntity
import dev.akari.pulse.bridge.diagnostics.AdapterDiagnostics
import dev.akari.pulse.bridge.diagnostics.TransportPhase
import dev.akari.pulse.bridge.phonehealth.PhoneHealthStatus
import dev.akari.pulse.bridge.phonehealth.VivoLatestVital
import dev.akari.pulse.bridge.phonehealth.VivoPrivateHealthCapability
import dev.akari.pulse.bridge.ui.theme.AkariError
import java.text.DateFormat
import java.util.Date

@Composable
fun AkariPulseScreen(
    viewModel: BridgeViewModel,
    onStartHttpReceiver: () -> Unit,
    onStopHttpReceiver: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    var settingsExpanded by rememberSaveable { mutableStateOf(false) }
    var logsExpanded by rememberSaveable { mutableStateOf(false) }
    var sessionId by rememberSaveable { mutableStateOf("") }
    var sessionLabel by rememberSaveable { mutableStateOf("") }

    val actualError = state.sync.lastError != null ||
        state.queue.lastError != null ||
        state.transport.officialRpc.phase == TransportPhase.ERROR ||
        state.transport.httpReceiver.phase == TransportPhase.ERROR ||
        state.phoneHealth?.status == PhoneHealthStatus.ERROR ||
        state.vivoPrivateHealth?.capability?.let { it != VivoPrivateHealthCapability.GRANTED } == true ||
        state.notice?.isError == true

    Surface(color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .safeDrawingPadding()
                .padding(horizontal = 16.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text("akari pulse", style = MaterialTheme.typography.headlineMedium)
                    Text(
                        "android bridge",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (actualError) {
                    Box(
                        Modifier
                            .size(10.dp)
                            .background(AkariError, CircleShape),
                    )
                }
            }

            state.notice?.let { notice ->
                NoticeCard(notice = notice, onDismiss = viewModel::clearNotice)
            }

            SectionCard(title = "official vivo rpc") {
                TransportSummary(state.transport.officialRpc)
                Spacer(Modifier.height(8.dp))
                Text(
                    if (state.rpcAppIdConfigured) "appid configured" else "API_MISSING · appid not configured",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    if (state.config.hasRpcEncryption) "encryStr stored securely" else "API_MISSING · encryStr not stored",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = viewModel::startOfficialRpc,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    ) { Text("start rpc") }
                    OutlinedButton(
                        onClick = viewModel::stopOfficialRpc,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    ) { Text("stop rpc") }
                }
                Spacer(Modifier.height(12.dp))
                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f))
                Spacer(Modifier.height(12.dp))
                Text("session notification", style = MaterialTheme.typography.titleMedium)
                Text(
                    "best-effort notify only; delivery does not confirm watch execution or create a backend session",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = sessionId,
                    onValueChange = { sessionId = it },
                    label = { Text("session id") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = sessionLabel,
                    onValueChange = { sessionLabel = it },
                    label = { Text("label (start only)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { viewModel.dispatchSessionStart(sessionId, sessionLabel) },
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    ) { Text("notify start") }
                    OutlinedButton(
                        onClick = { viewModel.dispatchSessionStop(sessionId) },
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    ) { Text("notify stop") }
                }
            }

            SectionCard(title = "phone health · vivo local") {
                val phoneHealth = state.phoneHealth
                if (phoneHealth == null) {
                    Text(
                        "not sampled · provider is authoritative; Settings is diagnostics only",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    MetricRow("status", "${phoneHealth.status} · ${phoneHealth.outcome}")
                    MetricRow("source", phoneHealth.source)
                    MetricRow("day", phoneHealth.day)
                    MetricRow("timezone", phoneHealth.timezone)
                    MetricRow("steps", phoneHealth.steps?.toString() ?: "not returned")
                    MetricRow(
                        "distance",
                        phoneHealth.distanceMeters?.let { "$it m" } ?: "not returned",
                    )
                    MetricRow(
                        "calories",
                        phoneHealth.caloriesKilocalories?.let { "$it kcal" } ?: "not returned",
                    )
                    MetricRow("sampled", formatTime(phoneHealth.sampleEpochMs))
                    Text(
                        "sample time is the bridge observation time; the provider exposes no source timestamp",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = viewModel::readPhoneHealth,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text("read today activity") }
            }

            SectionCard(title = "vivo private health · sleep + latest vitals") {
                val privateHealth = state.vivoPrivateHealth
                if (privateHealth == null) {
                    Text(
                        "not sampled · requires a one-time owner ADB grant of " +
                            "com.vivo.health.widget.permission",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    MetricRow("capability", privateHealth.capability.name)
                    if (privateHealth.capability != VivoPrivateHealthCapability.GRANTED) {
                        Text(
                            when (privateHealth.capability) {
                                VivoPrivateHealthCapability.NOT_GRANTED ->
                                    "run scripts/bootstrap-vivo-private-health.ps1 from the PC; " +
                                        "reinstalling this app clears the grant"
                                VivoPrivateHealthCapability.UNSUPPORTED ->
                                    "the vivo private health providers are absent on this device"
                                else -> "the capability probe failed"
                            },
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    } else {
                        val sleep = privateHealth.sleep
                        MetricRow("sleep", "${sleep.status} · ${sleep.outcome}")
                        if (sleep.status == PhoneHealthStatus.PASS) {
                            MetricRow("sleep day", sleep.sourceDay ?: "not returned")
                            MetricRow(
                                "asleep → awake",
                                "${formatClock(sleep.sleepStartEpochMs)} → ${formatClock(sleep.sleepEndEpochMs)}",
                            )
                            MetricRow("total", formatDuration(sleep.totalDurationMs))
                            MetricRow(
                                "deep / light / rem",
                                "${formatDuration(sleep.deepSleepDurationMs)} · " +
                                    "${formatDuration(sleep.lightSleepDurationMs)} · " +
                                    formatDuration(sleep.remSleepDurationMs),
                            )
                            MetricRow(
                                "wake-ups",
                                sleep.awakeEpisodeCount?.let {
                                    "$it · ${formatDuration(sleep.awakeEpisodeDurationMs)}"
                                } ?: "not returned",
                            )
                            MetricRow("score", sleep.score?.toString() ?: "not returned")
                            MetricRow(
                                "deep continuity",
                                sleep.deepSleepContinuity?.toString() ?: "not returned",
                            )
                        }
                        HorizontalDivider(
                            modifier = Modifier.padding(vertical = 8.dp),
                            color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                        )
                        MetricRow("vitals", "${privateHealth.vitals.status} · ${privateHealth.vitals.outcome}")
                        VitalRow("heart rate", privateHealth.vitals.heartRate)
                        VitalRow("spo2", privateHealth.vitals.spo2)
                        VitalRow("stress", privateHealth.vitals.stress)
                        Text(
                            "latest single points only · no daily min/max/avg and no resting heart " +
                                "rate exist on this provider",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    MetricRow("read at", formatTime(privateHealth.readAtEpochMs))
                }
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = viewModel::readVivoPrivateHealth,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text("read sleep and vitals") }
            }

            SectionCard(title = "http receiver · fallback probe") {
                TransportSummary(state.transport.httpReceiver)
                Spacer(Modifier.height(8.dp))
                Text(
                    "${state.config.receiverBindAddress}:${state.config.receiverPort}/v1/health/batches",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    if (state.config.hasReceiverToken) {
                        "X-Akari-Bridge-Token stored"
                    } else {
                        "token absent · only tokenless loopback is allowed and shown as insecure local probe"
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = onStartHttpReceiver,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    ) { Text("start receiver") }
                    OutlinedButton(
                        onClick = onStopHttpReceiver,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    ) { Text("stop receiver") }
                }
            }

            SectionCard(title = "local queue and uplink") {
                MetricRow("pending", state.queue.pendingCount.toString())
                MetricRow("synced", state.queue.syncedCount.toString())
                MetricRow("total", state.queue.totalCount.toString())
                MetricRow("active sessions", state.sync.activeSessionCount?.toString() ?: "not checked")
                MetricRow("last receive", formatTime(state.queue.lastReceivedAt))
                MetricRow("last sync", formatTime(state.sync.lastSuccessAt))
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = viewModel::syncNow,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    ) { Text("sync now") }
                    OutlinedButton(
                        onClick = viewModel::refreshActiveSessions,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    ) { Text("check sessions") }
                }
                state.sync.lastError?.let { error ->
                    Spacer(Modifier.height(8.dp))
                    Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }

            ExpandableCard(
                title = "settings",
                expanded = settingsExpanded,
                onToggle = { settingsExpanded = !settingsExpanded },
            ) {
                SettingsForm(state, viewModel)
            }

            ExpandableCard(
                title = "event logs · ${state.recentEvents.size}",
                expanded = logsExpanded,
                onToggle = { logsExpanded = !logsExpanded },
            ) {
                if (state.recentEvents.isEmpty()) {
                    Text(
                        "no persisted events",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    state.recentEvents.forEachIndexed { index, event ->
                        if (index > 0) {
                            HorizontalDivider(
                                modifier = Modifier.padding(vertical = 10.dp),
                                color = MaterialTheme.colorScheme.outline.copy(alpha = 0.2f),
                            )
                        }
                        EventLog(event)
                    }
                }
            }

            Text(
                "device-rpc 1.0.0.17 · WA2456C transport support requires real-device verification",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun SettingsForm(state: BridgeUiState, viewModel: BridgeViewModel) {
    var serverUrl by rememberSaveable(state.config.serverBaseUrl) { mutableStateOf(state.config.serverBaseUrl) }
    var allowHttp by rememberSaveable(state.config.allowTailnetHttp) {
        mutableStateOf(state.config.allowTailnetHttp)
    }
    var bindAddress by rememberSaveable(state.config.receiverBindAddress) {
        mutableStateOf(state.config.receiverBindAddress)
    }
    var receiverPort by rememberSaveable(state.config.receiverPort) {
        mutableStateOf(state.config.receiverPort.toString())
    }
    var serverToken by rememberSaveable { mutableStateOf("") }
    var receiverToken by rememberSaveable { mutableStateOf("") }
    var rpcEncryption by rememberSaveable { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = serverUrl,
            onValueChange = { serverUrl = it },
            label = { Text("server base url") },
            placeholder = { Text("https://akari-health.example.ts.net") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = allowHttp, onCheckedChange = { allowHttp = it })
            Text("allow explicit tailnet http in debug builds")
        }
        OutlinedTextField(
            value = bindAddress,
            onValueChange = { bindAddress = it },
            label = { Text("receiver bind address") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = receiverPort,
            onValueChange = { receiverPort = it },
            label = { Text("receiver port") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "official rpc target com.vivo.health",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
        SecretField("server bearer token", state.config.hasServerToken, serverToken) { serverToken = it }
        SecretField("bridge token", state.config.hasReceiverToken, receiverToken) { receiverToken = it }
        SecretField("rpc encryStr", state.config.hasRpcEncryption, rpcEncryption) { rpcEncryption = it }
        Text(
            "secret fields are encrypted with Android Keystore; blank fields keep the stored value",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
        Button(
            onClick = {
                viewModel.saveSettings(
                    serverBaseUrl = serverUrl,
                    allowTailnetHttp = allowHttp,
                    receiverBindAddress = bindAddress,
                    receiverPort = receiverPort,
                    serverToken = serverToken,
                    receiverToken = receiverToken,
                    rpcEncryption = rpcEncryption,
                )
                serverToken = ""
                receiverToken = ""
                rpcEncryption = ""
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text("save settings") }
    }
}

@Composable
private fun SecretField(label: String, stored: Boolean, value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = { Text(if (stored) "stored · blank keeps" else "not stored") },
        visualTransformation = PasswordVisualTransformation(),
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
        shape = MaterialTheme.shapes.large,
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

@Composable
private fun ExpandableCard(
    title: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    content: @Composable () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
        shape = MaterialTheme.shapes.large,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggle)
                .heightIn(min = 48.dp)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(if (expanded) "hide" else "show", color = MaterialTheme.colorScheme.primary)
        }
        if (expanded) {
            Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp)) { content() }
        }
    }
}

@Composable
private fun NoticeCard(notice: UiNotice, onDismiss: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (notice.isError) {
                MaterialTheme.colorScheme.errorContainer
            } else {
                MaterialTheme.colorScheme.primaryContainer
            },
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(notice.text, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 44.dp)) { Text("dismiss") }
        }
    }
}

@Composable
private fun TransportSummary(adapter: AdapterDiagnostics) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusPill(adapter.phase)
        adapter.port?.let { port -> Text("port $port", color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
    adapter.detail?.let { detail ->
        Spacer(Modifier.height(6.dp))
        Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
    }
    adapter.lastError?.let { error ->
        Spacer(Modifier.height(6.dp))
        Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }
    if (adapter.acceptedEvents > 0 || adapter.duplicateEvents > 0) {
        Spacer(Modifier.height(6.dp))
        Text(
            "accepted ${adapter.acceptedEvents} · duplicates ${adapter.duplicateEvents}",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun StatusPill(phase: TransportPhase) {
    val color = when (phase) {
        TransportPhase.LISTENING -> MaterialTheme.colorScheme.primaryContainer
        TransportPhase.ERROR -> MaterialTheme.colorScheme.errorContainer
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    Surface(color = color, shape = MaterialTheme.shapes.small) {
        Text(
            phase.name.lowercase().replace('_', ' '),
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            style = MaterialTheme.typography.labelLarge,
        )
    }
}

@Composable
private fun MetricRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun EventLog(event: HealthEventEntity) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(event.metric, fontWeight = FontWeight.Medium)
        Text(event.status.lowercase(), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Text(
        event.eventId,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        style = MaterialTheme.typography.bodyMedium,
    )
    Text(
        "timestamp ${event.timestamp} · ${formatTime(event.receivedAt)}",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium,
    )
    if (event.hasValue) {
        Text("value ${event.valueJson}", style = MaterialTheme.typography.bodyMedium)
    }
    event.quality?.let { Text("quality $it", style = MaterialTheme.typography.bodyMedium) }
    event.sessionId?.let { Text("session $it", style = MaterialTheme.typography.bodyMedium) }
    event.rawErrorCodeJson?.let { Text("raw code $it", color = MaterialTheme.colorScheme.error) }
    event.rawErrorMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }
}

@Composable
private fun VitalRow(label: String, vital: VivoLatestVital) {
    MetricRow(
        label,
        if (vital.status == PhoneHealthStatus.PASS) {
            "${vital.value} ${vital.unit} · ${formatClock(vital.sourceEpochMs)}"
        } else {
            vital.status.name
        },
    )
}

private fun formatTime(value: Long?): String = value?.let {
    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM).format(Date(it))
} ?: "never"

private fun formatClock(value: Long?): String = value?.let {
    DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it))
} ?: "not returned"

private fun formatDuration(milliseconds: Long?): String = milliseconds?.let {
    val minutes = it / 60_000
    "${minutes / 60}h${minutes % 60}m"
} ?: "not returned"
