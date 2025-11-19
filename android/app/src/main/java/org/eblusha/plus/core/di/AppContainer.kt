package org.eblusha.plus.core.di

import android.content.Context
import org.eblusha.plus.core.config.AppConfig
import org.eblusha.plus.data.api.auth.AuthApi
import org.eblusha.plus.data.api.conversations.ConversationsApi
import org.eblusha.plus.data.api.livekit.LiveKitApi
import org.eblusha.plus.data.api.messages.MessagesApi
import org.eblusha.plus.data.api.status.StatusApi
import org.eblusha.plus.data.livekit.LiveKitRepository
import org.eblusha.plus.data.network.NetworkModule
import org.eblusha.plus.data.realtime.RealtimeService
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
    val conversationsApi: ConversationsApi = networkModule.create()
    val messagesApi: MessagesApi = networkModule.create()
    val authApi: AuthApi = networkModule.create()
    val liveKitApi: LiveKitApi = networkModule.create()
    val liveKitRepository = LiveKitRepository(liveKitApi)
    val realtimeService = RealtimeService(AppConfig, accessTokenProvider)
}

