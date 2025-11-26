package org.eblusha.plus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps the WebView process alive while the app is backgrounded,
 * so Socket.IO stays connected long enough to receive calls/messages.
 */
public class BackgroundConnectionService extends Service {
    private static final String CHANNEL_ID = "background_connection_channel";
    private static final int NOTIFICATION_ID = 2001;
    private static final long KEEP_ALIVE_INTERVAL_MS = 30_000L;
    public static final String ACTION_KEEP_ALIVE = "org.eblusha.plus.ACTION_KEEP_ALIVE";
    
    private final Handler keepAliveHandler = new Handler(Looper.getMainLooper());
    private final Runnable keepAliveRunnable = new Runnable() {
        @Override
        public void run() {
            sendKeepAliveBroadcast();
            keepAliveHandler.postDelayed(this, KEEP_ALIVE_INTERVAL_MS);
        }
    };
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

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
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, createNotification());
        acquireLocks();
        scheduleKeepAlive();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Keep running until explicitly stopped.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        keepAliveHandler.removeCallbacks(keepAliveRunnable);
        releaseLocks();
        stopForeground(true);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
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
}

