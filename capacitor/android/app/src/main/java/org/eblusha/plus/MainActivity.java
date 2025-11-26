package org.eblusha.plus;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String EXTRA_CONVERSATION_ID = "conversation_id";
    private static final String EXTRA_ACCEPT_WITH_VIDEO = "accept_with_video";

    private Intent pendingCallIntent;
    private final BroadcastReceiver keepAliveReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || intent.getAction() == null) {
                return;
            }
            if (BackgroundConnectionService.ACTION_KEEP_ALIVE.equals(intent.getAction())) {
                if (bridge != null && bridge.getWebView() != null) {
                    bridge.getWebView()
                        .post(() -> bridge
                            .getWebView()
                            .evaluateJavascript("window.dispatchEvent(new Event('eblushaKeepAlive'));", null));
                }
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(MessageNotificationPlugin.class);
        registerPlugin(IncomingCallPlugin.class);
        registerPlugin(NativeSocketPlugin.class);
        super.onCreate(savedInstanceState);
        BackgroundConnectionService.start(this);
        IntentFilter keepAliveFilter = new IntentFilter(BackgroundConnectionService.ACTION_KEEP_ALIVE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(keepAliveReceiver, keepAliveFilter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(keepAliveReceiver, keepAliveFilter);
        }
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
        try {
            unregisterReceiver(keepAliveReceiver);
        } catch (IllegalArgumentException ignored) {
        }
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
