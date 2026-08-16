package app.pear.ssh

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
    val exits = ConcurrentHashMap<String, Int>()
    val closedSessions = ConcurrentHashMap.newKeySet<String>()

    override fun shellData(channelId: String, data: String) {
        this.data.getOrPut(channelId) { StringBuffer() }.append(data)
    }

    override fun shellExit(channelId: String, code: Int) {
        exits[channelId] = code
    }

    override fun sessionClosed(sessionId: String) {
        closedSessions.add(sessionId)
    }

    fun text(channelId: String): String = data[channelId]?.toString() ?: ""

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
