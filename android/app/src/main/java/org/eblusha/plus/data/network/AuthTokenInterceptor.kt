package org.eblusha.plus.data.network

import okhttp3.Interceptor
import okhttp3.Response
import org.eblusha.plus.data.session.AccessTokenProvider

/**
 * Добавляет заголовок Authorization: Bearer <token> для всех запросов,
 * если токен присутствует. Пустые значения не добавляются.
 */
class AuthTokenInterceptor(
    private val tokenProvider: AccessTokenProvider
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val token = tokenProvider.getAccessToken()
        val request = if (!token.isNullOrBlank()) {
            chain.request()
                .newBuilder()
                .addHeader("Authorization", "Bearer $token")
                .build()
        } else {
            chain.request()
        }
        return chain.proceed(request)
    }
}

