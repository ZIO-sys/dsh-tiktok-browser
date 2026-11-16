// dedup.mjs — P2-1 素材去重：8 帧 32×32 灰度 dHash（64 bit hex）+ 文案 token 集 Jaccard。
//
// 判重规则（options 见 DEDUP_DEFAULTS）：
//   1) 两边都有视频哈希：汉明距离 ≤ 6 → 重复；
//      文案 Jaccard ≥ 0.85 且汉明 ≤ 12 → 重复（同素材换文案 → 靠画面兜住）。
//   2) 一边没有视频哈希（没下载/没 ffmpeg/哈希失败）：只看文案，阈值收紧到 ≥ 0.95，避免误杀。
// 只读视频文件，不写库；索引写在 state/dedup-index.jsonl（每个 videoId 一行，读时后写覆盖先写）。

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findFfmpeg } from '../collect/frames.mjs';

export const DEDUP_DEFAULTS = Object.freeze({
  // 汉明距离 ≤ 6 直接判重（64 bit 下约 9% 位差，能容下转码/水印差异）。
  videoDistance: 6,
  // 文案高度相似时的放宽距离。
  relaxedDistance: 12,
  // 文案 Jaccard（token 集）。
  textSimilarity: 0.85,
  // 没有视频哈希时的文案阈值。
  textOnlySimilarity: 0.95,
  frames: 8,
  hashSize: 32,
  gridSize: 8,
});

const HASH_HEX = /^[0-9a-f]{16}$/i;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
const TAG_RE = /[@#][\p{L}\p{N}_.]+/gu;
const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

// 只去真正无信息的词；"match 3 game" 这类数字 token 要留着。
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'im', 'my', 'me', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'his', 'her',
  'do', 'does', 'did', 'so', 'if', 'but', 'not', 'no', 'yes', 'just', 'now', 'new', 'get', 'got',
  'out', 'up', 'off', 'all', 'too', 'very', 'can', 'will', 'would', 'should', 'about', 'into',
  'tiktok', 'fyp', 'foryou', 'foryoupage', 'viral', 'trend', 'trending', 'video', 'shorts',
]);

const BITS_PER_FRAME = 64;

