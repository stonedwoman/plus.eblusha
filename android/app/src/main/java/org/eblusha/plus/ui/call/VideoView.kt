package org.eblusha.plus.ui.call

import android.view.ViewGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.render.VideoRenderer
import android.widget.FrameLayout

@Composable
fun LiveKitVideoView(
    track: VideoTrack?,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    
    AndroidView(
        factory = { ctx ->
            VideoRenderer(ctx).apply {
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            }
        },
        modifier = modifier,
        update = { view ->
            track?.let {
                view.setTrack(it)
            } ?: run {
                view.setTrack(null)
            }
        }
    )
    
    DisposableEffect(track) {
        onDispose {
            // Track cleanup is handled by LiveKit
        }
    }
}

