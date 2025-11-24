package org.eblusha.plus;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.TextView;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Нативный экран входящего звонка
 * Открывается как full-screen Activity при получении call:incoming события
 */
public class IncomingCallActivity extends AppCompatActivity {
    private static final String EXTRA_CONVERSATION_ID = "conversation_id";
    private static final String EXTRA_CALLER_NAME = "caller_name";
    private static final String EXTRA_IS_VIDEO = "is_video";
    private static final String EXTRA_AVATAR_URL = "avatar_url";

    private String conversationId;
    private String callerName;
    private boolean isVideo;
    private String avatarUrl;

    private static volatile IncomingCallActivity currentInstance;
    private final ExecutorService avatarExecutor = Executors.newSingleThreadExecutor();

    public static void dismissCurrent() {
        IncomingCallActivity instance = currentInstance;
        if (instance != null) {
            instance.runOnUiThread(instance::finish);
        }
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        currentInstance = this;
        super.onCreate(savedInstanceState);

        // Получаем данные из Intent
        Intent intent = getIntent();
        conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID);
        callerName = intent.getStringExtra(EXTRA_CALLER_NAME);
        isVideo = intent.getBooleanExtra(EXTRA_IS_VIDEO, false);
        avatarUrl = intent.getStringExtra(EXTRA_AVATAR_URL);

        if (conversationId == null) {
            finish();
            return;
        }

        // Настройка full-screen режима
        setupFullScreen();

        // Устанавливаем layout (будет создан отдельно)
        setContentView(R.layout.activity_incoming_call);

        // Инициализация UI
        initUI();
    }

    private void setupFullScreen() {
        // Показываем поверх блокировки экрана
        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
            WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD |
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON |
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        );

        // Full-screen режим
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_FULLSCREEN
        );
    }

    private void initUI() {
        TextView callerNameView = findViewById(R.id.caller_name);
        TextView callTypeView = findViewById(R.id.call_type);
        ImageView avatarView = findViewById(R.id.caller_avatar);
        ImageButton answerButton = findViewById(R.id.btn_answer);
        ImageButton answerVideoButton = findViewById(R.id.btn_answer_video);
        ImageButton declineButton = findViewById(R.id.btn_decline);

        if (callerNameView != null) {
            callerNameView.setText(callerName != null ? callerName : "Входящий звонок");
        }

        if (callTypeView != null) {
            callTypeView.setText(isVideo ? "Видеозвонок" : "Аудиозвонок");
        }

        loadAvatarAsync(avatarView);

        // Кнопка "Ответить" (аудио)
        if (answerButton != null) {
            answerButton.setOnClickListener(v -> {
                answerCall(false);
            });
        }

        // Кнопка "Ответить с видео"
        if (answerVideoButton != null) {
            answerVideoButton.setOnClickListener(v -> {
                answerCall(true);
            });
            // Скрываем кнопку для аудио звонков
            if (!isVideo) {
                answerVideoButton.setVisibility(View.GONE);
            }
        }

        // Кнопка "Отклонить"
        if (declineButton != null) {
            declineButton.setOnClickListener(v -> {
                declineCall();
            });
        }
    }

    private void answerCall(boolean withVideo) {
        // Отправляем событие в JavaScript через Capacitor
        IncomingCallService.accept(
            this,
            conversationId,
            callerName != null ? callerName : "Входящий звонок",
            isVideo,
            avatarUrl,
            withVideo
        );
        finish();
    }

    private void declineCall() {
        // Отправляем событие в JavaScript
        IncomingCallService.decline(
            this,
            conversationId,
            callerName != null ? callerName : "Входящий звонок",
            isVideo,
            avatarUrl
        );
        finish();
    }

    /**
     * Статический метод для открытия экрана входящего звонка
     */
    public static void show(Context context, String conversationId, String callerName,
                           boolean isVideo, @Nullable String avatarUrl) {
        Intent intent = new Intent(context, IncomingCallActivity.class);
        intent.putExtra(EXTRA_CONVERSATION_ID, conversationId);
        intent.putExtra(EXTRA_CALLER_NAME, callerName);
        intent.putExtra(EXTRA_IS_VIDEO, isVideo);
        if (avatarUrl != null) {
            intent.putExtra(EXTRA_AVATAR_URL, avatarUrl);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        context.startActivity(intent);
    }

    @Override
    public void onBackPressed() {
        // Блокируем кнопку "Назад" - можно только ответить или отклонить
        declineCall();
    }

    @Override
    public void onDestroy() {
        avatarExecutor.shutdownNow();
        currentInstance = null;
        super.onDestroy();
    }

    private void loadAvatarAsync(ImageView target) {
        if (avatarUrl == null || avatarUrl.isEmpty()) {
            return;
        }
        avatarExecutor.execute(() -> {
            Bitmap bitmap = downloadBitmap(avatarUrl);
            if (bitmap != null) {
                runOnUiThread(() -> target.setImageBitmap(bitmap));
            }
        });
    }

    private Bitmap downloadBitmap(String urlString) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(urlString);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(4000);
            connection.connect();
            if (connection.getResponseCode() >= 200 && connection.getResponseCode() < 300) {
                try (InputStream stream = connection.getInputStream()) {
                    return BitmapFactory.decodeStream(stream);
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
        return null;
    }
}

