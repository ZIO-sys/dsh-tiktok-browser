// judge-model.mjs — 用 OpenAI 兼容接口给视频打模型分。
// token 只读不落盘：config.judge.api > 环境变量 > DSH 的 cordis.patch.yml。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const REQUEST_TIMEOUT_MS = 90_000;
// P2-3：模型 429/5xx 在同一次预算预留内退避重试 2 次（401/400 等不重试），
// 重试策略在这里声明，实际等待与循环在 services/model-gateway.mjs，避免重复计 token。
export const MODEL_RETRY = Object.freeze({ attempts: 2, base: 1000, max: 8000, jitter: 0.2 });

function isLocalHttp(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function readPatchToken({ dshRoot } = {}) {
  const root = dshRoot || join(homedir(), '.dsh');
  const file = join(root, 'profiles', 'desktop', 'cordis.patch.yml');
  if (!existsSync(file)) return { token: null, baseUrl: null };
  try {
    const text = readFileSync(file, 'utf8');
    const match = text.match(/Authorization:\s*"?Bearer\s+([A-Za-z0-9._\-]+)"?/);
    const base = text.match(/baseURL:\s*"?([^"\s]+)"?/);
    return { token: match ? match[1] : null, baseUrl: base ? base[1] : null };
  } catch {
    return { token: null, baseUrl: null };
  }
}

/**
 * 解析模型调用配置。优先级：显式 api > 环境变量 > DSH patch 文件。
 * @returns {{ok:boolean, apiKey?:string, baseUrl?:string, model?:string, source?:string, code?:string, message?:string}}
 */
export function resolveJudgeApi({ api = null, env = process.env, dshRoot } = {}) {
  if (api && typeof api === 'object') {
    const key = String(api.apiKey || api.key || '').trim();
    const baseUrl = String(api.baseUrl || api.baseURL || '').trim();
    const model = String(api.model || '').trim();
    if (key && baseUrl && isLocalHttp(baseUrl)) {
      return { ok: true, apiKey: key, baseUrl: baseUrl.replace(/\/+$/, ''), model: model || DEFAULT_MODEL, source: 'config' };
    }
  }

  const envKey = String(env.TIKTOK_JUDGE_API_KEY || env.DEEPSEEK_API_KEY || '').trim();
  const envBase = String(env.TIKTOK_JUDGE_BASE_URL || env.DEEPSEEK_BASE_URL || '').trim();
  const envModel = String(env.TIKTOK_JUDGE_MODEL || '').trim();
  if (envKey) {
    const baseUrl = envBase || DEFAULT_BASE_URL;
    if (!isLocalHttp(baseUrl)) {
      return { ok: false, code: 'JUDGE_API_INVALID', message: '模型 baseURL 必须是 https 或本机 http 地址。' };
    }
    return { ok: true, apiKey: envKey, baseUrl: baseUrl.replace(/\/+$/, ''), model: envModel || DEFAULT_MODEL, source: 'env' };
  }

  const patch = readPatchToken({ dshRoot });
  if (patch.token) {
    const baseUrl = patch.baseUrl && isLocalHttp(patch.baseUrl) ? patch.baseUrl : DEFAULT_BASE_URL;
    return { ok: true, apiKey: patch.token, baseUrl: baseUrl.replace(/\/+$/, ''), model: DEFAULT_MODEL, source: 'dsh-profile' };
  }

  return { ok: false, code: 'JUDGE_API_MISSING', message: '没有可用的模型凭据：请配置 judge.api，或设置 TIKTOK_JUDGE_API_KEY。' };
}

