package org.eblusha.plus;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "IncomingCall")
public class IncomingCallPlugin extends Plugin {

    private static final int REQUEST_CODE_MANAGE_OWN_CALLS = 1002;

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

        Context context = getContext();
        if (context == null) {
            call.reject("Context is null");
            return;
        }

        if (!ensureCallPermissions(true)) {
            call.reject("MANAGE_OWN_CALLS permission is required");
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

    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        boolean granted = ensureCallPermissions(true);
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    private boolean ensureCallPermissions(boolean requestIfMissing) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            return true;
        }
        Context context = getContext();
        if (context == null) {
            return false;
        }
        boolean granted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.MANAGE_OWN_CALLS)
                == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            return true;
        }
        if (requestIfMissing) {
            Activity activity = getActivity();
            if (activity != null) {
                ActivityCompat.requestPermissions(
                    activity,
                    new String[]{Manifest.permission.MANAGE_OWN_CALLS},
                    REQUEST_CODE_MANAGE_OWN_CALLS
                );
            }
        }
        return false;
    }
}





