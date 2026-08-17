package app.pear.ssh

import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import java.io.File
import java.security.MessageDigest
import java.security.PublicKey
import java.util.Base64

/** A trusted host key: OpenSSH-style fingerprint plus the key algorithm
 *  (`ssh-ed25519`, `ssh-rsa`, …). keyType is null for entries written by
 *  older builds that stored only the fingerprint. */
data class KnownHostEntry(val fingerprint: String, val keyType: String? = null)

/**
 * Persisted trust decisions, keyed by host:port. Fingerprints are OpenSSH
 * `SHA256:<base64-no-pad>` — what `ssh` prints, so users can cross-check
 * against a trusted terminal.
 */
interface KnownHostsStore {
    fun get(host: String, port: Int): KnownHostEntry?
    fun put(host: String, port: Int, fingerprint: String, keyType: String? = null)
    fun forget(host: String, port: Int)
}

/** One `host:port<TAB>fingerprint[<TAB>keyType]` line per entry; the third
 *  field is absent in files written by older builds. Rewrites atomically. */
class FileKnownHostsStore(private val file: File) : KnownHostsStore {
    private val lock = Any()

    private fun load(): MutableMap<String, KnownHostEntry> = synchronized(lock) {
        val map = LinkedHashMap<String, KnownHostEntry>()
        if (file.exists()) {
            for (line in file.readLines()) {
                val parts = line.split('\t')
                if (parts.size >= 2 && parts[0].isNotEmpty()) {
                    map[parts[0]] = KnownHostEntry(parts[1], parts.getOrNull(2)?.ifEmpty { null })
                }
            }
        }
        map
    }

    private fun save(map: Map<String, KnownHostEntry>) = synchronized(lock) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(
            map.entries.joinToString("") { (key, e) ->
                if (e.keyType != null) "$key\t${e.fingerprint}\t${e.keyType}\n"
                else "$key\t${e.fingerprint}\n"
            },
        )
        tmp.renameTo(file)
    }

    override fun get(host: String, port: Int): KnownHostEntry? = load()["$host:$port"]

    override fun put(host: String, port: Int, fingerprint: String, keyType: String?) {
        val map = load()
        map["$host:$port"] = KnownHostEntry(fingerprint, keyType)
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
                store.put(host, port, fingerprint, keyType)
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
        if (known.fingerprint == fingerprint) {
            // Self-heal entries from builds that didn't record the algorithm.
            if (known.keyType == null) store.put(host, port, fingerprint, keyType)
            return true
        }
        // Never auto-accept a changed key — the UI must forget explicitly.
        failure = SshError(
            SshError.HOST_KEY_CHANGED,
            "Host key for $host:$port changed — was ${known.fingerprint}, now $fingerprint",
            mapOf(
                "host" to host,
                "port" to port.toString(),
                "keyType" to keyType,
                "fingerprint" to fingerprint,
                "knownFingerprint" to known.fingerprint,
            ),
        )
        return false
    }

    /** Prefer the trusted key's algorithm during negotiation, so a server
     *  that serves several host keys presents the one we pinned instead of
     *  tripping a spurious HOST_KEY_CHANGED. sshj only reorders its proposal
     *  with this — verification above stays authoritative. */
    override fun findExistingAlgorithms(hostname: String, portArg: Int): List<String> =
        store.get(host, port)?.keyType?.let { listOf(it) } ?: emptyList()
}
