"use client";

/**
 * 共同养成的小家伙——SVG 手绘 + CSS 动画。
 *
 * ── 为什么不用 emoji / 生图 ──
 * emoji 没有「活着」的感觉：不能呼吸、不会看你、表情不会变。
 * 生图需要 API、会失败、有加载延迟，而且换一个表情就要重画一张。
 * SVG 三样都能做：形状可参数化（颜色随用户选）、表情可切换、
 * 动画用 CSS 就能跑，而且零网络依赖。
 *
 * ── 「活」的四个来源（改这个组件前先读）──
 *   1. 呼吸：整体极缓慢缩放（3.6s），幅度很小，但眼睛会先捕捉到
 *   2. 眨眼：随机间隔（2~6s），不是固定节奏——固定节奏一眼就看出是机器
 *   3. 视线跟随：眼睛随 mood 微移，happy 时眼睛弯成弧、sad 时下垂
 *   4. 点击反馈：被摸时弹一下 + 爱心飘出
 *
 * ── 为什么表情画在 SVG 里而不是换图 ──
 * 换图会闪、要预加载、每加一个状态就多一张资源。用 path/ellipse
 * 直接画，状态切换是瞬时的、可插值的，也不占额外体积。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CompanionSpecies, CompanionSpriteSheet } from "@/lib/companion-types";
import type { CompanionMood } from "@/lib/companion-storage";
import { CompanionSprite } from "./companion-sprite";

type Props = {
    species: CompanionSpecies;
    color: string;
    mood: CompanionMood;
    /** 尺寸（px），默认 160 */
    size?: number;
    /** 被点击时触发（摸摸） */
    onPoke?: () => void;
    /** 是否播放「开心弹跳」动画 */
    bounce?: boolean;
    /** 有序列帧图时优先用图；SVG 只是没图时的兜底 */
    sprite?: CompanionSpriteSheet;
};

/** 各物种的身体轮廓路径。用归一化坐标（0-100 视口），便于统一缩放。 */
const BODY_PATHS: Record<CompanionSpecies, string> = {
    // 圆润的身体 + 两只尖耳
    cat: "M50 88 C22 88 12 70 12 52 C12 34 28 22 50 22 C72 22 88 34 88 52 C88 70 78 88 50 88 Z",
    // 稍宽，耳朵下垂
    dog: "M50 88 C22 88 12 70 12 52 C12 34 28 22 50 22 C72 22 88 34 88 52 C88 70 78 88 50 88 Z",
    // 更圆更扁
    hamster: "M50 86 C20 86 10 68 10 52 C10 34 28 24 50 24 C72 24 90 34 90 52 C90 68 80 86 50 86 Z",
    // 椭圆蛋形
    bird: "M50 88 C26 88 16 72 16 56 C16 36 30 22 50 22 C70 22 84 36 84 56 C84 72 74 88 50 88 Z",
    // 布丁形状：上窄下宽
    slime: "M50 86 C24 86 14 72 14 58 C14 38 30 20 50 20 C70 20 86 38 86 58 C86 72 76 86 50 86 Z",
    // 花盆 + 叶子（特殊处理，见下）
    plant: "M28 88 L72 88 L68 56 L32 56 Z",
};

/** 耳朵路径（plant 没有耳朵）。 */
const EAR_PATHS: Partial<Record<CompanionSpecies, { left: string; right: string }>> = {
    cat: {
        left: "M22 30 L18 8 L40 22 Z",
        right: "M78 30 L82 8 L60 22 Z",
    },
    dog: {
        left: "M20 34 C8 30 6 46 14 52 Z",
        right: "M80 34 C92 30 94 46 86 52 Z",
    },
    hamster: {
        left: "M24 28 C16 14 30 12 36 24 Z",
        right: "M76 28 C84 14 70 12 64 24 Z",
    },
    bird: {
        left: "M32 24 C26 12 40 12 44 20 Z",
        right: "M68 24 C74 12 60 12 56 20 Z",
    },
    slime: {
        // 软软没有耳朵，用两个小尖角代替
        left: "M32 22 C30 12 40 14 40 20 Z",
        right: "M68 22 C70 12 60 14 60 20 Z",
    },
};

/**
 * 眼睛：按情绪改变形状。
 * 返回 SVG 元素——直接用 JSX 而不是字符串路径，因为每种的标签类型不同。
 */
