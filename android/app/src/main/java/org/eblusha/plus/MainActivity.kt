package org.eblusha.plus

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.feature.chats.ConversationPreview
import org.eblusha.plus.ui.chats.ChatsRoute
import org.eblusha.plus.ui.theme.EblushaPlusTheme
import org.eblusha.plus.feature.session.SessionUiState
import org.eblusha.plus.feature.session.SessionUser
import org.eblusha.plus.feature.session.SessionViewModel
import org.eblusha.plus.feature.session.SessionViewModelFactory

class MainActivity : ComponentActivity() {
    private val container: AppContainer by lazy { (application as EblushaApp).container }
    private val sessionViewModel: SessionViewModel by viewModels {
        SessionViewModelFactory(container)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val state by sessionViewModel.uiState.collectAsStateWithLifecycle()
            EblushaPlusTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    SessionScreen(
                        container = container,
                        state = state,
                        onSubmitToken = sessionViewModel::submitToken,
                        onLogin = sessionViewModel::login,
                        onRefresh = sessionViewModel::refresh,
                        onLogout = sessionViewModel::logout
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
    onConversationClick: (ConversationPreview) -> Unit = {},
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        when (state) {
            SessionUiState.Loading -> CircularProgressIndicator()
            SessionUiState.LoggedOut -> LoggedOutContent(onLogin, onSubmitToken)
            is SessionUiState.Error -> ErrorContent(state.message, onRefresh, onLogout)
            is SessionUiState.LoggedIn -> ChatsRoute(
                container = container,
                currentUser = state.user,
                onLogout = onLogout,
                onConversationClick = onConversationClick
            )
        }
    }
}

@Composable
private fun LoggedOutContent(
    onLogin: (String, String) -> Unit,
    onSubmitToken: (String) -> Unit,
) {
    var username by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var token by rememberSaveable { mutableStateOf("") }
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
