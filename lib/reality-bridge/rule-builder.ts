// lib/reality-bridge/rule-builder.ts
//
// 用大白话生成联动规则。
//
// 存在的理由：现实桥的自定义能力已经够强（定时、安静时段、工作日限定、
// 随机浮动、每日上限、各类动作），但**配置成本全压在用户身上**——要理解
// 「信号名」「加工模式」「动作」「触发间隔」这一整套概念，才知道该怎么填。
// 用户心里想的是「我想八点收到一条角色消息」，而不是「我要建一条 daily
// 定时规则、process.mode=template、actions.chat.role=system」。
//
// 所以这一层做的事是：把一句人话翻译成上面那套结构。翻译完**不直接落库**，
// 而是交给用户过目确认——AI 理解错的时候，用户能一眼看出「我要八点它给了
// 十点」，比事后发现规则不生效好得多。

import { simpleLLMCall } from "../api-helpers";
import { loadApiConfigs, resolveAuxiliaryApiConfig } from "../settings-storage";
import { loadCharacters } from "../character-storage";
import type { ApiConfig } from "../settings-types";
import type { BridgeRule } from "./types";

/** AI 返回的规则草案：规则本体 + 给人看的解释。 */
export type RuleDraft = {
  /** 生成好的规则；null = AI 认为这句话配不出规则 */
  rule: BridgeRule | null;
  /** 一句话说明这条规则会怎么工作（给用户确认用） */
  explanation: string;
  /** 需要用户补充的信息（如没指定角色、时间不明确） */
  questions?: string[];
};

/** 本机感知能产生的信号名。写进提示词让模型只能从中挑，避免它编造不存在的事件。 */
export const KNOWN_SIGNAL_TYPES = [
  "电量偏低",
  "充电开始",
  "充电结束",
  "离开 WiFi",
  "连上 WiFi",
  "长时间使用",
  "应用用太久",
  "深夜还醒着",
  "今天第一次打开",
  "很久没聊天",
  "久坐不动",
  "到达新位置",
  "睡醒了",
  "回到手机",
] as const;

const SYSTEM_PROMPT = `你是「现实桥」的规则配置助手。用户会用大白话描述想要的效果，你把它翻译成一条联动规则。

## 你可以配置的东西

**触发方式（二选一）**

1. 定时触发 schedule —— 到点自动执行，不需要任何信号
   - { kind: "daily", time: "HH:MM", weekdays?: [0-6] }  每天/指定星期
     weekdays 数组：0=周日 1=周一 … 6=周六。工作日是 [1,2,3,4,5]，周末是 [0,6]。不填=每天。
   - { kind: "weekly", time: "HH:MM", weekday: 0-6 }  每周某天
   - { kind: "interval", minutes: 数字 }  每隔多少分钟

2. 信号触发 matchType —— 手机状态变化时执行
   可用的信号名只有这些，不要编造：
   ${KNOWN_SIGNAL_TYPES.join("、")}
   另外可以用 "*" 表示任意信号，或用 payloadFilter 按正文关键词过滤。

**动作 actions（可以同时多个）**

- chat: { characterId: "角色id", role: "system"|"assistant"|"user", requestReply: true }
  写进与某角色的聊天。role="system" 表示以旁白/系统提示的形式让角色自己开口（最常用，角色会用自己的语气说话）；
  role="assistant" 表示直接以角色身份说固定的话；role="user" 表示模拟用户说的话。
  requestReply=true 会让角色接着回复。
- memory: { characterId, type: "long_term"|"core" }  写入角色记忆
- notify: true  弹系统通知
- deviceAction: { action: "动作名" }  直接操作手机（手电筒、音量等）
- tool: { name: "工具名" }  调用工具箱里的工具

**加工方式 process**
- { mode: "raw" }  原样使用信号内容（定时规则用它，配合下面 template 更好）
- { mode: "template", template: "文本" }  模板，可用 {payload} {type} 占位
  定时规则没有真实信号，template 写一句给角色的旁白提示最合适。
- { mode: "ai", prompt: "提示词" }  让 AI 先处理信号内容再交给动作

**其他可调项**
- quietHours: { enabled: true, start: "23:00", end: "08:00" }  安静时段（不填=跟随全局设置）
- jitterMinutes: 数字  随机浮动分钟数，让触发不像闹钟
- dailyLimit: 数字  每天最多执行几次
- cooldownMinutes: 数字  两次触发之间至少隔多少分钟

## 重要规则

1. **定时类请求**：用户说「八点」「每天早上」「睡前」这类，用 schedule。
   角色的主动消息通常要 role="system" + process.mode="template"，template 写成
   一句给角色的旁白提示（用括号包起来，如「（现在是早上，主动跟用户说声早安吧）」），
   这样角色会用自己的语气组织语言，每次说法不同，比写死台词自然。

2. **状态类请求**：用户说「电量低的时候」「我回来的时候」，用 matchType。

3. **不要编造**：信号名只能从上面列表里挑。用户描述的触发条件如果对应不上任何
   现有信号，就在 questions 里说明，不要硬凑一个不存在的信号名。

4. **没指定角色时**：如果用户没说找哪个角色，且只有一个角色，就用它；
   有多个角色时在 questions 里问清楚，rule 仍然返回但 characterId 留空。

5. 用户没提到的项不要瞎设。quietHours、jitterMinutes、dailyLimit 这些
   只在用户明确要求时才填。

## 输出格式

只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：

{
  "rule": {
    "name": "规则的简短名字",
    "matchType": "",
    "schedule": { "kind": "daily", "time": "08:00" },
    "process": { "mode": "template", "template": "（旁白提示）" },
    "actions": { "chat": { "characterId": "id", "role": "system", "requestReply": true } },
    "cooldownMinutes": 0,
    "quietHours": null,
    "jitterMinutes": 0,
    "dailyLimit": 0
  },
  "explanation": "一句话说明这条规则会怎么工作",
  "questions": ["需要用户补充的问题"]
}

不需要的字段直接省略或给 null/0。如果完全配不出来，rule 给 null 并在 explanation 里说明原因。`;

