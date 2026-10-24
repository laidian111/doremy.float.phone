"use client";

/**
 * 聊天附件：把用户选的文件变成「角色能读懂的文本」。
 *
 * 存在的理由：这个项目原本只有「工具生成的文件」能出现在聊天里（media_file），
 * 用户自己发不了文件。而「把作业发给角色批改」这种需求，缺的其实不是文件传输——
 * 文件本来就能存在本机 MediaStore 里——缺的是**让模型读到文件内容**。
 * 只把文件名塞进 prompt，角色只会说「我看到你发了个 docx」。
 *
 * 所以这里做两件事：
 *   1. 把文件解析成纯文本（docx 用 JSZip 拆 word/document.xml）
 *   2. 把文本裁剪到可控长度，附在消息里送给模型
 *
 * 为什么不引入 mammoth / pdf.js：项目里已经有 jszip（备份功能在用），
 * 而 .docx 本质就是一个 zip 包，正文在 word/document.xml 里，用现成的
 * 依赖就能拆。多引一个几百 KB 的库只为了这个场景不划算。
 */

import JSZip from "jszip";

/** 单个文件解析后最多送给模型多少字符。 */
export const ATTACHMENT_TEXT_MAX_CHARS = 12_000;
/** 允许上传的单个文件大小上限（字节）。超过的只提示，不解析。 */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** 解析结果：成功带 text，失败带 error（给用户看的原因）。 */
export type AttachmentExtract =
    | { ok: true; text: string; truncated: boolean; kind: string }
    | { ok: false; error: string; kind: string };

/**
 * 文件类别。与 ChatMessage.mediaData.fileType 的取值保持一一对应，
 * 这样 detectFileKind 的返回值可以直接塞进消息，不需要再做一次映射。
 */
export type AttachmentFileKind =
    | "image" | "audio" | "video"
    | "docx" | "text" | "csv" | "code" | "pdf" | "file";

/** 按扩展名判断这是什么文件，用于选解析方式和渲染图标。 */
export function detectFileKind(fileName: string, mimeType?: string): AttachmentFileKind {
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic"].includes(ext)) return "image";
    if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
    if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
    if (ext === "pdf") return "pdf";
    if (["docx", "doc"].includes(ext)) return "docx";
    if (["txt", "md", "markdown", "log"].includes(ext)) return "text";
    if (["csv", "tsv"].includes(ext)) return "csv";
    if (["json", "xml", "yaml", "yml", "html", "htm", "css", "js", "ts", "py", "java", "kt", "c", "cpp", "h", "go", "rs", "sh"].includes(ext)) return "code";
    if (mimeType?.startsWith("image/")) return "image";
    if (mimeType?.startsWith("audio/")) return "audio";
    if (mimeType?.startsWith("video/")) return "video";
    if (mimeType?.startsWith("text/")) return "text";
    return "file";
}

/** 这个类型能不能解析出可读文本。 */
export function isExtractableKind(kind: string): boolean {
    return ["docx", "text", "csv", "code"].includes(kind);
}

/**
 * 从 docx 的 XML 里抠出纯文本。
 *
 * docx 的结构：<w:p> 是段落，<w:t> 是文字片段。直接删标签会把所有段落粘成
 * 一行（「第一段第二段」），角色读起来会以为是一句话。所以先把段落边界换成
 * 换行，再删剩下的标签。
 */
function extractDocxTextFromXml(xml: string): string {
    // ── 表格处理 ──
    // Word 的表格单元格里包着 <w:p>，所以不能简单地把 </w:p> 换成换行：
    // 单元格内的段落换行会先出现，整张表被拆成一行一个词
    // （实测：「姓名 / 分数」被拆成两行，模型读不出这是表头）。
    //
    // 做法：先把每个单元格整体替换成「纯文字 + \u0001 占位」，
    // 段落换行在格内压成空格；随后把占位还原成制表符。
    // 用占位符而不是直接输出 \t，是因为后续的「删标签」和「压缩空白」
    // 两步会把 \t 当成普通空白处理掉（踩过一次）。
    const CELL_MARK = "\u0001";
    let body = xml.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (cell) => {
        const text = cell
            .replace(/<\/w:p>/g, " ")
            .replace(/<w:br\s*\/?>/g, " ")
            .replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/\s+/g, " ")
            .trim();
        return `${text}${CELL_MARK}`;
    });

    body = body
        .replace(/<\/w:tr>/g, "\n")
        // 正文段落
        .replace(/<\/w:p>/g, "\n")
        // 换行符 <w:br/>
        .replace(/<w:br\s*\/?>/g, "\n")
        // 制表符 <w:tab/>
        .replace(/<w:tab\s*\/?>/g, "\t")
        // 其余标签全部删掉（此时正文文字已经露出来了）
        .replace(/<[^>]+>/g, "")
        // XML 实体还原（表格外的部分；表格内已在上面还原过）
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");

    // 还原单元格分隔符：占位符 → 制表符。
    // 只保留「同一行内、不是最后一个」的那个，行尾多余的 tab 去掉。
    body = body
        .replace(new RegExp(`${CELL_MARK}`, "g"), "\t")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    return body;
}

