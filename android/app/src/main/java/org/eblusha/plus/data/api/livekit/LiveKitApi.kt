package org.eblusha.plus.data.api.livekit

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.POST

interface LiveKitApi {
    @POST("livekit/token")
    suspend fun requestToken(@Body body: LiveKitTokenRequest): LiveKitTokenResponse
}

@Serializable
data class LiveKitTokenRequest(
    val room: String,
    @SerialName("participantName") val participantName: String? = null,
    @SerialName("participantMetadata") val participantMetadata: Map<String, String?>? = null,
)

@Serializable
data class LiveKitTokenResponse(
    val token: String,
    val url: String,
)

