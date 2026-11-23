// library.mjs — M5 样例库：导入样例、抽视觉特征、生成画像、校准阈值。
// 目录结构（设计文档 §4.6）：
//   library/samples/<videoId>.mp4     样例视频（本地副本）
//   library/samples/<videoId>.json    特征与来源（sidecar）
//   library/sample-index.json         索引
//   library/profiles/<profileId>.json 生成的画像卡
// 模型调用复用 judge-model.mjs 的接口解析（同一个 OpenAI 兼容端点）。

import {
  copyFileSync,
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
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { extractFrames, findFfmpeg } from './frames.mjs';
import { parseJsonReply, resolveJudgeApi } from './judge-model.mjs';
import { ruleScore } from './judge-rule.mjs';
import { clearHistory, listVersions, readVersion, writeVersion } from '../services/profile-history.mjs';

const INDEX_VERSION = 1;
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv']);
/** 样例极性：旧索引没有这个字段，一律按 positive 读，不做批量改写。 */
const normalizePolarity = (value) => (value === 'negative' ? 'negative' : 'positive');

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'this', 'that', 'with', 'from', 'are', 'was', 'have', 'has',
  'not', 'but', 'all', 'can', 'will', 'just', 'get', 'out', 'how', 'what', 'when', 'why', 'who',
  'tiktok', 'fyp', 'foryou', 'viral', 'video', 'videos', 'like', 'follow', 'subscribe', 'new',
  'his', 'her', 'him', 'she', 'they', 'them', 'our', 'its', 'my', 'me', 'he', 'we', 'us', 'it',
  'dont', 'does', 'did', 'got', 'now', 'one', 'two', 'way', 'day', 'time', 'people', 'lol', 'pls',
]);

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(join(file, '..'));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/**
 * 反样例 → mustNot：视觉标签优先，其次文案高频词；去重后最多 8 条。
 * 与正样例信号重叠的条目直接丢弃（同一个词既是要又是否定，会让规则分自相矛盾）。
 */
function negativeMustNot({ negatives = [], positiveTags = new Map(), positiveWords = new Map() } = {}) {
  const tagFreq = new Map();
  const wordFreq = new Map();
  for (const sample of negatives) {
    for (const tag of sample.features?.tags || []) {
      const value = String(tag || '').trim();
      if (value.length >= 2) tagFreq.set(value, (tagFreq.get(value) || 0) + 1);
    }
    const text = [
      String(sample.meta?.desc || '').slice(0, 400),
      ...(sample.meta?.challenges || []),
    ].join(' ');
    for (const token of new Set(tokenize(text))) wordFreq.set(token, (wordFreq.get(token) || 0) + 1);
  }
  const overlaps = (value, positive) => positive.has(value) || positive.has(String(value).toLowerCase());
  const isLatin = (token) => /^[a-z0-9]+$/.test(token);
  // 反样例多起来以后，只出现一次的词多半是噪声，要求至少在 2 条反样例里出现。
  const minWordCount = negatives.length >= 3 ? 2 : 1;
  const tags = [...tagFreq.entries()]
    .filter(([tag]) => !overlaps(tag, positiveTags))
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);
  const words = [...wordFreq.entries()]
    .filter(([token, count]) => count >= minWordCount)
    .filter(([token]) => token.length >= 2 && !STOPWORDS.has(token))
    .filter(([token]) => !(isLatin(token) && token.length < 4))
    .filter(([token]) => !overlaps(token, positiveWords))
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token);
  return [...new Set([...tags, ...words])].slice(0, 8);
}

/** 从视频同目录的 sidecar json 读文案信息（下载归档时写入）。 */
export function readSidecarMeta(videoPath) {
  const candidates = [`${videoPath.replace(/\.[^.]+$/, '')}.json`, `${videoPath}.json`];
  for (const file of candidates) {
    const parsed = readJson(file, null);
    if (parsed && typeof parsed === 'object') {
      return {
        desc: typeof parsed.desc === 'string' ? parsed.desc : '',
        author: parsed.author?.uniqueId || parsed.author?.nickname || '',
        nickname: parsed.author?.nickname || '',
        duration: Number(parsed.duration) || 0,
        challenges: Array.isArray(parsed.challenges) ? parsed.challenges.map(String) : [],
        stats: parsed.stats || null,
        url: parsed.url || '',
        query: parsed.query || '',
        source: 'sidecar',
      };
    }
  }
  return null;
}

function makeSampleId(file) {
  const base = basename(file, extname(file));
  return base.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 64) || `sample-${Date.now()}`;
}

/**
 * 让模型描述一组关键帧，返回结构化视觉特征。
 * @returns {Promise<{ok:boolean, features?:object, code?:string, message?:string}>}
 */
