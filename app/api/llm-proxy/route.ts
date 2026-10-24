import { NextRequest, NextResponse } from "next/server";

/**
 * LLM 请求的服务端转发出口。
 *
 * 存在的理由：浏览器直连第三方 LLM API 时，对方没开 CORS 就会被浏览器拦掉，
 * 表现为 `failed to fetch`——连 HTTP 状态码都拿不到，用户只能看到一句无意义的
 * 报错。原生 App（如 Operit）不受 CORS 约束，所以在那些软件里同一个地址能用。
 * 这里由服务端代为请求，走服务器出口，CORS 自然不存在。
 *
 * 目前的使用方（刻意保持最小）：
 *   - 设置页的「拉取模型列表」与「测试连接」
 *   - `lib/llm-http.ts` 里 serverProxy 标记的调用（聊天主链路尚未启用）
 *
 * 为什么不直接用 /api/tool-proxy：
 *   那条路由面向 MCP 工具调用，会把响应缓冲后按 JSON 返回，且有 120 秒硬上限；
 *   LLM 需要的是**流式透传**（SSE 边生成边吐字），缓冲会把体验彻底毁掉。
 *   两者的失败语义也不同，混在一起会让排障更困难。
 *
 * 部署注意（Netlify）：免费档函数执行上限约 10 秒。本路由对拉取模型这类
 * 短请求足够；将来若把聊天流式接过来，长回复可能被平台切断，需要在平台侧
 * 调高上限或改用自建服务器。
 */

// 与 tool-proxy 保持一致：给平台一个明确的时长上限。
export const maxDuration = 120;

/** 允许转发的方法。只开 LLM 场景需要的，不开放任意动词。 */
const ALLOWED_METHODS = new Set(["GET", "POST"]);

/** 请求体大小上限。LLM 请求带图片时可能较大，但 20MB 足够覆盖常规用法。 */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

function isPrivateIpv4(host: string): boolean {
    const parts = host.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = parts;
    return a === 0
        || a === 10
        || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127);
}

/**
 * SSRF 防线。
 *
 * 这个路由会把请求发到调用方指定的任意 URL，如果不拦，就等于给外部提供了一个
 * 「探测内网」的跳板（云环境里尤其危险：169.254.169.254 能读到实例凭证）。
 * 校验逻辑与 /api/tool-proxy 同款，保持一致以免两处判断分叉。
 */
function blockedProxyUrlReason(rawUrl: string): string | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return "URL 格式不合法";
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        return "只允许 http/https URL";
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isIpv6Literal = host.includes(":");
    const blocked = host === "localhost"
        || host.endsWith(".localhost")
        || host.endsWith(".local")
        || host.endsWith(".internal")
        || host === "::1"
        || host === "0:0:0:0:0:0:0:1"
        || (isIpv6Literal && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host.startsWith("::ffff:")))
        || isPrivateIpv4(host);
    return blocked ? "不允许代理访问本机或内网地址" : null;
}

/**
 * 转发白名单式地挑请求头。
 *
 * 不能原样透传所有头：`host`、`content-length` 等由运行时自己算，
 * 原样带过去会导致请求失败；而 `authorization` 必须保留（API Key 就在里面）。
 */
function pickForwardHeaders(raw: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    if (!raw || typeof raw !== "object") return result;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        const lower = key.toLowerCase();
        if (lower === "host" || lower === "content-length" || lower === "connection") continue;
        result[key] = value;
    }
    return result;
}

