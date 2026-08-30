package dev.agentbrain.share

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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

        val app = applicationContext
        val settings = Settings(this)
        val outbox = ShareOutbox.at(this)

        val payload = payloadFrom(intent)
        if (payload == null) {
            toast(app, getString(R.string.nothing_to_share))
            finish()
            return
        }

        // Recent reminders are client state, independent of whether Admission
        // has happened or the outbox still holds this share.
        RecentLinkNotifications.remember(app, payload)

        // An unconfigured app cannot send, but the share is still worth
        // keeping: naming a server drains what was held meanwhile.
        if (!settings.isConfigured) {
            outbox.enqueue(payload)
            toast(app, getString(R.string.held_unconfigured, outbox.pending()))
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }

        // Finish before the network call so the share sheet dismisses at once;
        // the outcome arrives as a toast from the background thread.
        toast(app, getString(R.string.sending))
        val client = ShareClient(settings.serverUrl, settings.token)
        thread {
            // Held before it is attempted: this process can be killed the
            // moment the share sheet dismisses, and a share that exists only in
            // this thread's memory would go with it.
            val entry = outbox.enqueue(payload)
            ShareScheduler.scheduleNext(app, outbox)

            val result = client.share(payload)
            when {
                result is ShareResult.Queued || result is ShareResult.Duplicate -> {
                    outbox.remove(entry.id)
                    // The server just answered, so anything held from an
                    // earlier outage can go now.
                    if (outbox.pending() > 0) ShareScheduler.flushNow(app)
                }
                ShareOutbox.isRetryable(result) -> {
                    outbox.defer(entry.id, result)
                    ShareScheduler.scheduleNext(app, outbox)
                }
                else -> outbox.remove(entry.id)
            }
            toast(app, describe(result, outbox))
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

    /**
     * A held share is reported as held, never as saved: nothing exists in
     * Agentbrain until the ingress admits it.
     */
    private fun describe(result: ShareResult, outbox: ShareOutbox): String = when (result) {
        is ShareResult.Queued -> getString(R.string.queued, result.jobId)
        is ShareResult.Duplicate -> getString(R.string.duplicate, result.jobId)
        is ShareResult.Unreachable -> getString(R.string.held, outbox.pending())
        is ShareResult.Rejected ->
            if (ShareOutbox.isRetryable(result)) {
                getString(R.string.held_detail, result.message, outbox.pending())
            } else {
                getString(R.string.rejected, result.message)
            }
    }

    /**
     * Posted to the main looper against the application context rather than
     * through `runOnUiThread`: by the time a result arrives this Activity has
     * finished, and the toast must outlive it.
     */
    private fun toast(context: Context, message: String) {
        Handler(Looper.getMainLooper()).post {
            Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
        }
    }
}