export async function describeWithModel({
  frames,
  meta = {},
  api,
  gateway = null,
  budget = null,
  signal,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!Array.isArray(frames) || !frames.length) return { ok: false, code: 'NO_FRAMES', message: '没有可用关键帧。' };

  const prompt = [
    '你在为短视频广告素材建库。请看这些关键帧，用结构化 JSON 描述这条视频。',
    '只输出一个 JSON 对象，不要代码块、不要解释。字段：',
    '{"subjects":["画面里的主体，如 真人/手/宠物/产品/棋盘/UI"],"scene":"场景","style":"风格","colors":"色调","camera":"镜头（手持/固定/特写/第一人称等）","captions":"字幕样式，没有就写 无","hasPerson":true,"hasInteraction":false,"tags":["最多 6 个短标签"]}',
    `视频文案：${String(meta.desc || '').slice(0, 200) || '无'}`,
    `作者：${meta.author || '未知'}；时长：${meta.duration || 0} 秒`,
  ].join('\n');

  const content = [{ type: 'text', text: prompt }];
  for (const frame of frames) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.data || frame.base64}` } });
  }

  if (gateway) {
    const result = await gateway.chat({
      kind: 'vision',
      messages: [{ role: 'user', content }],
      maxTokens: 800,
      temperature: 0.2,
      budget,
      operation: 'sample_describe',
      signal,
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const parsed = parseJsonReply(result.content);
    if (!parsed) return { ok: false, code: 'MODEL_UNPARSABLE', message: '模型回复无法解析为 JSON。' };
    return { ok: true, features: normalizeFeatures(parsed), model: result.model, source: result.source, usage: result.usage };
  }

  const resolved = resolveJudgeApi({ api, env });
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetchImpl(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resolved.apiKey}` },
      body: JSON.stringify({
        model: resolved.model,
        messages: [{ role: 'user', content }],
        temperature: 0.2,
        max_tokens: 800,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, code: 'MODEL_HTTP', message: `模型接口返回 HTTP ${response.status}。` };
    }
    const text = await response.text();
    let reply = '';
    if (text.trimStart().startsWith('data:')) {
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          reply += chunk?.choices?.[0]?.delta?.content || '';
        } catch {
          // 单块解析失败忽略，继续拼接。
        }
      }
    } else {
      const payload = JSON.parse(text);
      reply = payload?.choices?.[0]?.message?.content || '';
    }
    const parsed = parseJsonReply(reply);
    if (!parsed) return { ok: false, code: 'MODEL_UNPARSABLE', message: '模型回复无法解析为 JSON。' };
    return { ok: true, features: normalizeFeatures(parsed) };
  } catch (error) {
    return { ok: false, code: 'MODEL_FAILED', message: `模型调用失败：${error?.message || error}` };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeFeatures(raw) {
  const str = (value) => (typeof value === 'string' ? value.trim() : '');
  const list = (value) => (Array.isArray(value) ? value.map(str).filter(Boolean).slice(0, 8) : []);
  return {
    subjects: list(raw.subjects),
    scene: str(raw.scene),
    style: str(raw.style),
    colors: str(raw.colors),
    camera: str(raw.camera),
    captions: str(raw.captions),
    hasPerson: raw.hasPerson === true,
    hasInteraction: raw.hasInteraction === true,
    tags: list(raw.tags),
  };
}

/** 截断文本，避免单条长文案把提示词撑爆。 */
function truncateText(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 把一条样例的特征压成一行证据，供文本模型参考。 */
function describeSampleEvidence(sample) {
  const features = sample.features || {};
  const parts = [];
  const desc = truncateText(sample.meta?.desc || sample.meta?.title || '', 160);
  if (desc) parts.push(`文案：${desc}`);
  const challenges = (sample.meta?.challenges || []).map((item) => truncateText(item, 40)).filter(Boolean);
  if (challenges.length) parts.push(`话题：${challenges.slice(0, 6).join('、')}`);
  const tags = (features.tags || []).map((tag) => truncateText(tag, 24)).filter(Boolean);
  if (tags.length) parts.push(`视觉标签：${tags.slice(0, 8).join('、')}`);
  if (features.subjects?.length) parts.push(`主体：${features.subjects.slice(0, 4).join('、')}`);
  if (features.scene) parts.push(`场景：${truncateText(features.scene, 40)}`);
  if (features.style) parts.push(`风格：${truncateText(features.style, 40)}`);
  if (features.colors) parts.push(`颜色：${truncateText(features.colors, 40)}`);
  if (features.camera) parts.push(`镜头：${truncateText(features.camera, 40)}`);
  if (features.captions) parts.push(`字幕：${truncateText(features.captions, 40)}`);
  const flags = [];
  if (features.hasPerson) flags.push('有人物');
  if (features.hasInteraction) flags.push('有互动');
  if (flags.length) parts.push(`特征：${flags.join('、')}`);
  return parts.length ? `- ${parts.join('；')}` : '';
}

/** 用文本模型把样例证据合成为画像卡字段；失败时返回 { ok: false }，调用方回退规则结果。 */
async function synthesizeProfileFields({ profile, samples, negatives = [], gateway = null, budget = null, signal } = {}) {
  if (!gateway || typeof gateway.chat !== 'function') {
    return { ok: false, code: 'NO_GATEWAY', message: '未配置文本模型，跳过画像合成。' };
  }
  const positiveEvidence = samples.map(describeSampleEvidence).filter(Boolean).slice(0, 20).join('\n');
  const negativeEvidence = negatives.map(describeSampleEvidence).filter(Boolean).slice(0, 10).join('\n');
  const prompt = [
    '你是短视频素材筛选画像专家。下面是一批正样例（用户想要的素材）和反样例（用户不想要的素材）。',
    '请根据这些证据，为筛选画像生成：keywords（关键词，6-12 个，中文短词）、mustHave（必须包含，3-5 条，每条 4-14 字）、niceToHave（尽量包含，2-4 条）、mustNot（排除项，2-8 条，优先来自反样例）、description（画像描述，80-200 字，说明这类素材的共同特征与筛选标准）。',
    '只输出一个 JSON 对象，不要输出任何解释，不要用 markdown 代码块；回答的第一个字符必须是 {，最后一个字符必须是 }。',
    '',
    `正样例证据（${samples.length} 条）：`,
    positiveEvidence || '（无）',
    '',
    `反样例证据（${negatives.length} 条）：`,
    negativeEvidence || '（无）',
    '',
    `规则版草稿：关键词=${(profile.keywords || []).join('、') || '无'}；必须包含=${(profile.mustHave || []).join('、') || '无'}；尽量包含=${(profile.niceToHave || []).join('、') || '无'}；排除项=${(profile.mustNot || []).join('、') || '无'}`,
  ].join('\n');
  let result = null;
  try {
    result = await gateway.chat({
      kind: 'text',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 4000,
      temperature: 0.2,
      budget,
      operation: 'profile_synthesize',
      signal,
    });
  } catch (error) {
    return { ok: false, code: 'MODEL_FAILED', message: String(error?.message || error) };
  }
  if (!result?.ok) {
    return { ok: false, code: result?.code || 'MODEL_FAILED', message: result?.message || '模型调用失败。' };
  }
  let parsed = parseJsonReply(result.content);
  if (!parsed) {
    // 画像 JSON 没有 score 字段，parseJsonReply 的兜底分支不适用；这里从首个 { 起做括号配平后直接解析。
    const text = String(result.content || '');
    const start = text.indexOf('{');
    if (start >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try { parsed = JSON.parse(text.slice(start, i + 1)); } catch { parsed = null; }
            break;
          }
        }
      }
    }
  }
  if (!parsed) return { ok: false, code: 'MODEL_UNPARSABLE', message: '模型没有返回可解析的 JSON。', model: result.model || null };
  const asList = (value, max) => (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter((item) => item.length >= 2)
    .slice(0, max);
  const fields = {
    keywords: asList(parsed.keywords, 12),
    mustHave: asList(parsed.mustHave, 6),
    niceToHave: asList(parsed.niceToHave, 6),
    mustNot: asList(parsed.mustNot, 8),
    description: String(parsed.description || parsed.guidance || '').trim(),
  };
  if (!fields.keywords.length && !fields.mustHave.length && !fields.description) {
    return { ok: false, code: 'MODEL_UNPARSABLE', message: '模型返回的 JSON 缺少可用字段。', model: result.model || null };
  }
  return { ok: true, fields, model: result.model || null };
}

