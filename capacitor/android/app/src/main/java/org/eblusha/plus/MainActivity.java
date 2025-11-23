package org.eblusha.plus;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Явная регистрация плагина LocalNotifications через рефлексию
        // Это гарантирует, что плагин будет зарегистрирован даже если автоматическая регистрация не сработает
        try {
            Class<? extends Plugin> pluginClass = (Class<? extends Plugin>) Class.forName("com.capacitorjs.plugins.localnotifications.LocalNotificationsPlugin");
            registerPlugin(pluginClass);
            Logger.debug("LocalNotificationsPlugin registered manually via reflection");
        } catch (ClassNotFoundException e) {
            Logger.error("LocalNotificationsPlugin class not found", e);
        } catch (Exception e) {
            Logger.error("Failed to register LocalNotificationsPlugin", e);
        }
    }
}
