package app.pear.ssh

import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Engine half of the M2 throughput spike: how fast PTY output moves from
 * sshd through sshj and the streaming decoder into EngineEvents. The other
 * half — the same bytes crossing the Capacitor bridge — needs a real device
 * (see mobile/src/app/native/pear-ssh.ts benchPty).
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ThroughputTest {
    private lateinit var sshd: ScratchSshd
    private lateinit var engine: SshEngine
    private lateinit var events: TestEvents
    private lateinit var dir: File

    @BeforeAll
    fun setUp() {
        sshd = ScratchSshd.start()
        events = TestEvents()
        dir = Files.createTempDirectory("pear-bench-known").toFile()
        engine = SshEngine(FileKnownHostsStore(File(dir, "known_hosts")), events)
        val spec = ConnectSpec(
            host = "127.0.0.1", port = sshd.port, user = sshd.user,
            auth = AuthSpec(method = "key", privateKey = sshd.clientKey),
        )
        val err = assertFailsWith<SshError> { engine.connect(spec) }
        engine.disconnect(engine.connect(spec.copy(trustFingerprint = err.details["fingerprint"])))
    }

    @AfterAll
    fun tearDown() {
        engine.disposeAll()
        sshd.close()
        dir.deleteRecursively()
    }

    @Test
    fun `pty throughput stays terminal-grade`() {
        val spec = ConnectSpec(
            host = "127.0.0.1", port = sshd.port, user = sshd.user,
            auth = AuthSpec(method = "key", privateKey = sshd.clientKey),
        )
        val id = engine.connect(spec)
        try {
            val payload = 8 * 1024 * 1024
            val started = System.nanoTime()
            val ch = engine.shellOpen(id, "head -c $payload /dev/zero | base64", 80, 24)
            assertEquals(0, events.waitForExit(ch, 60_000))
            val seconds = (System.nanoTime() - started) / 1e9
            val chars = events.text(ch).length
            val mbps = chars / 1024.0 / 1024.0 / seconds
            println("PTY throughput: %,d chars in %.2fs = %.1f MB/s".format(chars, seconds, mbps))
            // base64 of 8 MB is ~10.7 MB + line breaks
            assertTrue(chars > 10_900_000, "expected full payload, got $chars chars")
            assertTrue(mbps > 1.0, "engine-side PTY throughput below 1 MB/s: $mbps")
        } finally {
            engine.disconnect(id)
        }
    }
}
