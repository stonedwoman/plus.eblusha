package org.eblusha.plus.ui.call

import android.view.ViewGroup
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.video.VideoView

@Composable
fun LiveKitVideoView(
    track: VideoTrack?,
    modifier: Modifier = Modifier,
    mirror: Boolean = false,
) {
    val viewRef = remember { mutableStateOf<VideoView?>(null) }

    AndroidView(
        factory = { context ->
            VideoView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                setEnableHardwareScaler(true)
                setMirror(mirror)
                viewRef.value = this
            }
        },
        modifier = modifier,
        update = { view ->
            view.setMirror(mirror)
            view.setVideoTrack(track)
        }
    )

    DisposableEffect(Unit) {
        onDispose {
            viewRef.value?.setVideoTrack(null)
            viewRef.value?.release()
            viewRef.value = null
        }
    }
}