export function buildPrompt(profile, meta, { threshold } = {}) {
  // 判定阈值由 judge.mjs 的配置传入（默认 60），提示词必须与实际判定阈值一致。
  const line = Number.isFinite(Number(threshold)) ? Math.round(Number(threshold)) : 60;
  const lines = [
    '你是 TikTok 广告素材筛选助手。请判断这条视频与目标画像的匹配度，输出 0-100 的整数分。',
    '',
    `画像名称：${profile.name}`,
    `必须符合：${(profile.mustHave || []).join('；') || '无'}`,
    `加分项：${(profile.niceToHave || []).join('；') || '无'}`,
    `一票否决：${(profile.mustNot || []).join('；') || '无'}`,
  ];
  if (Array.isArray(profile.mustNot) && profile.mustNot.length) {
    lines.push(`不要的特征（来自用户标注的反样例，命中即视为不符合，score 应显著低于阈值）：${profile.mustNot.join('；')}`);
  }
  if (profile.guidance) lines.push(`补充要求：${profile.guidance}`);
  lines.push(
    '',
    '视频信息：',
    `- 文案：${String(meta.desc || '').slice(0, 300) || '（无）'}`,
    `- 作者：${meta.author || '未知'}`,
    `- 时长：${meta.duration || '未知'} 秒`,
    `- 话题：${(meta.challenges || []).join(' ') || '（无）'}`,
    `- 播放量：${meta.playCount ?? '未知'}`,
    '',
    '下面给出若干关键帧（按时间顺序）。请结合画面与文案判断：',
    '1) 是否命中一票否决项；2) 是否满足必须符合项；3) 前 3 秒是否有强钩子；4) 时长是否合适；5) 画面是否清晰体现玩法/产品。',
    '',
    '另外请逐字抄写画面里出现的文字（贴纸字幕、按钮文案、产品名、玩法提示等）：只抄看得清的字，不要翻译、不要脑补；没有任何文字就留空字符串。',
    '',
    '严格只输出一个 JSON 对象，不要代码块、不要解释、不要在对象外再输出任何数组：',
    '{"score": 0-100 的整数, "verdict": "accept" | "reject", "reasons": ["中文理由1", "中文理由2"], "tags": ["中文标签"], "onScreenText": "画面文字，逐字抄写，没有就空字符串"}',
    'reasons 最多 3 条、每条不超过 40 个汉字；tags 最多 4 个、每个不超过 8 个汉字；onScreenText 最多 120 个字符。',
    `score 与 verdict 必须一致：score >= ${line}（当前判定阈值）时 verdict 为 accept，低于该阈值时为 reject。`,
  );
  return lines.join('\n');
}

/**
 * P1-6 文本预筛提示词：只看文案/话题，不看画面，要求保守（拿不准就给中间分）。
 */
export function buildTextPrompt(profile, meta) {
  const lines = [
    '你是 TikTok 广告素材筛选助手。现在只能看到文案与话题，看不到画面，请只根据文字信息给一个 0-100 的匹配度分。',
    '因为看不到画面，请保守打分：文字中性或信息不足时给 45-55，只有文字明确证明符合才给高分，文字明确违反才给低分。',
    '',
    `画像名称：${profile.name}`,
    `必须符合：${(profile.mustHave || []).join('；') || '无'}`,
    `加分项：${(profile.niceToHave || []).join('；') || '无'}`,
    `一票否决：${(profile.mustNot || []).join('；') || '无'}`,
  ];
  if (Array.isArray(profile.mustNot) && profile.mustNot.length) {
    lines.push(`不要的特征（来自用户标注的反样例，命中即视为不符合）：${profile.mustNot.join('；')}`);
  }
  lines.push(
    '',
    '文字信息：',
    `- 文案：${String(meta.desc || '').slice(0, 300) || '（无）'}`,
    `- 话题：${(meta.challenges || []).join(' ') || '（无）'}`,
    `- 作者：${meta.author || '未知'}`,
    '',
    '严格只输出一个 JSON 对象，不要代码块、不要解释：',
    '{"score": 0-100 的整数, "reasons": ["中文理由1"], "tags": ["中文标签"]}',
    'reasons 最多 2 条、每条不超过 30 个汉字；tags 最多 3 个、每个不超过 8 个汉字。',
  );
  return lines.join('\n');
}

/**
 * P1-6 文本预筛：用文本模型按文案/话题打一个粗分。
 * 没有网关、没有文案时返回 ok:false（调用方应放行到正式判定，不误杀）。
 */
