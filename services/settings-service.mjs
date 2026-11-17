import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { isAllowedModelBaseUrl } from './model-gateway.mjs';

export const CONFIG_VERSION = 2;

const FIELDS = Object.freeze({
  // 留空时使用运行目录下的默认 downloads/，方便新用户按需填写。
  downloadsDir: { kind: 'directory', allowEmpty: true },
  port: { kind: 'integer', min: 1024, max: 65535, allowEmpty: true },
  'proxy.server': { kind: 'string' },
  // P2-5 代理池：留空沿用单代理；最多 20 个。
  'proxy.pool': { kind: 'stringArray' },
  'proxy.cooldownMs': { kind: 'integer', min: 1_000, max: 3_600_000 },
  'proxy.failureThreshold': { kind: 'integer', min: 1, max: 10 },
  'browser.profileDir': { kind: 'directory' },
  // 被拒素材落点：配置后判定为 reject 的 mp4+json 平铺到 <dir>/<YYYY-MM-DD>/；留空则直接删。
  'storage.rejectedDir': { kind: 'directory', allowEmpty: true },
  'proxy.username': { kind: 'string' },
  'proxy.password': { kind: 'string' },
  'search.maxResultsPerKeyword': { kind: 'integer', min: 1, max: 200, allowEmpty: true },
  'search.tokenBudget': { kind: 'integer', min: 1, max: 1_000_000_000, allowEmpty: true },
  'search.dailyTokenBudget': { kind: 'integer', min: 0, max: 1_000_000_000, allowEmpty: true },
  'search.targetCount': { kind: 'integer', min: 3, max: 30, allowEmpty: true },
  'search.queryLanguage': { kind: 'string' },
  'search.contentLanguage': { kind: 'string' },
  'search.expansionEnabled': { kind: 'boolean' },
  'search.defaultProfileId': { kind: 'string' },
  // 目标种子词与排除词：client 保存搜索设置时一并提交，重进设置页据此回填。
  // 之前这两项没进白名单也没被保存，导致「保存后退出重进又变回默认值」。
  'search.seeds': { kind: 'stringArray', maxItems: 20 },
  'search.exclude': { kind: 'stringArray', maxItems: 30 },
  'collect.minDelayMs': { kind: 'integer', min: 0, max: 60_000 },
  'collect.maxDelayMs': { kind: 'integer', min: 0, max: 120_000 },
  'collect.batchPauseEvery': { kind: 'integer', min: 1, max: 10_000 },
  'collect.batchPauseMs': { kind: 'integer', min: 0, max: 600_000 },
  'judge.threshold': { kind: 'number', min: 0, max: 100 },
  'judge.modelWeight': { kind: 'number', min: 0, max: 1 },
  'judge.prefilter': { kind: 'enum', values: ['off', 'rule'] },
  'judge.coverPrefilter': { kind: 'boolean' },
  'judge.textPrefilter': { kind: 'boolean' },
  // P2-6 卖点提取：默认 off，单条约 800 token。
  'judge.sellingPoints': { kind: 'boolean' },
  // P2-1 素材去重：默认 off，阈值可调。
  'dedup.enabled': { kind: 'boolean' },
  'dedup.videoDistance': { kind: 'integer', min: 0, max: 64, allowEmpty: true },
  'dedup.textSimilarity': { kind: 'number', min: 0, max: 1, allowEmpty: true },
  'judge.useModel': { kind: 'boolean' },
  'judge.frameCount': { kind: 'integer', min: 1, max: 10 },
  'judge.api.baseUrl': { kind: 'baseUrl' },
  'judge.api.apiKey': { kind: 'string' },
  'judge.api.model': { kind: 'string' },
  'judge.profiles': { kind: 'array' },
  'model.source': { kind: 'enum', values: ['legacy', 'dsh', 'openai-compatible'] },
  'model.provider': { kind: 'string' },
  'model.model': { kind: 'string' },
  'model.textModel': { kind: 'string' },
  'model.visionModel': { kind: 'string' },
  'model.api.baseUrl': { kind: 'baseUrl' },
  'model.api.apiKey': { kind: 'string' },
  // 自定义 OpenAI 兼容接口的模型名：client 的 basicPatch() 每次保存都会带上，
  // 白名单若缺这一项，整个 patch 会被 CONFIG_UNKNOWN_FIELD 拒绝，模型选择永远存不进去。
  'model.api.model': { kind: 'string' },
  'download.channel': { kind: 'enum', values: ['page', 'aix', 'auto'] },
  // 默认 true：优先 playAddr（无水印）；false 才用带水印的 downloadAddr。
  'download.preferNoWatermark': { kind: 'boolean' },
  'download.aix.enabled': { kind: 'boolean' },
  'download.aix.manualFallback': { kind: 'boolean' },
  'download.aix.allowPageFallback': { kind: 'boolean' },
  'download.aix.allowAixUrlPageFetch': { kind: 'boolean' },
});

