package org.eblusha.plus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

public class IncomingCallService extends Service {

    private static final String TAG = "IncomingCallService";

    private static final String CHANNEL_ID = "incoming_calls_channel";
    private static final String CHANNEL_NAME = "Входящие звонки";
    private static final int NOTIFICATION_ID = 4001;

    private static final String ACTION_START_CALL = "org.eblusha.plus.action.START_CALL";
    private static final String ACTION_STOP_CALL = "org.eblusha.plus.action.STOP_CALL";

    private static final String EXTRA_CONVERSATION_ID = "conversation_id";
    private static final String EXTRA_CALLER_NAME = "caller_name";
    private static final String EXTRA_IS_VIDEO = "is_video";
    private static final String EXTRA_AVATAR_URL = "avatar_url";

    private MediaPlayer mediaPlayer;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;

    private String activeConversationId;
    private boolean activeIsVideo;
    private String activeCallerName;
    private String activeAvatarUrl;

    public static void start(
        Context context,
        String conversationId,
        String callerName,
        boolean isVideo,
        @Nullable String avatarUrl
    ) {
        Intent intent = new Intent(context, IncomingCallService.class);
        intent.setAction(ACTION_START_CALL);
        intent.putExtra(EXTRA_CONVERSATION_ID, conversationId);
        intent.putExtra(EXTRA_CALLER_NAME, callerName);
        intent.putExtra(EXTRA_IS_VIDEO, isVideo);
        intent.putExtra(EXTRA_AVATAR_URL, avatarUrl);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        Intent intent = new Intent(context, IncomingCallService.class);
        intent.setAction(ACTION_STOP_CALL);
        context.startService(intent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        initVibrator();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_STOP_CALL.equals(action)) {
            stopAlerting();
            IncomingCallActivity.dismissCurrent();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!ACTION_START_CALL.equals(action)) {
            return START_NOT_STICKY;
        }

        activeConversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID);
        activeCallerName = intent.getStringExtra(EXTRA_CALLER_NAME);
        activeIsVideo = intent.getBooleanExtra(EXTRA_IS_VIDEO, false);
        activeAvatarUrl = intent.getStringExtra(EXTRA_AVATAR_URL);

        Notification notification = buildNotification(
            activeConversationId,
            activeCallerName,
            activeIsVideo,
            activeAvatarUrl
        );
        startAlerting();
        startForeground(NOTIFICATION_ID, notification);
        launchFullScreenUi(activeConversationId, activeCallerName, activeIsVideo, activeAvatarUrl);

        return START_STICKY;
    }

    private void startAlerting() {
        acquireWakeLock();
        startRingtone();
        startVibration();
    }

    private void stopAlerting() {
        releaseWakeLock();
        stopRingtone();
        stopVibration();
    }

    private void startRingtone() {
        try {
            stopRingtone();
            mediaPlayer = new MediaPlayer();
            mediaPlayer.setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            );
            Uri ringtoneUri = Settings.System.DEFAULT_RINGTONE_URI;
            mediaPlayer.setDataSource(this, ringtoneUri);
            mediaPlayer.setLooping(true);
            mediaPlayer.setVolume(1.0f, 1.0f);
            mediaPlayer.prepare();
            mediaPlayer.start();
        } catch (Exception ex) {
            Log.e(TAG, "Failed to start ringtone", ex);
            stopRingtone();
        }
    }

    private void stopRingtone() {
        if (mediaPlayer != null) {
            try {
                mediaPlayer.stop();
            } catch (Exception ignored) { }
            mediaPlayer.reset();
            mediaPlayer.release();
            mediaPlayer = null;
        }
    }

    private void initVibrator() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager vibratorManager =
                (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            if (vibratorManager != null) {
                vibrator = vibratorManager.getDefaultVibrator();
            }
        } else {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        }
    }

    private void startVibration() {
        if (vibrator == null) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            long[] timings = new long[]{0, 1000, 500, 1000, 500, 1200};
            int[] amplitudes = new int[]{0, 255, 0, 255, 0, 255};
            VibrationEffect effect = VibrationEffect.createWaveform(timings, amplitudes, 0);
            vibrator.vibrate(effect);
        } else {
            vibrator.vibrate(new long[]{0, 1000, 500, 1000}, 0);
        }
    }

    private void stopVibration() {
        if (vibrator != null) {
            vibrator.cancel();
        }
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) {
            return;
        }
        wakeLock = powerManager.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                | PowerManager.ACQUIRE_CAUSES_WAKEUP
                | PowerManager.ON_AFTER_RELEASE,
            TAG + ":WakeLock"
        );
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(60_000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    private void launchFullScreenUi(
        String conversationId,
        String callerName,
        boolean isVideo,
        @Nullable String avatarUrl
    ) {
        Intent fullScreenIntent = new Intent(this, IncomingCallActivity.class);
        fullScreenIntent.putExtra(EXTRA_CONVERSATION_ID, conversationId);
        fullScreenIntent.putExtra(EXTRA_CALLER_NAME, callerName);
        fullScreenIntent.putExtra(EXTRA_IS_VIDEO, isVideo);
        fullScreenIntent.putExtra(EXTRA_AVATAR_URL, avatarUrl);
        fullScreenIntent.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP
        );
        startActivity(fullScreenIntent);
    }

    private Notification buildNotification(
        String conversationId,
        String callerName,
        boolean isVideo,
        @Nullable String avatarUrl
    ) {
        Intent fullScreenIntent = new Intent(this, IncomingCallActivity.class);
        fullScreenIntent.putExtra(EXTRA_CONVERSATION_ID, conversationId);
        fullScreenIntent.putExtra(EXTRA_CALLER_NAME, callerName);
        fullScreenIntent.putExtra(EXTRA_IS_VIDEO, isVideo);
        fullScreenIntent.putExtra(EXTRA_AVATAR_URL, avatarUrl);

        PendingIntent fullScreenPendingIntent = PendingIntent.getActivity(
            this,
            0,
            fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(isVideo ? "Входящий видеозвонок" : "Входящий звонок")
            .setContentText(callerName != null ? callerName : "Неизвестный абонент")
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOngoing(true)
            .setAutoCancel(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                NotificationChannel existing = manager.getNotificationChannel(CHANNEL_ID);
                if (existing == null) {
                    NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID,
                        CHANNEL_NAME,
                        NotificationManager.IMPORTANCE_HIGH
                    );
                    channel.setDescription("Уведомления о входящих звонках");
                    channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
                    AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build();
                    channel.setSound(Settings.System.DEFAULT_RINGTONE_URI, attrs);
                    channel.enableVibration(true);
                    manager.createNotificationChannel(channel);
                }
            }
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopAlerting();
        super.onDestroy();
    }
}

