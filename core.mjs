// core.mjs — M1 控制器：代理自检 → 启动专用 Edge → 打开页面 → 返回状态。

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { ensureRuntimePaths, resolveRuntimePaths } from './runtime-paths.mjs';
import { runBrowserHost, readBrowserState, clearBrowserState, BROWSER_ERROR_CODES } from './browser-host.mjs';
import { findPageByRole, describePage, ensurePage } from './browser-pages.mjs';
import { ensurePreparePage, readPageSignals, describePageState, PREPARE_HOME } from './browser-launcher.mjs';
import { checkProxy, resolveProxyConfig, PROXY_ERROR_CODES } from './proxy-check.mjs';
import { runDiagnostics } from './diagnostics.mjs';
import { createStore, CANDIDATE_STATUS } from './collect/store.mjs';
import { runSearch, dropCandidateArtifacts } from './collect/pipeline.mjs';
import { extractVideoDetail } from './collect/extract.mjs';
import { dateStamp } from './collect/archive.mjs';
import { judgeCandidate } from './collect/judge.mjs';
import { listProfiles, findProfile } from './collect/profiles.mjs';
import { createLibrary } from './collect/library.mjs';
import { runCollect } from './collect/batch.mjs';
import { buildReport } from './collect/report.mjs';
import { createSettingsService } from './services/settings-service.mjs';
import { createModelGateway, resolveModelRoute } from './services/model-gateway.mjs';
import { createTokenBudget } from './services/token-budget.mjs';
import {
  computeDailyBudget,
  dailyBudgetExhaustedResult,
  DEFAULT_DAILY_TOKEN_BUDGET,
} from './services/daily-budget.mjs';
import { createDownloadManager } from './services/downloader.mjs';
import { expandKeywords } from './services/keyword-expander.mjs';
import { buildInterestProfile as buildInterestProfileWithModel, normalizeInterestProfile } from './services/interest-profile.mjs';
import { listVersions, readVersion, writeVersion } from './services/profile-history.mjs';
import { resolveDedupOptions, createDedupIndex } from './services/dedup.mjs';
import { filterCandidateRows, exportCandidatesCsv } from './services/export.mjs';
import { createRetryQueue, RETRY_DEFAULTS } from './services/retry.mjs';
import { createFeedbackStore, FEEDBACK_LIMITS } from './services/feedback.mjs';
import { createProxyPool } from './services/proxy-pool.mjs';

const PORT_RANGE = [9333, 9350];
const DEFAULT_TASK_TOKEN_BUDGET = 50_000;
const SEARCH_URL = 'https://www.tiktok.com/search?q=';
// 素材库列表默认隐藏“首次采集超过 N 天”的旧记录：只影响列表展示，不删除文件与候选数据。
// 时间基准是 collectedAt（首次入库时间），而不是 updatedAt（每次判定/下载都会刷新）。
const LIBRARY_HIDE_AFTER_DAYS = 3;