export async function scoreTextWithModel({
  profile,
  meta = {},
  gateway = null,
  budget = null,
  threshold,
  signal,
} = {}) {
  const desc = String(meta.desc || '').trim();
  const challenges = Array.isArray(meta.challenges) ? meta.challenges.filter(Boolean) : [];
  if (!desc && !challenges.length) {
    return { ok: false, code: 'NO_TEXT', message: '没有文案或话题，文本预筛跳过。' };
  }
  if (!gateway) {
    return { ok: false, code: 'TEXT_PREFILTER_NO_GATEWAY', message: '没有模型网关，文本预筛跳过。' };
  }
  const result = await gateway.chat({
    kind: 'text',
    messages: [{ role: 'user', content: buildTextPrompt(profile, meta, { threshold }) }],
    maxTokens: 400,
    temperature: 0.1,
    budget,
    operation: 'judge_text',
    retry: MODEL_RETRY,
    signal,
  });
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      message: result.message,
      model: result.model,
      source: result.source,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  }
  const parsed = parseJsonReply(result.content);
  if (!parsed) {
    return { ok: false, code: 'TEXT_UNPARSABLE', message: '文本模型回复无法解析为 JSON。', model: result.model, source: result.source };
  }
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
  if (!Number.isFinite(score)) {
    return { ok: false, code: 'TEXT_BAD_SCORE', message: '文本模型没有返回有效分数。', model: result.model, source: result.source };
  }
  return {
    ok: true,
    score,
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 3).map((item) => String(item).slice(0, 80)) : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 4).map((item) => String(item).slice(0, 40)) : [],
    model: result.model,
    source: result.source,
    usage: result.usage,
    latencyMs: result.latencyMs,
  };
}

/**
 * 画面文字归一化：字符串化、压平空白、去掉明显占位词，最多 120 字符。
 * 模型经常回 "无"/"none"/"N/A"，统一当空。
 */
export function normalizeOnScreenText(value) {
  if (value === null || value === undefined) return '';
  const text = String(Array.isArray(value) ? value.join(' ') : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (/^(无|没有|none|n\/?a|null|nil|-|—)$/i.test(text)) return '';
  return text.slice(0, 120);
}

export function parseJsonReply(text, { threshold } = {}) {
  // 与 buildPrompt 同一阈值：verdict 字段缺失时按分数推断。
  const line = Number.isFinite(Number(threshold)) ? Math.round(Number(threshold)) : 60;
  if (!text) return null;
  const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // 落到括号配平提取
  }
  // 从每个 '{' 起做括号配平（跳过字符串内的括号），返回第一个带 score 的可解析对象。
  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < cleaned.length; j += 1) {
      const ch = cleaned[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const obj = JSON.parse(cleaned.slice(i, j + 1));
            if (obj && typeof obj === 'object' && 'score' in obj) return obj;
          } catch {
            // 继续找下一个起点
          }
          break;
        }
      }
    }
  }
  return salvageFields(cleaned, line);
}

/** 兜底：JSON 被截断或带多余数组时，直接从文本里抽 score / verdict / reasons / tags。 */
function salvageFields(text, threshold = 60) {
  const scoreMatch = text.match(/"score"\s*:\s*(-?\d+)/);
  if (!scoreMatch) return null;
  const score = Number(scoreMatch[1]);
  if (!Number.isFinite(score)) return null;
  const verdictMatch = text.match(/"verdict"\s*:\s*"(accept|reject)"/i);
  const reasons = extractStringArray(text, 'reasons');
  const tags = extractStringArray(text, 'tags');
  return {
    score,
    verdict: verdictMatch ? verdictMatch[1].toLowerCase() : score >= threshold ? 'accept' : 'reject',
    reasons,
    tags,
  };
}

