import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

export const maxDuration = 60;

/**
 * 读取网页正文。
 *
 * 为什么需要这个路由：项目原有的「查看网页」内置工具只依赖 r.jina.ai，
 * 实测在大陆网络下直连 20 秒超时、走代理返回 451（Jina 拒绝该 IP），
 * 工具对用户完全不可用，角色只能反复报「打不开」然后开始编造内容。
 *
 * 这里的策略是**直连优先、Jina 兜底**：
 *   1. 服务端直接抓目标页面（服务端没有 CORS 限制，比浏览器直连可靠）
 *   2. 自己抽正文，不依赖任何第三方服务
 *   3. 只有直连拿不到正文时，才试 Jina（有海外网络时它渲染 JS 页面更强）
 *
 * 放在服务端而不是浏览器：浏览器直连外站会被 CORS 拦，绕不开；
 * 服务端抓取是唯一稳的路子。
 */

const FETCH_TIMEOUT_MS = 12_000;
const MAX_CONTENT_CHARS = 8_000;

function getProxyDispatcher(): Dispatcher | undefined {
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
        || process.env.http_proxy || process.env.HTTP_PROXY;
    if (!proxyUrl) return undefined;
    return new ProxyAgent(proxyUrl);
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

function extractReadableText(html: string): { title: string; text: string } {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";

    let body = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<head[\s\S]*?<\/head>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ");

    body = body
        .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        // 占位符保 tab，避免被后面的空白压缩吃掉
        .replace(/<\/(td|th)>/gi, "\u0001")
        .replace(/<[^>]+>/g, " ");

    body = decodeHtmlEntities(body);

    return {
        title,
        text: body
            .replace(/[ \t\u00a0]+/g, " ")
            .replace(/ *\n */g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/\u0001/g, "\t")
            .trim(),
    };
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await undiciFetch(url, {
            ...init,
            signal: controller.signal,
            dispatcher: getProxyDispatcher(),
        } as Parameters<typeof undiciFetch>[1]);
    } finally {
        clearTimeout(timer);
    }
}

export async function GET(request: NextRequest) {
    const rawUrl = request.nextUrl.searchParams.get("url") || "";
    if (!rawUrl) {
        return NextResponse.json({ error: "缺少 url 参数" }, { status: 400 });
    }
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return NextResponse.json({ error: "URL 格式不合法" }, { status: 400 });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return NextResponse.json({ error: "只允许 http/https" }, { status: 400 });
    }

    // ── 第一级：直连抓 HTML ──
    try {
        const res = await fetchWithTimeout(url, {
            headers: {
                // 有些站点对无 UA 的请求直接返回空页
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
            redirect: "follow",
        });
        if (res.ok) {
            const html = await res.text();
            const { title, text } = extractReadableText(html);
            if (text.length >= 80) {
                return NextResponse.json({
                    title: title || url,
                    url,
                    text: text.slice(0, MAX_CONTENT_CHARS),
                    source: "direct",
                });
            }
        }
    } catch {
        // 直连失败，继续试 Jina
    }

    // ── 第二级：Jina Reader 兜底（能渲染 JS 页面，但海外服务不一定可达）──
    try {
        const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, {
            headers: { Accept: "text/plain" },
        });
        if (res.ok) {
            const text = (await res.text()).trim();
            if (text.length >= 80) {
                return NextResponse.json({
                    title: url,
                    url,
                    text: text.slice(0, MAX_CONTENT_CHARS),
                    source: "jina",
                });
            }
        }
    } catch {
        // 两级都失败
    }

    return NextResponse.json({
        error: "抓不到这个网页的正文（可能需要登录、是纯图片/视频页面，或者网络不通）。可以让用户贴一段文字或截图，你就能继续。",
        url,
    }, { status: 502 });
}