function configuredNumber(value, fallback) {
  return value === '' || value === null || value === undefined ? fallback : Number(value);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort(preferred) {
  if (Number.isInteger(preferred) && preferred >= 1024 && preferred <= 65535 && (await isPortFree(preferred))) {
    return preferred;
  }
  for (let port = PORT_RANGE[0]; port <= PORT_RANGE[1]; port += 1) {
    if (await isPortFree(port)) return port;
  }
  return null;
}

export class BrowserController {
  #config;
  #env;
  #paths;
  #basePaths;
  #settings;
  #llm;
  #attachments;
  #sessionId;
  #revealHandler;
  #context = null;
  #host = null;
  #proxyCheckAt = 0;
  #proxyCheckResult = null;
  #proxyPoolInstance = null;
  #activeProxyServer = null;

  constructor({ config = {}, env = process.env, paths = null, llm = null, attachments = null, sessionId = null, revealHandler = null } = {}) {
    this.#env = env;
    this.#basePaths = paths || resolveRuntimePaths({ env });
    this.#paths = { ...this.#basePaths };
    this.#settings = createSettingsService({ paths: this.#paths, overrides: config });
    this.#config = this.#settings.raw();
    this.#llm = llm;
    this.#attachments = attachments;
    this.#sessionId = sessionId || `tiktok-browser:${randomUUID()}`;
    this.#revealHandler = typeof revealHandler === 'function' ? revealHandler : null;
    this.#syncDownloadsPath();
    ensureRuntimePaths(this.#paths);
  }

  get paths() {
    return this.#paths;
  }

  #syncDownloadsPath() {
    const next = { ...this.#basePaths };
    const customDownloads = String(this.#config.downloadsDir || '').trim();
    if (customDownloads) next.downloadsDir = resolve(customDownloads);
    // P2-5 多账号只做目录隔离：不同账号配不同 browser.profileDir，登录仍需手动完成。
    const customProfile = String(this.#config?.browser?.profileDir || '').trim();
    if (customProfile) {
      next.browserProfileDir = resolve(customProfile);
      next.browserControlDir = join(next.browserProfileDir, '.control');
      next.browserStateFile = join(next.browserControlDir, 'browser.json');
    }
    this.#paths = next;
  }

  #modelGateway() {
    return createModelGateway({
      config: this.#config,
      env: this.#env,
      llm: this.#llm,
      attachments: this.#attachments,
      sessionId: this.#sessionId,
    });
  }

  /**
   * 今日 token 预算状态：只汇总账本里本地日期（Asia/Shanghai）的 settle 事件。
   * 未结算的预留不计入，避免进程崩溃后余额永久为负。
   */
  dailyBudgetStatus(now = new Date()) {
    const raw = this.#config?.search?.dailyTokenBudget;
    const dailyLimit = raw === undefined || raw === null || raw === '' ? DEFAULT_DAILY_TOKEN_BUDGET : Number(raw);
    const task = configuredNumber(this.#config?.search?.tokenBudget, DEFAULT_TASK_TOKEN_BUDGET);
    return computeDailyBudget({
      ledgerPath: join(this.#paths.stateDir, 'token-usage.jsonl'),
      dailyLimit,
      taskLimit: Number.isSafeInteger(task) && task > 0 ? task : null,
      now,
    });
  }

  /** 任务开始前检查每日预算；耗尽时返回统一错误体，否则返回 null。 */
  #dailyBudgetBlocked() {
    const daily = this.dailyBudgetStatus();
    return daily.exhausted ? dailyBudgetExhaustedResult(daily) : null;
  }

  #tokenBudget() {
    const daily = this.dailyBudgetStatus();
    const task = configuredNumber(this.#config?.search?.tokenBudget, DEFAULT_TASK_TOKEN_BUDGET);
    const taskLimit = Number.isSafeInteger(task) && task > 0 ? task : null;
    if (!daily.enabled && taskLimit == null) return null;
    // 每日上限更小时以每日为准；剩余为 0 时用 1 兜底，真正的拦截由调用前的 #dailyBudgetBlocked() 完成。
    const limit = daily.enabled ? Math.max(1, daily.effectiveLimit) : taskLimit;
    return createTokenBudget({ limit, ledgerPath: join(this.#paths.stateDir, 'token-usage.jsonl') });
  }

  #downloader() {
    return createDownloadManager({
      config: this.#config,
      paths: this.#paths,
      env: this.#env,
      getContext: () => this.#host?.context || null,
    });
  }

  #retryQueue() {
    return createRetryQueue({
      stateDir: this.#paths.stateDir,
      maxAttempts: Number(this.#config?.download?.maxAttempts) || RETRY_DEFAULTS.maxAttempts,
    });
  }

  /** P2-3 重试队列状态（只读）。 */
  retryStatus() {
    return this.#retryQueue().status();
  }

  /**
   * 被拒素材的落点：`storage.rejectedDir` 配置了就平铺到 `<dir>/<YYYY-MM-DD>/`，
   * 没配置就返回空对象 → pipeline 走原来的“直接删”。
   */
  #rejectDropOptions() {
    const root = String(this.#config?.storage?.rejectedDir || '').trim();
    if (!root) return {};
    return { mode: 'move', backupDir: join(resolve(root), dateStamp()) };
  }

  /** P2-3 清空重试队列（不动候选记录）。 */
  clearRetryQueue() {
    return this.#retryQueue().clear();
  }

  #feedbackStore() {
    return createFeedbackStore({ stateDir: this.#paths.stateDir });
  }

  /** 样例画像最近一次更新时间（决定“回流后待重建”提示）。只取 .json，跳过 .history。 */
  #profileUpdatedAt() {
    const dir = join(this.#paths.libraryDir, 'profiles');
    if (!existsSync(dir)) return null;
    let newest = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        const at = Date.parse(raw?.updatedAt || '');
        if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
      } catch {
        // 损坏的画像文件不影响提示计算
      }
    }
    return newest === null ? null : new Date(newest).toISOString();
  }

  #pendingRebuild() {
    return this.#feedbackStore().pendingRebuild({ profileUpdatedAt: this.#profileUpdatedAt() });
  }

  /** P2-4 读一条候选的反馈。 */
  candidateFeedback({ videoId = '' } = {}) {
    const id = String(videoId || '').trim();
    if (!id) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 videoId。' };
    const candidate = this.#store().loadCandidates().get(id);
    if (!candidate) return { ok: false, code: 'CANDIDATE_NOT_FOUND', message: `候选 ${id} 不存在。` };
    const store = this.#feedbackStore();
    return {
      ok: true,
      videoId: id,
      feedback: store.get(id),
      summary: store.summary(),
      pendingRebuild: this.#pendingRebuild(),
      limits: FEEDBACK_LIMITS,
    };
  }

  /** P2-4 列出反馈（可按分数/标签/收藏筛选）。 */
  listCandidateFeedback({ minScore = 0, maxScore = 0, tag = '', favorite = false } = {}) {
    const store = this.#feedbackStore();
    return {
      ok: true,
      entries: store.filter({ minScore, maxScore, tag, favorite }),
      summary: store.summary(),
      pendingRebuild: this.#pendingRebuild(),
      limits: FEEDBACK_LIMITS,
    };
  }

  /** P2-4 写反馈：收藏 / 1-5 分 / 标签；只写 state/feedback.jsonl，不碰样例库。 */
  saveCandidateFeedback(input = {}) {
    const id = String(input?.videoId || '').trim();
    if (!id) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 videoId。' };
    const candidate = this.#store().loadCandidates().get(id);
    if (!candidate) return { ok: false, code: 'CANDIDATE_NOT_FOUND', message: `候选 ${id} 不存在。` };
    const store = this.#feedbackStore();
    try {
      const feedback = store.upsert(input);
      return { ok: true, videoId: id, feedback, summary: store.summary(), pendingRebuild: this.#pendingRebuild() };
    } catch (error) {
      return { ok: false, code: error?.code || 'INVALID_ARGUMENT', message: error?.message || String(error) };
    }
  }

  /** P2-4 撤销一条反馈（不改样例库）。 */
  removeCandidateFeedback({ videoId = '' } = {}) {
    const id = String(videoId || '').trim();
    if (!id) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 videoId。' };
    const store = this.#feedbackStore();
    try {
      store.remove(id);
      return { ok: true, videoId: id, summary: store.summary() };
    } catch (error) {
      return { ok: false, code: error?.code || 'INVALID_ARGUMENT', message: error?.message || String(error) };
    }
  }

  /**
   * P2-4 回流：把一条候选加入正/反样例。**只有用户显式点按钮才调用**。
   * 文件缺失时明确报 FILE_MISSING，不做静默降级。
   */
  async reflowFeedback({ videoId = '', polarity = 'positive', profileId = null, describe = true, signal } = {}) {
    const id = String(videoId || '').trim();
    if (!id) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 videoId。' };
    const candidate = this.#store().loadCandidates().get(id);
    if (!candidate) return { ok: false, code: 'CANDIDATE_NOT_FOUND', message: `候选 ${id} 不存在。` };
    const file = String(candidate.archive?.file || '');
    if (!file || !existsSync(file)) {
      return {
        ok: false,
        code: 'FILE_MISSING',
        message: `候选 ${id} 的归档文件不存在（${file || '未记录路径'}），无法加入样例库。请先在“素材库”里确认文件，或重新下载。`,
      };
    }
    const target = profileId || this.#config?.search?.defaultProfileId || null;
    const result = await this.libraryAdd({ file, profileId: target, polarity, describe, signal });
    const store = this.#feedbackStore();
    store.recordReflow({
      videoId: id,
      polarity,
      profileId: target,
      ok: result.ok === true,
      code: result.code || null,
      message: result.message || null,
    });
    return {
      ...result,
      reflow: { videoId: id, polarity, profileId: target, joined: result.ok === true },
      pendingRebuild: this.#pendingRebuild(),
    };
  }

  async modelCatalog() {
    const llm = this.#llm;
    if (!llm) {
      return {
        providers: [],
        models: [],
        errors: [{ provider: null, message: '当前 DSH 未提供模型目录服务，可改用自定义 OpenAI 兼容接口。' }],
        available: false,
      };
    }
    const providers = typeof llm.listProviders === 'function'
      ? llm.listProviders().map(({ id, name, displayName }) => ({ id, name: name || displayName || id }))
      : [];
    const groups = await Promise.all(providers.map(async ({ id }) => {
      if (typeof llm.listModels !== 'function') return { models: [], error: { provider: id, message: '模型目录服务未就绪。' } };
      let timer;
      try {
        const entries = await Promise.race([
          Promise.resolve().then(() => llm.listModels(id)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('目录查询超时')), 5_000); }),
        ]);
        const models = (Array.isArray(entries) ? entries : [])
          .filter((item) => item && item.provider === id && typeof item.id === 'string' && item.id)
          .map((item) => ({
            provider: id,
            id: item.id,
            name: typeof item.name === 'string' && item.name ? item.name : item.id,
            inputModalities: Array.isArray(item.inputModalities) ? item.inputModalities.filter((value) => ['text', 'image'].includes(value)) : [],
          }));
        return { models, error: models.length ? null : { provider: id, message: '该提供商没有可用模型。' } };
      } catch (error) {
        return { models: [], error: { provider: id, message: error?.message === '目录查询超时' ? '目录查询超时。' : '无法读取模型目录。' } };
      } finally {
        clearTimeout(timer);
      }
    }));
    return {
      providers,
      models: groups.flatMap((group) => group.models),
      errors: groups.flatMap((group) => group.error ? [group.error] : []),
      available: providers.length > 0,
    };
  }

  downloadStatus() {
    return this.#downloader().status();
  }

  getProxyConfig() {
    return resolveProxyConfig(this.#config, this.#env);
  }

  /**
   * 读取当前配置。公开响应只返回脱敏 DTO，密钥以 configured 状态表示。
   */
  config() {
    const proxy = this.getProxyConfig();
    return {
      ...this.#settings.public(),
      proxy: { configured: proxy.configured, server: proxy.server, hasAuth: Boolean(proxy.username || proxy.password) },
    };
  }

  /**
   * 合并式更新配置并落盘；仅允许白名单字段，返回脱敏结果。
   */
  updateConfig(patch = {}) {
    try {
      const updated = this.#settings.update(patch);
      this.#config = this.#settings.raw();
      this.#syncDownloadsPath();
      ensureRuntimePaths(this.#paths);
      this.#proxyCheckAt = 0;
      this.#proxyCheckResult = null;
      this.#proxyPoolInstance = null;
      return updated;
    } catch (error) {
      return { ok: false, code: error?.code || 'CONFIG_UPDATE_FAILED', message: error?.message || String(error) };
    }
  }

  /** P2-5 代理池：池非空时轮换，池空时沿用单代理。 */
  #proxyPool() {
    if (!this.#proxyPoolInstance) {
      const raw = this.#config?.proxy || {};
      this.#proxyPoolInstance = createProxyPool({
        pool: raw.pool || [],
        fallback: raw.server || '',
        ...(Number(raw.cooldownMs) > 0 ? { cooldownMs: Number(raw.cooldownMs) } : {}),
        ...(Number(raw.failureThreshold) > 0 ? { failureThreshold: Number(raw.failureThreshold) } : {}),
      });
    }
    return this.#proxyPoolInstance;
  }

  /** P2-5 代理池状态（只读）。 */
  proxyPoolStatus() {
    return this.#proxyPool().status();
  }

  /** P2-5 重置代理冷却（设置页“重置冷却”）。 */
  resetProxyPool() {
    return this.#proxyPool().reset();
  }

  async #proxyOption() {
    const pool = this.#proxyPool();
    if (pool.enabled) {
      const picked = pool.next();
      if (!picked.ok) {
        return {
          ok: false,
          failure: { code: picked.code || PROXY_ERROR_CODES.NOT_CONFIGURED, message: picked.message },
        };
      }
      const proxy = resolveProxyConfig(
        { proxy: { ...(this.#config?.proxy || {}), server: picked.server } },
        this.#env,
      );
      if (!proxy.configured || !proxy.valid) {
        pool.reportFailure(picked.server, proxy.invalidReason || 'invalid proxy');
        return { ok: false, failure: this.#proxyFailure(proxy), pool: { server: picked.server, source: picked.source } };
      }
      return {
        ok: true,
        option: {
          server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
          ...(proxy.username || proxy.password ? { username: proxy.username, password: proxy.password } : {}),
        },
        pool: { server: picked.server, source: picked.source, index: picked.index },
      };
    }
    const proxy = this.getProxyConfig();
    if (!proxy.configured) return { ok: false, failure: this.#proxyFailure(proxy) };
    if (!proxy.valid) return { ok: false, failure: this.#proxyFailure(proxy) };
    return {
      ok: true,
      option: {
        server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
        ...(proxy.username || proxy.password ? { username: proxy.username, password: proxy.password } : {}),
      },
    };
  }

  #proxyFailure(proxy) {
    if (!proxy.configured) {
      return {
        code: PROXY_ERROR_CODES.NOT_CONFIGURED,
        message: '未配置代理。TikTok 在本机必须经代理访问：请在 ~/.dsh/tiktok-browser/config.json 填写 proxy.server。',
      };
    }
    return {
      code: /socks/i.test(proxy.invalidReason || '') ? PROXY_ERROR_CODES.UNSUPPORTED : PROXY_ERROR_CODES.UNREACHABLE,
      message: proxy.invalidReason || '代理地址无效。',
    };
  }

  async #checkProxy({ force = false } = {}) {
    const pool = this.#proxyPool();
    // 池模式：每次都按轮换结果检查，并把结果回写给池（连续 2 次失败进入 10 分钟冷却）。
    if (pool.enabled) {
      const option = await this.#proxyOption();
      if (!option.ok) {
        return { ok: false, code: option.failure.code, message: option.failure.message, server: option.pool?.server || null, pool: pool.status() };
      }
      const server = option.pool.server;
      const proxy = resolveProxyConfig({ proxy: { ...(this.#config?.proxy || {}), server } }, this.#env);
      const result = await checkProxy({ proxy });
      if (result.ok) pool.reportSuccess(server);
      else pool.reportFailure(server, result.message);
      this.#activeProxyServer = server;
      return { ...result, server, pool: pool.status() };
    }
    const fresh = Date.now() - this.#proxyCheckAt < 60_000;
    if (!force && fresh && this.#proxyCheckResult) return this.#proxyCheckResult;
    const proxy = this.getProxyConfig();
    const result = await checkProxy({ proxy });
    this.#proxyCheckAt = Date.now();
    this.#proxyCheckResult = result;
    this.#activeProxyServer = result.ok ? proxy.server : this.#activeProxyServer;
    return result;
  }

  async #ensureHost({ signal } = {}) {
    if (this.#host?.context) {
      try {
        this.#host.context.pages();
        return { ok: true };
      } catch {
        this.#host = null;
      }
    }
    const proxy = await this.#proxyOption();
    if (!proxy.ok) return { ok: false, failure: proxy.failure };

    const port = await pickPort(configuredNumber(this.#config.port, PORT_RANGE[0]));
    if (!port) {
      return { ok: false, failure: { code: 'PORT_UNAVAILABLE', message: '9333–9350 端口都被占用，无法启动调试端口。' } };
    }
    signal?.throwIfAborted?.();
    const result = await runBrowserHost({
      profile: this.#paths.browserProfileDir,
      controlDir: this.#paths.browserControlDir,
      port,
      proxy: proxy.option,
      launchOptions: { downloadDir: join(this.#paths.stateDir, 'aix-downloads') },
    });
    if (!result.started) {
      // 池模式下启动失败也算一次代理失败（换个出口再试由下一轮启动完成）。
      if (proxy.pool?.server) this.#proxyPool().reportFailure(proxy.pool.server, result.message || result.code);
      return { ok: false, failure: { code: result.code || BROWSER_ERROR_CODES.LAUNCH_FAILED, message: result.message } };
    }
    this.#host = result;
    return { ok: true };
  }

  async open({ keyword = '', reuse = true, signal } = {}) {
    const text = String(keyword || '').trim();
    const proxy = await this.#checkProxy();
    if (!proxy.ok) {
      return {
        opened: false,
        code: proxy.code,
        message: proxy.message,
        proxy: { ok: false, server: proxy.server, code: proxy.code },
        browser: null,
        page: null,
        loginRequired: false,
        verificationRequired: false,
      };
    }

    if (!reuse && this.#host) {
      await this.close();
    }

    const host = await this.#ensureHost({ signal });
    if (!host.ok) {
      return {
        opened: false,
        code: host.failure.code,
        message: host.failure.message,
        proxy: { ok: true, server: proxy.server },
        browser: null,
        page: null,
        loginRequired: false,
        verificationRequired: false,
      };
    }

    const context = this.#host.context;
    let page = await findPageByRole(context, 'prepare');
    if (!page || page.isClosed() || text) {
      page = await ensurePreparePage(context, { signal, navigate: !text });
    }
    if (text) {
      const url = `${SEARCH_URL}${encodeURIComponent(text)}`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }

    const signals = await readPageSignals(page);
    return {
      opened: true,
      mode: text ? 'search' : 'home',
      keyword: text || null,
      url: signals.url,
      title: signals.title,
      state: describePageState(signals),
      proxy: { ok: true, server: proxy.server },
      loginRequired: signals.loginRequired,
      verificationRequired: signals.verificationRequired,
      browser: { pid: this.#host.pid || null, port: this.#host.port },
      page: describePage(page),
      code: null,
      message: signals.loginRequired
        ? '页面要求登录：请在 Edge 窗口内手动登录一次，之后专用 profile 会保留登录态。'
        : signals.verificationRequired
          ? '页面出现验证码：请在 Edge 窗口内手动完成验证。'
          : null,
    };
  }

  #store() {
    return createStore({ stateDir: this.#paths.stateDir, controlDir: this.#paths.browserControlDir });
  }

  async search({ query = '', limit, detail = true, download = false, preferNoWatermark = null, judge = false, profileId = null, signal } = {}) {
    const text = String(query || '').trim();
    if (!text) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '关键词不能为空。' };
    }
    const dailyBlocked = this.#dailyBudgetBlocked();
    if (dailyBlocked) return dailyBlocked;

    let judgeProfile = null;
    if (judge) {
      judgeProfile = findProfile(this.#config, profileId, this.#paths.libraryDir);
      if (!judgeProfile) {
        return { ok: false, code: 'INVALID_PROFILE', message: `未知画像：${profileId || '(空)'}。可调用 tiktok_profiles 查看可用画像。` };
      }
    }

    const halt = this.#store().readHalt();
    if (halt) {
      return {
        ok: false,
        code: 'CAPTCHA_REQUIRED',
        message: `上次运行因验证码挂起（${halt.at || ''}）。请在 Edge 窗口内手动完成验证，然后调用 tiktok_collect_resume 或删除 control/halt.json 后重试。`,
        halt,
      };
    }

    const proxy = await this.#checkProxy();
    if (!proxy.ok) {
      return { ok: false, code: proxy.code, message: proxy.message, proxy: { ok: false, server: proxy.server } };
    }

    const host = await this.#ensureHost({ signal });
    if (!host.ok) {
      return { ok: false, code: host.failure.code, message: host.failure.message };
    }

    const context = this.#host.context;
    const store = this.#store();
    const searchPage = await ensurePage(context, 'search');
    const getPage = (role) => ensurePage(context, role);

    const summary = await runSearch({
      searchPage,
      getPage,
      store,
      config: this.#config,
      query: text,
      limit,
      detail,
      download,
      downloadsDir: this.#paths.downloadsDir,
      preferNoWatermark,
      judge,
      judgeProfile,
      judgePaths: judge ? this.#paths : null,
      judgeApi: null,
      judgeConfig: this.#config.judge || {},
      modelGateway: this.#modelGateway(),
      budget: this.#tokenBudget(),
      downloadManager: this.#downloader(),
      stateDir: this.#paths.stateDir,
      retryQueue: this.#retryQueue(),
      signal,
    });

    return { ...summary, proxy: { ok: true, server: proxy.server } };
  }

  /**
   * 下载已入库的候选作品（不重新搜索）。
   * @param {object} options
   * @param {string} [options.query] 只下载该关键词下的候选
   * @param {string[]} [options.videoIds] 指定作品 ID 列表（优先于 query）
   * @param {number} [options.limit] 最多下载几条
   * @param {boolean} [options.preferNoWatermark] 优先无水印地址（playAddr）
   */
  async download({ query = '', videoIds = null, limit = 10, preferNoWatermark = null, signal } = {}) {
    const noWatermark = preferNoWatermark === null
      ? this.#config?.download?.preferNoWatermark !== false
      : preferNoWatermark !== false;
    const halt = this.#store().readHalt();
    if (halt) {
      return { ok: false, code: 'CAPTCHA_REQUIRED', message: `上次运行因验证码挂起（${halt.at || ''}）。请先在 Edge 窗口内手动完成验证。`, halt };
    }

    const proxy = await this.#checkProxy();
    if (!proxy.ok) {
      return { ok: false, code: proxy.code, message: proxy.message, proxy: { ok: false, server: proxy.server } };
    }

    const host = await this.#ensureHost({ signal });
    if (!host.ok) {
      return { ok: false, code: host.failure.code, message: host.failure.message };
    }

    const context = this.#host.context;
    const store = this.#store();
    const wanted = Array.isArray(videoIds) ? new Set(videoIds.map(String)) : null;
    const text = String(query || '').trim();
    const downloadManager = this.#downloader();
    const urlOnlyDownload = downloadManager.status().channel !== 'page';

    const rows = store.listCandidates({ limit: 1000 }).filter((row) => {
      if (!row?.videoId) return false;
      if (wanted && !wanted.has(String(row.videoId))) return false;
      if (!wanted && text && row.query !== text) return false;
      if (row.status === CANDIDATE_STATUS.ARCHIVED) return false;
      // P1-5：语言不符的候选已经决定不下载，绕过筛选单独补下载也不做，避免白花流量。
      if (row.status === CANDIDATE_STATUS.SKIPPED_LANGUAGE) return false;
      return urlOnlyDownload
        ? Boolean(row.url || row.video?.downloadAddr || row.video?.playAddr)
        : Boolean(row.video?.downloadAddr || row.video?.playAddr);
    });

    const max = Math.max(1, Math.min(Number(limit) || 10, 200));
    const picked = rows.slice(0, max);
    if (!picked.length) {
      return { ok: true, downloaded: 0, failed: 0, skipped: 0, message: '没有可下载的候选（可能都已归档或缺少地址）。', items: [] };
    }

    const videoPage = await ensurePage(context, 'video');
    const items = [];
    let downloaded = 0;
    let failed = 0;

    for (const candidate of picked) {
      const archived = await downloadManager.download({
        page: videoPage,
        candidate,
        downloadsDir: this.#paths.downloadsDir,
        keyword: candidate.query || text || 'untitled',
        preferNoWatermark: noWatermark,
        signal,
        refresh: async (videoId) => {
          const again = await extractVideoDetail(videoPage, { videoId, url: candidate.url, waitMs: 1500 });
          return again.ok ? again.data : null;
        },
      });

      if (archived.ok) {
        downloaded += 1;
        store.upsertCandidate({
          ...candidate,
          status: CANDIDATE_STATUS.ARCHIVED,
          archive: {
            file: archived.file,
            bytes: archived.bytes,
            source: archived.source,
            channel: archived.channel || 'page',
            watermark: archived.watermark || 'unknown',
            skipped: Boolean(archived.skipped),
          },
        });
        items.push({
          videoId: candidate.videoId,
          ok: true,
          file: archived.file,
          bytes: archived.bytes,
          source: archived.source,
          channel: archived.channel || 'page',
          skipped: Boolean(archived.skipped),
        });
      } else {
        failed += 1;
        store.upsertCandidate({
          ...candidate,
          status: CANDIDATE_STATUS.DOWNLOAD_FAILED,
          archiveError: { code: archived.code, message: archived.message, channel: archived.channel || null, manualRequired: archived.manualRequired === true },
        });
        items.push({
          videoId: candidate.videoId,
          ok: false,
          code: archived.code,
          message: archived.message,
          channel: archived.channel || null,
          manualRequired: archived.manualRequired === true,
        });
        if (archived.manualRequired) break;
      }
    }

    return {
      ok: downloaded > 0,
      query: text || null,
      requested: picked.length,
      downloaded,
      failed,
      manualDownloadRequired: items.some((item) => item.manualRequired === true),
      downloadsDir: this.#paths.downloadsDir,
      items,
      proxy: { ok: true, server: proxy.server },
    };
  }

  profiles() {
    return {
      ok: true,
      profiles: listProfiles(this.#config, this.#paths.libraryDir).map((profile) => ({
        id: profile.id,
        name: profile.name,
        threshold: profile.threshold,
        keywords: profile.keywords || [],
        mustHave: profile.mustHave || [],
        niceToHave: profile.niceToHave || [],
        mustNot: profile.mustNot || [],
        guidance: profile.guidance || '',
        generated: profile.generated === true,
        sampleCount: profile.sampleCount || 0,
        negativeCount: profile.negativeCount || 0,
      })),
      judge: {
        threshold: this.#config?.judge?.threshold ?? 60,
        modelWeight: this.#config?.judge?.modelWeight ?? 0.6,
        prefilter: this.#config?.judge?.prefilter ?? 'off',
        coverPrefilter: this.#config?.judge?.coverPrefilter === true,
        textPrefilter: this.#config?.judge?.textPrefilter === true,
        dedup: this.#config?.dedup?.enabled === true,
        sellingPoints: this.#config?.judge?.sellingPoints === true,
        model: this.#modelGateway().describe('vision').model || null,
        modelSource: this.#modelGateway().describe('vision').source,
        modelConfigured: this.#modelGateway().describe('vision').configured,
      },
      library: { dir: this.#paths.libraryDir },
    };
  }

  /** P2-1 去重状态：配置 + 指纹索引条数（只读，不计算任何指纹）。 */
  dedupStatus() {
    const options = resolveDedupOptions(this.#config);
    const index = createDedupIndex({ stateDir: this.#paths.stateDir, options });
    return {
      enabled: options.enabled,
      videoDistance: options.videoDistance,
      textSimilarity: options.textSimilarity,
      textOnlySimilarity: options.textOnlySimilarity,
      frames: options.frames,
      indexed: index.size(),
    };
  }

  #library() {
    return createLibrary({
      libraryDir: this.#paths.libraryDir,
      env: this.#env,
      modelGateway: this.#modelGateway(),
      budgetFactory: () => this.#tokenBudget(),
    });
  }

  /** 查看样例库：样例清单 + 索引统计 + 正/反样例数量。 */
  library() {
    const lib = this.#library();
    const samples = lib.listSamples({ limit: 500 });
    const byProfile = {};
    for (const sample of samples) {
      const key = sample.profileId || 'unassigned';
      byProfile[key] = (byProfile[key] || 0) + 1;
    }
    const negatives = samples.filter((sample) => sample.polarity === 'negative').length;
    return {
      ok: true,
      dir: this.#paths.libraryDir,
      count: samples.length,
      byProfile,
      positiveCount: samples.length - negatives,
      negativeCount: negatives,
      unassigned: lib.countUnassigned(),
      defaultsHidden: lib.loadState().defaultsHidden,
      samples: samples.map((sample) => ({
        id: sample.id || sample.sampleId,
        file: sample.file,
        bytes: Number(sample.bytes) || 0,
        profileId: sample.profileId || null,
        polarity: sample.polarity === 'negative' ? 'negative' : 'positive',
        query: sample.query || null,
        duration: sample.meta?.duration ?? null,
        desc: String(sample.meta?.desc || '').slice(0, 120),
        hasFeatures: Boolean(sample.features),
        addedAt: sample.addedAt || null,
      })),
    };
  }

  /**
   * 素材库分页查询：只返回列表需要的小字段，避免把整库塞进每 2.5s 轮询的 /state。
   * 同一 videoId 以最后一条候选为准（store.loadCandidates 已去重）。
   */
  libraryCandidates({ status = '', query = '', sinceDays = 0, limit = 30, offset = 0, minScore = 0, tag = '', videoId = '' } = {}) {
    const store = this.#store();
    const rows = [...store.loadCandidates().values()];
    // 筛选逻辑与导出共用同一实现，保证 CSV 行数与这里一致。
    // 列表默认隐藏 3 天前的旧记录（只影响展示，不删文件/数据）。两种情况绕过该隐藏：
    //   1) 按 videoId 精确检索 —— 旧素材仍要能查到；
    //   2) 用户主动把「时间范围」放宽到 7/30 天 —— 此时按用户所选范围显示，避免下拉框形同虚设。
    // 导出不走这里的 maxAgeDays，保持全量。
    const exactVideoId = String(videoId || '').trim();
    const wideRange = Number(sinceDays) > LIBRARY_HIDE_AFTER_DAYS;
    const matched = filterCandidateRows(rows, {
      status,
      query,
      sinceDays,
      videoId: exactVideoId,
      maxAgeDays: exactVideoId || wideRange ? 0 : LIBRARY_HIDE_AFTER_DAYS,
    });
    // P2-4：人工评分/标签筛选（只在设置页生效，导出仍按状态/关键词/时间）。
    const feedback = this.#feedbackStore();
    const lowScore = Number(minScore) || 0;
    const wantedTag = String(tag || '').trim().toLowerCase();
    const scored = lowScore > 0 || wantedTag
      ? matched.filter((row) => {
          const value = feedback.get(row.videoId);
          if (!value) return false;
          if (lowScore > 0 && !(Number(value.score) >= lowScore)) return false;
          if (wantedTag && !(value.tags || []).some((item) => String(item).toLowerCase() === wantedTag)) return false;
          return true;
        })
      : matched;
    const total = scored.length;
    const size = Math.max(1, Math.min(Number(limit) || 30, 100));
    const start = Math.max(0, Math.min(Number(offset) || 0, Math.max(0, total - 1)));
    const page = scored.slice(start, start + size).map((row) => {
      const file = String(row.archive?.file || '');
      const exists = Boolean(file) && existsSync(file);
      const score = Number(row.judge?.score);
      const own = feedback.get(row.videoId);
      return {
        videoId: String(row.videoId || ''),
        status: row.status || 'unknown',
        query: row.query || '',
        author: row.author?.uniqueId || row.author?.nickname || '',
        nickname: row.author?.nickname || '',
        desc: String(row.desc || '').replace(/\s+/g, ' ').slice(0, 120),
        duration: Number(row.duration) || 0,
        score: Number.isFinite(score) ? score : null,
        verdict: row.judge?.verdict || '',
        language: row.language?.code && row.language.code !== 'unknown' ? row.language.code : '',
        url: row.url || '',
        updatedAt: row.updatedAt || '',
        archive: { file: exists ? file : '', bytes: Number(row.archive?.bytes) || 0, exists },
        feedback: own
          ? { favorite: own.favorite === true, score: own.score ?? null, tags: own.tags || [], at: own.at || null, reflow: own.reflow || null }
          : null,
      };
    });

    return {
      ok: true,
      total,
      offset: start,
      limit: size,
      hasMore: total > 0 && start + size < total,
      counts: store.countCandidates(),
      statuses: Object.values(CANDIDATE_STATUS),
      candidates: page,
    };
  }

  /**
   * P2-2 导出候选 CSV：筛选口径与 libraryCandidates 完全一致（同一个 filterCandidateRows）。
   * 只读候选库，写 exports/candidates-YYYY-MM-DD.csv（UTF-8 BOM）。
   */
  exportCandidates({ status = '', query = '', sinceDays = 0 } = {}) {
    const store = this.#store();
    const rows = [...store.loadCandidates().values()];
    const matched = filterCandidateRows(rows, { status, query, sinceDays });
    const exportsDir = join(this.#paths.stateDir, 'exports');
    const result = exportCandidatesCsv({ rows: matched, exportsDir });
    return {
      ...result,
      filters: {
        status: String(status || 'all') || 'all',
        query: String(query || ''),
        sinceDays: Number(sinceDays) || 0,
      },
      counts: store.countCandidates(),
    };
  }

  /**
   * 在资源管理器里定位文件。只接受归档目录、样例库、日报目录内的真实文件，
   * `resolve` 之后再校验，挡住 `..` 和绝对路径穿越。
   */
  revealPath({ file = '', scope = 'any' } = {}) {
    const target = String(file || '').trim();
    if (!target) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要文件路径。' };
    if (process.platform !== 'win32') return { ok: false, code: 'UNSUPPORTED', message: '当前系统不支持资源管理器定位。' };
    if (target.includes('\0')) return { ok: false, code: 'INVALID_ARGUMENT', message: '文件路径非法。' };

    const resolved = resolve(target);
    const reportsDir = resolve(this.#paths.stateDir, 'reports');
    const exportsDir = resolve(this.#paths.stateDir, 'exports');
    const roots = scope === 'reports'
      ? [reportsDir]
      : [resolve(this.#paths.downloadsDir), resolve(this.#paths.libraryDir), reportsDir, exportsDir];
    const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    const inside = roots.some((root) => {
      const rel = relative(fold(root), fold(resolved));
      return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
    });
    if (!inside) {
      return { ok: false, code: 'PATH_NOT_ALLOWED', message: '只允许打开归档目录、样例库或日报目录内的文件。' };
    }
    if (!existsSync(resolved)) return { ok: false, code: 'FILE_MISSING', message: '文件不存在或已被移动。' };

    try {
      if (this.#revealHandler) this.#revealHandler(resolved);
      else {
        const child = spawn('explorer.exe', [`/select,${resolved}`], { detached: true, stdio: 'ignore' });
        child.unref();
      }
    } catch (error) {
      return { ok: false, code: 'REVEAL_FAILED', message: error.message };
    }
    return { ok: true, file: resolved };
  }

  /** 导入样例：本地视频路径或已下载候选的 videoId；polarity=negative 表示反样例。 */
  async libraryAdd({ file = '', videoId = '', profileId = null, polarity = 'positive', describe = true, signal } = {}) {
    const lib = this.#library();
    let source = String(file || '').trim();

    if (!source && videoId) {
      // 精确查找（与 candidateFeedback/reflowFeedback 同口径）：listCandidates 有 1000 条截断上限，老素材会漏。
      const row = this.#store().loadCandidates().get(String(videoId));
      if (!row) {
        return { ok: false, code: 'NOT_FOUND', message: `库中没有 videoId=${videoId} 的候选。` };
      }
      source = row.archive?.file || row.archiveFile || '';
      if (!source || !existsSync(source)) {
        return { ok: false, code: 'FILE_MISSING', message: '该候选还没有归档视频文件，请先 tiktok_download。', videoId };
      }
    }
    if (!source) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 file（本地视频路径）或 videoId。' };
    }

    const result = await lib.addSample({ file: source, profileId, polarity, describe, signal });
    if (!result.ok) return result;
    return {
      ok: true,
      sample: {
        id: result.sample.sampleId || result.sample.id,
        file: result.sample.file,
        profileId: result.sample.profileId || null,
        polarity: result.sample.polarity || 'positive',
        features: result.sample.features || null,
      },
      count: lib.listSamples().length,
      dir: this.#paths.libraryDir,
    };
  }

  /** 切换已有样例的正/反极性（P1-2：不用重新上传就能标注反样例）。 */
  librarySetPolarity({ sampleId = '', polarity = '' } = {}) {
    return this.#library().setSamplePolarity({ sampleId, polarity });
  }

  /** 从样例库生成画像卡（可校准阈值）；目标画像正样例不足时自动接管“未指定归属”的样例。 */
  profileBuild({ profileId = '', name = '', threshold = null, calibrate = false, minSamples = 3, includeUnassigned = true } = {}) {
    const rawId = String(profileId || '').trim();
    if (!rawId) return { ok: false, code: 'INVALID_ARGUMENT', message: '画像 ID 不能为空；例如填 puzzle-match3。' };
    if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(rawId)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '画像 ID 只能包含字母、数字、下划线或短横线，最多 64 个字符。' };
    }
    const id = rawId;
    const lib = this.#library();
    const min = Math.max(1, Number(minSamples) || 3);
    const owned = lib.countSamples({ profileId: id, polarity: 'positive' });
    const negativeOwned = lib.countSamples({ profileId: id, polarity: 'negative' });
    const unassigned = lib.countUnassigned();
    let adopted = 0;
    if (includeUnassigned && owned < min && unassigned > 0) {
      adopted = lib.assignUnassigned(id);
    }
    const result = lib.buildProfile({ profileId: id, name, threshold, minSamples: min });
    if (!result.ok) {
      const remain = lib.countSamples({ profileId: id, polarity: 'positive' });
      const negatives = lib.countSamples({ profileId: id, polarity: 'negative' });
      return {
        ...result,
        profileId: id,
        owned: remain,
        negativeCount: negatives,
        adopted,
        unassigned: lib.countUnassigned(),
        message: remain < min
          ? `正样例不足：画像 ${id} 现有 ${remain} 条，至少需要 ${min} 条（反样例 ${negatives} 条不计入）${adopted ? `；已自动接管 ${adopted} 条未归属样例` : ''}。请先上传视频，或在上传时把“新画像 ID”填成 ${id}。`
          : result.message,
      };
    }
    if (calibrate) {
      const calibration = lib.calibrate({
        profile: result.profile,
        samples: lib.listSamples({ profileId: id, polarity: 'positive' }),
        negatives: lib.listSamples({ profileId: id, polarity: 'negative' }),
      });
      if (calibration && Number.isFinite(Number(calibration.threshold))) {
        lib.buildProfile({ profileId: id, name, threshold: calibration.threshold, minSamples: min });
        return { ok: true, profile: { ...result.profile, threshold: calibration.threshold }, calibration, adopted, dir: this.#paths.libraryDir };
      }
      return { ok: true, profile: result.profile, calibration, adopted, dir: this.#paths.libraryDir };
    }
    return { ok: true, profile: result.profile, adopted, dir: this.#paths.libraryDir };
  }

  /** 保存对已生成素材筛选画像的人工修改。 */
  saveMaterialProfile({ id = '', patch = {} } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'patch 必须是对象。' };
    }
    return this.#library().updateProfile({ profileId: id, patch });
  }

  /** 保存对已生成观看兴趣画像的人工修改。 */
  saveInterestProfile({ id = '', patch = {} } = {}) {
    const profileId = String(id || '').trim();
    if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(profileId)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '画像 ID 不合法。' };
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'patch 必须是对象。' };
    }
    const file = join(this.#interestDir(), `${profileId}.json`);
    if (!existsSync(file)) {
      return { ok: false, code: 'NOT_FOUND', message: `没有观看兴趣画像 ${profileId}。` };
    }
    let current;
    try {
      current = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return { ok: false, code: 'PROFILE_CORRUPTED', message: '观看兴趣画像文件无法解析。' };
    }
    if (!current || current.id !== profileId) {
      return { ok: false, code: 'PROFILE_CORRUPTED', message: '观看兴趣画像文件内容不匹配。' };
    }
    const merged = normalizeInterestProfile(
      { ...current, ...patch },
      { id: profileId, sampleCount: Number(current.sampleCount) || 0 },
    );
    if (!merged) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '至少保留 summary、interests 或 positiveSeeds 之一。' };
    }
    merged.generatedAt = current.generatedAt || merged.generatedAt;
    merged.updatedAt = new Date().toISOString();
    this.#recordInterestVersion(current, 'edit');
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
    return { ok: true, profile: merged, file };
  }

  /** 素材筛选画像的历史版本（新 → 旧）。 */
  listMaterialProfileHistory({ id = '' } = {}) {
    const profileId = String(id || '').trim();
    if (!profileId) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要画像 ID。' };
    return this.#library().listProfileHistory({ profileId });
  }

  /** 把素材筛选画像恢复到某个历史版本（恢复前先给当前版本留档）。 */
  restoreMaterialProfile({ id = '', version = '' } = {}) {
    if (!String(version || '').trim()) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 version。' };
    }
    return this.#library().restoreProfile({ profileId: id, version });
  }

  /** 观看兴趣画像的历史版本（新 → 旧）。 */
  listInterestProfileHistory({ id = '' } = {}) {
    const profileId = String(id || '').trim();
    if (!profileId) return { ok: false, code: 'INVALID_ARGUMENT', message: '需要画像 ID。' };
    return listVersions({ rootDir: this.#interestHistoryRoot(), id: profileId });
  }

  /** 把观看兴趣画像恢复到某个历史版本（恢复前先给当前版本留档）。 */
  restoreInterestProfile({ id = '', version = '' } = {}) {
    const profileId = String(id || '').trim();
    if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(profileId)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '画像 ID 不合法。' };
    }
    if (!String(version || '').trim()) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '需要 version。' };
    }
    const target = readVersion({ rootDir: this.#interestHistoryRoot(), id: profileId, version });
    if (!target.ok) return target;
    if (target.data.id !== profileId) {
      return { ok: false, code: 'PROFILE_CORRUPTED', message: `版本 ${version} 的画像 ID 与目标不一致。` };
    }
    const file = join(this.#interestDir(), `${profileId}.json`);
    let current = null;
    try {
      current = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      current = null;
    }
    if (current && current.id === profileId) this.#recordInterestVersion(current, 'restore');
    const now = new Date().toISOString();
    const next = { ...target.data, restoredAt: now, updatedAt: now };
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
    return { ok: true, profile: next, version: target.version, restoredAt: now };
  }

  /** 清空样例与全部画像（需显式 confirm）；清空后隐藏内置默认画像。 */
  purgeLibrary({ confirm = false } = {}) {
    if (confirm !== true) {
      return { ok: false, code: 'CONFIRM_REQUIRED', message: '清空操作需要二次确认。' };
    }
    const result = this.#library().purge({ backup: true });
    try {
      if (this.#config?.search?.defaultProfileId) {
        this.updateConfig({ search: { defaultProfileId: '' } });
      }
    } catch {
      // 配置清理失败不影响“样例与画像已清空”的结果。
    }
    return result;
  }

  restoreDefaultProfiles() {
    return this.#library().restoreDefaultProfiles();
  }

  #interestDir() {
    return join(this.#paths.libraryDir, 'interest-profiles');
  }

  #interestHistoryRoot() {
    // 历史工具内部拼 `.history`，这里传兴趣画像父目录。
    return this.#interestDir();
  }

  /** 兴趣画像留档；写历史失败不应阻塞画像本身的保存。 */
  #recordInterestVersion(profile, source) {
    if (!profile || typeof profile !== 'object' || !profile.id) return null;
    try {
      const result = writeVersion({ rootDir: this.#interestHistoryRoot(), id: profile.id, source, data: profile });
      return result.ok ? result : null;
    } catch {
      return null;
    }
  }

  listInterestProfiles() {
    const dir = this.#interestDir();
    if (!existsSync(dir)) return { ok: true, count: 0, profiles: [] };
    const profiles = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
        if (parsed?.id) profiles.push(parsed);
      } catch {
        // 损坏的画像不阻塞设置页。
      }
    }
    profiles.sort((left, right) => String(right.generatedAt || '').localeCompare(String(left.generatedAt || '')));
    return { ok: true, count: profiles.length, profiles };
  }

  async buildInterestProfile({ id = 'interest', name = '', minSamples = 3, signal } = {}) {
    const dailyBlocked = this.#dailyBudgetBlocked();
    if (dailyBlocked) return dailyBlocked;
    const profileId = String(id || 'interest').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 64) || 'interest';
    const samples = this.#library().listSamples({ limit: 200 });
    if (samples.length < Math.max(1, Number(minSamples) || 3)) {
      return { ok: false, code: 'NOT_ENOUGH_SAMPLES', message: `样例不足：${samples.length} 条，至少需要 ${minSamples} 条。` };
    }
    const budget = this.#tokenBudget() || createTokenBudget({
      limit: 50_000,
      ledgerPath: join(this.#paths.stateDir, 'token-usage.jsonl'),
    });
    const result = await buildInterestProfileWithModel({
      samples,
      gateway: this.#modelGateway(),
      budget,
      signal,
      id: profileId,
    });
    if (!result.ok) return { ...result, budget: budget.state() };
    const profile = { ...result.profile, ...(name.trim() ? { name: name.trim().slice(0, 80) } : {}) };
    const dir = this.#interestDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${profileId}.json`);
    // 重新生成前把旧兴趣画像存进历史（source=build）。
    if (existsSync(file)) {
      try {
        const previous = JSON.parse(readFileSync(file, 'utf8'));
        if (previous?.id === profileId) this.#recordInterestVersion(previous, 'build');
      } catch {
        // 旧文件损坏时跳过留档，直接覆盖。
      }
    }
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
    return { ok: true, profile, file, model: result.model, source: result.source, usage: result.usage, budget: budget.state() };
  }

  async previewKeywords({
    seeds = [],
    targetCount = 10,
    queryLanguage = 'en',
    contentLanguage = 'en',
    exclude = [],
    signal,
  } = {}) {
    const cleanSeeds = [...new Set((Array.isArray(seeds) ? seeds : String(seeds || '').split(/[\n,，;；]+/))
      .map((item) => String(item || '').trim())
      .filter(Boolean))].slice(0, 20);
    if (!cleanSeeds.length) return { ok: false, code: 'INVALID_ARGUMENT', message: '至少填写一个种子词。' };
    const dailyBlocked = this.#dailyBudgetBlocked();
    if (dailyBlocked) return dailyBlocked;
    const budget = this.#tokenBudget() || createTokenBudget({
      limit: 50_000,
      ledgerPath: join(this.#paths.stateDir, 'token-usage.jsonl'),
    });
    const result = await expandKeywords({
      seeds: cleanSeeds,
      targetCount,
      queryLanguage,
      contentLanguage,
      exclude,
      gateway: this.#modelGateway(),
      budget,
      signal,
    });
    return { ...result, seeds: cleanSeeds, budget: budget.state() };
  }

  async expandAndCollect({
    seeds = [],
    targetCount = 10,
    queryLanguage = 'en',
    contentLanguage = 'en',
    exclude = [],
    profileId = null,
    maxPerRun = 5,
    download = true,
    judge = true,
    resume = true,
    pauseMs = 4000,
    onProgress = null,
    signal,
  } = {}) {
    const cleanSeeds = [...new Set((Array.isArray(seeds) ? seeds : String(seeds || '').split(/[\n,，;；]+/))
      .map((item) => String(item || '').trim())
      .filter(Boolean))].slice(0, 20);
    if (!cleanSeeds.length) return { ok: false, code: 'INVALID_ARGUMENT', message: '至少填写一个种子词。' };
    const dailyBlocked = this.#dailyBudgetBlocked();
    if (dailyBlocked) return dailyBlocked;
    const budget = this.#tokenBudget() || createTokenBudget({
      limit: 50_000,
      ledgerPath: join(this.#paths.stateDir, 'token-usage.jsonl'),
    });
    const modelGateway = this.#modelGateway();
    const downloadManager = this.#downloader();
    const expansion = await expandKeywords({
      seeds: cleanSeeds,
      targetCount,
      queryLanguage,
      contentLanguage,
      exclude,
      gateway: modelGateway,
      budget,
      signal,
    });
    if (!expansion.ok) {
      return { ...expansion, seeds: cleanSeeds, budget: budget.state() };
    }
    const keywords = [...new Set([...cleanSeeds, ...expansion.keywords])];
    const baseProgress = {
      phase: 'collecting',
      keywords,
      expansion: { keywords: expansion.keywords, count: expansion.count },
    };
    onProgress?.({ ...baseProgress, budget: budget.state() });
    const result = await this.collect({
      keywords,
      maxPerRun,
      profileId,
      download,
      judge,
      resume,
      pauseMs,
      budget,
      modelGateway,
      downloadManager,
      onProgress: (p) => onProgress?.({ ...baseProgress, budget: budget.state(), progress: p }),
      signal,
    });
    return {
      ok: Boolean(result.ok),
      seeds: cleanSeeds,
      keywords,
      expansion: {
        keywords: expansion.keywords,
        count: expansion.count,
        model: expansion.model,
        source: expansion.source,
        usage: expansion.usage,
      },
      result,
      budget: budget.state(),
    };
  }

  /**
   * 对已入库候选做素材判定（规则分 + 模型分），不合格的删除视频只留 JSON。
   */
  async judge({ query = '', videoIds = null, limit = 10, profileId = null, signal } = {}) {
    const dailyBlocked = this.#dailyBudgetBlocked();
    if (dailyBlocked) return dailyBlocked;
    const store = this.#store();
    const profile = findProfile(this.#config, profileId, this.#paths.libraryDir);
    if (!profile) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: `未知画像：${profileId}` };
    }
    const modelGateway = this.#modelGateway();
    const budget = this.#tokenBudget();
    const downloadManager = this.#downloader();
    const urlOnlyDownload = downloadManager.status().channel !== 'page';

    const text = String(query || '').trim();
    const ids = Array.isArray(videoIds) ? videoIds.map((id) => String(id)) : null;
    const pool = store
      .listCandidates({ limit: 1000 })
      .filter((row) => {
        if (ids && ids.length) return ids.includes(String(row.videoId));
        if (text) return row.query === text;
        return true;
      })
      .filter((row) => !['rejected', 'accepted'].includes(row.status))
      .filter((row) => (urlOnlyDownload ? Boolean(row.url) : false) || row.video?.downloadAddr || row.video?.playAddr || row.archive?.file);

    const max = Math.max(1, Math.min(Number(limit) || 10, 200));
    const picked = pool.slice(0, max);
    if (!picked.length) {
      return {
        ok: false,
        code: 'NOTHING_TO_JUDGE',
        message: '没有可判定的候选（已判定过的会被跳过）。',
        counts: store.countCandidates(),
      };
    }

    // 只有需要先下载视频时才要求代理与浏览器；已归档的本地文件可离线判定。
    const needsDownload = picked.some((row) => !row.archive?.file);
    let proxy = { ok: true, server: this.getProxyConfig()?.server || null };
    let videoPage = null;
    if (needsDownload) {
      proxy = await this.#checkProxy();
      if (!proxy.ok) {
        return { ok: false, code: proxy.code, message: proxy.message, proxy: { ok: false, server: proxy.server } };
      }
      const host = await this.#ensureHost({ signal });
      if (!host.ok) {
        return { ok: false, code: host.failure.code, message: host.failure.message };
      }
      videoPage = await ensurePage(this.#host.context, 'video');
    }
    const startedAt = Date.now();
    const items = [];
    let accepted = 0;
    let rejected = 0;
    let failed = 0;
    let budgetExhausted = false;

    for (const row of picked) {
      signal?.throwIfAborted?.();
      let candidate = row;
      let videoPath = row.archive?.file || null;

      // 没有本地视频就先下载（判定要看关键帧）
      if (!videoPath) {
        const archived = await downloadManager.download({
          page: videoPage,
          candidate: row,
          downloadsDir: this.#paths.downloadsDir,
          keyword: row.query || text || 'untitled',
          preferNoWatermark: this.#config?.download?.preferNoWatermark !== false,
          signal,
          refresh: async (videoId) => {
            const again = await extractVideoDetail(videoPage, { videoId, url: row.url, waitMs: 1500 });
            return again.ok ? again.data : null;
          },
        });
        if (!archived.ok) {
          failed += 1;
          store.upsertCandidate({
            ...row,
            status: CANDIDATE_STATUS.DOWNLOAD_FAILED,
            archiveError: { code: archived.code, message: archived.message, channel: archived.channel || null, manualRequired: archived.manualRequired === true },
          });
          items.push({ videoId: row.videoId, ok: false, stage: 'download', code: archived.code, channel: archived.channel || null, manualRequired: archived.manualRequired === true });
          if (archived.manualRequired) break;
          continue;
        }
        videoPath = archived.file;
        candidate = {
          ...row,
          status: CANDIDATE_STATUS.ARCHIVED,
          archive: {
            file: archived.file,
            bytes: archived.bytes,
            source: archived.source,
            channel: archived.channel || 'page',
            watermark: archived.watermark || 'unknown',
            skipped: Boolean(archived.skipped),
          },
        };
      }

      const verdict = await judgeCandidate({
        candidate,
        profile,
        config: this.#config,
        paths: this.#paths,
        videoPath,
        modelGateway,
        budget,
        signal,
      });

      if (!verdict.ok) {
        failed += 1;
        store.upsertCandidate({ ...candidate, judgeError: { code: verdict.code, message: verdict.message } });
        items.push({ videoId: candidate.videoId, ok: false, stage: 'judge', code: verdict.code });
        if (verdict.code === 'TOKEN_BUDGET_EXHAUSTED') {
          budgetExhausted = true;
          break;
        }
        continue;
      }

      if (verdict.verdict === 'accepted') {
        accepted += 1;
        store.upsertCandidate({
          ...candidate,
          status: CANDIDATE_STATUS.ACCEPTED,
          judge: {
            score: verdict.score,
            verdict: verdict.verdict,
            ruleScore: verdict.ruleScore,
            modelScore: verdict.modelScore,
            reasons: verdict.reasons,
            tags: verdict.tags,
            threshold: verdict.threshold,
            coldStart: verdict.coldStart,
            profileId: profile.id,
          },
        });
      } else {
        rejected += 1;
        // 被拒素材统一收到 storage.rejectedDir/<日期>/（平铺）；未配置时沿用老的删除逻辑。
        try {
          dropCandidateArtifacts(candidate, this.#rejectDropOptions());
        } catch {
          /* 清理失败不应改变已完成的判定结果 */
        }
        store.removeCandidate(candidate.videoId);
      }

      items.push({
        videoId: candidate.videoId,
        ok: true,
        score: verdict.score,
        verdict: verdict.verdict,
        ruleScore: verdict.ruleScore,
        modelScore: verdict.modelScore,
      });
    }

    const manualDownloadRequired = items.some((item) => item.manualRequired === true);
    return {
      ok: accepted > 0 && !budgetExhausted && !manualDownloadRequired,
      code: manualDownloadRequired ? 'DOWNLOAD_MANUAL_REQUIRED' : budgetExhausted ? 'TOKEN_BUDGET_EXHAUSTED' : null,
      message: manualDownloadRequired
        ? 'AIX 下载需要人工接管，任务已暂停并保留现场。'
        : budgetExhausted ? 'Token 预算已耗尽，剩余候选保留且未判 rejected。' : null,
      profileId: profile.id,
      requested: picked.length,
      accepted,
      rejected,
      failed,
      budgetExhausted,
      manualDownloadRequired,
      durationMs: Date.now() - startedAt,
      items,
      counts: store.countCandidates(),
      proxy: { ok: true, server: proxy.server },
    };
  }

  async candidates({ status, limit = 50 } = {}) {
    const store = this.#store();
    const rows = store.listCandidates({ status, limit });
    return {
      ok: true,
      count: rows.length,
      counts: store.countCandidates(),
      halt: store.readHalt(),
      candidates: rows,
    };
  }

  /**
   * M6 批量采集：多个关键词依次跑 search（可带下载与判定），支持断点续跑。
   */
  async collect({
    keywords = [],
    maxPerRun = 40,
    profileId = null,
    download = true,
    judge = true,
    resume = true,
    pauseMs = 4000,
    budget: externalBudget = null,
    modelGateway: externalGateway = null,
    downloadManager: externalDownloader = null,
    onProgress = null,
    signal,
  } = {}) {
    const list = Array.isArray(keywords) ? keywords : String(keywords || '').split(/[,\n，]/);
    if (!list.map((k) => String(k || '').trim()).filter(Boolean).length) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'keywords 不能为空。' };
    }
    const dailyBlocked = this.#dailyBudgetBlocked();
    if (dailyBlocked) return dailyBlocked;
    const store = this.#store();
    const halt = store.readHalt();
    if (halt) {
      return {
        ok: false,
        code: 'CAPTCHA_REQUIRED',
        message: '当前处于挂起状态，先在 Edge 里手动完成验证，然后删除 control/halt.json 或 resume。',
        halt,
      };
    }
    const proxy = await this.#checkProxy();
    if (!proxy.ok) return { ...proxy, ok: false };

    const host = await this.#ensureHost();
    if (!host.ok) return host;
    const context = this.#host.context;
    const searchPage = await ensurePage(context, 'search');
    const modelGateway = externalGateway || this.#modelGateway();
    const budget = externalBudget === null ? this.#tokenBudget() : externalBudget;
    const downloadManager = externalDownloader || this.#downloader();
    const judgeProfile = judge ? findProfile(this.#config, profileId, this.#paths.libraryDir) : null;
    if (judge && !judgeProfile) {
      return { ok: false, code: 'INVALID_PROFILE', message: `未知画像：${profileId || '(空)'}。` };
    }
    const result = await runCollect({
      keywords: list,
      store,
      maxPerRun,
      profileId,
      download,
      judge,
      resume,
      pauseMs,
      onProgress,
      signal,
      search: (args) =>
        runSearch({
          searchPage,
          getPage: (role) => ensurePage(context, role),
          store,
          config: this.#config,
          judgeConfig: this.#config.judge || {},
          judgeProfile,
          judgePaths: this.#paths,
          query: args.query,
          limit: args.limit,
          detail: true,
          download: args.download,
          downloadsDir: this.#paths.downloadsDir,
          preferNoWatermark: this.#config?.download?.preferNoWatermark !== false,
          judge: args.judge,
          modelGateway,
          budget,
          downloadManager,
          stateDir: this.#paths.stateDir,
          retryQueue: this.#retryQueue(),
          signal: args.signal,
        }),
    });
    return { ...result, proxy: { ok: true, server: proxy.server } };
  }

  /**
   * M6 报告：基于本地状态文件生成 Markdown。
   */
  report({ sinceDays = 1 } = {}) {
    const store = this.#store();
    return buildReport({
      store,
      reportsDir: join(this.#paths.stateDir, 'reports'),
      sinceDays: Number(sinceDays) || 1,
    });
  }

  // 调试用：仅供开发期 probe 脚本取到 Playwright context，不对外暴露为工具。
  __contextForDebug() {
    return this.#host?.context || null;
  }

  async execute(name, args = {}, { signal } = {}) {
    switch (name) {
      case 'tiktok_open':
        return this.open({ keyword: args.keyword, reuse: args.reuse !== false, signal });
      case 'tiktok_search':
        return this.search({
          query: args.query,
          limit: args.limit,
          detail: args.detail !== false,
          download: args.download === true,
          preferNoWatermark: args.preferNoWatermark,
          judge: args.judge === true,
          profileId: args.profileId || null,
          signal,
        });
      case 'tiktok_candidates':
        return this.candidates({ status: args.status, limit: args.limit });
      case 'tiktok_export':
        return this.exportCandidates({
          status: args.status || '',
          query: args.query || '',
          sinceDays: args.sinceDays || 0,
        });
      case 'tiktok_judge':
        return this.judge({
          query: args.query,
          videoIds: args.videoIds,
          limit: args.limit,
          profileId: args.profileId,
          signal,
        });
      case 'tiktok_profiles':
        return this.profiles();
      case 'tiktok_library_list':
        return this.library();
      case 'tiktok_library_add':
        return this.libraryAdd({
          file: args.file,
          videoId: args.videoId,
          profileId: args.profileId || null,
          polarity: args.polarity === 'negative' ? 'negative' : 'positive',
          describe: args.describe !== false,
          signal,
        });
      case 'tiktok_profile_build':
        return this.profileBuild({
          profileId: args.profileId,
          name: args.name,
          threshold: args.threshold,
          calibrate: args.calibrate === true,
          minSamples: args.minSamples,
        });
      case 'tiktok_download':
        return this.download({
          query: args.query,
          videoIds: args.videoIds,
          limit: args.limit,
          preferNoWatermark: args.preferNoWatermark,
          signal,
        });
      case 'tiktok_collect':
        return this.collect({
          keywords: args.keywords,
          maxPerRun: args.maxPerRun,
          profileId: args.profileId || null,
          download: args.download !== false,
          judge: args.judge !== false,
          resume: args.resume !== false,
          pauseMs: args.pauseMs,
          signal,
        });
      case 'tiktok_report':
        return this.report({ sinceDays: args.sinceDays });
      case 'tiktok_config':
        if (args.patch && typeof args.patch === 'object') return this.updateConfig(args.patch);
        return this.config();
      case 'tiktok_status':
        return this.status();
      case 'tiktok_diagnostics':
        return this.diagnostics();
      default:
        throw new Error(`未知工具：${name}`);
    }
  }

  async status() {
    const state = readBrowserState(this.#paths.browserControlDir);
    const context = this.#host?.context || null;
    let page = null;
    let signals = null;
    if (context) {
      try {
        page = await findPageByRole(context, 'prepare');
        if (page && !page.isClosed()) signals = await readPageSignals(page);
      } catch {
        page = null;
      }
    }
    const proxy = this.getProxyConfig();
    return {
      running: Boolean(context) || Boolean(state),
      browser: state || null,
      proxy: { configured: proxy.configured, valid: Boolean(proxy.valid), server: proxy.server },
      page: page ? { ...describePage(page), ...(signals || {}) } : null,
      state: signals ? describePageState(signals) : 'unknown',
    };
  }

  async diagnostics() {
    return runDiagnostics({
      paths: this.#paths,
      config: this.#config,
      env: this.#env,
      context: this.#host?.context || null,
    });
  }

  async close() {
    if (this.#host?.close) {
      await this.#host.close().catch(() => {});
    } else {
      clearBrowserState(this.#paths.browserControlDir);
    }
    this.#host = null;
  }
}

export { PREPARE_HOME };
