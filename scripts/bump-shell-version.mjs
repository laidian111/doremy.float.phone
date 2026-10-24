#!/usr/bin/env node
// 安卓壳版本号自动递增
//
// 为什么要这个脚本：改一次安卓原生代码，就要手动改两处版本号——
//   android-shell/app/build.gradle 的 versionCode / versionName
//   MainActivity.kt 的 VERSION 常量
// 漏改任何一处都有具体后果，而且都不是「报错」而是「静默不对劲」：
//   · 漏改 versionCode  → Android 认为装的是同一版本，覆盖安装直接失败
//                          （提示「应用未安装」，用户往往误以为要卸载重装，
//                           一卸载 WebView 里的角色/聊天/记忆就全没了）
//   · 漏改 MainActivity.VERSION → 网页按旧壳能力降级，原生功能「装了却不生效」
//
// 这个脚本把两处一起改，并顺手跑一致性校验，把这类错误挡在提交之前。
//
// 用法:
//   node scripts/bump-shell-version.mjs           递增并写入
//   node scripts/bump-shell-version.mjs --dry-run 只看会改成什么，不写文件
//   node scripts/bump-shell-version.mjs --set 1.1.0  指定版本（versionCode 取小版本号）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRADLE = path.join(root, "android-shell/app/build.gradle");
const MAIN = path.join(root, "android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const setIndex = args.indexOf("--set");
const explicitVersion = setIndex >= 0 ? args[setIndex + 1] : null;

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function readOrFail(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(`读不到文件 ${path.relative(root, file)}：${error.message}`);
  }
}

const gradleText = readOrFail(GRADLE);
const mainText = readOrFail(MAIN);

// ---------- 读出当前版本 ----------

const codeMatch = gradleText.match(/^(\s*versionCode\s+)(\d+)\s*$/m);
const nameMatch = gradleText.match(/^(\s*versionName\s+)"([^"]+)"\s*$/m);
const mainMatch = mainText.match(/^(\s*const\s+val\s+VERSION\s*=\s*)"([^"]+)"\s*$/m);

if (!codeMatch) fail("在 build.gradle 里找不到 `versionCode N` 这一行");
if (!nameMatch) fail('在 build.gradle 里找不到 `versionName "x.y.z"` 这一行');
if (!mainMatch) fail("在 MainActivity.kt 里找不到 `const val VERSION = \"x.y.z\"` 这一行");

const currentCode = Number(codeMatch[2]);
const currentName = nameMatch[2];
const currentMainVersion = mainMatch[2];

// 先报告当前是否已经分叉——分叉时直接递增会把错误固化下来
const splitIssues = [];
if (currentName !== currentMainVersion) {
  splitIssues.push(
    `当前就已经分叉：build.gradle versionName="${currentName}"，MainActivity.VERSION="${currentMainVersion}"`
  );
}

// ---------- 算出目标版本 ----------

function parseVersion(version) {
  const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!matched) return null;
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
  };
}

