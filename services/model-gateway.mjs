import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isRetryableModelError, nextDelay } from './retry.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const REQUEST_TIMEOUT_MS = 90_000;
const IMAGE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function cleanMessage(error) {
  return String(error?.message || error || '模型调用失败。')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***')
    .replace(/(api[_-]?key|authorization)[:=]\s*[^\s,;]+/gi, '$1=***')
    .slice(0, 300);
}

export function isAllowedModelBaseUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function readLegacyPatch(dshRoot) {
  const file = join(dshRoot || join(homedir(), '.dsh'), 'profiles', 'desktop', 'cordis.patch.yml');
  if (!existsSync(file)) return { token: null, baseUrl: null };
  try {
    const text = readFileSync(file, 'utf8');
    return {
      token: text.match(/Authorization:\s*"?Bearer\s+([A-Za-z0-9._\-]+)"?/)?.[1] || null,
      baseUrl: text.match(/baseURL:\s*"?([^"\s]+)"?/)?.[1] || null,
    };
  } catch {
    return { token: null, baseUrl: null };
  }
}

function legacyRoute(config, env, dshRoot) {
  const explicit = config?.judge?.api || {};
  const explicitKey = String(explicit.apiKey || explicit.key || '').trim();
  const explicitBase = String(explicit.baseUrl || explicit.baseURL || '').trim();
  if (explicitKey && explicitBase) {
    return {
      apiKey: explicitKey,
      baseUrl: explicitBase,
      model: String(explicit.model || '').trim() || DEFAULT_MODEL,
      source: 'config',
    };
  }
  const envKey = String(env?.TIKTOK_JUDGE_API_KEY || env?.DEEPSEEK_API_KEY || '').trim();
  if (envKey) {
    return {
      apiKey: envKey,
      baseUrl: String(env?.TIKTOK_JUDGE_BASE_URL || env?.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).trim(),
      model: String(env?.TIKTOK_JUDGE_MODEL || '').trim() || DEFAULT_MODEL,
      source: 'env',
    };
  }
  const patch = readLegacyPatch(dshRoot);
  return {
    apiKey: patch.token || '',
    baseUrl: patch.baseUrl || DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    source: patch.token ? 'dsh-profile' : 'missing',
  };
}

// “默认模型”：读取挂载本插件的 DSH 宿主当前默认模型（新开对话默认选择的 provider/model）。
// DSH 以服务名 agentDefaultModel 暴露该配置，currentSelection() 同步返回 { provider, model, reasoningEffort? }。
function hostDefaultModel(agentDefaultModel) {
  if (!agentDefaultModel || typeof agentDefaultModel.currentSelection !== 'function') return null;
  try {
    const selection = agentDefaultModel.currentSelection();
    if (!selection || typeof selection !== 'object') return null;
    const provider = String(selection.provider || '').trim();
    const model = String(selection.model || '').trim();
    if (!provider || !model) return null;
    const reasoningEffort = typeof selection.reasoningEffort === 'string' && selection.reasoningEffort ? selection.reasoningEffort : undefined;
    return { provider, model, reasoningEffort };
  } catch {
    return null;
  }
}

// “文本/视觉模型”允许存 “提供商/模型名” 形式（如 workbuddy/glm-5v-turbo），
// 运行时按前缀的提供商路由；纯模型名则沿用默认提供商。
export function splitProviderModel(value, fallbackProvider = '') {
  const raw = String(value || '').trim();
  if (!raw) return { provider: String(fallbackProvider || '').trim(), model: '' };
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return { provider: String(fallbackProvider || '').trim(), model: raw };
  const provider = raw.slice(0, slash).trim();
  const model = raw.slice(slash + 1).trim();
  if (!provider || !model) return { provider: String(fallbackProvider || '').trim(), model: raw };
  return { provider, model };
}

