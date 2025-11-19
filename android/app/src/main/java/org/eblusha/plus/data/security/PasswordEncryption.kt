package org.eblusha.plus.data.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Утилита для шифрования/дешифрования пароля с использованием Android Keystore
 */
class PasswordEncryption(context: Context) {
    
    private val keyStore: KeyStore = KeyStore.getInstance("AndroidKeyStore").apply {
        load(null)
    }
    
    private val keyAlias = "eblusha_password_key"
    private val transformation = "AES/GCM/NoPadding"
    
    init {
        ensureKeyExists()
    }
    
    private fun ensureKeyExists() {
        if (!keyStore.containsAlias(keyAlias)) {
            val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            val keyGenParameterSpec = KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
            
            keyGenerator.init(keyGenParameterSpec)
            keyGenerator.generateKey()
            Log.d("PasswordEncryption", "Generated new encryption key")
        }
    }
    
    private fun getSecretKey(): SecretKey {
        val keyEntry = keyStore.getEntry(keyAlias, null) as KeyStore.SecretKeyEntry
        return keyEntry.secretKey
    }
    
    fun encrypt(password: String): String {
        return try {
            val cipher = Cipher.getInstance(transformation)
            cipher.init(Cipher.ENCRYPT_MODE, getSecretKey())
            
            val iv = cipher.iv
            val encrypted = cipher.doFinal(password.toByteArray(Charsets.UTF_8))
            
            // Сохраняем IV вместе с зашифрованными данными
            val combined = ByteArray(iv.size + encrypted.size)
            System.arraycopy(iv, 0, combined, 0, iv.size)
            System.arraycopy(encrypted, 0, combined, iv.size, encrypted.size)
            
            Base64.encodeToString(combined, Base64.DEFAULT)
        } catch (e: Exception) {
            Log.e("PasswordEncryption", "Error encrypting password", e)
            throw e
        }
    }
    
    fun decrypt(encryptedPassword: String): String {
        return try {
            val combined = Base64.decode(encryptedPassword, Base64.DEFAULT)
            
            // Извлекаем IV (первые 12 байт для GCM)
            val ivSize = 12
            val iv = ByteArray(ivSize)
            val encrypted = ByteArray(combined.size - ivSize)
            System.arraycopy(combined, 0, iv, 0, ivSize)
            System.arraycopy(combined, ivSize, encrypted, 0, encrypted.size)
            
            val cipher = Cipher.getInstance(transformation)
            val spec = GCMParameterSpec(128, iv)
            cipher.init(Cipher.DECRYPT_MODE, getSecretKey(), spec)
            
            val decrypted = cipher.doFinal(encrypted)
            String(decrypted, Charsets.UTF_8)
        } catch (e: Exception) {
            Log.e("PasswordEncryption", "Error decrypting password", e)
            throw e
        }
    }
}

