package org.eblusha.plus.plugins

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.eblusha.plus.MainActivity
import java.io.InputStream
import java.net.URL

@CapacitorPlugin(name = "MessageNotification")
class MessageNotificationPlugin : Plugin() {
    
    companion object {
        private const val CHANNEL_ID = "message_notifications_channel"
        private const val NOTIFICATION_ID_BASE = 2000
    }
    
    override fun load() {
        super.load()
        android.util.Log.d("MessageNotificationPlugin", "✅ Plugin loaded successfully")
    }
    
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Сообщения",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Уведомления о новых сообщениях"
                setShowBadge(true)
                enableVibration(true)
                enableLights(true)
            }
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
        }
    }
    
    @PluginMethod
    fun show(call: PluginCall) {
        android.util.Log.d("MessageNotificationPlugin", "show() called with call: ${call.data}")
        val id = call.getInt("id") ?: return call.reject("id is required")
        val conversationId = call.getString("conversationId") ?: return call.reject("conversationId is required")
        val senderName = call.getString("senderName") ?: return call.reject("senderName is required")
        val messageText = call.getString("messageText") ?: return call.reject("messageText is required")
        val avatarUrl = call.getString("avatarUrl")
        
        android.util.Log.d("MessageNotificationPlugin", "Showing notification: id=$id, conversationId=$conversationId, senderName=$senderName")
        createNotificationChannel()
        
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("action", "open_conversation")
            putExtra("conversation_id", conversationId)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        val notificationBuilder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(senderName)
            .setContentText(messageText)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setStyle(NotificationCompat.BigTextStyle().bigText(messageText))
        
        // Загружаем аватар, если указан
        if (!avatarUrl.isNullOrBlank()) {
            try {
                val bitmap = loadBitmapFromUrl(avatarUrl)
                if (bitmap != null) {
                    notificationBuilder.setLargeIcon(bitmap)
                }
            } catch (e: Exception) {
                android.util.Log.w("MessageNotificationPlugin", "Failed to load avatar", e)
            }
        }
        
        val notification = notificationBuilder.build()
        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notificationId = NOTIFICATION_ID_BASE + id
        notificationManager.notify(notificationId, notification)
        android.util.Log.d("MessageNotificationPlugin", "✅ Notification shown with ID: $notificationId")
        
        call.resolve()
    }
    
    @PluginMethod
    fun cancel(call: PluginCall) {
        val ids = call.getArray("ids")?.toList() ?: return call.reject("ids is required")
        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        
        ids.forEach { idObj ->
            val id = (idObj as? Number)?.toInt() ?: return@forEach
            notificationManager.cancel(NOTIFICATION_ID_BASE + id)
        }
        
        call.resolve()
    }
    
    @PluginMethod
    fun clear(call: PluginCall) {
        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.cancelAll()
        call.resolve()
    }
    
    private fun loadBitmapFromUrl(url: String): Bitmap? {
        return try {
            val connection = URL(url).openConnection()
            connection.connectTimeout = 3000
            connection.readTimeout = 3000
            val inputStream: InputStream = connection.getInputStream()
            BitmapFactory.decodeStream(inputStream)
        } catch (e: Exception) {
            android.util.Log.w("MessageNotificationPlugin", "Failed to load avatar from $url", e)
            null
        }
    }
}

