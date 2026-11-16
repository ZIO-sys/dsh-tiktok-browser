// export.mjs — P2-2 候选导出 CSV。
//
// 两件事：
//  1) filterCandidateRows：候选筛选的唯一实现，`libraryCandidates` 与导出都调它，
//     保证“CSV 行数 = 设置页筛选结果”不会漂移。
//  2) exportCandidatesCsv：写 exports/candidates-YYYY-MM-DD.csv，UTF-8 BOM，Excel 直接打开不乱码。

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EXPORT_FIELDS = Object.freeze([
  'videoId',
  'url',
  'query',
  'author',
  'desc',
  'duration',
  'status',
  'score',
  'verdict',
  'ruleScore',
  'modelScore',
  'textScore',
  'coverScore',
  'archivedPath',
  'updatedAt',
]);

export const EXPORT_BOM = '\ufeff';

export function formatDateKey(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 候选筛选（唯一实现）。
 * @param {Array<object>} rows store.loadCandidates() 的值
 * @param {{status?:string, query?:string, sinceDays?:number, videoId?:string, maxAgeDays?:number, now?:number}} filter
 *   videoId: 精确检索指定作品（trim + 忽略大小写）。
 *   maxAgeDays: 列表层自动隐藏“首次采集时间早于 N 天”的记录（无 collectedAt 的旧记录回退 updatedAt）；
 *   显式传 videoId 时忽略，便于按 ID 找回旧素材。只影响展示，不删除任何文件或候选数据。
 */
export function filterCandidateRows(rows, { status = '', query = '', sinceDays = 0, videoId = '', maxAgeDays = 0, now = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const wanted = String(status || '').trim();
  const keyword = String(query || '').trim().toLowerCase();
  const wantedVideoId = String(videoId || '').trim().toLowerCase();
  const days = Number(sinceDays);
  const since = Number.isFinite(days) && days > 0 ? now - days * 86_400_000 : null;
  const maxAge = Number(maxAgeDays);
  const hiddenSince = Number.isFinite(maxAge) && maxAge > 0 ? now - maxAge * 86_400_000 : null;

  let matched = list;
  if (wanted && wanted !== 'all') matched = matched.filter((row) => row.status === wanted);
  if (keyword) {
    matched = matched.filter((row) => {
      const haystack = [
        row?.videoId,
        row?.desc,
        row?.query,
        row?.author?.uniqueId,
        row?.author?.nickname,
        ...(Array.isArray(row?.challenges) ? row.challenges : []),
      ].join(' ').toLowerCase();
      return haystack.includes(keyword);
    });
  }
  if (wantedVideoId) {
    matched = matched.filter((row) => String(row?.videoId || '').trim().toLowerCase() === wantedVideoId);
  } else if (hiddenSince !== null) {
    // 自动隐藏：只从列表移除，不动文件与候选数据；时间缺失的记录保守保留。
    // 按首次采集时间判断（collectedAt），老记录没有该字段时回退 updatedAt，
    // 这样重新判定/重新下载刷新 updatedAt 不会让旧素材重新出现在列表里。
    matched = matched.filter((row) => {
      const at = Date.parse(row?.collectedAt || row?.updatedAt || '');
      if (!Number.isFinite(at)) return true;
      return at >= hiddenSince;
    });
  }
  if (since !== null) {
    matched = matched.filter((row) => {
      const at = Date.parse(row?.updatedAt || '');
      return Number.isFinite(at) ? at >= since : false;
    });
  }
  matched.sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')));
  return matched;
}

function numberCell(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? number : '';
}

/** 单行候选 → CSV 字段对象（null/undefined 一律空串）。 */
export function exportRowOf(row) {
  const file = String(row?.archive?.file || '');
  return {
    videoId: row?.videoId ?? '',
    url: row?.url ?? '',
    query: row?.query ?? '',
    author: row?.author?.uniqueId || row?.author?.nickname || '',
    desc: String(row?.desc ?? ''),
    duration: numberCell(row?.duration),
    status: row?.status ?? '',
    score: numberCell(row?.judge?.score),
    verdict: row?.judge?.verdict ?? '',
    ruleScore: numberCell(row?.judge?.ruleScore),
    modelScore: numberCell(row?.judge?.modelScore),
    textScore: numberCell(row?.judge?.textScore),
    coverScore: numberCell(row?.judge?.coverScore),
    archivedPath: file && existsSync(file) ? file : '',
    updatedAt: row?.updatedAt ?? '',
  };
}

/** CSV 单元格转义：含逗号/引号/换行/前后空格时加引号，内部引号翻倍。 */
export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text === '') return '';
  if (/[",\r\n]/.test(text) || text !== text.trim()) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 候选数组 → CSV 文本（不含 BOM）。 */
export function buildCsv(rows, { fields = EXPORT_FIELDS } = {}) {
  const header = fields.map((field) => csvCell(field)).join(',');
  const body = (rows || []).map((row) => fields.map((field) => csvCell(row?.[field])).join(','));
  return [header, ...body].join('\r\n');
}

/**
 * 写导出文件。
 * @returns {{ok:boolean, file:string, rows:number, bytes:number, error?:string}}
 */
export function exportCandidatesCsv({ rows = [], exportsDir, now = new Date(), fields = EXPORT_FIELDS } = {}) {
  if (!exportsDir) throw new TypeError('exportCandidatesCsv 需要 exportsDir。');
  const mapped = rows.map((row) => exportRowOf(row));
  const csv = buildCsv(mapped, { fields });
  mkdirSync(exportsDir, { recursive: true });
  const file = join(exportsDir, `candidates-${formatDateKey(now)}.csv`);
  const body = `${EXPORT_BOM}${csv}\r\n`;
  writeFileSync(file, body, 'utf8');
  return { ok: true, file, rows: mapped.length, bytes: statSync(file).size };
}
