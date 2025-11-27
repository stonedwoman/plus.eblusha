package org.eblusha.plus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.text.TextUtils;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import io.socket.client.IO;
import io.socket.client.Socket;
import java.net.URISyntaxException;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Foreground service that keeps a native Socket.IO connection alive while the app is backgrounded,
 * so calls/messages still arrive even if the WebView is paused.
 */
public class BackgroundConnectionService extends Service {
    private static final String CHANNEL_ID = "background_connection_channel";
    private static final String MESSAGE_CHANNEL_ID = "eblusha_messages";
    private static final int NOTIFICATION_ID = 2001;
    private static final long KEEP_ALIVE_INTERVAL_MS = 15_000L; // Уменьшено до 15 секунд для более частых проверок
    private static final long NOTIFICATION_UPDATE_INTERVAL_MS = 30_000L; // Обновляем уведомление каждые 30 секунд
    private static final String SOCKET_URL = "https://ru.eblusha.org";
    public static final String ACTION_KEEP_ALIVE = "org.eblusha.plus.ACTION_KEEP_ALIVE";

    private final Handler keepAliveHandler = new Handler(Looper.getMainLooper());
    private long lastNotificationUpdate = 0;
    private final Runnable keepAliveRunnable = new Runnable() {
        @Override
        public void run() {
            try {
                sendKeepAliveBroadcast();
                checkNativeSocketConnection();
                
                // Периодически обновляем уведомление, чтобы система знала, что сервис активен
                long now = System.currentTimeMillis();
                if (now - lastNotificationUpdate > NOTIFICATION_UPDATE_INTERVAL_MS) {
                    updateForegroundNotification();
                    lastNotificationUpdate = now;
                }
                
                // Проверяем и восстанавливаем wakelock, если он был освобожден
                ensureLocksHeld();
            } catch (Exception e) {
                android.util.Log.e("BackgroundConnectionService", "Error in keep-alive runnable", e);
            }
            keepAliveHandler.postDelayed(this, KEEP_ALIVE_INTERVAL_MS);
        }
    };
    private final BroadcastReceiver tokenUpdateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || intent.getAction() == null) {
                android.util.Log.w("BackgroundConnectionService", "Token update receiver: intent or action is null");
                return;
            }
            android.util.Log.d("BackgroundConnectionService", "Broadcast received, action: " + intent.getAction());
            if ("org.eblusha.plus.ACTION_SOCKET_TOKEN_UPDATED".equals(intent.getAction())) {
                String token = intent.getStringExtra("token");
                android.util.Log.d("BackgroundConnectionService", "✅ Token update broadcast received, token length: " + (token != null ? token.length() : 0));
                updateSocketToken(token);
            } else {
                android.util.Log.d("BackgroundConnectionService", "Ignoring broadcast with action: " + intent.getAction());
            }
        }
    };
    private final BroadcastReceiver presenceFocusReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || intent.getAction() == null) return;
            if ("org.eblusha.plus.ACTION_SOCKET_PRESENCE_FOCUS".equals(intent.getAction())) {
                boolean focused = intent.getBooleanExtra("focused", false);
                android.util.Log.d("BackgroundConnectionService", "Presence focus broadcast received: focused=" + focused);
                appHasFocus = focused;
                sendPresenceFocus(focused);
            }
        }
    };

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private Socket nativeSocket;
    private String currentToken = "";
    private boolean appHasFocus = false;

    public static void start(Context context) {
        Intent intent = new Intent(context, BackgroundConnectionService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, BackgroundConnectionService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        android.util.Log.d("BackgroundConnectionService", "onCreate() called");
        try {
            createForegroundChannel();
            createMessageChannel();
            startForeground(NOTIFICATION_ID, createNotification());
            android.util.Log.d("BackgroundConnectionService", "Foreground service started");
            acquireLocks();
            android.util.Log.d("BackgroundConnectionService", "Locks acquired");
            scheduleKeepAlive();
            android.util.Log.d("BackgroundConnectionService", "Keep-alive scheduled");
            try {
                IntentFilter tokenFilter = new IntentFilter("org.eblusha.plus.ACTION_SOCKET_TOKEN_UPDATED");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    registerReceiver(tokenUpdateReceiver, tokenFilter, Context.RECEIVER_NOT_EXPORTED);
                } else {
                    registerReceiver(tokenUpdateReceiver, tokenFilter);
                }
                android.util.Log.d("BackgroundConnectionService", "Token update receiver registered");
            } catch (Exception e) {
                android.util.Log.e("BackgroundConnectionService", "Failed to register token receiver", e);
            }
            try {
                IntentFilter focusFilter = new IntentFilter("org.eblusha.plus.ACTION_SOCKET_PRESENCE_FOCUS");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    registerReceiver(presenceFocusReceiver, focusFilter, Context.RECEIVER_NOT_EXPORTED);
                } else {
                    registerReceiver(presenceFocusReceiver, focusFilter);
                }
                android.util.Log.d("BackgroundConnectionService", "Presence focus receiver registered");
            } catch (Exception e) {
                android.util.Log.e("BackgroundConnectionService", "Failed to register presence focus receiver", e);
            }
            try {
                currentToken = NativeSocketPlugin.getStoredToken(this);
                android.util.Log.d("BackgroundConnectionService", "Stored token length: " + (currentToken != null ? currentToken.length() : 0));
                if (!TextUtils.isEmpty(currentToken)) {
                    android.util.Log.d("BackgroundConnectionService", "Connecting native socket with stored token...");
                    connectNativeSocket(currentToken);
                } else {
                    android.util.Log.d("BackgroundConnectionService", "No stored token yet; waiting for update");
                }
            } catch (Exception e) {
                android.util.Log.e("BackgroundConnectionService", "Failed to load token or connect socket", e);
            }
            android.util.Log.d("BackgroundConnectionService", "✅ onCreate() completed successfully");
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "❌ Fatal error in onCreate", e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        android.util.Log.d("BackgroundConnectionService", "onStartCommand called, startId=" + startId + ", flags=" + flags);
        // Проверяем соединение при каждом вызове onStartCommand
        if (!TextUtils.isEmpty(currentToken)) {
            checkNativeSocketConnection();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        keepAliveHandler.removeCallbacks(keepAliveRunnable);
        releaseLocks();
        try {
            unregisterReceiver(tokenUpdateReceiver);
        } catch (IllegalArgumentException ignored) {}
        try {
            unregisterReceiver(presenceFocusReceiver);
        } catch (IllegalArgumentException ignored) {}
        disconnectNativeSocket();
        stopForeground(true);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createForegroundChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Фоновое соединение",
                NotificationManager.IMPORTANCE_MIN
            );
            channel.setDescription("Поддерживает соединение для звонков и сообщений");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void createMessageChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                MESSAGE_CHANNEL_ID,
                "Сообщения",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Уведомления о новых сообщениях");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification createNotification() {
        Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Еблуша Plus работает в фоне")
            .setContentText("Поддерживается соединение для звонков и сообщений")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(pendingIntent)
            .setSilent(true)
            .build();
    }

    private void scheduleKeepAlive() {
        keepAliveHandler.removeCallbacks(keepAliveRunnable);
        keepAliveHandler.postDelayed(keepAliveRunnable, KEEP_ALIVE_INTERVAL_MS);
    }

    private void sendKeepAliveBroadcast() {
        Intent intent = new Intent(ACTION_KEEP_ALIVE).setPackage(getPackageName());
        sendBroadcast(intent);
    }

    private void checkNativeSocketConnection() {
        // Периодически проверяем, не появился ли токен в SharedPreferences
        if (TextUtils.isEmpty(currentToken)) {
            String storedToken = NativeSocketPlugin.getStoredToken(this);
            if (!TextUtils.isEmpty(storedToken)) {
                android.util.Log.d("BackgroundConnectionService", "✅ Token found in SharedPreferences (length: " + storedToken.length() + "), connecting socket...");
                currentToken = storedToken;
                connectNativeSocket(currentToken);
                return;
            }
            android.util.Log.d("BackgroundConnectionService", "No token available for socket connection (checked SharedPreferences)");
            return;
        }
        // Также проверяем, не обновился ли токен в SharedPreferences
        String storedToken = NativeSocketPlugin.getStoredToken(this);
        if (!TextUtils.isEmpty(storedToken) && !storedToken.equals(currentToken)) {
            android.util.Log.d("BackgroundConnectionService", "Token updated in SharedPreferences, reconnecting...");
            currentToken = storedToken;
            connectNativeSocket(currentToken);
            return;
        }
        boolean wasConnected = nativeSocket != null && nativeSocket.connected();
        if (!wasConnected) {
            android.util.Log.w("BackgroundConnectionService", "Native socket disconnected (wasConnected=" + wasConnected + "), reconnecting...");
            connectNativeSocket(currentToken);
        } else {
            android.util.Log.d("BackgroundConnectionService", "Native socket is connected");
        }
    }

    private void updateForegroundNotification() {
        try {
            Notification notification = createNotification();
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.notify(NOTIFICATION_ID, notification);
                android.util.Log.d("BackgroundConnectionService", "Foreground notification updated");
            }
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "Failed to update foreground notification", e);
        }
    }

    private void ensureLocksHeld() {
        try {
            if (wakeLock == null || !wakeLock.isHeld()) {
                android.util.Log.w("BackgroundConnectionService", "WakeLock was released, re-acquiring...");
                releaseLocks();
                acquireLocks();
            }
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "Failed to ensure WakeLock", e);
        }
        
        try {
            if (wifiLock == null || !wifiLock.isHeld()) {
                android.util.Log.w("BackgroundConnectionService", "WifiLock was released, re-acquiring...");
                releaseLocks();
                acquireLocks();
            }
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "Failed to ensure WifiLock", e);
        }
    }

    private void acquireLocks() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && wakeLock == null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "EblushaPlus::SocketWakeLock");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "Failed to acquire WakeLock", e);
        }

        try {
            WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null && wifiLock == null) {
                wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "EblushaPlus::WifiLock");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "Failed to acquire WifiLock", e);
        }
    }

    private void releaseLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
            wakeLock = null;
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "Failed to release WakeLock", e);
        }

        try {
            if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
            }
            wifiLock = null;
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "Failed to release WifiLock", e);
        }
    }

    private void updateSocketToken(String token) {
        android.util.Log.d("BackgroundConnectionService", "updateSocketToken() called, token length: " + (token != null ? token.length() : 0));
        if (TextUtils.isEmpty(token)) {
            android.util.Log.w("BackgroundConnectionService", "Token is empty, disconnecting socket");
            currentToken = "";
            disconnectNativeSocket();
            return;
        }
        boolean isSameToken = token.equals(currentToken);
        boolean isConnected = nativeSocket != null && nativeSocket.connected();
        android.util.Log.d("BackgroundConnectionService", "Token comparison: isSame=" + isSameToken + ", isConnected=" + isConnected);
        if (isSameToken && isConnected) {
            android.util.Log.d("BackgroundConnectionService", "Token unchanged and socket connected, skipping reconnect");
            return;
        }
        android.util.Log.d("BackgroundConnectionService", "Updating token and connecting socket...");
        currentToken = token;
        connectNativeSocket(token);
    }

    private void connectNativeSocket(String token) {
        if (TextUtils.isEmpty(token)) {
            android.util.Log.w("BackgroundConnectionService", "Token empty, cannot connect native socket");
            return;
        }
        android.util.Log.d("BackgroundConnectionService", "🔄 connectNativeSocket() called, token length: " + token.length());
        disconnectNativeSocket();
        try {
            IO.Options options = new IO.Options();
            options.forceNew = true;
            options.reconnection = true;
            options.reconnectionAttempts = Integer.MAX_VALUE;
            options.timeout = 20000;
            options.reconnectionDelay = 1000;
            options.reconnectionDelayMax = 10000;
            options.query = "token=" + token;
            Map<String, String> auth = new HashMap<>();
            auth.put("token", token);
            options.auth = auth;

            android.util.Log.d("BackgroundConnectionService", "Creating socket instance for URL: " + SOCKET_URL);
            nativeSocket = IO.socket(SOCKET_URL, options);
            if (nativeSocket == null) {
                android.util.Log.e("BackgroundConnectionService", "Failed to create socket instance");
                return;
            }
            android.util.Log.d("BackgroundConnectionService", "Socket instance created, setting up event handlers...");
            nativeSocket.on(Socket.EVENT_CONNECT, args -> {
                android.util.Log.d("BackgroundConnectionService", "✅ Native socket connected successfully");
                sendPresenceFocus(appHasFocus);
                updateForegroundNotification();
            });
            nativeSocket.on(Socket.EVENT_DISCONNECT, args -> {
                String reason = args != null && args.length > 0 ? String.valueOf(args[0]) : "unknown";
                android.util.Log.w("BackgroundConnectionService", "❌ Native socket disconnected: " + reason);
                // Автоматически переподключаемся, если это не ручное отключение
                if (!"io client disconnect".equals(reason) && !TextUtils.isEmpty(currentToken)) {
                    android.util.Log.d("BackgroundConnectionService", "🔄 Scheduling reconnect in 2 seconds...");
                    keepAliveHandler.postDelayed(() -> {
                        if (!TextUtils.isEmpty(currentToken)) {
                            boolean isConnected = nativeSocket != null && nativeSocket.connected();
                            android.util.Log.d("BackgroundConnectionService", "Reconnect check: isConnected=" + isConnected);
                            if (!isConnected) {
                                android.util.Log.d("BackgroundConnectionService", "🔄 Executing reconnect...");
                                connectNativeSocket(currentToken);
                            }
                        }
                    }, 2000);
                }
            });
            nativeSocket.on(Socket.EVENT_CONNECT_ERROR, args -> {
                String error = args != null && args.length > 0 ? String.valueOf(args[0]) : "unknown";
                android.util.Log.e("BackgroundConnectionService", "❌ Native socket connect error: " + error);
                // Переподключаемся через некоторое время
                if (!TextUtils.isEmpty(currentToken)) {
                    android.util.Log.d("BackgroundConnectionService", "🔄 Scheduling retry in 5 seconds...");
                    keepAliveHandler.postDelayed(() -> {
                        if (!TextUtils.isEmpty(currentToken)) {
                            boolean isConnected = nativeSocket != null && nativeSocket.connected();
                            android.util.Log.d("BackgroundConnectionService", "Retry check: isConnected=" + isConnected);
                            if (!isConnected) {
                                android.util.Log.d("BackgroundConnectionService", "🔄 Executing retry...");
                                connectNativeSocket(currentToken);
                            }
                        }
                    }, 5000);
                }
            });
            nativeSocket.on("message:notify", this::handleMessageNotify);
            nativeSocket.on("call:incoming", this::handleCallIncoming);
            nativeSocket.on("call:declined", this::handleCallEnded);
            nativeSocket.on("call:ended", this::handleCallEnded);
            android.util.Log.d("BackgroundConnectionService", "Event handlers registered, calling connect()...");
            nativeSocket.connect();
            android.util.Log.d("BackgroundConnectionService", "✅ Native socket connect() called, connection initiated");
        } catch (URISyntaxException e) {
            android.util.Log.e("BackgroundConnectionService", "❌ Failed to connect native socket: URI syntax error", e);
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "❌ Failed to connect native socket: unexpected error", e);
            e.printStackTrace();
        }
    }

    private void disconnectNativeSocket() {
        if (nativeSocket != null) {
            nativeSocket.off();
            nativeSocket.disconnect();
            nativeSocket.close();
            nativeSocket = null;
        }
    }

    private void handleMessageNotify(Object... args) {
        try {
            if (args == null || args.length == 0 || !(args[0] instanceof JSONObject)) return;
            JSONObject payload = (JSONObject) args[0];
            String conversationId = payload.optString("conversationId", "");
            String messageId = payload.optString("messageId", "");
            JSONObject message = payload.optJSONObject("message");
            String preview = extractMessagePreview(message);
            showMessageNotification(conversationId, messageId, preview);
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "Error handling message:notify", e);
        }
    }

    private void handleCallIncoming(Object... args) {
        try {
            if (args == null || args.length == 0 || !(args[0] instanceof JSONObject)) return;
            JSONObject payload = (JSONObject) args[0];
            String conversationId = payload.optString("conversationId", "");
            JSONObject from = payload.optJSONObject("from");
            String callerName = from != null ? from.optString("name", "Входящий звонок") : "Входящий звонок";
            boolean isVideo = payload.optBoolean("video", false);
            IncomingCallService.start(getApplicationContext(), conversationId, callerName, isVideo, null);
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "Error handling call:incoming", e);
        }
    }

    private void handleCallEnded(Object... args) {
        try {
            IncomingCallService.stop(getApplicationContext());
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "Error handling call ended", e);
        }
    }

    private void sendPresenceFocus(boolean focused) {
        if (nativeSocket == null || !nativeSocket.connected()) {
            android.util.Log.d("BackgroundConnectionService", "Cannot emit presence focus, socket not connected");
            return;
        }
        try {
            JSONObject payload = new JSONObject();
            payload.put("focused", focused);
            nativeSocket.emit("presence:focus", payload);
            android.util.Log.d("BackgroundConnectionService", "Emitted presence focus: " + focused);
        } catch (JSONException e) {
            android.util.Log.e("BackgroundConnectionService", "Failed to emit presence focus", e);
        }
    }

    private String extractMessagePreview(JSONObject message) {
        if (message == null) return "Новое сообщение";
        String content = message.optString("content", "");
        if (!TextUtils.isEmpty(content)) {
            return content;
        }
        JSONArray attachments = message.optJSONArray("attachments");
        if (attachments != null && attachments.length() > 0) {
            JSONObject attachment = attachments.optJSONObject(0);
            if (attachment != null) {
                String type = attachment.optString("type", "");
                if ("IMAGE".equalsIgnoreCase(type)) {
                    return "📷 Фото";
                }
                return "📎 Вложение";
            }
        }
        return "Новое сообщение";
    }

    private void showMessageNotification(String conversationId, String messageId, String body) {
        try {
            Context context = getApplicationContext();
            if (context == null) {
                android.util.Log.e("BackgroundConnectionService", "Cannot show notification: context is null");
                return;
            }
            NotificationManagerCompat manager = NotificationManagerCompat.from(context);
            if (manager == null) {
                android.util.Log.e("BackgroundConnectionService", "Cannot show notification: NotificationManagerCompat is null");
                return;
            }

            Intent intent = new Intent(context, MainActivity.class)
                .setAction("open_conversation")
                .putExtra("conversation_id", conversationId)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                (conversationId + messageId).hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, MESSAGE_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Новое сообщение")
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent);

            int notificationId = (conversationId + messageId).hashCode();
            manager.notify(notificationId, builder.build());
        } catch (Exception e) {
            android.util.Log.e("BackgroundConnectionService", "Failed to show message notification", e);
        }
    }
}

