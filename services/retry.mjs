// retry.mjs — P2-3 失败重试：指数退避 + 下载失败重试队列 + 模型 429/5xx 可重试判定。
//
// 设计边界：
//  - nextDelay 是纯函数，序列 1s→2s→4s→8s…，封顶 30s，抖动默认 ±20%。
//  - 队列只记“哪条候选失败了几次、下次什么时候可以试”，不自动重跑（重跑由人工/下一轮采集决定）。
//  - 模型重试在 model-gateway 里做（同一次预算预留内重试），本模块只提供“这个错误该不该重试”的判断。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RETRY_DEFAULTS = Object.freeze({
  base: 1000,
  max: 30_000,
  jitter: 0.2,
  maxAttempts: 3,
});

/** 第 attempt 次退避的基准值（未加抖动）：1s, 2s, 4s, 8s… 封顶 max。 */
export function backoffBase(attempt, { base = RETRY_DEFAULTS.base, max = RETRY_DEFAULTS.max } = {}) {
  const n = Math.max(1, Math.trunc(Number(attempt) || 1));
  const raw = Number(base) * 2 ** (n - 1);
  return Math.min(Number(max), Math.max(0, Math.round(raw)));
}

/**
 * 第 attempt 次退避的实际等待毫秒（带抖动）。
 * 结果始终落在 [base*(1-jitter), min(max, base*(1+jitter))] 内。
 */
export function nextDelay(attempt, { base = RETRY_DEFAULTS.base, max = RETRY_DEFAULTS.max, jitter = RETRY_DEFAULTS.jitter } = {}, random = Math.random) {
  const raw = backoffBase(attempt, { base, max });
  const ratio = Math.min(Math.max(Number(jitter) || 0, 0), 1);
  if (!ratio) return raw;
  const low = Math.max(0, Math.round(raw * (1 - ratio)));
  const high = Math.min(Number(max), Math.round(raw * (1 + ratio)));
  if (high <= low) return raw;
  const value = low + Math.floor(Math.max(0, Math.min(Number(random()) || 0, 0.999999)) * (high - low + 1));
  return Math.min(Number(max), value);
}

/** 模型错误码是否值得重试：429 与 5xx。 */
export function isRetryableModelError(code) {
  return /^MODEL_HTTP_(?:429|5\d\d)$/.test(String(code || ''));
}

/** 下载错误是否值得重试：网络/超时类可重试，鉴权与人工接管类不重试。 */
export function isRetryableDownloadError(code) {
  const value = String(code || '').toUpperCase();
  if (!value) return false;
  if (/MANUAL|AUTH|LOGIN|CAPTCHA|FORBIDDEN|NOT_FOUND|INVALID|MISMATCH/.test(value)) return false;
  return /TIMEOUT|NETWORK|FETCH|DOWNLOAD_FAILED|ECONN|ABORT|_5\d\d|HTTP_429|RATE/.test(value);
}

function readRows(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const row = JSON.parse(text);
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      // 跳过损坏行
    }
  }
  return rows;
}

/**
 * 下载失败重试队列（JSONL，按 videoId 归并，读时后写覆盖先写）。
 * 事件：enqueue（失败入队）/ resolve（重试成功或人工处理）/ clear（清空）。
 */
