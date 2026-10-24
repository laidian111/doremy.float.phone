"use client";

/**
 * 「一起养」的设置面板。
 *
 * 按用户的要求：**每个功能都有开关或自定义**。
 * 这里把能想到的都放出来——衰减速度、角色能否主动提到/照顾、
 * 每个动作的反馈语、物种显示名。默认值都是「开」，但用户随时能关。
 */

import { useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";
import {
    COMPANION_ACTIONS,
    SPECIES_META,
    type Companion,
    type CompanionActionId,
    type CompanionConfig,
    type CompanionSpecies,
    type CompanionSpriteSheet,
} from "@/lib/companion-types";
import { loadCompanionConfig, saveCompanionConfig, loadCompanions, updateCompanion } from "@/lib/companion-storage";
import { loadChatContacts } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
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

                    {/* 顶部角色栏：显示哪些角色、按什么顺序（用户明确要求可自定义排序） */}
                    <div className="companion-create-form">
                        <div className="companion-field-label">顶部角色栏</div>
                        <div style={{ fontSize: 10.4, color: "var(--c-icon)", marginBottom: 8 }}>
                            「共同」永远在最前。添加想显示的角色，用箭头调顺序。
                        </div>
                        <OwnerBarEditor
                            selectedIds={config.ownerBarCharacterIds}
                            onChange={ids => update({ ownerBarCharacterIds: ids })}
                        />
                    </div>

                    {/* 序列帧宠物：每只单独配，有图用图、没图用手绘 */}
                    <SpriteSheetSection />

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

/**
 * 顶部角色栏编辑器：添加 + 排序 + 移除。
 *
 * 用「上下箭头」而不是拖拽：拖拽在手机触屏上误触率高，
 * 还要把指针事件和页面滚动区分开，代码复杂且容易出 bug。
 * 箭头多点一下，但每次结果都可预期。
 */
function OwnerBarEditor({
    selectedIds,
    onChange,
}: {
    selectedIds: string[];
    onChange: (ids: string[]) => void;
}) {
    const characters = useMemo(() => loadCharacters(), []);
    const contactCharIds = useMemo(() => {
        const contacts = loadChatContacts();
        return new Set(contacts.map(c => c.characterId));
    }, []);

    const selected = selectedIds
        .map(id => characters.find(c => c.id === id))
        .filter((c): c is NonNullable<typeof c> => !!c);
    const unselected = characters.filter(c =>
        !selectedIds.includes(c.id) && contactCharIds.has(c.id),
    );

    const toggle = (id: string) => {
        onChange(
            selectedIds.includes(id)
                ? selectedIds.filter(x => x !== id)
                : [...selectedIds, id],
        );
    };

    const move = (index: number, dir: -1 | 1) => {
        const next = [...selectedIds];
        const target = index + dir;
        if (target < 0 || target >= next.length) return;
        [next[index], next[target]] = [next[target], next[index]];
        onChange(next);
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {selected.map((ch, i) => (
                <div
                    key={ch.id}
                    className="companion-species-option"
                    style={{ flexDirection: "row", alignItems: "center", padding: "7px 10px", gap: 8 }}
                >
                    <span style={{ flex: 1, fontSize: 12, color: "var(--c-text)" }}>{ch.name}</span>
                    <button className="companion-secondary-btn" style={{ padding: "3px 9px" }} disabled={i === 0} onClick={() => move(i, -1)} aria-label="上移">↑</button>
                    <button className="companion-secondary-btn" style={{ padding: "3px 9px" }} disabled={i === selected.length - 1} onClick={() => move(i, 1)} aria-label="下移">↓</button>
                    <button className="companion-secondary-btn" style={{ padding: "3px 9px" }} onClick={() => toggle(ch.id)} aria-label="移除">✕</button>
                </div>
            ))}
            {unselected.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    {unselected.map(ch => (
                        <button
                            key={ch.id}
                            className="companion-owner-chip"
                            data-active="false"
                            onClick={() => toggle(ch.id)}
                        >
                            + {ch.name}
                        </button>
                    ))}
                </div>
            )}
            {selected.length === 0 && unselected.length === 0 && (
                <div style={{ fontSize: 11, color: "var(--c-icon)" }}>
                    还没有聊天角色，去创建一个吧
                </div>
            )}
        </div>
    );
}

