package org.eblusha.plus.ui.call

import android.view.ViewGroup
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import io.livekit.android.room.track.VideoTrack
import org.webrtc.EglBase
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer

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

    DisposableEffect(Unit) {
        onDispose {
            rendererRef.value?.let { renderer ->
                (renderer.tag as? VideoTrack)?.removeRenderer(renderer)
                renderer.release()
            }
            eglBase.release()
        }
    }
}