/** NFKC + 去 URL/@提及/#话题/表情 + 小写 + 标点转空格。 */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(URL_RE, ' ')
    .replace(TAG_RE, ' ')
    .replace(EMOJI_RE, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * 文案 → token 集（排序后用空格连接，便于落盘与比较）。
 * 无文案时返回空串。
 */
export function textKey(desc) {
  const normalized = normalizeText(desc);
  if (!normalized) return '';
  const tokens = new Set();
  for (const token of normalized.split(' ')) {
    if (!token) continue;
    if (token.length < 2 && !/[0-9]/.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  return [...tokens].sort().join(' ');
}

function tokenSet(key) {
  if (!key) return new Set();
  return new Set(String(key).split(' ').filter(Boolean));
}

/** 两个 token 集的 Jaccard；任一为空返回 0（无文案不参与判重）。 */
export function jaccard(keyA, keyB) {
  const a = tokenSet(keyA);
  const b = tokenSet(keyB);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

/** 两段文案的相似度（内部先转 token 集）。 */
export function textSimilarity(descA, descB) {
  return jaccard(textKey(descA), textKey(descB));
}

/** 两个 64 bit hex 哈希的汉明距离；任一格式非法返回 null。 */
export function hammingHex(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (!HASH_HEX.test(a) || !HASH_HEX.test(b)) return null;
  let distance = 0;
  for (let i = 0; i < 16; i += 1) {
    distance += POPCOUNT[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  }
  return distance;
}

/**
 * 单帧 32×32 灰度 → 64 bit。
 * 4×4 像素求块均值得到 8×8 网格，每行以行均值为阈值取 8 个 bit（8 行 × 8 = 64）。
 * 返回 0/1 数组（长度 64）。
 */
export function frameBits(gray) {
  const buffer = Buffer.isBuffer(gray) ? gray : Buffer.from(gray || []);
  if (buffer.length < 32 * 32) return null;
  const grid = DEDUP_DEFAULTS.gridSize;
  const cell = DEDUP_DEFAULTS.hashSize / grid; // 4
  const cells = [];
  for (let gy = 0; gy < grid; gy += 1) {
    const row = [];
    for (let gx = 0; gx < grid; gx += 1) {
      let sum = 0;
      for (let y = 0; y < cell; y += 1) {
        const offset = (gy * cell + y) * 32 + gx * cell;
        for (let x = 0; x < cell; x += 1) sum += buffer[offset + x];
      }
      row.push(sum / (cell * cell));
    }
    cells.push(row);
  }
  const bits = [];
  for (let gy = 0; gy < grid; gy += 1) {
    const row = cells[gy];
    const mean = row.reduce((sum, value) => sum + value, 0) / row.length;
    for (let gx = 0; gx < grid; gx += 1) bits.push(row[gx] > mean ? 1 : 0);
  }
  return bits;
}

/** 多帧按位多数表决合成一个 64 bit hex；frames 为空返回 null。 */
export function combineBits(frames) {
  const usable = (frames || []).filter((bits) => Array.isArray(bits) && bits.length === BITS_PER_FRAME);
  if (!usable.length) return null;
  const hex = [];
  for (let nibble = 0; nibble < 16; nibble += 1) {
    let value = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      const index = nibble * 4 + offset;
      let ones = 0;
      for (const bits of usable) if (bits[index]) ones += 1;
      value = (value << 1) | (ones * 2 >= usable.length ? 1 : 0);
    }
    hex.push(value.toString(16));
  }
  return hex.join('');
}

function probeDurationSec(file, ffmpeg) {
  // ffmpeg 把时长写在 stderr；-i 没有输出文件时退出码是 1，所以用 spawnSync 读文本而不是判退出码。
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', file], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** 抽帧时间点：避开首尾，均分 count 个。 */
export function hashTimes(durationSec, count = DEDUP_DEFAULTS.frames) {
  const total = Number(durationSec);
  const safe = Number.isFinite(total) && total > 1 ? total : 10;
  const n = Math.max(1, Math.min(Math.trunc(Number(count) || DEDUP_DEFAULTS.frames), 16));
  const points = [];
  for (let i = 0; i < n; i += 1) {
    const ratio = 0.06 + (0.88 * i) / Math.max(n - 1, 1);
    const value = safe * ratio;
    points.push(Number(Math.min(Math.max(value, 0.2), Math.max(safe - 0.3, 0.2)).toFixed(2)));
  }
  return points;
}

/**
 * 视频指纹：抽 8 帧 → 32×32 灰度 → 64 bit → 多数表决。
 * @returns {{ok:boolean, hash?:string, frameCount?:number, code?:string, message?:string, ffmpeg?:string}}
 */
export function videoHash(file, { frames = DEDUP_DEFAULTS.frames, ffmpeg = null, signal } = {}) {
  if (!file || !existsSync(file)) {
    return { ok: false, code: 'VIDEO_NOT_FOUND', message: '没有本地视频文件。' };
  }
  const bin = ffmpeg || findFfmpeg();
  if (!bin) return { ok: false, code: 'FFMPEG_MISSING', message: '未找到 ffmpeg，无法计算视频指纹。' };
  const duration = probeDurationSec(file, bin);
  const times = hashTimes(duration, frames);
  const collected = [];
  for (const time of times) {
    signal?.throwIfAborted?.();
    try {
      const raw = execFileSync(
        bin,
        ['-y', '-loglevel', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', '-'],
        { timeout: 20_000, maxBuffer: 1 << 20, windowsHide: true },
      );
      const bits = frameBits(raw);
      if (bits) collected.push(bits);
    } catch {
      // 单帧失败不影响其余帧；全部失败才判失败。
    }
  }
  if (!collected.length) {
    return { ok: false, code: 'HASH_FRAME_FAILED', message: '抽帧失败，无法计算视频指纹。', ffmpeg: bin };
  }
  const hash = combineBits(collected);
  if (!hash) return { ok: false, code: 'HASH_BUILD_FAILED', message: '指纹合成失败。', ffmpeg: bin };
  return { ok: true, hash, frameCount: collected.length, ffmpeg: bin };
}

/**
 * 单对候选判重（纯函数）。
 * @param {{videoDistance?:number|null, textSimilarity?:number, textOnlyEligible?:boolean}} input
 * @returns {{duplicate:boolean, reason:string|null}}
 */
export function comparePair({ videoDistance = null, textSimilarity: similarity = 0, textOnlyEligible = true } = {}, options = {}) {
  const opts = { ...DEDUP_DEFAULTS, ...options };
  const textSim = Number(similarity) || 0;
  const distance = Number.isFinite(videoDistance) ? Number(videoDistance) : null;
  if (distance === null) {
    // 没有指纹时最危险：还必须过 textOnlyGuard（同作者 + 时长接近 + 够长），否则不判重。
    if (textOnlyEligible && textSim >= opts.textOnlySimilarity) return { duplicate: true, reason: 'text-only' };
    return { duplicate: false, reason: null };
  }
  if (distance <= opts.videoDistance) return { duplicate: true, reason: 'video' };
  if (textSim >= opts.textSimilarity && distance <= opts.relaxedDistance) return { duplicate: true, reason: 'text+video' };
  return { duplicate: false, reason: null };
}

/**
 * 没有指纹时的额外护栏：必须同作者、时长接近、文案够长。
 * 真实库回放显示，不同视频用同一句模板文案（Jaccard=1）非常常见，只靠文案会误杀。
 * @returns {{ok:boolean, reason:string|null}}
 */
export function textOnlyGuard({ author = '', duration = null, textKey: key = '' } = {}, entry = null, { minTokens = 4, durationTolerance = 2 } = {}) {
  const tokens = String(key || '').split(' ').filter(Boolean);
  if (tokens.length < minTokens) return { ok: false, reason: 'text-too-short' };
  if (!entry) return { ok: false, reason: 'no-entry' };
  const left = String(author || '').trim().toLowerCase();
  const right = String(entry.author || '').trim().toLowerCase();
  if (!left || !right || left !== right) return { ok: false, reason: 'author-mismatch' };
  const a = Number(duration);
  const b = Number(entry.duration);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return { ok: false, reason: 'duration-unknown' };
  if (Math.abs(a - b) > durationTolerance) return { ok: false, reason: 'duration-gap' };
  return { ok: true, reason: null };
}

/** 从 config.dedup 解析出运行参数；enabled 必须显式为 true 才生效。 */
export function resolveDedupOptions(config = {}) {
  const raw = config?.dedup && typeof config.dedup === 'object' ? config.dedup : {};
  const flag = raw.enabled;
  const enabled = flag === true || ['on', 'true', '1'].includes(String(flag ?? '').toLowerCase());
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    enabled,
    videoDistance: number(raw.videoDistance, DEDUP_DEFAULTS.videoDistance),
    relaxedDistance: number(raw.relaxedDistance, DEDUP_DEFAULTS.relaxedDistance),
    textSimilarity: number(raw.textSimilarity, DEDUP_DEFAULTS.textSimilarity),
    textOnlySimilarity: number(raw.textOnlySimilarity, DEDUP_DEFAULTS.textOnlySimilarity),
    frames: number(raw.frames, DEDUP_DEFAULTS.frames),
  };
}

/**
 * 指纹索引：一行一个 videoId，读时后写覆盖先写。
 * 只存 videoId / textKey / hash / at，不存文案原文。
 */
export function createDedupIndex({ stateDir, maxEntries = 2000, options = {} } = {}) {
  if (!stateDir) throw new TypeError('createDedupIndex 需要 stateDir。');
  const file = join(stateDir, 'dedup-index.jsonl');
  let loaded = null;

  function load() {
    if (loaded) return loaded;
    const map = new Map();
    if (existsSync(file)) {
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          const text = line.trim();
          if (!text) continue;
          try {
            const row = JSON.parse(text);
            if (row?.videoId) map.set(String(row.videoId), row);
          } catch {
            // 跳过损坏行
          }
        }
      } catch {
        // 索引读不出来时按空索引处理，不影响采集。
      }
    }
    loaded = map;
    return map;
  }

  function add({ videoId, textKey: key = '', hash = null, author = '', duration = null, at = null } = {}) {
    if (!videoId) return null;
    const row = {
      videoId: String(videoId),
      textKey: String(key || ''),
      hash: HASH_HEX.test(String(hash || '')) ? String(hash).toLowerCase() : null,
      author: String(author || '').slice(0, 80),
      duration: Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : null,
      at: at || new Date().toISOString(),
    };
    if (!row.textKey && !row.hash) return null;
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    load().set(row.videoId, row);
    return row;
  }

  /**
   * 找最像的一条。
   * @returns {{duplicate:boolean, reason:string|null, of:string|null, videoDistance:number|null, textSim:number, entry:object|null, nearest:object|null}}
   */
  function findBest({ textKey: key = '', hash = null, excludeVideoId = null, textOnlyEligible = true } = {}) {
    const opts = { ...DEDUP_DEFAULTS, ...options };
    const entries = [...load().values()];
    const selfId = excludeVideoId ? String(excludeVideoId) : null;
    let best = null;
    for (const row of entries.slice(-maxEntries)) {
      if (selfId && row.videoId === selfId) continue;
      const distance = hash && row.hash ? hammingHex(hash, row.hash) : null;
      const similarity = key && row.textKey ? jaccard(key, row.textKey) : 0;
      if (distance === null && similarity === 0) continue;
      const verdict = comparePair({ videoDistance: distance, textSimilarity: similarity, textOnlyEligible }, opts);
      const candidate = {
        duplicate: verdict.duplicate,
        reason: verdict.reason,
        of: row.videoId,
        videoDistance: distance,
        textSim: Number(similarity.toFixed(4)),
        entry: row,
      };
      if (candidate.duplicate) return candidate;
      // 没命中时保留“最接近”的一条，便于日志排查。
      const rank = (candidate.videoDistance ?? 64) - candidate.textSim * 10;
      if (!best || rank < best.rank) best = { ...candidate, rank };
    }
    if (best) {
      const { rank, ...rest } = best;
      return { ...rest, duplicate: false, reason: null };
    }
    return { duplicate: false, reason: null, of: null, videoDistance: null, textSim: 0, entry: null, nearest: null };
  }

  return {
    file,
    size: () => load().size,
    entries: () => [...load().values()],
    add,
    findBest,
  };
}

/**
 * 采集时给单条候选做判重：pre-download 只用文案（外加同作者/同时长护栏），post-download 带上指纹。
 * @returns {{duplicate:boolean, reason:string|null, of:string|null, videoDistance:number|null, textSim:number, stage:string, guard?:string}}
 */
export function evaluateCandidate({
  desc = '',
  hash = null,
  author = '',
  duration = null,
  index,
  excludeVideoId = null,
  options = {},
  stage = 'pre-download',
} = {}) {
  const key = textKey(desc);
  if (!index) return { duplicate: false, reason: null, of: null, videoDistance: null, textSim: 0, stage };
  // 先找最像的一条，再用护栏决定“没有指纹时能不能仅凭文案判重”。
  const probe = index.findBest({ textKey: key, hash, excludeVideoId, textOnlyEligible: true });
  const guard = hash ? { ok: true, reason: null } : textOnlyGuard({ author, duration, textKey: key }, probe.entry, options);
  const verdict = comparePair(
    { videoDistance: probe.videoDistance, textSimilarity: probe.textSim, textOnlyEligible: guard.ok },
    options,
  );
  return {
    duplicate: verdict.duplicate,
    reason: verdict.reason,
    of: probe.of || null,
    videoDistance: probe.videoDistance,
    textSim: probe.textSim,
    stage,
    guard: guard.reason || 'ok',
  };
}
