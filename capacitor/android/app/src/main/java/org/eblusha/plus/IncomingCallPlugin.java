package org.eblusha.plus;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "IncomingCall")
public class IncomingCallPlugin extends Plugin {

    private static final int REQUEST_CODE_NOTIFICATIONS = 1002;
    private static final int REQUEST_CODE_AUDIO_VIDEO = 1003;

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

        ensureNotificationPermission(false);
        ensureAudioVideoPermissions(false);
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
        boolean notificationGranted = ensureNotificationPermission(true);
        boolean mediaGranted = ensureAudioVideoPermissions(true);
        boolean granted = notificationGranted && mediaGranted;
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void ensureBackgroundExecution(PluginCall call) {
        boolean granted = ensureBatteryOptimizationExemption(true);
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    private boolean ensureNotificationPermission(boolean requestIfMissing) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        Context context = getContext();
        if (context == null) {
            return false;
        }
        boolean granted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        if (granted || !requestIfMissing) {
            return granted;
        }
        Activity activity = getActivity();
        if (activity != null) {
            ActivityCompat.requestPermissions(
                activity,
                new String[]{Manifest.permission.POST_NOTIFICATIONS},
                REQUEST_CODE_NOTIFICATIONS
            );
        }
        return false;
    }

    private boolean ensureAudioVideoPermissions(boolean requestIfMissing) {
        Context context = getContext();
        if (context == null) {
            return false;
        }

        boolean audioGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
        boolean cameraGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;

        if ((audioGranted && cameraGranted) || !requestIfMissing) {
            return audioGranted && cameraGranted;
        }

        Activity activity = getActivity();
        if (activity != null) {
            ActivityCompat.requestPermissions(
                activity,
                new String[] { Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA },
                REQUEST_CODE_AUDIO_VIDEO
            );
        }

        return false;
    }

    private boolean ensureBatteryOptimizationExemption(boolean requestIfMissing) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        Context context = getContext();
        if (context == null) {
            return false;
        }
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName())) {
            return true;
        }
        if (requestIfMissing) {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        }
        return false;
    }
}
