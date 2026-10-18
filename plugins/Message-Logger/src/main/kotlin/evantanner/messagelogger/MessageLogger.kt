@file:JvmName("MessageLogger")

package evantanner.messagelogger

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import io.github.revenge.bridge.asDelegate
import io.github.revenge.plugins.plugin
import io.github.revenge.xposed.api.registerNativeMethod
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * Message Logger native side.
 *
 * Saves copies of attachments to the plugin's storage so they still open after Discord's
 * links expire, and writes exports to the Downloads folder.
 *
 * Layout under `<pluginDir>/attachments`:
 *   pending/<messageId>/<n>-<name>   copies of attachments as messages arrive (opt-in, purged)
 *   kept/<messageId>/<n>-<name>      copies of deleted messages' attachments (kept until cleared)
 *
 * Every bridge method takes and returns strings only.
 */

private const val MAX_FILE_BYTES = 25L * 1024 * 1024
private const val MAX_FILES_PER_MESSAGE = 10
private const val MAX_REDIRECTS = 5

/** Most bytes of kept files to hold on to. 0 means no limit. Set from JavaScript. */
@Volatile private var keptLimitBytes = 0L

private val ID_PATTERN = Regex("^[0-9]{1,30}$")

/** One worker, so downloads queue up instead of competing for the connection. */
private var executor: ExecutorService = Executors.newSingleThreadExecutor()

private fun safeName(name: String): String =
    name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80).ifEmpty { "file" }

/** Only Discord's own https hosts, so other plugins can't use this to fetch arbitrary URLs. */
private fun isAllowedUrl(raw: String): Boolean =
    try {
        val url = URL(raw)
        val host = url.host.lowercase()
        url.protocol == "https" &&
            (host == "discordapp.com" || host.endsWith(".discordapp.com") ||
                host == "discordapp.net" || host.endsWith(".discordapp.net") ||
                host == "discord.com" || host.endsWith(".discord.com"))
    } catch (e: Exception) {
        false
    }

/**
 * Opens the URL and follows redirects by hand, so every hop is checked against the
 * allow-list. (Automatic redirects would let an allowed host send us anywhere.)
 */
private fun openChecked(startUrl: String): HttpURLConnection? {
    var current = startUrl
    var hops = 0
    while (hops <= MAX_REDIRECTS) {
        if (!isAllowedUrl(current)) return null

        val connection = (URL(current).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = false
            requestMethod = "GET"
        }

        val code = connection.responseCode
        if (code !in 300..399) return connection

        val location = connection.getHeaderField("Location")
        connection.disconnect()
        if (location.isNullOrEmpty()) return null

        current = URL(URL(current), location).toString()
        hops++
    }
    return null
}

private fun download(url: String, dest: File, maxBytes: Long): Boolean {
    var connection: HttpURLConnection? = null
    return try {
        connection = openChecked(url) ?: return false

        if (connection.responseCode !in 200..299) return false
        if (connection.contentLengthLong > maxBytes) return false

        dest.parentFile?.mkdirs()
        val partial = File(dest.parentFile, dest.name + ".part")

        connection.inputStream.use { input ->
            partial.outputStream().use { output ->
                val buffer = ByteArray(8192)
                var total = 0L
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > maxBytes) {
                        partial.delete()
                        return false
                    }
                    output.write(buffer, 0, read)
                }
            }
        }

        partial.renameTo(dest)
    } catch (e: Exception) {
        false
    } finally {
        connection?.disconnect()
    }
}

private fun saveFiles(dir: File, files: JSONArray) {
    val count = minOf(files.length(), MAX_FILES_PER_MESSAGE)
    for (i in 0 until count) {
        val item = files.optJSONObject(i) ?: continue
        val dest = File(dir, "$i-${safeName(item.optString("name", "file"))}")
        if (dest.exists()) continue

        val urls = listOf(item.optString("url"), item.optString("fallback"))
            .filter { it.isNotEmpty() && isAllowedUrl(it) }

        for (url in urls) {
            if (download(url, dest, MAX_FILE_BYTES)) break
        }
    }
}

private fun dirSize(dir: File): Long =
    dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

/** Removes the oldest kept messages' files until everything fits in `maxBytes`. 0 means no limit. */
private fun trimKept(root: File, maxBytes: Long) {
    if (maxBytes <= 0) return

    val dirs = File(root, "kept").listFiles()
        ?.filter { it.isDirectory }
        ?.sortedBy { it.lastModified() }
        ?: return

    var total = dirs.sumOf { dirSize(it) }
    for (dir in dirs) {
        if (total <= maxBytes) break
        total -= dirSize(dir)
        dir.deleteRecursively()
    }
}

/** Removes half-finished downloads left behind by an interrupted run. */
private fun cleanPartials(root: File) {
    val cutoff = System.currentTimeMillis() - 60 * 60 * 1000
    root.walkTopDown()
        .filter { it.isFile && it.name.endsWith(".part") && it.lastModified() < cutoff }
        .forEach { it.delete() }
}

private fun handleSave(root: File, messageId: String, filesJson: String, bucket: String): String {
    if (!ID_PATTERN.matches(messageId)) return "error: bad message id"
    if (bucket != "kept" && bucket != "pending") return "error: bad bucket"

    val files = try {
        JSONArray(filesJson)
    } catch (e: Exception) {
        return "error: bad files"
    }

    val dir = File(File(root, bucket), messageId)
    try {
        executor.execute {
            try {
                saveFiles(dir, files)
                if (bucket == "kept") trimKept(root, keptLimitBytes)
            } catch (e: Exception) {
                // Best effort: a failed download just means no local copy.
            }
        }
    } catch (e: Exception) {
        return "error: ${e.message}"
    }

    return "queued"
}

