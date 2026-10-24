export type MusicChatSharePayload = {
    type: "music";
    title: string;
    artist: string;
};

export type XiaohongshuNoteChatSharePayload = {
    type: "xiaohongshu_note";
    authorName: string;
    title: string;
    body: string;
    description?: string;
    noteType: "post" | "video";
    tags?: string[];
    imageAssetId?: string;
    coverIcon?: string;
    tone?: string;
};

/** 通用网页链接分享（知乎/B站/新闻/博客……小红书之外的一切）。 */
export type WebLinkChatSharePayload = {
    type: "web_link";
    url: string;
    title: string;
    description?: string;
    siteName?: string;
    favicon?: string;
};

export type ChatSharePayload = MusicChatSharePayload | XiaohongshuNoteChatSharePayload | WebLinkChatSharePayload;

function compactShareText(value: string | undefined, fallback: string): string {
    const text = (value || "").replace(/\s+/g, " ").trim();
    return text || fallback;
}

export function formatXiaohongshuShareForPrompt(input: {
    author?: string;
    title?: string;
    body?: string;
    description?: string;
}): string {
    const author = compactShareText(input.author, "未知作者");
    const title = compactShareText(input.title, "无标题");
    const body = compactShareText(input.body, "无正文内容");
    const description = compactShareText(input.description, "");
    return `分享了一条小红书帖子，作者：${author}, 标题：${title}, 正文内容：${body}，图片/视频描述：${description || "无"}`;
}

/**
 * 从 URL 里猜站点名，用于卡片上显示「知乎」「B站」这类标签。
 *
 * 为什么不做真正的抓取：抓取要经过服务端代理（CORS + 各家反爬），
 * 失败率高且慢。这里只做「看起来像那么回事」的呈现——用户真正想
 * 让角色知道的其实是标题和链接本身，站点名只是视觉辅助。
 */
export function guessSiteName(url: string): string {
    try {
        const host = new URL(url).hostname.replace(/^www\./, "");
        const known: Record<string, string> = {
            "xiaohongshu.com": "小红书",
            "xhslink.com": "小红书",
            "zhihu.com": "知乎",
            "bilibili.com": "哔哩哔哩",
            "b23.tv": "哔哩哔哩",
            "weibo.com": "微博",
            "douban.com": "豆瓣",
            "jianshu.com": "简书",
            "github.com": "GitHub",
            "youtube.com": "YouTube",
            "twitter.com": "X",
            "x.com": "X",
            "mp.weixin.qq.com": "微信公众号",
            "toutiao.com": "今日头条",
            "baidu.com": "百度",
            "taobao.com": "淘宝",
            "jd.com": "京东",
        };
        for (const [domain, label] of Object.entries(known)) {
            if (host === domain || host.endsWith(`.${domain}`)) return label;
        }
        return host;
    } catch {
        return "网页";
    }
}

export function formatWebLinkForPrompt(input: {
    url?: string;
    title?: string;
    description?: string;
    siteName?: string;
}): string {
    const url = (input.url || "").trim();
    const title = compactShareText(input.title, "无标题");
    const siteName = input.siteName || (url ? guessSiteName(url) : "网页");
    const description = compactShareText(input.description, "");
    const parts = [`分享了一个网页链接`, `站点：${siteName}`, `标题：${title}`];
    if (description) parts.push(`摘要：${description}`);
    if (url) parts.push(`链接：${url}`);
    return parts.join("，");
}

/**
 * 判断一条消息内容是不是「纯链接」——整条消息只有一个 URL（允许前后空白）。
 *
 * 为什么要这个判断：用户从浏览器复制链接直接粘到输入框发送，是最自然的
 * 操作习惯。如果这时仍然发成普通文字气泡，用户会觉得「怎么不是卡片」。
 *
 * 严格限定「整条只有一个链接」：如果消息里还有别的话
 * （比如「你看这个 https://... 挺有意思」），那就该是普通文字消息——
 * 那种情况硬转成卡片会把用户写的话吞掉。
 */
export function parseBareLinkMessage(text: string): { url: string } | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    // 整条消息必须就是一个 URL，不接受多余文字
    const match = trimmed.match(/^(https?:\/\/[^\s]+)$/i);
    if (!match) return null;
    const url = match[1];
    try {
        const parsed = new URL(url);
        // 只有域名没有路径也算（比如 https://example.com）——那是有效分享
        return parsed.protocol === "http:" || parsed.protocol === "https:"
            ? { url }
            : null;
    } catch {
        return null;
    }
}

/** 从消息文本里抽出任意链接时用的正则（供未来扩展）。 */
export const ANY_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
