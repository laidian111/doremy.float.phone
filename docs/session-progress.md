# 开发进度存档

> 这份文档是为了跨会话不丢失上下文而写的。每次大改动后更新。
> 最后更新：提交 `480720a`

---

## 一、项目与目标

- **仓库**：`https://github.com/laidian111/laidian333.git`（fork 自 `doremy1203/doremy.float.phone`，保留原作者署名，照常公开）
- **本地路径**：`C:\Users\Lenovo\deepseek\doremy.float.phone`
- **技术栈**：Next.js 15 App Router + React 19 + TypeScript + Tailwind 4，AGPL-3.0
- **形态**：Android 壳（WebView 全屏加载远程站点）+ PWA 网页
- **核心诉求**：改造为**完全本地运行**的私人版本（数据全在手机上，不依赖浏览器中转），并增强现实桥、聊天等能力

### 工作方式
1. **先在本地改，本地验证（`http://localhost:3001`），再推送**
2. 每次结束汇报「做到哪一步」，不只给产物
3. 密钥绝不进仓库、不写进源码、不打日志

---

## 二、已完成的改动

### 1. 数据本地化 + 导出到手机

**问题**：在 APK 里点导出，没反应或找不到文件。

**根因（两层）**：
1. Android Binder 事务上限约 **1MB**，大对象跨 Intent 被静默吞掉（`runCatching{}.getOrDefault(false)` 掩盖了失败）
2. `isAndroidBrowser()` 误匹配了壳的 Android UA，导出卡在「请点保存备份文件」

**解法**：
- 分块传输（`CHUNK_BYTES = 256KB`），`saveViaChunkedBridge()`
- 壳侧用 MediaStore `Downloads.EXTERNAL_CONTENT_URI` + `IS_PENDING` 1→0（Android 10+ 免权限）
- 修正 UA 判断：壳标记为 `FloatShell/`（`FLOAT_SHELL_UA_MARK`）

### 2. LLM 直连 / 服务端转发

- API 设置里加了 **直连 / 服务端转发** 下拉
- 两个出口都要认这个设置：`simpleLLMCall`（`lib/api-helpers.ts`）、`fetchLlmPayload`（`lib/llm-http.ts`）
- ⚠️ 两处逻辑是**重复的**（`api-helpers.ts` 不能 import `llm-http.ts`，会循环依赖），改一处必须同步另一处

**踩过的坑**：本地 dev server 带了 `HTTP_PROXY` 环境变量，`scripts/local-next-server.mjs` 会装全局 proxy dispatcher，导致所有服务端 fetch 被强制走代理 → LLM 接口 502。
**解决**：启动时 `HTTP_PROXY=''` / `HTTPS_PROXY=''`。

### 3. 工坊自定义系统提示词

- 工坊侧边栏可编辑，存 key `ai_phone_qa_persona_prompt`
- **只替换人格段**（`getQaPersonaPrompt()`），知识库和工具文档保留

### 4. 现实桥（Reality Bridge）

**先修的问题**：
- 安卓上隐藏 iOS 选项 —— 第一版改错了：`else <iOS组>` 导致桌面端（`home === null`）落进 iOS 分支，仍然显示。改成两个**独立条件**才对
- `http://localhost:3001` 无法访问

**新增的自定义能力**：

| 能力 | 说明 |
|---|---|
| 全局安静时段 | 桥接设置里统一配置 |
| 单条规则覆盖 | 规则的安静时段**覆盖**全局，不是叠加 |
| 工作日 / 周末限定 | 每天 / 仅工作日 / 仅周末 |
| 随机浮动 | ±N 分钟，种子按 `ruleId#Y-M-D`，同一天内稳定 |
| 每日上限 | 每天最多触发 N 次 |
| **AI 规则助手** | 用大白话说「我想八点收到一条指定角色消息」，自动生成规则草稿 |

AI 助手的流程刻意**不落库**：草稿 → 用户确认「就用这个，我再调调」→ 载入编辑器 → 用户自己保存。

### 5. Android 包名共存 + 签名发布

**为什么改包名**：避免覆盖上游 `app.floatphone.shell`，让两个 app 共存。

| 项目 | 值 |
|---|---|
| applicationId | `app.floatphone.shell.pro` |
| app_name | `float-pro` |
| versionCode / versionName | `13` / `1.0.13` |

**签名**：GitHub Actions 用 4 个 Secret（`SHELL_KEYSTORE_BASE64`、`SHELL_KEYSTORE_PASSWORD`、`SHELL_KEY_ALIAS`、`SHELL_KEY_PASSWORD`）+ 1 个 Variable（`SHELL_SITE_URL`，注意在 **Variables** 不是 Secrets）。

**版本管理**：`npm run bump:shell`（`scripts/bump-shell-version.mjs`）自动递增两处版本号。
铁律：`versionCode` 必须严格递增，否则 Android 报「应用未安装」。

### 6. 聊天发文件（最近三批改动）

#### 用户发给角色 —— `03cda81`

