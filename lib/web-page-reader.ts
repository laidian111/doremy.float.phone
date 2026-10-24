"use client";

/**
 * 抓取网页正文，供角色「看」网页内容。
 *
 * 为什么需要这个模块：项目原有的「查看网页」内置工具只依赖 r.jina.ai——
 * 一个海外服务。实测在大陆网络下：直连 20 秒超时，走代理返回 451
 * （Jina 对部分 IP 直接拒绝）。结果就是这个工具对用户完全不可用，
 * 角色会反复报「打不开」，然后开始编造内容。
 *
 * 所以改成两级策略：
 *   1. 先试**直连**抓页面 HTML，自己抽正文（绝大多数中文站点都行）
 *   2. 直连失败才回退到 Jina（有海外网络时它质量更好）
 *
 * 为什么不直接在服务端抓：这个 app 是本地优先的，用户可能压根没有
 * 可用的服务端（纯静态部署）。直连走浏览器 fetch，配合已有的
 * /api/tool-proxy 处理 CORS，覆盖面最广。
 */

/** 抓取结果。失败时 error 是给用户/模型看的**人话**，不是技术堆栈。 */
export type WebPageFetchResult =
    | { ok: true; text: string; title: string; url: string; source: "direct" | "jina" }
    | { ok: false; error: string; url: string };

const FETCH_TIMEOUT_MS = 12_000;
/** 抽出来的正文上限。给模型看的内容太长没意义，还会挤爆上下文。 */
const MAX_CONTENT_CHARS = 6_000;

/** 从 HTML 里剥出可读正文。 */
export function extractReadableText(html: string): { title: string; text: string } {
    // 标题
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";

    let body = html;
    // 先整体删掉这些标签的**内容**（不只是标签），否则 CSS/JS 会全变成正文
    body = body
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<head[\s\S]*?<\/head>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ");

    // 块级元素边界 → 换行，保住段落结构（和 docx 解析同样的道理：
    // 直接删标签会把所有段落粘成一行）
    body = body
        .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        // 单元格用占位符而不是直接 \t：后面的空白压缩会把 \t 当普通空格吃掉
        .replace(/<\/(td|th)>/gi, "\u0001");

    // 剩下的标签全删
    body = body.replace(/<[^>]+>/g, " ");

    // 实体还原
    body = decodeHtmlEntities(body);

    // 压空白：行内多空格合成一个，连续空行压成最多两个。
    // 最后再把单元格占位符还原成制表符。
    body = body
        .replace(/[ \t\u00a0]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\u0001/g, "\t")
        .trim();

    return { title, text: body };
}

function decodeHtmlEntities(text: string): string {
    const named: Record<string, string> = {
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
        mdash: "—", ndash: "–", hellip: "…", ldquo: "“", rdquo: "”",
        lsquo: "‘", rsquo: "’", middot: "·",
    };
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            const code = parseInt(hex, 16);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
        })
        .replace(/&#(\d+);/g, (_, dec) => {
            const code = Number(dec);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
        })
        .replace(/&([a-z]+);/gi, (match, name) => named[String(name).toLowerCase()] ?? match);
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 抓取并抽取网页正文。
 *
 * 顺序很重要：直连优先。Jina 在部分网络下要么超时要么 451，
 * 把它放在前面会让「能直连的页面也失败」。
 */
export async function fetchWebPageText(rawUrl: string): Promise<WebPageFetchResult> {
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

    // ── 第一级：直连抓 HTML ──
    try {
        // 走项目自己的 tool-proxy：浏览器直连外站会被 CORS 拦，
        // 这个路由已经在处理转发（且带 SSRF 防线）
        const proxyUrl = `/api/tool-proxy?url=${encodeURIComponent(url)}`;
        const res = await fetchWithTimeout(proxyUrl, {
            method: "GET",
            headers: { Accept: "text/html,application/xhtml+xml" },
        });
        if (res.ok) {
            const html = await res.text();
            const { title, text } = extractReadableText(html);
            if (text.length >= 80) {
                return {
                    ok: true,
                    title: title || url,
                    text: text.slice(0, MAX_CONTENT_CHARS),
                    url,
                    source: "direct",
                };
            }
            // 正文太短：多半是纯 JS 渲染的页面（小红书/知乎这类），
            // 直连拿到的是空壳，继续往下试 Jina
        }
    } catch {
        // 直连失败，走下一级
    }

    // ── 第二级：Jina Reader（海外服务，有网时质量更好）──
    try {
        const res = await fetchWithTimeout(
            `/api/tool-proxy?url=${encodeURIComponent(`https://r.jina.ai/${url}`)}`,
            { method: "GET", headers: { Accept: "text/plain" } },
        );
        if (res.ok) {
            const text = (await res.text()).trim();
            if (text.length >= 80) {
                return {
                    ok: true,
                    title: url,
                    text: text.slice(0, MAX_CONTENT_CHARS),
                    url,
                    source: "jina",
                };
            }
        }
    } catch {
        // 两条路都失败
    }

    return {
        ok: false,
        url,
        // 这句提示很关键：模型看到具体原因才不会说「我网络坏了」然后编造内容
        error: "这个网页抓不到正文（可能是需要登录、纯图片、或者网络不通）。如果用户能贴一段文字或截个图，就能继续。",
    };
}
