"use client";

/**
 * 「共同养成」App 主界面。
 *
 * 结构：
 *   顶部：标题 + 设置入口
 *   归属条：切「共享」/各个角色（每个归属各自一只）
 *   舞台：SVG 小家伙 + 名字 + 情绪 + 第几天
 *   状态条：五项状态
 *   互动：六个动作按钮（带冷却）
 *
 * 状态正确性完全依赖 `decayCompanion` 的时间差结算——组件只管展示，
 * 不自己累加数值。定时器在这里唯一的职责是「让画面上的数字跟着时间走」，
 * 停了也不会算错（见 companion-storage.ts 的注释）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Settings2, Plus, Trash2 } from "lucide-react";
import { CompanionCharacter } from "./companion-character";
import { CompanionSettings } from "./companion-settings";
import {
    COMPANION_ACTIONS,
    COMPANION_STAT_META,
    SPECIES_META,
    type Companion,
    type CompanionActionId,
    type CompanionOwner,
    type CompanionSpecies,
    type CompanionStats,
} from "@/lib/companion-types";
import {
    COMPANION_MOOD_TEXT,
    companionDayCount,
    companionOwnerKey,
    createCompanion,
    decayCompanion,
    deleteCompanion,
    findCompanion,
    loadCompanionConfig,
    loadCompanions,
    performCompanionAction,
    resolveCompanionMood,
    saveCompanions,
} from "@/lib/companion-storage";
import { loadChatContacts } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";

const STAT_ORDER: (keyof CompanionStats)[] = ["hunger", "mood", "clean", "health", "bond"];

/** 可选颜色：都是柔和低饱和，避免小家伙看起来像塑料玩具。 */
const COLOR_CHOICES = ["#f0a868", "#e8907a", "#e8c49a", "#c99a6b", "#9ad6a8", "#7fc4e8", "#a89ae8", "#f08fb8"];

