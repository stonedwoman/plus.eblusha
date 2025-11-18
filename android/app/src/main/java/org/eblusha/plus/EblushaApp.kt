package org.eblusha.plus

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import org.eblusha.plus.core.di.AppContainer

/**
 * Базовый класс Application. Позже сюда добавим DI, логи или инициализацию сокета.
 */
class EblushaApp : Application() {
    private val applicationScope = CoroutineScope(SupervisorJob())
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        // Здесь будет bootstrap (логирование, подключение к LiveKit и т.д.)
        container = AppContainer(this)
    }
}
