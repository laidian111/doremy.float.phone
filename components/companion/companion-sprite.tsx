"use client";

/**
 * 图片序列帧宠物——桌宠那种（一张精灵图 + 网格切帧循环播放）。
 *
 * ── 思路来源 ──
 * 网上流行「用一张立绘生成桌宠」的做法：把角色立绘喂给生成工具，
 * 得到一张网格排列的动作帧图（sprite sheet），前端按帧循环切换。
 * 用户给的图3→图4就是这条路：一张 Q 版立绘 → 一张 8 列多行的动作帧网格。
 *
 * ── 为什么用 CSS steps() 而不是 JS setInterval 换 background-position ──
 * 两者都可行，但 steps() 由合成器线程驱动：
 *   - 后台标签页/被冻结时动画自动暂停，回来不会「连跳十几帧追赶」
 *   - 不占 JS 主线程，页面卡顿时动画也不掉帧
 * JS 方案在手机 WebView 上切后台回来经常出现时间补偿跳帧，观感很差。
 *
 * ── 为什么按情绪分帧组 ──
 * 一张 sheet 通常混着好几个动作（待机/跑/跳/害羞……）。
 * 不分组的话循环播放会像抽风。用户在设置里给每种情绪勾帧号，
 * 播放时按宠物当前情绪挑对应的那组循环。
 */

import { useMemo } from "react";
import type { CompanionSpriteSheet } from "@/lib/companion-types";
import type { CompanionMood } from "@/lib/companion-storage";

type Props = {
    sheet: CompanionSpriteSheet;
    mood: CompanionMood;
    /** 显示宽度（px）；高度按帧比例自动算 */
    size?: number;
    className?: string;
};

/** 情绪 → 用户在设置里配置的帧组 key。没配的组按顺序找后备。 */
const MOOD_TO_SHEET_KEY: Record<CompanionMood, string> = {
    happy: "happy",
    content: "idle",
    sleepy: "idle",
    hungry: "idle",
    sad: "sad",
    dirty: "sad",
    sick: "sad",
};

/** 后备链：找不到配置的情绪时按这个顺序降级，最后兜底第一帧。 */
const FALLBACK_ORDER = ["idle", "happy", "sad"];

export function CompanionSprite({ sheet, mood, size = 160, className }: Props) {
    const { frameIndexes, frameMs } = useMemo(() => {
        const key = MOOD_TO_SHEET_KEY[mood];
        const groups = sheet.framesByMood || {};
        // 依次试：当前情绪的组 → 后备链 → 第一帧
        let frames = groups[key];
        if (!frames || frames.length === 0) {
            for (const fb of FALLBACK_ORDER) {
                if (groups[fb]?.length) { frames = groups[fb]; break; }
            }
        }
        if (!frames || frames.length === 0) frames = [0];
        return { frameIndexes: frames, frameMs: sheet.frameMs || 160 };
    }, [sheet, mood]);

    const totalCols = sheet.cols > 0 ? sheet.cols : 1;
    const sheetW = sheet.frameWidth * totalCols;
    // 总行数由用户给的最大帧号推断，避免多存一个 rows 字段
    const maxFrame = Math.max(...frameIndexes, 0);
    const totalRows = Math.max(1, Math.floor(maxFrame / totalCols) + 1);
    const sheetH = sheet.frameHeight * totalRows;

    // 显示尺寸：宽度 = size，高度按单帧宽高比
    const displayW = size;
    const displayH = size * (sheet.frameHeight / sheet.frameWidth);

    // 帧序号 → (x, y) 网格位置；背景位移按显示尺寸等比缩放
    const scale = displayW / sheet.frameWidth;

    // CSS steps 动画：把帧序列展开成 keyframes。
    // 每帧占比 = 1/帧数；位移按帧的网格坐标算。
    const keyframes = useMemo(() => {
        const n = frameIndexes.length;
        if (n <= 1) return "";
        const parts: string[] = [];
        frameIndexes.forEach((frameIdx, i) => {
            const col = frameIdx % totalCols;
            const row = Math.floor(frameIdx / totalCols);
            const x = -col * sheet.frameWidth * scale;
            const y = -row * sheet.frameHeight * scale;
            const pct = (i / n) * 100;
            parts.push(`${pct.toFixed(3)}% { background-position: ${x}px ${y}px; }`);
        });
        // 结尾回到第一帧，保证循环无缝
        const first = frameIndexes[0];
        const fx = -(first % totalCols) * sheet.frameWidth * scale;
        const fy = -Math.floor(first / totalCols) * sheet.frameHeight * scale;
        parts.push(`100% { background-position: ${fx}px ${fy}px; }`);
        return parts.join("\n");
    }, [frameIndexes, totalCols, sheet.frameWidth, sheet.frameHeight, scale]);

    // 唯一动画名：每只宠物 + 情绪一个，避免多个实例互相覆盖 keyframes
    const animName = useMemo(
        () => `comp-spr-${Math.abs(hashString(`${sheet.src}|${frameIndexes.join(",")}`))}`,
        [sheet.src, frameIndexes],
    );

    const firstCol = frameIndexes[0] % totalCols;
    const firstRow = Math.floor(frameIndexes[0] / totalCols);
    const baseX = -firstCol * sheet.frameWidth * scale;
    const baseY = -firstRow * sheet.frameHeight * scale;

    return (
        <div
            className={`companion-sprite${className ? ` ${className}` : ""}`}
            style={{ width: displayW, height: displayH }}
            aria-hidden="true"
        >
            <style>{keyframes ? `@keyframes ${animName} {\n${keyframes}\n}` : ""}</style>
            <div
                style={{
                    width: "100%",
                    height: "100%",
                    backgroundImage: `url("${sheet.src}")`,
                    backgroundSize: `${sheetW * scale}px ${sheetH * scale}px`,
                    backgroundPosition: `${baseX}px ${baseY}px`,
                    backgroundRepeat: "no-repeat",
                    imageRendering: "auto",
                    animation: keyframes ? `${animName} ${frameIndexes.length * frameMs}ms steps(1, end) infinite` : undefined,
                }}
            />
        </div>
    );
}

/** 稳定的字符串哈希（djb2）。给动画名用，避免 crypto 开销。 */
function hashString(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return h;
}
