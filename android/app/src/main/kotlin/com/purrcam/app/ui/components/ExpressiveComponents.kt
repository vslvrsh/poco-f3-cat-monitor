package com.purrcam.app.ui.components

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material.icons.rounded.WifiFind
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.purrcam.app.protocol.LensInfo
import com.purrcam.app.protocol.PairingLinkParser
import com.purrcam.app.protocol.ParsedPairingLink
import com.purrcam.app.protocol.PurrJson
import com.purrcam.app.protocol.ServerInfoDto
import com.purrcam.app.protocol.ServerUrlHelper
import com.purrcam.app.ui.theme.PurrStatusColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Floating M3 Expressive Lens Selector Pill Group (e.g. `0.6×`, `1×`, `Macro`, `Front`).
 * Uses spring-animated shape morphing and tonal highlight on the active lens.
 */
@Composable
fun ExpressiveLensDock(
    lenses: List<LensInfo>,
    activeLensId: String,
    onSelectLens: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    if (lenses.isEmpty()) return
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.86f),
        shape = RoundedCornerShape(999.dp),
        tonalElevation = 4.dp,
        modifier = modifier
    ) {
        Row(
            modifier = Modifier
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 6.dp, vertical = 5.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            lenses.forEach { lens ->
                val active = lens.id == activeLensId
                val cornerRadius by animateDpAsState(
                    targetValue = if (active) 12.dp else 22.dp,
                    animationSpec = spring(
                        dampingRatio = Spring.DampingRatioMediumBouncy,
                        stiffness = Spring.StiffnessMediumLow
                    ),
                    label = "lensCorner"
                )
                val safeCorner = cornerRadius.coerceIn(4.dp, 32.dp)
                val bg by animateColorAsState(
                    targetValue = if (active) MaterialTheme.colorScheme.primaryContainer
                    else Color.Transparent,
                    label = "lensBg"
                )
                val fg by animateColorAsState(
                    targetValue = if (active) MaterialTheme.colorScheme.onPrimaryContainer
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                    label = "lensFg"
                )

                Surface(
                    color = bg,
                    shape = RoundedCornerShape(safeCorner),
                    modifier = Modifier
                        .clip(RoundedCornerShape(safeCorner))
                        .clickable { onSelectLens(lens.id) }
                ) {
                    Text(
                        text = lens.shortPillLabel(),
                        color = fg,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = if (active) FontWeight.Bold else FontWeight.Medium,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)
                    )
                }
            }
        }
    }
}

/**
 * M3 Expressive Segmented Pill Selector for compact options (e.g. 480p / 720p / 1080p).
 */
@Composable
fun ExpressiveSegmentedPills(
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        shape = RoundedCornerShape(999.dp),
        modifier = modifier
    ) {
        Row(
            modifier = Modifier.padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            options.forEach { option ->
                val isSelected = option == selected
                val bg by animateColorAsState(
                    targetValue = if (isSelected) MaterialTheme.colorScheme.primaryContainer
                    else Color.Transparent,
                    label = "segBg"
                )
                val fg by animateColorAsState(
                    targetValue = if (isSelected) MaterialTheme.colorScheme.onPrimaryContainer
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                    label = "segFg"
                )
                Surface(
                    color = bg,
                    shape = RoundedCornerShape(999.dp),
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(999.dp))
                        .clickable { onSelect(option) }
                ) {
                    Box(
                        modifier = Modifier.padding(vertical = 10.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = option,
                            color = fg,
                            style = MaterialTheme.typography.labelLarge
                        )
                    }
                }
            }
        }
    }
}

/**
 * Spacious M3 Expressive Metric Card (28.dp corners, tonal surfaceContainerLow, zero noisy outlines).
 */
@Composable
fun HealthMetricCard(
    title: String,
    value: String,
    subtitle: String,
    icon: ImageVector,
    accentColor: Color = MaterialTheme.colorScheme.primary,
    modifier: Modifier = Modifier
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(28.dp),
        modifier = modifier
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(accentColor.copy(alpha = 0.16f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = icon,
                        contentDescription = null,
                        tint = accentColor,
                        modifier = Modifier.size(18.dp)
                    )
                }
                Text(
                    text = title,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Text(
                text = value,
                style = MaterialTheme.typography.headlineMedium.copy(
                    fontFeatureSettings = "tnum"
                ),
                color = MaterialTheme.colorScheme.onSurface
            )
            if (subtitle.isNotBlank()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2
                )
            }
        }
    }
}

