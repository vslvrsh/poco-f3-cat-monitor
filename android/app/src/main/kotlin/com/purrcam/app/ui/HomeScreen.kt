package com.purrcam.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Monitor
import androidx.compose.material.icons.rounded.Pets
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.purrcam.app.protocol.ServerUrlHelper
import com.purrcam.app.ui.components.ConnectServerBottomSheet

@Composable
fun HomeScreen(
    localServerUrl: String,
    remoteServerUrl: String,
    authToken: String,
    initialAutoStart: Boolean,
    savedMode: String,
    pairingBanner: String?,
    onSaveConnection: (localUrl: String, remoteUrl: String, token: String) -> Unit,
    onLaunchCamera: (autoStart: Boolean) -> Unit,
    onLaunchMonitor: (autoStart: Boolean) -> Unit
) {
    var autoStart by remember(initialAutoStart) { mutableStateOf(initialAutoStart) }
    var showConnectSheet by remember { mutableStateOf(false) }

    val hasRemote = remoteServerUrl.isNotBlank()
    val summaryHost = remember(localServerUrl, remoteServerUrl) {
        val localHost = ServerUrlHelper.parse(localServerUrl).wsUrl
            .removePrefix("ws://").removePrefix("wss://").removeSuffix("/ws")
        if (hasRemote) "$localHost + Remote" else localHost
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .statusBarsPadding()
            .navigationBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp)
    ) {
        // Minimal Expressive Brand Header
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(54.dp)
                        .clip(RoundedCornerShape(20.dp))
                        .background(MaterialTheme.colorScheme.primaryContainer),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = Icons.Rounded.Pets,
                        contentDescription = "PurrCam",
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.size(30.dp)
                    )
                }
                Column {
                    Text(
                        text = "PurrCam",
                        style = MaterialTheme.typography.displaySmall,
                        color = MaterialTheme.colorScheme.onBackground
                    )
                    Text(
                        text = "Self-hosted pet monitor",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        // Compact Tappable Connection Status Chip
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            shape = RoundedCornerShape(999.dp),
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(999.dp))
                .clickable { showConnectSheet = true }
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(
                        imageVector = if (hasRemote) Icons.Rounded.Public else Icons.Rounded.Wifi,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(18.dp)
                    )
                    Text(
                        text = summaryHost,
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Text(
                    text = "Edit",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(start = 12.dp)
                )
            }
        }

        pairingBanner?.let { msg ->
            Surface(
                color = MaterialTheme.colorScheme.secondaryContainer,
                shape = RoundedCornerShape(20.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = msg,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
                )
            }
        }

        Spacer(Modifier.height(2.dp))

        // Two Large Tactile Mode Cards
        ModeLaunchCard(
            title = "Camera Mode",
            subtitle = "Stream live Camera2 video from this phone with 0.6× Wide lens, AMOLED blackout, and 24/7 battery guard.",
            badge = if (savedMode == "camera") "Last used" else "Camera node",
            icon = Icons.Rounded.Videocam,
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            badgeContainer = MaterialTheme.colorScheme.primaryContainer,
            badgeContent = MaterialTheme.colorScheme.onPrimaryContainer,
            onClick = { onLaunchCamera(autoStart) }
        )

        ModeLaunchCard(
            title = "Monitor Mode",
            subtitle = "Watch live video over Wi-Fi or 4G/5G, switch lenses remotely, talk to your cat, and browse snapshots.",
            badge = if (savedMode == "monitor") "Last used" else "Remote viewer",
            icon = Icons.Rounded.Monitor,
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            badgeContainer = MaterialTheme.colorScheme.secondaryContainer,
            badgeContent = MaterialTheme.colorScheme.onSecondaryContainer,
            onClick = { onLaunchMonitor(autoStart) }
        )

        // Clean Footer Actions: Connect / Paste Link + Auto-start
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Auto-start last mode",
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                        Text(
                            text = "Jump straight into Camera or Monitor on launch",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Switch(
                        checked = autoStart,
                        onCheckedChange = { autoStart = it }
                    )
                }

                FilledTonalButton(
                    onClick = { showConnectSheet = true },
                    shape = RoundedCornerShape(999.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(50.dp)
                ) {
                    Icon(Icons.Rounded.Link, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Connect / Paste Pairing Link", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }

    if (showConnectSheet) {
        ConnectServerBottomSheet(
            initialLocalUrl = localServerUrl,
            initialRemoteUrl = remoteServerUrl,
            initialToken = authToken,
            onDismiss = { showConnectSheet = false },
            onSave = { local, remote, tok ->
                onSaveConnection(local, remote, tok)
            }
        )
    }
}

@Composable
private fun ModeLaunchCard(
    title: String,
    subtitle: String,
    badge: String,
    icon: ImageVector,
    containerColor: Color,
    badgeContainer: Color,
    badgeContent: Color,
    onClick: () -> Unit
) {
    Surface(
        color = containerColor,
        shape = RoundedCornerShape(28.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(28.dp))
            .clickable(onClick = onClick)
    ) {
        Column(
            modifier = Modifier.padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(48.dp)
                        .clip(RoundedCornerShape(18.dp))
                        .background(badgeContainer),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = icon,
                        contentDescription = null,
                        tint = badgeContent,
                        modifier = Modifier.size(26.dp)
                    )
                }
                Surface(
                    color = badgeContainer,
                    shape = RoundedCornerShape(999.dp)
                ) {
                    Text(
                        text = badge,
                        color = badgeContent,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)
                    )
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.headlineSmall,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Text(
                    text = "Launch",
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )
                Box(
                    modifier = Modifier
                        .size(24.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primaryContainer),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Rounded.ArrowForward,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.size(14.dp)
                    )
                }
            }
        }
    }
}
