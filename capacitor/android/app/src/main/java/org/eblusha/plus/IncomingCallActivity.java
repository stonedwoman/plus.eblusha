package org.eblusha.plus;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.TextView;
import androidx.annotation.Nullable;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;

/**
 * Нативный экран входящего звонка
 * Открывается как full-screen Activity при получении call:incoming события
 */
public class IncomingCallActivity extends BridgeActivity {
    private static final String EXTRA_CONVERSATION_ID = "conversation_id";
    private static final String EXTRA_CALLER_NAME = "caller_name";
    private static final String EXTRA_IS_VIDEO = "is_video";
    private static final String EXTRA_AVATAR_URL = "avatar_url";

    private String conversationId;
    private String callerName;
    private boolean isVideo;
    private String avatarUrl;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
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
        Button answerButton = findViewById(R.id.btn_answer);
        Button answerVideoButton = findViewById(R.id.btn_answer_video);
        Button declineButton = findViewById(R.id.btn_decline);

        if (callerNameView != null) {
            callerNameView.setText(callerName != null ? callerName : "Входящий звонок");
        }

        if (callTypeView != null) {
            callTypeView.setText(isVideo ? "Видеозвонок" : "Аудиозвонок");
        }

        // TODO: Загрузить аватар из avatarUrl

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
        try {
            if (bridge != null && bridge.getWebView() != null) {
                String js = String.format(
                    "if (window.handleIncomingCallAnswer) { window.handleIncomingCallAnswer('%s', %s); }",
                    conversationId, withVideo
                );
                bridge.getWebView().evaluateJavascript(js, null);
            }
        } catch (Exception e) {
            e.printStackTrace();
        }

        // Закрываем Activity
        finish();
    }

    private void declineCall() {
        // Отправляем событие в JavaScript
        try {
            if (bridge != null && bridge.getWebView() != null) {
                String js = String.format(
                    "if (window.handleIncomingCallDecline) { window.handleIncomingCallDecline('%s'); }",
                    conversationId
                );
                bridge.getWebView().evaluateJavascript(js, null);
            }
        } catch (Exception e) {
            e.printStackTrace();
        }

        // Закрываем Activity
        finish();
    }

    /**
     * Статический метод для открытия экрана входящего звонка
     */
    public static void show(Activity activity, String conversationId, String callerName, 
                           boolean isVideo, @Nullable String avatarUrl) {
        Intent intent = new Intent(activity, IncomingCallActivity.class);
        intent.putExtra(EXTRA_CONVERSATION_ID, conversationId);
        intent.putExtra(EXTRA_CALLER_NAME, callerName);
        intent.putExtra(EXTRA_IS_VIDEO, isVideo);
        if (avatarUrl != null) {
            intent.putExtra(EXTRA_AVATAR_URL, avatarUrl);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        activity.startActivity(intent);
    }

    @Override
    public void onBackPressed() {
        // Блокируем кнопку "Назад" - можно только ответить или отклонить
        declineCall();
    }
}

