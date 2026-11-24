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
  const error = new Error(
    `playwright-core 未找到，插件无法启动浏览器。已尝试：\n${attempts.join('\n')}\n`
      + '修复办法（任选其一）：\n'
      + '  1) 在 DSH 插件管理里重新安装本插件，让包管理器自动装上依赖；\n'
      + '  2) 在 DSH 的 profile 目录执行：pnpm add playwright-core；\n'
      + '  3) 若用本地目录方式安装，请在该目录执行 pnpm install。',
  );
  error.code = 'PLAYWRIGHT_CORE_MISSING';
  throw error;
}

let cached = null;

/** 惰性解析 playwright-core：只有真正要用浏览器时才加载。 */
function playwright() {
  if (!cached) cached = loadPlaywright();
  return cached;
}

/**
 * 惰性代理：模块加载阶段不解析 playwright-core，避免依赖缺失时整个插件
 * （含设置页与自检）都注册不上。首次访问 chromium 的方法时才真正加载，
 * 失败会抛出 code=PLAYWRIGHT_CORE_MISSING 的可操作错误。
 */
export const chromium = new Proxy({}, {
  get(_target, property) {
    const mod = playwright();
    const value = mod.chromium[property];
    return typeof value === 'function' ? value.bind(mod.chromium) : value;
  },
  has(_target, property) {
    return property in playwright().chromium;
  },
});

/**
 * 自检用：不抛错地探测 playwright-core 是否可用。
 * 返回 { ok, detail, code }，供 diagnostics 展示可操作的修复提示。
 */
export function probePlaywrightRuntime() {
  try {
    const mod = playwright();
    const version = mod?._playwright?.version || mod?.chromium?.name?.() || '已加载';
    return { ok: true, detail: `playwright-core ${version}`, code: null };
  } catch (error) {
    return {
      ok: false,
      detail: String(error?.message || error).split('\n')[0] || 'playwright-core 未找到',
      code: error?.code || 'PLAYWRIGHT_CORE_MISSING',
    };
  }
}