export function createRetryQueue({ stateDir, maxAttempts = RETRY_DEFAULTS.maxAttempts, now = () => Date.now(), options = {} } = {}) {
  if (!stateDir) throw new TypeError('createRetryQueue 需要 stateDir。');
  const file = join(stateDir, 'retry-queue.jsonl');
  let loaded = null;

  function load() {
    if (loaded) return loaded;
    const map = new Map();
    for (const row of readRows(file)) {
      if (row.type === 'clear') {
        map.clear();
        continue;
      }
      if (!row.videoId) continue;
      const id = String(row.videoId);
      const previous = map.get(id);
      if (row.type === 'enqueue') {
        map.set(id, {
          videoId: id,
          query: row.query || previous?.query || '',
          state: 'pending',
          attempt: Number(row.attempt) || 1,
          code: row.code || previous?.code || null,
          message: row.message || previous?.message || null,
          at: row.at || new Date().toISOString(),
          nextRunAt: row.nextRunAt || null,
        });
      } else if (row.type === 'exhausted') {
        map.set(id, {
          videoId: id,
          query: row.query || previous?.query || '',
          state: 'exhausted',
          attempt: Number(row.attempt) || previous?.attempt || maxAttempts,
          code: row.code || 'RETRY_EXHAUSTED',
          message: row.message || previous?.message || null,
          at: row.at || new Date().toISOString(),
          nextRunAt: null,
        });
      } else if (row.type === 'resolve') {
        map.set(id, {
          videoId: id,
          query: row.query || previous?.query || '',
          state: row.ok === false ? 'pending' : 'resolved',
          attempt: previous?.attempt || Number(row.attempt) || 1,
          code: row.code || previous?.code || null,
          message: row.message || previous?.message || null,
          at: row.at || new Date().toISOString(),
          nextRunAt: null,
          resolvedAt: row.at || new Date().toISOString(),
        });
      }
    }
    loaded = map;
    return map;
  }

  function append(row) {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date(now()).toISOString(), ...row })}\n`, 'utf8');
  }

  /**
   * 失败入队。同一个 videoId 重复入队是幂等的（不叠加 attempt）。
   * @returns {{ok:boolean, videoId:string, attempt:number, exhausted:boolean, nextRunAt:string|null, code?:string}}
   */
  function enqueue({ videoId, query = '', code = null, message = null, force = false } = {}) {
    if (!videoId) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 videoId。', attempt: 0, exhausted: false, nextRunAt: null };
    const id = String(videoId);
    const current = load().get(id);
    const alreadyPending = current?.state === 'pending';
    const attempt = alreadyPending && !force ? current.attempt : (current?.attempt || 0) + 1;
    if (attempt > maxAttempts) {
      // 超限：保持 download_failed，不再排重试；写一条 exhausted 事件让重启后也能看到。
      const record = { ...current, videoId: id, state: 'exhausted', attempt: current?.attempt || maxAttempts };
      append({ type: 'exhausted', videoId: id, query, attempt: record.attempt, code: 'RETRY_EXHAUSTED' });
      load().set(id, { ...record, query, nextRunAt: null, code: 'RETRY_EXHAUSTED' });
      return { ok: false, code: 'RETRY_EXHAUSTED', message: `已重试 ${current?.attempt || maxAttempts} 次，不再自动重试。`, videoId: id, attempt: record.attempt, exhausted: true, nextRunAt: null };
    }
    const delayMs = nextDelay(attempt, options);
    const at = new Date(now()).toISOString();
    const nextRunAt = new Date(now() + delayMs).toISOString();
    if (!alreadyPending || force) {
      append({
        type: 'enqueue',
        videoId: id,
        query,
        attempt,
        code,
        message: String(message ?? '').slice(0, 300) || null,
        delayMs,
        nextRunAt,
      });
    }
    // 同步更新内存视图，避免同一进程里 status() 读到追加前的快照。
    load().set(id, {
      videoId: id,
      query,
      state: 'pending',
      attempt,
      code: code || null,
      message: String(message ?? '').slice(0, 300) || null,
      at,
      nextRunAt,
    });
    return {
      ok: true,
      videoId: id,
      attempt,
      exhausted: false,
      nextRunAt,
      delayMs,
      code: code || null,
    };
  }

  /** 成功（或人工处理）→ 出队。 */
  function resolve(videoId, { ok = true, note = null } = {}) {
    if (!videoId) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 videoId。' };
    const id = String(videoId);
    append({ type: 'resolve', videoId: id, ok: ok !== false, code: note ? String(note).slice(0, 120) : null });
    const current = load().get(id);
    if (current) {
      load().set(id, {
        ...current,
        state: ok === false ? 'pending' : 'resolved',
        resolvedAt: new Date(now()).toISOString(),
        nextRunAt: null,
      });
    }
    return { ok: true, videoId: id };
  }

  function list() {
    return [...load().values()];
  }

  function pending() {
    return list().filter((row) => row.state === 'pending');
  }

  /** 到了重试时间的条目（不在重试前空转）。 */
  function due(at = now()) {
    return pending().filter((row) => {
      const when = Date.parse(row.nextRunAt || '');
      return !Number.isFinite(when) || when <= at;
    });
  }

  function status() {
    const rows = list();
    const pend = rows.filter((row) => row.state === 'pending');
    return {
      file,
      total: rows.length,
      pending: pend.length,
      exhausted: rows.filter((row) => row.state === 'exhausted').length,
      resolved: rows.filter((row) => row.state === 'resolved').length,
      due: due().length,
      maxAttempts,
      entries: pend.slice(0, 20),
    };
  }

  function clear() {
    mkdirSync(stateDir, { recursive: true });
    append({ type: 'clear' });
    loaded = new Map();
    return { ok: true, cleared: true };
  }

  return { file, enqueue, resolve, list, pending, due, status, clear, attemptsOf: (videoId) => load().get(String(videoId)) || null };
}

/** 生成一段可直接写进日志的退避序列（用于自检与文档）。 */
export function describeBackoff({ attempts = 5, base = RETRY_DEFAULTS.base, max = RETRY_DEFAULTS.max } = {}) {
  const out = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) out.push(backoffBase(attempt, { base, max }));
  return out;
}

/** 清空队列文件的便捷函数（设置页“清空重试队列”用；保留文件本身）。 */
export function resetRetryQueue(file) {
  if (!file) return false;
  writeFileSync(file, '', 'utf8');
  return true;
}
