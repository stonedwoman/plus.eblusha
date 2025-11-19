package org.eblusha.plus.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import org.eblusha.plus.MainActivity

class IncomingCallService : Service() {
    
    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    
    companion object {
        private const val CHANNEL_ID = "incoming_call_channel"
        private const val NOTIFICATION_ID = 1001
        private const val ACTION_ACCEPT = "org.eblusha.plus.ACTION_ACCEPT_CALL"
        private const val ACTION_DECLINE = "org.eblusha.plus.ACTION_DECLINE_CALL"
        
        private const val EXTRA_CONVERSATION_ID = "conversation_id"
        private const val EXTRA_CALLER_NAME = "caller_name"
        private const val EXTRA_IS_VIDEO = "is_video"
        
        fun start(context: Context, conversationId: String, callerName: String, isVideo: Boolean) {
            val intent = Intent(context, IncomingCallService::class.java).apply {
                putExtra(EXTRA_CONVERSATION_ID, conversationId)
                putExtra(EXTRA_CALLER_NAME, callerName)
                putExtra(EXTRA_IS_VIDEO, isVideo)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
        
        fun stop(context: Context) {
            context.stopService(Intent(context, IncomingCallService::class.java))
        }
    }
    
    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        
        // Initialize vibrator
        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vibratorManager.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        
        // Acquire wake lock
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "EblushaPlus:IncomingCall"
        ).apply {
            acquire(10 * 60 * 1000L) // 10 minutes timeout
        }
    }
    
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        
        val conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID) ?: return START_NOT_STICKY
        val callerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: "Входящий звонок"
        val isVideo = intent.getBooleanExtra(EXTRA_IS_VIDEO, false)
        
        when (intent.action) {
            ACTION_ACCEPT -> {
                stopRinging()
                // Navigate to call screen - handled by MainActivity
                val callIntent = Intent(this, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra("action", "accept_call")
                    putExtra("conversation_id", conversationId)
                    putExtra("is_video", isVideo)
                }
                startActivity(callIntent)
                stopSelf()
            }
            ACTION_DECLINE -> {
                stopRinging()
                // Notify RealtimeService to decline
                // This will be handled by MainActivity observing events
                stopSelf()
            }
            else -> {
                startRinging()
                showNotification(conversationId, callerName, isVideo)
            }
        }
        
        return START_NOT_STICKY
    }
    
    private fun startRinging() {
        // Start ringtone
        try {
            mediaPlayer = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .build()
                )
                setDataSource(this@IncomingCallService, android.provider.Settings.System.DEFAULT_RINGTONE_URI)
                isLooping = true
                setVolume(1.0f, 1.0f)
                prepare()
                start()
            }
        } catch (e: Exception) {
            android.util.Log.e("IncomingCallService", "Error starting ringtone", e)
        }
        
        // Start vibration pattern
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val pattern = longArrayOf(0, 1000, 500, 1000, 500, 1000)
            val amplitudes = intArrayOf(0, 255, 0, 255, 0, 255)
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, amplitudes, 0))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(longArrayOf(0, 1000, 500, 1000, 500, 1000), 0)
        }
    }
    
    private fun stopRinging() {
        mediaPlayer?.stop()
        mediaPlayer?.release()
        mediaPlayer = null
        vibrator?.cancel()
    }
    
    private fun showNotification(conversationId: String, callerName: String, isVideo: Boolean) {
        val acceptIntent = Intent(this, IncomingCallService::class.java).apply {
            action = ACTION_ACCEPT
            putExtra(EXTRA_CONVERSATION_ID, conversationId)
            putExtra(EXTRA_IS_VIDEO, isVideo)
        }
        val acceptPendingIntent = PendingIntent.getService(
            this,
            0,
            acceptIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        val declineIntent = Intent(this, IncomingCallService::class.java).apply {
            action = ACTION_DECLINE
            putExtra(EXTRA_CONVERSATION_ID, conversationId)
        }
        val declinePendingIntent = PendingIntent.getService(
            this,
            1,
            declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        val fullScreenIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("action", "incoming_call")
            putExtra("conversation_id", conversationId)
            putExtra("caller_name", callerName)
            putExtra("is_video", isVideo)
        }
        val fullScreenPendingIntent = PendingIntent.getActivity(
            this,
            0,
            fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(if (isVideo) "Входящий видеозвонок" else "Входящий звонок")
            .setContentText(callerName)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .addAction(android.R.drawable.ic_menu_call, "Принять", acceptPendingIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Отклонить", declinePendingIntent)
            .setOngoing(true)
            .setAutoCancel(false)
            .build()
        
        startForeground(NOTIFICATION_ID, notification)
    }
    
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Входящие звонки",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Уведомления о входящих звонках"
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }
    
    override fun onDestroy() {
        super.onDestroy()
        stopRinging()
        wakeLock?.release()
        wakeLock = null
    }
    
    override fun onBind(intent: Intent?) = null
}

