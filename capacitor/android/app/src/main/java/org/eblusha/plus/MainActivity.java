package org.eblusha.plus;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.capacitorjs.plugins.localnotifications.LocalNotificationsPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Явная регистрация плагина LocalNotifications
        registerPlugin(LocalNotificationsPlugin.class);
    }
}