/**
 * Clean M3 Expressive ModalBottomSheet for Server Connection & `purrcam://connect?...` Pairing Link import.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectServerBottomSheet(
    initialLocalUrl: String,
    initialRemoteUrl: String,
    initialToken: String,
    onDismiss: () -> Unit,
    onSave: (localUrl: String, remoteUrl: String, token: String) -> Unit
) {
    val context = LocalContext.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()

    var localUrl by remember { mutableStateOf(initialLocalUrl) }
    var remoteUrl by remember { mutableStateOf(initialRemoteUrl) }
    var token by remember { mutableStateOf(initialToken) }
    var pasteNotice by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<Pair<Boolean, String>?>(null) }

    val testClient = remember {
        OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(4, TimeUnit.SECONDS)
            .build()
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Server & Remote Access",
                    style = MaterialTheme.typography.headlineSmall,
                    color = MaterialTheme.colorScheme.onSurface
                )
                FilledTonalButton(
                    onClick = {
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                        val clip = cm?.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()?.trim().orEmpty()
                        val parsed = PairingLinkParser.parse(clip)
                        if (parsed != null) {
                            parsed.localUrl?.let { localUrl = it }
                            parsed.remoteUrl?.let { remoteUrl = it }
                            parsed.token?.let { token = it }
                            pasteNotice = "Imported pairing link from clipboard"
                            testResult = null
                        } else {
                            pasteNotice = "No PurrCam link found in clipboard"
                        }
                    },
                    shape = RoundedCornerShape(999.dp)
                ) {
                    Icon(Icons.Rounded.ContentPaste, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Paste Link")
                }
            }

            pasteNotice?.let { note ->
                Surface(
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    shape = RoundedCornerShape(14.dp)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Icon(
                            Icons.Rounded.Link,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSecondaryContainer,
                            modifier = Modifier.size(16.dp)
                        )
                        Text(
                            text = note,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSecondaryContainer
                        )
                    }
                }
            }

            OutlinedTextField(
                value = localUrl,
                onValueChange = {
                    localUrl = it
                    testResult = null
                },
                label = { Text("Local Wi-Fi / USB Server") },
                placeholder = { Text("ws://192.168.1.100:8787/ws") },
                leadingIcon = { Icon(Icons.Rounded.Wifi, contentDescription = null) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth()
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                QuickAddressChip(
                    label = "USB (127.0.0.1)",
                    selected = localUrl.contains("127.0.0.1"),
                    onClick = { localUrl = ServerUrlHelper.DEFAULT_LOCAL_URL }
                )
                QuickAddressChip(
                    label = "LAN (192.168.1.100)",
                    selected = localUrl.contains("192.168.1.100"),
                    onClick = { localUrl = ServerUrlHelper.DEFAULT_LAN_URL }
                )
            }

            OutlinedTextField(
                value = remoteUrl,
                onValueChange = {
                    remoteUrl = it
                    testResult = null
                },
                label = { Text("Remote Tunnel URL (4G/5G)") },
                placeholder = { Text("https://example.trycloudflare.com") },
                leadingIcon = { Icon(Icons.Rounded.Public, contentDescription = null) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("Access Token (required for Remote)") },
                placeholder = { Text("Paste token from PC Connect tab") },
                leadingIcon = { Icon(Icons.Rounded.Key, contentDescription = null) },
                singleLine = true,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth()
            )

            testResult?.let { (ok, msg) ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(
                        imageVector = if (ok) Icons.Rounded.CheckCircle else Icons.Rounded.ErrorOutline,
                        contentDescription = null,
                        tint = if (ok) PurrStatusColors.Live else PurrStatusColors.Danger,
                        modifier = Modifier.size(18.dp)
                    )
                    Text(
                        text = msg,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (ok) PurrStatusColors.Live else PurrStatusColors.Danger
                    )
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                OutlinedButton(
                    onClick = {
                        testing = true
                        testResult = null
                        scope.launch {
                            val res = probeServerEndpoints(testClient, localUrl, remoteUrl, token)
                            testing = false
                            testResult = res
                        }
                    },
                    enabled = !testing,
                    shape = RoundedCornerShape(999.dp),
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp)
                ) {
                    if (testing) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Rounded.WifiFind, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Test")
                    }
                }

                Button(
                    onClick = {
                        onSave(localUrl.trim(), remoteUrl.trim(), token.trim())
                        onDismiss()
                    },
                    shape = RoundedCornerShape(999.dp),
                    modifier = Modifier
                        .weight(1.4f)
                        .height(48.dp)
                ) {
                    Text("Save & Apply")
                }
            }
        }
    }
}

@Composable
private fun QuickAddressChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer
        else MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(999.dp),
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .clickable(onClick = onClick)
    ) {
        Text(
            text = label,
            color = if (selected) MaterialTheme.colorScheme.onSecondaryContainer
            else MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)
        )
    }
}

suspend fun probeServerEndpoints(
    client: OkHttpClient,
    localUrl: String,
    remoteUrl: String,
    token: String
): Pair<Boolean, String> = withContext(Dispatchers.IO) {
    val candidates = buildList {
        if (localUrl.isNotBlank()) add("Local" to ServerUrlHelper.parse(localUrl))
        if (remoteUrl.isNotBlank()) add("Remote" to ServerUrlHelper.parse(remoteUrl))
    }
    if (candidates.isEmpty()) return@withContext false to "Enter a server address"

    var lastErr = "No response"
    for ((label, ep) in candidates) {
        try {
            val reqBuilder = Request.Builder().url("${ep.httpBaseUrl}/api/info")
            val tok = token.ifBlank { ep.tokenFromUrl.orEmpty() }
            if (tok.isNotBlank()) reqBuilder.header("Authorization", "Bearer $tok")
            client.newCall(reqBuilder.build()).execute().use { resp ->
                if (resp.isSuccessful) {
                    val info = PurrJson.decodeFromString<ServerInfoDto>(resp.body?.string().orEmpty())
                    val cam = if (info.cameraOnline) "camera online" else "camera offline"
                    return@withContext true to "$label OK · $cam (${info.viewerCount} viewers)"
                } else if (resp.code == 401) {
                    lastErr = "$label requires valid access token (HTTP 401)"
                } else {
                    lastErr = "$label HTTP ${resp.code}"
                }
            }
        } catch (e: Exception) {
            lastErr = "$label unreachable: ${e.message ?: "timeout"}"
        }
    }
    false to lastErr
}

fun formatDurationShort(sec: Long): String {
    val h = sec / 3600
    val m = (sec % 3600) / 60
    val s = sec % 60
    return if (h > 0) String.format(java.util.Locale.US, "%dh %02dm", h, m)
    else String.format(java.util.Locale.US, "%02d:%02d", m, s)
}

/**
 * Security confirmation dialog shown whenever an external `purrcam://connect?...` deep link
 * opens PurrCam. Prevents untrusted links from silently overwriting server URLs or tokens.
 */
@Composable
fun PairingConfirmationDialog(
    link: ParsedPairingLink,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = RoundedCornerShape(28.dp),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        icon = {
            Icon(
                imageVector = Icons.Rounded.Link,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary
            )
        },
        title = {
            Text(
                text = "Apply Pairing Link?",
                style = MaterialTheme.typography.headlineSmall
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = "Only apply links generated by your own PurrCam PC server.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                    shape = RoundedCornerShape(18.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier.padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        link.localUrl?.let { local ->
                            Text(
                                text = "Local: $local",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                        }
                        link.remoteUrl?.let { remote ->
                            Text(
                                text = "Remote: $remote",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                        }
                        if (!link.token.isNullOrBlank()) {
                            Text(
                                text = "Token: ${PairingLinkParser.maskToken(link.token)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                shape = RoundedCornerShape(999.dp)
            ) {
                Text("Apply")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}
