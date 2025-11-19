package org.eblusha.plus.feature.session

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.util.Locale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.data.api.auth.AuthApi
import org.eblusha.plus.data.realtime.ConnectionState
import org.eblusha.plus.data.realtime.RealtimeEvent
import org.eblusha.plus.data.realtime.RealtimeService
import org.eblusha.plus.data.api.auth.LoginRequest
import org.eblusha.plus.data.api.status.StatusApi
import org.eblusha.plus.data.api.status.StatusUser
import org.eblusha.plus.data.session.SessionStore

sealed interface SessionUiState {
    data object Loading : SessionUiState
    data object LoggedOut : SessionUiState
    data class LoggedIn(val user: SessionUser) : SessionUiState
    data class Error(val message: String) : SessionUiState
}

data class SessionUser(
    val id: String,
    val username: String,
    val displayName: String?,
    val eblid: String?,
    val avatarUrl: String?,
    val status: String?,
)

class SessionViewModel(
    private val sessionStore: SessionStore,
    private val statusApi: StatusApi,
    private val authApi: AuthApi,
    private val realtimeService: RealtimeService,
) : ViewModel() {

    private val _uiState = MutableStateFlow<SessionUiState>(SessionUiState.Loading)
    val uiState: StateFlow<SessionUiState> = _uiState

    init {
        observeSession()
        observeRealtime()
    }

    private fun observeRealtime() {
        viewModelScope.launch {
            realtimeService.connectionState.collect { state ->
                if (state is ConnectionState.Disconnected && uiState.value is SessionUiState.LoggedIn) {
                    // Можно подсвечивать UI (для MVP просто логика)
                }
            }
        }
        viewModelScope.launch {
            realtimeService.events.collect { event ->
                when (event) {
                    is RealtimeEvent.PresenceUpdate -> { /* TODO propagate to UI */ }
                    else -> Unit
                }
            }
        }
    }

    private fun observeSession() {
        viewModelScope.launch {
            sessionStore.accessTokenFlow.collect { token ->
                if (token.isNullOrBlank()) {
                    _uiState.value = SessionUiState.LoggedOut
                } else {
                    fetchProfile()
                }
            }
        }
    }

    fun submitToken(token: String) {
        viewModelScope.launch {
            sessionStore.setAccessToken(token.trim())
        }
    }

    fun login(username: String, password: String) {
        viewModelScope.launch {
            _uiState.value = SessionUiState.Loading
            try {
                val response = authApi.login(LoginRequest(username.trim(), password))
                sessionStore.setAccessToken(response.accessToken)
                // Save credentials for automatic re-login
                sessionStore.setCredentials(username.trim(), password)
            } catch (error: Throwable) {
                _uiState.value = SessionUiState.Error(error.message ?: "Не удалось войти")
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            sessionStore.clear()
        }
    }

    fun refresh() {
        viewModelScope.launch {
            fetchProfile()
        }
    }

    private suspend fun fetchProfile() {
        _uiState.value = SessionUiState.Loading
        _uiState.value = try {
            val response = statusApi.getMe()
            val user = response.user
            if (user != null) {
                val sessionUser = user.toSessionUser()
                realtimeService.requestCallStatuses(listOf()) // placeholder
                SessionUiState.LoggedIn(sessionUser)
            } else {
                SessionUiState.Error("Профиль пустой — авторизуйтесь заново.")
            }
        } catch (error: Throwable) {
            SessionUiState.Error(error.message ?: "Не удалось загрузить профиль")
        }
    }

    private fun StatusUser.toSessionUser() = SessionUser(
        id = id,
        username = username,
        displayName = displayName,
        eblid = eblid,
        avatarUrl = avatarUrl,
        status = status?.uppercase(Locale.getDefault())
    )
}

class SessionViewModelFactory(
    private val container: AppContainer,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(SessionViewModel::class.java)) {
            return SessionViewModel(
                sessionStore = container.sessionStore,
                statusApi = container.statusApi,
                authApi = container.authApi,
                realtimeService = container.realtimeService,
            ) as T
        }
        throw IllegalArgumentException("Unknown ViewModel class")
    }
}

