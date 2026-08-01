package dev.agentbrain.share

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import kotlin.concurrent.thread

/**
 * The share target. Runs with no UI of its own: it accepts the payload,
 * reports the outcome as a toast, and finishes immediately so sharing feels
 * instantaneous from the originating app.
 */
class ShareActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val settings = Settings(this)
        if (!settings.isConfigured) {
            toast(getString(R.string.not_configured))
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }

        val payload = payloadFrom(intent)
        if (payload == null) {
            toast(getString(R.string.nothing_to_share))
            finish()
            return
        }

        // Finish before the network call so the share sheet dismisses at once;
        // the outcome arrives as a toast from the background thread.
        toast(getString(R.string.sending))
        val client = ShareClient(settings.serverUrl, settings.token)
        thread {
            val result = client.share(payload)
            runOnUiThread { toast(describe(result)) }
        }
        finish()
    }

    private fun payloadFrom(intent: Intent?): SharePayload? {
        if (intent == null || intent.action != Intent.ACTION_SEND) return null
        return ShareIntentParser.parse(
            intent.getStringExtra(Intent.EXTRA_TEXT),
            intent.getStringExtra(Intent.EXTRA_SUBJECT),
        )
    }

    private fun describe(result: ShareResult): String = when (result) {
        is ShareResult.Queued -> getString(R.string.queued, result.jobId)
        is ShareResult.Duplicate -> getString(R.string.duplicate, result.jobId)
        is ShareResult.Rejected -> getString(R.string.rejected, result.message)
        is ShareResult.Unreachable -> getString(R.string.unreachable)
    }

    private fun toast(message: String) {
        Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
    }
}
