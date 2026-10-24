import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, fetch as undiciFetch } from "undici";

export const maxDuration = 30;

/**
 * 联网搜索。
 *
 * 为什么需要这个路由：原来的「搜索」内置工具是 directFetch（浏览器直连
 * api.tavily.com）。但 Tavily 的响应里**没有任何 CORS 头**，浏览器请求
 * 必然被拦，报错就是用户看到的 `Failed to fetch`——跟 API key 填没填无关。
 *
 * 服务端转发没有 CORS 限制，key 也不用暴露在前端。
 *
 * key 从哪来：优先读请求里带的（用户在工具箱里填的），
 * 其次读服务端环境变量 TAVILY_API_KEY。两者都没有就返回一句人话提示，
 * 而不是让浏览器抛一个看不懂的 Failed to fetch。
 */

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

function getProxyDispatcher() {
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
        || process.env.http_proxy || process.env.HTTP_PROXY;
    if (!proxyUrl) return undefined;
    return new ProxyAgent(proxyUrl);
}

export async function POST(request: NextRequest) {
    let body: { query?: string; api_key?: string; max_results?: number };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
    }

    const query = (body.query || "").trim();
    if (!query) {
        return NextResponse.json({ error: "缺少搜索关键词 query" }, { status: 400 });
    }

    const apiKey = (body.api_key || "").trim() || (process.env.TAVILY_API_KEY || "").trim();
    if (!apiKey) {
        // 这句提示是给人看的：告诉用户去哪儿填，而不是抛技术错误
        return NextResponse.json({
            error: "还没有配置 Tavily API Key。打开 工具箱 → 搜索 → 参数设置，把 key 填进去（免费额度够日常用）。",
        }, { status: 400 });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
        const res = await undiciFetch(TAVILY_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: apiKey,
                query,
                max_results: Math.min(Math.max(body.max_results ?? 5, 1), 10),
                search_depth: "basic",
            }),
            signal: controller.signal,
            dispatcher: getProxyDispatcher(),
        } as Parameters<typeof undiciFetch>[1]);

        const text = await res.text();
        if (!res.ok) {
            // 把 Tavily 的错误翻成人话，模型和用户都看得懂
            let friendly = `搜索服务返回 ${res.status}`;
            if (res.status === 401 || res.status === 403) {
                friendly = "Tavily API Key 无效或已失效，请到 工具箱 → 搜索 重新填写。";
            } else if (res.status === 429) {
                friendly = "Tavily 免费额度用完了，等额度重置或换一个 key。";
            } else if (res.status >= 500) {
                friendly = "搜索服务暂时不可用，稍后再试。";
            }
            return NextResponse.json({ error: friendly, detail: text.slice(0, 300) }, { status: res.status });
        }

        return new NextResponse(text, {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({
            error: `连不上搜索服务（${msg.includes("abort") ? "超时" : "网络不通"}）。检查网络或代理后再试。`,
        }, { status: 502 });
    } finally {
        clearTimeout(timer);
    }
}
