package app.pear.mobile

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * SecretCipher for Android — the mobile counterpart of the desktop's
 * SafeStorageCipher (Electron safeStorage). The Android Keystore cannot
 * export key material, and sshj needs raw bytes, so secrets (passwords,
 * key passphrases, private keys) are AES-GCM-encrypted blobs at rest with
 * the wrapping key living in hardware-backed Keystore.
 *
 * Same contract as core's SecretCipher: encrypt → base64, decrypt → throws
 * if undecryptable (e.g. Keystore key invalidated), available() gates
 * whether secrets are persisted at all.
 */
class KeystoreCipher {
    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "app.pear.secrets.v1"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }

    fun available(): Boolean = try {
        key()
        true
    } catch (_: Exception) {
        false
    }

    /** plaintext → base64(iv ‖ ciphertext) */
    fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + sealed, Base64.NO_WRAP)
    }

    /** base64(iv ‖ ciphertext) → plaintext; throws if undecryptable. */
    fun decrypt(data: String): String {
        val raw = Base64.decode(data, Base64.NO_WRAP)
        require(raw.size > IV_BYTES) { "cipher blob too short" }
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES),
        )
        val plain = cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES)
        return String(plain, Charsets.UTF_8)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }
}
