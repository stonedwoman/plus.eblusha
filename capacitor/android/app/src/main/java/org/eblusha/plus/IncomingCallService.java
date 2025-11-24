package org.eblusha.plus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.annotation.Nullable;

public class IncomingCallService extends Service {

    private static final String CHANNEL_ID = "incoming_calls_channel";
    private static final String CHANNEL_NAME = "Входящие звонки";
    private static final int NOTIFICATION_ID = 4001;

    private static final String ACTION_START_CALL = "org.eblusha.plus.action.START_CALL";
    private static final String ACTION_STOP_CALL = "org.eblusha.plus.action.STOP_CALL";

    private static final String EXTRA_CONVERSATION_ID = "conversation_id";
    private static final String EXTRA_CALLER_NAME = "caller_name";
    private static final String EXTRA_IS_VIDEO = "is_video";
    private static final String EXTRA_AVATAR_URL = "avatar_url";

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
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_STOP_CALL.equals(action)) {
            IncomingCallActivity.dismissCurrent();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!ACTION_START_CALL.equals(action)) {
            return START_NOT_STICKY;
        }

        String conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID);
        String callerName = intent.getStringExtra(EXTRA_CALLER_NAME);
        boolean isVideo = intent.getBooleanExtra(EXTRA_IS_VIDEO, false);
        String avatarUrl = intent.getStringExtra(EXTRA_AVATAR_URL);

        Notification notification = buildNotification(conversationId, callerName, isVideo, avatarUrl);
        startForeground(NOTIFICATION_ID, notification);
        launchFullScreenUi(conversationId, callerName, isVideo, avatarUrl);

        return START_STICKY;
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
}

