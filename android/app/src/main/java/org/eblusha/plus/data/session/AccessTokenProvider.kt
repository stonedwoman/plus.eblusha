package org.eblusha.plus.data.session

/**
 * Минимальный контракт для компонентов, которым нужен текущий access token.
 * Реализация пока in-memory, позже можно заменить на DataStore/EncryptedStorage.
 */
interface AccessTokenProvider {
    fun getAccessToken(): String?
}

class InMemoryAccessTokenProvider : AccessTokenProvider {

    @Volatile
    private var token: String? = null

    override fun getAccessToken(): String? = token

    fun updateToken(newToken: String?) {
        token = newToken
    }
}

