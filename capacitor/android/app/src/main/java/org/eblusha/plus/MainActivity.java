package org.eblusha.plus;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String EXTRA_CONVERSATION_ID = "conversation_id";
    private static final String EXTRA_ACCEPT_WITH_VIDEO = "accept_with_video";

    private Intent pendingCallIntent;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(MessageNotificationPlugin.class);
        registerPlugin(IncomingCallPlugin.class);
        super.onCreate(savedInstanceState);
        BackgroundConnectionService.start(this);
        processCallIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        processCallIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        if (pendingCallIntent != null) {
            processCallIntent(pendingCallIntent);
        }
    }

    @Override
    public void onDestroy() {
        BackgroundConnectionService.stop(this);
        super.onDestroy();
    }

    private void processCallIntent(Intent intent) {
        if (intent == null) {
            return;
        }
        String action = intent.getStringExtra("call_action");
        if (action == null) {
            return;
        }
        if (bridge == null || bridge.getWebView() == null) {
            pendingCallIntent = intent;
            return;
        }
        dispatchCallActionToJs(intent, action);
    }

    private void dispatchCallActionToJs(Intent intent, String action) {
        String conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID);
        if (conversationId == null || conversationId.isEmpty()) {
            return;
        }
        boolean withVideo = intent.getBooleanExtra(EXTRA_ACCEPT_WITH_VIDEO, false);
        final String js = String.format(
            "(function(){window.__pendingCallActions = window.__pendingCallActions || []; "
                + "window.__pendingCallActions.push({action:'%s', conversationId:'%s', withVideo:%s}); "
                + "if(window.__flushNativeCallActions){window.__flushNativeCallActions();}})();",
            action,
            conversationId.replace("'", "\\'"),
            withVideo ? "true" : "false"
        );
        bridge.getWebView().post(() -> bridge.getWebView().evaluateJavascript(js, null));
        pendingCallIntent = null;
    }
}
