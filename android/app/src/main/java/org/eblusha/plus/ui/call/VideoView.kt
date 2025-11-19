package org.eblusha.plus.ui.call

import android.graphics.Color
import android.view.ViewGroup
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
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
    val eglBase = remember { EglBase.create() }
    val rendererRef = remember { mutableStateOf<SurfaceViewRenderer?>(null) }

    AndroidView(
        factory = { context ->
            SurfaceViewRenderer(context).apply {
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
            }
        },
        modifier = modifier,
        update = { view ->
            view.setMirror(mirror)
            val previousTrack = view.tag as? VideoTrack
            if (previousTrack != track) {
                previousTrack?.removeRenderer(view)
                track?.addRenderer(view)
                view.tag = track
            }
        }
    )

    DisposableEffect(track) {
        onDispose {
            rendererRef.value?.let { renderer ->
                val taggedTrack = renderer.tag as? VideoTrack
                taggedTrack?.removeRenderer(renderer)
                renderer.tag = null
                renderer.release()
            }
            eglBase.release()
        }
    }
}

