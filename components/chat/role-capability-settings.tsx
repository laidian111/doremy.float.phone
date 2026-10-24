"use client";

/**
 * 聊天设置里的「角色能力」开关。
 *
 * 存在的理由：工具箱里的内置能力开关是全局的——一个开关管所有角色。
 * 但实际用起来必须能分开：「这个角色会分享小红书，那个角色别乱发」。
 *
 * 交互设计：
 *   - 每行显示「当前是否启用」，并标出这个值是「继承全局」还是「已单独设置」。
 *   - 点开关 = 写一条角色级覆盖；点「恢复跟随全局」= 删掉覆盖。
 *   - 不把继承状态藏起来：用户必须能一眼看出这个角色和全局是否一致，
 *     否则改了全局却发现某个角色没变，会以为是 bug。
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
    capabilityOwnerKey,
    countCapabilityOverrides,
    getCapabilityOverride,
    setCapabilityOverride,
} from "@/lib/capability-overrides";
import {
    GENERATE_FILE_CAPABILITY_ID,
    SHARE_CONTENT_CAPABILITY_ID,
    loadInternalCapabilities,
} from "@/lib/internal-capability-storage";
import type { ChatSession } from "@/lib/chat-storage";

/** 只展示「新增的、值得按角色区分」的能力。
 *  写入记忆这类核心能力不放在这里——那是全局基础设施，
 *  混进来会让这个列表变长且噪音大。 */
const ROLE_SCOPED_CAPABILITIES = [
    { id: SHARE_CONTENT_CAPABILITY_ID, label: "分享内容", hint: "让 TA 能主动分享小红书帖子或网页链接" },
    { id: GENERATE_FILE_CAPABILITY_ID, label: "生成文件", hint: "让 TA 能把文字整理成 docx/txt 文件发给你" },
];

export function RoleCapabilitySettings({ session }: { session: ChatSession }) {
    const [revision, setRevision] = useState(0);
    const bump = useCallback(() => setRevision(v => v + 1), []);

    const ownerKey = capabilityOwnerKey({
        isGroup: session.isGroup,
        sessionId: session.id,
        contactId: session.contactId,
        participantIds: session.participantIds,
    });

    // 依赖 revision 用于开关后重算
    const globals = (() => {
        void revision;
        const map = new Map<string, { enabled: boolean; mode: string }>();
        for (const cap of loadInternalCapabilities()) {
            map.set(cap.id, { enabled: cap.enabled, mode: cap.mode });
        }
        return map;
    })();

    const overrideCount = (() => { void revision; return countCapabilityOverrides(ownerKey); })();

    // 第一次渲染时读一次，避免 SSR 空值闪烁
    useEffect(() => { bump(); }, [bump]);

    return (
        <div className="menu-group">
            {ROLE_SCOPED_CAPABILITIES.map(({ id, label, hint }) => {
                const global = globals.get(id);
                if (!global) return null;
                const override = (() => { void revision; return getCapabilityOverride(ownerKey, id); })();
                // mode === "off" 是硬关闭（本机不可用），此时开关无意义，隐藏
                if (global.mode === "off") return null;
                const effective = typeof override === "boolean" ? override : global.enabled;
                const inherited = typeof override !== "boolean";

                return (
                    <div key={id} className="menu-item" style={{ cursor: "default" }}>
                        <div className="menu-label-group" style={{ flex: 1, minWidth: 0 }}>
                            <span className="menu-label">{label}</span>
                            <span className="menu-desc">
                                {hint}
                                {inherited ? "（跟随全局）" : "（已单独设置）"}
                            </span>
                        </div>
                        <div className="menu-right" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            {!inherited && (
                                <button
                                    className="menu-desc"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        setCapabilityOverride(ownerKey, id, undefined);
                                        bump();
                                    }}
                                    style={{ background: "none", border: "none", cursor: "pointer" }}
                                >
                                    恢复
                                </button>
                            )}
                            <button
                                role="switch"
                                aria-checked={effective}
                                aria-label={`${label}：${effective ? "开" : "关"}`}
                                onClick={(e) => {
                                    e.preventDefault();
                                    // 点一下就写死一个明确值（不再继承）。
                                    // 不做「三态循环」：循环切换用户很难预期下一次是什么。
                                    setCapabilityOverride(ownerKey, id, !effective);
                                    bump();
                                }}
                                style={{
                                    position: "relative",
                                    width: 42,
                                    height: 24,
                                    flex: "0 0 auto",
                                    borderRadius: 12,
                                    border: "none",
                                    cursor: "pointer",
                                    background: effective ? "var(--c-accent, #34c759)" : "var(--c-fill, #d8d9dd)",
                                    transition: "background 0.18s ease",
                                }}
                            >
                                <span
                                    style={{
                                        position: "absolute",
                                        top: 2,
                                        left: effective ? 20 : 2,
                                        width: 20,
                                        height: 20,
                                        borderRadius: "50%",
                                        background: "#fff",
                                        boxShadow: "0 1px 3px rgba(0,0,0,.2)",
                                        transition: "left 0.18s ease",
                                    }}
                                />
                            </button>
                        </div>
                    </div>
                );
            })}
            {overrideCount > 0 && (
                <button
                    className="menu-item"
                    onClick={(e) => {
                        e.preventDefault();
                        for (const { id } of ROLE_SCOPED_CAPABILITIES) {
                            setCapabilityOverride(ownerKey, id, undefined);
                        }
                        bump();
                    }}
                    style={{ justifyContent: "center" }}
                >
                    <span className="menu-desc">全部恢复跟随全局（{overrideCount} 项已自定义）</span>
                    <ChevronRight size={14} style={{ opacity: 0.4 }} />
                </button>
            )}
        </div>
    );
}
