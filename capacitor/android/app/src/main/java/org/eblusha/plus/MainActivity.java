package org.eblusha.plus;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(MessageNotificationPlugin.class);
        registerPlugin(IncomingCallPlugin.class);
        super.onCreate(savedInstanceState);
        BackgroundConnectionService.start(this);
    }

    @Override
    public void onDestroy() {
        BackgroundConnectionService.stop(this);
        super.onDestroy();
    }
}
