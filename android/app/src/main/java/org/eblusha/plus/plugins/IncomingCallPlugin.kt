package org.eblusha.plus.plugins

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.eblusha.plus.service.IncomingCallService

@CapacitorPlugin(name = "IncomingCall")
class IncomingCallPlugin : Plugin() {

    @PluginMethod
    fun showIncomingCall(call: PluginCall) {
        val conversationId = call.getString("conversationId")
        if (conversationId.isNullOrBlank()) {
            call.reject("conversationId is required")
            return
        }

        val callerName = call.getString("callerName") ?: "Входящий звонок"
        val isVideo = call.getBoolean("isVideo") ?: false

        try {
            IncomingCallService.start(context, conversationId, callerName, isVideo)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to start IncomingCallService", e)
        }
    }

    @PluginMethod
    fun closeIncomingCall(call: PluginCall) {
        try {
            IncomingCallService.stop(context)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to stop IncomingCallService", e)
        }
    }
}

