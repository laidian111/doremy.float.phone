// lib/moments-background-sync.ts
//
// 把朋友圈互动的调度交给 Android 原生（WorkManager）。
//
// 为什么需要这层（这是整个文件的存在理由）：
//   网页侧的待办轮询靠 Web Worker 心跳（bg-timer.ts）。Worker 能绕开
//   **标签页节流**，但绕不开 **进程冻结/回收**——Android 内存吃紧或用户
//   长时间切走时，整个 WebView 会被冻住甚至杀掉，定时器随之停摆。
//   那一刻起，积压的「角色该评论/该点赞」任务就一直躺着，用户看到的
//   现象就是「我发了动态，退出后台就没人回」。
//
//   这不是概率问题，是机制问题：只要调度器活在会被冻结的进程里，
//   就一定会有任务不兑现。所以把「什么时候该看一眼」交给系统，
//   网页只负责「被叫醒后干活」。
//
// 分工：
//   · 原生 Worker（每 15 分钟）：检查有没有到期待办 → 发一条安静通知
//   · 网页（回到前台时）：立刻补跑积压任务 + 清掉通知
//
// 刻意**不让 Worker 调 LLM**：生成评论要 API key、提示词、正则、预设，
// 这些全在网页侧。原生重写一份必然两边不一致，改一边忘一边。
// Worker 只当闹钟，不当大脑。

type MomentsSchedulerBridge = {
    setMomentsBackgroundEnabled?: (enabled: boolean) => boolean;
    setMomentsPending?: (json: string) => boolean;
    getMomentsSchedulerState?: () => string;
    clearMomentsPendingNotice?: () => void;
};

function getBridge(): MomentsSchedulerBridge | null {
    if (typeof window === "undefined") return null;
    const candidate = (window as unknown as { AndroidShell?: MomentsSchedulerBridge }).AndroidShell;
    if (!candidate) return null;
    // 旧版 APK 没有这些方法：特性检测而不是版本号比较，
    // 免得每加一个桥方法都要改一次版本判断
    return typeof candidate.setMomentsBackgroundEnabled === "function" ? candidate : null;
}

/** 当前环境是否支持原生后台调度（壳内 + 新版本 APK）。 */
export function isNativeMomentsSchedulerAvailable(): boolean {
    return getBridge() !== null;
}

/**
 * 开关原生后台心跳。
 *
 * @returns 是否成功下发。网页侧没壳时返回 false，调用方据此退回
 *          纯网页定时器（能跑，只是进后台就不保证）。
 */
export function syncMomentsBackground(enabled: boolean): boolean {
    const bridge = getBridge();
    if (!bridge?.setMomentsBackgroundEnabled) return false;
    try {
        return bridge.setMomentsBackgroundEnabled(enabled);
    } catch {
        return false;
    }
}

/**
 * 把待办摘要推给原生。
 *
 * 只传**元信息**（条数、最早到期时间），不传聊天内容——
 * 后台闹钟不需要知道角色要说什么，少传一份就少一份泄露面。
 *
 * @param dueAts 所有待办的到期时间戳（毫秒）
 */
export function publishMomentsPending(dueAts: number[]): boolean {
    const bridge = getBridge();
    if (!bridge?.setMomentsPending) return false;
    const valid = dueAts.filter(t => Number.isFinite(t) && t > 0);
    const payload = JSON.stringify({
        count: valid.length,
        earliestDueAt: valid.length > 0 ? Math.min(...valid) : 0,
    });
    try {
        return bridge.setMomentsPending(payload);
    } catch {
        return false;
    }
}

/** 清掉「有互动在等你」的通知（回到前台补跑完之后调）。 */
export function clearMomentsPendingNotice(): void {
    const bridge = getBridge();
    if (!bridge?.clearMomentsPendingNotice) return;
    try {
        bridge.clearMomentsPendingNotice();
    } catch {
        // 清通知失败不影响功能
    }
}

/** 原生调度器状态（诊断用）。没壳或旧版本返回 null。 */
export function readMomentsSchedulerState(): {
    enabled: boolean;
    pendingCount: number;
    earliestDueAt: number;
    lastTickAt: number;
} | null {
    const bridge = getBridge();
    if (!bridge?.getMomentsSchedulerState) return null;
    try {
        const raw = bridge.getMomentsSchedulerState();
        if (!raw) return null;
        return JSON.parse(raw) as {
            enabled: boolean;
            pendingCount: number;
            earliestDueAt: number;
            lastTickAt: number;
        };
    } catch {
        return null;
    }
}
