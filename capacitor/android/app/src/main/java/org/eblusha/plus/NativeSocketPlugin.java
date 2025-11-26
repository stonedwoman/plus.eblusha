package org.eblusha.plus;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.TextUtils;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeSocket")
public class NativeSocketPlugin extends Plugin {

    private static final String PREFS = "eblusha_native_socket";
    private static final String KEY_TOKEN = "access_token";
    private static final String ACTION_TOKEN_UPDATED = "org.eblusha.plus.ACTION_SOCKET_TOKEN_UPDATED";
    private static final int REQUEST_IGNORE_BATTERY_OPTIMIZATIONS = 1004;

    @PluginMethod
    public void updateToken(PluginCall call) {
        String token = call.getString("token", null);
        android.util.Log.d("NativeSocketPlugin", "updateToken() called, token length: " + (token != null ? token.length() : 0));
        if (TextUtils.isEmpty(token)) {
            android.util.Log.w("NativeSocketPlugin", "Token is empty or null");
        }
        saveToken(token);
        notifyServiceAboutToken(token);
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
        android.util.Log.d("NativeSocketPlugin", "✅ updateToken() completed");
    }

    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            JSObject result = new JSObject();
            result.put("granted", true);
            result.put("message", "Not required on this Android version");
            call.resolve(result);
            return;
        }

        Context context = getContext();
        if (context == null) {
            call.reject("Context is null");
            return;
        }

        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (pm == null) {
            call.reject("PowerManager is null");
            return;
        }

        String packageName = context.getPackageName();
        boolean isIgnoring = pm.isIgnoringBatteryOptimizations(packageName);
        
        if (isIgnoring) {
            JSObject result = new JSObject();
            result.put("granted", true);
            result.put("message", "Already granted");
            call.resolve(result);
            return;
        }

        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + packageName));
            getActivity().startActivityForResult(intent, REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            
            JSObject result = new JSObject();
            result.put("granted", false);
            result.put("message", "Permission dialog shown");
            call.resolve(result);
        } catch (Exception e) {
            android.util.Log.e("NativeSocketPlugin", "Failed to request battery optimization exemption", e);
            call.reject("Failed to show permission dialog: " + e.getMessage());
        }
    }

    private void saveToken(String token) {
        Context context = getContext();
        if (context == null) {
            android.util.Log.e("NativeSocketPlugin", "Context is null, cannot save token");
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (TextUtils.isEmpty(token)) {
            android.util.Log.d("NativeSocketPlugin", "Removing token from SharedPreferences");
            prefs.edit().remove(KEY_TOKEN).apply();
        } else {
            android.util.Log.d("NativeSocketPlugin", "Saving token to SharedPreferences, length: " + token.length());
            boolean saved = prefs.edit().putString(KEY_TOKEN, token).commit(); // Используем commit() для синхронного сохранения
            android.util.Log.d("NativeSocketPlugin", "Token saved: " + saved);
            // Проверяем, что токен действительно сохранился
            String savedToken = prefs.getString(KEY_TOKEN, "");
            android.util.Log.d("NativeSocketPlugin", "Verification: saved token length: " + savedToken.length());
        }
    }

    private void notifyServiceAboutToken(String token) {
        Context context = getContext();
        if (context == null) {
            android.util.Log.e("NativeSocketPlugin", "Context is null, cannot notify service");
            return;
        }
        android.util.Log.d("NativeSocketPlugin", "Sending token update broadcast to service");
        Intent intent = new Intent(ACTION_TOKEN_UPDATED);
        intent.putExtra("token", token);
        intent.setPackage(context.getPackageName());
        context.sendBroadcast(intent);
        android.util.Log.d("NativeSocketPlugin", "✅ Token update broadcast sent");
    }

    @NonNull
    static String getStoredToken(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return prefs.getString(KEY_TOKEN, "");
    }
}

