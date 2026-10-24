package app.floatphone.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * 壳层的轻量通知。
 *
 * 只做一件事：后台心跳发现「有待办」时提醒用户回来看看。
 * 不放任何内容摘要——后台任务本来就不该知道聊天里说了什么。
 */
object ShellNotifier {

    private const val CHANNEL_ID = "shell_moments_pending"
    private const val NOTIF_ID = 9101

    fun notifyMomentsPending(context: Context, count: Int) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "动态互动",
                // LOW：不发声、不弹横幅。用户要的是「回来看看有人评论了」，
                // 不是被一条推送打断手上的事。
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "有角色回应了你的动态"
                setShowBadge(false)
            }
            manager.createNotificationChannel(channel)
        }

        // 点通知直接回到 App
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?.apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP }
        val pending = launch?.let {
            PendingIntent.getActivity(
                context,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0),
            )
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("动态有新互动")
            .setContentText(if (count > 1) "有 $count 条回应在等你" else "有 1 条回应在等你")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .apply { if (pending != null) setContentIntent(pending) }
            .build()

        runCatching { manager.notify(NOTIF_ID, notification) }
    }

    /** 清掉待办通知（用户回到 App 并补跑完之后调用）。 */
    fun clearMomentsPending(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return
        runCatching { manager.cancel(NOTIF_ID) }
    }
}
