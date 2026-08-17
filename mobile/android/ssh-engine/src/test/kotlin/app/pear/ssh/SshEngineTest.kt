package app.pear.ssh

import kotlin.concurrent.thread
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Collects engine events with simple polling waits. */
class TestEvents : EngineEvents {
    val data = ConcurrentHashMap<String, StringBuffer>()
    val stderr = ConcurrentHashMap<String, StringBuffer>()
    val exits = ConcurrentHashMap<String, Int>()
    val closedSessions = ConcurrentHashMap.newKeySet<String>()
    val progress = ConcurrentHashMap<String, MutableList<Pair<Long, Long>>>()

    override fun transferProgress(transferId: String, bytes: Long, total: Long) {
        progress.getOrPut(transferId) { java.util.Collections.synchronizedList(mutableListOf()) }
            .add(bytes to total)
    }

    override fun shellData(channelId: String, data: String) {
        this.data.getOrPut(channelId) { StringBuffer() }.append(data)
    }

    override fun shellStderr(channelId: String, data: String) {
        this.stderr.getOrPut(channelId) { StringBuffer() }.append(data)
    }

    override fun shellExit(channelId: String, code: Int) {
        exits[channelId] = code
    }

    override fun sessionClosed(sessionId: String) {
        closedSessions.add(sessionId)
    }

    fun text(channelId: String): String = data[channelId]?.toString() ?: ""

    fun errText(channelId: String): String = stderr[channelId]?.toString() ?: ""

