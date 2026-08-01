package dev.agentbrain.share

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Device-local configuration.
 *
 * The share token is a credential, so it is held in EncryptedSharedPreferences
 * rather than plain preferences, keeping it consistent with ADR 0012's rule
 * that credentials are not stored as casually readable state.
 */
class Settings(context: Context) {

    private val prefs = run {
        val key = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "agentbrain-share",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_SERVER, value.trim().trimEnd('/')).apply()

    var token: String
        get() = prefs.getString(KEY_TOKEN, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_TOKEN, value.trim()).apply()

    val isConfigured: Boolean
        get() = serverUrl.isNotEmpty() && token.isNotEmpty()

    private companion object {
        const val KEY_SERVER = "server_url"
        const val KEY_TOKEN = "token"
    }
}
