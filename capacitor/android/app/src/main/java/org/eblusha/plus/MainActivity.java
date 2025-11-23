package org.eblusha.plus;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Logger;
import com.capacitorjs.plugins.localnotifications.LocalNotificationsPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Явная регистрация плагина LocalNotifications
        // Это гарантирует, что плагин будет зарегистрирован даже если автоматическая регистрация не сработает
        try {
            registerPlugin(LocalNotificationsPlugin.class);
            Logger.debug("LocalNotificationsPlugin registered manually");
        } catch (Exception e) {
            Logger.error("Failed to register LocalNotificationsPlugin", e);
        }
    }
}
