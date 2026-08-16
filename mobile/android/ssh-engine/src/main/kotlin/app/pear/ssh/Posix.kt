package app.pear.ssh

// Kotlin mirrors of core's pure helpers (ssh/mode.ts, shq.ts) so listings and
// remote commands behave byte-identically to desktop.

private const val S_IFMT = 0xF000
private const val S_IFDIR = 0x4000
private const val S_IFLNK = 0xA000

fun kindOf(mode: Int): String = when (mode and S_IFMT) {
    S_IFDIR -> "dir"
    S_IFLNK -> "link"
    else -> "file"
}

fun modeString(mode: Int): String {
    val kind = kindOf(mode)
    val sb = StringBuilder(if (kind == "dir") "d" else if (kind == "link") "l" else "-")
    for (shift in intArrayOf(6, 3, 0)) {
        val bits = (mode shr shift) and 0x7
        sb.append(if (bits and 4 != 0) 'r' else '-')
        sb.append(if (bits and 2 != 0) 'w' else '-')
        sb.append(if (bits and 1 != 0) 'x' else '-')
    }
    return sb.toString()
}

/** POSIX single-quote escaping for values interpolated into remote commands. */
fun shq(value: String): String = "'" + value.replace("'", "'\\''") + "'"
