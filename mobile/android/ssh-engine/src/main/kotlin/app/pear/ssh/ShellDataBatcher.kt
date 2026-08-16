package app.pear.ssh

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Coalesces shell output before it crosses the Capacitor bridge. Raw SSH
 * chunks arrive every few KB; firing a bridge event per chunk janks the
 * WebView, so chunks accumulate per channel and flush once per frame
 * (~16 ms), or immediately when a channel's backlog crosses `maxPending`.
 *
 * All delivery happens on the single scheduler thread, which guarantees
 * per-channel ordering; `run` lets exit events queue behind pending data.
 */
class ShellDataBatcher(
    private val deliver: (channelId: String, data: String) -> Unit,
    private val flushIntervalMs: Long = 16,
    private val maxPending: Int = 64 * 1024,
) {
    private val scheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "pear-ssh-batch").apply { isDaemon = true }
        }
    private val pending = LinkedHashMap<String, StringBuilder>()
    private var scheduled = false

    fun add(channelId: String, data: String) {
        var immediate = false
        synchronized(this) {
            val buf = pending.getOrPut(channelId) { StringBuilder() }
            buf.append(data)
            immediate = buf.length >= maxPending
            if (!scheduled) {
                scheduled = true
                scheduler.schedule(::flushAll, if (immediate) 0 else flushIntervalMs, TimeUnit.MILLISECONDS)
            } else if (immediate) {
                scheduler.execute(::flushAll)
            }
        }
    }

    /** Flush everything queued, then run `action` — all on the batch thread. */
    fun run(action: () -> Unit) {
        scheduler.execute {
            flushAll()
            action()
        }
    }

    private fun flushAll() {
        val drained: List<Pair<String, String>>
        synchronized(this) {
            scheduled = false
            if (pending.isEmpty()) return
            drained = pending.entries.map { it.key to it.value.toString() }
            pending.clear()
        }
        for ((channelId, data) in drained) deliver(channelId, data)
    }

    fun shutdown() {
        scheduler.shutdown()
    }
}
