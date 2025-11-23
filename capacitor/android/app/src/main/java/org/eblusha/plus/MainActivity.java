package org.eblusha.plus;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Logger;
import com.getcapacitor.Bridge;
import java.util.List;
import com.getcapacitor.Plugin;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }
    
    @Override
    protected void onStart() {
        super.onStart();
        
        // Логируем загруженные плагины для диагностики
        try {
            Bridge bridge = getBridge();
            if (bridge != null) {
                List<Class<? extends Plugin>> plugins = bridge.getPlugins();
                Logger.debug("Loaded plugins count: " + plugins.size());
                for (Class<? extends Plugin> plugin : plugins) {
                    Logger.debug("Plugin: " + plugin.getName());
                }
            }
        } catch (Exception e) {
            Logger.error("Error logging plugins", e);
        }
    }
}