export async function POST(req: NextRequest) {
    let targetUrl = "";

    try {
        const payload = await req.json().catch(() => null);
        if (!payload || typeof payload !== "object") {
            return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
        }

        const { url, method, headers, body } = payload as {
            url?: unknown;
            method?: unknown;
            headers?: unknown;
            body?: unknown;
        };

        if (typeof url !== "string" || !url) {
            return NextResponse.json({ error: "缺少 url" }, { status: 400 });
        }
        targetUrl = url;

        const blockedReason = blockedProxyUrlReason(url);
        if (blockedReason) {
            return NextResponse.json({ error: blockedReason }, { status: 400 });
        }

        const verb = typeof method === "string" ? method.toUpperCase() : "POST";
        if (!ALLOWED_METHODS.has(verb)) {
            return NextResponse.json({ error: `不支持的方法：${verb}` }, { status: 405 });
        }

        const forwardHeaders = pickForwardHeaders(headers);

        // body 可能是字符串（调用方已序列化）或对象；统一转成字符串再发。
        let bodyText: string | undefined;
        if (body !== undefined && body !== null && verb !== "GET") {
            bodyText = typeof body === "string" ? body : JSON.stringify(body);
            if (bodyText && new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
                return NextResponse.json({ error: "请求体过大" }, { status: 413 });
            }
            if (!Object.keys(forwardHeaders).some((k) => k.toLowerCase() === "content-type")) {
                forwardHeaders["Content-Type"] = "application/json";
            }
        }

        // 把浏览器的中断信号转给上游，避免用户点了取消、服务端还在白烧 token。
        const controller = new AbortController();
        const onClientAbort = () => controller.abort();
        req.signal.addEventListener("abort", onClientAbort);

        let upstream: Response;
        try {
            upstream = await fetch(targetUrl, {
                method: verb,
                headers: forwardHeaders,
                body: bodyText,
                signal: controller.signal,
                // 服务端到服务端不需要浏览器的 CORS 参与，这里显式关掉重定向跟随之外的默认行为
                redirect: "follow",
            });
        } finally {
            req.signal.removeEventListener("abort", onClientAbort);
        }

        // 把上游的响应原样交回浏览器。
        //
        // 关键点：这里**必须**把 body 作为流直接返回，不能 await res.text() 再返回。
        // 一旦缓冲，SSE 的「边生成边显示」就退化成「等全部生成完再一次性显示」，
        // 长回复还会因为平台时长上限被整段掐断。
        const responseHeaders = new Headers();
        const contentType = upstream.headers.get("content-type");
        if (contentType) responseHeaders.set("content-type", contentType);
        // 部分服务商用这两个头做限流提示，透传出去便于前端排障。
        for (const name of ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
            const value = upstream.headers.get(name);
            if (value) responseHeaders.set(name, value);
        }
        // 明确告诉浏览器不要缓存：LLM 响应因请求而异，缓存住会拿到别人的结果。
        responseHeaders.set("cache-control", "no-store");

        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 中断是正常路径（用户切页/取消），不要报成错误
        if (message.includes("aborted") || message.includes("AbortError")) {
            return NextResponse.json({ error: "请求已取消" }, { status: 499 });
        }
        // 把上游地址带进错误里：没有它，用户只能看到「failed to fetch」这种
        // 无法行动的信息，排查时得靠猜。
        const host = (() => {
            try {
                return new URL(targetUrl).host;
            } catch {
                return targetUrl;
            }
        })();

        // 把底层 cause 也带出来。Node/undici 的顶层消息经常只有一句
        // 「fetch failed」，真正的原因（DNS 解析失败、TLS 握手失败、
        // 代理连不上）藏在 cause 里。不展开就只能靠猜。
        const cause = (error as { cause?: unknown })?.cause;
        const causeText = cause instanceof Error
            ? cause.message
            : cause ? String(cause) : "";
        const causeCode = (cause as { code?: string } | undefined)?.code;

        // 明确点名「可能是代理」：本地开发时 HTTP(S)_PROXY 一旦指向一个挂掉的
        // 代理，服务端所有出站请求都会失败，而错误信息里完全看不出这一点。
        const proxyHint = (() => {
            const proxy = process.env.https_proxy || process.env.HTTPS_PROXY
                || process.env.http_proxy || process.env.HTTP_PROXY;
            return proxy ? `（当前服务端配置了代理 ${proxy}，若代理不可用会导致此错误）` : "";
        })();

        const detail = [causeText, causeCode].filter(Boolean).join(" / ");
        return NextResponse.json(
            { error: `转发到 ${host} 失败：${message}${detail ? `（${detail}）` : ""}${proxyHint}` },
            { status: 502 },
        );
    }
}