- 「+」菜单加「文件」项
- 文件存本机 MediaStore，不上云
- **docx 用 JSZip 拆 `word/document.xml`**（项目已有 jszip，零新增依赖）
- 文件气泡显示「文件名 / 类型 · 大小」

#### 修复 + 编码 —— `02e2974`

**关键 bug**：项目有**两条**把消息喂给模型的路径：

| 文件 | 用途 |
|---|---|
| `lib/short-term-assembler.ts` | 长期记忆归档 |
| **`lib/llm-prompt-assembler.ts`** | **主对话（关键）** |

第一版只改了前者，而主对话的 `media_file` 分支直接 `return msg.content`（只有文件名），所以角色说「我这边没收到文件」——**它是如实回答**。

**编码识别**：Windows 上大量 `.txt` 是 GBK，直接 `blob.text()` 会把「你好」解成 `���` 且**不报错**。
判断顺序：BOM（UTF-8/UTF-16LE/BE）→ UTF-8 严格解码 → GBK 回退 → 乱码兜底提示。

#### PDF + 交互修正 —— `63ef644`

- **PDF**：`pdfjs-dist`，**动态 import**（300KB+，只有真发 PDF 才加载）
  - 坑1：必须 `disableWorker: true`，否则 Next 打包里 worker 路径解析失败
  - 坑2：用 `legacy/build/pdf.mjs`
  - 坑3：`doc.cleanup()`，`destroy()` 在这个版本不存在
  - 扫描版/加密 PDF 如实提示，不编造
- **发文件后不再自动回复**，与文字一致（点发送键才回复）
- `.doc`（OLE 二进制）从 `docx` 分类里拆出来 → `legacy_doc`，提示另存为 `.docx`

#### 角色发文件回 —— `480720a`

**发现**：项目已有「发送文件」工具，但**只接受 URL**（角色没服务器，生成不出 URL）。

**新增「生成文件」工具**：文字 → 真正的 docx

- 手拼最小 OOXML 骨架（`[Content_Types].xml` + `_rels/.rels` + `word/document.xml`），零新增依赖
- 支持 `docx` / `txt` / `md`
- 走与「发送文件」**相同出口**（`mediaAttachments`），渲染层零改动
- **默认关闭**（`enabled: false`），需在 工具箱 → 内置能力 手动开

---

## 三、几个必须记住的技术铁律

1. **两条 prompt 路径**：改「角色看到什么」必须同时改 `llm-prompt-assembler.ts`（主对话）和 `short-term-assembler.ts`（长期记忆）
2. **1MB Binder 上限**：大对象绝不跨 Intent，分块传输
3. **docx 表格**：`<w:tc>` 内包着 `<w:p>`，直接替换 `</w:p>` 会把表格拆成一行一个词。要先用占位符包裹单元格
4. **PDF worker**：`disableWorker: true` + `legacy` 构建 + `cleanup()`
5. **GBK 编码**：中文 `.txt` 不能直接 `blob.text()`，要按 BOM → UTF-8 → GBK 三级判断
6. **本地 dev 代理**：启动时清掉 `HTTP_PROXY` / `HTTPS_PROXY`
7. **每个 pwsh 调用都是新进程**：`cwd` 不保留，必须显式 `cd` 或传 `workdir`；`.NET` 方法不继承 cwd，要用绝对路径
8. **Node 在** `C:\Users\Lenovo\deepseek\tools\node-v24.14.0-win-x64`，每次要 prepend 到 `$env:Path`

---

## 四、当前状态

| 项目 | 值 |
|---|---|
| 本地 HEAD | `480720a` |
| 远端 main | `480720a` |
| 未推送 | 0 |
| 是否需要装 APK | 否（最近改动都是纯 Web） |
| TypeScript 基线 | 35 个既有错误（非我引入） |

**既有噪音（不是我造成的，别去追）**：
- 35 个 `tsc` 错误（`setCallInitiator`、`callEndMarker` 等）
- 构建警告 `Attempted import error: 'deleteScreenshotRecord' is not exported from '@/lib/screenshot'`

---

## 五、还没做的

1. 现实桥「每隔 N 分钟」的规则，weekday 过滤不完全生效
2. 桥接轮询失败没有重试/退避
3. 安卓上仍会尝试连 Supabase 云端轮询（应关掉）
4. 感知权限在打开时就申请，应改为按需
5. 角色发文件是纯文字批改、没调工具时，可考虑把「生成文件」改为默认开启

---

## 六、环境备忘

- 本地仓库：`C:\Users\Lenovo\deepseek\doremy.float.phone`
- 签名文件：`C:\Users\Lenovo\deepseek\signing\`（**在仓库外**，绝不提交）
- git 走本地代理：`http://127.0.0.1:7899`
- dev server：`npm run dev` → `scripts/local-next-server.mjs --dev`，端口 3001
  - 需 `--max-old-space-size=8192`，4GB 会 OOM
- 本地调试注意：DevTools → Application → Service Workers → 勾「Bypass for network」
- 数据是按 origin 存的 IndexedDB，换端口/换浏览器看起来像丢数据
- `.env.local` 需要 `NEXT_PUBLIC_SELF_HOSTED_MODE=true`（已 gitignore）
