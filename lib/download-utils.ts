export type DownloadFileOptions = {
    disableNativeShare?: boolean;
    nativeShareOnly?: boolean;
};

/** android-shell 壳的 WebView UA 后缀标识（见 MainActivity.kt 的 userAgentString 拼接）。 */
const FLOAT_SHELL_UA_MARK = "FloatShell/";

/** 壳暴露的原生桥（能力按需特性检测，非壳环境为 undefined）。 */
type FloatShellBridge = {
    saveBase64File?: (fileName: string, base64: string) => boolean;
    openUrl?: (url: string) => boolean;
    launchExternalApp?: (packageName: string, dataUrl: string) => boolean;
    /** 直链交给系统下载管理器（真后台）；返回是否成功入队 */
    downloadUrl?: (url: string, fileName: string) => boolean;
    /** 分块导出：开始会话，返回 token（空串 = 失败） */
    beginFileChunked?: (fileName: string) => string;
    /** 分块导出：追加一块 base64 */
    appendFileChunk?: (token: string, base64: string) => boolean;
    /** 分块导出：收尾并让文件在「下载」目录可见 */
    finishFileChunked?: (token: string) => boolean;
    /** 分块导出：中止并删除半成品 */
    abortFileChunked?: (token: string) => boolean;
};

function readFloatShellBridge(): FloatShellBridge | null {
    if (typeof window === "undefined" || typeof navigator === "undefined") return null;
    if (!navigator.userAgent.includes(FLOAT_SHELL_UA_MARK)) return null;
    return (window as unknown as { AndroidShell?: FloatShellBridge }).AndroidShell ?? null;
}

/** 是否运行在 android-shell 壳内（普通浏览器/iOS 均为 false）。 */
export function isFloatShell(): boolean {
    return readFloatShellBridge() !== null;
}

/**
 * 用壳的桥能力打开外部 App / URL（桌宠联动）。
 * 优先按自定义 scheme 走 ACTION_VIEW（对方声明了 intent-filter 即可，不要求正在运行），
 * 失败时退回按包名唤起。非壳环境返回 false，调用方自行兜底。
 */
export function openInFloatShell(url: string, packageName?: string): boolean {
    const bridge = readFloatShellBridge();
    if (!bridge) return false;
    const direct = bridge.openUrl;
    if (direct) {
        try {
            if (direct(url)) return true;
        } catch {
            // 落到包名唤起
        }
    }
    if (packageName && bridge.launchExternalApp) {
        try {
            return bridge.launchExternalApp(packageName, url);
        } catch {
            return false;
        }
    }
    return false;
}

export function isAndroidBrowser(): boolean {
    return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

export function isIOSBrowser(): boolean {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    return /iPad|iPhone|iPod/i.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * 分块导出时每次读取的字节数。
 *
 * 为什么是 256KB：base64 后膨胀到约 341KB，离 Android Binder 事务上限（约 1MB）
 * 还有三倍余量。调大到 512KB 时 base64 已 683KB，加上字符串与 JNI 开销就贴近
 * 上限了；调小则往返次数变多、导出变慢。256KB 是这两者之间的稳妥值。
 */
const CHUNK_BYTES = 256 * 1024;

/** Blob 的一个分片 → 纯 base64（去 data URL 前缀），供分块桥使用。 */
function chunkToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || "");
            const comma = result.indexOf(",");
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error("读取分片内容失败"));
        reader.readAsDataURL(blob);
    });
}

/**
 * 用分块桥把大文件写进壳的「下载」目录。
 *
 * 这是导出备份的主路径。原先的做法是把整个 zip 转成一个 base64 字符串塞给
 * saveBase64File——Android 的 Binder 事务上限约 1MB，备份稍大就抛
 * TransactionTooLargeException，而原生侧 runCatching 把它吞成 false，
 * 网页只能看到「失败」，实际表现是「点了导出没反应」。
 *
 * 这里逐块传输：任意时刻跨桥的数据都在 CHUNK_BYTES 量级，与文件总大小无关。
 * 失败一定会 abort，避免在「下载」目录留下半成品。
 *
 * @returns true = 已完整写入；false = 壳不支持分块桥或中途失败（调用方走兜底）
 */
async function saveViaChunkedBridge(blob: Blob, filename: string): Promise<boolean> {
    const shell = readFloatShellBridge();
    if (!shell?.beginFileChunked || !shell.appendFileChunk
        || !shell.finishFileChunked || !shell.abortFileChunked) {
        return false;
    }

    let token = "";
    try {
        token = shell.beginFileChunked(filename);
        if (!token) return false;

        for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
            const slice = blob.slice(offset, Math.min(offset + CHUNK_BYTES, blob.size));
            const base64 = await chunkToBase64(slice);
            if (!shell.appendFileChunk(token, base64)) {
                shell.abortFileChunked(token);
                return false;
            }
        }

        if (!shell.finishFileChunked(token)) {
            shell.abortFileChunked(token);
            return false;
        }
        return true;
    } catch {
        if (token) {
            try {
                shell.abortFileChunked(token);
            } catch {
                // 中止本身失败也没有更好的补救手段，交给调用方兜底
            }
        }
        return false;
    }
}