function extractStringArray(text, key) {
  const start = text.indexOf(`"${key}"`);
  if (start === -1) return [];
  const open = text.indexOf('[', start);
  if (open === -1) return [];
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  const segment = text.slice(open);
  let match;
  let depth = 0;
  let consumed = 0;
  for (const ch of segment) {
    consumed += 1;
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = segment.slice(0, consumed);
  while ((match = re.exec(body)) !== null) {
    const value = match[1].replace(/\\"/g, '"').trim();
    if (value) out.push(value);
  }
  return out.slice(0, 8);
}

/**
 * 调模型打分。
 * @returns {Promise<{ok:boolean, score?:number, verdict?:string, reasons?:string[], tags?:string[], code?:string, message?:string, model?:string, latencyMs?:number}>}
 */
export async function scoreWithModel({
  frames,
  profile,
  meta,
  api,
  gateway = null,
  budget = null,
  threshold,
  signal,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!Array.isArray(frames) || !frames.length) {
    return { ok: false, code: 'NO_FRAMES', message: '没有关键帧，无法做视觉打分。' };
  }

  const content = [{ type: 'text', text: buildPrompt(profile, meta || {}, { threshold }) }];
  for (const frame of frames.slice(0, 5)) {
    content.push({ type: 'image_url', image_url: { url: `data:${frame.mime || 'image/jpeg'};base64,${frame.data}` } });
  }

  if (gateway) {
    const result = await gateway.chat({
      kind: 'vision',
      messages: [{ role: 'user', content }],
      maxTokens: 1600,
      temperature: 0.2,
      budget,
      operation: 'judge',
      retry: MODEL_RETRY,
      signal,
    });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        model: result.model,
        source: result.source,
        usage: result.usage,
        latencyMs: result.latencyMs,
      };
    }
    const parsed = parseJsonReply(result.content);
    if (!parsed) {
      return {
        ok: false,
        code: 'JUDGE_UNPARSABLE',
        message: `模型回复无法解析为 JSON：${String(result.content).slice(0, 200)}`,
        model: result.model,
        source: result.source,
        latencyMs: result.latencyMs,
      };
    }
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
    if (!Number.isFinite(score)) {
      return { ok: false, code: 'JUDGE_BAD_SCORE', message: '模型没有返回有效分数。', model: result.model, source: result.source };
    }
    return {
      ok: true,
      score,
      verdict: parsed.verdict === 'reject' ? 'reject' : 'accept',
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6).map((item) => String(item).slice(0, 160)) : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8).map((item) => String(item).slice(0, 40)) : [],
      onScreenText: normalizeOnScreenText(parsed.onScreenText),
      model: result.model,
      source: result.source,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  }

  const resolved = resolveJudgeApi({ api, env });
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        model: resolved.model,
        messages: [{ role: 'user', content }],
        temperature: 0.2,
        max_tokens: 1600,
        stream: false,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        code: `JUDGE_HTTP_${response.status}`,
        message: `模型接口返回 ${response.status}：${text.slice(0, 200)}`,
        model: resolved.model,
        latencyMs: Date.now() - startedAt,
      };
    }

    let payload = null;
    let replyText = '';
    if (text.trimStart().startsWith('data:')) {
      // 兼容服务端默认流式（SSE）返回：拼接所有 delta.content
      for (const line of text.split(/\r?\n/)) {
        const item = line.trim();
        if (!item.startsWith('data:')) continue;
        const chunk = item.slice(5).trim();
        if (!chunk || chunk === '[DONE]') continue;
        try {
          const obj = JSON.parse(chunk);
          const piece = obj?.choices?.[0]?.delta?.content;
          if (typeof piece === 'string') replyText += piece;
        } catch {
          // 单个分片解析失败不影响其余分片
        }
      }
    } else {
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, code: 'JUDGE_BAD_RESPONSE', message: '模型接口返回的不是 JSON。', model: resolved.model };
      }
      const raw = payload?.choices?.[0]?.message?.content;
      replyText = Array.isArray(raw) ? raw.map((part) => part?.text || '').join('') : String(raw || '');
    }
    const parsed = parseJsonReply(replyText);
    if (!parsed) {
      return {
        ok: false,
        code: 'JUDGE_UNPARSABLE',
        message: `模型回复无法解析为 JSON：${replyText.slice(0, 200)}`,
        model: resolved.model,
        latencyMs: Date.now() - startedAt,
      };
    }

    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
    if (!Number.isFinite(score)) {
      return { ok: false, code: 'JUDGE_BAD_SCORE', message: '模型没有返回有效分数。', model: resolved.model };
    }
    return {
      ok: true,
      score,
      verdict: parsed.verdict === 'reject' ? 'reject' : 'accept',
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6).map((item) => String(item).slice(0, 160)) : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8).map((item) => String(item).slice(0, 40)) : [],
      onScreenText: normalizeOnScreenText(parsed.onScreenText),
      model: resolved.model,
      source: resolved.source,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'JUDGE_TIMEOUT' : 'JUDGE_REQUEST_FAILED',
      message: String(error?.message || error).slice(0, 200),
      model: resolved.model,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
