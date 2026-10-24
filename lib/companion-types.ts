// lib/companion-types.ts
//
// 「共同养成」的数据类型。
//
// 设计要点（改之前先读）：
//  · **一只宠物属于一个「owner」**：owner 可以是某个角色（私聊各自一只），
//    也可以是 "shared"（全局共享一只）。这样「和小 A 养猫、和小 B 养仓鼠」
//    和「全家共养一只」两种玩法共用一套存储，不用写两遍。
//  · **状态一律存 0-100 的整数**：浮点数在存储/比较/显示三处都容易出偏差，
//    取整之后「喂食 +20」这种行为永远可预测。
//  · **不存「上次更新时间」以外的派生值**：饥饿值等由
//    `decayCompanion` 按时间差现算，避免定时器漏跑导致状态卡住。
//    这是整个模块最重要的设计——手机后台会被冻结，任何「靠定时器
//    累加」的状态都会在后台期间停摆。

/** 宠物的外观预设。用 SVG 画，不依赖生图。 */
export type CompanionSpecies = "cat" | "dog" | "hamster" | "bird" | "slime" | "plant";

/**
 * 图片序列帧宠物（桌宠那种）。
 *
 * 用户上传一张精灵图（sprite sheet，网格排列的动作帧），
 * 按网格切成帧、按情绪/动作挑一组循环播放。
 * 网上流行的「用一张立绘生成桌宠」就是这个思路。
 */
export type CompanionSpriteSheet = {
    /** 单帧宽度（源图像素） */
    frameWidth: number;
    /** 单帧高度（源图像素） */
    frameHeight: number;
    /** 每行几帧（自动算：图宽 / frameWidth） */
    cols: number;
    /** 每行帧数的序号从 0 开始；动画按 frameIndexes 循环 */
    framesByMood: Partial<Record<string, number[]>>;
    /** 存储路径（media-store:// 或 dataURL） */
    src: string;
    /** 播放速度：每帧多少毫秒 */
    frameMs: number;
};

/** 一只宠物的归属：某角色私有，或全局共享。 */
export type CompanionOwner = string; // "char:<contactId>" | "shared"

export type CompanionStats = {
    /** 饥饿 0=饿死边缘 100=饱 */
    hunger: number;
    /** 心情 0=很低落 100=超开心 */
    mood: number;
    /** 清洁 0=很脏 100=干净 */
    clean: number;
    /** 健康 0=生病 100=很健康 */
    health: number;
    /** 亲密度 0=刚认识 100=形影不离 */
    bond: number;
};

export type CompanionActionId =
    | "feed"
    | "play"
    | "clean"
    | "pet"
    | "sleep"
    | "medicine";

export type CompanionAction = {
    id: CompanionActionId;
    label: string;
    /** emoji 图标，避免为一堆动作各画一个 SVG */
    icon: string;
    /** 对各项状态的增量；负数是消耗 */
    effects: Partial<CompanionStats>;
    /** 冷却时间（毫秒）。防止连点刷满状态。 */
    cooldownMs: number;
    /** 动作后宠物会说的话（可被用户自定义覆盖） */
    reaction?: string;
};

export type Companion = {
    id: string;
    owner: CompanionOwner;
    name: string;
    species: CompanionSpecies;
    /** 用户可调的主色，用于 SVG 着色 */
    color: string;
    /** 有序列帧图时优先用图，SVG 只是兜底 */
    sprite?: CompanionSpriteSheet;
    stats: CompanionStats;
    /** 创建时间 */
    createdAt: string;
    /** 最后一次状态结算时间（ISO）。衰减从这里起算。 */
    lastTickAt: string;
    /** 各动作的最后使用时间，用于冷却 */
    lastActionAt: Partial<Record<CompanionActionId, string>>;
    /** 累计互动次数——用于「一起经历」的叙事素材 */
    interactionCount: number;
    /** 出生第几天（派生，存一份便于排序/展示） */
    bornAt: string;
};

