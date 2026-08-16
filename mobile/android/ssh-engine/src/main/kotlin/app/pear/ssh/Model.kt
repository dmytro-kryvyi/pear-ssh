package app.pear.ssh

/**
 * Typed engine failure. `code` crosses the Capacitor bridge as the reject
 * code so the TS side can branch (host-key prompts, auth retry) without
 * string-matching messages.
 */
class SshError(
    val code: String,
    message: String,
    val details: Map<String, String> = emptyMap(),
    cause: Throwable? = null,
) : Exception(message, cause) {
    companion object {
        const val UNKNOWN_HOST_KEY = "UNKNOWN_HOST_KEY"
        const val HOST_KEY_CHANGED = "HOST_KEY_CHANGED"
        const val AUTH_FAILED = "AUTH_FAILED"
        const val CONNECT_FAILED = "CONNECT_FAILED"
        const val UNSUPPORTED_AUTH = "UNSUPPORTED_AUTH"
        const val NO_SESSION = "NO_SESSION"
        const val NO_CHANNEL = "NO_CHANNEL"
        const val FILE_TOO_LARGE = "FILE_TOO_LARGE"
        const val SFTP_FAILED = "SFTP_FAILED"
        const val EXEC_FAILED = "EXEC_FAILED"
    }
}

/**
 * Auth for one connect attempt. Mirrors core's HostAuth after the TS layer
 * resolves it: keys arrive as text (Android has no ~/.ssh), passwords as
 * plaintext decrypted from the Keystore-wrapped store just-in-time.
 * `agent` has no Android equivalent until the M5 credential-proxy work.
 */
data class AuthSpec(
    /** "password" | "key" */
    val method: String,
    val password: String? = null,
    /** Private key text — OpenSSH/PEM/PuTTY formats, per sshj. */
    val privateKey: String? = null,
    val passphrase: String? = null,
)

/**
 * One connect attempt to one endpoint. Endpoint failover stays in core's
 * SessionManager.dialEndpoints (TS) — same sequential contract as desktop —
 * so the engine never sees more than a single host:port.
 */
data class ConnectSpec(
    val host: String,
    val port: Int,
    val user: String,
    val auth: AuthSpec,
    val timeoutMs: Int = 15_000,
    /**
     * TOFU acceptance: when the server key is unknown and its fingerprint
     * equals this value, trust and persist it. Set by the UI after the user
     * confirms the UNKNOWN_HOST_KEY prompt; never bypasses a mismatch.
     */
    val trustFingerprint: String? = null,
)

/** Mirrors core ExecResult (ssh/transport.ts). */
data class ExecResult(val code: Int, val stdout: String, val stderr: String)

/** Mirrors core FileEntry (types.ts): kind ∈ file|dir|link, mtime in ms. */
data class RemoteEntry(
    val name: String,
    val kind: String,
    val size: Long,
    val mtimeMs: Long,
    val mode: String,
)

/** Mirrors core DirListing: `path` is the server-resolved absolute path. */
data class DirListingData(val path: String, val entries: List<RemoteEntry>)

/** Engine → embedder events; the plugin batches these across the bridge. */
interface EngineEvents {
    fun shellData(channelId: String, data: String)
    fun shellExit(channelId: String, code: Int)
    fun sessionClosed(sessionId: String)
}
