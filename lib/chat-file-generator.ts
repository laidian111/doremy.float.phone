"use client";

/**
 * 把纯文本打包成 .docx 文件。
 *
 * 为什么需要：角色要「批改作业后发回给我」，但模型只能输出文字。
 * 现有的「发送文件」工具只接受一个 URL——角色没有服务器，生成不出 URL。
 * 所以这里补上从「文字」到「文件」这一步：模型给内容，前端打包成真正的
 * Word 文档，存进 MediaStore，再走已有的 mediaAttachments 通道发出去。
 *
 * 为什么自己拼 XML 而不是引一个生成库：.docx 就是一个 zip，只要塞进
 * 最小可用的 OOXML 骨架，Word/WPS 就能正常打开。引 docx 之类的库
 * （几百 KB）只为了这一件事不划算——项目里已经有 jszip 了。
 */

import JSZip from "jszip";

/** XML 里必须转义的字符。不转义会直接产出损坏的文档。 */
function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
        // XML 1.0 不允许的控制字符（除了 \t \n \r），留着会让 Word 报文件损坏
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** 一行文字 → 一个 <w:p> 段落。 */
function paragraphXml(line: string): string {
    // 空行也要占一个段落，否则段间距会塌掉
    if (!line.trim()) return "<w:p/>";
    return [
        "<w:p><w:r><w:t xml:space=\"preserve\">",
        escapeXml(line),
        "</w:t></w:r></w:p>",
    ].join("");
}

/**
 * 纯文本 → .docx（Blob）。
 *
 * 骨架是最小可用的 OOXML：docProps 两个 + 一个 document.xml。
 * 少了 [Content_Types].xml 或 _rels/.rels，Word 会拒绝打开。
 */
export async function textToDocxBlob(text: string): Promise<Blob> {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const body = lines.map(paragraphXml).join("");

    const documentXml = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        "<w:body>",
        body,
        // 末尾这一节让页面尺寸正常（A4），不加的话某些阅读器会用奇怪默认值
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
        "</w:body></w:document>",
    ].join("");

    const contentTypes = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        "</Types>",
    ].join("");

    const rootRels = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
        "</Relationships>",
    ].join("");

    const zip = new JSZip();
    zip.file("[Content_Types].xml", contentTypes);
    zip.folder("_rels")!.file(".rels", rootRels);
    zip.folder("word")!.file("document.xml", documentXml);

    return zip.generateAsync({
        type: "blob",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
}

/** 纯文本 → Blob（带 UTF-8 BOM）。 */
export function textToTxtBlob(text: string): Blob {
    // 加 BOM：Windows 记事本打开不带 BOM 的 UTF-8 文件时可能认成 GBK，
    // 中文全变乱码。加了这个三个字节能省掉用户一次困惑。
    return new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" });
}

/** 纯文本 → Markdown Blob。 */
export function textToMarkdownBlob(text: string): Blob {
    return new Blob([text], { type: "text/markdown;charset=utf-8" });
}

export type GeneratedFileFormat = "docx" | "txt" | "md";

/**
 * 按格式把文本打包成文件。
 *
 * 返回的 mimeType 会跟着 Blob 一起进 MediaStore，
 * 下载时浏览器据此决定打开方式。
 */
export async function buildGeneratedFile(
    text: string,
    format: GeneratedFileFormat,
): Promise<{ blob: Blob; fileName: string }> {
    switch (format) {
        case "docx":
            return { blob: await textToDocxBlob(text), fileName: "" };
        case "md":
            return { blob: textToMarkdownBlob(text), fileName: "" };
        case "txt":
        default:
            return { blob: textToTxtBlob(text), fileName: "" };
    }
}

/** 给文件名补上扩展名（角色可能给了个不带后缀的名字）。 */
export function ensureFileExtension(fileName: string, format: GeneratedFileFormat): string {
    const trimmed = (fileName || "").trim() || "文件";
    const ext = `.${format}`;
    if (trimmed.toLowerCase().endsWith(ext)) return trimmed;
    // 已经有别的扩展名就先剥掉，避免出现「批改.docx.txt」
    return `${trimmed.replace(/\.(docx?|txt|md|markdown)$/i, "")}${ext}`;
}