function CompanionEyes({ mood }: { mood: CompanionMood }) {
    const eyeY = 52;

    // 开心：弯成上扬的弧（^^）
    if (mood === "happy") {
        return (
            <g stroke="#2b2b33" strokeWidth="3.4" strokeLinecap="round" fill="none">
                <path d={`M34 ${eyeY + 2} Q40 ${eyeY - 5} 46 ${eyeY + 2}`} />
                <path d={`M54 ${eyeY + 2} Q60 ${eyeY - 5} 66 ${eyeY + 2}`} />
            </g>
        );
    }
    // 难过：下垂的眼皮
    if (mood === "sad" || mood === "sick") {
        return (
            <g>
                <ellipse cx="40" cy={eyeY} rx="4.2" ry="5" fill="#2b2b33" />
                <ellipse cx="60" cy={eyeY} rx="4.2" ry="5" fill="#2b2b33" />
                {/* 下垂的眼皮：一条压住上方的弧线 */}
                <path d={`M34 ${eyeY - 4} Q40 ${eyeY - 7} 46 ${eyeY - 4}`} stroke="#2b2b33" strokeWidth="2.6" fill="none" strokeLinecap="round" />
                <path d={`M54 ${eyeY - 4} Q60 ${eyeY - 7} 66 ${eyeY - 4}`} stroke="#2b2b33" strokeWidth="2.6" fill="none" strokeLinecap="round" />
            </g>
        );
    }
    // 困：半闭
    if (mood === "sleepy") {
        return (
            <g>
                <path d={`M35 ${eyeY} Q40 ${eyeY + 4} 45 ${eyeY}`} stroke="#2b2b33" strokeWidth="3.2" fill="none" strokeLinecap="round" />
                <path d={`M55 ${eyeY} Q60 ${eyeY + 4} 65 ${eyeY}`} stroke="#2b2b33" strokeWidth="3.2" fill="none" strokeLinecap="round" />
            </g>
        );
    }
    // 默认：圆眼 + 高光（高光是「有生命」的关键，纯黑圆点看着像塑料）
    return (
        <g>
            <ellipse cx="40" cy={eyeY} rx="4.6" ry="5.4" fill="#2b2b33" />
            <ellipse cx="60" cy={eyeY} rx="4.6" ry="5.4" fill="#2b2b33" />
            <circle cx="38.4" cy={eyeY - 1.8} r="1.5" fill="#ffffff" opacity="0.9" />
            <circle cx="58.4" cy={eyeY - 1.8} r="1.5" fill="#ffffff" opacity="0.9" />
        </g>
    );
}

/** 嘴：随情绪变。 */
function CompanionMouth({ mood }: { mood: CompanionMood }) {
    const y = 66;
    if (mood === "happy") {
        // 张开的笑
        return <path d={`M43 ${y} Q50 ${y + 8} 57 ${y} Q50 ${y + 3} 43 ${y} Z`} fill="#e8697d" />;
    }
    if (mood === "sad" || mood === "sick") {
        // 向下的弧
        return <path d={`M44 ${y + 3} Q50 ${y - 2} 56 ${y + 3}`} stroke="#2b2b33" strokeWidth="2.6" fill="none" strokeLinecap="round" />;
    }
    if (mood === "hungry") {
        // 张开等吃的
        return <ellipse cx="50" cy={y + 1} rx="4.4" ry="4" fill="#e8697d" />;
    }
    // 默认小微笑
    return <path d={`M44 ${y} Q50 ${y + 4} 56 ${y}`} stroke="#2b2b33" strokeWidth="2.6" fill="none" strokeLinecap="round" />;
}

/** 腮红：只在开心/满足时出现，是很廉价但极有效的「可爱」信号。 */
function CompanionBlush({ mood }: { mood: CompanionMood }) {
    if (mood !== "happy" && mood !== "content") return null;
    return (
        <g opacity="0.55">
            <ellipse cx="28" cy="62" rx="5.5" ry="3.4" fill="#ff9db3" />
            <ellipse cx="72" cy="62" rx="5.5" ry="3.4" fill="#ff9db3" />
        </g>
    );
}

/** 植物没有眼睛嘴，改用叶子 + 表情（拟人化）。 */
function PlantDecoration({ color, mood }: { color: string; mood: CompanionMood }) {
    const leafDrop = mood === "sad" || mood === "sick" ? 6 : 0;
    return (
        <g>
            {/* 两片叶子 */}
            <path
                d={`M50 56 C44 ${34 + leafDrop} 30 ${28 + leafDrop} 30 ${40 + leafDrop} C30 ${50 + leafDrop} 42 54 50 56 Z`}
                fill={color}
                opacity="0.85"
            />
            <path
                d={`M50 56 C56 ${30 + leafDrop} 70 ${24 + leafDrop} 70 ${38 + leafDrop} C70 ${48 + leafDrop} 58 54 50 56 Z`}
                fill={color}
                opacity="0.7"
            />
        </g>
    );
}

