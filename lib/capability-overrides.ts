"use client";

/**
 * 能力开关的「全局默认 + 角色覆盖」两层配置。
 *
 * 为什么需要这一层：项目原本的 InternalCapabilityConfig 是纯全局的——
 * 一个开关管所有角色。但实际用起来必须能分开：「这个角色会分享小红书，
 * 那个角色不要」。而且新加的能力越来越多，全挤在一个全局列表里没法用。
 *
 * 设计取舍——为什么不是「每个角色独立一份完整配置」：
 *   - 那样每加一个角色就要把现有能力全配一遍，繁琐且容易漏。
 *   - 两层配置下，用户只在想区别对待时才写覆盖，其余继承全局默认。
 *
 * 覆盖的语义是**完全覆盖**（不是合并）：
 *   角色里写 true 就是 true，写 false 就是 false，没写才看全局。
 *   合并语义会导致「全局关了、角色想开」这种最基本的需求做不到。
 */

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const OVERRIDE_KEY = "ai_phone_capability_role_overrides_v1";
registerKvMigration(OVERRIDE_KEY);

/** 各角色的覆盖表：characterKey -> capabilityId -> enabled。 */
type OverrideMap = Record<string, Record<string, boolean>>;

/**
 * 覆盖用的角色键。
 *
 * 为什么不用 sessionId：同一个角色的会话可能被重建（换分支、清历史），
 * sessionId 会变；而开关是「这个角色」的属性，不该跟着会话一起丢。
 * 群聊用 group:<sessionId>，因为群本身就是一个长期的实体。
 */
export function capabilityOwnerKey(params: {
    isGroup?: boolean;
    sessionId: string;
    contactId?: string;
    participantIds?: string[];
}): string {
    if (params.isGroup) {
        // 群聊的「角色」其实就是这个群，用群内成员排序后拼成稳定标识——
        // 只按 sessionId 的话，重建会话就丢配置；只按成员的话，
        // 同两个人开两个群会串。两者结合最稳。
        const members = [...(params.participantIds || [])].sort().join(",");
        return `group:${members || params.sessionId}`;
    }
    return `char:${params.contactId || params.sessionId}`;
}

function loadOverrides(): OverrideMap {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(OVERRIDE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return {};
        const result: OverrideMap = {};
        for (const [ownerKey, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== "object") continue;
            const caps: Record<string, boolean> = {};
            for (const [capId, enabled] of Object.entries(value as Record<string, unknown>)) {
                if (typeof enabled === "boolean") caps[capId] = enabled;
            }
            if (Object.keys(caps).length > 0) result[ownerKey] = caps;
        }
        return result;
    } catch {
        return {};
    }
}

function saveOverrides(map: OverrideMap): void {
    if (typeof window === "undefined") return;
    try { kvSet(OVERRIDE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

/**
 * 算出某个能力对某个角色是否启用。
 *
 * 优先级：角色覆盖 > 全局 enabled。
 * 注意 mode === "off" 是硬关闭，任何覆盖都不能开——它是「这个能力在本机
 * 完全不可用」（比如没配置 API），不是用户偏好。
 */
export function resolveCapabilityEnabled(params: {
    capabilityId: string;
    globalEnabled: boolean;
    globalMode: string;
    ownerKey?: string | null;
}): boolean {
    if (params.globalMode === "off") return false;
    if (!params.ownerKey) return params.globalEnabled;
    const override = loadOverrides()[params.ownerKey]?.[params.capabilityId];
    if (typeof override === "boolean") return override;
    return params.globalEnabled;
}

/** 该角色是否显式设置过这个能力（用于 UI 区分「继承」和「已改」）。 */
export function getCapabilityOverride(ownerKey: string, capabilityId: string): boolean | undefined {
    return loadOverrides()[ownerKey]?.[capabilityId];
}

/** 写角色级覆盖。传 undefined 表示清除覆盖、回到继承全局。 */
export function setCapabilityOverride(
    ownerKey: string,
    capabilityId: string,
    enabled: boolean | undefined,
): void {
    const map = loadOverrides();
    if (enabled === undefined) {
        const caps = map[ownerKey];
        if (!caps) return;
        delete caps[capabilityId];
        // 清空后连这个角色一起删，别留空对象
        if (Object.keys(caps).length === 0) delete map[ownerKey];
    } else {
        map[ownerKey] = { ...(map[ownerKey] || {}), [capabilityId]: enabled };
    }
    saveOverrides(map);
}

/** 该角色已覆盖的能力数量（UI 上提示「已自定义 N 项」）。 */
export function countCapabilityOverrides(ownerKey: string): number {
    return Object.keys(loadOverrides()[ownerKey] || {}).length;
}
