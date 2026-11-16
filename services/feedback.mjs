// feedback.mjs — P2-4 人工评分/标签 + 回流样例。
//
// 边界（很重要）：
//  - 本模块只写 state/feedback.jsonl，**不写样例库、不改画像**；
//  - 回流（加入正/反样例）必须由用户显式点按钮，走 core.reflowFeedback → libraryAdd；
//  - 回流后画像需要手动重建，这里只记时间戳，用 pendingRebuild 让页面提示“待重建”。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FEEDBACK_LIMITS = Object.freeze({
  minScore: 1,
  maxScore: 5,
  maxTags: 8,
  maxTagLength: 24,
  maxNote: 200,
});

function bad(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 归一化标签：去空、去重、截断，最多 8 个。 */
export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,，;；\n]+/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const value = String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, FEEDBACK_LIMITS.maxTagLength);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= FEEDBACK_LIMITS.maxTags) break;
  }
  return out;
}

/** 校验并归一化一条反馈；score 允许 1-5 或 null（未评分）。 */
export function normalizeFeedback({ videoId = '', favorite = false, score = null, tags = [], note = '' } = {}) {
  const id = String(videoId || '').trim();
  if (!id) throw bad('INVALID_ARGUMENT', '需要 videoId。');
  let normalizedScore = null;
  if (score !== null && score !== undefined && score !== '') {
    const number = Number(score);
    if (!Number.isInteger(number) || number < FEEDBACK_LIMITS.minScore || number > FEEDBACK_LIMITS.maxScore) {
      throw bad('INVALID_SCORE', `分数只能是 ${FEEDBACK_LIMITS.minScore}-${FEEDBACK_LIMITS.maxScore} 的整数。`);
    }
    normalizedScore = number;
  }
  if (favorite !== undefined && typeof favorite !== 'boolean') throw bad('INVALID_TYPE', 'favorite 必须是布尔值。');
  return {
    videoId: id,
    favorite: favorite === true,
    score: normalizedScore,
    tags: normalizeTags(tags),
    note: String(note ?? '').slice(0, FEEDBACK_LIMITS.maxNote),
  };
}

/**
 * 反馈存储：一行一条事件，按 videoId 归并（后写覆盖先写）。
 * 事件类型：feedback（评分/标签/收藏）、remove（撤销）、reflow（回流样例）。
 */
