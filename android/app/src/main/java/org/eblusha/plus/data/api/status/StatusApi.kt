package org.eblusha.plus.data.api.status

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.GET

interface StatusApi {
    @GET("status/me")
    suspend fun getMe(): StatusResponse
}

@Serializable
data class StatusResponse(
    val user: StatusUser? = null,
)

@Serializable
@Serializable
data class StatusUser(
    val id: String,
    val username: String,
    val eblid: String? = null,
    @SerialName("displayName") val displayName: String? = null,
    val bio: String? = null,
    val avatarUrl: String? = null,
    val status: String? = null,
    val lastSeenAt: String? = null,
)

