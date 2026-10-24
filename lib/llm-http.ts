// lib/llm-http.ts
// LLM 请求的统一 fetch 出口。所有走 buildProviderRequest 的调用点统一经它发请求：
//  - serverProxy 标记：改发本站 /api/llm-proxy，由服务端转发。
//    第三方 API 大多不给浏览器发 CORS 头，直连会被浏览器拦掉，而且拦截时
//    连 HTTP 状态码都拿不到，用户只能看到一句 `failed to fetch`。
//    走服务端出口就没有跨域问题，API Key 也不会出现在浏览器网络面板里。
//  - 无标记：浏览器直连（用户明确选了「浏览器直连」时）。
//
// 标记由 buildProviderRequest 统一注入，见 lib/llm-provider-adapter.ts。
// 那个函数是全项目 LLM 请求的唯一构造入口，在这里注入才能保证「聊天、群聊、
// 朋友圈、手记、剧情、桌宠、答疑、离线兜底」一处不落。

import type { LlmRequestPayload } from "./llm-provider-adapter";

export type FetchLlmPayloadOptions = {
    signal?: AbortSignal;
};

export function fetchLlmPayload(
    payload: LlmRequestPayload,
    options: FetchLlmPayloadOptions = {},
): Promise<Response> {
    const bodyText = JSON.stringify(payload.body);
    if (payload.serverProxy) {
        return fetch("/api/llm-proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: payload.url,
                // LLM 请求一律 POST，这里显式带上，避免代理侧靠默认值猜
                method: "POST",
                headers: payload.headers,
                body: bodyText,
            }),
            signal: options.signal,
        });
    }
    return fetch(payload.url, {
        method: "POST",
        headers: payload.headers,
        body: bodyText,
        signal: options.signal,
    });
}
