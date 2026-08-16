package app.pear.ssh

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction

/**
 * Incremental UTF-8 decoder for shell streams. SSH chunks arrive on arbitrary
 * byte boundaries; decoding each chunk independently would corrupt multibyte
 * characters split across chunks, so bytes of an incomplete sequence are held
 * back until the next chunk arrives.
 */
class StreamingUtf8 {
    private val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPLACE)
        .onUnmappableCharacter(CodingErrorAction.REPLACE)
    private var carry = ByteArray(0)

    fun decode(bytes: ByteArray, offset: Int, length: Int): String {
        val input = if (carry.isEmpty()) {
            ByteBuffer.wrap(bytes, offset, length)
        } else {
            val merged = ByteBuffer.allocate(carry.size + length)
            merged.put(carry).put(bytes, offset, length)
            merged.flip()
            merged
        }
        val out = CharBuffer.allocate(input.remaining() + 1)
        decoder.decode(input, out, false)
        carry = ByteArray(input.remaining()).also { input.get(it) }
        out.flip()
        return out.toString()
    }

    /** Flush any dangling partial sequence (stream ended mid-character). */
    fun finish(): String {
        if (carry.isEmpty()) return ""
        val input = ByteBuffer.wrap(carry)
        val out = CharBuffer.allocate(carry.size + 1)
        decoder.decode(input, out, true)
        decoder.flush(out)
        carry = ByteArray(0)
        decoder.reset()
        out.flip()
        return out.toString()
    }
}
