// lib/companion-storage.ts
//
// 共同养成的存储 + 状态结算。
//
// ── 为什么状态要靠「时间差现算」而不是定时器累加 ──
//
// 最直觉的写法是每 N 分钟跑一次 setInterval 把饥饿值减一点。但这个小手机
// 跑在手机 WebView 里，进后台会被冻结甚至杀进程——定时器一停，宠物就
// 「饿不死也脏不掉」，用户切回来发现数值纹丝不动。
//
// 所以这里反过来：**只存 lastTickAt，每次读取时按经过的真实时间算衰减**。
// 手机在后台躺了 8 小时，回来一读就是 8 小时的衰减，一次算清。
// 定时器只在 App 开着时负责「让画面动起来」，不承担正确性。
//
// ── 为什么衰减用「分段」而不是线性 ──
//
// 线性衰减下，离开三天回来所有值都归零，宠物看起来像死了，体验很差。
// 这里让每项状态有各自的「舒适区」：跌到阈值以下就不再快速下降，
// 停在「有点饿但还活着」的位置。回来喂一顿就能救回来。

import {
    COMPANION_ACTIONS,
    DEFAULT_COMPANION_CONFIG,
    DEFAULT_COMPANION_STATS,
    SPECIES_META,
    type Companion,
    type CompanionActionId,
    type CompanionConfig,
    type CompanionOwner,
    type CompanionSpecies,
    type CompanionStats,
} from "./companion-types";

const COMPANIONS_KEY = "ai_phone_companions_v1";
const COMPANION_CONFIG_KEY = "ai_phone_companion_config_v1";

// ── 基础读写 ──────────────────────────────────

function kvGet(key: string): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function kvSet(key: string, value: string): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // 配额满 / 隐私模式：静默失败，不阻断 UI
    }
}

function clamp(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
}

export function loadCompanions(): Companion[] {
    const raw = kvGet(COMPANIONS_KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((c): c is Companion =>
            !!c && typeof c.id === "string" && typeof c.name === "string" && !!c.stats,
        );
    } catch {
        return [];
    }
}

export function saveCompanions(list: Companion[]): void {
    kvSet(COMPANIONS_KEY, JSON.stringify(list));
    if (typeof window !== "undefined") {
        // 桌面图标/聊天面板据此刷新
        window.dispatchEvent(new CustomEvent("companions-updated"));
    }
}

export function loadCompanionConfig(): CompanionConfig {
    const raw = kvGet(COMPANION_CONFIG_KEY);
    if (!raw) return DEFAULT_COMPANION_CONFIG;
    try {
        // 展开默认值：老版本存的配置缺新字段时自动补上，
        // 不用写一堆 `?? default`
        return { ...DEFAULT_COMPANION_CONFIG, ...JSON.parse(raw) };
    } catch {
        return DEFAULT_COMPANION_CONFIG;
    }
}

export function saveCompanionConfig(config: CompanionConfig): void {
    kvSet(COMPANION_CONFIG_KEY, JSON.stringify(config));
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("companions-updated"));
    }
}

// ── 归属键 ────────────────────────────────────

/**
 * 生成归属键。
 *
 * 用 contactId 而不是 sessionId：会话可能被重建/删除重建，
 * 而角色身份是稳定的。用 sessionId 会导致「删了聊天，宠物就没了」。
 */
export function companionOwnerKey(contactId?: string | null): CompanionOwner {
    return contactId ? `char:${contactId}` : "shared";
}

export function findCompanion(owner: CompanionOwner): Companion | null {
    return loadCompanions().find(c => c.owner === owner) || null;
}

// ── 状态结算 ──────────────────────────────────

/** 每项状态每小时的基础衰减量（decayRate=1 时）。 */
const HOURLY_DECAY: Record<keyof CompanionStats, number> = {
    // 饿得最快：一天不管会明显掉，这是「需要照顾」的主要来源
    hunger: 3.2,
    mood: 2.0,
    clean: 1.6,
    // 健康不直接随时间掉，由其它项过低时连带影响
    health: 0,
    // 亲密度只增不减（掉亲密度最伤感情，不做）
    bond: 0,
};

/**
 * 每项状态的「舒适地板」：跌到这里之后衰减速度降到 20%。
 *
 * 为什么要有地板：离开三天回来发现所有值归零，宠物看起来像死了，
 * 用户会觉得被惩罚。停在一个「明显需要照顾但还活着」的位置，
 * 回来喂一顿就能救回来，才是可持续的养成节奏。
 */