export function resolveModelRoute({ config = {}, kind = 'vision', env = process.env, dshRoot, agentDefaultModel = null } = {}) {
  const settings = config?.model || {};
  const source = settings.source || 'legacy';
  const selected = kind === 'text' ? settings.textModel : settings.visionModel;
  if (source === 'dsh') {
    const picked = splitProviderModel(selected, settings.provider);
    return {
      source: 'dsh',
      provider: String(picked.provider || settings.provider || '').trim(),
      model: String(picked.model || settings.model || '').trim(),
      credentialSource: 'dsh',
    };
  }
  if (source === 'openai-compatible') {
    const api = settings.api || {};
    return {
      source: 'openai-compatible',
      provider: null,
      // 自定义接口的模型 ID 可能本身包含 `/`（如 openai/gpt-4o），不能按 DSH 的提供商前缀截断。
      model: String(selected || settings.model || api.model || DEFAULT_MODEL).trim(),
      apiKey: String(api.apiKey || '').trim(),
      baseUrl: String(api.baseUrl || DEFAULT_BASE_URL).trim(),
      credentialSource: 'config',
    };
  }
  // “默认模型”：优先跟随宿主新开对话默认选择的模型；宿主未提供时才回退到旧的三级兼容逻辑。
  // textModel/visionModel 可用 “提供商/模型名” 跨提供商覆盖，运行时按所选提供商路由。
  const host = hostDefaultModel(agentDefaultModel);
  if (host) {
    const picked = splitProviderModel(selected, host.provider);
    return {
      source: 'dsh',
      provider: String(picked.provider || host.provider).trim(),
      model: String(picked.model || host.model).trim(),
      reasoningEffort: host.reasoningEffort,
      credentialSource: 'agent-default-model',
    };
  }
  const legacy = legacyRoute(config, env, dshRoot);
  const picked = splitProviderModel(selected);
  return {
    source: 'openai-compatible',
    provider: null,
    model: String(picked.model || settings.model || legacy.model || DEFAULT_MODEL).trim(),
    apiKey: legacy.apiKey,
    baseUrl: legacy.baseUrl,
    credentialSource: legacy.source,
  };
}

export function estimateMessageTokens(messages, { imageTokens = 1000, maxTokens = 0 } = {}) {
  let total = Math.max(0, Number(maxTokens) || 0);
  for (const message of messages || []) {
    const parts = typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : message?.content || [];
    for (const part of parts) {
      if (part?.type === 'text') total += Math.max(1, Math.ceil(String(part.text || '').length / 4));
      else if (part?.type === 'image_url') total += imageTokens;
    }
  }
  return Math.max(1, Math.ceil(total));
}

export function normalizeModelUsage(usage = {}) {
  const prompt = usage.prompt_tokens ?? usage.inputTokens ?? null;
  const completion = usage.completion_tokens ?? usage.outputTokens ?? null;
  const total = usage.total_tokens ?? usage.totalTokens ?? (Number.isFinite(prompt) && Number.isFinite(completion) ? prompt + completion : null);
  const positive = [prompt, completion, total].some((value) => Number.isFinite(value) && value > 0);
  if (!positive) return { prompt_tokens: null, completion_tokens: null, total_tokens: null };
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : null,
    completion_tokens: Number.isFinite(completion) ? completion : null,
    total_tokens: Number.isFinite(total) ? total : null,
  };
}

function parseOpenAIResponse(text) {
  if (text.trimStart().startsWith('data:')) {
    let content = '';
    let usage = {};
    for (const line of text.split(/\r?\n/)) {
      const item = line.trim();
      if (!item.startsWith('data:')) continue;
      const chunk = item.slice(5).trim();
      if (!chunk || chunk === '[DONE]') continue;
      try {
        const payload = JSON.parse(chunk);
        content += payload?.choices?.[0]?.delta?.content || '';
        if (payload?.usage) usage = payload.usage;
      } catch {
        // 单个 SSE 分片损坏不掩盖其他有效内容。
      }
    }
    return { content, usage };
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw failure('MODEL_BAD_RESPONSE', '模型接口返回的不是 JSON。');
  }
  const raw = payload?.choices?.[0]?.message?.content;
  return {
    content: Array.isArray(raw) ? raw.map((part) => part?.text || '').join('') : String(raw || ''),
    usage: payload?.usage || {},
  };
}

