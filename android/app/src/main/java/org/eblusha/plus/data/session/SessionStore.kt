package org.eblusha.plus.data.session

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.io.IOException

class SessionStore(
    context: Context,
    private val tokenProvider: InMemoryAccessTokenProvider,
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val dataStore: DataStore<Preferences> = PreferenceDataStoreFactory.create(
        scope = scope
    ) {
        context.preferencesDataStoreFile("session_prefs")
    }

    private object Keys {
        val ACCESS_TOKEN = stringPreferencesKey("access_token")
        val USERNAME = stringPreferencesKey("username")
        val PASSWORD = stringPreferencesKey("password")
    }

    val accessTokenFlow: Flow<String?> = dataStore.data
        .catch { exception ->
            if (exception is IOException) emit(emptyPreferences()) else throw exception
        }
        .map { prefs -> prefs[Keys.ACCESS_TOKEN] }

    init {
        scope.launch {
            val token = accessTokenFlow.firstOrNull()
            tokenProvider.updateToken(token)
        }
    }

    suspend fun setAccessToken(token: String?) {
        dataStore.edit { prefs ->
            if (token.isNullOrBlank()) {
                prefs.remove(Keys.ACCESS_TOKEN)
            } else {
                prefs[Keys.ACCESS_TOKEN] = token
            }
        }
        tokenProvider.updateToken(token)
    }

    suspend fun clear() {
        dataStore.edit { prefs ->
            prefs.remove(Keys.ACCESS_TOKEN)
            prefs.remove(Keys.USERNAME)
            prefs.remove(Keys.PASSWORD)
        }
        tokenProvider.updateToken(null)
    }
    
    suspend fun setCredentials(username: String, password: String) {
        dataStore.edit { prefs ->
            prefs[Keys.USERNAME] = username
            prefs[Keys.PASSWORD] = password
        }
    }
    
    suspend fun getCredentials(): Pair<String?, String?> {
        val prefs = dataStore.data.firstOrNull() ?: return null to null
        return prefs[Keys.USERNAME] to prefs[Keys.PASSWORD]
    }
    
    val usernameFlow: Flow<String?> = dataStore.data
        .catch { exception ->
            if (exception is IOException) emit(emptyPreferences()) else throw exception
        }
        .map { prefs -> prefs[Keys.USERNAME] }
}