const DECAY_FLOOR: Partial<Record<keyof CompanionStats, number>> = {
    hunger: 15,
    mood: 12,
    clean: 10,
};

/**
 * 每项状态的**硬下限**：地板以下的 20% 慢速衰减也不会跌破这里。
 *
 * 光有「减速」不够——第一版只做了减速，实测离开三天仍然全部归零。
 * 减速只是让归零变慢，不能阻止归零。这里给一个绝对兜底，
 * 保证「不管离开多久，宠物都还活着、还能救回来」。
 */
const DECAY_HARD_MIN: Partial<Record<keyof CompanionStats, number>> = {
    hunger: 4,
    mood: 3,
    clean: 3,
};

/**
 * 按真实经过时间结算状态。**纯函数**，不写存储。
 *
 * @param companion 当前宠物
 * @param nowMs 结算时刻（默认现在）
 * @param decayRate 衰减倍率，0 = 冻结
 */
export function decayCompanion(
    companion: Companion,
    nowMs: number = Date.now(),
    decayRate: number = 1,
): Companion {
    if (decayRate <= 0) {
        // 冻结模式：只更新结算时间，数值不动
        return { ...companion, lastTickAt: new Date(nowMs).toISOString() };
    }

    const last = new Date(companion.lastTickAt).getTime();
    if (!Number.isFinite(last) || last > nowMs) {
        // 时间戳坏了或来自未来（改过系统时间）：不结算，只重置时间戳，
        // 免得算出一个巨大的负数把宠物直接算死
        return { ...companion, lastTickAt: new Date(nowMs).toISOString() };
    }

    const hours = (nowMs - last) / 3_600_000;
    if (hours <= 0) return companion;

    const next: CompanionStats = { ...companion.stats };

    for (const key of Object.keys(HOURLY_DECAY) as (keyof CompanionStats)[]) {
        const base = HOURLY_DECAY[key];
        if (base <= 0) continue;

        const floor = DECAY_FLOOR[key];
        const hardMin = DECAY_HARD_MIN[key] ?? 0;
        const current = next[key];
        const fullDrop = base * hours * decayRate;

        if (floor === undefined) {
            next[key] = clamp(current - fullDrop);
            continue;
        }

        // 分段衰减：舒适区正常掉，地板以下慢速掉，硬下限兜底。
        // 三段分别按「跨过各段的时长」拆开算，避免一次大步跨过时算错。
        if (current <= hardMin) {
            next[key] = hardMin;
        } else if (current <= floor) {
            const slowDrop = fullDrop * 0.2;
            next[key] = Math.max(hardMin, clamp(current - slowDrop));
        } else {
            const toFloor = current - floor;
            const hoursToFloor = toFloor / (base * decayRate);
            if (hours <= hoursToFloor) {
                next[key] = clamp(current - fullDrop);
            } else {
                const restHours = hours - hoursToFloor;
                const slowDrop = base * restHours * decayRate * 0.2;
                next[key] = Math.max(hardMin, clamp(floor - slowDrop));
            }
        }
    }

    // 健康由其它项连带：饥饿或清洁见底时缓慢掉健康。
    // 放在最后算，用的是本轮已更新的数值。
    const healthDrag =
        (next.hunger <= 10 ? 1 : 0) +
        (next.clean <= 8 ? 0.8 : 0) +
        (next.mood <= 8 ? 0.5 : 0);
    if (healthDrag > 0) {
        next.health = clamp(next.health - healthDrag * hours * decayRate);
    } else if (next.hunger > 45 && next.clean > 40 && next.mood > 40) {
        // 状态还行时健康缓慢自愈。
        //
        // 阈值定在 45/40/40 而不是「全 >60」：第一版要求三项都 >60，
        // 但衰减 10 小时后就满足不了了——自愈条件实际上永远不成立。
        // 自愈的意义是「别让健康单向恶化」，门槛必须够低才起作用。
        next.health = clamp(next.health + 0.4 * hours * decayRate);
    }

    return {
        ...companion,
        stats: next,
        lastTickAt: new Date(nowMs).toISOString(),
    };
}

