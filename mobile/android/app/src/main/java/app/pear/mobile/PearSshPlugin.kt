package app.pear.mobile

import app.pear.ssh.AuthSpec
import app.pear.ssh.ConnectSpec
import app.pear.ssh.EngineEvents
import app.pear.ssh.FileKnownHostsStore
import app.pear.ssh.RemoteEntry
import app.pear.ssh.ShellDataBatcher
import app.pear.ssh.SshEngine
import app.pear.ssh.SshError
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.io.File
import java.security.Security
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Capacitor bridge for the pure-JVM SshEngine (mobile/android/ssh-engine).
 * This layer only maps JSON ⇄ engine types, batches shell output per frame
 * (ShellDataBatcher — raw per-chunk events jank the WebView), and exposes
 * the Keystore cipher for core's write-only secret contract.
 *
 * The TS counterpart is mobile/src/app/native/pear-ssh.ts; endpoint
 * failover and session bookkeeping stay in core's SessionManager (M3).
 */
@CapacitorPlugin(name = "PearSsh")
class PearSshPlugin : Plugin() {
    private lateinit var engine: SshEngine
    private lateinit var batcher: ShellDataBatcher
    private val cipher = KeystoreCipher()
    private val pool: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "pear-ssh-call").apply { isDaemon = true }
    }

    override fun load() {
        // Android ships a stripped BouncyCastle as "BC"; sshj needs the real
        // one. Replace it app-wide before any crypto is touched.
        Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
        Security.insertProviderAt(BouncyCastleProvider(), 1)

        batcher = ShellDataBatcher({ channelId, data ->
            notifyListeners("shellData", JSObject().put("channelId", channelId).put("data", data))
        })
        engine = SshEngine(
            FileKnownHostsStore(File(context.filesDir, "known_hosts")),
            object : EngineEvents {
                override fun shellData(channelId: String, data: String) {
                    batcher.add(channelId, data)
                }

                override fun shellExit(channelId: String, code: Int) {
                    // Queue behind pending data so the tail is never lost.
                    batcher.run {
                        notifyListeners(
                            "shellExit",
                            JSObject().put("channelId", channelId).put("code", code),
                        )
                    }
                }

                override fun sessionClosed(sessionId: String) {
                    batcher.run {
                        notifyListeners("sessionClosed", JSObject().put("sessionId", sessionId))
                    }
                }
            },
        )
    }

    override fun handleOnDestroy() {
        engine.disposeAll()
        batcher.shutdown()
        pool.shutdown()
    }

    /** Run `block` off the bridge thread; map SshError codes onto the reject. */
    private fun async(call: PluginCall, block: () -> JSObject) {
        pool.execute {
            try {
                call.resolve(block())
            } catch (e: SshError) {
                val data = JSObject()
                for ((k, v) in e.details) data.put(k, v)
                call.reject(e.message, e.code, null, data)
            } catch (e: Exception) {
                call.reject(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    private fun PluginCall.session(): String =
        getString("sessionId") ?: throw SshError(SshError.NO_SESSION, "sessionId missing")

    private fun PluginCall.channel(): String =
        getString("channelId") ?: throw SshError(SshError.NO_CHANNEL, "channelId missing")

    private fun PluginCall.path(name: String = "path"): String =
        getString(name) ?: throw SshError(SshError.SFTP_FAILED, "$name missing")

    // -------------------------------------------------------------- lifecycle

    @PluginMethod
    fun connect(call: PluginCall) = async(call) {
        val auth = call.getObject("auth") ?: JSObject()
        val spec = ConnectSpec(
            host = call.getString("host") ?: throw SshError(SshError.CONNECT_FAILED, "host missing"),
            port = call.getInt("port") ?: 22,
            user = call.getString("user") ?: "root",
            auth = AuthSpec(
                method = auth.getString("method") ?: "key",
                password = auth.getString("password"),
                privateKey = auth.getString("privateKey"),
                passphrase = auth.getString("passphrase"),
            ),
            timeoutMs = call.getInt("timeoutMs") ?: 15_000,
            trustFingerprint = call.getString("trustFingerprint"),
        )
        JSObject().put("sessionId", engine.connect(spec))
    }

    @PluginMethod
    fun disconnect(call: PluginCall) = async(call) {
        engine.disconnect(call.session())
        JSObject()
    }

    @PluginMethod
    fun isConnected(call: PluginCall) = async(call) {
        JSObject().put("connected", engine.isConnected(call.session()))
    }

    @PluginMethod
    fun forgetHostKey(call: PluginCall) = async(call) {
        engine.forgetHostKey(call.path("host"), call.getInt("port") ?: 22)
        JSObject()
    }

    @PluginMethod
    fun probe(call: PluginCall) = async(call) {
        val ms = engine.probe(
            call.path("host"),
            call.getInt("port") ?: 22,
            call.getInt("timeoutMs") ?: 4_000,
        )
        JSObject().put("ms", ms)
    }

    // ------------------------------------------------------------ exec/shell

    @PluginMethod
    fun exec(call: PluginCall) = async(call) {
        val result = engine.exec(call.session(), call.path("command"))
        JSObject()
            .put("code", result.code)
            .put("stdout", result.stdout)
            .put("stderr", result.stderr)
    }

    @PluginMethod
    fun shellOpen(call: PluginCall) = async(call) {
        val channelId = engine.shellOpen(
            call.session(),
            call.getString("command"),
            call.getInt("cols") ?: 80,
            call.getInt("rows") ?: 24,
        )
        JSObject().put("channelId", channelId)
    }

    @PluginMethod
    fun shellWrite(call: PluginCall) = async(call) {
        engine.shellWrite(call.channel(), call.getString("data") ?: "")
        JSObject()
    }

    @PluginMethod
    fun shellResize(call: PluginCall) = async(call) {
        engine.shellResize(call.channel(), call.getInt("cols") ?: 80, call.getInt("rows") ?: 24)
        JSObject()
    }

    @PluginMethod
    fun shellClose(call: PluginCall) = async(call) {
        engine.shellClose(call.channel())
        JSObject()
    }

    // ------------------------------------------------------------------ sftp

    private fun RemoteEntry.toJs(): JSObject = JSObject()
        .put("name", name)
        .put("kind", kind)
        .put("size", size)
        .put("mtimeMs", mtimeMs)
        .put("mode", mode)

    @PluginMethod
    fun sftpList(call: PluginCall) = async(call) {
        val listing = engine.listDir(call.session(), call.path())
        val entries = JSArray()
        for (entry in listing.entries) entries.put(entry.toJs())
        JSObject().put("path", listing.path).put("entries", entries)
    }

    @PluginMethod
    fun sftpRead(call: PluginCall) = async(call) {
        val maxBytes = call.getInt("maxBytes")?.toLong() ?: (5L * 1024 * 1024)
        JSObject().put("content", engine.readFile(call.session(), call.path(), maxBytes))
    }

    @PluginMethod
    fun sftpWrite(call: PluginCall) = async(call) {
        engine.writeFile(call.session(), call.path(), call.getString("content") ?: "")
        JSObject()
    }

    @PluginMethod
    fun sftpStat(call: PluginCall) = async(call) {
        val entry = engine.stat(call.session(), call.path())
        val out = JSObject().put("exists", entry != null)
        entry?.let { out.put("entry", it.toJs()) }
        out
    }

    @PluginMethod
    fun sftpMkdir(call: PluginCall) = async(call) {
        engine.mkdir(call.session(), call.path())
        JSObject()
    }

    @PluginMethod
    fun sftpRemove(call: PluginCall) = async(call) {
        engine.remove(call.session(), call.path(), call.getBoolean("recursive") ?: false)
        JSObject()
    }

    @PluginMethod
    fun sftpRename(call: PluginCall) = async(call) {
        engine.rename(call.session(), call.path("oldPath"), call.path("newPath"))
        JSObject()
    }

    @PluginMethod
    fun sftpCopy(call: PluginCall) = async(call) {
        engine.copy(call.session(), call.path("src"), call.path("dest"))
        JSObject()
    }

    @PluginMethod
    fun sftpHash(call: PluginCall) = async(call) {
        JSObject().put("hash", engine.hash(call.session(), call.path()))
    }

    // ---------------------------------------------------------------- cipher

    @PluginMethod
    fun cipherAvailable(call: PluginCall) = async(call) {
        JSObject().put("available", cipher.available())
    }

    @PluginMethod
    fun cipherEncrypt(call: PluginCall) = async(call) {
        JSObject().put("cipher", cipher.encrypt(call.getString("plain") ?: ""))
    }

    @PluginMethod
    fun cipherDecrypt(call: PluginCall) = async(call) {
        JSObject().put("plain", cipher.decrypt(call.path("cipher")))
    }
}