let nextName;
if (explicitVersion) {
  const parsed = parseVersion(explicitVersion);
  if (!parsed) fail(`--set 的版本号格式不对：「${explicitVersion}」，应为 x.y.z`);
  // 显式指定的版本不能低于当前版本。
  // 不加这道检查的话，`--set 1.0.10`（比当前 1.0.13 还旧）会被接受，
  // 然后 versionCode 变成 14——于是「版本名降级、versionCode 升级」，
  // 手机上和仓库里的版本会彻底对不上，之后再也无法从版本号判断装的到底是哪个。
  const currentParsed = parseVersion(currentName);
  if (currentParsed) {
    const lower = parsed.major < currentParsed.major
      || (parsed.major === currentParsed.major && parsed.minor < currentParsed.minor)
      || (parsed.major === currentParsed.major && parsed.minor === currentParsed.minor && parsed.patch < currentParsed.patch);
    if (lower) {
      fail(
        `--set 的版本 ${explicitVersion} 低于当前版本 ${currentName}。` +
        `Android 不允许降级安装，且版本名倒退会让版本状态彻底混乱。` +
        `请指定一个不低于 ${currentName} 的版本。`
      );
    }
  }
  nextName = explicitVersion;
} else {
  const parsed = parseVersion(currentName);
  if (!parsed) fail(`当前 versionName「${currentName}」不是 x.y.z 格式，无法自动递增`);
  // 只递增最后一段：本项目约定 versionCode == versionName 的第三段，
  // 递增 major/minor 会让这个对应关系需要额外解释，没必要。
  nextName = `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

// versionCode 与 versionName 的对应规则：
//   默认递增时，第三段加一，于是 versionCode == 第三段（本项目既有约定）。
//   用 --set 指定版本时，第三段可能不是递增的（如 1.1.0 的第三段是 0），
//   这时不能拿第三段当 versionCode——它会比当前值小，Android 直接拒绝安装。
//   所以 --set 的情况下改为「当前 versionCode + 1」，保证严格递增；
//   这样 versionCode 与 versionName 第三段会短暂不一致，属于可接受的取舍：
//   覆盖安装能否成功只看 versionCode 是否变大，而第三段只是命名习惯。
const nextParsed = parseVersion(nextName);
const nextCode = explicitVersion ? currentCode + 1 : nextParsed.patch;

if (nextCode <= currentCode) {
  fail(
    `新版本 ${nextName} 的 versionCode=${nextCode} 不大于当前的 ${currentCode}。` +
    `Android 会拒绝覆盖安装。请用一个更大的版本号。`
  );
}
if (nextName === currentName) {
  fail(`版本号没有变化（仍是 ${nextName}），Android 不会认为是升级。`);
}

// ---------- 报告 ----------

console.log("安卓壳版本号递增");
console.log("");
console.log(`  versionCode : ${currentCode}  →  ${nextCode}`);
console.log(`  versionName : "${currentName}"  →  "${nextName}"`);
console.log(`  MainActivity.VERSION : "${currentMainVersion}"  →  "${nextName}"`);
if (splitIssues.length > 0) {
  console.log("");
  for (const issue of splitIssues) {
    console.log(`  ⚠ ${issue}`);
    console.log(`    （本次递增会把两处都统一到 ${nextName}）`);
  }
}

if (dryRun) {
  console.log("");
  console.log("--dry-run：未写入任何文件。");
  process.exit(0);
}

// ---------- 写入 ----------

// 用函数式 replace 避免 `$` 被当成替换模式里的特殊字符
const nextGradle = gradleText
  .replace(/^(\s*versionCode\s+)\d+\s*$/m, (_, prefix) => `${prefix}${nextCode}`)
  .replace(/^(\s*versionName\s+)"[^"]+"\s*$/m, (_, prefix) => `${prefix}"${nextName}"`);
const nextMain = mainText.replace(
  /^(\s*const\s+val\s+VERSION\s*=\s*)"[^"]+"\s*$/m,
  (_, prefix) => `${prefix}"${nextName}"`
);

// 写之前先确认替换真的生效了，避免正则没匹配上却静默写回原内容
if (nextGradle === gradleText) fail("build.gradle 没有变化——正则可能没匹配上，已中止");
if (nextMain === mainText) fail("MainActivity.kt 没有变化——正则可能没匹配上，已中止");

fs.writeFileSync(GRADLE, nextGradle, "utf8");
fs.writeFileSync(MAIN, nextMain, "utf8");

console.log("");
console.log("✅ 已写入：");
console.log(`   ${path.relative(root, GRADLE)}`);
console.log(`   ${path.relative(root, MAIN)}`);

// ---------- 立刻跑一致性校验 ----------

console.log("");
try {
  const output = execFileSync(
    process.execPath,
    [path.join(root, "scripts/check-shell-version-consistency.mjs")],
    { encoding: "utf8" }
  );
  process.stdout.write(output);
} catch (error) {
  console.error("版本一致性校验未通过：");
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exit(1);
}

console.log("");
console.log("下一步：");
console.log("  git add android-shell/");
console.log(`  git commit -m "chore(shell): 版本号 ${nextName}"`);
console.log("  git push   # Actions 会自动构建新 APK");
