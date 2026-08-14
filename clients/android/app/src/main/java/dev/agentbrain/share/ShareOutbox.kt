package dev.agentbrain.share

import android.content.Context
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** One share the ingress has not accepted yet. */
data class OutboxEntry(
    val id: String,
    val payload: SharePayload,
    val createdAt: Long,
    val attempts: Int = 0,
    val nextAttemptAt: Long,
    val lastCode: String? = null,
    val lastMessage: String? = null,
)

/** Why a held share was given up on. Every drop is recorded, never silent. */
enum class DropReason { EXPIRED, OVERFLOW, REJECTED }

/** A share that will not be delivered, kept so the app can say what was lost. */
data class DroppedShare(
    val describes: String,
    val reason: DropReason,
    val detail: String?,
    val at: Long,
)

/** What one delivery round did. */
data class FlushSummary(
    val attempted: Int = 0,
    val delivered: Int = 0,
    val duplicate: Int = 0,
    val dropped: List<DroppedShare> = emptyList(),
    val pending: Int = 0,
    val offline: Boolean = false,
)

/**
 * Durable hold for shares the ingress has not accepted.
 *
 * A share the server never received is not a failed share: it is one that has
 * not been delivered yet. Entries outlive the share Activity, the process, and
 * a reboot, and are redelivered until the ingress admits them or classifies
 * them as unsendable.
 *
 * The outbox holds intent only. It is not a queue in the Agentbrain sense: no
 * job exists until Admission creates one, so nothing here may be reported to
 * the user as saved. Redelivery needs no client idempotency key because the
 * ingress derives one from the intent, so a share delivered twice comes back as
 * `duplicate` naming the same job. See ADR 0020.
 *
 * Plain app-private storage rather than [Settings]'s encrypted preferences:
 * this holds what the user chose to publish to their own index, not a
 * credential. The token stays encrypted and is never written here.
 *
 * Takes a [File] rather than a Context so the delivery policy is unit testable
 * on the JVM.
 */
class ShareOutbox(private val file: File) {

    private val lock = Any()

    fun pending(): Int = synchronized(lock) { read().first.size }

    fun entries(): List<OutboxEntry> = synchronized(lock) { read().first }

    fun dropped(): List<DroppedShare> = synchronized(lock) { read().second }

    /**
     * Holds one payload, evicting the oldest if the cap is reached: the newest
     * share is always kept, because it is the one the user just asked for.
     */
    fun enqueue(payload: SharePayload, now: Long = System.currentTimeMillis()): OutboxEntry {
        val entry = OutboxEntry(
            id = UUID.randomUUID().toString(),
            payload = payload,
            createdAt = now,
            nextAttemptAt = now + backoffMs(1),
        )
        synchronized(lock) {
            val (entries, dropped) = read()
            val grown = entries + entry
            val overflow = (grown.size - MAX_ENTRIES).coerceAtLeast(0)
            val evicted = grown.take(overflow).map {
                DroppedShare(describe(it.payload), DropReason.OVERFLOW, null, now)
            }
            write(grown.drop(overflow), evicted + dropped)
        }
        return entry
    }

    fun remove(id: String) = synchronized(lock) {
        val (entries, dropped) = read()
        write(entries.filterNot { it.id == id }, dropped)
    }

    /** Reschedules one entry after a retryable failure. */
    fun defer(id: String, result: ShareResult, now: Long = System.currentTimeMillis()) =
        synchronized(lock) {
            val (entries, dropped) = read()
            write(entries.map { if (it.id == id) it.deferred(now, result) else it }, dropped)
        }

    fun clear(): Int = synchronized(lock) {
        val (entries, dropped) = read()
        val held = entries.map { DroppedShare(describe(it.payload), DropReason.OVERFLOW, null, System.currentTimeMillis()) }
        write(emptyList(), held + dropped)
        entries.size
    }

    fun clearDropped() = synchronized(lock) { write(read().first, emptyList()) }

    /** When the next attempt is due, or null when nothing is held. */
    fun earliestAttempt(): Long? = synchronized(lock) {
        read().first.minOfOrNull { it.nextAttemptAt }
    }

    /**
     * Attempts delivery of every due entry through [send].
     *
     * The first unreachable server ends the round: the rest are deferred
     * unattempted rather than each paying its own connection timeout against a
     * host that is plainly down.
     *
     * The network calls happen outside the lock — a round can take a minute,
     * and a share arriving meanwhile must not block on it. The commit re-reads
     * and merges, so an entry enqueued mid-round survives.
     */
    fun flush(
        send: (SharePayload) -> ShareResult,
        now: Long = System.currentTimeMillis(),
        force: Boolean = false,
    ): FlushSummary {
        val snapshot = entries()
        if (snapshot.isEmpty()) return FlushSummary()

        var attempted = 0
        var delivered = 0
        var duplicate = 0
        var offline = false
        val kept = mutableListOf<OutboxEntry>()
        val dropped = mutableListOf<DroppedShare>()

        for (entry in snapshot) {
            if (now - entry.createdAt > MAX_AGE_MS) {
                dropped += DroppedShare(describe(entry.payload), DropReason.EXPIRED, entry.lastMessage, now)
                continue
            }
            if (offline || (!force && entry.nextAttemptAt > now)) {
                kept += if (offline) entry.deferred(now, null) else entry
                continue
            }

            attempted += 1
            when (val result = send(entry.payload)) {
                is ShareResult.Queued -> delivered += 1
                is ShareResult.Duplicate -> duplicate += 1
                is ShareResult.Unreachable -> {
                    offline = true
                    kept += entry.deferred(now, result)
                }
                is ShareResult.Rejected ->
                    if (isRetryable(result)) {
                        kept += entry.deferred(now, result)
                    } else {
                        dropped += DroppedShare(
                            describe(entry.payload),
                            DropReason.REJECTED,
                            result.message,
                            now,
                        )
                    }
            }
        }

        val pending = synchronized(lock) {
            val (current, priorDrops) = read()
            val processed = snapshot.map { it.id }.toSet()
            val arrived = current.filterNot { processed.contains(it.id) }
            val remaining = kept + arrived
            write(remaining, dropped + priorDrops)
            remaining.size
        }

        return FlushSummary(attempted, delivered, duplicate, dropped, pending, offline)
    }

