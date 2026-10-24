#!/usr/bin/env node
// 安卓壳版本号一致性校验
//
// 背景（见 docs/fork-changes-overview.md 的 A2「壳版本号约定」）：
// 壳的版本号散落在两处，且**必须同步递增**——
//   1. android-shell/app/build.gradle 的 versionCode / versionName  —— 系统用它判断能不能覆盖安装
//   2. MainActivity.kt 的 VERSION 常量                              —— 拼进 UA，网页据此判断壳能力
//
// 实际踩过的坑：传给网页的版本已经停在 1.0.10，而安装包是 1.0.12。
// 后果是网页按老壳能力降级，原生功能「明明装了却不生效」，极难排查。
//
// 另外校验 versionCode 与 versionName 的小版本号是否对齐：两者各说各话时，
// 「应用未安装」这类覆盖安装失败会变得无法从版本号上判断。
//
// 用法: node scripts/check-shell-version-consistency.mjs
// 退出码非 0 = 版本号不一致。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const GRADLE = "android-shell/app/build.gradle";
const MAIN = "android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt";

const problems = [];
const notes = [];

let gradle;
let main;
try {
  gradle = read(GRADLE);
  main = read(MAIN);
} catch (error) {
  console.error(`无法读取文件：${error.message}`);
  process.exit(2);
}

// ---------- 1. build.gradle: versionCode / versionName ----------
// 匹配形如 `versionCode 13` / `versionName "1.0.13"`，忽略注释行。
function readGradleValue(text, key, pattern) {
  const lineRe = new RegExp(`^\\s*${key}\\s+${pattern}`, "m");
  const match = text.match(lineRe);
  return match ? match[1] : null;
}

const versionCodeRaw = readGradleValue(gradle, "versionCode", "(\\d+)");
const versionName = readGradleValue(gradle, "versionName", '"([^"]+)"');

if (!versionCodeRaw) problems.push(`${GRADLE}: 找不到 versionCode`);
if (!versionName) problems.push(`${GRADLE}: 找不到 versionName`);

const versionCode = versionCodeRaw ? Number(versionCodeRaw) : null;

// ---------- 2. MainActivity.kt: VERSION 常量 ----------
const mainMatch = main.match(/const\s+val\s+VERSION\s*=\s*"([^"]+)"/);
const mainVersion = mainMatch ? mainMatch[1] : null;
if (!mainVersion) problems.push(`${MAIN}: 找不到 const val VERSION`);

// ---------- 3. 交叉校验 ----------
if (versionName && mainVersion && versionName !== mainVersion) {
  problems.push(
    `壳版本号分叉：build.gradle versionName="${versionName}"，` +
    `MainActivity.VERSION="${mainVersion}"。这两处必须一致——` +
    `后者会拼进 WebView 的 UA，分叉会让网页按错误的壳能力降级。`
  );
}

// versionName 形如 1.0.13 -> 小版本 13，按本项目约定应与 versionCode 相等。
//
// 例外：用 `npm run bump:shell --set x.y.0` 显式指定版本时，第三段会是 0，
// 而 versionCode 必须继续递增（否则 Android 拒绝覆盖安装），两者必然不等。
// 这种「versionCode 更大」的情况是合法的——覆盖安装只看 versionCode 变大，
// 第三段只是命名习惯。所以这里只在 versionCode **小于**小版本时报错，
// 大于时放行并提示一句，避免把正常的显式指定版本误判成错误。
if (versionName && versionCode !== null) {
  const parts = versionName.split(".");
  const minor = parts.length >= 3 ? Number(parts[2]) : null;
  if (Number.isFinite(minor) && minor !== versionCode) {
    if (versionCode < minor) {
      problems.push(
        `versionCode=${versionCode} 小于 versionName="${versionName}" 的小版本号 ${minor}。` +
        `这意味着 versionCode 没有随版本递增，Android 会拒绝覆盖安装。`
      );
    } else {
      notes.push(
        `versionCode=${versionCode} 大于 versionName 的小版本号 ${minor}（显式指定版本时的正常情况）`
      );
    }
  } else if (Number.isFinite(minor)) {
    notes.push(`versionCode=${versionCode} 与 versionName="${versionName}" 已对齐`);
  }
}

// ---------- 输出 ----------
if (problems.length > 0) {
  console.error("❌ 壳版本号校验失败：\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\n修复后重跑本脚本。版本号规则见 docs/fork-changes-overview.md 的 A2 一节。");
  process.exit(1);
}

console.log("✅ 壳版本号一致");
console.log(`   versionCode : ${versionCode}`);
console.log(`   versionName : ${versionName}`);
console.log(`   UA 版本常量 : ${mainVersion}`);
for (const note of notes) console.log(`   ${note}`);
