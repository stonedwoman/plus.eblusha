package org.eblusha.plus.data.api.auth

import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.POST

interface AuthApi {
    @POST("auth/login")
    suspend fun login(@Body payload: LoginRequest): LoginResponse
}

@Serializable
data class LoginRequest(
    val username: String,
    val password: String,
)

@Serializable
data class LoginResponse(
    val accessToken: String,
    val user: LoginUser,
)

@Serializable
data class LoginUser(
    val id: String,
    val username: String,
    val displayName: String? = null,
)

