package org.eblusha.plus.data.realtime

import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import org.eblusha.plus.core.config.AppConfig
import org.eblusha.plus.data.network.InMemoryAccessTokenProvider
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicBoolean

class RealtimeService(
    private val appConfig: AppConfig,
    private val tokenProvider: InMemoryAccessTokenProvider,
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _connectionState = MutableStateFlow(ConnectionState.Disconnected)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _events = MutableSharedFlow<RealtimeEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<RealtimeEvent> = _events.asSharedFlow()

    private var socket: Socket? = null
    private val connecting = AtomicBoolean(false)

    init {
        scope.launch {
            tokenProvider.token.collectLatest { token ->
                if (token.isNullOrBlank()) {
                    disconnectInternal()
                } else {
                    connectInternal(token)
                }
            }
        }
    }

    fun joinConversation(conversationId: String) {
        socket?.emit("conversation:join", conversationId)
    }

    fun leaveConversation(conversationId: String) {
        socket?.emit("conversation:leave", conversationId)
    }

    fun setTyping(conversationId: String, typing: Boolean) {
        val payload = JSONObject()
            .put("conversationId", conversationId)
            .put("typing", typing)
        socket?.emit("conversation:typing", payload)
    }

    fun inviteCall(conversationId: String, video: Boolean) {
        val payload = JSONObject()
            .put("conversationId", conversationId)
            .put("video", video)
        socket?.emit("call:invite", payload)
    }

    fun acceptCall(conversationId: String, video: Boolean) {
        val payload = JSONObject()
            .put("conversationId", conversationId)
            .put("video", video)
        socket?.emit("call:accept", payload)
    }

    fun declineCall(conversationId: String) {
        socket?.emit("call:decline", JSONObject().put("conversationId", conversationId))
    }

    fun endCall(conversationId: String) {
        socket?.emit("call:end", JSONObject().put("conversationId", conversationId))
    }

    fun requestCallStatuses(conversationIds: List<String>) {
        if (conversationIds.isEmpty()) return
        val idsArray = JSONArray()
        conversationIds.forEach(idsArray::put)
        val payload = JSONObject().put("conversationIds", idsArray)
        socket?.emit("call:status:request", payload)
    }

    fun joinCallRoom(conversationId: String, video: Boolean? = null) {
        val payload = JSONObject().put("conversationId", conversationId)
        video?.let { payload.put("video", it) }
        socket?.emit("call:room:join", payload)
    }

    fun leaveCallRoom(conversationId: String) {
        socket?.emit("call:room:leave", JSONObject().put("conversationId", conversationId))
    }

    fun offerSecretChat(conversationId: String) {
        socket?.emit("secret:chat:offer", JSONObject().put("conversationId", conversationId))
    }

    fun acceptSecretChat(conversationId: String, deviceId: String) {
        val payload = JSONObject()
            .put("conversationId", conversationId)
            .put("deviceId", deviceId)
        socket?.emit("secret:chat:accept", payload)
    }

    fun declineSecretChat(conversationId: String) {
        socket?.emit("secret:chat:decline", JSONObject().put("conversationId", conversationId))
    }

    fun disconnect() {
        scope.launch { disconnectInternal() }
    }

    private fun connectInternal(token: String) {
        if (connecting.get()) return
        val current = socket
        if (current != null && current.connected() && current.io()?.reconnection()) {
            // refresh auth
            current.io().auth = mapOf("token" to token)
            _connectionState.tryEmit(ConnectionState.Connected)
            return
        }

        connecting.set(true)
        scope.launch {
            try {
                disconnectInternal()
                val opts = IO.Options.builder()
                    .setReconnection(true)
                    .setForceNew(true)
                    .setTransports(arrayOf("websocket"))
                    .build()
                val encodedToken = URLEncoder.encode(token, Charsets.UTF_8.name())
                opts.query = "token=$encodedToken"
                opts.auth = mapOf("token" to token)
                val newSocket = IO.socket(appConfig.socketBaseUrl, opts)
                socket = newSocket
                registerCallbacks(newSocket)
                newSocket.connect()
            } catch (error: Throwable) {
                _connectionState.tryEmit(ConnectionState.Disconnected(error.message))
            } finally {
                connecting.set(false)
            }
        }
    }

    private suspend fun disconnectInternal() {
        socket?.let { s ->
            s.off()
            s.disconnect()
            s.close()
        }
        socket = null
        _connectionState.emit(ConnectionState.Disconnected())
    }

    private fun registerCallbacks(socket: Socket) {
        socket.on(Socket.EVENT_CONNECT) {
            _connectionState.tryEmit(ConnectionState.Connected)
        }
        socket.on(Socket.EVENT_DISCONNECT) { args ->
            val reason = args.firstOrNull()?.toString()
            _connectionState.tryEmit(ConnectionState.Disconnected(reason))
        }
        socket.on(Socket.EVENT_CONNECT_ERROR) { args ->
            val reason = args.firstOrNull()?.toString()
            _connectionState.tryEmit(ConnectionState.Disconnected(reason))
        }

        socket.on("presence:update") { args ->
            args.firstOrNull()?.toJsonObject()?.let { json ->
                val event = RealtimeEvent.PresenceUpdate(
                    userId = json.optString("userId"),
                    status = json.optString("status")
                )
                _events.tryEmit(event)
            }
        }

        socket.on("call:incoming") { args ->
            args.firstOrNull()?.toJsonObject()?.let { json ->
                val fromObj = json.optJSONObject("from")
                val event = RealtimeEvent.CallIncoming(
                    conversationId = json.optString("conversationId"),
                    fromUserId = fromObj?.optString("id").orEmpty(),
                    fromName = fromObj?.optString("name").orEmpty(),
                    video = json.optBoolean("video", false)
                )
                _events.tryEmit(event)
            }
        }

        socket.on("call:status") { args ->
            args.firstOrNull()?.toJsonObject()?.let { json ->
                val event = RealtimeEvent.CallStatus(
                    conversationId = json.optString("conversationId"),
                    active = json.optBoolean("active", false),
                    startedAt = json.optLongOrNull("startedAt"),
                    elapsedMs = json.optLongOrNull("elapsedMs"),
                    participants = json.optJSONArray("participants")?.toStringList().orEmpty()
                )
                _events.tryEmit(event)
            }
        }

        socket.on("call:status:bulk") { args ->
            args.firstOrNull()?.toJsonObject()?.optJSONObject("statuses")?.let { statuses ->
                val map = mutableMapOf<String, RealtimeEvent.CallStatus>()
                statuses.keys().forEach { key ->
                    val value = statuses.optJSONObject(key) ?: return@forEach
                    map[key] = RealtimeEvent.CallStatus(
                        conversationId = value.optString("conversationId", key),
                        active = value.optBoolean("active", false),
                        startedAt = value.optLongOrNull("startedAt"),
                        elapsedMs = value.optLongOrNull("elapsedMs"),
                        participants = value.optJSONArray("participants")?.toStringList().orEmpty()
                    )
                }
                _events.tryEmit(RealtimeEvent.CallStatusBulk(map))
            }
        }

        socket.on("conversation:typing") { args ->
            args.firstOrNull()?.toJsonObject()?.let { json ->
                val event = RealtimeEvent.Typing(
                    conversationId = json.optString("conversationId"),
                    userId = json.optString("userId"),
                    typing = json.optBoolean("typing", false)
                )
                _events.tryEmit(event)
            }
        }

        socket.on("secret:chat:offer") { args ->
            args.firstOrNull()?.toJsonObject()?.let { json ->
                val from = json.optJSONObject("from")
                _events.tryEmit(
                    RealtimeEvent.SecretChatOffer(
                        conversationId = json.optString("conversationId"),
                        fromUserId = from?.optString("id").orEmpty(),
                        fromName = from?.optString("name").orEmpty(),
                        deviceId = from?.optString("deviceId")
                    )
                )
            }
        }

        socket.on("secret:chat:accepted") { args ->
            args.firstOrNull()?.toJsonObject()?.let { json ->
                _events.tryEmit(
                    RealtimeEvent.SecretChatAccepted(
                        conversationId = json.optString("conversationId"),
                        peerDeviceId = json.optString("peerDeviceId")
                    )
                )
            }
        }
    }

    private fun Any?.toJsonObject(): JSONObject? = when (this) {
        is JSONObject -> this
        is String -> runCatching { JSONObject(this) }.getOrNull()
        else -> null
    }

    private fun JSONObject.optLongOrNull(key: String): Long? =
        if (has(key) && !isNull(key)) optLong(key) else null

    private fun JSONArray.toStringList(): List<String> =
        (0 until length()).mapNotNull { index -> optString(index, null) }
}

sealed interface ConnectionState {
    data object Connected : ConnectionState
    data class Disconnected(val reason: String? = null) : ConnectionState
}

sealed interface RealtimeEvent {
    data class PresenceUpdate(val userId: String, val status: String) : RealtimeEvent
    data class Typing(val conversationId: String, val userId: String, val typing: Boolean) : RealtimeEvent
    data class CallIncoming(val conversationId: String, val fromUserId: String, val fromName: String, val video: Boolean) : RealtimeEvent
    data class CallStatus(
        val conversationId: String,
        val active: Boolean,
        val startedAt: Long? = null,
        val elapsedMs: Long? = null,
        val participants: List<String> = emptyList(),
    ) : RealtimeEvent
    data class CallStatusBulk(val statuses: Map<String, CallStatus>) : RealtimeEvent
    data class SecretChatOffer(val conversationId: String, val fromUserId: String, val fromName: String, val deviceId: String?) : RealtimeEvent
    data class SecretChatAccepted(val conversationId: String, val peerDeviceId: String) : RealtimeEvent
}

