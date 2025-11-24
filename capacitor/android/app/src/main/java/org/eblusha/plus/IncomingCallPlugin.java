package org.eblusha.plus;

import android.app.Activity;
import com.getcapacitor.JSObject;
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

        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }

        // Открываем нативный экран входящего звонка
        IncomingCallActivity.show(activity, conversationId, callerName, isVideo, avatarUrl);
        
        call.resolve();
    }

    @PluginMethod
    public void closeIncomingCall(PluginCall call) {
        // Закрываем Activity если она открыта
        Activity activity = getActivity();
        if (activity instanceof IncomingCallActivity) {
            activity.finish();
        }
        call.resolve();
    }
}





