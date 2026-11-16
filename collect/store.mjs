// store.mjs — 候选与去重的本地存储（JSONL 追加写，读时按 videoId 合并）。
// M2 先用 JSONL 避免原生依赖；M3 需要查询/统计时再迁 SQLite。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CANDIDATE_STATUS = Object.freeze({
  DISCOVERED: 'discovered',
  EXTRACTED: 'extracted',
  EXTRACT_FAILED: 'extract_failed',
  SCORED: 'scored',
  ACCEPTED: 'accepted',
  ARCHIVED: 'archived',
  DOWNLOAD_FAILED: 'download_failed',
  REJECTED: 'rejected',
  // P1-5：文案语言与目标语言不符，不下载、不判定，只留记录。
  SKIPPED_LANGUAGE: 'skipped_language',
  // P2-1：与已有素材重复（画面指纹/文案高度相似），不归档、不判定。
  DUPLICATE: 'duplicate',
});

function readLines(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseLines(file) {
  const rows = [];
  for (const line of readLines(file)) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') rows.push(value);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return rows;
}

function appendLine(file, value) {
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function atomicWrite(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

function atomicWriteLines(file, rows) {
  const tmp = `${file}.${process.pid}.tmp`;
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
  renameSync(tmp, file);
}

export function createStore({ stateDir, controlDir }) {
  mkdirSync(stateDir, { recursive: true });
  if (controlDir) mkdirSync(controlDir, { recursive: true });

  const seenFile = join(stateDir, 'seen.jsonl');
  const candidatesFile = join(stateDir, 'candidates.jsonl');
  const runsFile = join(stateDir, 'runs.jsonl');
  const haltFile = controlDir ? join(controlDir, 'halt.json') : join(stateDir, 'halt.json');

  // candidates.jsonl 只追加不重写会无限膨胀（同一 videoId 每次状态变化都加一行）。
  // 压缩策略：文件超过阈值时，按 loadCandidates 合并规则（同 videoId 以最后一条为准）重写一遍。
  // 单进程串行写入，与 removeCandidate 的全量重写不会并发；本机运行目录无外部并发写者。
  const COMPACT_MIN_LINES = 2000;
  const COMPACT_MIN_BYTES = 512 * 1024;
  let compactCounter = 0;

  // 首次采集时间缓存：videoId → collectedAt（懒加载，随写入/删除同步更新）。
  // 素材库「自动隐藏超过 N 天」要按采集时间判断，而 updatedAt 每次判定/下载都会刷新，
  // 只看 updatedAt 会让几天前采集的旧素材重新冒出来。老记录没有 collectedAt 时回退 updatedAt。
  let collectedCache = null;

  function collectedTimes() {
    if (collectedCache) return collectedCache;
    const map = new Map();
    for (const row of parseLines(candidatesFile)) {
      if (!row || !row.videoId) continue;
      const id = String(row.videoId);
      if (map.has(id)) continue; // 首次出现的行即最早一次写入
      map.set(id, row.collectedAt ? String(row.collectedAt) : row.updatedAt ? String(row.updatedAt) : null);
    }
    collectedCache = map;
    return map;
  }

  function compactCandidates({ force = false } = {}) {
    if (!existsSync(candidatesFile)) return false;
    const lines = readLines(candidatesFile).length;
    const bytes = statSync(candidatesFile).size;
    if (!force && lines < COMPACT_MIN_LINES && bytes < COMPACT_MIN_BYTES) return false;
    // 按原始顺序合并：map.set 覆盖值但保留首次插入顺序，读端语义与未压缩时完全一致。
    const map = new Map();
    for (const row of parseLines(candidatesFile)) {
      if (row && row.videoId) map.set(String(row.videoId), row);
    }
    atomicWriteLines(candidatesFile, [...map.values()]);
    // 压缩不改变每条的 collectedAt，缓存只是需要重建一次。
    collectedCache = null;
    return true;
  }

  return {
    /** 已处理过的 videoId 集合。 */
    loadSeen() {
      const set = new Set();
      for (const row of parseLines(seenFile)) {
        if (row && row.videoId) set.add(String(row.videoId));
      }
      return set;
    },

    markSeen(videoId, meta = {}) {
      if (!videoId) return;
      appendLine(seenFile, { videoId: String(videoId), at: new Date().toISOString(), ...meta });
    },

    /** 读取全部候选，同一 videoId 以最后一条为准。 */
    loadCandidates() {
      const map = new Map();
      for (const row of parseLines(candidatesFile)) {
        if (row && row.videoId) map.set(String(row.videoId), row);
      }
      return map;
    },

    upsertCandidate(record) {
      if (!record || !record.videoId) return null;
      const videoId = String(record.videoId);
      const now = new Date().toISOString();
      // 首次采集时间：第一次写入后固定不变，后续判定/下载只刷新 updatedAt。
      const cache = collectedTimes();
      const collectedAt = String(record.collectedAt || cache.get(videoId) || now);
      cache.set(videoId, collectedAt);
      const value = { ...record, videoId, collectedAt, updatedAt: now };
      appendLine(candidatesFile, value);
      compactCounter += 1;
      // 每 200 次追加检查一次是否超过阈值，超阈值才全量重写，摊薄开销。
      if (compactCounter >= 200) {
        compactCounter = 0;
        compactCandidates();
      }
      return value;
    },

    /** 彻底移除一个候选（含历史重复行）。被拒素材不再留任何记录时使用。 */
    removeCandidate(videoId) {
      if (!videoId) return false;
      const target = String(videoId);
      const rows = parseLines(candidatesFile).filter((row) => row && row.videoId && String(row.videoId) !== target);
      atomicWriteLines(candidatesFile, rows);
      if (collectedCache) collectedCache.delete(target);
      return true;
    },

    listCandidates({ status = null, limit = 50, offset = 0 } = {}) {
      const map = this.loadCandidates();
      let rows = [...map.values()];
      if (status) rows = rows.filter((row) => row.status === status);
      rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      const size = Math.max(1, Math.min(Number(limit) || 50, 2000));
      const start = Math.max(0, Number(offset) || 0);
      return rows.slice(start, start + size);
    },

    countCandidates() {
      const map = this.loadCandidates();
      const byStatus = {};
      for (const row of map.values()) {
        const key = row.status || 'unknown';
        byStatus[key] = (byStatus[key] || 0) + 1;
      }
      return { total: map.size, byStatus };
    },

    recordRun(entry) {
      appendLine(runsFile, { at: new Date().toISOString(), ...entry });
    },

    /** 读取历史运行记录（最新在前）。 */
    readRuns({ limit = 50 } = {}) {
      const rows = parseLines(runsFile).filter(Boolean);
      rows.reverse();
      return rows.slice(0, Math.max(1, Math.min(Number(limit) || 50, 1000)));
    },

    /** 验证码/封禁等需要人工介入的情况：整体挂起，写入 control/halt.json。 */
    writeHalt(info) {
      const value = { at: new Date().toISOString(), ...info };
      atomicWrite(haltFile, value);
      return value;
    },

    readHalt() {
      if (!existsSync(haltFile)) return null;
      try {
        return JSON.parse(readFileSync(haltFile, 'utf8'));
      } catch {
        return null;
      }
    },

    clearHalt() {
      if (existsSync(haltFile)) atomicWrite(haltFile, null);
      return true;
    },
  };
}
