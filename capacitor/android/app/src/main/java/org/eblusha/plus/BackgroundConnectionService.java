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
import org.json.JSONObject;

/**
 * Foreground service that keeps a native Socket.IO connection alive while the app is backgrounded,
 * so calls/messages still arrive even if the WebView is paused.
 */
public class BackgroundConnectionService extends Service {
    private static final String CHANNEL_ID = "background_connection_channel";
    private static final String MESSAGE_CHANNEL_ID = "eblusha_messages";
    private static final int NOTIFICATION_ID = 2001;
    private static final long KEEP_ALIVE_INTERVAL_MS = 30_000L;
    private static final String SOCKET_URL = "https://ru.eblusha.org";
    public static final String ACTION_KEEP_ALIVE = "org.eblusha.plus.ACTION_KEEP_ALIVE";

    private final Handler keepAliveHandler = new Handler(Looper.getMainLooper());
    private final Runnable keepAliveRunnable = new Runnable() {
        @Override
        public void run() {
            sendKeepAliveBroadcast();
            keepAliveHandler.postDelayed(this, KEEP_ALIVE_INTERVAL_MS);
        }
    };
    private final BroadcastReceiver tokenUpdateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || intent.getAction() == null) return;
            if ("org.eblusha.plus.ACTION_SOCKET_TOKEN_UPDATED".equals(intent.getAction())) {
                String token = intent.getStringExtra("token");
                android.util.Log.d("BackgroundConnectionService", "Token update broadcast received");
                updateSocketToken(token);
            }
        }
    };

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private Socket nativeSocket;
    private String currentToken = "";

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
        createForegroundChannel();
        createMessageChannel();
        startForeground(NOTIFICATION_ID, createNotification());
        acquireLocks();
        scheduleKeepAlive();
        registerReceiver(tokenUpdateReceiver, new IntentFilter("org.eblusha.plus.ACTION_SOCKET_TOKEN_UPDATED"));
        currentToken = NativeSocketPlugin.getStoredToken(this);
        if (!TextUtils.isEmpty(currentToken)) {
            connectNativeSocket(currentToken);
        } else {
            android.util.Log.d("BackgroundConnectionService", "No stored token yet; waiting for update");
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        keepAliveHandler.removeCallbacks(keepAliveRunnable);
        releaseLocks();
        try {
            unregisterReceiver(tokenUpdateReceiver);
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
        if (TextUtils.isEmpty(token)) {
            currentToken = "";
            disconnectNativeSocket();
            return;
        }
        if (token.equals(currentToken) && nativeSocket != null && nativeSocket.connected()) {
            return;
        }
        currentToken = token;
        connectNativeSocket(token);
    }

    private void connectNativeSocket(String token) {
        if (TextUtils.isEmpty(token)) {
            android.util.Log.w("BackgroundConnectionService", "Token empty, cannot connect native socket");
            return;
        }
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

            nativeSocket = IO.socket(SOCKET_URL, options);
            nativeSocket.on(Socket.EVENT_CONNECT, args -> android.util.Log.d("BackgroundConnectionService", "Native socket connected"));
            nativeSocket.on(Socket.EVENT_DISCONNECT, args -> android.util.Log.w("BackgroundConnectionService", "Native socket disconnected: " + (args != null && args.length > 0 ? args[0] : "")));
            nativeSocket.on(Socket.EVENT_CONNECT_ERROR, args -> android.util.Log.e("BackgroundConnectionService", "Native socket connect error: " + (args != null && args.length > 0 ? args[0] : "")));
            nativeSocket.on("message:notify", this::handleMessageNotify);
            nativeSocket.on("call:incoming", this::handleCallIncoming);
            nativeSocket.on("call:declined", this::handleCallEnded);
            nativeSocket.on("call:ended", this::handleCallEnded);
            nativeSocket.connect();
        } catch (URISyntaxException e) {
            android.util.Log.e("BackgroundConnectionService", "Failed to connect native socket", e);
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
        if (args == null || args.length == 0 || !(args[0] instanceof JSONObject)) return;
        JSONObject payload = (JSONObject) args[0];
        String conversationId = payload.optString("conversationId", "");
        String messageId = payload.optString("messageId", "");
        JSONObject message = payload.optJSONObject("message");
        String preview = extractMessagePreview(message);
        showMessageNotification(conversationId, messageId, preview);
    }

    private void handleCallIncoming(Object... args) {
        if (args == null || args.length == 0 || !(args[0] instanceof JSONObject)) return;
        JSONObject payload = (JSONObject) args[0];
        String conversationId = payload.optString("conversationId", "");
        JSONObject from = payload.optJSONObject("from");
        String callerName = from != null ? from.optString("name", "Входящий звонок") : "Входящий звонок";
        boolean isVideo = payload.optBoolean("video", false);
        IncomingCallService.start(getApplicationContext(), conversationId, callerName, isVideo, null);
    }

    private void handleCallEnded(Object... args) {
        IncomingCallService.stop(getApplicationContext());
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
        Context context = getApplicationContext();
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);

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
    }
}

