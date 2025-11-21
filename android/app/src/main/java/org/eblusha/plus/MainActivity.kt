package org.eblusha.plus

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.core.content.ContextCompat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import kotlinx.coroutines.flow.firstOrNull
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import kotlin.math.roundToInt
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.feature.chats.ConversationPreview
import org.eblusha.plus.ui.chats.ChatsRoute
import org.eblusha.plus.ui.chatdetail.ChatRoute
import org.eblusha.plus.ui.call.IncomingCallScreen
import org.eblusha.plus.ui.call.CallOverlayHost
import org.eblusha.plus.ui.theme.EblushaPlusTheme
import org.eblusha.plus.feature.session.SessionUiState
import org.eblusha.plus.feature.session.SessionUser
import org.eblusha.plus.feature.session.SessionViewModel
import org.eblusha.plus.feature.session.SessionViewModelFactory
import org.eblusha.plus.data.realtime.RealtimeEvent
import org.eblusha.plus.service.IncomingCallService

data class ActiveCallSession(
    val conversationId: String,
    val isVideo: Boolean,
    val isGroup: Boolean,
)

class CallOverlayHandle internal constructor(
    private val hangUpAction: () -> Unit,
) {
    fun hangUp() = hangUpAction()
}

class MainActivity : ComponentActivity() {
    private val container: AppContainer by lazy { (application as EblushaApp).container }
    private val sessionViewModel: SessionViewModel by viewModels {
        SessionViewModelFactory(container)
    }
    
    // Request permissions on app startup
    private val requestPermissionsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val audioGranted = permissions[Manifest.permission.RECORD_AUDIO] ?: false
        val cameraGranted = permissions[Manifest.permission.CAMERA] ?: false
        android.util.Log.d("MainActivity", "Permissions result: audio=$audioGranted, camera=$cameraGranted")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Request permissions on first launch
        val permissionsToRequest = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permissionsToRequest.add(Manifest.permission.RECORD_AUDIO)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            permissionsToRequest.add(Manifest.permission.CAMERA)
        }
        if (permissionsToRequest.isNotEmpty()) {
            android.util.Log.d("MainActivity", "Requesting permissions on startup: $permissionsToRequest")
            requestPermissionsLauncher.launch(permissionsToRequest.toTypedArray())
        }
        
        setContent {
            val state by sessionViewModel.uiState.collectAsStateWithLifecycle()
            val activeCallState = remember { mutableStateOf<ActiveCallSession?>(null) }
            val isCallMinimizedState = rememberSaveable { mutableStateOf(false) }
            val callHandleState = remember { mutableStateOf<CallOverlayHandle?>(null) }
            EblushaPlusTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    SessionScreen(
                        container = container,
                        state = state,
                        onSubmitToken = sessionViewModel::submitToken,
                        onLogin = sessionViewModel::login,
                        onRefresh = sessionViewModel::refresh,
                        onLogout = sessionViewModel::logout,
                        activeCall = activeCallState.value,
                        isCallMinimized = isCallMinimizedState.value,
                        callHandle = callHandleState.value,
                        onStartCall = { session ->
                            activeCallState.value = session
                            isCallMinimizedState.value = false
                        },
                        onCallSessionEnded = {
                            activeCallState.value = null
                            isCallMinimizedState.value = false
                            callHandleState.value = null
                        },
                        onMinimizeChange = { minimized -> isCallMinimizedState.value = minimized },
                        onHandleChange = { handle -> callHandleState.value = handle }
                    )
                }
            }
        }
    }
}

