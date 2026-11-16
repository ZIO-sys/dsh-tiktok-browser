// profile-history.mjs — 画像历史版本：每次生成、保存或恢复之前留一份快照，改错可回滚。
// 目录结构（设计文档 §9 P1-3）：
//   library/profiles/.history/<id>/<ISO时间>-<source>.json
//   library/interest-profiles/.history/<id>/<ISO时间>-<source>.json
// 每个画像最多保留最近 20 个版本，超出按时间删除最旧。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const HISTORY_SOURCES = ['build', 'edit', 'restore', 'import'];
export const HISTORY_LIMIT = 20;

const ID_PATTERN = /^[\p{L}\p{N}_-]{1,64}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;

export function isValidProfileId(value) {
  return ID_PATTERN.test(String(value || '').trim());
}

export function normalizeHistorySource(value) {
  const source = String(value || '').trim().toLowerCase();
  return HISTORY_SOURCES.includes(source) ? source : 'edit';
}

/** 历史根目录下的画像目录；ID 非法时返回 null（由调用方报 INVALID_ARGUMENT）。 */
export function historyDirFor(rootDir, id) {
  const profileId = String(id || '').trim();
  if (!rootDir || !isValidProfileId(profileId)) return null;
  return join(rootDir, '.history', profileId);
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Windows 不允许文件名里出现冒号，用 - 替代；替换后仍可按字典序排序。
const stampOf = (date) => date.toISOString().replace(/[:.]/g, '-');

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/** 删除超过 keep 的旧版本，返回删除数量。 */
function prune(dir, keep = HISTORY_LIMIT) {
  const files = readdirSafe(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .reverse();
  let removed = 0;
  for (const entry of files.slice(Math.max(1, keep))) {
    try {
      unlinkSync(join(dir, entry));
      removed += 1;
    } catch {
      // 单个旧版本删不掉不影响新版本写入。
    }
  }
  return removed;
}

/**
 * 写入一个历史版本。data 是完整的画像对象（id 必填）。
 * @returns {{ok:true, version:string, file:string, pruned:number} | {ok:false, code:string, message:string}}
 */
export function writeVersion({ rootDir, id, source = 'edit', data = null, keep = HISTORY_LIMIT, now = new Date() } = {}) {
  const dir = historyDirFor(rootDir, id);
  if (!dir) return { ok: false, code: 'INVALID_ARGUMENT', message: '画像 ID 不合法。' };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '历史版本内容必须是画像对象。' };
  }
  ensureDir(dir);
  const base = `${stampOf(now)}-${normalizeHistorySource(source)}`;
  let version = base;
  for (let index = 2; existsSync(join(dir, `${version}.json`)); index += 1) version = `${base}-${index}`;
  const file = join(dir, `${version}.json`);
  writeJsonAtomic(file, data);
  return { ok: true, version, file, pruned: prune(dir, keep) };
}

/**
 * 列出某个画像的历史版本（新 → 旧）。
 * @returns {{ok:true, id:string, count:number, versions:Array<object>}}
 */
export function listVersions({ rootDir, id, limit = HISTORY_LIMIT } = {}) {
  const profileId = String(id || '').trim();
  if (!isValidProfileId(profileId)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '画像 ID 不合法。' };
  }
  const dir = historyDirFor(rootDir, profileId);
  const files = readdirSafe(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, Math.max(1, Number(limit) || HISTORY_LIMIT));
  const versions = [];
  for (const entry of files) {
    const file = join(dir, entry);
    const parsed = readJsonSafe(file);
    let bytes = 0;
    try { bytes = statSync(file).size; } catch { bytes = 0; }
    const version = entry.slice(0, -'.json'.length);
    const source = normalizeHistorySource(version.split('-').pop());
    versions.push({
      version,
      source,
      // 文件名以 ISO 时间开头，可直接还原；解析失败时退回文件 mtime。
      at: parsed?.updatedAt || parsed?.generatedAt || (() => {
        try { return statSync(file).mtime.toISOString(); } catch { return null; }
      })(),
      name: String(parsed?.name || ''),
      threshold: Number.isFinite(Number(parsed?.threshold)) ? Number(parsed.threshold) : null,
      sampleCount: Number.isFinite(Number(parsed?.sampleCount)) ? Number(parsed.sampleCount) : null,
      negativeCount: Number.isFinite(Number(parsed?.negativeCount)) ? Number(parsed.negativeCount) : null,
      bytes,
    });
  }
  return { ok: true, id: profileId, count: versions.length, versions };
}

/** 读取一个历史版本的内容。 */
export function readVersion({ rootDir, id, version = '' } = {}) {
  const dir = historyDirFor(rootDir, id);
  if (!dir) return { ok: false, code: 'INVALID_ARGUMENT', message: '画像 ID 不合法。' };
  const name = String(version || '').trim();
  if (!VERSION_PATTERN.test(name) || name.includes('..') || /[\\/]/.test(name)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '版本号不合法。' };
  }
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return { ok: false, code: 'NOT_FOUND', message: `没有版本 ${name}。` };
  const data = readJsonSafe(file);
  if (!data || typeof data !== 'object') {
    return { ok: false, code: 'PROFILE_CORRUPTED', message: `版本 ${name} 无法解析。` };
  }
  return { ok: true, version: name, file, data };
}

/**
 * 清空历史：删除 rootDir/.history 下全部文件，返回被删除的绝对路径（用于 purge manifest）。
 * 不做备份——清空库时历史版本随画像一起丢弃。
 */
export function clearHistory(rootDir) {
  const root = String(rootDir || '').trim();
  if (!root) return [];
  const historyRoot = join(root, '.history');
  if (!existsSync(historyRoot)) return [];
  const removed = [];
  for (const id of readdirSafe(historyRoot)) {
    const dir = join(historyRoot, id);
    for (const entry of readdirSafe(dir)) removed.push(join(dir, entry));
  }
  try {
    rmSync(historyRoot, { recursive: true, force: true });
  } catch {
    // 删除失败时把已发现的文件列表返回，manifest 仍可记录。
  }
  return removed;
}
