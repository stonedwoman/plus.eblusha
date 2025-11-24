package org.eblusha.plus;

import android.content.Context;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "IncomingCall")
public class IncomingCallPlugin extends Plugin {

    @PluginMethod
    public void showIncomingCall(PluginCall call) {
        String conversationId = call.getString("conversationId");
        String callerName = call.getString("callerName", "Входящий звонок");
        Boolean isVideo = call.getBoolean("isVideo", false);
        String avatarUrl = call.getString("avatarUrl");

        if (conversationId == null) {
            call.reject("conversationId is required");
            return;
        }

        // Открываем нативный экран входящего звонка
        Context context = getContext();
        if (context == null) {
            call.reject("Context is null");
            return;
        }

        IncomingCallService.start(context, conversationId, callerName, isVideo, avatarUrl);
        call.resolve();
    }

    @PluginMethod
    public void closeIncomingCall(PluginCall call) {
        Context context = getContext();
        if (context != null) {
            IncomingCallService.stop(context);
        }
        IncomingCallActivity.dismissCurrent();
        call.resolve();
    }
}





