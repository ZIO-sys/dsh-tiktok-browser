// browser-host.mjs — 专用 Edge 宿主：拉起持久化 profile、写控制文件、做焦点重置与错误分类。
// M1 以内联方式被 core.mjs 调用；文件末尾保留 CLI 入口，M2 可切换为独立 node 子进程。

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from './playwright-runtime.mjs';

export const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export const BROWSER_ERROR_CODES = Object.freeze({
  PROFILE_IN_USE: 'BROWSER_PROFILE_IN_USE',
  ACCESS_DENIED: 'EDGE_ACCESS_DENIED',
  MISSING: 'EDGE_MISSING',
  VERSION_INCOMPATIBLE: 'EDGE_VERSION_INCOMPATIBLE',
  LAUNCH_FAILED: 'EDGE_LAUNCH_FAILED',
  FOCUS_RESET_FAILED: 'EDGE_FOCUS_RESET_FAILED',
});

export function probeEdgeInstallation({ env = process.env, exists = existsSync } = {}) {
  const local = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null;
  const candidates = [local, ...EDGE_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return { ok: true, path: candidate };
    } catch {
      // 忽略单个候选的探测错误，继续下一个。
    }
  }
  return { ok: false, path: null, candidates };
}

export function readBrowserState(controlDir) {
  const file = join(controlDir, 'browser.json');
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearBrowserState(controlDir) {
  const file = join(controlDir, 'browser.json');
  try {
    rmSync(file, { force: true });
  } catch {
    // 清理失败不影响主流程。
  }
}

function writeBrowserState(controlDir, state) {
  mkdirSync(controlDir, { recursive: true });
  const file = join(controlDir, 'browser.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, file);
}

function isPortFree(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/**
 * 为插件专用 Edge profile 设置受管下载目录，避免 AIX 下载散落到用户默认下载目录。
 * 只改 download.* 三个字段，写前保留 Preferences 备份。
 */
export function configureProfileDownloads(profile, directory) {
  if (!profile || !directory) return { ok: false, code: 'INVALID_ARGUMENTS', message: '缺少 profile 或下载目录。' };
  mkdirSync(directory, { recursive: true });
  const defaultDir = join(profile, 'Default');
  mkdirSync(defaultDir, { recursive: true });
  const file = join(defaultDir, 'Preferences');
  let preferences = {};
  if (existsSync(file)) {
    try {
      preferences = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      return { ok: false, code: 'PREFERENCES_INVALID', message: `Edge Preferences 无法解析：${error.message}` };
    }
  }
  preferences.download = {
    ...(preferences.download || {}),
    default_directory: directory,
    prompt_for_download: false,
    directory_upgrade: true,
  };
  const temp = `${file}.${process.pid}.tmp`;
  try {
    if (existsSync(file)) copyFileSync(file, `${file}.tiktok-browser.bak`);
    writeFileSync(temp, JSON.stringify(preferences), 'utf8');
    renameSync(temp, file);
    return { ok: true, file, directory };
  } catch (error) {
    return { ok: false, code: 'PREFERENCES_WRITE_FAILED', message: `写入 Edge 下载设置失败：${error.message}` };
  }
}

/**
 * 启动持久化 Edge。返回 { started, pid, port, context, close, code, message }。
 */
export async function runBrowserHost({
  profile,
  controlDir,
  port,
  proxy = null,
  launchOptions = {},
  chromiumImpl = chromium,
  probeInstallation = probeEdgeInstallation,
  logger = console,
} = {}) {
  if (!profile || !controlDir || !isPortFree(port)) {
    return { started: false, exitCode: 2, code: 'INVALID_ARGUMENTS', message: 'profile / controlDir / port 参数无效。' };
  }
  const installation = probeInstallation();
  if (!installation.ok) {
    const failure = { started: false, code: BROWSER_ERROR_CODES.MISSING, message: '未找到 Microsoft Edge，请先安装 Edge 后重试。' };
    writeBrowserState(controlDir, { pid: null, profile, port, ready: false, ...failure, startedAt: new Date().toISOString() });
    return failure;
  }
  if (launchOptions.downloadDir) {
    const configured = configureProfileDownloads(profile, launchOptions.downloadDir);
    if (!configured.ok) {
      writeBrowserState(controlDir, { pid: null, profile, port, ready: false, ...configured, startedAt: new Date().toISOString() });
      return { started: false, ...configured };
    }
  }
  // 默认走 CDP 附加模式：以普通方式拉起 msedge.exe（不带 --enable-automation），
  // 再用 connectOverCDP 接管。这样 navigator.webdriver 为 false，Google 登录与反爬检测都更友好。
  const mode = launchOptions.launchMode === 'playwright' ? 'playwright' : 'cdp';
  try {
    if (mode === 'playwright') {
      return await launchWithPlaywright({ profile, controlDir, port, proxy, launchOptions, chromiumImpl, logger });
    }
    return await launchWithCdp({ installation, profile, controlDir, port, proxy, launchOptions, chromiumImpl, logger });
  } catch (error) {
    const failure = classifyBrowserLaunchError(error);
    writeBrowserState(controlDir, { pid: null, profile, port, ready: false, ...failure, startedAt: new Date().toISOString() });
    return { started: false, ...failure };
  }
}

/** 普通方式启动 Edge 并通过 CDP 接管（无自动化标记）。 */
async function launchWithCdp({ installation, profile, controlDir, port, proxy, launchOptions, chromiumImpl, logger }) {
  mkdirSync(profile, { recursive: true });
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
    '--start-maximized',
  ];
  const proxyServer = proxy?.server || proxy?.proxyServer || null;
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
  if (Array.isArray(launchOptions.args)) args.push(...launchOptions.args);
  args.push('about:blank');

  const child = spawn(installation.path, args, { detached: false, stdio: 'ignore', windowsHide: false });
  let spawnError = null;
  let exitInfo = null;
  child.on('error', (error) => {
    spawnError = error;
  });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const endpoint = `http://127.0.0.1:${port}`;
  const version = await waitForDevtools(endpoint, 25000, () => spawnError || exitInfo);
  const browser = await chromiumImpl.connectOverCDP(endpoint);
  const context = browser.contexts()[0] || (await browser.newContext());
  const pid = child.pid ?? null;
  writeBrowserState(controlDir, {
    pid,
    profile,
    port,
    ready: true,
    mode: 'cdp',
    browserVersion: version?.Browser || null,
    startedAt: new Date().toISOString(),
  });
  const close = async () => {
    try {
      await browser.close();
    } catch (error) {
      logger?.warn?.('[tiktok-browser] 关闭浏览器连接失败：', error?.message || error);
    }
    try {
      if (child.exitCode === null && !child.killed) child.kill();
    } catch (error) {
      logger?.warn?.('[tiktok-browser] 结束 Edge 进程失败：', error?.message || error);
    }
    clearBrowserState(controlDir);
  };
  return { started: true, pid, port, context, browser, close, code: null, message: null };
}

async function waitForDevtools(endpoint, timeoutMs, checkFailure) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const failure = checkFailure();
    if (failure) {
      const detail = failure.message ? failure.message : `exit code=${failure.code}`;
      throw new Error(`Edge 启动失败：${detail}`);
    }
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return await response.json();
    } catch {
      // 调试端口尚未就绪，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('ProcessSingleton: profile in use —— Edge 未能在 25 秒内开启调试端口，可能已有同 profile 的 Edge 在运行。');
}

/** 旧路径：Playwright launchPersistentContext（会带 --enable-automation）。 */
async function launchWithPlaywright({ profile, controlDir, port, proxy, launchOptions, chromiumImpl, logger }) {
  const context = await chromiumImpl.launchPersistentContext(profile, {
      channel: 'msedge',
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ['--mute-audio'],
      args: [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        '--autoplay-policy=no-user-gesture-required',
      ],
      ...(proxy ? { proxy } : {}),
      ...launchOptions,
    });
    const pid = readPid(context);
    writeBrowserState(controlDir, {
      pid,
      profile,
      port,
      ready: true,
      startedAt: new Date().toISOString(),
    });
    const close = async () => {
      try {
        await context.close();
      } catch (error) {
        logger?.warn?.('[tiktok-browser] 关闭浏览器失败：', error?.message || error);
      } finally {
        clearBrowserState(controlDir);
      }
    };
  return { started: true, pid, port, context, close, code: null, message: null };
}

function readPid(context) {
  const browser = typeof context?.browser === 'function' ? context.browser() : null;
  return browser?.process?.()?.pid ?? null;
}

export function classifyBrowserLaunchError(error) {
  const text = `${error?.message || ''} ${error?.stderr || ''}`;
  if (/ProcessSingleton|profile.*in use|已被占用/i.test(text)) {
    return { code: BROWSER_ERROR_CODES.PROFILE_IN_USE, message: '浏览器 profile 已被占用，请关闭其他 Edge 窗口后重试。' };
  }
  if (/EACCES|EPERM|access is denied|拒绝访问/i.test(text)) {
    return { code: BROWSER_ERROR_CODES.ACCESS_DENIED, message: '没有权限启动 Edge，请检查 profile 目录权限或安全软件拦截。' };
  }
  if (/Executable doesn't exist|not found|ENOENT/i.test(text)) {
    return { code: BROWSER_ERROR_CODES.MISSING, message: '未找到 Microsoft Edge，请先安装 Edge 后重试。' };
  }
  if (/version|incompatible/i.test(text)) {
    return { code: BROWSER_ERROR_CODES.VERSION_INCOMPATIBLE, message: 'Edge 版本不兼容，请更新 Edge 后重试。' };
  }
  return { code: BROWSER_ERROR_CODES.LAUNCH_FAILED, message: `启动 Edge 失败：${sanitizeBrowserFailure(text).slice(0, 300)}` };
}

export function sanitizeBrowserFailure(text) {
  return String(text || '')
    .replace(/([?&](?:token|cookie|session|auth)[^&\s]*)/gi, '$1=***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<local-path>');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [profile, controlDir, portText] = process.argv.slice(2);
  const port = Number(portText);
  runBrowserHost({ profile, controlDir, port })
    .then((result) => {
      if (!result.started) {
        process.stderr.write(`${result.code}: ${result.message}\n`);
        process.exit(result.exitCode ?? 1);
      }
      process.stdout.write(`started pid=${result.pid} port=${result.port}\n`);
      const shutdown = () => result.close().finally(() => process.exit(0));
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((error) => {
      process.stderr.write(`${error?.message || error}\n`);
      process.exit(1);
    });
}
