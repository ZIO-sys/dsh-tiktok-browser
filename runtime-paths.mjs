// runtime-paths.mjs — tiktok-browser 的目录解析与 Node 运行时校验。
// 所有运行态数据都放在 ~/.dsh/tiktok-browser/ 下，与抖音插件完全隔离。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_NAME = 'dsh-tiktok-browser-local';
export const PLUGIN_VERSION = '0.2.4';
export const LOCATION_VERSION = 1;

function readLocation(baseDir) {
  const file = join(baseDir, 'runtime-location.json');
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== LOCATION_VERSION) return null;
    if (typeof parsed.baseDir !== 'string' || !parsed.baseDir.trim()) return null;
    return parsed.baseDir;
  } catch {
    return null;
  }
}

function writeLocation(baseDir) {
  const file = join(baseDir, 'runtime-location.json');
  const body = JSON.stringify({ version: LOCATION_VERSION, baseDir, updatedAt: new Date().toISOString() }, null, 2);
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file);
  } catch {
    // 位置文件只是缓存，写不进去不影响主流程。
  }
}

/**
 * 解析运行目录。优先级：TIKTOK_BROWSER_HOME 环境变量 > runtime-location.json > 默认路径。
 */
export function resolveRuntimePaths({ env = process.env, home = homedir() } = {}) {
  const defaultBase = join(home, '.dsh', 'tiktok-browser');
  const override = (env.TIKTOK_BROWSER_HOME || '').trim();
  const stored = override ? null : readLocation(defaultBase);
  const baseDir = override || stored || defaultBase;
  const paths = {
    baseDir,
    configFile: join(baseDir, 'config.json'),
    locationFile: join(baseDir, 'runtime-location.json'),
    stateDir: join(baseDir, 'state'),
    memoryDir: join(baseDir, 'memory'),
    memoryDbPath: join(baseDir, 'memory', 'tiktok.sqlite'),
    libraryDir: join(baseDir, 'library'),
    downloadsDir: join(baseDir, 'downloads'),
    logsDir: join(baseDir, 'logs'),
    browserProfileDir: join(baseDir, 'cli-profile'),
    browserControlDir: join(baseDir, 'control'),
    browserStateFile: join(baseDir, 'control', 'browser.json'),
  };
  return paths;
}

export function ensureRuntimePaths(paths) {
  const dirs = [
    paths.baseDir,
    paths.stateDir,
    paths.memoryDir,
    paths.libraryDir,
    paths.downloadsDir,
    paths.logsDir,
    paths.browserProfileDir,
    paths.browserControlDir,
  ];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  if (!existsSync(paths.locationFile)) writeLocation(paths.baseDir);
  return paths;
}

const NODE_MIN = { major: 22, minor: 13 };

function parseNodeVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function versionSatisfies(version) {
  if (!version) return false;
  if (version.major > NODE_MIN.major) return true;
  if (version.major < NODE_MIN.major) return false;
  return version.minor >= NODE_MIN.minor;
}

/**
 * 校验独立 Node 运行时。Electron 自带的 node（ELECTRON_RUN_AS_NODE）不满足要求。
 * 返回 { ok, executable, version, code, message }。
 */
export function resolveNodeExecutable({
  env = process.env,
  executable = process.execPath,
  versions = process.versions,
} = {}) {
  const explicit = (env.TIKTOK_NODE_EXECUTABLE || '').trim();
  const isElectron = Boolean(versions && versions.electron) && !explicit;
  if (isElectron) {
    return {
      ok: false,
      executable: executable || '',
      version: versions?.node || null,
      code: 'NODE_ELECTRON_RUNTIME',
      message: '当前运行在 Electron 自带 Node 中，请安装独立 Node >=22.13 并设置 TIKTOK_NODE_EXECUTABLE。',
    };
  }
  if (!executable) {
    return {
      ok: false,
      executable: '',
      version: null,
      code: 'NODE_NOT_FOUND',
      message: '找不到 Node 可执行文件，请安装 Node >=22.13。',
    };
  }
  const version = parseNodeVersion(versions?.node);
  if (!versionSatisfies(version)) {
    return {
      ok: false,
      executable,
      version: versions?.node || null,
      code: 'NODE_VERSION_UNSUPPORTED',
      message: `Node 版本过低（${versions?.node || 'unknown'}），需要 >=${NODE_MIN.major}.${NODE_MIN.minor}。`,
    };
  }
  return { ok: true, executable, version: versions?.node || null, code: null, message: null };
}
