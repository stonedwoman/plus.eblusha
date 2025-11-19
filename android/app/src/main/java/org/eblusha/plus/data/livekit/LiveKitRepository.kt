package org.eblusha.plus.data.livekit

import org.eblusha.plus.data.api.livekit.LiveKitApi
import org.eblusha.plus.data.api.livekit.LiveKitTokenRequest
import org.eblusha.plus.data.api.livekit.LiveKitTokenResponse

class LiveKitRepository(
    private val api: LiveKitApi,
) {
    suspend fun fetchToken(
        conversationId: String,
        participantName: String? = null,
        metadata: Map<String, String?>? = null,
    ): LiveKitTokenResponse {
        val request = LiveKitTokenRequest(
            room = "conv-$conversationId",
            participantName = participantName,
            participantMetadata = metadata,
        )
        return api.requestToken(request)
    }
}