/** Moves a message's pre-saved copies from `pending` to `kept`. */
private fun handleKeep(root: File, messageId: String): String {
    if (!ID_PATTERN.matches(messageId)) return "error: bad message id"

    val pending = File(File(root, "pending"), messageId)
    val kept = File(File(root, "kept"), messageId)
    if (!pending.isDirectory) return "missing"

    kept.parentFile?.mkdirs()
    if (!pending.renameTo(kept)) return "missing"

    try {
        executor.execute { trimKept(root, keptLimitBytes) }
    } catch (e: Exception) {
        // The next download or limit change trims instead.
    }
    return "kept"
}

/** JSON object of message id -> absolute paths of its kept copies. */
private fun handleListKept(root: File): String {
    val out = JSONObject()
    File(root, "kept").listFiles()?.forEach { dir ->
        if (dir.isDirectory) {
            val paths = JSONArray()
            dir.listFiles()
                ?.filter { it.isFile && !it.name.endsWith(".part") }
                ?.forEach { paths.put(it.absolutePath) }
            out.put(dir.name, paths)
        }
    }
    return out.toString()
}

private fun handleStats(root: File): String =
    JSONObject()
        .put("kept", dirSize(File(root, "kept")))
        .put("pending", dirSize(File(root, "pending")))
        .toString()

private fun handleDeleteKept(root: File, messageId: String): String {
    if (!ID_PATTERN.matches(messageId)) return "error: bad message id"
    File(File(root, "kept"), messageId).deleteRecursively()
    return "ok"
}

private fun handleDeleteAllKept(root: File): String {
    File(root, "kept").deleteRecursively()
    return "ok"
}

/** Removes pre-saved copies older than the given number of hours. */
private fun handlePurgePending(root: File, hoursRaw: String): String {
    val hours = hoursRaw.toLongOrNull() ?: return "error: bad hours"
    if (hours < 0) return "error: bad hours"
    val cutoff = System.currentTimeMillis() - hours * 60 * 60 * 1000

    var removed = 0
    File(root, "pending").listFiles()?.forEach { dir ->
        if (dir.lastModified() < cutoff && dir.deleteRecursively()) removed++
    }
    return removed.toString()
}

/** Writes a text file to Downloads/Message Logger. Returns where it went, or "error: ...". */
private fun exportToDownloads(context: Context, name: String, mime: String, content: String): String {
    return try {
        val fileName = safeName(name)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(
                    MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/Message Logger",
                )
            }

            val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return "error: could not create the file"

            val stream = context.contentResolver.openOutputStream(uri)
                ?: return "error: could not open the file"
            stream.use { it.write(content.toByteArray()) }
        } else {
            val dir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                "Message Logger",
            )
            dir.mkdirs()
            File(dir, fileName).writeText(content)
        }

        "Downloads/Message Logger/$fileName"
    } catch (e: Exception) {
        "error: ${e.message}"
    }
}

@Suppress("UNUSED")
val messageLogger = plugin {
    start {
        log.i("Loaded ${manifest.name} (${manifest.id})")

        if (executor.isShutdown) executor = Executors.newSingleThreadExecutor()

        val id = manifest.id
        val root = File(pluginDir, "attachments")

        try {
            executor.execute { cleanPartials(root) }
        } catch (e: Exception) {
            // Cleaning up is optional.
        }

        registerNativeMethod("$id.save") { rawArgs ->
            val args = rawArgs.asDelegate()
            val messageId: String by args.string()
            val filesJson: String by args.string()
            val bucket: String by args.string()

            handleSave(root, messageId, filesJson, bucket)
        }

        registerNativeMethod("$id.keep") { rawArgs ->
            val args = rawArgs.asDelegate()
            val messageId: String by args.string()

            handleKeep(root, messageId)
        }

        registerNativeMethod("$id.listKept") { _ -> handleListKept(root) }

        registerNativeMethod("$id.stats") { _ -> handleStats(root) }

        registerNativeMethod("$id.deleteKept") { rawArgs ->
            val args = rawArgs.asDelegate()
            val messageId: String by args.string()

            handleDeleteKept(root, messageId)
        }

        registerNativeMethod("$id.deleteAllKept") { _ -> handleDeleteAllKept(root) }

        registerNativeMethod("$id.purgePending") { rawArgs ->
            val args = rawArgs.asDelegate()
            val hours: String by args.string()

            handlePurgePending(root, hours)
        }

        registerNativeMethod("$id.setKeptLimit") { rawArgs ->
            val args = rawArgs.asDelegate()
            val bytes: String by args.string()

            keptLimitBytes = bytes.toLongOrNull()?.coerceAtLeast(0L) ?: 0L
            try {
                executor.execute { trimKept(root, keptLimitBytes) }
            } catch (e: Exception) {
                // The next download trims instead.
            }
            "ok"
        }

        withAppActivity { activity ->
            registerNativeMethod("$id.exportToDownloads") { rawArgs ->
                val args = rawArgs.asDelegate()
                val fileName: String by args.string()
                val mime: String by args.string()
                val content: String by args.string()

                exportToDownloads(activity.applicationContext, fileName, mime, content)
            }
        }
    }

    stop {
        log.i("Unloaded ${manifest.id}")
        executor.shutdownNow()
    }
}