async function extractDocx(blob: Blob): Promise<AttachmentExtract> {
    try {
        const zip = await JSZip.loadAsync(blob);
        const doc = zip.file("word/document.xml");
        if (!doc) {
            return { ok: false, error: "这个 .docx 里找不到正文（可能不是标准 Word 文档）", kind: "docx" };
        }
        const xml = await doc.async("string");
        const text = extractDocxTextFromXml(xml);
        if (!text) {
            return { ok: false, error: "文档里没有可读文字（可能是纯图片或空的）", kind: "docx" };
        }
        return clampExtract(text, "docx");
    } catch (err) {
        return {
            ok: false,
            error: `解析失败：${err instanceof Error ? err.message : String(err)}`,
            kind: "docx",
        };
    }
}

function clampExtract(text: string, kind: string): AttachmentExtract {
    const trimmed = text.trim();
    if (trimmed.length <= ATTACHMENT_TEXT_MAX_CHARS) {
        return { ok: true, text: trimmed, truncated: false, kind };
    }
    // 超长时截断并明确告诉模型「后面还有」——否则角色会以为这就是全文，
    // 对着半截作业给出「已全部批改完毕」这种错误结论。
    return {
        ok: true,
        text: trimmed.slice(0, ATTACHMENT_TEXT_MAX_CHARS),
        truncated: true,
        kind,
    };
}

async function extractPlainText(blob: Blob, kind: string): Promise<AttachmentExtract> {
    try {
        const text = await blob.text();
        if (!text.trim()) {
            return { ok: false, error: "文件是空的", kind };
        }
        return clampExtract(text, kind);
    } catch (err) {
        return { ok: false, error: `读取失败：${err instanceof Error ? err.message : String(err)}`, kind };
    }
}

/**
 * 解析一个文件，得到可以塞进 prompt 的文本。
 *
 * 不支持的类型（pdf / 图片 / 音视频）返回 ok:false，由调用方决定怎么提示。
 * PDF 没做是因为没有现成依赖，硬塞一个 pdf.js 进来（几百 KB）
 * 对当前场景不划算——真需要时可以再加。
 */
export async function extractAttachmentText(file: File): Promise<AttachmentExtract> {
    const kind = detectFileKind(file.name, file.type);
    if (file.size > ATTACHMENT_MAX_BYTES) {
        return {
            ok: false,
            error: `文件太大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB`,
            kind,
        };
    }
    if (kind === "docx") return extractDocx(file);
    if (kind === "text" || kind === "csv" || kind === "code") return extractPlainText(file, kind);
    if (kind === "pdf") {
        return {
            ok: false,
            error: "暂时读不了 PDF 的内容（可以先把文字复制出来发，或另存为 .docx / .txt）",
            kind,
        };
    }
    if (kind === "image") {
        // 图片本身会以视觉消息送进模型，不需要文本提取
        return { ok: false, error: "", kind };
    }
    return { ok: false, error: "这个格式暂时读不了内容，角色只能看到文件名", kind };
}

/**
 * 把解析结果包成给模型看的段落。
 *
 * 格式刻意做成「用户发来一个文件」的叙述，而不是裸文本：模型看到裸文本会
 * 以为用户直接粘贴了这么多字，看到文件描述才知道这是附件、可以整体点评。
 */
export function formatAttachmentForPrompt(params: {
    fileName: string;
    text: string;
    truncated: boolean;
}): string {
    const head = `[用户发来文件：${params.fileName}]`;
    const tail = params.truncated
        ? "\n[注意：文件内容过长，以上只是前面一部分，不是全文。不要声称已读完全部内容。]"
        : `\n[文件结束：${params.fileName}]`;
    return `${head}\n${params.text}${tail}`;
}

/** 人类可读的文件大小。 */
export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
