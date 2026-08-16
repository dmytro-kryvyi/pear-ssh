package app.pear.ssh

import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files

/**
 * Throwaway OpenSSH server for engine tests — the desktop verify pattern
 * (scratch sshd on a loopback high port) adapted to JUnit. Runs as the
 * current user with key-only auth against generated keys; everything lives
 * in a temp dir removed on close.
 */
class ScratchSshd private constructor(
    val port: Int,
    val user: String,
    val dir: File,
    private val process: Process,
) : AutoCloseable {

    val clientKey: String get() = File(dir, "id_ed25519").readText()
    val passKey: String get() = File(dir, "id_pass").readText()
    val strangerKey: String get() = File(dir, "id_stranger").readText()

    companion object {
        fun start(): ScratchSshd {
            val dir = Files.createTempDirectory("pear-scratch-sshd").toFile()
            sh("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", "${dir.absolutePath}/host_ed25519")
            sh("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", "${dir.absolutePath}/id_ed25519")
            sh("ssh-keygen", "-q", "-t", "ed25519", "-N", "secret", "-f", "${dir.absolutePath}/id_pass")
            sh("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", "${dir.absolutePath}/id_stranger")

            val authorized = File(dir, "authorized_keys")
            authorized.writeText(
                File(dir, "id_ed25519.pub").readText() + File(dir, "id_pass.pub").readText(),
            )
            authorized.setReadable(false, false)
            authorized.setWritable(false, false)
            authorized.setReadable(true, true)
            authorized.setWritable(true, true)

            val port = ServerSocket(0).use { it.localPort }
            val config = File(dir, "sshd_config")
            config.writeText(
                """
                Port $port
                ListenAddress 127.0.0.1
                HostKey ${dir.absolutePath}/host_ed25519
                PidFile ${dir.absolutePath}/sshd.pid
                AuthorizedKeysFile ${dir.absolutePath}/authorized_keys
                StrictModes no
                UsePAM no
                PasswordAuthentication no
                KbdInteractiveAuthentication no
                Subsystem sftp internal-sftp
                """.trimIndent() + "\n",
            )

            val process = ProcessBuilder(
                "/usr/sbin/sshd", "-D",
                "-f", config.absolutePath,
                "-E", "${dir.absolutePath}/sshd.log",
            ).start()

            val deadline = System.currentTimeMillis() + 10_000
            while (System.currentTimeMillis() < deadline) {
                if (!process.isAlive) {
                    error("sshd died on startup:\n" + File(dir, "sshd.log").let {
                        if (it.exists()) it.readText() else "(no log)"
                    })
                }
                try {
                    Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 250) }
                    return ScratchSshd(port, System.getProperty("user.name"), dir, process)
                } catch (_: Exception) {
                    Thread.sleep(100)
                }
            }
            process.destroyForcibly()
            error("scratch sshd never came up on :$port")
        }

        private fun sh(vararg cmd: String) {
            val p = ProcessBuilder(*cmd).redirectErrorStream(true).start()
            val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
            check(p.waitFor() == 0) { "${cmd.joinToString(" ")} failed:\n$out" }
        }
    }

    override fun close() {
        process.destroyForcibly()
        process.waitFor()
        dir.deleteRecursively()
    }
}
