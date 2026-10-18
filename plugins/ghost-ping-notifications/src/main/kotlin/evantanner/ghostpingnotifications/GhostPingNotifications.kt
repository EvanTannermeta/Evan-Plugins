@file:JvmName("GhostPingNotifications")

package evantanner.ghostpingnotifications

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import io.github.revenge.bridge.asDelegate
import io.github.revenge.plugins.plugin
import io.github.revenge.xposed.api.registerNativeMethod
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * Ghost Ping Notifications native side.
 *
 * Posts Android notifications through Discord's own app, so they use Discord's notification
 * permission. Every bridge method takes and returns strings only.
 */

private const val CHANNEL_ID = "ghost_pings"
private const val NOTIFICATION_PERMISSION = "android.permission.POST_NOTIFICATIONS"
private const val PERMISSION_REQUEST_CODE = 47110
private const val ANDROID_13 = 33

private var nextNotificationId = 4000

/** The latest Discord activity. Weak, so this plugin never keeps a closed screen alive. */
private var activityRef: WeakReference<Activity>? = null

private fun notificationManager(context: Context): NotificationManager =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

private fun newBuilder(context: Context): Notification.Builder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, CHANNEL_ID)
    } else {
        Notification.Builder(context)
    }

/** Shows a notification. Returns "shown", or "error: ...". */
private fun showNotification(
    context: Context,
    title: String,
    body: String,
    hideOnLockScreen: Boolean,
): String {
    return try {
        val manager = notificationManager(context)
        if (!manager.areNotificationsEnabled()) {
            return "error: notifications are turned off for Discord in Android settings"
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Ghost pings",
                NotificationManager.IMPORTANCE_HIGH,
            )
            channel.description = "Someone pinged you and then deleted the message"
            manager.createNotificationChannel(channel)
        }

        val builder = newBuilder(context)

        builder
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true)

        if (hideOnLockScreen) {
            // On a locked screen Android shows this generic version instead of the real text.
            val hidden = newBuilder(context)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("Ghost ping")
                .setContentText("Unlock your phone to see the details")
                .build()
            builder
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(hidden)
        }

        // Tapping the notification opens Discord.
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch != null) {
            builder.setContentIntent(
                PendingIntent.getActivity(
                    context,
                    0,
                    launch,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
        }

        nextNotificationId += 1
        manager.notify(nextNotificationId, builder.build())
        "shown"
    } catch (e: Exception) {
        "error: ${e.message}"
    }
}

/** JSON: whether notifications are allowed, and the Android version. */
private fun status(context: Context): String =
    JSONObject()
        .put("enabled", notificationManager(context).areNotificationsEnabled())
        .put("sdk", Build.VERSION.SDK_INT)
        .toString()

/** Asks for the notification permission on Android 13 and newer. */
private fun requestPermission(activity: Activity): String {
    if (Build.VERSION.SDK_INT < ANDROID_13) return "granted"

    if (activity.checkSelfPermission(NOTIFICATION_PERMISSION) == PackageManager.PERMISSION_GRANTED) {
        return "granted"
    }

    activity.runOnUiThread {
        activity.requestPermissions(arrayOf(NOTIFICATION_PERMISSION), PERMISSION_REQUEST_CODE)
    }
    return "requested"
}

@Suppress("UNUSED")
val ghostPingNotifications = plugin {
    start {
        log.i("Loaded ${manifest.name} (${manifest.id})")

        val id = manifest.id

        withAppActivity { activity ->
            activityRef = WeakReference(activity)
            val context = activity.applicationContext

            registerNativeMethod("$id.notify") { rawArgs ->
                val args = rawArgs.asDelegate()
                val title: String by args.string()
                val body: String by args.string()
                val hideOnLockScreen: String by args.string()

                showNotification(context, title, body, hideOnLockScreen == "1")
            }

            registerNativeMethod("$id.status") { _ -> status(context) }

            registerNativeMethod("$id.requestPermission") { _ ->
                val current = activityRef?.get()
                if (current != null) requestPermission(current) else "error: Discord is not open"
            }
        }
    }

    stop {
        log.i("Unloaded ${manifest.id}")
    }
}