function settingsError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deepMerge(base, patch) {
  const next = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    next[key] = isPlainObject(value) && isPlainObject(next[key]) ? deepMerge(next[key], value) : clone(value);
  }
  return next;
}

function getPath(object, path) {
  let current = object;
  for (const key of path.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function hasPrefix(prefix, path) {
  return path === prefix || path.startsWith(`${prefix}.`);
}

function validateField(path, value, rule) {
  if (value === undefined || value === null) return;
  // allowEmpty 的字段把空串原样保存，运行层再应用内部默认值，设置页因此能保持空白。
  if (rule.allowEmpty && typeof value === 'string' && !value.trim()) return;
  if (rule.kind === 'string') {
    if (typeof value !== 'string') throw settingsError('CONFIG_INVALID_TYPE', `${path} 必须是字符串。`);
    if (rule.nonEmpty && !value.trim()) throw settingsError('CONFIG_INVALID_VALUE', `${path} 不能为空。`);
    return;
  }
  if (rule.kind === 'baseUrl') {
    // 空串表示“未配置”：切换到 DSH / 沿用默认模型时前端会把 baseUrl 清空，
    // 这种情况不应让整次保存失败（openai-compatible 的必填校验在 validateConfig 里）。
    if (typeof value === 'string' && !value.trim()) return;
    if (typeof value !== 'string' || !isAllowedModelBaseUrl(value)) {
      throw settingsError('CONFIG_INVALID_URL', `${path} 必须是 https 或本机 http 地址。`);
    }
    return;
  }
  if (rule.kind === 'directory') {
    // allowEmpty：允许留空表示“不启用”，其余目录字段仍必须是非空绝对路径。
    if (rule.allowEmpty && typeof value === 'string' && !value.trim()) return;
    if (typeof value !== 'string' || !value.trim() || !isAbsolute(value) || value.includes('\0')) {
      throw settingsError('CONFIG_INVALID_PATH', `${path} 必须是绝对目录路径。`);
    }
    return;
  }
  if (rule.kind === 'boolean') {
    if (typeof value !== 'boolean') throw settingsError('CONFIG_INVALID_TYPE', `${path} 必须是布尔值。`);
    return;
  }
  if (rule.kind === 'enum') {
    if (!rule.values.includes(value)) throw settingsError('CONFIG_INVALID_VALUE', `${path} 只能是 ${rule.values.join('/')}。`);
    return;
  }
  if (rule.kind === 'stringArray') {
    const maxItems = Number.isSafeInteger(rule.maxItems) && rule.maxItems > 0 ? rule.maxItems : 20;
    if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string')) {
      throw settingsError('CONFIG_INVALID_TYPE', `${path} 必须是字符串数组（最多 ${maxItems} 项）。`);
    }
    return;
  }
  if (rule.kind === 'array') {
    if (!Array.isArray(value) || value.length > 100 || value.some((item) => !isPlainObject(item))) {
      throw settingsError('CONFIG_INVALID_TYPE', `${path} 必须是最多 100 个对象的数组。`);
    }
    return;
  }
  if (rule.kind === 'integer' && !Number.isSafeInteger(value)) {
    throw settingsError('CONFIG_INVALID_TYPE', `${path} 必须是整数。`);
  }
  if (rule.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw settingsError('CONFIG_INVALID_TYPE', `${path} 必须是有限数字。`);
  }
  if (rule.min !== undefined && value < rule.min) throw settingsError('CONFIG_INVALID_VALUE', `${path} 不能小于 ${rule.min}。`);
  if (rule.max !== undefined && value > rule.max) throw settingsError('CONFIG_INVALID_VALUE', `${path} 不能大于 ${rule.max}。`);
}

function validatePatchNode(value, prefix = '') {
  if (!isPlainObject(value)) throw settingsError('CONFIG_INVALID_TYPE', `${prefix || 'patch'} 必须是对象。`);
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (Object.hasOwn(FIELDS, path) && ['array', 'stringArray'].includes(FIELDS[path].kind)) {
      validateField(path, child, FIELDS[path]);
      continue;
    }
    if (isPlainObject(child) && Object.keys(FIELDS).some((field) => field.startsWith(`${path}.`))) {
      validatePatchNode(child, path);
      continue;
    }
    if (!Object.hasOwn(FIELDS, path)) throw settingsError('CONFIG_UNKNOWN_FIELD', `不支持的设置字段：${path}。`);
    validateField(path, child, FIELDS[path]);
  }
}

