package org.eblusha.plus.core.config

import org.eblusha.plus.BuildConfig

/**
 * Централизованное хранилище констант окружения, приходящих из BuildConfig.
 * Благодаря buildConfigField мы можем задавать разные URL для debug/release
 * и переиспользовать их в одном месте.
 */
object AppConfig {
    /**
     * REST API base URL. Должен заканчиваться на '/', чтобы Retrofit корректно
     * собирал эндпоинты.
     */
    val apiBaseUrl: String = BuildConfig.API_BASE_URL

    /**
     * Базовый URL для Socket.IO/LiveKit (пока просто http/s origin).
     */
    val socketBaseUrl: String = BuildConfig.WS_BASE_URL
}