    private fun OutboxEntry.deferred(now: Long, result: ShareResult?): OutboxEntry {
        val next = attempts + 1
        return copy(
            attempts = next,
            nextAttemptAt = now + backoffMs(next),
            lastCode = (result as? ShareResult.Rejected)?.code
                ?: (result as? ShareResult.Unreachable)?.let { "unreachable" }
                ?: lastCode,
            lastMessage = when (result) {
                is ShareResult.Rejected -> result.message
                is ShareResult.Unreachable -> result.message
                else -> lastMessage
            },
        )
    }

    private fun read(): Pair<List<OutboxEntry>, List<DroppedShare>> {
        if (!file.exists()) return emptyList<OutboxEntry>() to emptyList()
        val root = try {
            JSONObject(file.readText())
        } catch (_: Exception) {
            // A truncated write is the one thing worse than an empty outbox:
            // refusing to start. Begin again rather than crash every share.
            return emptyList<OutboxEntry>() to emptyList()
        }
        val entries = root.optJSONArray("entries").toList { item ->
            val payload = SharePayload.fromStorage(item.getJSONObject("payload"))
            OutboxEntry(
                id = item.getString("id"),
                payload = payload,
                createdAt = item.getLong("created_at"),
                attempts = item.optInt("attempts"),
                nextAttemptAt = item.getLong("next_attempt_at"),
                lastCode = item.optString("last_code").takeIf { it.isNotEmpty() },
                lastMessage = item.optString("last_message").takeIf { it.isNotEmpty() },
            )
        }
        val dropped = root.optJSONArray("dropped").toList { item ->
            DroppedShare(
                describes = item.getString("describes"),
                reason = DropReason.valueOf(item.getString("reason")),
                detail = item.optString("detail").takeIf { it.isNotEmpty() },
                at = item.getLong("at"),
            )
        }
        return entries to dropped
    }

    private fun write(entries: List<OutboxEntry>, dropped: List<DroppedShare>) {
        val root = JSONObject()
        root.put(
            "entries",
            JSONArray().also { array ->
                for (entry in entries) {
                    array.put(
                        JSONObject()
                            .put("id", entry.id)
                            .put("payload", entry.payload.toStorageJson())
                            .put("created_at", entry.createdAt)
                            .put("attempts", entry.attempts)
                            .put("next_attempt_at", entry.nextAttemptAt)
                            .putOpt("last_code", entry.lastCode)
                            .putOpt("last_message", entry.lastMessage),
                    )
                }
            },
        )
        root.put(
            "dropped",
            JSONArray().also { array ->
                for (drop in dropped.take(MAX_DROPPED)) {
                    array.put(
                        JSONObject()
                            .put("describes", drop.describes)
                            .put("reason", drop.reason.name)
                            .putOpt("detail", drop.detail)
                            .put("at", drop.at),
                    )
                }
            },
        )
        file.parentFile?.mkdirs()
        file.writeText(root.toString())
    }

    private fun <T> JSONArray?.toList(build: (JSONObject) -> T): List<T> {
        if (this == null) return emptyList()
        return (0 until length()).mapNotNull { index ->
            try {
                build(getJSONObject(index))
            } catch (_: Exception) {
                null
            }
        }
    }

    companion object {
        /** Beyond this the oldest held shares are dropped rather than grown without bound. */
        const val MAX_ENTRIES = 200

        /** A share nobody could deliver for a week is abandoned, with a record. */
        const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000

        /** How many abandoned shares are remembered so the app can name them. */
        const val MAX_DROPPED = 20

        private val BACKOFF_MS = longArrayOf(60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000)

        fun backoffMs(attempts: Int): Long =
            BACKOFF_MS[attempts.coerceIn(1, BACKOFF_MS.size) - 1]

        /**
         * Whether a failed share is worth sending again unchanged, per
         * share-ingest-v1: a connection failure or a server fault is safely
         * retryable, and a 4xx other than 401 means the payload itself is wrong
         * and never will be.
         *
         * 401 is retryable on purpose. A rejected token is a configuration
         * fault the user can repair, and discarding what they shared in the
         * meantime is the one outcome the outbox exists to prevent.
         */
        fun isRetryable(result: ShareResult): Boolean = when (result) {
            is ShareResult.Unreachable -> true
            is ShareResult.Rejected ->
                result.status >= 500 ||
                    result.status == 401 ||
                    result.status == 408 ||
                    result.status == 429
            else -> false
        }

        fun describe(payload: SharePayload): String =
            payload.url ?: payload.title ?: payload.text?.take(60) ?: "a share"

        fun at(context: Context): ShareOutbox =
            ShareOutbox(File(context.filesDir, "share-outbox.json"))
    }
}