    fun waitFor(timeoutMs: Long = 10_000, what: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (what()) return
            Thread.sleep(20)
        }
        check(what()) { "condition not met within ${timeoutMs}ms" }
    }

    fun waitForText(channelId: String, needle: String, timeoutMs: Long = 10_000) =
        waitFor(timeoutMs) { text(channelId).contains(needle) }

    fun waitForExit(channelId: String, timeoutMs: Long = 15_000): Int {
        waitFor(timeoutMs) { exits.containsKey(channelId) }
        return exits[channelId]!!
    }
}

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SshEngineTest {
    private lateinit var sshd: ScratchSshd
    private lateinit var engine: SshEngine
    private lateinit var events: TestEvents
    private lateinit var knownHosts: FileKnownHostsStore
    private lateinit var workDir: File

    private fun spec(
        trust: String? = null,
        key: String = sshd.clientKey,
        passphrase: String? = null,
    ) = ConnectSpec(
        host = "127.0.0.1",
        port = sshd.port,
        user = sshd.user,
        auth = AuthSpec(method = "key", privateKey = key, passphrase = passphrase),
        timeoutMs = 8_000,
        trustFingerprint = trust,
    )

    /** Connect with the TOFU dance already done. */
    private fun connectTrusted(): String = engine.connect(spec())

    @BeforeAll
    fun setUp() {
        sshd = ScratchSshd.start()
        events = TestEvents()
        workDir = Files.createTempDirectory("pear-engine-known").toFile()
        knownHosts = FileKnownHostsStore(File(workDir, "known_hosts"))
        engine = SshEngine(knownHosts, events)

        // TOFU dance once: first contact fails with the fingerprint, retry
        // with it pinned succeeds and persists the trust.
        val err = assertFailsWith<SshError> { engine.connect(spec()) }
        assertEquals(SshError.UNKNOWN_HOST_KEY, err.code)
        val fingerprint = assertNotNull(err.details["fingerprint"])
        assertTrue(fingerprint.startsWith("SHA256:"), "got $fingerprint")
        val id = engine.connect(spec(trust = fingerprint))
        engine.disconnect(id)
    }

    @AfterAll
    fun tearDown() {
        engine.disposeAll()
        sshd.close()
        workDir.deleteRecursively()
    }

    // ------------------------------------------------------------ connect/TOFU

    @Test
    fun `known host connects without a trust token`() {
        val id = connectTrusted()
        assertTrue(engine.isConnected(id))
        engine.disconnect(id)
        events.waitFor { events.closedSessions.contains(id) }
    }

    @Test
    fun `changed host key is refused even with a trust token`() {
        val real = knownHosts.get("127.0.0.1", sshd.port)!!
        knownHosts.put("127.0.0.1", sshd.port, "SHA256:tampered")
        try {
            val err = assertFailsWith<SshError> { engine.connect(spec(trust = "SHA256:tampered")) }
            assertEquals(SshError.HOST_KEY_CHANGED, err.code)
            assertEquals("SHA256:tampered", err.details["knownFingerprint"])
            assertEquals(real, err.details["fingerprint"])
        } finally {
            knownHosts.put("127.0.0.1", sshd.port, real)
        }
    }

    @Test
    fun `unauthorized key fails auth, not connect`() {
        val err = assertFailsWith<SshError> { engine.connect(spec(key = sshd.strangerKey)) }
        assertEquals(SshError.AUTH_FAILED, err.code)
    }

    @Test
    fun `passphrase-protected key works, wrong passphrase fails auth`() {
        val id = engine.connect(spec(key = sshd.passKey, passphrase = "secret"))
        assertTrue(engine.isConnected(id))
        engine.disconnect(id)

        val err = assertFailsWith<SshError> {
            engine.connect(spec(key = sshd.passKey, passphrase = "wrong"))
        }
        assertEquals(SshError.AUTH_FAILED, err.code)
    }

    @Test
    fun `probe measures a dial and times out on dead ports`() {
        assertTrue(engine.probe("127.0.0.1", sshd.port, 2_000) >= 0)
        assertFailsWith<Exception> { engine.probe("127.0.0.1", 1, 500) }
    }

    // ------------------------------------------------------------------- exec

    @Test
    fun `exec demuxes stdout stderr and reports the exit code`() {
        val id = connectTrusted()
        try {
            val r = engine.exec(id, "echo out; echo err >&2; exit 3")
            assertEquals(3, r.code)
            assertEquals("out\n", r.stdout)
            assertEquals("err\n", r.stderr)
        } finally {
            engine.disconnect(id)
        }
    }

    @Test
    fun `exec survives megabytes on both streams without deadlock`() {
        val id = connectTrusted()
        try {
            val r = engine.exec(
                id,
                "head -c 1048576 /dev/zero | tr '\\0' a; head -c 1048576 /dev/zero | tr '\\0' b >&2",
            )
            assertEquals(0, r.code)
            assertEquals(1048576, r.stdout.length)
            assertEquals(1048576, r.stderr.length)
        } finally {
            engine.disconnect(id)
        }
    }

    // ------------------------------------------------------------------ shell

    @Test
    fun `login shell round-trips input, resizes, and exits cleanly`() {
        val id = connectTrusted()
        try {
            val ch = engine.shellOpen(id, null, 80, 24)
            engine.shellWrite(ch, "echo pear-$((6*7))\n")
            events.waitForText(ch, "pear-42")

            engine.shellResize(ch, 120, 40)
            Thread.sleep(300)
            engine.shellWrite(ch, "stty size\n")
            events.waitForText(ch, "40 120")

            engine.shellWrite(ch, "exit\n")
            assertEquals(0, events.waitForExit(ch))
        } finally {
            engine.disconnect(id)
        }
    }

    @Test
    fun `command PTY closes on exit with its code`() {
        val id = connectTrusted()
        try {
            val ch = engine.shellOpen(id, "echo done-cmd && exit 5", 80, 24)
            assertEquals(5, events.waitForExit(ch))
            assertContains(events.text(ch), "done-cmd")
        } finally {
            engine.disconnect(id)
        }
    }

    @Test
    fun `multibyte output survives chunk boundaries intact`() {
        val id = connectTrusted()
        val remote = "/tmp/pear-utf8-${System.nanoTime()}.txt"
        try {
            val line = "привет-мир-🍐-héllo-日本語"
            val content = (1..2000).joinToString("\n") { "$it $line" } + "\n"
            engine.writeFile(id, remote, content)

            val ch = engine.shellOpen(id, "cat -- ${shq(remote)}", 500, 50)
            events.waitForExit(ch)
            val got = events.text(ch).replace("\r\n", "\n")
            assertFalse(got.contains('�'), "replacement chars — decoder split a sequence")
            assertContains(got, "2000 $line")
            assertEquals(content, got)
        } finally {
            engine.remove(id, remote, false)
            engine.disconnect(id)
        }
    }

    // ---------------------------------------------------------- exec channels

    @Test
    fun `non-PTY channel demuxes streams, takes stdin, reports the exit code`() {
        val id = connectTrusted()
        try {
            val ch = engine.shellOpen(
                id,
                "echo out; echo err >&2; read line; echo got:\$line; exit 7",
                80, 24,
                pty = false,
            )
            events.waitForText(ch, "out\n")
            engine.shellWrite(ch, "hello\n")
            assertEquals(7, events.waitForExit(ch))
            // clean streams: no CR mangling, stderr separated
            assertEquals("out\ngot:hello\n", events.text(ch))
            assertEquals("err\n", events.errText(ch))
        } finally {
            engine.disconnect(id)
        }
    }

    @Test
    fun `signals terminate a non-PTY command`() {
        val id = connectTrusted()
        try {
            val ch = engine.shellOpen(id, "sleep 30", 80, 24, pty = false)
            Thread.sleep(300)
            engine.shellSignal(ch, "TERM")
            events.waitForExit(ch, 5_000)
        } finally {
            engine.disconnect(id)
        }
    }

    // ------------------------------------------------------- via / ProxyJump

    @Test
    fun `connectVia tunnels a fully working target through a jump session`() {
        val jump = connectTrusted()
        try {
            // The scratch sshd doubles as its own jump target: the tunnel is a
            // direct-tcpip channel the jump opens back to 127.0.0.1:port, over
            // which a second, independent SSH transport handshakes + auths.
            val target = engine.connectVia(spec(), jump)
            try {
                assertTrue(target != jump, "the tunneled session must be its own connection")
                assertTrue(engine.isConnected(target))
                val result = engine.exec(target, "echo via-ok")
                assertEquals(0, result.code, "exec over tunnel failed: ${result.stderr}")
                assertContains(result.stdout, "via-ok")
                // A PTY channel rides the tunnel too.
                val ch = engine.shellOpen(target, "printf tunnel-pty", 80, 24)
                events.waitForText(ch, "tunnel-pty")
                events.waitForExit(ch)
            } finally {
                engine.disconnect(target)
            }
        } finally {
            engine.disconnect(jump)
        }
    }

    @Test
    fun `connectVia verifies the target host key, not the jump's`() {
        val jump = connectTrusted()
        try {
            // Forget the target key so TOFU must challenge on the tunneled leg —
            // proving the target's own host key is what gets verified.
            val known = knownHosts.get("127.0.0.1", sshd.port)!!
            knownHosts.forget("127.0.0.1", sshd.port)
            try {
                val err = assertFailsWith<SshError> { engine.connectVia(spec(), jump) }
                assertEquals(SshError.UNKNOWN_HOST_KEY, err.code)
                // Accepting the fingerprint lets the tunneled connect through.
                val target = engine.connectVia(spec(trust = err.details["fingerprint"]), jump)
                engine.disconnect(target)
            } finally {
                knownHosts.put("127.0.0.1", sshd.port, known)
            }
        } finally {
            engine.disconnect(jump)
        }
    }

    @Test
    fun `a tunneled session dies when its jump host drops`() {
        val jump = connectTrusted()
        val target = engine.connectVia(spec(), jump)
        assertTrue(engine.isConnected(target))
        // Killing the carrier must cascade: the target notices the tunnel EOF
        // and reports closed rather than hanging marked-connected.
        engine.disconnect(jump)
        events.waitFor(10_000) { !engine.isConnected(target) }
        assertFalse(engine.isConnected(target), "target survived its jump host dying")
    }

    // ------------------------------------------------- remote forward + relay

    @Test
    fun `mcp relay answers through an ssh remote port-forward`() {
        val seen = java.util.concurrent.atomic.AtomicReference<RelayRequest>()
        val relay = McpRelay({ request, respond ->
            seen.set(request)
            respond(RelayResponse(200, """{"echo":${request.body}}"""))
        })
        val relayPort = relay.start()
        val id = connectTrusted()
        try {
            val remotePort = engine.remoteForwardOpen(id, relayPort)
            assertTrue(remotePort > 0)
            val result = engine.exec(
                id,
                "curl -s -m 10 -X POST -H 'Authorization: Bearer tok' " +
                    "-H 'Content-Type: application/json' -d '{\"ping\":1}' " +
                    "http://127.0.0.1:$remotePort/mcp",
            )
            assertEquals(0, result.code, "curl failed: ${result.stderr}")
            assertEquals("""{"echo":{"ping":1}}""", result.stdout)
            val request = seen.get()!!
            assertEquals("/mcp", request.path)
            assertEquals("Bearer tok", request.authorization)
            assertEquals("""{"ping":1}""", request.body)
            engine.remoteForwardClose(id, remotePort)
        } finally {
            engine.disconnect(id)
            relay.stop()
        }
    }

    @Test
    fun `relay binds ipv4 loopback so the ssh forwarder can reach it`() {
        val relay = McpRelay({ _, respond -> respond(RelayResponse(200, "{}")) })
        try {
            val port = relay.start()
            // The forwarder connects to 127.0.0.1; the relay must accept there
            // (getLoopbackAddress() would be ::1 on IPv6-preferring hosts).
            java.net.Socket().use { it.connect(java.net.InetSocketAddress("127.0.0.1", port), 1000) }
        } finally {
            relay.stop()
        }
    }

    @Test
    fun `mcp relay survives a burst of tunneled requests like claude drives`() {
        val relay = McpRelay({ request, respond ->
            respond(RelayResponse(200, """{"ok":${request.body}}"""))
        })
        val relayPort = relay.start()
        val id = connectTrusted()
        try {
            val remotePort = engine.remoteForwardOpen(id, relayPort)
            // Sequential burst (MCP init/list/call pattern), then a GET the
            // relay 405s (SSE probe), then concurrent calls — all one channel
            // per request (Connection: close).
            val script = buildString {
                append("set -e; ")
                for (i in 1..12) {
                    append(
                        "curl -s -m 10 -X POST -H 'Authorization: Bearer t' " +
                            "-d '{\"n\":$i}' http://127.0.0.1:$remotePort/mcp >/dev/null; ",
                    )
                }
                append("curl -s -m 10 http://127.0.0.1:$remotePort/mcp >/dev/null || true; ")
                append("for i in \$(seq 1 8); do ")
                append(
                    "curl -s -m 10 -X POST -H 'Authorization: Bearer t' " +
                        "-d '{\"c\":1}' http://127.0.0.1:$remotePort/mcp >/dev/null & done; wait; ",
                )
                append("echo DONE")
            }
            val exitsBefore = events.exits.size
            val result = engine.exec(id, script)
            assertEquals(0, result.code, "burst failed: ${result.stderr}")
            assertContains(result.stdout, "DONE")
            // The transport must still be alive after the burst — a malformed
            // forwarded-channel reject would have disconnected it.
            assertTrue(engine.isConnected(id), "session died during the tunnel burst")
            assertEquals(exitsBefore, events.exits.size, "a channel died during the burst")
            engine.remoteForwardClose(id, remotePort)
        } finally {
            engine.disconnect(id)
            relay.stop()
        }
    }

    // ------------------------------------------------------------------- sftp

    @Test
    fun `sftp crud, listing shape, and desktop parity fallbacks`() {
        val id = connectTrusted()
        val base = "/tmp/pear-sftp-${System.nanoTime()}"
        try {
            engine.mkdir(id, base)
            engine.writeFile(id, "$base/a.txt", "alpha ✓\n")
            engine.mkdir(id, "$base/sub")

            // listing: resolved path, kinds, modes, sizes
            val listing = engine.listDir(id, base)
            assertEquals(base, listing.path)
            val byName = listing.entries.associateBy { it.name }
            assertEquals("file", byName["a.txt"]!!.kind)
            assertEquals("dir", byName["sub"]!!.kind)
            assertTrue(byName["sub"]!!.mode.startsWith("d"))
            assertEquals("alpha ✓\n".toByteArray().size.toLong(), byName["a.txt"]!!.size)

            // read/write round-trip + stat
            assertEquals("alpha ✓\n", engine.readFile(id, "$base/a.txt"))
            assertEquals("file", engine.stat(id, "$base/a.txt")!!.kind)
            assertNull(engine.stat(id, "$base/missing"))

            // size cap mirrors the desktop message
            val big = assertFailsWith<SshError> { engine.readFile(id, "$base/a.txt", maxBytes = 3) }
            assertEquals(SshError.FILE_TOO_LARGE, big.code)

            // rename onto an existing destination exercises the exec fallback
            engine.writeFile(id, "$base/b.txt", "beta\n")
            engine.rename(id, "$base/a.txt", "$base/b.txt")
            assertEquals("alpha ✓\n", engine.readFile(id, "$base/b.txt"))
            assertNull(engine.stat(id, "$base/a.txt"))

            // copy preserves content; hash matches a local digest
            engine.copy(id, "$base/b.txt", "$base/c.txt")
            val local = MessageDigest.getInstance("SHA-256")
                .digest("alpha ✓\n".toByteArray())
                .joinToString("") { "%02x".format(it) }
            assertEquals(local, engine.hash(id, "$base/c.txt"))

            // remove: plain file, then recursive tree
            engine.remove(id, "$base/c.txt", false)
            assertNull(engine.stat(id, "$base/c.txt"))
            engine.remove(id, base, true)
            assertNull(engine.stat(id, base))
        } finally {
            engine.exec(id, "rm -rf -- ${shq(base)}")
            engine.disconnect(id)
        }
    }

    // -------------------------------------------------------------- transfers

    @Test
    fun `download and upload round-trip with progress and matching hashes`() {
        val id = connectTrusted()
        val remoteBase = "/tmp/pear-xfer-${System.nanoTime()}"
        val localDir = Files.createTempDirectory("pear-xfer-local").toFile()
        try {
            // 1 MB of patterned data uploaded, downloaded back, byte-identical.
            val payload = ByteArray(1024 * 1024) { (it % 251).toByte() }
            val src = File(localDir, "src.bin").apply { writeBytes(payload) }
            engine.mkdir(id, remoteBase)

            engine.upload(id, src.absolutePath, "$remoteBase/up.bin", "t-up")
            assertEquals(payload.size.toLong(), engine.stat(id, "$remoteBase/up.bin")!!.size)

            val back = File(localDir, "back.bin")
            engine.download(id, "$remoteBase/up.bin", back.absolutePath, "t-down")
            assertTrue(payload.contentEquals(back.readBytes()), "round-trip corrupted the file")

            // both directions reported progress ending at the full size
            for (transfer in listOf("t-up", "t-down")) {
                val seen = events.progress[transfer]
                assertNotNull(seen, "no progress for $transfer")
                assertEquals(payload.size.toLong(), seen.last().first)
                assertEquals(payload.size.toLong(), seen.last().second)
            }

            // hashes agree across LocalFs and the remote host
            assertEquals(LocalFs.hash(src.absolutePath), engine.hash(id, "$remoteBase/up.bin"))
        } finally {
            engine.exec(id, "rm -rf -- ${shq(remoteBase)}")
            engine.disconnect(id)
            localDir.deleteRecursively()
        }
    }

    @Test
    fun `an aborted download fails with TRANSFER_ABORTED`() {
        val id = connectTrusted()
        val remoteBase = "/tmp/pear-abort-${System.nanoTime()}"
        val localDir = Files.createTempDirectory("pear-abort-local").toFile()
        try {
            engine.mkdir(id, remoteBase)
            engine.exec(id, "head -c 8388608 /dev/urandom > ${shq("$remoteBase/big.bin")}")
            // Abort as soon as the first progress event proves it started.
            val aborter = thread(isDaemon = true) {
                events.waitFor(10_000) { events.progress.containsKey("t-abort") }
                engine.transferAbort("t-abort")
            }
            val err = assertFailsWith<SshError> {
                engine.download(id, "$remoteBase/big.bin", File(localDir, "x").absolutePath, "t-abort")
            }
            aborter.join()
            assertEquals(SshError.TRANSFER_ABORTED, err.code)
        } finally {
            engine.exec(id, "rm -rf -- ${shq(remoteBase)}")
            engine.disconnect(id)
            localDir.deleteRecursively()
        }
    }

    @Test
    fun `LocalFs stages, lists, stats, moves, and removes like a transport`() {
        val root = Files.createTempDirectory("pear-localfs").toFile()
        try {
            val staging = LocalFs.makeStagingDir(root.absolutePath)
            assertTrue(File(staging).isDirectory)

            LocalFs.mkdir("$staging/sub")
            File("$staging/a.txt").writeText("alpha")
            val listing = LocalFs.list(staging)
            val byName = listing.entries.associateBy { it.name }
            assertEquals("file", byName["a.txt"]!!.kind)
            assertEquals("dir", byName["sub"]!!.kind)
            assertEquals(5L, byName["a.txt"]!!.size)

            assertNull(LocalFs.stat("$staging/missing"))
            LocalFs.rename("$staging/a.txt", "$staging/sub/b.txt")
            assertEquals("file", LocalFs.stat("$staging/sub/b.txt")!!.kind)

            LocalFs.remove(staging, recursive = true)
            assertNull(LocalFs.stat(staging))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `tilde resolves to the login home`() {
        val id = connectTrusted()
        try {
            val home = engine.exec(id, "printf %s \"\$HOME\"").stdout
            assertEquals(home, engine.listDir(id, "~").path)
        } finally {
            engine.disconnect(id)
        }
    }
}
