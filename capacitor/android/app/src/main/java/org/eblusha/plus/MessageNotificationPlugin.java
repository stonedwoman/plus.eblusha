package org.eblusha.plus;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "MessageNotification")
public class MessageNotificationPlugin extends Plugin {

    private static final String CHANNEL_ID = "eblusha_messages";
    private static final String CHANNEL_NAME = "Messages";
    private static final String CHANNEL_DESCRIPTION = "Incoming chat messages";
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private NotificationManagerCompat notificationManager;

    @Override
    public void load() {
        super.load();
        notificationManager = NotificationManagerCompat.from(getContext());
        ensureChannel();
    }

    @PluginMethod
    public void show(PluginCall call) {
        Integer id = call.getInt("id");
        String conversationId = call.getString("conversationId");
        String senderName = call.getString("senderName", "Новое сообщение");
        String messageText = call.getString("messageText", "У вас новое сообщение");
        String avatarUrl = call.getString("avatarUrl");

        if (id == null || conversationId == null) {
            call.reject("Missing notification id or conversationId");
            return;
        }

        executor.execute(() -> {
            Bitmap avatar = loadAvatarBitmap(avatarUrl);
            showNotificationInternal(id, conversationId, senderName, messageText, avatar);
            call.resolve();
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        JSArray idsArray = call.getArray("ids");
        if (idsArray == null) {
            call.reject("ids array is required");
            return;
        }
        List<Integer> ids = new ArrayList<>();
        try {
            for (Object value : idsArray.toList()) {
                if (value instanceof Number) {
                    ids.add(((Number) value).intValue());
                } else if (value instanceof String) {
                    ids.add(Integer.parseInt((String) value));
                }
            }
        } catch (JSONException | NumberFormatException e) {
            call.reject("Invalid id value", e);
            return;
        }

        for (int id : ids) {
            notificationManager.cancel(id);
        }
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        notificationManager.cancelAll();
        call.resolve();
    }

    private void showNotificationInternal(
        int id,
        String conversationId,
        String senderName,
        String messageText,
        @Nullable Bitmap avatar
    ) {
        ensureChannel();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(senderName)
            .setContentText(messageText)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setGroup("conversation_" + conversationId);

        Person.Builder personBuilder = new Person.Builder().setName(senderName);
        if (avatar != null) {
            personBuilder.setIcon(IconCompat.createWithBitmap(avatar));
            builder.setLargeIcon(avatar);
        }
        Person person = personBuilder.build();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(person)
            .addMessage(messageText, System.currentTimeMillis(), person);
        builder.setStyle(style);

        PendingIntent intent = buildContentIntent(conversationId, id);
        builder.setContentIntent(intent);

        notificationManager.notify(id, builder.build());
    }

    private PendingIntent buildContentIntent(String conversationId, int requestCode) {
        Context context = getContext();
        Intent intent;
        if (getActivity() != null) {
            intent = new Intent(context, getActivity().getClass());
        } else {
            String packageName = context.getPackageName();
            intent = context.getPackageManager().getLaunchIntentForPackage(packageName);
            if (intent == null) {
                intent = new Intent(packageName + ".MAIN");
            }
        }
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("conversationId", conversationId);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_MUTABLE;
        }

        return PendingIntent.getActivity(getContext(), requestCode, intent, flags);
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager =
                (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
            if (channel == null) {
                channel = new NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
                channel.setDescription(CHANNEL_DESCRIPTION);
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Bitmap loadAvatarBitmap(@Nullable String avatarUrl) {
        if (avatarUrl == null || avatarUrl.isEmpty()) {
            return null;
        }
        HttpURLConnection connection = null;
        try {
            URL url = new URL(avatarUrl);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(4000);
            connection.connect();
            if (connection.getResponseCode() >= 200 && connection.getResponseCode() < 300) {
                try (InputStream stream = connection.getInputStream()) {
                    return BitmapFactory.decodeStream(stream);
                }
            }
        } catch (Exception ex) {
            Logger.error("MessageNotification", "Failed to load avatar: " + ex.getMessage(), null);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
        return null;
    }
}

