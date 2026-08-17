package app.pear.mobile

import app.pear.ssh.AuthSpec
import app.pear.ssh.ConnectSpec
import app.pear.ssh.EngineEvents
import app.pear.ssh.FileKnownHostsStore
import app.pear.ssh.McpRelay
import app.pear.ssh.RelayResponse
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
    private var relay: McpRelay? = null
    private val cipher = KeystoreCipher()
    private val pool: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "pear-ssh-call").apply { isDaemon = true }
    }
    /** Live engine sessions — drives the keep-alive foreground service. */
    private val liveSessions = java.util.Collections.synchronizedSet(HashSet<String>())

    // ------------------------------------------------------------- keep-alive

    private fun sessionOpened(sessionId: String) {
        liveSessions.add(sessionId)
        updateKeepAlive()
    }

    private fun sessionGone(sessionId: String) {
        liveSessions.remove(sessionId)
        updateKeepAlive()
    }

    /**
     * ≥1 live session → foreground service with a notification (keeps the
     * process unfrozen and the network usable while backgrounded); 0 → stop.
     */
    private fun updateKeepAlive() {
        val n = liveSessions.size
        try {
            if (n > 0) {
                requestNotificationPermission()
                PearForegroundService.start(
                    context,
                    if (n == 1) "1 SSH session active" else "$n SSH sessions active",
                )
            } else {
                PearForegroundService.stop(context)
            }
        } catch (_: Exception) {
            // Android 12+ forbids foreground-service starts from the deep
            // background — sessions still work whenever the app is scheduled.
        }
    }

    private fun requestNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < 33) return
        val granted = androidx.core.app.ActivityCompat.checkSelfPermission(
            context,
            android.Manifest.permission.POST_NOTIFICATIONS,
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (!granted) {
            activity?.let {
                androidx.core.app.ActivityCompat.requestPermissions(
                    it,
                    arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                    9007,
                )
            }
        }
    }

    override fun load() {
        // Android ships a stripped BouncyCastle as "BC"; sshj needs the real
        // one. Replace it app-wide before any crypto is touched.
        Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
        Security.insertProviderAt(BouncyCastleProvider(), 1)

        // One batcher for both streams; keys carry the stream tag so ordering
        // within a channel+stream is preserved and events demux on flush.
        batcher = ShellDataBatcher({ key, data ->
            val event = if (key.startsWith("e:")) "shellStderr" else "shellData"
            notifyListeners(
                event,
                JSObject().put("channelId", key.substring(2)).put("data", data),
            )
        })
        engine = SshEngine(
            FileKnownHostsStore(File(context.filesDir, "known_hosts")),
            object : EngineEvents {
                override fun shellData(channelId: String, data: String) {
                    batcher.add("d:$channelId", data)
                }

                override fun shellStderr(channelId: String, data: String) {
                    batcher.add("e:$channelId", data)
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
                    sessionGone(sessionId)
                    batcher.run {
                        notifyListeners("sessionClosed", JSObject().put("sessionId", sessionId))
                    }
                }

                override fun transferProgress(transferId: String, bytes: Long, total: Long) {
                    // Already throttled by the engine (100ms) — no batching.
                    notifyListeners(
                        "transferProgress",
                        JSObject()
                            .put("transferId", transferId)
                            .put("bytes", bytes)
                            .put("total", total),
                    )
                }
            },
        )
    }

    override fun handleOnDestroy() {
        relay?.stop()
        engine.disposeAll()
        batcher.shutdown()
        pool.shutdown()
        try {
            PearForegroundService.stop(context)
        } catch (_: Exception) {
            // context already torn down — the service dies with the process
        }
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

    private fun PluginCall.connectSpec(): ConnectSpec {
        val auth = getObject("auth") ?: JSObject()
        return ConnectSpec(
            host = getString("host") ?: throw SshError(SshError.CONNECT_FAILED, "host missing"),
            port = getInt("port") ?: 22,
            user = getString("user") ?: "root",
            auth = AuthSpec(
                method = auth.getString("method") ?: "key",
                password = auth.getString("password"),
                privateKey = auth.getString("privateKey"),
                passphrase = auth.getString("passphrase"),
            ),
            timeoutMs = getInt("timeoutMs") ?: 15_000,
            trustFingerprint = getString("trustFingerprint"),
        )
    }

    @PluginMethod
    fun connect(call: PluginCall) = async(call) {
        val sessionId = engine.connect(call.connectSpec())
        sessionOpened(sessionId)
        JSObject().put("sessionId", sessionId)
    }

    /** ProxyJump/`via`: same spec as connect, tunneled through jumpSessionId. */
    @PluginMethod
    fun connectVia(call: PluginCall) = async(call) {
        val jumpSessionId = call.getString("jumpSessionId")
            ?: throw SshError(SshError.NO_SESSION, "jumpSessionId missing")
        val sessionId = engine.connectVia(call.connectSpec(), jumpSessionId)
        sessionOpened(sessionId)
        JSObject().put("sessionId", sessionId)
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
            call.getBoolean("pty") ?: true,
        )
        JSObject().put("channelId", channelId)
    }

    @PluginMethod
    fun shellSignal(call: PluginCall) = async(call) {
        engine.shellSignal(call.channel(), call.getString("signal") ?: "TERM")
        JSObject()
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

    // ------------------------------------------------------ mcp relay/tunnel

    @PluginMethod
    fun mcpStart(call: PluginCall) = async(call) {
        val existing = relay
        if (existing != null) {
            JSObject().put("port", existing.port)
        } else {
            val started = McpRelay({ request, _ ->
                notifyListeners(
                    "mcpRequest",
                    JSObject()
                        .put("id", request.id)
                        .put("path", request.path)
                        .put("authorization", request.authorization ?: "")
                        .put("body", request.body),
                )
            })
            relay = started
            JSObject().put("port", started.start())
        }
    }

    @PluginMethod
    fun mcpRespond(call: PluginCall) = async(call) {
        relay?.respond(
            call.path("id"),
            RelayResponse(
                status = call.getInt("status") ?: 200,
                body = call.getString("body") ?: "",
            ),
        )
        JSObject()
    }

    @PluginMethod
    fun mcpStop(call: PluginCall) = async(call) {
        relay?.stop()
        relay = null
        JSObject()
    }

    @PluginMethod
    fun remoteForwardOpen(call: PluginCall) = async(call) {
        val port = engine.remoteForwardOpen(
            call.session(),
            call.getInt("targetPort") ?: 0,
            call.getInt("remotePort") ?: 0,
        )
        JSObject().put("remotePort", port)
    }

    @PluginMethod
    fun remoteForwardClose(call: PluginCall) = async(call) {
        engine.remoteForwardClose(call.session(), call.getInt("remotePort") ?: 0)
        JSObject()
    }

    // ------------------------------------------------------------- transfers

    @PluginMethod
    fun download(call: PluginCall) = async(call) {
        engine.download(
            call.session(),
            call.path("remotePath"),
            call.path("localPath"),
            call.getString("transferId"),
        )
        JSObject()
    }

    @PluginMethod
    fun upload(call: PluginCall) = async(call) {
        engine.upload(
            call.session(),
            call.path("localPath"),
            call.path("remotePath"),
            call.getString("transferId"),
        )
        JSObject()
    }

    @PluginMethod
    fun transferAbort(call: PluginCall) = async(call) {
        engine.transferAbort(call.path("transferId"))
        JSObject()
    }

    // ------------------------------------------- local fs (the phone as relay)

    @PluginMethod
    fun localList(call: PluginCall) = async(call) {
        val listing = app.pear.ssh.LocalFs.list(call.path())
        val entries = JSArray()
        for (entry in listing.entries) entries.put(entry.toJs())
        JSObject().put("path", listing.path).put("entries", entries)
    }

    @PluginMethod
    fun localStat(call: PluginCall) = async(call) {
        val entry = app.pear.ssh.LocalFs.stat(call.path())
        if (entry == null) JSObject().put("exists", false)
        else JSObject().put("exists", true).put("entry", entry.toJs())
    }

    @PluginMethod
    fun localMkdir(call: PluginCall) = async(call) {
        app.pear.ssh.LocalFs.mkdir(call.path())
        JSObject()
    }

    @PluginMethod
    fun localRemove(call: PluginCall) = async(call) {
        app.pear.ssh.LocalFs.remove(call.path(), call.getBoolean("recursive") ?: false)
        JSObject()
    }

    @PluginMethod
    fun localRename(call: PluginCall) = async(call) {
        app.pear.ssh.LocalFs.rename(call.path("oldPath"), call.path("newPath"))
        JSObject()
    }

    @PluginMethod
    fun localHash(call: PluginCall) = async(call) {
        JSObject().put("hash", app.pear.ssh.LocalFs.hash(call.path()))
    }

    @PluginMethod
    fun makeStagingDir(call: PluginCall) = async(call) {
        JSObject().put("path", app.pear.ssh.LocalFs.makeStagingDir(context.cacheDir.absolutePath))
    }

    // ------------------------------------------------------ device SAF bridges

    /**
     * Copy a finished download out of staging into the system Downloads
     * collection (MediaStore on API 29+, the public dir below), where every
     * file manager and share sheet can see it.
     */
    @PluginMethod
    fun saveToDownloads(call: PluginCall) = async(call) {
        val localPath = call.path("localPath")
        val name = call.getString("name") ?: File(localPath).name
        val source = File(localPath)
        if (!source.isFile) throw SshError(SshError.SFTP_FAILED, "no such staged file: $localPath")
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
                put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Download/Pear")
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(
                android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                values,
            ) ?: throw SshError(SshError.SFTP_FAILED, "could not create the download entry")
            resolver.openOutputStream(uri)?.use { output ->
                source.inputStream().use { it.copyTo(output) }
            } ?: throw SshError(SshError.SFTP_FAILED, "could not open the download for writing")
        } else {
            @Suppress("DEPRECATION")
            val downloads = android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOWNLOADS,
            )
            val dest = File(downloads, name)
            downloads.mkdirs()
            source.inputStream().use { input -> dest.outputStream().use { input.copyTo(it) } }
        }
        source.delete()
        JSObject().put("name", name)
    }

    /** SAF picker → copies each chosen document into a staging dir. */
    @PluginMethod
    fun pickFiles(call: PluginCall) {
        val intent = android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(android.content.Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        startActivityForResult(call, intent, "pickFilesResult")
    }

    @com.getcapacitor.annotation.ActivityCallback
    private fun pickFilesResult(call: PluginCall, result: androidx.activity.result.ActivityResult) {
        if (result.resultCode != android.app.Activity.RESULT_OK || result.data == null) {
            call.resolve(JSObject().put("files", JSArray()))
            return
        }
        val uris = mutableListOf<android.net.Uri>()
        result.data?.let { data ->
            data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
            if (uris.isEmpty()) data.data?.let { uris.add(it) }
        }
        pool.execute {
            try {
                val staging = File(app.pear.ssh.LocalFs.makeStagingDir(context.cacheDir.absolutePath))
                val files = JSArray()
                for (uri in uris) {
                    val name = displayNameOf(uri)
                    val dest = File(staging, name)
                    context.contentResolver.openInputStream(uri)?.use { input ->
                        dest.outputStream().use { input.copyTo(it) }
                    } ?: continue
                    files.put(
                        JSObject()
                            .put("path", dest.absolutePath)
                            .put("name", name)
                            .put("size", dest.length()),
                    )
                }
                call.resolve(JSObject().put("files", files).put("dir", staging.absolutePath))
            } catch (e: Exception) {
                call.reject(e.message ?: "pick failed")
            }
        }
    }

    private fun displayNameOf(uri: android.net.Uri): String {
        context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (index >= 0 && cursor.moveToFirst()) {
                val name = cursor.getString(index)
                if (!name.isNullOrBlank()) return name.replace('/', '_')
            }
        }
        return "file-${System.currentTimeMillis()}"
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
