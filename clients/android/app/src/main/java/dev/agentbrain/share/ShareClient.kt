package dev.agentbrain.share

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/** Normalized outcome of one share attempt. */
sealed class ShareResult {
    data class Queued(val jobId: Int) : ShareResult()
    data class Duplicate(val jobId: Int) : ShareResult()
    data class Rejected(val code: String, val message: String) : ShareResult()
    data class Unreachable(val message: String) : ShareResult()
}

/**
 * Minimal HTTP client for the share ingress.
 *
 * Uses HttpURLConnection so the app carries no third-party networking
 * dependency. Calls block, so callers must run this off the main thread.
 */
class ShareClient(
    private val serverUrl: String,
    private val token: String,
    private val timeoutMs: Int = 15_000,
) {

    fun share(payload: SharePayload): ShareResult {
        val body = payload.toJson().toByteArray(Charsets.UTF_8)
        val endpoint = "${serverUrl.trimEnd('/')}/v1/share"

        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Authorization", "Bearer $token")
            }
            connection.outputStream.use { it.write(body) }

            val status = connection.responseCode
            val raw = if (status in 200..299) {
                connection.inputStream.bufferedReader().use { it.readText() }
            } else {
                connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
            }
            interpret(status, raw)
        } catch (error: IOException) {
            ShareResult.Unreachable(
                error.message ?: "Could not reach Agentbrain at $serverUrl",
            )
        } finally {
            connection?.disconnect()
        }
    }

    fun checkHealth(): ShareResult {
        var connection: HttpURLConnection? = null
        return try {
            val endpoint = "${serverUrl.trimEnd('/')}/v1/health"
            connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                setRequestProperty("Authorization", "Bearer $token")
            }
            when (val status = connection.responseCode) {
                in 200..299 -> ShareResult.Queued(0)
                401 -> ShareResult.Rejected("unauthorized", "The share token was rejected.")
                else -> ShareResult.Rejected("http_$status", "Server answered HTTP $status.")
            }
        } catch (error: IOException) {
            ShareResult.Unreachable(error.message ?: "Could not reach $serverUrl")
        } finally {
            connection?.disconnect()
        }
    }

    private fun interpret(status: Int, raw: String): ShareResult {
        val json = try {
            if (raw.isBlank()) null else JSONObject(raw)
        } catch (_: Exception) {
            null
        }

        if (status in 200..299 && json != null && json.optBoolean("ok")) {
            val data = json.optJSONObject("data")
            val jobId = data?.optInt("job_id") ?: 0
            return if (data?.optString("status") == "duplicate") {
                ShareResult.Duplicate(jobId)
            } else {
                ShareResult.Queued(jobId)
            }
        }

        val error = json?.optJSONObject("error")
        return ShareResult.Rejected(
            error?.optString("code") ?: "http_$status",
            error?.optString("message") ?: "Agentbrain rejected the share (HTTP $status).",
        )
    }
}