/**
 * 序列帧宠物配置区：每只宠物单独设置。
 *
 * 配置流程尽量少让用户算数：
 *   1. 选图 → 自动按「每行帧数」切网格（先假设正方形帧）
 *   2. 点网格格子，把帧分配给「待机/开心/低落/吃/睡」五组
 *   3. 保存后宠物就用图渲染，情绪变化时自动切对应帧组
 * 帧号按行优先从 0 编号（0 1 2 3 / 4 5 6 7 …）。
 */
function SpriteSheetSection() {
    const [revision, setRevision] = useState(0);
    const companions = useMemo(() => loadCompanions(), [revision]);

    return (
        <div className="companion-create-form">
            <div className="companion-field-label">图片宠物（序列帧）</div>
            <div style={{ fontSize: 10.4, color: "var(--c-icon)", marginBottom: 8 }}>
                上传一张网格排列的动作帧图（桌宠那种），它就会动起来。不传则用内置手绘形象。
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {companions.map(c => (
                    <SpriteCompanionRow key={c.id} companionId={c.id} name={c.name} hasSprite={!!c.sprite} onChanged={() => setRevision(r => r + 1)} />
                ))}
                {companions.length === 0 && (
                    <div style={{ fontSize: 11, color: "var(--c-icon)" }}>
                        先领养一只小家伙，再回来给它设置图片
                    </div>
                )}
            </div>
        </div>
    );
}

function SpriteCompanionRow({
    companionId,
    name,
    hasSprite,
    onChanged,
}: {
    companionId: string;
    name: string;
    hasSprite: boolean;
    onChanged: () => void;
}) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div>
            <button
                className="companion-secondary-btn"
                style={{ width: "100%", textAlign: "left", display: "flex", gap: 7, alignItems: "center" }}
                onClick={() => setExpanded(e => !e)}
            >
                <span style={{ flex: 1 }}>{name}</span>
                <span style={{ fontSize: 10, color: "var(--c-icon)" }}>{hasSprite ? "已设置图片" : "默认手绘"}</span>
            </button>
            {expanded && (
                <div style={{ marginTop: 8 }}>
                    <SpriteCompanionPanel
                        companionId={companionId}
                        onChanged={onChanged}
                        onCleared={() => {
                            updateCompanion(companionId, { sprite: undefined });
                            onChanged();
                        }}
                    />
                </div>
            )}
        </div>
    );
}

