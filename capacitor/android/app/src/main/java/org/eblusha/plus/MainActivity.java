package org.eblusha.plus;

import android.os.Bundle;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import java.util.List;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onStart() {
        super.onStart();
        Bridge bridge = getBridge();
        if (bridge != null) {
            try {
                List<Class<? extends Plugin>> plugins = bridge.getPlugins();
                Logger.info("MainActivity", "Loaded plugins count: " + plugins.size());
                for (Class<? extends Plugin> plugin : plugins) {
                    Logger.info("MainActivity", "Plugin: " + plugin.getName());
                }
            } catch (Exception e) {
                Logger.error("MainActivity", "Unable to enumerate plugins", e);
            }
        } else {
            Logger.warn("MainActivity", "Bridge not ready in onStart");
        }
    }
}
