package dev.agentbrain.share

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import kotlin.concurrent.thread

/** Server address and token entry, a reachability check, and the Share outbox. */
class SettingsActivity : AppCompatActivity() {

    private lateinit var outbox: ShareOutbox
    private lateinit var outboxStatus: TextView
    private lateinit var outboxDropped: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        val settings = Settings(this)
        outbox = ShareOutbox.at(this)
        val serverField = findViewById<EditText>(R.id.server_url)
        val tokenField = findViewById<EditText>(R.id.token)
        val status = findViewById<TextView>(R.id.status)
        outboxStatus = findViewById(R.id.outbox_status)
        outboxDropped = findViewById(R.id.outbox_dropped)

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
            // A server that was only just named may be the one held shares are
            // waiting on.
            if (outbox.pending() > 0) ShareScheduler.flushNow(applicationContext)
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
                if (result is ShareResult.Queued) ShareScheduler.flushNow(applicationContext)
                runOnUiThread { status.text = message }
            }
        }

        findViewById<Button>(R.id.outbox_send).setOnClickListener {
            if (!settings.isConfigured) {
                status.text = getString(R.string.not_configured)
                return@setOnClickListener
            }
            status.text = getString(R.string.outbox_sending)
            val client = ShareClient(settings.serverUrl, settings.token)
            thread {
                // Forced: the user asked now, so the backoff does not apply.
                val summary = outbox.flush({ client.share(it) }, force = true)
                ShareScheduler.scheduleNext(applicationContext, outbox)
                val message = if (summary.attempted == 0) {
                    getString(R.string.outbox_nothing_waiting)
                } else {
                    getString(
                        R.string.outbox_flushed,
                        summary.delivered + summary.duplicate,
                        summary.attempted,
                        summary.pending,
                    )
                }
                runOnUiThread {
                    status.text = message
                    refreshOutbox()
                }
            }
        }

        findViewById<Button>(R.id.outbox_discard).setOnClickListener {
            val discarded = outbox.clear()
            ShareScheduler.scheduleNext(applicationContext, outbox)
            status.text = getString(R.string.outbox_cleared, discarded)
            refreshOutbox()
        }
    }

    override fun onResume() {
        super.onResume()
        refreshOutbox()
    }

    private fun refreshOutbox() {
        val pending = outbox.pending()
        outboxStatus.text = if (pending == 0) {
            getString(R.string.outbox_none)
        } else {
            getString(R.string.outbox_pending, pending)
        }

        // Every abandoned share is named. Silent loss is what the outbox exists
        // to prevent, and this app has no notification permission to lean on.
        val dropped = outbox.dropped()
        outboxDropped.text = if (dropped.isEmpty()) {
            ""
        } else {
            buildString {
                append(getString(R.string.outbox_dropped_heading))
                for (drop in dropped) {
                    append('\n')
                    append(
                        when (drop.reason) {
                            DropReason.EXPIRED ->
                                getString(R.string.outbox_dropped_expired, drop.describes)
                            DropReason.OVERFLOW ->
                                getString(R.string.outbox_dropped_overflow, drop.describes)
                            DropReason.REJECTED ->
                                getString(R.string.outbox_dropped_rejected, drop.describes)
                        },
                    )
                }
            }
        }
    }
}