export async function downloadFile(blob: Blob, filename: string, options: DownloadFileOptions = {}): Promise<void> {
    const url = URL.createObjectURL(blob);
    const anchorDownload = () => {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    };

    const shouldUseNativeShare = options.nativeShareOnly || (!options.disableNativeShare && isIOSBrowser());
    if (shouldUseNativeShare) {
        const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
        const canNativeShare = typeof navigator !== "undefined"
            && typeof navigator.share === "function"
            && typeof navigator.canShare === "function"
            && navigator.canShare({ files: [file] });
        if (canNativeShare) {
            try {
                await navigator.share({ files: [file] });
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return;
            } catch (err) {
                // User explicitly dismissed the share sheet → respect it, don't force a download.
                if (err instanceof DOMException && err.name === "AbortError") {
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    return;
                }
                // Any other failure (webview without real file-share support, lost user
                // activation, etc.) is surfaced to the caller on iOS instead of opening
                // the blob URL, which can navigate away from the app.
            }
        }
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        throw new Error("当前浏览器没有成功打开系统分享，请在 Safari 中重试，或导出轻量备份后再试。");
    }

    // 壳环境：blob: + a[download] 在 WebView 里不会落盘（DownloadManager 取不到内存地址），
    // 必须交给壳写进公共「下载」目录。
    //
    // 一律走分块路径，**不再按大小分流**。原先的「小文件走 saveBase64File、
    // 大文件走分块」看起来更省事，实际留了两个坑：
    //   1. 分界点附近的行为不一致，出问题时现象随文件大小漂移，极难复现；
    //   2. 整包直传哪怕只有 300KB，base64 后也接近 Binder 上限的一半，
    //      再叠加字符串与 JNI 开销就可能抛 TransactionTooLargeException，
    //      而原生侧 runCatching 会把它吞成 false —— 用户看到的就是「点了没反应」。
    // 分块的代价只是多几次往返，换来的是与文件大小完全无关的稳定性，值得。
    const shell = readFloatShellBridge();
    if (shell) {
        if (typeof shell.beginFileChunked === "function") {
            if (await saveViaChunkedBridge(blob, filename)) {
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return;
            }
            // 分块失败是硬错误，不能再悄悄退回浏览器下载：WebView 里
            // a[download] 对 blob: 完全无效，用户只会看到「点了没反应」，
            // 而根本不知道出了什么事。抛出去让调用方显示明确原因。
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            throw new Error("导出失败：无法写入手机「下载」目录。请检查存储空间，或确认 App 是最新版本。");
        }
        // 老版本壳没有分块接口，只能退回整包直传；同样不再静默失败。
        if (shell.saveBase64File) {
            try {
                const base64 = await blobToBase64(blob);
                if (shell.saveBase64File(filename, base64)) {
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    return;
                }
            } catch {
                // 落到下面的统一报错
            }
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            throw new Error("导出失败：当前 App 版本不支持大文件导出，请更新到最新版 APK。");
        }
    }

    // 真正在浏览器里（非壳环境）才用浏览器下载。
    anchorDownload();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Blob → 纯 base64（去掉 data URL 前缀），供壳的 saveBase64File 使用。 */
function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || "");
            const comma = result.indexOf(",");
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error("读取文件内容失败"));
        reader.readAsDataURL(blob);
    });
}

/**
 * 把 http(s) 直链交给壳的系统下载管理器（DownloadManager）：系统托管，
 * 切后台、锁屏、退出 App 都会继续下载，完成后通知栏提示。
 * 非壳环境、非直链、或入队失败时返回 false，由调用方走原有兜底路径。
 */
export function downloadUrlInFloatShell(url: string, filename: string): boolean {
    const bridge = readFloatShellBridge();
    if (!bridge?.downloadUrl) return false;
    if (!/^https?:\/\//i.test(url)) return false;
    try {
        return bridge.downloadUrl(url, filename);
    } catch {
        return false;
    }
}

/** 把站内相对地址补成绝对地址（壳的原生下载器拿不到页面 base，必须给完整 URL）。 */
function toAbsoluteUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    try {
        return new URL(url, window.location.href).href;
    } catch {
        return url;
    }
}

export async function downloadUrl(url: string, filename: string): Promise<void> {
    // 直链优先走壳的原生下载：页面里的 fetch→blob 一旦进后台就被暂停，
    // 交给系统下载器才能真正「离开界面继续下」。
    if (downloadUrlInFloatShell(toAbsoluteUrl(url), filename)) return;

    let blob: Blob | null = null;

    try {
        const res = await fetch(url);
        if (res.ok) blob = await res.blob();
    } catch { /* CORS or network error — try proxy */ }

    if (!blob && /^https?:\/\//.test(url)) {
        try {
            const res = await fetch("/api/tool-proxy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url, method: "GET" }),
            });
            if (res.ok) blob = await res.blob();
        } catch { /* proxy also failed */ }
    }

    if (blob) {
        await downloadFile(blob, filename);
    } else {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
}
