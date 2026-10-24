package app.floatphone.shell

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 朋友圈/聊天互动的**系统级**后台调度。
 *
 * 为什么必须搬到原生（这是这个类存在的全部理由）：
 *   网页侧原本靠 Web Worker 心跳定时器（bg-timer.ts）轮询待办任务。
 *   Worker 能绕开**标签页节流**，但绕不开**进程冻结/回收**——
 *   Android 在内存吃紧或用户长时间切走时会把 WebView 整个冻住甚至杀掉。
 *   那一刻起，定时器不再走，积压的「角色该评论/该点赞/该发帖」任务
 *   就一直躺着。用户看到的现象就是「我发了动态，退出后台就没人回」。
 *
 *   这不是概率问题，是机制问题：只要调度器活在会被冻结的进程里，
 *   就一定会有任务不兑现。搬到 WorkManager 之后，调度由系统负责——
 *   App 被杀掉、手机重启，任务都还在队列里。
 *
 * 设计取舍：
 *   - 用 **PeriodicWork（15 分钟）** 而不是精确闹钟：朋友圈互动不是
 *     秒级需求，15 分钟的粒度足够；而精确闹钟在 Android 12+ 需要
 *     SCHEDULE_EXACT_ALARM 权限，为一个「谁给我点了个赞」去要这个权限
 *     不值得。
 *   - Worker **不做 LLM 调用**：生成评论要联网、要 API key、要提示词，
 *     这些逻辑全在网页侧，重复实现一份必然两边不一致。Worker 只负责
 *     「把网页叫醒」，真正的活由网页干。
 *   - 叫醒方式 = 拉起一个不可见的 WebView 执行一段 JS？不做。太重、
 *     太脏，而且会被当成后台偷跑。这里改用**通知 + 网页回前台补跑**
 *     的组合：Worker 检查到有待办就发一条静默通知，用户点开（或下次
 *     打开 App）时网页立刻补跑积压任务。
 *
 *   换句话说：WorkManager 解决的是「**保证用户下次打开时一定有东西**」，
 *   而不是「保证 App 没开也能立刻回评论」。后者需要常驻前台服务 +
 *   持续联网 + 消耗电量，与「个人本地小手机」的定位不符。
 */
object MomentsScheduler {

    private const val TAG = "MomentsScheduler"
    private const val WORK_NAME = "moments_heartbeat"

    /** 待办任务的落盘位置（网页写、Worker 读）。 */
    private const val PREFS = "moments_scheduler_prefs"
    private const val KEY_PENDING = "pending_json"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_LAST_TICK = "last_tick_at"

    /**
     * 注册周期任务。幂等——重复调用不会叠加。
     *
     * @param enabled 网页侧「后台互动」开关；关掉就撤销队列，
     *                不留一个偷偷跑的后台任务。
     */
    fun sync(context: Context, enabled: Boolean): Boolean = runCatching {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_ENABLED, enabled)
            .apply()

        val wm = WorkManager.getInstance(context)
        if (!enabled) {
            wm.cancelUniqueWork(WORK_NAME)
            return@runCatching true
        }

        val request = PeriodicWorkRequestBuilder<MomentsHeartbeatWorker>(15, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    // 待办要发通知、要拉模型，没网就别白跑一趟
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .build()

        wm.enqueueUniquePeriodicWork(
            WORK_NAME,
            // KEEP：已排队的不要因为网页又同步一次就重置计时，
            // 否则频繁开关设置页会让心跳永远推迟到 15 分钟后。
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
        true
    }.onFailure { Log.w(TAG, "sync failed", it) }.getOrDefault(false)

    /**
     * 网页推送待办清单。Worker 读它决定要不要提醒。
     *
     * 只存「有多少条、最早什么时候到期」这类元信息，**不存聊天内容**——
     * 后台任务不需要知道角色要说什么，它只需要知道「有事要做」。
     */
    fun setPending(context: Context, json: String): Boolean = runCatching {
        // 校验是合法 JSON 再落盘，避免网页给坏数据导致 Worker 每次都崩
        JSONObject(json)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_PENDING, json)
            .apply()
        true
    }.getOrDefault(false)

    /** 待办数量（0 = 没事可做）。 */
    fun pendingCount(context: Context): Int = runCatching {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_PENDING, "").orEmpty()
        // 注意用 return@runCatching：裸 return 会直接从 pendingCount 返回，
        // 跳过 runCatching 的异常兜底，坏数据一进来就抛给调用方
        if (raw.isBlank()) return@runCatching 0
        JSONObject(raw).optInt("count", 0)
    }.getOrDefault(0)

    /** 最早到期时间戳（毫秒）；0 = 没有。 */
    fun earliestDueAt(context: Context): Long = runCatching {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_PENDING, "").orEmpty()
        if (raw.isBlank()) return@runCatching 0L
        JSONObject(raw).optLong("earliestDueAt", 0L)
    }.getOrDefault(0L)

    fun lastTickAt(context: Context): Long = runCatching {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getLong(KEY_LAST_TICK, 0L)
    }.getOrDefault(0L)

    internal fun recordTick(context: Context) {
        runCatching {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong(KEY_LAST_TICK, System.currentTimeMillis())
                .apply()
        }
    }

    /** 状态快照，给设置页的诊断面板读。 */
    fun diagnosticsJson(context: Context): String = runCatching {
        JSONObject()
            .put("enabled", context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_ENABLED, false))
            .put("pendingCount", pendingCount(context))
            .put("earliestDueAt", earliestDueAt(context))
            .put("lastTickAt", lastTickAt(context))
            .toString()
    }.getOrDefault("{}")
}

/**
 * 15 分钟一次的心跳。
 *
 * 职责刻意压到最小：看看有没有到期待办，有就发一条静默通知。
 * 真正的生成逻辑在网页侧——这里调 LLM 会变成第二份实现，
 * 提示词、正则、预设全得同步维护，迟早不一致。
 */
class MomentsHeartbeatWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        MomentsScheduler.recordTick(applicationContext)
        val count = MomentsScheduler.pendingCount(applicationContext)
        val earliest = MomentsScheduler.earliestDueAt(applicationContext)
        if (count > 0 && earliest > 0 && earliest <= System.currentTimeMillis()) {
            // 有待办到期：发一条安静的通知，点开就把用户带回 App 补跑。
            // 不在这里生成内容——见类注释。
            runCatching { ShellNotifier.notifyMomentsPending(applicationContext, count) }
        }
        return Result.success()
    }
}
