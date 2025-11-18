package org.eblusha.plus.core.di

import org.eblusha.plus.data.network.NetworkModule
import org.eblusha.plus.data.session.InMemoryAccessTokenProvider

/**
 * Простейший сервис-локатор. Позже его можно заменить на полноценный DI,
 * но пока достаточно иметь один объект, где хранятся модули приложения.
 */
class AppContainer {
    val accessTokenProvider = InMemoryAccessTokenProvider()
    val networkModule = NetworkModule(accessTokenProvider)
}

