"use client";

/**
 * 「一起养」的设置面板。
 *
 * 按用户的要求：**每个功能都有开关或自定义**。
 * 这里把能想到的都放出来——衰减速度、角色能否主动提到/照顾、
 * 每个动作的反馈语、物种显示名。默认值都是「开」，但用户随时能关。
 */

import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import {
    COMPANION_ACTIONS,
    SPECIES_META,
    type CompanionActionId,
    type CompanionConfig,
    type CompanionSpecies,
} from "@/lib/companion-types";
import { loadCompanionConfig, saveCompanionConfig } from "@/lib/companion-storage";
import { Toggle } from "@/components/ui";

/** 衰减速度档位。给档位而不是滑杆：数值化会让用户纠结 0.7 还是 0.8。 */
const DECAY_PRESETS: { value: number; label: string; desc: string }[] = [
    { value: 0, label: "不衰减", desc: "数值永远不变，纯陪伴" },
    { value: 0.5, label: "慢", desc: "一天不管也基本没事" },
    { value: 1, label: "标准", desc: "每天照顾一次刚好" },
    { value: 2, label: "快", desc: "需要经常照顾" },
];

export function CompanionSettings({ onBack }: { onBack: () => void }) {
    const [config, setConfig] = useState<CompanionConfig>(loadCompanionConfig);
    const [editingAction, setEditingAction] = useState<CompanionActionId | null>(null);
    const [reactionDraft, setReactionDraft] = useState("");

    const update = (patch: Partial<CompanionConfig>) => {
        const next = { ...config, ...patch };
        setConfig(next);
        saveCompanionConfig(next);
    };

    const updateReaction = (actionId: CompanionActionId, text: string) => {
        const next = {
            ...config,
            customReactions: { ...config.customReactions, [actionId]: text },
        };
        setConfig(next);
        saveCompanionConfig(next);
    };

    const updateSpeciesLabel = (species: CompanionSpecies, label: string) => {
        const next = {
            ...config,
            customSpeciesLabels: { ...config.customSpeciesLabels, [species]: label },
        };
        setConfig(next);
        saveCompanionConfig(next);
    };

    return (
        <div className="companion-app">
            <div className="companion-header">
                <button
                    className="companion-icon-btn"
                    onClick={onBack}
                    aria-label="返回"
                    style={{ width: "auto", padding: "0 8px", gap: 3 }}
                >
                    <ChevronLeft size={16} strokeWidth={2} />
                </button>
                <div className="companion-title" style={{ flex: 1 }}>设置</div>
            </div>

            {/* 总开关 */}
            <div className="companion-stats" style={{ gap: 0, padding: 0 }}>
                <SettingRow
                    label="启用一起养"
                    desc="关掉后这个 App 会隐藏，角色也不会再提到它"
                    checked={config.enabled}
                    onChange={v => update({ enabled: v })}
                />
            </div>

            {config.enabled && (
                <>
                    {/* 衰减速度 */}
                    <div className="companion-create-form">
                        <div className="companion-field-label">状态变化速度</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {DECAY_PRESETS.map(p => (
                                <button
                                    key={p.value}
                                    className="companion-species-option"
                                    data-active={config.decayRate === p.value}
                                    onClick={() => update({ decayRate: p.value })}
                                    style={{ flexDirection: "row", justifyContent: "space-between", padding: "10px 12px" }}
                                >
                                    <span style={{ fontSize: 12.6, fontWeight: 600, color: "var(--c-text)" }}>
                                        {p.label}
                                    </span>
                                    <span style={{ fontSize: 10.4, color: "var(--c-icon)" }}>{p.desc}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 角色行为 */}
                    <div className="companion-stats" style={{ gap: 0, padding: 0 }}>
                        <SettingRow
                            label="角色会提到它"
                            desc="聊天时角色可能主动说起这个小家伙"
                            checked={config.allowCharacterMention}
                            onChange={v => update({ allowCharacterMention: v })}
                        />
                        <SettingRow
                            label="角色能照顾它"
                            desc="角色可以喂食、陪玩，帮你分担"
                            checked={config.allowCharacterCare}
                            onChange={v => update({ allowCharacterCare: v })}
                        />
                    </div>

                    {/* 动作反馈语 */}
                    <div className="companion-create-form">
                        <div className="companion-field-label">互动反馈语</div>
                        <div style={{ fontSize: 10.4, color: "var(--c-icon)", marginBottom: 8 }}>
                            留空则用默认文案
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                            {COMPANION_ACTIONS.map(action => (
                                <div key={action.id}>
                                    <button
                                        className="companion-secondary-btn"
                                        style={{ width: "100%", textAlign: "left", display: "flex", gap: 7, alignItems: "center" }}
                                        onClick={() => {
                                            setEditingAction(editingAction === action.id ? null : action.id);
                                            setReactionDraft(config.customReactions[action.id] || "");
                                        }}
                                    >
                                        <span>{action.icon}</span>
                                        <span style={{ flex: 1 }}>{action.label}</span>
                                        <span style={{ fontSize: 10, color: "var(--c-icon)" }}>
                                            {config.customReactions[action.id] ? "已自定义" : "默认"}
                                        </span>
                                    </button>
                                    {editingAction === action.id && (
                                        <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                                            <input
                                                className="companion-input"
                                                value={reactionDraft}
                                                onChange={e => setReactionDraft(e.target.value)}
                                                placeholder="比如：它开心地蹭了蹭你的手"
                                                maxLength={40}
                                            />
                                            <button
                                                className="companion-primary-btn"
                                                style={{ padding: "9px 14px" }}
                                                onClick={() => {
                                                    updateReaction(action.id, reactionDraft.trim());
                                                    setEditingAction(null);
                                                }}
                                            >
                                                存
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* 物种显示名 */}
                    <div className="companion-create-form">
                        <div className="companion-field-label">叫法</div>
                        <div style={{ fontSize: 10.4, color: "var(--c-icon)", marginBottom: 8 }}>
                            不想叫「小猫」可以改成别的
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                            {(Object.keys(SPECIES_META) as CompanionSpecies[]).map(s => (
                                <div key={s} style={{ display: "flex", gap: 7, alignItems: "center" }}>
                                    <span style={{ width: 52, fontSize: 11.3, color: "var(--c-icon)" }}>
                                        {SPECIES_META[s].label}
                                    </span>
                                    <input
                                        className="companion-input"
                                        value={config.customSpeciesLabels[s] || ""}
                                        onChange={e => updateSpeciesLabel(s, e.target.value)}
                                        placeholder={SPECIES_META[s].label}
                                        maxLength={10}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

function SettingRow({
    label,
    desc,
    checked,
    onChange,
}: {
    label: string;
    desc: string;
    checked: boolean;
    onChange: (v: boolean) => void;
}) {
    return (
        <div className="menu-item">
            <div className="menu-label-group" style={{ flex: 1 }}>
                <span className="menu-label">{label}</span>
                <span className="menu-desc">{desc}</span>
            </div>
            <div className="menu-right">
                <Toggle checked={checked} onChange={onChange} />
            </div>
        </div>
    );
}