@Composable
private fun SessionScreen(
    container: AppContainer,
    state: SessionUiState,
    onSubmitToken: (String) -> Unit,
    onLogin: (String, String) -> Unit,
    onRefresh: () -> Unit,
    onLogout: () -> Unit,
    activeCall: ActiveCallSession?,
    isCallMinimized: Boolean,
    callHandle: CallOverlayHandle?,
    onStartCall: (ActiveCallSession) -> Unit,
    onCallSessionEnded: () -> Unit,
    onMinimizeChange: (Boolean) -> Unit,
    onHandleChange: (CallOverlayHandle?) -> Unit,
) {
    val shouldCloseCall = state !is SessionUiState.LoggedIn && activeCall != null
    LaunchedEffect(shouldCloseCall) {
        if (shouldCloseCall) {
            onCallSessionEnded()
        }
    }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        when (state) {
            SessionUiState.Loading -> CircularProgressIndicator()
            SessionUiState.LoggedOut -> LoggedOutContent(container, onLogin, onSubmitToken)
            is SessionUiState.Error -> ErrorContent(state.message, onRefresh, onLogout)
            is SessionUiState.LoggedIn -> {
                Box(modifier = Modifier.fillMaxSize()) {
                    MessengerNavHost(
                        container = container,
                        user = state.user,
                        onLogout = onLogout,
                        activeCall = activeCall,
                        isCallMinimized = isCallMinimized,
                        callHandle = callHandle,
                        onStartCall = onStartCall,
                        onMinimizeChange = onMinimizeChange,
                    )
                    activeCall?.let { session ->
                        CallOverlayHost(
                            container = container,
                            currentUser = state.user,
                            session = session,
                            isVisible = !isCallMinimized,
                            onRequestMinimize = { onMinimizeChange(true) },
                            onHandleReady = onHandleChange,
                            onClose = onCallSessionEnded
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MessengerNavHost(
    container: AppContainer,
    user: SessionUser,
    onLogout: () -> Unit,
    activeCall: ActiveCallSession?,
    isCallMinimized: Boolean,
    callHandle: CallOverlayHandle?,
    onStartCall: (ActiveCallSession) -> Unit,
    onMinimizeChange: (Boolean) -> Unit,
) {
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current
    val screenWidth = configuration.screenWidthDp.dp
    val screenWidthPx = with(density) { screenWidth.toPx() }
    
    // Mobile slider state
    var selectedConversation by rememberSaveable { mutableStateOf<ConversationPreview?>(null) }
    var sliderOffset by remember { mutableStateOf(0f) }
    var isDragging by remember { mutableStateOf(false) }
    
    // Calculate current panel (0 = list, 1 = chat)
    val currentPanel = if (selectedConversation != null) 1 else 0
    val targetOffset = if (currentPanel == 1) -1f else 0f
    
    // Animate to target offset when not dragging
    val animatedOffset by animateFloatAsState(
        targetValue = if (isDragging) sliderOffset else targetOffset,
        animationSpec = tween(durationMillis = 300),
        label = "slider_offset"
    )
    
    // Handle incoming calls - show incoming call screen
    data class IncomingCallUi(val event: RealtimeEvent.CallIncoming, val avatarUrl: String?)
    var incomingCall by remember { mutableStateOf<IncomingCallUi?>(null) }
    val context = androidx.compose.ui.platform.LocalContext.current
    
    androidx.compose.runtime.LaunchedEffect(Unit) {
        container.realtimeService.events.collect { event ->
            when (event) {
                is RealtimeEvent.CallIncoming -> {
                    android.util.Log.d("MainActivity", "Incoming call: ${event.conversationId}, from: ${event.fromName}, video: ${event.video}")
                    // Start foreground service for native call experience
                    IncomingCallService.start(
                        context = context,
                        conversationId = event.conversationId,
                        callerName = event.fromName,
                        isVideo = event.video
                    )
                    incomingCall = IncomingCallUi(event, avatarUrl = null)
                }
                is RealtimeEvent.CallStatus -> {
                    // Stop service when call ends
                    if (event.conversationId == incomingCall?.event?.conversationId && !event.active) {
                        IncomingCallService.stop(context)
                        incomingCall = null
                    }
                }
                is RealtimeEvent.CallAccepted -> {
                    android.util.Log.d("MainActivity", "Call accepted: ${event.conversationId} by ${event.byUserId}")
                    if (event.conversationId == incomingCall?.event?.conversationId) {
                        IncomingCallService.stop(context)
                        onStartCall(
                            ActiveCallSession(
                                conversationId = event.conversationId,
                                isVideo = event.video,
                                isGroup = false
                            )
                        )
                        incomingCall = null
                    }
                }
                is RealtimeEvent.CallDeclined -> {
                    android.util.Log.d("MainActivity", "Call declined: ${event.conversationId} by ${event.byUserId}")
                    // Stop service if this is our incoming call
                    if (event.conversationId == incomingCall?.event?.conversationId) {
                        IncomingCallService.stop(context)
                        incomingCall = null
                    }
                }
                is RealtimeEvent.CallEnded -> {
                    android.util.Log.d("MainActivity", "Call ended: ${event.conversationId} by ${event.byUserId}")
                    // Stop service if this is our incoming call
                    if (event.conversationId == incomingCall?.event?.conversationId) {
                        IncomingCallService.stop(context)
                        incomingCall = null
                    }
                }
                else -> {}
            }
        }
    }
    
    // Handle intent actions
    androidx.compose.runtime.LaunchedEffect(Unit) {
        val intent = (context as? android.app.Activity)?.intent
        when (intent?.getStringExtra("action")) {
            "accept_call" -> {
                val conversationId = intent.getStringExtra("conversation_id") ?: return@LaunchedEffect
                val isVideo = intent.getBooleanExtra("is_video", false)
                container.realtimeService.acceptCall(conversationId, isVideo)
                onStartCall(
                    ActiveCallSession(
                        conversationId = conversationId,
                        isVideo = isVideo,
                        isGroup = false
                    )
                )
                IncomingCallService.stop(context)
            }
            "incoming_call" -> {
                val conversationId = intent.getStringExtra("conversation_id") ?: return@LaunchedEffect
                val callerName = intent.getStringExtra("caller_name") ?: "Входящий звонок"
                val isVideo = intent.getBooleanExtra("is_video", false)
                incomingCall = IncomingCallUi(
                    event = RealtimeEvent.CallIncoming(conversationId, "", callerName, isVideo),
                    avatarUrl = null
                )
            }
        }
    }

    // Load avatar for incoming call
    LaunchedEffect(incomingCall?.event?.conversationId) {
        val callUi = incomingCall ?: return@LaunchedEffect
        val conversationId = callUi.event.conversationId
        val fromUserId = callUi.event.fromUserId
        val avatar = runCatching {
            val response = container.conversationsApi.getConversations()
            val convo = response.conversations.firstOrNull { it.conversation.id == conversationId }
            val participantAvatar = convo?.conversation?.participants
                ?.firstOrNull { it.user?.id == fromUserId }
                ?.user?.avatarUrl
            participantAvatar ?: convo?.conversation?.avatarUrl
        }.getOrNull()
        incomingCall = callUi.copy(avatarUrl = avatar)
    }
    
    // Mobile slider layout
    Box(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                detectHorizontalDragGestures(
                    onDragStart = { isDragging = true },
                    onDragEnd = {
                        isDragging = false
                        // Snap to nearest panel
                        val threshold = 0.5f
                        if (sliderOffset < -threshold) {
                            // Snap to chat panel - ensure conversation is selected
                            sliderOffset = -1f
                            if (selectedConversation == null) {
                                // If no conversation selected, snap back to list
                                sliderOffset = 0f
                            }
                        } else {
                            // Snap to list panel
                            sliderOffset = 0f
                            selectedConversation = null
                        }
                    },
                    onDrag = { change, dragAmount ->
                        val newOffset = (sliderOffset + dragAmount / this.size.width).coerceIn(-1f, 0f)
                        sliderOffset = newOffset
                        change.consume()
                    }
                )
            }
    ) {
        // Slider inner container
        Row(
            modifier = Modifier
                .fillMaxSize()
                .offset { IntOffset(x = (animatedOffset * screenWidthPx).roundToInt(), y = 0) }
        ) {
            // Conversations list panel
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .width(screenWidth)
            ) {
                ChatsRoute(
                    container = container,
                    currentUser = user,
                    onLogout = onLogout,
                    onConversationClick = { conversation ->
                        selectedConversation = conversation
                        sliderOffset = -1f
                    }
                )
            }
            
            // Chat detail panel
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .width(screenWidth)
            ) {
                selectedConversation?.let { conversation ->
                    ChatRoute(
                        container = container,
                        conversationId = conversation.id,
                        currentUser = user,
                        conversation = conversation,
                        activeCall = activeCall,
                        isCallMinimized = isCallMinimized,
                        onMinimizeChange = onMinimizeChange,
                        onHangUp = { callHandle?.hangUp() },
                        onBack = {
                            selectedConversation = null
                            sliderOffset = 0f
                        },
                        onCallClick = { isVideo ->
                            android.util.Log.d("MainActivity", "Initiating call: conversationId=${conversation.id}, isVideo=$isVideo")
                            container.realtimeService.inviteCall(conversation.id, isVideo)
                            onStartCall(
                                ActiveCallSession(
                                    conversationId = conversation.id,
                                    isVideo = isVideo,
                                    isGroup = conversation.isGroup
                                )
                            )
                        }
                    )
                }
            }
        }
    }
    
    // Show incoming call overlay
    incomingCall?.let { callUi ->
        val call = callUi.event
        IncomingCallScreen(
            call = call,
            avatarUrl = callUi.avatarUrl,
            onAccept = {
                IncomingCallService.stop(context)
                container.realtimeService.acceptCall(call.conversationId, call.video)
                onStartCall(
                    ActiveCallSession(
                        conversationId = call.conversationId,
                        isVideo = call.video,
                        isGroup = false
                    )
                )
                incomingCall = null
            },
            onDecline = {
                IncomingCallService.stop(context)
                container.realtimeService.declineCall(call.conversationId)
                incomingCall = null
            },
            onDismiss = {
                incomingCall = null
            }
        )
    }
}

@Composable
private fun LoggedOutContent(
    container: AppContainer,
    onLogin: (String, String) -> Unit,
    onSubmitToken: (String) -> Unit,
) {
    // Load saved username
    var username by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var token by rememberSaveable { mutableStateOf("") }
    
    // Load saved username on first composition
    LaunchedEffect(Unit) {
        val savedUsername = container.sessionStore.usernameFlow.firstOrNull()
        if (!savedUsername.isNullOrBlank()) {
            username = savedUsername
        }
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
            Text(
            text = "Добро пожаловать!",
                style = MaterialTheme.typography.headlineMedium,
                textAlign = TextAlign.Center
            )
            Text(
            text = "Войдите по логину и паролю, чтобы загрузить ваши чаты.",
            modifier = Modifier.padding(top = 12.dp),
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(16.dp))
        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Логин") },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None),
            singleLine = true
        )
        Spacer(modifier = Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Пароль") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true
        )
        Spacer(modifier = Modifier.height(12.dp))
        Button(
            onClick = {
                onLogin(username, password)
                password = ""
            },
            enabled = username.isNotBlank() && password.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Войти")
        }
        Spacer(modifier = Modifier.height(24.dp))
        Divider()
        Spacer(modifier = Modifier.height(16.dp))
        Text(
            text = "Нужно быстро проверить API? Вставьте access token вручную.",
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(12.dp))
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Access token") },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None),
            singleLine = true
        )
        Spacer(modifier = Modifier.height(12.dp))
        Button(
            onClick = {
                onSubmitToken(token)
                token = ""
            },
            enabled = token.isNotBlank(),
            modifier = Modifier.align(Alignment.End)
        ) {
            Text("Сохранить токен")
        }
    }
}

@Composable
private fun ErrorContent(
    message: String,
    onRetry: () -> Unit,
    onLogout: () -> Unit,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = "Ошибка",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.error
        )
        Text(
            text = message,
            modifier = Modifier.padding(top = 8.dp),
                textAlign = TextAlign.Center
            )
        Spacer(modifier = Modifier.height(16.dp))
        Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
            Text("Повторить")
            }
        TextButton(onClick = onLogout, modifier = Modifier.fillMaxWidth()) {
            Text("Очистить токен")
        }
    }
}
