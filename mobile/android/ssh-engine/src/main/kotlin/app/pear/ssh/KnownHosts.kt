package app.pear.ssh

import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import java.io.File
import java.security.MessageDigest
import java.security.PublicKey
import java.util.Base64

/**
 * Persisted trust decisions, keyed by host:port. Values are OpenSSH-style
 * `SHA256:<base64-no-pad>` fingerprints — what `ssh` prints, so users can
 * cross-check against a trusted terminal.
 */
interface KnownHostsStore {
    fun get(host: String, port: Int): String?
    fun put(host: String, port: Int, fingerprint: String)
    fun forget(host: String, port: Int)
}

/** One `host:port<TAB>fingerprint` line per entry; rewrites atomically. */
class FileKnownHostsStore(private val file: File) : KnownHostsStore {
    private val lock = Any()

    private fun load(): MutableMap<String, String> = synchronized(lock) {
        val map = LinkedHashMap<String, String>()
        if (file.exists()) {
            for (line in file.readLines()) {
                val cut = line.indexOf('\t')
                if (cut > 0) map[line.substring(0, cut)] = line.substring(cut + 1)
            }
        }
        map
    }

    private fun save(map: Map<String, String>) = synchronized(lock) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(map.entries.joinToString("") { "${it.key}\t${it.value}\n" })
        tmp.renameTo(file)
    }

    override fun get(host: String, port: Int): String? = load()["$host:$port"]

    override fun put(host: String, port: Int, fingerprint: String) {
        val map = load()
        map["$host:$port"] = fingerprint
        save(map)
    }

    override fun forget(host: String, port: Int) {
        val map = load()
        if (map.remove("$host:$port") != null) save(map)
    }
}

/** OpenSSH SHA256 fingerprint of a public key (wire-format encoded). */
fun sshFingerprint(key: PublicKey): String {
    val wire = Buffer.PlainBuffer().putPublicKey(key).compactData
    val digest = MessageDigest.getInstance("SHA-256").digest(wire)
    return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)
}

/**
 * Trust-on-first-use verifier for one connect attempt. sshj only lets a
 * verifier answer yes/no, so on refusal the typed reason is parked in
 * `failure` and re-thrown by SshEngine.connect with full details for the UI
 * prompt.
 */
class TofuVerifier(
    private val store: KnownHostsStore,
    private val host: String,
    private val port: Int,
    private val trustFingerprint: String?,
) : HostKeyVerifier {
    var failure: SshError? = null

    override fun verify(hostname: String, portArg: Int, key: PublicKey): Boolean {
        val fingerprint = sshFingerprint(key)
        val keyType = KeyType.fromKey(key).toString()
        val known = store.get(host, port)
        if (known == null) {
            if (trustFingerprint == fingerprint) {
                store.put(host, port, fingerprint)
                return true
            }
            failure = SshError(
                SshError.UNKNOWN_HOST_KEY,
                "Unknown host key for $host:$port ($keyType $fingerprint)",
                mapOf(
                    "host" to host,
                    "port" to port.toString(),
                    "keyType" to keyType,
                    "fingerprint" to fingerprint,
                ),
            )
            return false
        }
        if (known == fingerprint) return true
        // Never auto-accept a changed key — the UI must forget explicitly.
        failure = SshError(
            SshError.HOST_KEY_CHANGED,
            "Host key for $host:$port changed — was $known, now $fingerprint",
            mapOf(
                "host" to host,
                "port" to port.toString(),
                "keyType" to keyType,
                "fingerprint" to fingerprint,
                "knownFingerprint" to known,
            ),
        )
        return false
    }

    override fun findExistingAlgorithms(hostname: String, portArg: Int): List<String> = emptyList()
}
