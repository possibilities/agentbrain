package dev.agentbrain.share

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * One delivery round for the Share outbox.
 *
 * Runs on WorkManager's background thread, so the blocking [ShareClient] calls
 * are made where they belong. The round is always reported as success: a share
 * that could not be delivered is rescheduled by the outbox's own backoff, and
 * letting WorkManager retry as well would attempt it twice on two schedules.
 */
class ShareUploadWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {

    override fun doWork(): Result {
        val outbox = ShareOutbox.at(applicationContext)
        val settings = Settings(applicationContext)
        // Unconfigured is not undeliverable: held shares wait for a server to
        // be named, and saving one schedules this round again.
        if (!settings.isConfigured) return Result.success()

        val client = ShareClient(settings.serverUrl, settings.token)
        outbox.flush({ payload -> client.share(payload) })
        ShareScheduler.scheduleNext(applicationContext, outbox)
        return Result.success()
    }
}