export function CompanionApp() {
    const [owner, setOwner] = useState<CompanionOwner>("shared");
    const [companion, setCompanion] = useState<Companion | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    const [showCreate, setShowCreate] = useState(false);
    const [toast, setToast] = useState("");
    const [bounce, setBounce] = useState(false);
    /** 触发重渲染用的时间刻度；不存业务数据 */
    const [tick, setTick] = useState(0);

    const contacts = useMemo(() => loadChatContacts(), []);
    const characters = useMemo(() => loadCharacters(), []);

    // 归属条：「共同」永远在最前；其余按用户在设置里选的顺序显示。
    // 没选任何角色时只有「共同」——之前是自动塞全部好友，
    // 一排挤不下还点不到，用户明确说了要自己挑。
    const ownerOptions = useMemo(() => {
        const opts: { key: CompanionOwner; label: string }[] = [{ key: "shared", label: "共同" }];
        const config = loadCompanionConfig();
        const shownIds = new Set(config.ownerBarCharacterIds);
        for (const charId of config.ownerBarCharacterIds) {
            const ch = characters.find(x => x.id === charId);
            if (ch) opts.push({ key: companionOwnerKey(charId), label: ch.name });
        }
        // 配置里有但角色已被删的条目跳过；contacts 变量只用于校验好友关系存在性
        void contacts;
        void shownIds;
        return opts;
    }, [contacts, characters]);

    // 读取 + 结算。每次 owner/tick 变化都重新算，保证数字跟得上时间。
    useEffect(() => {
        const cfg = loadCompanionConfig();
        const raw = findCompanion(owner);
        if (!raw) {
            setCompanion(null);
            return;
        }
        const settled = decayCompanion(raw, Date.now(), cfg.decayRate);
        // 结算结果写回：否则每次进 App 都从旧时间戳重算，
        // 虽然结果一样，但 lastTickAt 会一直停留在很久以前，
        // 冷却判断之类依赖它的逻辑会看到过期数据
        const list = loadCompanions();
        const idx = list.findIndex(c => c.id === settled.id);
        if (idx >= 0) {
            list[idx] = settled;
            saveCompanions(list);
        }
        setCompanion(settled);
    }, [owner, tick]);

    // 让画面跟着时间走。30 秒一次够用——状态是按小时衰减的，
    // 更频繁只会白耗电。
    useEffect(() => {
        const timer = window.setInterval(() => setTick(t => t + 1), 30_000);
        return () => window.clearInterval(timer);
    }, []);

    // 别的地方改了宠物（聊天工具喂食等）也要刷新
    useEffect(() => {
        const onUpdate = () => setTick(t => t + 1);
        window.addEventListener("companions-updated", onUpdate);
        return () => window.removeEventListener("companions-updated", onUpdate);
    }, []);

    const showToast = useCallback((text: string) => {
        setToast(text);
        window.setTimeout(() => setToast(""), 2200);
    }, []);

    const handleAction = (actionId: CompanionActionId) => {
        const result = performCompanionAction(owner, actionId);
        if (!result.ok) {
            if (result.reason === "cooldown") {
                const sec = Math.ceil(result.remainingMs / 1000);
                showToast(sec >= 60 ? `再等 ${Math.ceil(sec / 60)} 分钟` : `再等 ${sec} 秒`);
            }
            return;
        }
        setCompanion(result.companion);
        setBounce(true);
        window.setTimeout(() => setBounce(false), 520);

        // 提示这次实际加了什么。用实际增量而不是配置值：
        // 状态已经满时加 0，显示「+25」会让用户以为坏了
        const parts = Object.entries(result.deltas)
            .filter(([, v]) => v !== 0)
            .map(([k, v]) => `${COMPANION_STAT_META[k as keyof CompanionStats].label}${v > 0 ? "+" : ""}${v}`);
        const action = COMPANION_ACTIONS.find(a => a.id === actionId);
        showToast(parts.length > 0 ? `${action?.label}：${parts.join(" ")}` : "它现在这样就挺好");
    };

    const handlePoke = () => {
        setBounce(true);
        window.setTimeout(() => setBounce(false), 520);
        // 摸一摸也走正式动作（有冷却、加心情/亲密），
        // 但不弹提示——连点时不希望满屏 toast
        performCompanionAction(owner, "pet");
        setTick(t => t + 1);
    };

    if (showSettings) {
        return <CompanionSettings onBack={() => { setShowSettings(false); setTick(t => t + 1); }} />;
    }

    if (showCreate) {
        return (
            <CreateCompanionForm
                owner={owner}
                onCancel={() => setShowCreate(false)}
                onCreated={(c) => {
                    setShowCreate(false);
                    setCompanion(c);
                    setTick(t => t + 1);
                    showToast(`「${c.name}」来到你身边了`);
                }}
            />
        );
    }

    return (
        <div className="companion-app">
            <div className="companion-header">
                <div>
                    <div className="companion-title">一起养</div>
                    <div className="companion-subtitle">和 TA 共同照顾的小家伙</div>
                </div>
                <button className="companion-icon-btn" onClick={() => setShowSettings(true)} aria-label="设置">
                    <Settings2 size={16} strokeWidth={1.8} />
                </button>
            </div>

            {/* 归属切换：共享 / 各角色。只在有多个归属时才显示，
                只有一个的时候那条切换栏纯属噪音。 */}
            {ownerOptions.length > 1 && (
                <div className="companion-owner-bar">
                    {ownerOptions.map(opt => (
                        <button
                            key={opt.key}
                            className="companion-owner-chip"
                            data-active={owner === opt.key}
                            onClick={() => setOwner(opt.key)}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            )}

            {companion ? (
                <>
                    <div className="companion-stage">
                        <CompanionCharacter
                            species={companion.species}
                            color={companion.color}
                            mood={resolveCompanionMood(companion.stats)}
                            size={150}
                            onPoke={handlePoke}
                            bounce={bounce}
                            sprite={companion.sprite}
                        />
                        <div className="companion-name">{companion.name}</div>
                        <div className="companion-mood-text">
                            {COMPANION_MOOD_TEXT[resolveCompanionMood(companion.stats)]}
                        </div>
                        <div className="companion-day-badge">
                            一起的第 {companionDayCount(companion)} 天
                        </div>
                    </div>

                    <div className="companion-stats">
                        {STAT_ORDER.map(key => {
                            const meta = COMPANION_STAT_META[key];
                            const value = companion.stats[key];
                            return (
                                <div key={key} className="companion-stat-row">
                                    <span className="companion-stat-icon">{meta.icon}</span>
                                    <span className="companion-stat-label">{meta.label}</span>
                                    <div className="companion-stat-track">
                                        <div
                                            className="companion-stat-fill"
                                            style={{ width: `${value}%`, background: meta.color }}
                                        />
                                    </div>
                                    <span className="companion-stat-value">{value}</span>
                                </div>
                            );
                        })}
                    </div>

                    <div className="companion-actions">
                        {COMPANION_ACTIONS.map(action => {
                            const lastAt = companion.lastActionAt[action.id];
                            const remaining = lastAt
                                ? Math.max(0, action.cooldownMs - (Date.now() - new Date(lastAt).getTime()))
                                : 0;
                            const onCooldown = remaining > 0;
                            return (
                                <button
                                    key={action.id}
                                    className="companion-action-btn"
                                    disabled={onCooldown}
                                    onClick={() => handleAction(action.id)}
                                >
                                    <span className="companion-action-icon">{action.icon}</span>
                                    <span className="companion-action-label">{action.label}</span>
                                    {onCooldown && (
                                        <span className="companion-action-cd">
                                            {remaining >= 60_000
                                                ? `${Math.ceil(remaining / 60_000)}分`
                                                : `${Math.ceil(remaining / 1000)}秒`}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    <button
                        className="companion-secondary-btn"
                        onClick={() => {
                            if (!confirm(`确定要告别「${companion.name}」吗？这个操作不能撤销。`)) return;
                            deleteCompanion(companion.id);
                            setCompanion(null);
                            setTick(t => t + 1);
                        }}
                        style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                    >
                        <Trash2 size={13} strokeWidth={1.8} />
                        告别这个小家伙
                    </button>
                </>
            ) : (
                <div className="companion-empty">
                    <div style={{ fontSize: 40, opacity: 0.5 }}>🥚</div>
                    <div>这里还空着</div>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>
                        养一只小家伙，和 TA 一起照顾它长大
                    </div>
                    <button className="companion-primary-btn" onClick={() => setShowCreate(true)} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <Plus size={15} strokeWidth={2.2} />
                        领养一只
                    </button>
                </div>
            )}

            {toast && <div className="companion-toast">{toast}</div>}
        </div>
    );
}

// ── 创建表单 ──────────────────────────────────

function CreateCompanionForm({
    owner,
    onCancel,
    onCreated,
}: {
    owner: CompanionOwner;
    onCancel: () => void;
    onCreated: (c: Companion) => void;
}) {
    const [name, setName] = useState("");
    const [species, setSpecies] = useState<CompanionSpecies>("cat");
    const [color, setColor] = useState(SPECIES_META.cat.defaultColor);

    // 换物种时自动换到该物种的默认色。用户手动改过颜色后再换物种
    // 会被覆盖——这是有意的：新物种配旧颜色经常很怪。
    const handleSpecies = (s: CompanionSpecies) => {
        setSpecies(s);
        setColor(SPECIES_META[s].defaultColor);
    };

    const canSubmit = name.trim().length > 0;

    return (
        <div className="companion-app">
            <div className="companion-header">
                <div className="companion-title">领养一只</div>
                <button className="companion-secondary-btn" onClick={onCancel}>取消</button>
            </div>

            <div className="companion-stage" style={{ paddingTop: 12 }}>
                <CompanionCharacter species={species} color={color} mood="happy" size={120} />
                <div className="companion-mood-text">{name.trim() || "还没起名字"}</div>
            </div>

            <div className="companion-create-form">
                <div>
                    <div className="companion-field-label">起个名字</div>
                    <input
                        className="companion-input"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder="比如：团子、小满、阿黄"
                        maxLength={12}
                        autoFocus
                    />
                </div>

                <div>
                    <div className="companion-field-label">选个样子</div>
                    <div className="companion-species-grid">
                        {(Object.keys(SPECIES_META) as CompanionSpecies[]).map(s => (
                            <button
                                key={s}
                                className="companion-species-option"
                                data-active={species === s}
                                onClick={() => handleSpecies(s)}
                            >
                                <CompanionCharacter
                                    species={s}
                                    color={SPECIES_META[s].defaultColor}
                                    mood="content"
                                    size={42}
                                />
                                <span className="companion-species-label">{SPECIES_META[s].label}</span>
                            </button>
                        ))}
                    </div>
                </div>

                <div>
                    <div className="companion-field-label">选个颜色</div>
                    <div className="companion-color-row">
                        {COLOR_CHOICES.map(c => (
                            <button
                                key={c}
                                className="companion-color-dot"
                                style={{ background: c }}
                                data-active={color === c}
                                onClick={() => setColor(c)}
                                aria-label={`颜色 ${c}`}
                            />
                        ))}
                    </div>
                </div>

                <button
                    className="companion-primary-btn"
                    disabled={!canSubmit}
                    onClick={() => {
                        const created = createCompanion({ owner, name, species, color });
                        onCreated(created);
                    }}
                >
                    就是它了
                </button>
            </div>
        </div>
    );
}
