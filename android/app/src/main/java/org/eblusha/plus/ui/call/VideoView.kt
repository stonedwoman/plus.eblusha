package org.eblusha.plus.ui.call

import android.graphics.Color
import android.view.ViewGroup
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.EglBase
import livekit.org.webrtc.RendererCommon
import livekit.org.webrtc.SurfaceViewRenderer

@Composable
fun LiveKitVideoView(
    track: VideoTrack?,
    modifier: Modifier = Modifier,
    mirror: Boolean = false,
) {
    val context = LocalContext.current
    val eglBase = remember { EglBase.create() }
    val rendererRef = remember { mutableStateOf<SurfaceViewRenderer?>(null) }

    AndroidView(
        factory = { ctx ->
            SurfaceViewRenderer(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                init(eglBase.eglBaseContext, null)
                setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
                setEnableHardwareScaler(true)
                setZOrderMediaOverlay(true)
                setBackgroundColor(Color.TRANSPARENT)
                rendererRef.value = this
                tag = VideoRendererHolder(eglBase = eglBase, currentTrack = null)
            }
        },
        modifier = modifier,
        update = { view ->
            view.setMirror(mirror)
            val holder = view.tag as? VideoRendererHolder
            val previousTrack = holder?.currentTrack
            if (previousTrack != track) {
                previousTrack?.removeRenderer(view)
                track?.addRenderer(view)
                holder?.currentTrack = track
            }
        }
    )

    DisposableEffect(Unit) {
        onDispose {
            rendererRef.value?.let { renderer ->
                val holder = renderer.tag as? VideoRendererHolder
                holder?.currentTrack?.removeRenderer(renderer)
                holder?.currentTrack = null
                holder?.eglBase?.release()
                renderer.release()
            }
            rendererRef.value = null
        }
    }
}

private data class VideoRendererHolder(
    val eglBase: EglBase,
    var currentTrack: VideoTrack?
)

