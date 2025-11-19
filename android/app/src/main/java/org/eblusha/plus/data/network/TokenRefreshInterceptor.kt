package org.eblusha.plus.data.network

import okhttp3.Interceptor
import okhttp3.Response
import org.eblusha.plus.data.api.auth.AuthApi
import org.eblusha.plus.data.api.auth.LoginRequest
import org.eblusha.plus.data.session.SessionStore
import kotlinx.coroutines.runBlocking

/**
 * Interceptor для автоматического обновления токена при 401 ошибке
 */
class TokenRefreshInterceptor(
    private val sessionStore: SessionStore,
    private val authApi: AuthApi,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val response = chain.proceed(request)

        // Если получили 401, попробуем обновить токен
        if (response.code == 401 && !request.url.encodedPath.contains("/auth/login")) {
            android.util.Log.d("TokenRefreshInterceptor", "Got 401, attempting to refresh token")
            
            // Закрываем response body перед повторным запросом
            response.close()
            
            // Пытаемся перелогиниться с сохраненными данными
            val refreshed = runBlocking {
                try {
                    val (username, password) = sessionStore.getCredentials()
                    if (!username.isNullOrBlank() && !password.isNullOrBlank()) {
                        android.util.Log.d("TokenRefreshInterceptor", "Attempting to re-login with saved credentials")
                        val loginResponse = authApi.login(LoginRequest(username, password))
                        sessionStore.setAccessToken(loginResponse.accessToken)
                        android.util.Log.d("TokenRefreshInterceptor", "Token refreshed successfully")
                        true
                    } else {
                        android.util.Log.w("TokenRefreshInterceptor", "No saved credentials found")
                        false
                    }
                } catch (e: Exception) {
                    android.util.Log.e("TokenRefreshInterceptor", "Failed to refresh token", e)
                    false
                }
            }

            // Если токен обновлен, повторяем запрос
            if (refreshed) {
                android.util.Log.d("TokenRefreshInterceptor", "Retrying request with new token")
                val newRequest = request.newBuilder().build()
                return chain.proceed(newRequest)
            }
        }

        return response
    }
}