/**
 * 样例库。
 */
export function createLibrary({ libraryDir, env = process.env, modelGateway = null, budgetFactory = null } = {}) {
  if (!libraryDir) throw new Error('createLibrary 需要 libraryDir');
  const samplesDir = join(libraryDir, 'samples');
  const profilesDir = join(libraryDir, 'profiles');
  const interestDir = join(libraryDir, 'interest-profiles');
  const uploadsDir = join(libraryDir, '.uploads');
  const indexFile = join(libraryDir, 'sample-index.json');
  const stateFile = join(libraryDir, 'library-state.json');
  // 画像历史版本（P1-3）：profiles/.history/<id>/<ISO时间>-<source>.json。
  // 注意：历史工具内部会自己拼 `.history`，这里传的必须是父目录。
  const profilesHistoryRoot = profilesDir;
  const interestHistoryRoot = interestDir;

  function loadState() {
    const parsed = readJson(stateFile, null);
    if (!parsed || typeof parsed !== 'object') return { version: 1, defaultsHidden: false };
    return { ...parsed, defaultsHidden: parsed.defaultsHidden === true };
  }

  function saveState(patch = {}) {
    writeJson(stateFile, { ...loadState(), ...patch, version: 1, updatedAt: new Date().toISOString() });
  }

  function loadIndex() {
    const parsed = readJson(indexFile, null);
    if (!parsed || !Array.isArray(parsed.samples)) return { version: INDEX_VERSION, updatedAt: null, samples: [] };
    return parsed;
  }

  function saveIndex(index) {
    ensureDir(libraryDir);
    writeJson(indexFile, { ...index, version: INDEX_VERSION, updatedAt: new Date().toISOString() });
  }

  /** 把画像快照写入历史版本；失败不阻塞画像本身的保存。 */
  function recordProfileVersion(profile, source) {
    if (!profile || typeof profile !== 'object' || !profile.id) return null;
    try {
      const result = writeVersion({ rootDir: profilesHistoryRoot, id: profile.id, source, data: profile });
      return result.ok ? result : null;
    } catch {
      return null;
    }
  }

  function listProfileHistory({ profileId = '', limit = 20 } = {}) {
    return listVersions({ rootDir: profilesHistoryRoot, id: profileId, limit });
  }

  /** 恢复到某个历史版本：先把当前文件写进历史（source=restore），再原子替换画像文件。 */
  function restoreProfile({ profileId = '', version = '' } = {}) {
    const id = String(profileId || '').trim();
    if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(id)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '画像 ID 不合法。' };
    }
    const target = readVersion({ rootDir: profilesHistoryRoot, id, version });
    if (!target.ok) return target;
    if (target.data.id !== id) {
      return { ok: false, code: 'PROFILE_CORRUPTED', message: `版本 ${version} 的画像 ID 与目标不一致。` };
    }
    const file = join(profilesDir, `${id}.json`);
    const current = readJson(file, null);
    if (current && current.id === id) recordProfileVersion(current, 'restore');
    const now = new Date().toISOString();
    const next = { ...target.data, restoredAt: now, updatedAt: now };
    writeJson(file, next);
    return { ok: true, profile: next, version: target.version, restoredAt: now };
  }

  function listSamples({ limit = 100, profileId = null, polarity = null } = {}) {
    const index = loadIndex();
    let rows = profileId ? index.samples.filter((row) => row.profileId === profileId) : index.samples;
    if (polarity === 'positive' || polarity === 'negative') {
      rows = rows.filter((row) => normalizePolarity(row.polarity) === polarity);
    }
    return rows.slice(0, Math.max(1, Number(limit) || 100));
  }

  function countSamples({ profileId = null, polarity = null } = {}) {
    return listSamples({ limit: 100_000, profileId, polarity }).length;
  }

  /** 切换单条样例的正/反极性，同步索引与 sidecar。 */
  function setSamplePolarity({ sampleId = '', polarity = '' } = {}) {
    const id = String(sampleId || '').trim();
    const next = String(polarity || '').trim();
    if (!id) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 sampleId。' };
    if (next !== 'positive' && next !== 'negative') {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'polarity 只能是 positive 或 negative。' };
    }
    const index = loadIndex();
    const row = index.samples.find((item) => item.sampleId === id || String(item.videoId) === id);
    if (!row) return { ok: false, code: 'NOT_FOUND', message: `没有样例 ${id}。` };
    row.polarity = next;
    row.polarityUpdatedAt = new Date().toISOString();
    saveIndex(index);
    // sidecar 与索引保持一致，避免重装/重建索引时丢失极性。
    try {
      writeJson(join(samplesDir, `${row.sampleId}.json`), row);
    } catch {
      // sidecar 写失败不影响索引生效。
    }
    return { ok: true, sampleId: row.sampleId, polarity: next, sample: row };
  }

  /** 导入一条本地视频作为样例。polarity=negative 表示“不想要的素材”。 */
  async function addSample({ file, profileId = null, query = '', meta = null, describe = true, polarity = 'positive', signal } = {}) {
    if (!file || !existsSync(file)) {
      return { ok: false, code: 'FILE_NOT_FOUND', message: `找不到文件：${file}` };
    }
    const ext = extname(file).toLowerCase();
    if (!VIDEO_EXT.has(ext)) {
      return { ok: false, code: 'UNSUPPORTED_FORMAT', message: `不支持的格式 ${ext || '(无扩展名)'}，仅支持 mp4/mov/webm/mkv。` };
    }
    const sampleId = makeSampleId(file);
    ensureDir(samplesDir);
    const destVideo = join(samplesDir, `${sampleId}${ext}`);
    if (!existsSync(destVideo)) copyFileSync(file, destVideo);

    const sidecar = meta || readSidecarMeta(file) || {};
    const size = statSync(destVideo).size;

    let features = null;
    let featureError = null;
    if (describe) {
      const ffmpeg = findFfmpeg({ env });
      if (!ffmpeg) {
        featureError = { code: 'NO_FFMPEG', message: '找不到 ffmpeg，跳过视觉特征抽取。' };
      } else {
        const frameResult = await extractFrames(destVideo, {
          durationSec: Number(sidecar.duration) || 20,
          count: 3,
          tmpDir: join(libraryDir, '.tmp'),
          ffmpeg,
          signal,
        });
        const frames = frameResult?.frames || [];
        if (!frames.length) {
          featureError = {
            code: frameResult?.code || 'NO_FRAMES',
            message: frameResult?.message || '关键帧抽取失败。',
          };
        } else {
          const described = await describeWithModel({
            frames,
            meta: sidecar,
            signal,
            env,
            gateway: modelGateway,
            budget: typeof budgetFactory === 'function' ? budgetFactory() : null,
          });
          if (described.ok) features = described.features;
          else featureError = { code: described.code, message: described.message };
        }
      }
    }

    const record = {
      sampleId,
      videoId: String(sidecar.videoId || sampleId),
      file: destVideo,
      bytes: size,
      addedAt: new Date().toISOString(),
      profileId: profileId || null,
      polarity: normalizePolarity(polarity),
      query: query || sidecar.query || '',
      meta: {
        desc: sidecar.desc || '',
        author: sidecar.author || '',
        nickname: sidecar.nickname || '',
        duration: Number(sidecar.duration) || 0,
        challenges: Array.isArray(sidecar.challenges) ? sidecar.challenges : [],
        stats: sidecar.stats || null,
        url: sidecar.url || '',
      },
      features,
      featureError,
    };

    writeJson(join(samplesDir, `${sampleId}.json`), record);
    const index = loadIndex();
    const existing = index.samples.findIndex((row) => row.sampleId === sampleId);
    if (existing >= 0) index.samples[existing] = record;
    else index.samples.push(record);
    saveIndex(index);

    return { ok: true, sample: record, featureError };
  }

  /**
   * 删除一条样例：索引、sidecar 与库内视频副本一起删。
   * 只删 samples/ 目录内的真实文件（resolve + relative 校验），索引被改坏时也不会误删库外文件。
   */
  function removeSample({ sampleId = '' } = {}) {
    const id = String(sampleId || '').trim();
    if (!id) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 sampleId。' };
    const index = loadIndex();
    const row = index.samples.find((item) => item.sampleId === id || String(item.videoId) === id);
    if (!row) return { ok: false, code: 'NOT_FOUND', message: `没有样例 ${id}` };
    index.samples = index.samples.filter((item) => item !== row);
    saveIndex(index);

    const baseDir = resolve(samplesDir);
    const targets = [row.file, join(samplesDir, `${row.sampleId}.json`)];
    const removedFiles = [];
    for (const target of targets) {
      if (!target) continue;
      const resolved = resolve(String(target));
      const rel = relative(baseDir, resolved);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      try {
        if (existsSync(resolved)) {
          unlinkSync(resolved);
          removedFiles.push(resolved);
        }
      } catch {
        // 单个文件删不掉不影响索引已删；下次清空样例时会再扫一次。
      }
    }
    return { ok: true, removed: 1, sampleId: row.sampleId, files: removedFiles };
  }

  /**
   * 删除一张素材筛选画像：画像 JSON、该画像的历史版本，以及归属该画像的全部样例
   * （索引项、sidecar 与库内视频副本）一起删，不可恢复。
   * 只删 samples/ 与 profiles/ 目录内的真实文件（resolve + relative 校验）。
   */
  function removeProfile({ profileId = '' } = {}) {
    const id = String(profileId || '').trim();
    if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(id)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '画像 ID 不合法。' };
    }
    const file = join(profilesDir, `${id}.json`);
    const current = readJson(file, null);
    if (!current || current.id !== id) {
      return { ok: false, code: 'NOT_FOUND', message: `没有素材筛选画像 ${id}。` };
    }

    const index = loadIndex();
    const rows = index.samples.filter((item) => item.profileId === id);
    index.samples = index.samples.filter((item) => item.profileId !== id);
    saveIndex(index);

    const baseDir = resolve(samplesDir);
    const removedFiles = [];
    const errors = [];
    for (const row of rows) {
      const targets = [row.file, join(samplesDir, `${row.sampleId}.json`)];
      for (const target of targets) {
        if (!target) continue;
        const resolved = resolve(String(target));
        const rel = relative(baseDir, resolved);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
        try {
          if (existsSync(resolved)) {
            unlinkSync(resolved);
            removedFiles.push(resolved);
          }
        } catch (error) {
          errors.push({ file: resolved, message: String(error?.message || error) });
        }
      }
    }

    try {
      unlinkSync(file);
    } catch (error) {
      errors.push({ file, message: String(error?.message || error) });
    }
    const historyDir = join(profilesDir, '.history', id);
    try {
      rmSync(historyDir, { recursive: true, force: true });
    } catch (error) {
      errors.push({ file: historyDir, message: String(error?.message || error) });
    }

    return { ok: true, profileId: id, removedSamples: rows.length, removedFiles, errors };
  }

  function countUnassigned() {
    return loadIndex().samples.filter((row) => !row.profileId).length;
  }

  /** 把“未指定归属”的样例整体归入某个画像，返回迁移条数。 */
  function assignUnassigned(profileId) {
    const id = String(profileId || '').trim();
    if (!id) return 0;
    const index = loadIndex();
    let moved = 0;
    for (const row of index.samples) {
      if (!row.profileId) {
        row.profileId = id;
        moved += 1;
      }
    }
    if (moved) saveIndex(index);
    return moved;
  }

  /**
   * 清空样例与画像。删除前把索引和画像 JSON 备份到 library/backups/purge-<时间>/，
   * 并写 manifest（含视频路径与体积），视频副本本身不复制，避免再占一份空间。
   */
  function purge({ backup = true } = {}) {
    const index = loadIndex();
    const profileFiles = readdirSyncSafe(profilesDir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => join(profilesDir, entry));
    const interestFiles = readdirSyncSafe(interestDir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => join(interestDir, entry));

    const sampleFiles = new Set();
    for (const row of index.samples) if (row?.file) sampleFiles.add(String(row.file));
    for (const entry of readdirSyncSafe(samplesDir)) sampleFiles.add(join(samplesDir, entry));

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = join(libraryDir, 'backups', `purge-${stamp}`);
    if (backup) {
      ensureDir(backupDir);
      for (const file of [...profileFiles, ...interestFiles, indexFile]) {
        try {
          if (existsSync(file)) copyFileSync(file, join(backupDir, basename(file)));
        } catch {}
      }
    }

    const removedFiles = [];
    const errors = [];
    let removedBytes = 0;
    const removeFile = (file) => {
      try {
        if (!existsSync(file)) return false;
        const stat = statSync(file);
        if (!stat.isFile()) return false;
        unlinkSync(file);
        removedFiles.push({ file, bytes: stat.size });
        removedBytes += stat.size;
        return true;
      } catch (error) {
        if (errors.length < 20) errors.push({ file, code: error?.code || null, message: error?.message || String(error) });
        return false;
      }
    };

    // 先删索引与画像，保证即使视频被占用，画像库也已经回到干净状态。
    let removedProfiles = 0;
    for (const file of profileFiles) if (removeFile(file)) removedProfiles += 1;
    let removedInterestProfiles = 0;
    for (const file of interestFiles) if (removeFile(file)) removedInterestProfiles += 1;
    // 历史版本不单独保留：清空库时一并删除，只把文件名记进 manifest 供事后核对。
    const historyFiles = [...clearHistory(profilesHistoryRoot), ...clearHistory(interestHistoryRoot)];
    removeFile(indexFile);

    // 先删 sidecar，再删视频，最后清理上传临时目录。
    const ordered = [...sampleFiles].sort((left, right) => Number(/\.mp4$/i.test(left)) - Number(/\.mp4$/i.test(right)));
    const removedSidecars = ordered.filter((file) => !/\.mp4$/i.test(file) && removeFile(file)).length;
    const removedVideos = ordered.filter((file) => /\.mp4$/i.test(file) && removeFile(file)).length;

    for (const entry of readdirSyncSafe(uploadsDir)) {
      try { rmSync(join(uploadsDir, entry), { recursive: true, force: true }); } catch {}
    }

    const manifest = {
      purgedAt: new Date().toISOString(),
      libraryDir,
      samples: index.samples.map((row) => ({
        sampleId: row.sampleId,
        videoId: row.videoId || null,
        profileId: row.profileId || null,
        file: row.file || null,
        bytes: Number(row.bytes) || 0,
        desc: String(row.meta?.desc || '').slice(0, 160),
      })),
      profiles: profileFiles.map((file) => basename(file)),
      interestProfiles: interestFiles.map((file) => basename(file)),
      history: historyFiles,
      removedFiles,
      removedBytes,
      errors,
      remainingSampleFiles: readdirSyncSafe(samplesDir).length,
    };
    if (backup) writeJson(join(backupDir, 'manifest.json'), manifest);

    saveState({ defaultsHidden: true });
    return {
      ok: errors.length === 0,
      removedSamples: manifest.samples.length,
      removedSampleFiles: removedSidecars + removedVideos,
      removedVideos,
      removedSidecars,
      removedProfiles,
      removedInterestProfiles,
      removedHistory: historyFiles.length,
      removedBytes,
      remainingSampleFiles: manifest.remainingSampleFiles,
      errors,
      backupDir: backup ? backupDir : null,
      defaultsHidden: true,
    };
  }

  function restoreDefaultProfiles() {
    saveState({ defaultsHidden: false });
    return { ok: true, defaultsHidden: false };
  }

  /**
   * 修改已生成的素材筛选画像（名称、阈值、描述、关键词与 must/nice/mustNot）。
   * 只允许编辑白名单字段，id 与 sampleCount 不在此接口内变更。
   */
  function updateProfile({ profileId = '', patch = {} } = {}) {
    const id = String(profileId || '').trim();
    if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(id)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '画像 ID 不合法。' };
    }
    const file = join(profilesDir, `${id}.json`);
    const current = readJson(file, null);
    if (!current || current.id !== id) {
      return { ok: false, code: 'NOT_FOUND', message: `没有素材筛选画像 ${id}。` };
    }
    const next = { ...current };
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      const name = String(patch.name || '').trim().slice(0, 80);
      if (!name) return { ok: false, code: 'INVALID_ARGUMENT', message: '画像名称不能为空。' };
      next.name = name;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'threshold')) {
      const threshold = Number(patch.threshold);
      if (!Number.isFinite(threshold)) return { ok: false, code: 'INVALID_ARGUMENT', message: '阈值必须是 0-100 的数字。' };
      next.threshold = Math.max(0, Math.min(100, Math.round(threshold)));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'guidance')) {
      next.guidance = String(patch.guidance || '').slice(0, 4000);
    }
    for (const key of ['keywords', 'mustHave', 'niceToHave', 'mustNot']) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const value = patch[key];
      if (!Array.isArray(value)) return { ok: false, code: 'INVALID_ARGUMENT', message: `${key} 必须是字符串数组。` };
      next[key] = value
        .map((item) => String(item || '').trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 40);
    }
    next.updatedAt = new Date().toISOString();
    recordProfileVersion(current, 'edit');
    writeJson(file, next);
    return { ok: true, profile: next };
  }

  function listProfiles() {
    const out = [];
    for (const entry of readdirSyncSafe(profilesDir)) {
      if (!entry.endsWith('.json')) continue;
      const parsed = readJson(join(profilesDir, entry), null);
      if (parsed && parsed.id) out.push(parsed);
    }
    return out;
  }

  /**
   * 从样例聚合生成画像卡：正样例决定“要什么”，反样例只贡献 mustNot。
   * 生成前会对缺少视觉特征的样例补抽帧+视觉描述（backfill），生成后用文本模型合成画像字段（synthesize）。
   * @param {{profileId:string, name?:string, threshold?:number, minSamples?:number,
   *   gateway?:object, modelEnv?:object, budgetFactory?:Function, signal?:AbortSignal,
   *   backfill?:boolean, synthesize?:boolean}} opts
   */
  async function buildProfile({
    profileId,
    name = null,
    threshold = null,
    minSamples = 3,
    gateway = modelGateway,
    modelEnv = env,
    budgetFactory: budgetFactoryOption = budgetFactory,
    signal = undefined,
    backfill = true,
    synthesize = true,
  } = {}) {
    if (!profileId) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 profileId。' };
    const all = listSamples({ limit: 1000, profileId });
    const samples = all.filter((sample) => normalizePolarity(sample.polarity) === 'positive');
    const negatives = all.filter((sample) => normalizePolarity(sample.polarity) === 'negative');
    if (samples.length < minSamples) {
      return {
        ok: false,
        code: 'NOT_ENOUGH_SAMPLES',
        message: `正样例不足：${samples.length} 条，至少需要 ${minSamples} 条（另有反样例 ${negatives.length} 条，不计入）。`,
        positiveCount: samples.length,
        negativeCount: negatives.length,
      };
    }

    // B：生成画像前，对缺少视觉特征的样例补抽帧 + 视觉描述（失败也记录原因，供 D 段写进描述）。
    const backfillReport = {
      enabled: Boolean(backfill && gateway && typeof gateway.chat === 'function'),
      attempted: 0,
      filled: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };
    if (backfillReport.enabled) {
      const missing = all.filter((sample) => !sample.features);
      const ffmpeg = findFfmpeg({ env: modelEnv });
      if (!ffmpeg) {
        backfillReport.skipped = missing.length;
        backfillReport.errors.push({ code: 'NO_FFMPEG', message: '找不到 ffmpeg，跳过补抽帧。' });
      } else if (missing.length) {
        const index = loadIndex();
        const budget = typeof budgetFactoryOption === 'function' ? budgetFactoryOption() : null;
        for (const sample of missing) {
          backfillReport.attempted += 1;
          try {
            const videoPath = isAbsolute(sample.file) ? sample.file : join(libraryDir, sample.file);
            if (!existsSync(videoPath)) throw new Error(`样例视频不存在：${videoPath}`);
            const frameResult = await extractFrames(videoPath, {
              durationSec: Number(sample.meta?.duration) || 20,
              count: 3,
              tmpDir: join(libraryDir, '.tmp'),
              ffmpeg,
              signal,
            });
            const frames = frameResult?.frames || [];
            if (!frames.length) {
              throw new Error(frameResult?.message || frameResult?.code || '抽帧失败。');
            }
            const described = await describeWithModel({
              frames,
              meta: sample.meta || {},
              signal,
              env: modelEnv,
              gateway,
              budget,
            });
            if (!described.ok) {
              throw Object.assign(new Error(described.message || '视觉描述失败。'), { code: described.code });
            }
            sample.features = described.features;
            sample.featureModel = described.model || null;
            sample.featureError = null;
            backfillReport.filled += 1;
          } catch (error) {
            sample.featureError = {
              code: error?.code || 'BACKFILL_FAILED',
              message: String(error?.message || error || '补抽帧失败。'),
            };
            backfillReport.failed += 1;
            backfillReport.errors.push({ sampleId: sample.sampleId, code: sample.featureError.code, message: sample.featureError.message });
          }
          writeJson(join(samplesDir, `${sample.sampleId}.json`), sample);
          const row = (index.samples || []).find((item) => item.sampleId === sample.sampleId);
          if (row) {
            row.features = sample.features;
            row.featureModel = sample.featureModel || null;
            row.featureError = sample.featureError;
          }
        }
        saveIndex(index);
      }
    }

    const freq = new Map();
    const tagFreq = new Map();
    let person = 0;
    let interaction = 0;
    let withFeatures = 0;
    for (const sample of samples) {
      // 单条样例的描述可能极长（部分 TikTok 文案上千字），先截断，避免一个样本主导词频。
      const text = [
        String(sample.meta?.desc || '').slice(0, 400),
        ...(sample.meta?.challenges || []),
        ...(sample.features?.tags || []),
      ].join(' ');
      // 用"文档频次"统计：同一条样例内重复出现的词只计一次。
      for (const token of new Set(tokenize(text))) freq.set(token, (freq.get(token) || 0) + 1);
      if (sample.features) {
        withFeatures += 1;
        if (sample.features.hasPerson) person += 1;
        if (sample.features.hasInteraction) interaction += 1;
        for (const tag of sample.features.tags || []) tagFreq.set(tag, (tagFreq.get(tag) || 0) + 1);
      }
    }

    // 关键词优先取视觉标签（模型产出的中文标签最能代表这一类素材），
    // 再用"出现在至少 minCount 条样例里"的文本词补充，避免单条长文案把噪声词顶上榜。
    const minCount = samples.length >= 6 ? 2 : 1;
    const isLatin = (token) => /^[a-z0-9]+$/.test(token);
    const tagKeywords = [...tagFreq.entries()]
      .filter(([tag]) => String(tag).length >= 2 && !STOPWORDS.has(tag))
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);
    const textKeywords = [...freq.entries()]
      .filter(([token, count]) => {
        if (token.length < 2) return false;
        if (STOPWORDS.has(token)) return false;
        if (count < minCount) return false;
        if (isLatin(token) && token.length < 4) return false;
        return true;
      })
      .sort((a, b) => b[1] - a[1])
      .map(([token]) => token);
    const keywords = [...new Set([...tagKeywords, ...textKeywords])].slice(0, 12);

    const topTags = [...tagFreq.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
    const mustHave = [];
    if (withFeatures && person / withFeatures >= 0.6) mustHave.push('真人出镜');
    if (withFeatures && interaction / withFeatures >= 0.4) mustHave.push('互动玩法');
    for (const tag of topTags) {
      if (mustHave.length >= 4) break;
      if (!mustHave.includes(tag)) mustHave.push(tag);
    }
    // 视觉特征缺失时退回用高频关键词，避免画像卡 mustHave 为空。
    if (!mustHave.length) mustHave.push(...keywords.slice(0, 3));
    const niceToHave = topTags.filter((tag) => !mustHave.includes(tag)).slice(0, 4);

    // 反样例只影响 mustNot：视觉标签优先，其次文案词；与正样例信号重叠的条目直接丢弃，
    // 否则一个同时出现在正/反样例里的词会把整类素材一票否决。
    const mustNot = negativeMustNot({ negatives, positiveTags: tagFreq, positiveWords: freq });
    const negativeNote = negatives.length
      ? ` 反样例特征：${mustNot.slice(0, 6).join('、') || '无明显特征'}（来自 ${negatives.length} 条反样例，判定时作为否定项）。`
      : '';

    // D：把补抽帧失败的原因写进画像描述，避免用户以为画像“凭空变空”。
    const failedSamples = all.filter((sample) => sample.featureError);
    const failureNote = failedSamples.length
      ? ` 视觉特征缺失 ${failedSamples.length} 条：${[...new Set(failedSamples.map((sample) => String(sample.featureError?.message || sample.featureError?.code || '未知原因').slice(0, 60)))].slice(0, 3).join('；')}。`
      : '';
    const baseGuidance = `从 ${samples.length} 条正样例自动生成：常见关键词 ${keywords.slice(0, 6).join('、') || '无'}；视觉标签 ${topTags.slice(0, 6).join('、') || '无'}。${negativeNote}`;

    const profile = {
      id: profileId,
      name: name || `${profileId}（自动生成）`,
      keywords,
      mustHave,
      niceToHave,
      mustNot,
      guidance: `${baseGuidance}${failureNote}`,
      threshold: Number(threshold) || 60,
      generated: true,
      generatedAt: new Date().toISOString(),
      sampleCount: samples.length,
      negativeCount: negatives.length,
    };

    // C：用文本模型把样例证据合成为画像字段；失败时保留规则版结果，只记录原因。
    const synthesis = { ok: false, model: null, code: null, message: null };
    if (synthesize && gateway && typeof gateway.chat === 'function') {
      const synthesized = await synthesizeProfileFields({
        profile,
        samples,
        negatives,
        gateway,
        budget: typeof budgetFactoryOption === 'function' ? budgetFactoryOption() : null,
        signal,
      });
      if (synthesized.ok) {
        const fields = synthesized.fields || {};
        if (fields.keywords?.length) profile.keywords = fields.keywords.slice(0, 12);
        if (fields.mustHave?.length) profile.mustHave = fields.mustHave.slice(0, 6);
        if (fields.niceToHave?.length) profile.niceToHave = fields.niceToHave.slice(0, 6);
        if (fields.mustNot?.length) {
          profile.mustNot = [...new Set([...fields.mustNot, ...(profile.mustNot || [])])].slice(0, 8);
        }
        profile.guidance = `${fields.description || baseGuidance}${negativeNote}${failureNote}`;
        synthesis.ok = true;
        synthesis.model = synthesized.model || null;
      } else {
        synthesis.code = synthesized.code || 'MODEL_FAILED';
        synthesis.message = synthesized.message || '画像合成失败。';
      }
    }
    profile.synthesis = { ok: synthesis.ok, model: synthesis.model, code: synthesis.code };
    profile.backfill = {
      attempted: backfillReport.attempted,
      filled: backfillReport.filled,
      failed: backfillReport.failed,
      skipped: backfillReport.skipped,
    };

    const calibration = calibrate({ profile, samples, negatives });
    profile.threshold = Number(threshold) || calibration.threshold;

    ensureDir(profilesDir);
    const file = join(profilesDir, `${profileId}.json`);
    // 重新生成前把旧画像存进历史（source=build），方便回滚到上一版。
    const previous = readJson(file, null);
    if (previous && previous.id === profileId) recordProfileVersion(previous, 'build');
    writeJson(file, profile);
    return { ok: true, profile, calibration, backfill: backfillReport, synthesis };
  }

  /**
   * 用样例的规则分分布校准阈值。
   * - 有反样例：找“正样例通过率 ≥ acceptRatio 且反样例通过最少”的分界；
   * - 没有反样例：沿用原来的分位数逻辑（默认约 80% 正样例通过）。
   */
  function calibrate({ profile, samples, negatives = null, acceptRatio = 0.8 } = {}) {
    const pool = samples || listSamples({ limit: 1000, profileId: profile?.id, polarity: 'positive' });
    const negativePool = negatives
      || (profile?.id ? listSamples({ limit: 1000, profileId: profile.id, polarity: 'negative' }) : []);
    // 没有文案/话题的样例，规则分恒等于基线 50，会把校准阈值直接压到 50；
    // 因此只用"有文本信号"的样例参与校准，不足 3 条时退回全部样例（再由分布检查兜底）。
    const withText = pool.filter(
      (sample) => String(sample.meta?.desc || '').trim() || (sample.meta?.challenges || []).length > 0,
    );
    const scoreOf = (sample) => ruleScore(
      {
        desc: sample.meta?.desc || '',
        author: { uniqueId: sample.meta?.author || '' },
        challenges: sample.meta?.challenges || [],
        duration: sample.meta?.duration || 0,
      },
      profile,
    ).ruleScore;
    const rows = (withText.length >= 3 ? withText : pool).map(scoreOf);
    const negativeRows = negativePool.map(scoreOf);
    rows.sort((a, b) => a - b);
    const n = rows.length;
    const min = n ? rows[0] : null;
    const max = n ? rows[n - 1] : null;
    const median = n ? rows[Math.floor(n / 2)] : null;
    const rate = (list, at) => (list.length
      ? Math.round((list.filter((value) => value >= at).length / list.length) * 1000) / 1000
      : null);

    // 有反样例时优先用它定分界：先保证正样例通过率，再让反样例通过最少，
    // 同分时把阈值放在“最低通过正样例”和“最高未通过反样例”的中间，留出两侧余量。
    if (n && negativeRows.length) {
      // 小样本不降阈值，只允许收紧，避免三五条样例把门槛压穿。
      const floor = n >= 10 ? 45 : Math.max(55, Number(profile?.threshold) || 60);
      let best = null;
      for (let at = floor; at <= 75; at += 1) {
        const positivePass = rate(rows, at);
        if (positivePass < acceptRatio) continue;
        const negativePass = rate(negativeRows, at);
        const passing = rows.filter((value) => value >= at);
        const failing = negativeRows.filter((value) => value < at);
        const gap = passing.length && failing.length
          ? (passing[0] + Math.max(...failing)) / 2
          : at;
        const candidate = { threshold: at, positivePass, negativePass, distance: Math.abs(at - gap) };
        const better = !best
          || candidate.negativePass < best.negativePass - 1e-9
          || (Math.abs(candidate.negativePass - best.negativePass) < 1e-9
            && (candidate.positivePass > best.positivePass + 1e-9
              || (Math.abs(candidate.positivePass - best.positivePass) < 1e-9
                && (candidate.distance < best.distance - 1e-9
                  || (Math.abs(candidate.distance - best.distance) < 1e-9 && candidate.threshold < best.threshold)))));
        if (better) best = candidate;
      }
      if (best) {
        return {
          threshold: best.threshold,
          acceptRatio,
          samples: n,
          negatives: negativeRows.length,
          positivePass: best.positivePass,
          negativePass: best.negativePass,
          mode: 'negatives',
          min,
          max,
          median,
        };
      }
    }

    const idx = Math.max(0, Math.min(n - 1, Math.floor(n * (1 - acceptRatio))));
    const raw = n ? rows[idx] : 60;
    const spread = n ? rows[n - 1] - rows[0] : 0;
    // 样例规则分没有区分度（例如本地样例没有文案/话题）时，校准会把阈值压到基线，
    // 反而失去筛选能力 —— 此时保留画像卡自身阈值。
    if (spread < 10) {
      const kept = Number(profile?.threshold) || 60;
      return {
        threshold: kept,
        acceptRatio,
        samples: n,
        negatives: negativeRows.length,
        positivePass: rate(rows, kept),
        negativePass: rate(negativeRows, kept),
        min,
        max,
        median,
        skipped: true,
        mode: 'percentile',
        reason: '样例规则分分布过窄，保留原阈值。',
      };
    }
    // 样本太少（<10 条有文案信号）时校准结果不稳定，不允许把阈值降到画像默认值以下。
    const floor = n >= 10 ? 45 : Number(profile?.threshold) || 60;
    const threshold = Math.max(floor, Math.min(75, Math.round(raw)));
    return {
      threshold,
      acceptRatio,
      samples: n,
      negatives: negativeRows.length,
      positivePass: rate(rows, threshold),
      negativePass: rate(negativeRows, threshold),
      mode: 'percentile',
      min,
      max,
      median,
    };
  }

  return {
    libraryDir,
    samplesDir,
    profilesDir,
    loadIndex,
    loadState,
    listSamples,
    countSamples,
    addSample,
    removeSample,
    removeProfile,
    setSamplePolarity,
    countUnassigned,
    assignUnassigned,
    purge,
    restoreDefaultProfiles,
    listProfiles,
    buildProfile,
    updateProfile,
    listProfileHistory,
    restoreProfile,
    calibrate,
  };
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 读取 library/profiles 下自动生成的画像卡，供 profiles.mjs 合并。 */
export function loadGeneratedProfiles(libraryDir) {
  if (!libraryDir) return [];
  const dir = join(libraryDir, 'profiles');
  const out = [];
  for (const entry of readdirSyncSafe(dir)) {
    if (!entry.endsWith('.json')) continue;
    const parsed = readJson(join(dir, entry), null);
    if (parsed && typeof parsed.id === 'string' && parsed.id) out.push(parsed);
  }
  return out;
}

/** 清空画像库后是否隐藏代码内置的两张默认画像卡。 */
export function areDefaultProfilesHidden(libraryDir) {
  if (!libraryDir) return false;
  const parsed = readJson(join(libraryDir, 'library-state.json'), null);
  return parsed?.defaultsHidden === true;
}
