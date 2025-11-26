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
        try {
            registerPlugin(MessageNotificationPlugin.class);
            registerPlugin(IncomingCallPlugin.class);
            registerPlugin(NativeSocketPlugin.class);
        } catch (Exception e) {
            android.util.Log.e("MainActivity", "Failed to register plugins", e);
        }
        super.onCreate(savedInstanceState);
        
        // Сохраняем токен из SharedPreferences, если он есть, перед запуском сервиса
        String storedToken = NativeSocketPlugin.getStoredToken(this);
        if (storedToken != null && !storedToken.isEmpty()) {
            android.util.Log.d("MainActivity", "Found stored token, length: " + storedToken.length());
            // Отправляем broadcast, чтобы сервис получил токен
            Intent tokenIntent = new Intent("org.eblusha.plus.ACTION_SOCKET_TOKEN_UPDATED");
            tokenIntent.putExtra("token", storedToken);
            tokenIntent.setPackage(getPackageName());
            sendBroadcast(tokenIntent);
            android.util.Log.d("MainActivity", "Sent stored token to service");
        } else {
            android.util.Log.d("MainActivity", "No stored token found");
        }
        
        try {
            BackgroundConnectionService.start(this);
        } catch (Exception e) {
            android.util.Log.e("MainActivity", "Failed to start BackgroundConnectionService", e);
        }
        
        // Добавляем код, который будет выполняться после загрузки WebView и сохранит токен из localStorage
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().post(() -> {
                String js = "(function() {" +
                    "try {" +
                    "  const storage = window.localStorage;" +
                    "  const sessionStr = storage.getItem('app-store');" +
                    "  if (sessionStr) {" +
                    "    const session = JSON.parse(sessionStr);" +
                    "    const token = session?.session?.accessToken;" +
                    "    if (token && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeSocket) {" +
                    "      console.log('[MainActivity] Found token in localStorage, saving to native...');" +
                    "      window.Capacitor.Plugins.NativeSocket.updateToken({ token: token }).then(() => {" +
                    "        console.log('[MainActivity] ✅ Token saved from localStorage');" +
                    "      }).catch((e) => {" +
                    "        console.error('[MainActivity] ❌ Failed to save token from localStorage:', e);" +
                    "      });" +
                    "    }" +
                    "  }" +
                    "} catch(e) { console.error('[MainActivity] Error reading localStorage:', e); }" +
                    "})();";
                bridge.getWebView().evaluateJavascript(js, null);
            });
        }
        try {
            IntentFilter keepAliveFilter = new IntentFilter(BackgroundConnectionService.ACTION_KEEP_ALIVE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(keepAliveReceiver, keepAliveFilter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(keepAliveReceiver, keepAliveFilter);
            }
        } catch (Exception e) {
            android.util.Log.e("MainActivity", "Failed to register keep-alive receiver", e);
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
