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
 *   1. 把文件解析成纯文本
 *   2. 把文本裁剪到可控长度，附在消息里送给模型
 *
 * 解析器选型（都实测过）：
 *   - .docx → JSZip 拆 word/document.xml。jszip 项目里本来就有（备份功能在用），
 *     .docx 本质就是 zip 包，不用引 mammoth（几百 KB）。
 *   - .pdf  → pdfjs-dist，但**动态 import**：它有 300KB+，只有真的发 PDF 时才加载，
 *     不然所有聊天页面的首包都要背上它。
 *   - .txt/.md/.csv/代码 → 纯 UTF-8 读取，带 GBK/UTF-16 编码识别。
 *   - .doc（老版 OLE 二进制）→ 不解析，直接提示另存为 .docx。
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
    | "docx" | "legacy_doc" | "text" | "csv" | "code" | "pdf" | "file";

/** 按扩展名判断这是什么文件，用于选解析方式和渲染图标。 */
export function detectFileKind(fileName: string, mimeType?: string): AttachmentFileKind {
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic"].includes(ext)) return "image";
    if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
    if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
    if (ext === "pdf") return "pdf";
    if (ext === "docx") return "docx";
    // 老版 .doc 是 OLE 复合二进制，不是 zip —— 必须和 .docx 分开，
    // 否则用户会看到「解析失败」的技术报错，而不是「另存为 docx」的建议。
    if (ext === "doc") return "legacy_doc";
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
    return ["docx", "pdf", "text", "csv", "code"].includes(kind);
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
        const bytes = new Uint8Array(await blob.arrayBuffer());

        let text: string;

        // ── 先看 BOM，它能一锤定音 ──
        // BOM 顺序不能乱：FF FE 是 UTF-16LE，FE FF 是 UTF-16BE，
        // 而 UTF-8 的 BOM 是 EF BB BF。先判 BOM 再猜编码，比纯猜可靠得多。
        if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
            text = new TextDecoder("utf-8").decode(bytes.subarray(3));
        } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
            text = new TextDecoder("utf-16le").decode(bytes.subarray(2));
        } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
            text = new TextDecoder("utf-16be").decode(bytes.subarray(2));
        } else {
            // ── 没有 BOM，靠「UTF-8 严格解码能不能过」来判断 ──
            // 为什么必须做这一步：Windows 上大量 .txt 是 GBK 编码，
            // 直接 blob.text() 会把「你好」解成「���」，模型拿到的是一堆
            // 替换字符，等于什么都没读到——而且不会报任何错，最难排查那种。
            try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            } catch {
                // UTF-8 解不了 → 按 GBK 试（覆盖简体中文 Windows 的常见情况）
                try {
                    text = new TextDecoder("gbk").decode(bytes);
                } catch {
                    // 浏览器不支持 gbk 标签时退回宽松 UTF-8（至少不抛异常）
                    text = new TextDecoder("utf-8").decode(bytes);
                }
            }
        }

        if (!text.trim()) {
            return { ok: false, error: "文件是空的", kind };
        }

        // 兜底：解出来大半是替换字符，说明编码还是没猜对。
        // 与其把乱码喂给模型（它会基于乱码瞎编），不如直说读不了。
        const replacementCount = (text.match(/\uFFFD/g) || []).length;
        if (replacementCount > 20 && replacementCount / text.length > 0.1) {
            return {
                ok: false,
                error: "文件编码无法识别（内容读出来是乱码），可以另存为 UTF-8 再发",
                kind,
            };
        }

        return clampExtract(text, kind);
    } catch (err) {
        return { ok: false, error: `读取失败：${err instanceof Error ? err.message : String(err)}`, kind };
    }
}

/**
 * 从 PDF 里提取文字。
 *
 * 用 pdfjs-dist 动态 import：这是个 300KB+ 的库，只有真的发 PDF 时才需要，
 * 静态 import 会让所有聊天页面的首包都背上它。
 *
 * 三个实测过的坑：
 *   1. worker 必须关掉（disableWorker）。默认它想加载 pdf.worker.mjs，
 *      在 Next 的浏览器打包里路径解析不了，会直接抛错。
 *   2. 用 legacy 构建。现代构建依赖一些较新的 API，legacy 更稳。
 *   3. cleanup() 而不是 destroy()。destroy 在这个版本上不存在（实测报错）。
 *
 * 扫描版 PDF（整页是图片）提不出任何文字——这不是 bug，是没有 OCR。
 * 这种情况如实告诉用户，别让模型对着空白内容瞎编。
 */
async function extractPdf(blob: Blob): Promise<AttachmentExtract> {
    try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const doc = await pdfjs.getDocument({
            data: bytes,
            // 关掉 worker：浏览器包里 worker 文件路径解析不了（见上面第 1 点）
            disableWorker: true,
            useSystemFonts: true,
            isEvalSupported: false,
        } as Parameters<typeof pdfjs.getDocument>[0]).promise;

        const pageTexts: string[] = [];
        let totalChars = 0;
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            // items 里既有文字也有排版标记，只取有 str 的
            const pageText = content.items
                .map((item) => ("str" in item ? item.str : ""))
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
            if (pageText) pageTexts.push(pageText);
            totalChars += pageText.length;
            // 够用了就停：继续解析几十页既慢又没必要，反正最后要截断
            if (totalChars > ATTACHMENT_TEXT_MAX_CHARS * 2) break;
        }

        try {
            doc.cleanup();
        } catch {
            // 清理失败不影响结果
        }

        const joined = pageTexts.join("\n\n");
        if (!joined.trim()) {
            return {
                ok: false,
                error: "这个 PDF 提取不到文字（可能是扫描件/图片版），角色只能看到文件名",
                kind: "pdf",
            };
        }
        return clampExtract(joined, "pdf");
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 加密 PDF 是常见情况，单独给一句人话提示
        if (/password|encrypted/i.test(message)) {
            return { ok: false, error: "这个 PDF 有密码保护，读不了内容", kind: "pdf" };
        }
        return { ok: false, error: `PDF 解析失败：${message}`, kind: "pdf" };
    }
}

/**
 * 解析一个文件，得到可以塞进 prompt 的文本。
 *
 * 读不出内容的类型（图片 / 音视频 / 老版 .doc / 未知格式）返回 ok:false，
 * 由调用方决定怎么提示——但**文件本身照常发出去**，不拒发。
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
    if (kind === "pdf") return extractPdf(file);
    if (kind === "text" || kind === "csv" || kind === "code") return extractPlainText(file, kind);
    if (kind === "legacy_doc") {
        // 老版 .doc 是 OLE 复合文档（开头 D0 CF 11 E0），不是 zip，
        // JSZip 拆不动。与其让它「尝试解析然后失败」报一串技术错误，
        // 不如直接说清楚怎么办。
        return {
            ok: false,
            error: "老版 .doc 格式读不了内容，用 Word 另存为 .docx 再发就行",
            kind,
        };
    }
    if (kind === "image") {
        // 图片本身会以视觉消息送进模型，不需要文本提取
        return { ok: false, error: "", kind };
    }
    return { ok: false, error: "这个格式暂时读不了内容，角色只能看到文件名", kind };
}

/** 人类可读的文件大小。 */
export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
