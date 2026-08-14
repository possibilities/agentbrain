package dev.agentbrain.share

import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The delivery policy for shares the ingress has not accepted.
 *
 * [ShareOutbox] takes a File rather than a Context precisely so this runs on
 * the JVM: the policy is what has to be right, and it needs no device.
 */
class ShareOutboxTest {

    private lateinit var file: File
    private lateinit var outbox: ShareOutbox

    private val now = 1_760_000_000_000L
    private val unreachable = ShareResult.Unreachable("Could not reach the server.")
    private val rejected = ShareResult.Rejected(400, "bad_source", "not a usable locator")
    private val unauthorized = ShareResult.Rejected(401, "unauthorized", "token rejected")
    private val queued = ShareResult.Queued(7)
    private val duplicate = ShareResult.Duplicate(7)

    private fun link(name: String) = SharePayload(url = "https://example.com/$name")

    @Before
    fun setUp() {
        file = Files.createTempDirectory("outbox").resolve("share-outbox.json").toFile()
        outbox = ShareOutbox(file)
    }

    @Test
    fun `a held share survives a new instance reading the same file`() {
        outbox.enqueue(link("a"), now)
        val reopened = ShareOutbox(file)
        assertEquals(1, reopened.pending())
        assertEquals("https://example.com/a", reopened.entries().first().payload.url)
    }

    @Test
    fun `the first retry is one backoff step away`() {
        val entry = outbox.enqueue(link("a"), now)
        assertEquals(0, entry.attempts)
        assertEquals(now + ShareOutbox.backoffMs(1), entry.nextAttemptAt)
    }

    @Test
    fun `the oldest share is evicted rather than growing without bound`() {
        for (index in 0..ShareOutbox.MAX_ENTRIES) {
            outbox.enqueue(link("$index"), now + index)
        }
        val entries = outbox.entries()
        assertEquals(ShareOutbox.MAX_ENTRIES, entries.size)
        assertEquals("https://example.com/1", entries.first().payload.url)
        // The eviction is recorded, not silent.
        assertEquals(DropReason.OVERFLOW, outbox.dropped().first().reason)
    }

    @Test
    fun `an admitted share is removed`() {
        outbox.enqueue(link("a"), now)
        val summary = outbox.flush({ queued }, now, force = true)
        assertEquals(1, summary.attempted)
        assertEquals(1, summary.delivered)
        assertEquals(0, summary.pending)
        assertEquals(0, outbox.pending())
    }

    @Test
    fun `a duplicate counts as delivered because the job already exists`() {
        outbox.enqueue(link("a"), now)
        val summary = outbox.flush({ duplicate }, now, force = true)
        assertEquals(1, summary.duplicate)
        assertEquals(0, summary.delivered)
        assertEquals(0, outbox.pending())
    }

    @Test
    fun `the backoff is respected unless the round is forced`() {
        outbox.enqueue(link("a"), now)
        var calls = 0
        outbox.flush({ calls += 1; queued }, now + 1_000)
        assertEquals(0, calls)

        outbox.flush({ calls += 1; queued }, now + ShareOutbox.backoffMs(1) + 1)
        assertEquals(1, calls)
    }

    @Test
    fun `each retryable failure backs off further`() {
        outbox.enqueue(link("a"), now)
        outbox.flush({ unreachable }, now, force = true)
        var held = outbox.entries().first()
        assertEquals(1, held.attempts)
        assertEquals(now + ShareOutbox.backoffMs(1), held.nextAttemptAt)
        assertEquals("unreachable", held.lastCode)

        outbox.flush({ unreachable }, now + 1, force = true)
        held = outbox.entries().first()
        assertEquals(2, held.attempts)
        assertEquals(now + 1 + ShareOutbox.backoffMs(2), held.nextAttemptAt)
    }

    @Test
    fun `a payload the ingress will never accept is dropped and named`() {
        outbox.enqueue(link("a"), now)
        val summary = outbox.flush({ rejected }, now, force = true)
        assertEquals(1, summary.dropped.size)
        assertEquals(DropReason.REJECTED, summary.dropped.first().reason)
        assertEquals(0, outbox.pending())
        assertEquals("https://example.com/a", outbox.dropped().first().describes)
    }

    @Test
    fun `a rejected token is retried rather than discarded`() {
        outbox.enqueue(link("a"), now)
        val summary = outbox.flush({ unauthorized }, now, force = true)
        assertTrue(summary.dropped.isEmpty())
        assertEquals(1, outbox.pending())
        assertEquals("unauthorized", outbox.entries().first().lastCode)
    }

    @Test
    fun `the round stops at the first unreachable server`() {
        outbox.enqueue(link("a"), now)
        outbox.enqueue(link("b"), now)
        outbox.enqueue(link("c"), now)
        var calls = 0
        val summary = outbox.flush({ calls += 1; unreachable }, now, force = true)

        assertEquals(1, calls)
        assertTrue(summary.offline)
        assertEquals(3, summary.pending)
        // Every held share backs off, so the next round is one wake, not three.
        assertTrue(outbox.entries().all { it.attempts == 1 })
    }

    @Test
    fun `a share no server ever accepted is abandoned`() {
        outbox.enqueue(link("a"), now)
        var calls = 0
        val summary = outbox.flush(
            { calls += 1; queued },
            now + ShareOutbox.MAX_AGE_MS + 1,
            force = true,
        )
        assertEquals(0, calls)
        assertEquals(DropReason.EXPIRED, summary.dropped.first().reason)
        assertEquals(0, outbox.pending())
    }

    @Test
    fun `a share enqueued during a round survives the commit`() {
        outbox.enqueue(link("a"), now)
        val summary = outbox.flush(
            {
                outbox.enqueue(link("late"), now)
                queued
            },
            now,
            force = true,
        )
        assertEquals(1, summary.delivered)
        assertEquals(1, outbox.pending())
        assertEquals("https://example.com/late", outbox.entries().first().payload.url)
    }

    @Test
    fun `the earliest due attempt drives the next wake`() {
        assertNull(outbox.earliestAttempt())
        outbox.enqueue(link("a"), now + 5_000)
        outbox.enqueue(link("b"), now)
        assertEquals(now + ShareOutbox.backoffMs(1), outbox.earliestAttempt())
    }

    @Test
    fun `a truncated file begins again rather than failing every share`() {
        outbox.enqueue(link("a"), now)
        file.writeText("{\"entries\": [{\"id\"")
        assertEquals(0, outbox.pending())
        outbox.enqueue(link("b"), now)
        assertEquals(1, outbox.pending())
    }

    @Test
    fun `held payloads round trip through storage`() {
        outbox.enqueue(SharePayload(text = "a note worth keeping", title = "Notes"), now)
        val restored = ShareOutbox(file).entries().first().payload
        assertEquals("a note worth keeping", restored.text)
        assertEquals("Notes", restored.title)
        assertNull(restored.url)
    }
}
