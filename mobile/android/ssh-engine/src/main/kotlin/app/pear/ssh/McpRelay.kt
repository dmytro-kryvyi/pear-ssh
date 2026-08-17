package app.pear.ssh

import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

data class RelayRequest(
    val id: String,
    val method: String,
    val path: String,
    val authorization: String?,
    val contentType: String?,
    val body: String,
)

data class RelayResponse(
    val status: Int,
    val body: String,
    val contentType: String = "application/json",
)

/**
 * Minimal loopback HTTP/1.1 server relaying MCP JSON-RPC POSTs to an async
 * handler — on Android that handler crosses the Capacitor bridge into the
 * WebView, where the actual MCP server (core's registerPearTools) lives.
 * The Claude host reaches it through an SSH remote port-forward.
 *
 * One request per connection (`Connection: close`), which matches the
 * stateless per-POST MCP pattern the desktop server uses. Responses can be
 * legitimately slow — a permission card can sit unanswered for minutes — so
 * the handler timeout is generous.
 */
class McpRelay(
    private val handler: (RelayRequest, (RelayResponse) -> Unit) -> Unit,
    private val timeoutSeconds: Long = 600,
) {
    private var server: ServerSocket? = null
    private val pending = ConcurrentHashMap<String, (RelayResponse) -> Unit>()

    val port: Int get() = server?.localPort ?: 0

    fun start(): Int {
        check(server == null) { "relay already started" }
        // Bind IPv4 loopback explicitly: getLoopbackAddress() resolves to ::1
        // on IPv6-preferring hosts (Android), but the SSH forwarder connects
        // to 127.0.0.1 — a mismatch refuses every tunneled request.
        val socket = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
        server = socket
        thread(name = "pear-mcp-accept", isDaemon = true) {
            while (true) {
                val client = try {
                    socket.accept()
                } catch (_: IOException) {
                    break // closed
                }
                thread(name = "pear-mcp-conn", isDaemon = true) { serve(client) }
            }
        }
        return socket.localPort
    }

    /** Resolve a pending request from outside (the bridge response path). */
    fun respond(requestId: String, response: RelayResponse) {
        pending.remove(requestId)?.invoke(response)
    }

    private fun serve(client: Socket) {
        client.use { sock ->
            sock.soTimeout = 30_000
            val input = sock.getInputStream()
            val out = BufferedOutputStream(sock.getOutputStream())
            val request = try {
                parse(input)
            } catch (_: Exception) {
                write(out, RelayResponse(400, """{"error":"bad request"}"""))
                return
            }
            if (request.method != "POST") {
                write(out, RelayResponse(405, """{"error":"POST only"}"""))
                return
            }
            val latch = CountDownLatch(1)
            var response = RelayResponse(504, """{"error":"handler timeout"}""")
            val complete: (RelayResponse) -> Unit = {
                response = it
                latch.countDown()
            }
            pending[request.id] = complete
            try {
                handler(request) { respond(request.id, it) }
                latch.await(timeoutSeconds, TimeUnit.SECONDS)
            } catch (e: Exception) {
                response = RelayResponse(500, """{"error":"${e.message ?: "relay failure"}"}""")
            } finally {
                pending.remove(request.id)
            }
            write(out, response)
        }
    }

    private fun parse(input: InputStream): RelayRequest {
        val requestLine = readLine(input) ?: throw IOException("empty request")
        val parts = requestLine.split(' ')
        if (parts.size < 3) throw IOException("bad request line")
        var contentLength = 0
        var authorization: String? = null
        var contentType: String? = null
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
            val cut = line.indexOf(':')
            if (cut < 0) continue
            val name = line.substring(0, cut).trim().lowercase()
            val value = line.substring(cut + 1).trim()
            when (name) {
                "content-length" -> contentLength = value.toIntOrNull() ?: 0
                "authorization" -> authorization = value
                "content-type" -> contentType = value
            }
        }
        if (contentLength > 10 * 1024 * 1024) throw IOException("body too large")
        val body = ByteArray(contentLength)
        var read = 0
        while (read < contentLength) {
            val n = input.read(body, read, contentLength - read)
            if (n < 0) throw IOException("truncated body")
            read += n
        }
        return RelayRequest(
            id = UUID.randomUUID().toString(),
            method = parts[0],
            path = parts[1],
            authorization = authorization,
            contentType = contentType,
            body = String(body, Charsets.UTF_8),
        )
    }

    /** Reads one CRLF-terminated header line (ISO-8859-1 per HTTP). */
    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) {
                if (sb.isNotEmpty() && sb.last() == '\r') sb.setLength(sb.length - 1)
                return sb.toString()
            }
            sb.append(b.toChar())
            if (sb.length > 16 * 1024) throw IOException("header line too long")
        }
    }

    private fun write(out: BufferedOutputStream, response: RelayResponse) {
        val body = response.body.toByteArray(Charsets.UTF_8)
        val reason = when (response.status) {
            200 -> "OK"; 202 -> "Accepted"; 400 -> "Bad Request"; 401 -> "Unauthorized"
            405 -> "Method Not Allowed"; 500 -> "Internal Server Error"; 504 -> "Gateway Timeout"
            else -> "Status"
        }
        out.write(
            ("HTTP/1.1 ${response.status} $reason\r\n" +
                "Content-Type: ${response.contentType}\r\n" +
                "Content-Length: ${body.size}\r\n" +
                "Connection: close\r\n\r\n").toByteArray(Charsets.ISO_8859_1),
        )
        out.write(body)
        out.flush()
    }

    fun stop() {
        val socket = server ?: return
        server = null
        try {
            socket.close()
        } catch (_: IOException) {
            // closing
        }
        for ((id, complete) in pending) {
            pending.remove(id)
            complete(RelayResponse(500, """{"error":"relay stopped"}"""))
        }
    }
}