/** 读一只宠物并顺便结算状态（读操作就应该返回正确数值）。 */
export function getCompanionSettled(owner: CompanionOwner, nowMs: number = Date.now()): Companion | null {
    const companion = findCompanion(owner);
    if (!companion) return null;
    const cfg = loadCompanionConfig();
    return decayCompanion(companion, nowMs, cfg.decayRate);
}

/**
 * 把结算后的状态写回存储。
 *
 * 单独一个函数而不是让 getCompanionSettled 顺手写：读操作有副作用
 * 会让「渲染中写存储」变成常态，React 严格模式下会重复触发。
 */
export function persistSettled(companion: Companion): Companion {
    const list = loadCompanions();
    const idx = list.findIndex(c => c.id === companion.id);
    if (idx < 0) return companion;
    list[idx] = companion;
    saveCompanions(list);
    return companion;
}

// ── 创建 ──────────────────────────────────────

export function createCompanion(input: {
    owner: CompanionOwner;
    name: string;
    species: CompanionSpecies;
    color?: string;
}): Companion {
    const now = new Date().toISOString();
    const companion: Companion = {
        id: `comp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        owner: input.owner,
        name: input.name.trim() || "小家伙",
        species: input.species,
        color: input.color || SPECIES_META[input.species].defaultColor,
        stats: { ...DEFAULT_COMPANION_STATS },
        createdAt: now,
        lastTickAt: now,
        lastActionAt: {},
        interactionCount: 0,
        bornAt: now,
    };
    const list = loadCompanions();
    list.push(companion);
    saveCompanions(list);
    return companion;
}

export function deleteCompanion(id: string): void {
    saveCompanions(loadCompanions().filter(c => c.id !== id));
}

export function updateCompanion(id: string, patch: Partial<Companion>): Companion | null {
    const list = loadCompanions();
    const idx = list.findIndex(c => c.id === id);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], ...patch };
    saveCompanions(list);
    return list[idx];
}

// ── 互动 ──────────────────────────────────────

export type CompanionActionResult =
    | { ok: true; companion: Companion; deltas: Partial<CompanionStats> }
    | { ok: false; reason: "cooldown"; remainingMs: number }
    | { ok: false; reason: "not_found" };

/**
 * 执行一个互动动作。
 *
 * 冷却时间按**真实时间**判断，不依赖定时器——和状态衰减同一个道理。
 */
export function performCompanionAction(
    owner: CompanionOwner,
    actionId: CompanionActionId,
    nowMs: number = Date.now(),
): CompanionActionResult {
    const cfg = loadCompanionConfig();
    const found = findCompanion(owner);
    if (!found) return { ok: false, reason: "not_found" };

    // 先结算到此刻，保证增量加在正确的基础上
    const settled = decayCompanion(found, nowMs, cfg.decayRate);

    const action = COMPANION_ACTIONS.find(a => a.id === actionId);
    if (!action) return { ok: false, reason: "not_found" };

    const lastAt = settled.lastActionAt[actionId];
    if (lastAt) {
        const elapsed = nowMs - new Date(lastAt).getTime();
        if (Number.isFinite(elapsed) && elapsed < action.cooldownMs) {
            return { ok: false, reason: "cooldown", remainingMs: action.cooldownMs - elapsed };
        }
    }

    const nextStats: CompanionStats = { ...settled.stats };
    const deltas: Partial<CompanionStats> = {};
    for (const [k, v] of Object.entries(action.effects) as [keyof CompanionStats, number][]) {
        const before = nextStats[k];
        nextStats[k] = clamp(before + v);
        const actual = nextStats[k] - before;
        if (actual !== 0) deltas[k] = actual;
    }

    const updated: Companion = {
        ...settled,
        stats: nextStats,
        interactionCount: settled.interactionCount + 1,
        lastActionAt: { ...settled.lastActionAt, [actionId]: new Date(nowMs).toISOString() },
    };

    const list = loadCompanions();
    const idx = list.findIndex(c => c.id === updated.id);
    if (idx >= 0) {
        list[idx] = updated;
        saveCompanions(list);
    }

    return { ok: true, companion: updated, deltas };
}

// ── 展示辅助 ──────────────────────────────────

/** 综合状态：用于决定表情与一句话描述。 */
export type CompanionMood = "happy" | "content" | "hungry" | "dirty" | "sick" | "sad" | "sleepy";

export function resolveCompanionMood(stats: CompanionStats): CompanionMood {
    // 优先级：生病 > 很脏 > 很饿 > 低落 > 困 > 普通
    // 顺序有意义：健康问题最需要被看到，所以排最前
    if (stats.health <= 30) return "sick";
    if (stats.clean <= 25) return "dirty";
    if (stats.hunger <= 25) return "hungry";
    if (stats.mood <= 25) return "sad";
    if (stats.hunger <= 45 || stats.mood <= 45) return "sleepy";
    if (stats.mood >= 75 && stats.hunger >= 60) return "happy";
    return "content";
}

/** 情绪 → 一句人话（App 里显示，也用于聊天工具返回值）。 */
export const COMPANION_MOOD_TEXT: Record<CompanionMood, string> = {
    happy: "开心得不得了",
    content: "看起来很满足",
    hungry: "肚子饿了，在等吃的",
    dirty: "有点脏兮兮的",
    sick: "不太舒服",
    sad: "情绪有点低落",
    sleepy: "有点困了",
};

/** 出生第几天（1 起算）。 */
export function companionDayCount(companion: Companion, nowMs: number = Date.now()): number {
    const born = new Date(companion.bornAt).getTime();
    if (!Number.isFinite(born)) return 1;
    return Math.max(1, Math.floor((nowMs - born) / 86_400_000) + 1);
}

/**
 * 生成给模型看的状态摘要（工具返回值用）。
 *
 * 单独一个函数而不是在工具里拼字符串：聊天工具和「回忆闪回」之类
 * 后续功能都要用同一份描述，拼两遍必然不一致。
 */
export function formatCompanionForPrompt(companion: Companion, nowMs: number = Date.now()): string {
    const mood = resolveCompanionMood(companion.stats);
    const day = companionDayCount(companion, nowMs);
    const s = companion.stats;
    return [
        `你和{{user}}一起养的${SPECIES_META[companion.species].label}「${companion.name}」`,
        `今天是我们一起养它的第 ${day} 天`,
        `状态：饱食 ${s.hunger}、心情 ${s.mood}、清洁 ${s.clean}、健康 ${s.health}、亲密 ${s.bond}`,
        `它现在${COMPANION_MOOD_TEXT[mood]}`,
    ].join("；");
}

/**
 * 给系统提示词用的「一起养」上下文。
 *
 * 返回空字符串表示不需要注入——没养、或用户在设置里关掉了「角色会提到它」。
 * 调用方（chat-engine）把它塞进 {{companionContext}} 宏，空值会被自动裁掉。
 *
 * ── 为什么这段要存在 ──
 * 光有工具是不够的：角色不知道宠物存在就不会去调用工具，
 * 也就永远想不起来。这段提示词的作用是「让它知道有这么个东西」，
 * 具体状态则留给工具去查——提示词里只放最小必要信息，
 * 避免每次对话都塞一大段。
 *
 * @param characterId 当前说话的角色。用于找到「这个角色那一只」，
 *                    找不到就退回共享那只。
 */
export function buildCompanionPromptContext(characterId?: string | null): string {
    try {
        const config = loadCompanionConfig();
        if (!config.enabled || !config.allowCharacterMention) return "";

        const candidates: CompanionOwner[] = [];
        if (characterId) candidates.push(companionOwnerKey(characterId));
        candidates.push("shared");

        let companion: Companion | null = null;
        for (const owner of candidates) {
            companion = findCompanion(owner);
            if (companion) break;
        }
        if (!companion) return "";

        // 结算到此刻再描述，免得说「它很饿」但其实用户刚喂过
        const settled = decayCompanion(companion, Date.now(), config.decayRate);
        const mood = resolveCompanionMood(settled.stats);
        const day = companionDayCount(settled);
        const speciesLabel = config.customSpeciesLabels[settled.species] || SPECIES_META[settled.species].label;

        return [
            `【一起养】你和{{user}}共同养着一只${speciesLabel}，叫「${settled.name}」，今天是第 ${day} 天。`,
            `它现在${COMPANION_MOOD_TEXT[mood]}。`,
            "你可以自然地在聊天里提到它，也可以主动去看看它、照顾它（用「一起养」工具）。",
            "不用每句话都提，也别像汇报一样列数据——它只是你们生活里的一部分。",
        ].join("\n");
    } catch {
        // 提示词组装失败不该阻断对话
        return "";
    }
}
