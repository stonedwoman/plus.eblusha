package org.eblusha.plus;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
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

    @PluginMethod
    public void updateToken(PluginCall call) {
        String token = call.getString("token", null);
        saveToken(token);
        notifyServiceAboutToken(token);
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }

    private void saveToken(String token) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (TextUtils.isEmpty(token)) {
            prefs.edit().remove(KEY_TOKEN).apply();
        } else {
            prefs.edit().putString(KEY_TOKEN, token).apply();
        }
    }

    private void notifyServiceAboutToken(String token) {
        Context context = getContext();
        if (context == null) return;
        Intent intent = new Intent(ACTION_TOKEN_UPDATED);
        intent.putExtra("token", token);
        intent.setPackage(context.getPackageName());
        context.sendBroadcast(intent);
    }

    @NonNull
    static String getStoredToken(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return prefs.getString(KEY_TOKEN, "");
    }
}

