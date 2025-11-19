package org.eblusha.plus.data.network

import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import org.eblusha.plus.BuildConfig
import org.eblusha.plus.core.config.AppConfig
import org.eblusha.plus.data.session.AccessTokenProvider
import retrofit2.Retrofit
import retrofit2.create
import retrofit2.converter.kotlinx.serialization.asConverterFactory

/**
 * Простая обёртка вокруг OkHttp/Retrofit, чтобы не дублировать конфиг.
 * Позже можно заменить на DI (Hilt/Koin), но уже сейчас удобнее иметь
 * единое место создания API сервисов.
 */
class NetworkModule(
    private val tokenProvider: AccessTokenProvider,
    private val sessionStore: org.eblusha.plus.data.session.SessionStore? = null,
    private val authApi: org.eblusha.plus.data.api.auth.AuthApi? = null,
    private val baseUrl: String = AppConfig.apiBaseUrl,
) {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
    }

    private val loggingInterceptor = HttpLoggingInterceptor().apply {
        level = if (BuildConfig.DEBUG) {
            HttpLoggingInterceptor.Level.BODY
        } else {
            HttpLoggingInterceptor.Level.BASIC
        }
    }

    val okHttpClient: OkHttpClient by lazy {
        val builder = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .addInterceptor(AuthTokenInterceptor(tokenProvider))
            .addInterceptor(loggingInterceptor)
        
        // Add token refresh interceptor AFTER logging interceptor
        // Interceptors process responses in reverse order, so HttpLoggingInterceptor
        // will read the response body first, then TokenRefreshInterceptor can close it
        if (sessionStore != null && authApi != null) {
            builder.addInterceptor(TokenRefreshInterceptor(sessionStore, authApi))
        }
        
        builder.build()
    }

    val retrofit: Retrofit by lazy {
        Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(okHttpClient)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
    }

    inline fun <reified T> create(): T = retrofit.create()
}