/** 找到能用的 API 配置：优先辅助配置，退到第一个。 */
function resolveConfig(): ApiConfig | null {
  const aux = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
  if (aux) return aux;
  const all = loadApiConfigs();
  return all.length > 0 ? all[0] : null;
}

/** 把模型返回的 JSON 抠出来（模型常带 ```json 包裹或前后废话）。 */
function extractJson(raw: string): unknown {
  const text = raw.trim();
  // 先试直接解析
  try {
    return JSON.parse(text);
  } catch {
    // 抠第一个 { 到最后一个 }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function clampNumber(value: unknown, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

/**
 * 把模型给的松散对象收敛成合法 BridgeRule。
 *
 * 为什么要逐字段校验而不是直接 `as BridgeRule`：模型会给出 `"time": "8点"`
 * 这种看起来对、实际跑不起来的字段。直接塞进存储会让规则静默失效——
 * 用户以为建好了，到点什么都不发生，最难排查。宁可在这里丢掉非法值。
 */
function normalizeDraft(raw: unknown, fallbackCharacterId: string): BridgeRule | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const rule: BridgeRule = {
    id: `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim().slice(0, 30) : "AI 创建的联动",
    matchType: typeof obj.matchType === "string" ? obj.matchType.trim().slice(0, 60) : "",
    enabled: true,
    process: { mode: "raw", template: "", prompt: "" },
    actions: {},
    createdAt: new Date().toISOString(),
  };

  // 定时
  const schedule = obj.schedule;
  if (schedule && typeof schedule === "object") {
    const s = schedule as Record<string, unknown>;
    const kind = s.kind;
    if (kind === "interval") {
      const minutes = clampNumber(s.minutes, 1, 10080);
      if (minutes > 0) rule.schedule = { kind: "interval", minutes };
    } else if (kind === "daily" || kind === "weekly") {
      const time = typeof s.time === "string" ? s.time.trim() : "";
      // 严格校验 HH:MM：模型爱写「8点」「08：00」（全角冒号），这些都不能直接用
      const matched = /^(\d{1,2}):(\d{2})$/.exec(time);
      if (matched && Number(matched[1]) <= 23 && Number(matched[2]) <= 59) {
        const normalized = `${String(Number(matched[1])).padStart(2, "0")}:${matched[2]}`;
        if (kind === "weekly") {
          rule.schedule = { kind: "weekly", time: normalized, weekday: clampNumber(s.weekday, 0, 6) };
        } else {
          const weekdays = Array.isArray(s.weekdays)
            ? (s.weekdays as unknown[]).map(d => clampNumber(d, 0, 6)).filter((d, i, arr) => arr.indexOf(d) === i)
            : undefined;
          rule.schedule = { kind: "daily", time: normalized, weekdays: weekdays && weekdays.length > 0 ? weekdays : undefined };
        }
      }
    }
  }

  // 加工方式
  const process = obj.process;
  if (process && typeof process === "object") {
    const p = process as Record<string, unknown>;
    if (p.mode === "template" && typeof p.template === "string" && p.template.trim()) {
      rule.process = { mode: "template", template: p.template.trim().slice(0, 2000), prompt: "" };
    } else if (p.mode === "ai" && typeof p.prompt === "string" && p.prompt.trim()) {
      rule.process = { mode: "ai", template: "", prompt: p.prompt.trim().slice(0, 2000) };
    }
  }

  // 动作
  const actions = obj.actions;
  if (actions && typeof actions === "object") {
    const a = actions as Record<string, unknown>;
    const chat = a.chat;
    if (chat && typeof chat === "object") {
      const c = chat as Record<string, unknown>;
      const characterId = typeof c.characterId === "string" && c.characterId.trim()
        ? c.characterId.trim()
        : fallbackCharacterId;
      if (characterId) {
        const role = c.role === "user" || c.role === "assistant" ? c.role : "system";
        rule.actions.chat = { characterId, role, requestReply: c.requestReply !== false };
      }
    }
    const memory = a.memory;
    if (memory && typeof memory === "object") {
      const m = memory as Record<string, unknown>;
      const characterId = typeof m.characterId === "string" && m.characterId.trim()
        ? m.characterId.trim()
        : fallbackCharacterId;
      if (characterId) {
        rule.actions.memory = { characterId, type: m.type === "core" ? "core" : "long_term" };
      }
    }
    if (a.notify === true) rule.actions.notify = true;
    const deviceAction = a.deviceAction;
    if (deviceAction && typeof deviceAction === "object") {
      const d = deviceAction as Record<string, unknown>;
      if (typeof d.action === "string" && d.action.trim()) {
        rule.actions.deviceAction = {
          action: d.action.trim(),
          args: d.args && typeof d.args === "object" ? d.args as Record<string, unknown> : undefined,
        };
      }
    }
    const tool = a.tool;
    if (tool && typeof tool === "object") {
      const t = tool as Record<string, unknown>;
      if (typeof t.name === "string" && t.name.trim()) {
        rule.actions.tool = {
          name: t.name.trim(),
          args: t.args && typeof t.args === "object" ? t.args as Record<string, unknown> : undefined,
        };
      }
    }
  }

  // 没有任何动作的规则是废的：到点什么都不做，用户只会觉得坏了
  if (Object.keys(rule.actions).length === 0) return null;
  // 既没定时也没信号名的规则永远不会触发
  if (!rule.schedule && !rule.matchType) return null;

  // 可调项
  const quiet = obj.quietHours;
  if (quiet && typeof quiet === "object") {
    const q = quiet as Record<string, unknown>;
    const start = typeof q.start === "string" ? q.start.trim() : "";
    const end = typeof q.end === "string" ? q.end.trim() : "";
    if (/^\d{1,2}:\d{2}$/.test(start) && /^\d{1,2}:\d{2}$/.test(end) && q.enabled === true) {
      rule.quietHours = { enabled: true, start, end, logSkipped: true };
    }
  }
  const cooldown = clampNumber(obj.cooldownMinutes, 0, 10080);
  if (cooldown > 0) rule.cooldownMinutes = cooldown;
  const jitter = clampNumber(obj.jitterMinutes, 0, 120);
  if (jitter > 0) rule.jitterMinutes = jitter;
  const limit = clampNumber(obj.dailyLimit, 0, 99);
  if (limit > 0) rule.dailyLimit = limit;

  return rule;
}

/**
 * 把一句大白话变成规则草案。
 *
 * 不落库、不执行——只返回草案，由 UI 展示给用户确认。
 */
export async function draftRuleFromText(
  userText: string,
  options: { signal?: AbortSignal } = {},
): Promise<RuleDraft> {
  const text = userText.trim();
  if (!text) return { rule: null, explanation: "请先说说你想要什么效果。" };

  const config = resolveConfig();
  if (!config) {
    return { rule: null, explanation: "还没有配置可用的 API，请先到「设置 → API 设置」添加一个。" };
  }

  // 把现有角色列给模型，避免它编造 characterId
  const characters = loadCharacters();
  const characterList = characters.length > 0
    ? characters.map(c => `- ${c.id}：${c.name}`).join("\n")
    : "（当前没有任何角色）";
  const fallbackCharacterId = characters.length === 1 ? characters[0].id : "";

  const result = await simpleLLMCall(
    config,
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `现有角色：\n${characterList}\n\n用户想要：${text}`,
      },
    ],
    { temperature: 0.3, max_tokens: 2048, signal: options.signal, label: "现实桥 · 规则助手" },
  );

  if (result.error) {
    return { rule: null, explanation: `生成失败：${result.error}` };
  }
  if (!result.content) {
    return { rule: null, explanation: "模型没有返回内容，请再试一次或换个说法。" };
  }

  const parsed = extractJson(result.content);
  if (!parsed || typeof parsed !== "object") {
    return { rule: null, explanation: "没能理解模型返回的内容，请换个说法再试。" };
  }

  const obj = parsed as Record<string, unknown>;
  const rule = normalizeDraft(obj.rule, fallbackCharacterId);
  const explanation = typeof obj.explanation === "string" && obj.explanation.trim()
    ? obj.explanation.trim()
    : rule ? "已按你的描述生成规则。" : "没能从这句话里提取出可用的规则。";
  const questions = Array.isArray(obj.questions)
    ? (obj.questions as unknown[]).filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, 3)
    : [];

  return {
    rule,
    explanation,
    questions: questions.length > 0 ? questions : undefined,
  };
}