function validateConfig(config) {
  for (const [path, rule] of Object.entries(FIELDS)) {
    const value = getPath(config, path);
    if (value !== undefined) validateField(path, value, rule);
  }
  if (Number.isInteger(config?.collect?.minDelayMs) && Number.isInteger(config?.collect?.maxDelayMs)
    && config.collect.minDelayMs > config.collect.maxDelayMs) {
    throw settingsError('CONFIG_INVALID_VALUE', 'collect.minDelayMs 不能大于 maxDelayMs。');
  }
  if (config?.model?.source === 'dsh' && (!config.model.provider?.trim() || !config.model.model?.trim())) {
    throw settingsError('CONFIG_INVALID_VALUE', 'DSH 模型必须同时配置 provider 和 model。');
  }
  if (config?.model?.source === 'openai-compatible' && !config.model.api?.baseUrl) {
    throw settingsError('CONFIG_INVALID_VALUE', '自定义模型必须配置 baseUrl。');
  }
}

function readConfig(file) {
  if (!existsSync(file)) return {};
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw settingsError('CONFIG_UNREADABLE', `无法读取设置文件：${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text || '{}');
  } catch {
    throw settingsError('CONFIG_INVALID', `设置文件不是有效 JSON：${file}`);
  }
  if (!isPlainObject(parsed)) throw settingsError('CONFIG_INVALID', '设置文件必须是 JSON 对象。');
  return parsed;
}

function saveConfig(file, config) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
  } catch (error) {
    throw settingsError('CONFIG_WRITE_FAILED', `保存设置失败：${error.message}`);
  }
}

function publicConfig(raw) {
  const config = clone(raw);
  const modelKey = Boolean(config?.model?.api?.apiKey || config?.judge?.api?.apiKey);
  const proxyPassword = Boolean(config?.proxy?.password);
  if (config?.model?.api) delete config.model.api.apiKey;
  if (config?.judge?.api) {
    delete config.judge.api.apiKey;
    delete config.judge.api.key;
  }
  if (config?.proxy) delete config.proxy.password;
  return {
    config,
    credentials: {
      modelApiKey: { configured: modelKey },
      proxyPassword: { configured: proxyPassword },
    },
  };
}

export function createSettingsService({ paths, overrides = {} } = {}) {
  const file = paths?.configFile;
  if (!file) throw new TypeError('createSettingsService 需要 paths.configFile。');
  if (!isPlainObject(overrides)) throw new TypeError('overrides 必须是对象。');
  const disk = readConfig(file);
  const initial = deepMerge(disk, overrides);
  validateConfig(initial);
  let rawConfig = initial;
  const publicSnapshot = () => {
    const safe = publicConfig(rawConfig);
    return {
      ok: true,
      file,
      configVersion: Number(rawConfig.configVersion) || 1,
      config: safe.config,
      credentials: safe.credentials,
    };
  };

  return {
    file,
    raw() {
      return clone(rawConfig);
    },
    public: publicSnapshot,
    update(patch = {}) {
      if (!isPlainObject(patch)) throw settingsError('CONFIG_INVALID_TYPE', 'patch 必须是对象。');
      validatePatchNode(patch);
      const next = deepMerge(rawConfig, patch);
      next.configVersion = CONFIG_VERSION;
      validateConfig(next);
      saveConfig(file, next);
      rawConfig = next;
      return publicSnapshot();
    },
  };
}
