// playwright-runtime.mjs — 复用 DSH 已安装的 playwright-core（与抖音插件同一份），不额外打包浏览器。
//
// 注意：本插件通常以 pnpm `link:` 方式安装，profile 里的 node_modules/dsh-tiktok-browser-local
// 是指向工作区的符号链接。Node 会按真实路径解析依赖，因此从本文件位置找不到 profile 的
// node_modules；必须显式到 profile 目录去 require。

import { createRequire } from 'node:module';
import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function candidateRoots() {
  const roots = [];
  const push = (dir) => {
    if (!dir) return;
    const normalized = String(dir).replace(/[\\/]+$/, '');
    if (normalized && !roots.includes(normalized)) roots.push(normalized);
  };

  push(process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules') : null);
  push(process.cwd());
  push(join(process.cwd(), 'node_modules'));

  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profilesDir = join(home, 'profiles');
  const names = [];
  if (process.env.DSH_PROFILE) names.push(process.env.DSH_PROFILE);
  for (const name of ['desktop', 'cli', 'default']) names.push(name);
  for (const name of names) push(join(profilesDir, name, 'node_modules'));

  return roots;
}

function requireFrom(root, id) {
  const require = createRequire(join(root, 'noop.js'));
  return require(id);
}

function debugLog(message) {
  try {
    const line = `${new Date().toISOString()} ${message}\n`;
    const target = join(import.meta.dirname || process.cwd(), '..', '.tmp', 'pw-resolve.log');
    appendFileSync(target, line);
  } catch {
    // 诊断日志失败不影响主流程
  }
}

function loadPlaywright() {
  const attempts = [];
  debugLog(
    `cwd=${process.cwd()} dirname=${import.meta.dirname} homedir=${homedir()} DSH_HOME=${process.env.DSH_HOME || ''} DSH_PROFILE_DIR=${process.env.DSH_PROFILE_DIR || ''} roots=${JSON.stringify(candidateRoots())}`,
  );
  const tryRequire = (root, id) => {
    try {
      return requireFrom(root, id);
    } catch (error) {
      attempts.push(`${root} -> ${id}: ${error?.code || error?.message}`);
      return null;
    }
  };

  // 1) 正常解析（插件若被真实复制进 profile 时走这里）
  const direct = tryRequire(import.meta.dirname, 'playwright-core');
  if (direct) return direct;

  // 2) 逐个候选根目录
  for (const root of candidateRoots()) {
    const mod = tryRequire(root, 'playwright-core');
    if (mod) return mod;
  }

  // 3) 兜底：借 @playwright/mcp 的位置定位
  for (const root of candidateRoots()) {
    try {
      const mcp = requireFrom(root, '@playwright/mcp/package.json');
      if (mcp) {
        const mod = tryRequire(join(mcp, '..'), 'playwright-core');
        if (mod) return mod;
      }
    } catch (error) {
      attempts.push(`${root} -> @playwright/mcp: ${error?.code || error?.message}`);
    }
  }

  debugLog(`FAILED attempts=${JSON.stringify(attempts)}`);
  throw new Error(
    `playwright-core 未找到。已尝试：\n${attempts.join('\n')}\n请确认 DSH 的 profile 已安装 playwright-core。`,
  );
}

const playwright = loadPlaywright();

export const { chromium } = playwright;