export function createFeedbackStore({ stateDir, now = () => Date.now() } = {}) {
  if (!stateDir) throw new TypeError('createFeedbackStore 需要 stateDir。');
  const file = join(stateDir, 'feedback.jsonl');
  let loaded = null;

  function load() {
    if (loaded) return loaded;
    const map = new Map();
    const reflows = [];
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const text = line.trim();
        if (!text) continue;
        let row;
        try {
          row = JSON.parse(text);
        } catch {
          continue;
        }
        if (!row?.videoId) continue;
        const id = String(row.videoId);
        if (row.type === 'remove') {
          map.delete(id);
          continue;
        }
        if (row.type === 'reflow') {
          reflows.push(row);
          const current = map.get(id);
          if (current) map.set(id, { ...current, reflow: { polarity: row.polarity || null, at: row.at || null, ok: row.ok !== false, profileId: row.profileId || null } });
          continue;
        }
        const previous = map.get(id) || { videoId: id, favorite: false, score: null, tags: [], note: '', at: null };
        map.set(id, {
          videoId: id,
          favorite: row.favorite === undefined ? previous.favorite : row.favorite === true,
          score: row.score === undefined ? previous.score : row.score,
          tags: row.tags === undefined ? previous.tags : normalizeTags(row.tags),
          note: row.note === undefined ? previous.note : String(row.note ?? '').slice(0, FEEDBACK_LIMITS.maxNote),
          at: row.at || previous.at,
          reflow: previous.reflow || null,
        });
      }
    }
    loaded = { map, reflows, events: 0 };
    return loaded;
  }

  function append(row) {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date(now()).toISOString(), ...row })}\n`, 'utf8');
  }

  /** 写一条反馈（合并式：只传要改的字段）。 */
  function upsert(input) {
    const value = normalizeFeedback(input);
    const current = load().map.get(value.videoId);
    const merged = {
      ...value,
      favorite: input.favorite === undefined && current ? current.favorite : value.favorite,
      score: input.score === undefined && current ? current.score : value.score,
      tags: input.tags === undefined && current ? current.tags : value.tags,
      note: input.note === undefined && current ? current.note : value.note,
    };
    append({ type: 'feedback', ...merged });
    load().map.set(merged.videoId, { ...merged, at: new Date(now()).toISOString(), reflow: current?.reflow || null });
    return merged;
  }

  function get(videoId) {
    return load().map.get(String(videoId)) || null;
  }

  function list() {
    return [...load().map.values()].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  }

  function remove(videoId) {
    const id = String(videoId || '').trim();
    if (!id) throw bad('INVALID_ARGUMENT', '需要 videoId。');
    append({ type: 'remove', videoId: id });
    load().map.delete(id);
    return { ok: true, videoId: id };
  }

  /** 记一次回流（成功或失败都记，便于页面提示“待重建”）。 */
  function recordReflow({ videoId, polarity = 'positive', profileId = null, ok = true, code = null, message = null } = {}) {
    const id = String(videoId || '').trim();
    if (!id) throw bad('INVALID_ARGUMENT', '需要 videoId。');
    append({ type: 'reflow', videoId: id, polarity, profileId, ok: ok !== false, code, message });
    const current = load().map.get(id);
    if (current) {
      load().map.set(id, { ...current, reflow: { polarity, at: new Date(now()).toISOString(), ok: ok !== false, profileId } });
    }
    load().reflows.push({ videoId: id, polarity, profileId, ok: ok !== false, code, message, at: new Date(now()).toISOString() });
    return { ok: true, videoId: id };
  }

  function reflows() {
    return [...load().reflows];
  }

  /**
   * 回流后有多少条需要重建画像：回流时间晚于画像 updatedAt 的条数。
   * 没有画像或没有 updatedAt 时，只要有回流就算待重建。
   */
  function pendingRebuild({ profileUpdatedAt = null } = {}) {
    const list2 = load().reflows.filter((row) => row.ok !== false);
    if (!profileUpdatedAt) return list2.length;
    const stamp = Date.parse(profileUpdatedAt);
    if (!Number.isFinite(stamp)) return list2.length;
    return list2.filter((row) => {
      const at = Date.parse(row.at || '');
      return !Number.isFinite(at) || at > stamp;
    }).length;
  }

  function summary() {
    const rows = list();
    const byScore = {};
    for (const row of rows) {
      if (row.score) byScore[row.score] = (byScore[row.score] || 0) + 1;
    }
    const tags = {};
    for (const row of rows) for (const tag of row.tags || []) tags[tag] = (tags[tag] || 0) + 1;
    return {
      total: rows.length,
      favorite: rows.filter((row) => row.favorite).length,
      scored: rows.filter((row) => row.score).length,
      byScore,
      tags,
      reflowed: rows.filter((row) => row.reflow && row.reflow.ok !== false).length,
    };
  }

  /** 按分数/标签/收藏筛选（导出与页面共用）。 */
  function filter({ minScore = 0, maxScore = 0, tag = '', favorite = false } = {}) {
    let rows = list();
    const low = Number(minScore) || 0;
    const high = Number(maxScore) || 0;
    if (low > 0) rows = rows.filter((row) => Number(row.score) >= low);
    if (high > 0) rows = rows.filter((row) => Number(row.score) <= high);
    const wanted = String(tag || '').trim().toLowerCase();
    if (wanted) rows = rows.filter((row) => (row.tags || []).some((item) => String(item).toLowerCase() === wanted));
    if (favorite === true) rows = rows.filter((row) => row.favorite === true);
    return rows;
  }

  return { file, upsert, get, list, remove, recordReflow, reflows, pendingRebuild, summary, filter };
}
