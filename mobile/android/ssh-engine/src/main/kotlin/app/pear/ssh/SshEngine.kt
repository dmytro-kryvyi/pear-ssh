package app.pear.ssh

import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.connection.channel.direct.Signal
import net.schmizz.sshj.connection.channel.forwarded.RemotePortForwarder
import net.schmizz.sshj.connection.channel.forwarded.SocketForwardingConnectListener
import net.schmizz.sshj.sftp.FileAttributes
import net.schmizz.sshj.sftp.OpenMode
import net.schmizz.sshj.sftp.RemoteFile
import net.schmizz.sshj.sftp.Response
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.sftp.SFTPException
import net.schmizz.sshj.transport.TransportException
import net.schmizz.sshj.userauth.UserAuthException
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import net.schmizz.sshj.connection.channel.direct.PTYMode
import net.schmizz.sshj.userauth.method.AuthKeyboardInteractive
import net.schmizz.sshj.userauth.method.AuthPassword
import net.schmizz.sshj.userauth.method.PasswordResponseProvider
import net.schmizz.sshj.userauth.password.PasswordUtils
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.util.EnumSet
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

private const val TERM = "xterm-256color"
private const val DEFAULT_MAX_READ = 5L * 1024 * 1024
private const val KEEPALIVE_SECONDS = 15

/**
 * The blocking SSH engine behind the PearSsh Capacitor plugin. Pure JVM —
 * no Android or Capacitor types — so the whole thing is exercised by JVM
 * tests against a scratch sshd. Semantics mirror the desktop ssh2 transport
 * (core/src/node/connection.ts): merged PTY stdout+stderr, sequential
 * SFTP-with-exec fallbacks, '~' resolution, identical mode strings.
 *
 * All methods block; the embedder dispatches them onto its own executor.
 */