async function openAIChat({ route, messages, maxTokens, temperature, signal, fetchImpl }) {
  if (!route.apiKey) throw failure('JUDGE_API_MISSING', '没有可用的模型凭据，请先配置 API Key。');
  if (!isAllowedModelBaseUrl(route.baseUrl)) throw failure('JUDGE_API_INVALID', '模型 baseURL 必须是 https 或本机 http 地址。');
  if (typeof fetchImpl !== 'function') throw failure('MODEL_FETCH_UNAVAILABLE', '当前环境没有可用的 fetch。');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(`${String(route.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
      body: JSON.stringify({ model: route.model, messages, temperature, max_tokens: maxTokens, stream: false }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw failure(`MODEL_HTTP_${response.status}`, `模型接口返回 ${response.status}：${cleanMessage(text)}`);
    const parsed = parseOpenAIResponse(text);
    if (!parsed.content.trim()) throw failure('MODEL_EMPTY_RESPONSE', '模型没有返回文本内容。');
    return { ...parsed, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (error?.code) throw error;
    throw failure(error?.name === 'AbortError' ? 'MODEL_TIMEOUT' : 'MODEL_REQUEST_FAILED', cleanMessage(error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

async function convertDshMessages({ messages, system, info, attachments, signal }) {
  const converted = [];
  const systemParts = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(typeof message.content === 'string' ? message.content : '');
      continue;
    }
    if (!['user', 'assistant'].includes(message.role)) throw failure('MODEL_MESSAGE_INVALID', '只允许 user/assistant/system 消息。');
    const blocks = [];
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
    for (const part of parts) {
      if (part?.type === 'text') {
        blocks.push({ type: 'text', text: String(part.text || '') });
        continue;
      }
      if (part?.type !== 'image_url') throw failure('MODEL_MESSAGE_INVALID', '模型请求包含不支持的内容类型。');
      if (!info?.inputModalities?.includes('image') || typeof attachments?.saveImages !== 'function') {
        throw failure('MODEL_VISION_UNAVAILABLE', '当前模型不支持图片输入，可在“视觉模型（可选）”中选择支持图像的模型。');
      }
      const match = IMAGE.exec(part.image_url?.url || '');
      if (!match) throw failure('MODEL_IMAGE_INVALID', '图片必须是 jpeg/png/webp 的规范 data URL。');
      const data = Buffer.from(match[2], 'base64');
      if (!data.length || data.length > 2_000_000 || data.toString('base64') !== match[2]) {
        throw failure('MODEL_IMAGE_INVALID', '图片为空、超过 2MB 或 Base64 编码无效。');
      }
      const refs = await attachments.saveImages([{ data, mediaType: match[1] }]);
      signal?.throwIfAborted?.();
      if (!Array.isArray(refs) || refs.length !== 1 || !refs[0]?.attachmentId) {
        throw failure('MODEL_ATTACHMENT_FAILED', 'DSH 未保存完整的图片附件。');
      }
      blocks.push({ type: 'image', attachment: refs[0] });
    }
    converted.push({
      id: randomUUID(),
      role: message.role,
      content: blocks,
      source: { kind: 'plugin', plugin: 'tiktok-browser', form: 'snapshot', sections: [] },
    });
  }
  return { converted, system: [system, ...systemParts].filter(Boolean).join('\n\n') };
}

async function dshChat({ route, messages, system, maxTokens, llm, attachments, sessionId, signal }) {
  if (!route.provider || !route.model) throw failure('MODEL_DSH_ROUTE_MISSING', '请选择 DSH 提供商和模型。');
  if (typeof llm?.stream !== 'function' || typeof llm?.resolveModelInfo !== 'function') {
    throw failure('MODEL_DSH_UNAVAILABLE', '当前 DSH 未提供可调用的模型服务。');
  }
  const info = await llm.resolveModelInfo(route.provider, route.model, signal);
  const { converted, system: prompt } = await convertDshMessages({ messages, system, info, attachments, signal });
  const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [];
  // “默认模型”带出宿主的推理档位时优先沿用；模型不支持该档位再退回 off，避免流式请求被拒。
  const effort = route.reasoningEffort && efforts.some((item) => item.id === route.reasoningEffort) ? route.reasoningEffort : null;
  const reasoning = effort
    ? { reasoningEffort: effort }
    : efforts.some((item) => item.id === 'off')
      ? { reasoningEffort: 'off' }
      : {};
  let content = '';
  let usage = {};
  let finish = null;
  const deltas = new Set();
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    messages: converted,
    system: prompt,
    maxTokens,
    sessionId,
    signal,
    ...reasoning,
  })) {
    signal?.throwIfAborted?.();
    if (chunk.type === 'text-delta') {
      deltas.add(chunk.index);
      content += chunk.text || '';
    }
    if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !deltas.has(chunk.index)) content += chunk.block.text || '';
    if (chunk.type === 'usage') usage = chunk.usage || {};
    if (chunk.type === 'finish') finish = chunk.reason;
    if (content.length > 50_000) throw failure('MODEL_RESPONSE_TOO_LARGE', '模型回复超过长度上限。');
  }
  if (finish?.kind !== 'stop' || !content.trim()) {
    throw failure('MODEL_INCOMPLETE', `DSH 模型未完整返回（${finish?.kind || '缺少完成标记'}）。`);
  }
  return { content, usage };
}

export function createModelGateway({
  config = {},
  env = process.env,
  dshRoot,
  llm = null,
  attachments = null,
  agentDefaultModel = null,
  fetchImpl = globalThis.fetch,
  sessionId = `tiktok-browser:${randomUUID()}`,
  imageTokens = 1000,
} = {}) {
  function describe(kind = 'vision') {
    const route = resolveModelRoute({ config, kind, env, dshRoot, agentDefaultModel });
    return {
      source: route.source,
      provider: route.provider,
      model: route.model,
      baseUrl: route.baseUrl || null,
      credentialSource: route.credentialSource,
      configured: route.source === 'dsh' ? Boolean(route.provider && route.model) : Boolean(route.apiKey && route.baseUrl),
    };
  }

  async function chat({
    kind = 'vision',
    messages = [],
    system = '',
    maxTokens = 1600,
    temperature = 0.2,
    budget = null,
    operation = kind,
    // P2-3：模型 429/5xx 在同一次预算预留内退避重试，不重复计 token。
    retry = null,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    signal,
  } = {}) {
    if (!Array.isArray(messages) || !messages.length) return { ok: false, code: 'MODEL_MESSAGE_INVALID', message: '模型消息不能为空。' };
    const route = resolveModelRoute({ config, kind, env, dshRoot, agentDefaultModel });
    const estimatedTokens = estimateMessageTokens(messages, { imageTokens, maxTokens });
    const retries = Math.max(0, Math.min(Math.trunc(Number(retry?.attempts ?? 0)) || 0, 3));
    let reservation = null;
    const startedAt = Date.now();
    try {
      if (budget) {
        reservation = await budget.reserve({
          operation: String(operation || kind).slice(0, 64),
          estimatedTokens,
          metadata: { kind, model: route.model, source: route.source },
        });
      }
      const prepared = [{ role: 'system', content: system }, ...messages].filter((message, index) => index > 0 || message.content);
      let outcome = null;
      let attempts = 0;
      for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        attempts = attempt;
        try {
          outcome = route.source === 'dsh'
            ? await dshChat({ route, messages, system, maxTokens, llm, attachments, sessionId, signal })
            : await openAIChat({ route, messages: prepared, maxTokens, temperature, signal, fetchImpl });
          break;
        } catch (error) {
          const retryable = isRetryableModelError(error?.code);
          if (attempt > retries || !retryable) throw error;
          await sleep(nextDelay(attempt, retry || {}));
        }
      }
      const usage = normalizeModelUsage(outcome.usage);
      if (reservation) await budget.settle(reservation, usage);
      return {
        ok: true,
        content: outcome.content,
        usage,
        attempts,
        model: route.model,
        provider: route.provider || null,
        source: route.source,
        credentialSource: route.credentialSource,
        latencyMs: outcome.latencyMs ?? Date.now() - startedAt,
      };
    } catch (error) {
      if (reservation) {
        await budget.settle(reservation, { total_tokens: estimatedTokens });
      }
      return {
        ok: false,
        code: error?.code || 'MODEL_REQUEST_FAILED',
        message: cleanMessage(error),
        model: route.model,
        provider: route.provider || null,
        source: route.source,
        usage: normalizeModelUsage(),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  return { chat, describe };
}
