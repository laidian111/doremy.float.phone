// ── 工坊可调偏好（叶子模块，避免循环依赖）─────────────
// 单页读取字符数：答疑文档翻页、本机内容/创作指南翻页、仓库文件单次读取共用。
// localStorage 键 ai_phone_qa_page_chars 覆盖（调参/测试用）。

export const QA_DEFAULT_PAGE_CHARS = 90_000;
export const QA_PAGE_CHARS_MIN = 2_000;
export const QA_PAGE_CHARS_MAX = 100_000;

export function getQaPageChars(): number {
    try {
        const raw = Number(localStorage.getItem("ai_phone_qa_page_chars"));
        if (Number.isFinite(raw) && raw >= QA_PAGE_CHARS_MIN && raw <= QA_PAGE_CHARS_MAX) return Math.floor(raw);
    } catch {
        // ignore
    }
    return QA_DEFAULT_PAGE_CHARS;
}

/** 设置单页读取字符数（null = 恢复默认） */
export function setQaPageChars(chars: number | null): void {
    try {
        if (chars == null) localStorage.removeItem("ai_phone_qa_page_chars");
        else {
            const clamped = Math.min(QA_PAGE_CHARS_MAX, Math.max(QA_PAGE_CHARS_MIN, Math.floor(chars)));
            localStorage.setItem("ai_phone_qa_page_chars", String(clamped));
        }
    } catch {
        // ignore
    }
}

// 单次最大输出 token（物理护栏）：设置后工坊每次请求带 max_tokens，超长输出被服务端
// 安全截断而不是把连接拖崩；引擎会把该预算写进系统提示，并在截断后自动续接。
// 默认 16000；存 "0" 表示用户显式选择不传该参数（兼容不支持 max_tokens 的模型/中转）。
// localStorage 键 ai_phone_qa_max_output_tokens 覆盖（调参/测试用）。
export const QA_DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
export const QA_MAX_OUTPUT_TOKENS_MIN = 256;
export const QA_MAX_OUTPUT_TOKENS_MAX = 1_000_000;

export function getQaMaxOutputTokens(): number | null {
    try {
        const stored = localStorage.getItem("ai_phone_qa_max_output_tokens");
        if (stored === "0") return null; // 显式不传
        const raw = Number(stored);
        if (Number.isFinite(raw) && raw >= QA_MAX_OUTPUT_TOKENS_MIN && raw <= QA_MAX_OUTPUT_TOKENS_MAX) return Math.floor(raw);
    } catch {
        // ignore
    }
    return QA_DEFAULT_MAX_OUTPUT_TOKENS;
}

/** 设置单次最大输出 token：null = 恢复默认；0 = 显式不传该参数 */
export function setQaMaxOutputTokens(tokens: number | null): void {
    try {
        if (tokens == null) localStorage.removeItem("ai_phone_qa_max_output_tokens");
        else if (tokens === 0) localStorage.setItem("ai_phone_qa_max_output_tokens", "0");
        else {
            const clamped = Math.min(QA_MAX_OUTPUT_TOKENS_MAX, Math.max(QA_MAX_OUTPUT_TOKENS_MIN, Math.floor(tokens)));
            localStorage.setItem("ai_phone_qa_max_output_tokens", String(clamped));
        }
    } catch {
        // ignore
    }
}

// 单轮工具调用上限：一次提问里 agent 最多连续执行多少轮工具，用完提示「回复继续」。
// localStorage 键 ai_phone_qa_max_rounds 覆盖（调参/测试用）。
export const QA_DEFAULT_MAX_ROUNDS = 20;
export const QA_MAX_ROUNDS_MIN = 1;
export const QA_MAX_ROUNDS_MAX = 50;

export function getQaMaxRounds(): number {
    try {
        const raw = Number(localStorage.getItem("ai_phone_qa_max_rounds"));
        if (Number.isFinite(raw) && raw >= QA_MAX_ROUNDS_MIN && raw <= QA_MAX_ROUNDS_MAX) return Math.floor(raw);
    } catch {
        // ignore
    }
    return QA_DEFAULT_MAX_ROUNDS;
}

/** 设置单轮工具调用上限（null = 恢复默认） */
export function setQaMaxRounds(rounds: number | null): void {
    try {
        if (rounds == null) localStorage.removeItem("ai_phone_qa_max_rounds");
        else {
            const clamped = Math.min(QA_MAX_ROUNDS_MAX, Math.max(QA_MAX_ROUNDS_MIN, Math.floor(rounds)));
            localStorage.setItem("ai_phone_qa_max_rounds", String(clamped));
        }
    } catch {
        // ignore
    }
}

// ── 自定义系统提示词（人设覆盖）────────────────────────
// 与小卷的 personaPrompt 同一套语义：留空 = 用内置人设，填了 = 整段替换。
//
// 为什么是「替换」而不是「追加」：用户说「改系统提示词」，要的是能彻底改掉
// 工坊的说话方式与定位。追加式会在原人设后面再叠一段，两段语气打架时模型
// 往往听前面那段，用户会以为设置没生效。
//
// 注意知识库与工具说明**不受影响**：它们由 buildQaSystemPrompt 在调用时
// 另行拼接，人设只占其中第一节。这样用户改人设不会把工坊改瞎（丢掉产品知识）。
export const QA_PERSONA_PROMPT_MAX_CHARS = 20_000;

export function getQaPersonaPrompt(): string {
    try {
        return (localStorage.getItem("ai_phone_qa_persona_prompt") || "").trim();
    } catch {
        return "";
    }
}

/** 设置自定义人设（null 或空白 = 恢复内置默认） */
export function setQaPersonaPrompt(prompt: string | null): void {
    try {
        const trimmed = (prompt || "").trim();
        if (!trimmed) localStorage.removeItem("ai_phone_qa_persona_prompt");
        else localStorage.setItem("ai_phone_qa_persona_prompt", trimmed.slice(0, QA_PERSONA_PROMPT_MAX_CHARS));
    } catch {
        // ignore
    }
}
