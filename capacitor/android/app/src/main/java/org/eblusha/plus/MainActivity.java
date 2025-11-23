package org.eblusha.plus;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import java.util.ArrayList;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Явная регистрация плагина LocalNotifications через init()
        // Это гарантирует, что плагин будет зарегистрирован даже если автоматическая регистрация не сработает
        try {
            Class<? extends Plugin> pluginClass = (Class<? extends Plugin>) Class.forName("com.capacitorjs.plugins.localnotifications.LocalNotificationsPlugin");
            ArrayList<Class<? extends Plugin>> plugins = new ArrayList<>();
            plugins.add(pluginClass);
            this.init(savedInstanceState, plugins);
        } catch (ClassNotFoundException e) {
            // Если класс не найден, используем стандартную инициализацию
            super.onCreate(savedInstanceState);
        }
    }
}
