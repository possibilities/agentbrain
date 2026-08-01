package dev.agentbrain.share

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import kotlin.concurrent.thread

/** Server address and token entry, plus a reachability check. */
class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        val settings = Settings(this)
        val serverField = findViewById<EditText>(R.id.server_url)
        val tokenField = findViewById<EditText>(R.id.token)
        val status = findViewById<TextView>(R.id.status)

        serverField.setText(settings.serverUrl)
        tokenField.setText(settings.token)

        findViewById<Button>(R.id.save).setOnClickListener {
            val url = serverField.text.toString().trim().trimEnd('/')
            val token = tokenField.text.toString().trim()
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                status.text = getString(R.string.bad_server_url)
                return@setOnClickListener
            }
            if (token.isEmpty()) {
                status.text = getString(R.string.missing_token)
                return@setOnClickListener
            }
            settings.serverUrl = url
            settings.token = token
            status.text = getString(R.string.saved)
            Toast.makeText(this, R.string.saved, Toast.LENGTH_SHORT).show()
        }

        findViewById<Button>(R.id.test).setOnClickListener {
            val url = serverField.text.toString().trim().trimEnd('/')
            val token = tokenField.text.toString().trim()
            status.text = getString(R.string.testing)
            thread {
                val result = ShareClient(url, token).checkHealth()
                val message = when (result) {
                    is ShareResult.Queued -> getString(R.string.connected)
                    is ShareResult.Rejected -> result.message
                    is ShareResult.Unreachable -> getString(R.string.unreachable)
                    else -> getString(R.string.unreachable)
                }
                runOnUiThread { status.text = message }
            }
        }
    }
}