class SshEngine(
    private val knownHosts: KnownHostsStore,
    private val events: EngineEvents,
) {
    private class SessionState(val id: String, val client: SSHClient) {
        val sftpLock = Any()
        var sftp: SFTPClient? = null
        val closed = AtomicBoolean(false)
        val forwards = ConcurrentHashMap<Int, RemotePortForwarder.Forward>()
    }

    private class ChannelState(
        val id: String,
        val sessionId: String,
        val session: Session,
        val channel: Session.Command,
        val exited: AtomicBoolean = AtomicBoolean(false),
    )

    private val sessions = ConcurrentHashMap<String, SessionState>()
    private val channels = ConcurrentHashMap<String, ChannelState>()

    // ---------------------------------------------------------------- connect

    /** Dial + verify + authenticate one endpoint; returns the session id. */
    fun connect(spec: ConnectSpec): String {
        val client = SSHClient(DefaultConfig())
        val verifier = addVerifier(client, spec)
        client.connectTimeout = spec.timeoutMs
        try {
            client.connect(spec.host, spec.port)
        } catch (e: IOException) {
            quietly { client.close() }
            throw verifier.failure
                ?: SshError(SshError.CONNECT_FAILED, e.message ?: "connect failed", cause = e)
        }
        return authAndRegister(client, spec, verifier)
    }

    /**
     * Connect to `spec.host:spec.port` through an already-connected jump
     * session (ProxyJump / `via`). The TCP leg is a direct-tcpip channel the
     * jump opens on our behalf; the target's transport + auth still run
     * end-to-end over that tunnel, so the jump never sees the target's
     * credentials and TOFU verifies the *target's* host key. Returns a fresh
     * session id that behaves like any other — channels, SFTP, forwards, and
     * disconnect all ride the tunnel and it cascades closed when the jump dies.
     */
    fun connectVia(spec: ConnectSpec, jumpSessionId: String): String {
        val jump = require(jumpSessionId)
        val client = SSHClient(DefaultConfig())
        val verifier = addVerifier(client, spec)
        val direct = try {
            jump.client.newDirectConnection(spec.host, spec.port)
        } catch (e: IOException) {
            quietly { client.close() }
            throw SshError(
                SshError.CONNECT_FAILED,
                "the jump host could not reach ${spec.host}:${spec.port}: ${e.message}",
                cause = e,
            )
        }
        try {
            client.connectVia(direct)
        } catch (e: IOException) {
            quietly { client.close() }
            throw verifier.failure
                ?: SshError(SshError.CONNECT_FAILED, e.message ?: "connect via jump failed", cause = e)
        }
        return authAndRegister(client, spec, verifier)
    }

    private fun addVerifier(client: SSHClient, spec: ConnectSpec): TofuVerifier {
        val verifier = TofuVerifier(knownHosts, spec.host, spec.port, spec.trustFingerprint)
        client.addHostKeyVerifier(verifier)
        return verifier
    }

    /** Shared tail of connect()/connectVia(): authenticate, then register the
     *  live session with keepalive + disconnect instrumentation. */
    private fun authAndRegister(client: SSHClient, spec: ConnectSpec, verifier: TofuVerifier): String {
        try {
            authenticate(client, spec)
        } catch (e: SshError) {
            quietly { client.disconnect() }
            throw e
        } catch (e: UserAuthException) {
            quietly { client.disconnect() }
            throw SshError(SshError.AUTH_FAILED, e.message ?: "authentication failed", cause = e)
        } catch (e: IOException) {
            quietly { client.disconnect() }
            throw SshError(SshError.CONNECT_FAILED, e.message ?: "connect failed", cause = e)
        }
        client.connection.keepAlive.keepAliveInterval = KEEPALIVE_SECONDS

        val state = SessionState(UUID.randomUUID().toString(), client)
        client.transport.disconnectListener =
            net.schmizz.sshj.transport.DisconnectListener { reason, message ->
                val detail = message.ifBlank { reason.toString() }
                onSessionDead(state, "ssh session closed: $detail")
            }
        sessions[state.id] = state
        // The disconnect may have fired between listener install and
        // registration — onSessionDead saw no map entry then, so evict the
        // already-dead state rather than leaking a zombie session.
        if (state.closed.get()) sessions.remove(state.id)
        return state.id
    }

    private fun authenticate(client: SSHClient, spec: ConnectSpec) {
        val auth = spec.auth
        when (auth.method) {
            "password" -> {
                val password = auth.password
                    ?: throw SshError(SshError.AUTH_FAILED, "password auth selected but no password given")
                // Mirror desktop tryKeyboard: some sshds only offer
                // keyboard-interactive; answer its prompts with the password.
                client.auth(
                    spec.user,
                    AuthPassword(PasswordUtils.createOneOff(password.toCharArray())),
                    AuthKeyboardInteractive(
                        PasswordResponseProvider(PasswordUtils.createOneOff(password.toCharArray())),
                    ),
                )
            }
            "key" -> {
                val keyText = auth.privateKey
                    ?: throw SshError(SshError.AUTH_FAILED, "key auth selected but no key given")
                val provider: KeyProvider = try {
                    client.loadKeys(
                        keyText,
                        null,
                        auth.passphrase?.let { PasswordUtils.createOneOff(it.toCharArray()) },
                    )
                } catch (e: IOException) {
                    throw SshError(
                        SshError.AUTH_FAILED,
                        "unable to load private key: ${e.message}",
                        cause = e,
                    )
                }
                client.authPublickey(spec.user, provider)
            }
            else -> throw SshError(
                SshError.UNSUPPORTED_AUTH,
                "auth method '${auth.method}' is not supported on this platform",
            )
        }
    }

    private fun onSessionDead(state: SessionState, reason: String? = null) {
        if (!state.closed.compareAndSet(false, true)) return
        sessions.remove(state.id)
        for ((id, ch) in channels) {
            if (ch.sessionId == state.id) {
                channels.remove(id)
                if (ch.exited.compareAndSet(false, true)) {
                    // Route the disconnect reason to the channel's stderr so
                    // callers can report *why* -1 happened (batcher flushes
                    // stderr before the exit event — see ShellDataBatcher.run).
                    if (reason != null) events.shellStderr(id, reason + "\n")
                    events.shellExit(id, -1)
                }
            }
        }
        events.sessionClosed(state.id)
    }

    fun isConnected(sessionId: String): Boolean =
        sessions[sessionId]?.client?.isConnected ?: false

    fun disconnect(sessionId: String) {
        val state = sessions[sessionId] ?: return
        quietly { state.client.disconnect() }
        onSessionDead(state)
    }

    fun forgetHostKey(host: String, port: Int) = knownHosts.forget(host, port)

    /** TCP-dial an endpoint and report latency; mirrors desktop hosts.probe. */
    fun probe(host: String, port: Int, timeoutMs: Int): Long {
        val started = System.nanoTime()
        Socket().use { it.connect(InetSocketAddress(host, port), timeoutMs) }
        return (System.nanoTime() - started) / 1_000_000
    }

    private fun require(sessionId: String): SessionState =
        sessions[sessionId] ?: throw SshError(SshError.NO_SESSION, "no session $sessionId")

    // ------------------------------------------------------------------- exec

    /** Run a single command, collect demuxed stdout/stderr, wait for exit. */
    fun exec(sessionId: String, command: String): ExecResult {
        val state = require(sessionId)
        val session = state.client.startSession()
        try {
            val cmd = session.exec(command)
            var stderrBytes = ByteArray(0)
            // Drain stderr concurrently — reading the streams sequentially
            // deadlocks when the unread one exhausts its flow-control window.
            val errReader = thread(name = "pear-ssh-exec-err", isDaemon = true) {
                stderrBytes = quietlyOr(ByteArray(0)) { cmd.errorStream.readBytes() }
            }
            val stdoutBytes = quietlyOr(ByteArray(0)) { cmd.inputStream.readBytes() }
            errReader.join()
            quietly { cmd.join() }
            return ExecResult(
                code = cmd.exitStatus ?: -1,
                stdout = String(stdoutBytes, Charsets.UTF_8),
                stderr = String(stderrBytes, Charsets.UTF_8),
            )
        } finally {
            quietly { session.close() }
        }
    }

    private fun mustExec(sessionId: String, command: String, what: String) {
        val result = exec(sessionId, command)
        if (result.code != 0) {
            throw SshError(
                SshError.EXEC_FAILED,
                "$what failed: ${result.stderr.trim().ifEmpty { "exit ${result.code}" }}",
            )
        }
    }

    // ------------------------------------------------------------------ shell

    /**
     * Open a command/shell channel. With `pty` (the default): a terminal —
     * login shell when `command` is null, stdout+stderr merged like the
     * desktop transport. Without `pty`: a streaming exec channel with clean
     * demuxed streams (shellStderr events) — what the Claude stream-json
     * runtime rides on.
     */
    fun shellOpen(
        sessionId: String,
        command: String?,
        cols: Int,
        rows: Int,
        pty: Boolean = true,
    ): String {
        val state = require(sessionId)
        val session = state.client.startSession()
        val channel: Session.Command
        try {
            if (pty) session.allocatePTY(TERM, cols, rows, 0, 0, emptyMap<PTYMode, Int>())
            channel = if (command == null) {
                session.startShell() as Session.Command
            } else {
                session.exec(command)
            }
        } catch (e: Exception) {
            quietly { session.close() }
            throw e
        }
        val ch = ChannelState(UUID.randomUUID().toString(), sessionId, session, channel)
        channels[ch.id] = ch

        val stderrDone = AtomicBoolean(false)
        thread(name = "pear-ssh-ch-${ch.id}-err", isDaemon = true) {
            if (pty) {
                pump(channel.errorStream::read, ch.id, events::shellData)
            } else {
                pump(channel.errorStream::read, ch.id, events::shellStderr)
            }
            stderrDone.set(true)
        }
        thread(name = "pear-ssh-ch-${ch.id}-out", isDaemon = true) {
            pump(channel.inputStream::read, ch.id, events::shellData)
            // stdout EOF = channel is closing; give stderr up to 2s to drain
            // so its tail is not lost behind the exit event. Accepted
            // tradeoff: stderr slower than that is delivered after the exit
            // event — a bounded wait beats wedging the exit indefinitely on
            // a silent stderr stream.
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            while (!stderrDone.get() && System.nanoTime() < deadline) Thread.sleep(5)
            quietly { channel.join(2, TimeUnit.SECONDS) }
            channels.remove(ch.id)
            if (ch.exited.compareAndSet(false, true)) {
                // null exitStatus = the remote died to a signal (exit-signal)
                // or the channel closed without a status — report -1 like
                // exec() does, never a fake success.
                events.shellExit(ch.id, channel.exitStatus ?: -1)
            }
            quietly { session.close() }
        }
        return ch.id
    }

    private fun pump(
        read: (ByteArray) -> Int,
        channelId: String,
        emit: (String, String) -> Unit,
    ) {
        val decoder = StreamingUtf8()
        val buf = ByteArray(32 * 1024)
        while (true) {
            val n = try {
                read(buf)
            } catch (_: IOException) {
                -1
            }
            if (n < 0) break
            if (n == 0) continue
            val text = decoder.decode(buf, 0, n)
            if (text.isNotEmpty()) emit(channelId, text)
        }
        val tail = decoder.finish()
        if (tail.isNotEmpty()) emit(channelId, tail)
    }

    private fun channel(channelId: String): ChannelState =
        channels[channelId] ?: throw SshError(SshError.NO_CHANNEL, "no channel $channelId")

    fun shellWrite(channelId: String, data: String) {
        val ch = channel(channelId)
        val out = ch.channel.outputStream
        out.write(data.toByteArray(Charsets.UTF_8))
        out.flush()
    }

    fun shellResize(channelId: String, cols: Int, rows: Int) {
        val ch = channels[channelId] ?: return
        (ch.channel as? Session.Shell)?.changeWindowDimensions(cols, rows, 0, 0)
    }

    /** Deliver a signal (TERM, INT, KILL…) to a channel's remote process. */
    fun shellSignal(channelId: String, name: String) {
        val ch = channels[channelId] ?: return
        val signal = try {
            Signal.valueOf(name.uppercase())
        } catch (_: IllegalArgumentException) {
            throw SshError(SshError.NO_CHANNEL, "unknown signal '$name'")
        }
        quietly { ch.channel.signal(signal) }
    }

    fun shellClose(channelId: String) {
        val ch = channels[channelId] ?: return
        quietly { ch.session.close() }
    }

    // --------------------------------------------------------- port forwards

    /**
     * Ask the server to listen on a loopback port and tunnel connections back
     * to 127.0.0.1:targetPort on this device (the MCP relay). Returns the
     * server-allocated remote port. `remotePort` re-requests a specific port —
     * re-establishing a tunnel after a redial keeps the address a running
     * claude already has in its .mcp.json valid.
     */
    fun remoteForwardOpen(sessionId: String, targetPort: Int, remotePort: Int = 0): Int {
        val state = require(sessionId)
        val forward = try {
            state.client.remotePortForwarder.bind(
                RemotePortForwarder.Forward("127.0.0.1", remotePort),
                SocketForwardingConnectListener(InetSocketAddress("127.0.0.1", targetPort)),
            )
        } catch (e: Exception) {
            // The server refused the tcpip-forward request — almost always
            // `AllowTcpForwarding no` (or `remote`/`local`-only) in sshd_config.
            throw SshError(
                SshError.FORWARD_DENIED,
                "the SSH server refused a remote port-forward (AllowTcpForwarding)",
                cause = e,
            )
        }
        state.forwards[forward.port] = forward
        return forward.port
    }

    fun remoteForwardClose(sessionId: String, remotePort: Int) {
        val state = sessions[sessionId] ?: return
        val forward = state.forwards.remove(remotePort) ?: return
        quietly { state.client.remotePortForwarder.cancel(forward) }
    }

    // ------------------------------------------------------------------- sftp

    private fun sftp(state: SessionState): SFTPClient = synchronized(state.sftpLock) {
        state.sftp ?: state.client.newSFTPClient().also { state.sftp = it }
    }

    private fun resolveInput(path: String): String =
        if (path == "~" || path.isEmpty()) "." else path

    /** List a directory; '~'/'' resolve to the login home (desktop parity). */
    fun listDir(sessionId: String, path: String): DirListingData {
        val sftp = sftp(require(sessionId))
        val resolved = sftp.canonicalize(resolveInput(path))
        val entries = sftp.ls(resolved).map { info ->
            entryOf(info.name, info.attributes)
        }
        return DirListingData(resolved, entries)
    }

    private fun entryOf(name: String, attrs: FileAttributes): RemoteEntry {
        val mask = attrs.mode.mask
        return RemoteEntry(
            name = name,
            kind = kindOf(mask),
            size = attrs.size,
            mtimeMs = attrs.mtime * 1000,
            mode = modeString(mask),
        )
    }

    fun readFile(sessionId: String, path: String, maxBytes: Long = DEFAULT_MAX_READ): String {
        val sftp = sftp(require(sessionId))
        val size = sftp.stat(path).size
        if (size > maxBytes) {
            throw SshError(
                SshError.FILE_TOO_LARGE,
                "File is ${"%.1f".format(size / 1024.0 / 1024.0)} MB — too large to edit",
                mapOf("size" to size.toString()),
            )
        }
        val file: RemoteFile = sftp.open(path)
        try {
            return file.RemoteFileInputStream().use { String(it.readBytes(), Charsets.UTF_8) }
        } finally {
            quietly { file.close() }
        }
    }

    fun writeFile(sessionId: String, path: String, content: String) {
        val sftp = sftp(require(sessionId))
        val modes = EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.TRUNC)
        val file = sftp.open(path, modes)
        try {
            file.RemoteFileOutputStream().use { it.write(content.toByteArray(Charsets.UTF_8)) }
        } finally {
            quietly { file.close() }
        }
    }

    /** lstat; null when the path does not exist (desktop parity). */
    fun stat(sessionId: String, path: String): RemoteEntry? {
        val sftp = sftp(require(sessionId))
        val attrs = try {
            sftp.lstat(path)
        } catch (e: SFTPException) {
            if (e.statusCode == Response.StatusCode.NO_SUCH_FILE) return null
            throw e
        }
        return entryOf(path.trimEnd('/').substringAfterLast('/').ifEmpty { "/" }, attrs)
    }

    fun mkdir(sessionId: String, path: String) {
        sftp(require(sessionId)).mkdir(path)
    }

    fun remove(sessionId: String, path: String, recursive: Boolean) {
        if (recursive) return mustExec(sessionId, "rm -rf -- ${shq(path)}", "delete")
        val entry = stat(sessionId, path) ?: return
        val sftp = sftp(require(sessionId))
        if (entry.kind == "dir") sftp.rmdir(path) else sftp.rm(path)
    }

    fun rename(sessionId: String, oldPath: String, newPath: String) {
        try {
            sftp(require(sessionId)).rename(oldPath, newPath)
        } catch (_: SFTPException) {
            // SFTP RENAME refuses existing destinations and cross-device moves.
            mustExec(sessionId, "mv -f -- ${shq(oldPath)} ${shq(newPath)}", "move")
        }
    }

    fun copy(sessionId: String, src: String, dest: String) {
        mustExec(sessionId, "cp -a -- ${shq(src)} ${shq(dest)}", "copy")
    }

    /** SHA-256 hex digest via remote coreutils (desktop hash.ts parity). */
    fun hash(sessionId: String, path: String): String {
        val cmd = "sha256sum -- ${shq(path)} 2>/dev/null || shasum -a 256 -- ${shq(path)}"
        val result = exec(sessionId, cmd)
        val token = result.stdout.trim().split(Regex("\\s+")).firstOrNull() ?: ""
        if (result.code != 0 || !Regex("^[0-9a-f]{64}$", RegexOption.IGNORE_CASE).matches(token)) {
            throw SshError(
                SshError.EXEC_FAILED,
                "checksum failed for $path: ${result.stderr.trim().ifEmpty { "exit ${result.code}" }}",
            )
        }
        return token.lowercase()
    }

    // -------------------------------------------------------------- transfers

    private val aborts = ConcurrentHashMap<String, AtomicBoolean>()

    /** Cancel a running download/upload; it fails with TRANSFER_ABORTED. */
    fun transferAbort(transferId: String) {
        aborts[transferId]?.set(true)
    }

    /** Stream a remote file to a local path, with throttled progress events. */
    fun download(sessionId: String, remotePath: String, localPath: String, transferId: String? = null) {
        val sftp = sftp(require(sessionId))
        val total = sftp.stat(remotePath).size
        val file: RemoteFile = sftp.open(remotePath)
        try {
            // Read-ahead pipelines SFTP requests — plain reads round-trip
            // per 32KB block and crawl on any real-world latency.
            file.ReadAheadRemoteFileInputStream(16).use { input ->
                java.io.FileOutputStream(localPath).use { output ->
                    pumpBytes(input, output, total, transferId)
                }
            }
        } finally {
            quietly { file.close() }
        }
    }

    /** Stream a local file to an exact remote path, with progress events. */
    fun upload(sessionId: String, localPath: String, remotePath: String, transferId: String? = null) {
        val sftp = sftp(require(sessionId))
        val local = java.io.File(localPath)
        val total = local.length()
        val modes = EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.TRUNC)
        val file = sftp.open(remotePath, modes)
        try {
            java.io.FileInputStream(local).use { input ->
                file.RemoteFileOutputStream(0, 16).use { output ->
                    pumpBytes(input, output, total, transferId)
                }
            }
        } finally {
            quietly { file.close() }
        }
    }

    private fun pumpBytes(
        input: java.io.InputStream,
        output: java.io.OutputStream,
        total: Long,
        transferId: String?,
    ) {
        val flag = transferId?.let { id -> AtomicBoolean(false).also { aborts[id] = it } }
        try {
            // ≤32KB per write: sshj maps each write() onto ONE SFTP request,
            // and servers cap the message size (~256KB incl. headers) — a big
            // buffer kills the whole SFTP channel. Throughput comes from the
            // 16-deep request pipelining, not the buffer size.
            val buf = ByteArray(32 * 1024)
            var done = 0L
            var lastEmit = 0L
            while (true) {
                if (flag?.get() == true) {
                    throw SshError(SshError.TRANSFER_ABORTED, "transfer canceled")
                }
                val n = input.read(buf)
                if (n < 0) break
                output.write(buf, 0, n)
                done += n
                val now = System.currentTimeMillis()
                if (transferId != null && now - lastEmit >= 100) {
                    lastEmit = now
                    events.transferProgress(transferId, done, total)
                }
            }
            output.flush()
            if (transferId != null) events.transferProgress(transferId, done, total)
        } finally {
            transferId?.let { aborts.remove(it) }
        }
    }

    // ---------------------------------------------------------------- cleanup

    fun disposeAll() {
        for (state in sessions.values) quietly { state.client.disconnect() }
        sessions.clear()
        channels.clear()
    }
}

private inline fun quietly(block: () -> Unit) {
    try {
        block()
    } catch (_: Exception) {
        // teardown path — best effort
    }
}

private inline fun <T> quietlyOr(fallback: T, block: () -> T): T = try {
    block()
} catch (_: Exception) {
    fallback
}
