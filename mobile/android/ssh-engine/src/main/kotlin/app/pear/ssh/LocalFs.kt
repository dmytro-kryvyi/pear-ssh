package app.pear.ssh

import java.io.File
import java.security.MessageDigest

/**
 * The phone's own filesystem as the transfer relay. Cross-host transfers
 * stream through a staging dir here (download stage → upload stage, mirroring
 * the desktop's local relay), and SAF pick/save flows stage through it too.
 * Pure JVM so the JVM test suite covers it; the plugin points it at the app's
 * cache dir.
 */
object LocalFs {
    private fun entryOf(file: File): RemoteEntry {
        // Fabricate a POSIX mask (the relay only needs kind + a plausible
        // listing shape; Android's File API has no real mode bits).
        val mask = if (file.isDirectory) 0x4000 or 0x1ED else 0x8000 or 0x1A4
        return RemoteEntry(
            name = file.name,
            kind = kindOf(mask),
            size = file.length(),
            mtimeMs = file.lastModified(),
            mode = modeString(mask),
        )
    }

    fun list(path: String): DirListingData {
        val dir = File(path)
        val children = dir.listFiles()
            ?: throw SshError(SshError.SFTP_FAILED, "cannot list $path")
        return DirListingData(dir.absolutePath, children.map { entryOf(it) })
    }

    fun stat(path: String): RemoteEntry? {
        val file = File(path)
        return if (file.exists()) entryOf(file) else null
    }

    fun mkdir(path: String) {
        if (!File(path).mkdirs() && !File(path).isDirectory) {
            throw SshError(SshError.SFTP_FAILED, "cannot create $path")
        }
    }

    fun remove(path: String, recursive: Boolean) {
        val file = File(path)
        if (!file.exists()) return
        val ok = if (recursive) file.deleteRecursively() else file.delete()
        if (!ok) throw SshError(SshError.SFTP_FAILED, "cannot delete $path")
    }

    fun rename(oldPath: String, newPath: String) {
        if (!File(oldPath).renameTo(File(newPath))) {
            throw SshError(SshError.SFTP_FAILED, "cannot move $oldPath")
        }
    }

    /** SHA-256 hex digest — post-transfer verification against the remote side. */
    fun hash(path: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        File(path).inputStream().use { input ->
            val buf = ByteArray(256 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** Fresh unique staging dir under the given root (the app cache dir). */
    fun makeStagingDir(root: String): String {
        val dir = File(root, "pear-staging/${System.nanoTime()}")
        if (!dir.mkdirs()) throw SshError(SshError.SFTP_FAILED, "cannot create staging dir")
        return dir.absolutePath
    }
}