export type CompanionConfig = {
    /** 总开关：关掉后 App 隐藏、聊天工具不注入 */
    enabled: boolean;
    /** 状态衰减速度倍率；0 = 不衰减（纯摆设模式） */
    decayRate: number;
    /** 是否允许角色在聊天里主动提到宠物 */
    allowCharacterMention: boolean;
    /** 是否允许角色喂食/照顾（会消耗道具感） */
    allowCharacterCare: boolean;
    /**
     * 顶部归属条显示哪些角色、按什么顺序。
     * 「共同」永远在最前（它是所有角色共享的那只，不是可选的）；
     * 这里只控制「每个角色的那只」显不显示、排第几。
     * 空数组 = 一个角色都不显示，只有「共同」。
     */
    ownerBarCharacterIds: string[];
    /** 自定义动作反馈语；空则用默认 */
    customReactions: Partial<Record<CompanionActionId, string>>;
    /** 用户自定义的物种显示名（比如把 slime 叫「小史莱姆」） */
    customSpeciesLabels: Partial<Record<CompanionSpecies, string>>;
};

export const DEFAULT_COMPANION_STATS: CompanionStats = {
    hunger: 70,
    mood: 70,
    clean: 70,
    health: 100,
    bond: 10,
};

export const DEFAULT_COMPANION_CONFIG: CompanionConfig = {
    enabled: true,
    decayRate: 1,
    allowCharacterMention: true,
    allowCharacterCare: true,
    ownerBarCharacterIds: [],
    customReactions: {},
    customSpeciesLabels: {},
};

/** 各项状态的中文名与配色，UI 与聊天描述共用，避免两处各写一份。 */
export const COMPANION_STAT_META: Record<keyof CompanionStats, { label: string; color: string; icon: string }> = {
    hunger: { label: "饱食", color: "#f5a623", icon: "🍚" },
    mood: { label: "心情", color: "#ff6b9d", icon: "💗" },
    clean: { label: "清洁", color: "#4fc3f7", icon: "🫧" },
    health: { label: "健康", color: "#66bb6a", icon: "💚" },
    bond: { label: "亲密", color: "#ab47bc", icon: "🔗" },
};

export const SPECIES_META: Record<CompanionSpecies, { label: string; defaultColor: string }> = {
    cat: { label: "小猫", defaultColor: "#f0a868" },
    dog: { label: "小狗", defaultColor: "#c99a6b" },
    hamster: { label: "仓鼠", defaultColor: "#e8c49a" },
    bird: { label: "小鸟", defaultColor: "#7fc4e8" },
    slime: { label: "软软", defaultColor: "#9ad6a8" },
    plant: { label: "小盆栽", defaultColor: "#7bc47f" },
};

export const COMPANION_ACTIONS: CompanionAction[] = [
    {
        id: "feed",
        label: "喂食",
        icon: "🍚",
        effects: { hunger: 25, mood: 5, clean: -8 },
        cooldownMs: 60_000,
    },
    {
        id: "play",
        label: "陪玩",
        icon: "🎾",
        effects: { mood: 22, hunger: -10, clean: -12, bond: 4 },
        cooldownMs: 90_000,
    },
    {
        id: "clean",
        label: "清理",
        icon: "🫧",
        effects: { clean: 35, mood: 6 },
        cooldownMs: 120_000,
    },
    {
        id: "pet",
        label: "摸摸",
        icon: "🤲",
        effects: { mood: 10, bond: 3 },
        cooldownMs: 30_000,
    },
    {
        id: "sleep",
        label: "哄睡",
        icon: "🌙",
        effects: { health: 12, mood: 8 },
        cooldownMs: 300_000,
    },
    {
        id: "medicine",
        label: "喂药",
        icon: "💊",
        effects: { health: 30, mood: -8 },
        cooldownMs: 600_000,
    },
];