/** 单只宠物的序列帧配置面板。 */
function SpriteCompanionPanel({
    companionId,
    onChanged,
    onCleared,
}: {
    companionId: string;
    onChanged: () => void;
    onCleared: () => void;
}) {
    const existing = useMemo(() => loadCompanions().find(c => c.id === companionId)?.sprite || null, [companionId]);
    const [sheet, setSheet] = useState<CompanionSpriteSheet | null>(existing);
    const [gridCols, setGridCols] = useState(String(existing?.cols || 8));
    const [frameMs, setFrameMs] = useState(String(existing?.frameMs || 160));
    const [error, setError] = useState("");
    const [activeMoodKey, setActiveMoodKey] = useState<string>("idle");

    const MOOD_KEYS = [
        { key: "idle", label: "待机" },
        { key: "happy", label: "开心" },
        { key: "sad", label: "低落" },
        { key: "eat", label: "吃东西" },
        { key: "sleep", label: "睡觉" },
    ];

    const handleFile = (file: File) => {
        setError("");
        const reader = new FileReader();
        reader.onload = () => {
            const src = String(reader.result);
            const img = new Image();
            img.onload = () => {
                const cols = Math.max(1, parseInt(gridCols, 10) || 8);
                // 只给列数时先按正方形帧估算，用户可在预览里看效果
                const frameWidth = Math.floor(img.naturalWidth / cols);
                setSheet({
                    src,
                    frameWidth,
                    frameHeight: frameWidth,
                    cols,
                    framesByMood: {},
                    frameMs: parseInt(frameMs, 10) || 160,
                });
            };
            img.onerror = () => setError("图片读取失败");
            img.src = src;
        };
        reader.readAsDataURL(file);
    };

    if (!sheet) {
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {error && <div style={{ fontSize: 11, color: "#e05353" }}>{error}</div>}
                <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "var(--c-icon)", whiteSpace: "nowrap" }}>每行帧数</span>
                    <input className="companion-input" style={{ width: 64 }} value={gridCols} onChange={e => setGridCols(e.target.value)} />
                </div>
                <label className="companion-secondary-btn" style={{ textAlign: "center", cursor: "pointer" }}>
                    选择图片…
                    <input
                        type="file"
                        accept="image/png,image/webp"
                        style={{ display: "none" }}
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                    />
                </label>
            </div>
        );
    }

    const rows = estimateRows(sheet);
    const totalFrames = rows * sheet.cols;

    const updateMoodFrames = (key: string, frames: number[]) => {
        setSheet({ ...sheet, framesByMood: { ...sheet.framesByMood, [key]: frames } });
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {error && <div style={{ fontSize: 11, color: "#e05353" }}>{error}</div>}

            <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "var(--c-icon)", whiteSpace: "nowrap" }}>每行帧数</span>
                <input
                    className="companion-input"
                    style={{ width: 64 }}
                    value={gridCols}
                    onChange={e => {
                        setGridCols(e.target.value);
                        const cols = Math.max(1, parseInt(e.target.value, 10) || 8);
                        setSheet(s => s ? { ...s, cols, frameWidth: Math.round((s.frameWidth * s.cols) / cols) } : s);
                    }}
                />
                <span style={{ fontSize: 11, color: "var(--c-icon)", whiteSpace: "nowrap" }}>每帧ms</span>
                <input
                    className="companion-input"
                    style={{ width: 64 }}
                    value={frameMs}
                    onChange={e => {
                        setFrameMs(e.target.value);
                        setSheet(s => s ? { ...s, frameMs: parseInt(e.target.value, 10) || 160 } : s);
                    }}
                />
            </div>

            <div style={{ fontSize: 11, color: "var(--c-icon)" }}>
                先选一个情绪，再点格子把帧分给它。帧号按行优先（0 起）。
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {MOOD_KEYS.map(m => (
                    <button
                        key={m.key}
                        className="companion-owner-chip"
                        data-active={activeMoodKey === m.key}
                        onClick={() => setActiveMoodKey(m.key)}
                    >
                        {m.label}{(sheet.framesByMood[m.key]?.length || 0) > 0 ? ` (${sheet.framesByMood[m.key]!.length})` : ""}
                    </button>
                ))}
            </div>

            {/* 网格点选器：每个格子显示对应帧的缩略图 */}
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${sheet.cols}, 1fr)`,
                    gap: 3,
                    maxWidth: 280,
                }}
            >
                {Array.from({ length: totalFrames }, (_, i) => {
                    const isActiveMood = sheet.framesByMood[activeMoodKey]?.includes(i);
                    const assignedElsewhere = !isActiveMood
                        && Object.entries(sheet.framesByMood).some(([k, arr]) => k !== activeMoodKey && arr?.includes(i));
                    const col = i % sheet.cols;
                    const row = Math.floor(i / sheet.cols);
                    return (
                        <button
                            key={i}
                            onClick={() => {
                                const cur = sheet.framesByMood[activeMoodKey] || [];
                                updateMoodFrames(activeMoodKey, cur.includes(i) ? cur.filter(x => x !== i) : [...cur, i]);
                            }}
                            style={{
                                aspectRatio: "1",
                                border: isActiveMood ? "2px solid #5b8def" : assignedElsewhere ? "1px solid #9ad6a8" : "1px solid rgba(0,0,0,.12)",
                                borderRadius: 4,
                                background: `url("${sheet.src}") no-repeat`,
                                backgroundSize: `${sheet.cols * 100}% ${rows * 100}%`,
                                backgroundPosition: `${(col / Math.max(1, sheet.cols - 1)) * 100}% ${(row / Math.max(1, rows - 1)) * 100}%`,
                                cursor: "pointer",
                                padding: 0,
                                minWidth: 26,
                                opacity: assignedElsewhere ? 0.55 : 1,
                            }}
                            aria-label={`帧 ${i}`}
                        />
                    );
                })}
            </div>

            <div style={{ display: "flex", gap: 7 }}>
                <button
                    className="companion-primary-btn"
                    style={{ flex: 1 }}
                    onClick={() => {
                        updateCompanion(companionId, { sprite: sheet });
                        onChanged();
                    }}
                >
                    保存
                </button>
                <button className="companion-secondary-btn" onClick={onCleared}>恢复手绘</button>
            </div>
        </div>
    );
}

/** 由已分配的帧号推断网格总行数。 */
function estimateRows(sheet: CompanionSpriteSheet): number {
    let maxFrame = 0;
    for (const arr of Object.values(sheet.framesByMood)) {
        for (const f of arr || []) {
            if (f > maxFrame) maxFrame = f;
        }
    }
    return Math.floor(maxFrame / sheet.cols) + 1;
}