export function CompanionCharacter({ species, color, mood, size = 160, onPoke, bounce, sprite }: Props) {
    // 被摸时飘爱心（SVG/序列帧共用）
    const [hearts, setHearts] = useState<number[]>([]);
    const heartId = useRef(0);
    const handleClick = () => {
        onPoke?.();
        const id = ++heartId.current;
        setHearts(prev => [...prev, id]);
        window.setTimeout(() => setHearts(prev => prev.filter(h => h !== id)), 1100);
    };

    // ⚠️ Hooks 必须无条件调用（React 规则）：眨眼 state/effect 虽然只有
    // SVG 路径用得到，也必须先声明再提前 return。放在 if (sprite) return
    // 之后会导致两个渲染路径的 hooks 数量不一致，切换形态时直接崩。
    const [blinking, setBlinking] = useState(false);
    useEffect(() => {
        // 序列帧模式下不起定时器：图自己的换帧动画在跑，眨眼没有意义
        if (sprite) return;
        let cancelled = false;
        let timer: number;
        const schedule = () => {
            const delay = 2000 + Math.random() * 4000;
            timer = window.setTimeout(() => {
                if (cancelled) return;
                setBlinking(true);
                window.setTimeout(() => { if (!cancelled) setBlinking(false); }, 130);
                schedule();
            }, delay);
        };
        schedule();
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [sprite]);

    // 有序列帧图 → 走图片渲染，SVG 的一切都跳过。
    // 弹跳动画套在外层容器上，图片内部动画（steps 换帧）不受影响。
    if (sprite) {
        return (
            <div
                className="companion-char"
                style={{ width: size, height: size, cursor: onPoke ? "pointer" : "default" }}
                onClick={handleClick}
                role={onPoke ? "button" : undefined}
                aria-label={onPoke ? "摸摸它" : undefined}
            >
                <div className={bounce ? "companion-char-svg is-bounce" : "companion-char-svg"} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <CompanionSprite sheet={sprite} mood={mood} size={Math.round(size * 0.86)} />
                </div>
                {hearts.map(id => (
                    <span key={id} className="companion-heart">💗</span>
                ))}
            </div>
        );
    }

    // ── SVG 兜底路径 ──

    const ears = EAR_PATHS[species];
    const isPlant = species === "plant";
    // 深色版本用于阴影/耳朵内侧，避免再让用户选第二个颜色
    const darkColor = useMemo(() => shade(color, -0.18), [color]);
    const lightColor = useMemo(() => shade(color, 0.22), [color]);

    return (
        <div
            className="companion-char"
            style={{ width: size, height: size, cursor: onPoke ? "pointer" : "default" }}
            onClick={handleClick}
            role={onPoke ? "button" : undefined}
            aria-label={onPoke ? "摸摸它" : undefined}
        >
            <svg
                viewBox="0 0 100 100"
                width={size}
                height={size}
                className={`companion-char-svg${bounce ? " is-bounce" : ""}`}
                aria-hidden="true"
            >
                {/* 呼吸：整体极缓慢缩放。幅度刻意很小（1.5%），
                    大了像在抖动，小了又看不出来——这个值试出来的。 */}
                <g className="companion-breath" style={{ transformOrigin: "50px 70px" }}>
                    {ears && (
                        <g fill={darkColor}>
                            <path d={ears.left} />
                            <path d={ears.right} />
                        </g>
                    )}

                    {/* 身体 */}
                    <path d={BODY_PATHS[species]} fill={color} />
                    {/* 高光：左上角一块浅色，让球体有体积感 */}
                    <ellipse cx="36" cy="36" rx="13" ry="9" fill={lightColor} opacity="0.45" transform="rotate(-20 36 36)" />

                    {isPlant ? (
                        <>
                            <PlantDecoration color={color} mood={mood} />
                            {/* 花盆上的小脸 */}
                            <g transform="translate(0, 12) scale(0.82) translate(11, 0)">
                                {blinking ? (
                                    <g stroke="#2b2b33" strokeWidth="3" strokeLinecap="round">
                                        <line x1="36" y1="52" x2="44" y2="52" />
                                        <line x1="56" y1="52" x2="64" y2="52" />
                                    </g>
                                ) : (
                                    <CompanionEyes mood={mood} />
                                )}
                                <CompanionMouth mood={mood} />
                            </g>
                        </>
                    ) : (
                        <>
                            {blinking ? (
                                // 闭眼：两条短横线。比缩成一条缝更自然。
                                <g stroke="#2b2b33" strokeWidth="3.2" strokeLinecap="round">
                                    <line x1="35.5" y1="52" x2="44.5" y2="52" />
                                    <line x1="55.5" y1="52" x2="64.5" y2="52" />
                                </g>
                            ) : (
                                <CompanionEyes mood={mood} />
                            )}
                            <CompanionMouth mood={mood} />
                            <CompanionBlush mood={mood} />
                        </>
                    )}
                </g>
            </svg>

            {/* 飘出的爱心 */}
            {hearts.map(id => (
                <span key={id} className="companion-heart">💗</span>
            ))}
        </div>
    );
}

/**
 * 调整颜色明度。
 *
 * 自己算而不是引入 color 库：只用到「变深/变浅」这一种操作，
 * 为它加一个依赖不划算。
 */
function shade(hex: string, amount: number): string {
    const normalized = hex.replace("#", "");
    if (normalized.length !== 6) return hex;
    const num = parseInt(normalized, 16);
    if (!Number.isFinite(num)) return hex;

    const r = (num >> 16) & 0xff;
    const g = (num >> 8) & 0xff;
    const b = num & 0xff;

    const adjust = (v: number) => {
        const target = amount > 0 ? 255 : 0;
        const next = Math.round(v + (target - v) * Math.abs(amount));
        return Math.max(0, Math.min(255, next));
    };

    const toHex = (v: number) => v.toString(16).padStart(2, "0");
    return `#${toHex(adjust(r))}${toHex(adjust(g))}${toHex(adjust(b))}`;
}
