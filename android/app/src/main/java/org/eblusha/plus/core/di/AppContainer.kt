package org.eblusha.plus.core.di

import android.content.Context
import org.eblusha.plus.data.api.status.StatusApi
import org.eblusha.plus.data.network.NetworkModule
import org.eblusha.plus.data.session.InMemoryAccessTokenProvider
import org.eblusha.plus.data.session.SessionStore

/**
 * Простейший сервис-локатор. Позже его можно заменить на полноценный DI,
 * но пока достаточно иметь один объект, где хранятся модули приложения.
 */
class AppContainer(context: Context) {
    val accessTokenProvider = InMemoryAccessTokenProvider()
    val networkModule = NetworkModule(accessTokenProvider)
    val sessionStore = SessionStore(context, accessTokenProvider)
    val statusApi: StatusApi = networkModule.create()
}

