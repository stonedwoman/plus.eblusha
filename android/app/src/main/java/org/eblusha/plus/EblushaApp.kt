package org.eblusha.plus

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob

/**
 * Базовый класс Application. Позже сюда добавим DI, логи или инициализацию сокета.
 */
class EblushaApp : Application() {
    private val applicationScope = CoroutineScope(SupervisorJob())

    override fun onCreate() {
        super.onCreate()
        // Здесь будет bootstrap (логирование, подключение к LiveKit и т.д.)
    }
}
