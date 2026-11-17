// pipeline.mjs — M2 采集管线：搜索页收集卡片 → 去重 → 逐条提取作品字段 → 落库。

import { collectSearchCards, searchUrl } from './search.mjs';
import { extractVideoDetail } from './extract.mjs';
import { archiveCandidate } from './archive.mjs';
import { CANDIDATE_STATUS } from './store.mjs';
import { judgeCandidate } from './judge.mjs';
import { detectLanguage, judgeLanguage } from '../services/language-detect.mjs';
import { resolveDedupOptions, createDedupIndex, videoHash, textKey, evaluateCandidate } from '../services/dedup.mjs';
import { isRetryableDownloadError } from '../services/retry.mjs';
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ALLOWED_HOST = /^https:\/\/(www\.)?tiktok\.com\//i;

export function isAllowedUrl(url) {
  return typeof url === 'string' && (url === 'about:blank' || ALLOWED_HOST.test(url));
}

/**
 * 解析判定配置：显式 judgeConfig 优先，否则回退 config.judge。
 * 批量采集（tiktok_collect）只传 config，不能让它丢掉 judge.prefilter 等开关。
 */
export function resolveJudgeOptions(config = {}, judgeConfig = null) {
  if (judgeConfig && typeof judgeConfig === 'object' && Object.keys(judgeConfig).length > 0) return judgeConfig;
  return config?.judge && typeof config.judge === 'object' ? config.judge : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || lo);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * 把文件移入 Windows 回收站，失败时抛错，避免静默永久删除。
 */
function recycleFile(target) {
  if (!existsSync(target)) return;
  const escaped = String(target).replace(/'/g, "''");
  const command = [
    'Add-Type -AssemblyName Microsoft.VisualBasic;',
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}',`,
    '[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,',
    '[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
  ].join(' ');
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');

  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (!existsSync(target)) return;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
      { encoding: 'utf8', windowsHide: true },
    );
    if (!existsSync(target)) return;
    lastError = result.error
      ? result.error
      : new Error(`移入回收站失败（exit ${result.status}）：${String(result.stderr || '').trim()}`);
    if (attempt < 4) {
      // 刚写完的 sidecar 可能仍被 Defender/索引短暂占用，指数退避后重试。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 400);
    }
  }
  throw lastError || new Error(`移入回收站失败：${target}`);
}

/**
 * 删掉一条候选落盘的全部文件：视频 mp4 与同名 sidecar json。
 *
 * 两种模式（options 优先，其次读环境变量，都没有就直接删）：
 *  - `mode: 'move'` + `backupDir`：先复制到 backupDir（平铺 `<backupDir>/<videoId>.mp4`），
 *    校验字节一致后删源。用于“被拒素材统一收到某个目录”的场景（2026-11-10 起默认走这条）。
 *  - `mode: 'recycle'`：复制到备份目录 + 校验，再把源文件移入 Windows 回收站。
 *    只给旧脚本用（`TIKTOK_REJECT_BACKUP_DIR` 那种嵌套 `<时间戳>-<videoId>/` 布局）。
 * 任一步失败都会抛错并停止后续清理。
 */
export function dropCandidateArtifacts(candidate, options = {}) {
  const file = candidate?.archive?.file;
  if (!file) return { mode: 'none', files: [] };

  const targets = [...new Set([file, String(file).replace(/\.mp4$/i, '.json')])].filter((target) =>
    existsSync(target),
  );
  if (!targets.length) return { mode: 'none', files: [] };

  const cleanupMode = String(options.mode || process.env.TIKTOK_REJECT_CLEANUP_MODE || '').toLowerCase();
  const explicitDir = String(options.backupDir || '').trim();

  if (cleanupMode === 'recycle' || cleanupMode === 'move') {
    const backupRoot = explicitDir || String(process.env.TIKTOK_REJECT_BACKUP_DIR || '').trim();
    if (!backupRoot) {
      throw new Error(`${cleanupMode} 模式必须提供 backupDir（或设置 TIKTOK_REJECT_BACKUP_DIR）。`);
    }

    const videoId = String(candidate?.videoId || 'unknown');
    // 显式传 backupDir 视为“最终目录”，直接平铺；走环境变量则保持老的嵌套布局。
    const backupDir = explicitDir
      ? backupRoot
      : join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${videoId}`);
    mkdirSync(backupDir, { recursive: true });

    const backedUp = [];
    for (const target of targets) {
      const backup = join(backupDir, basename(target));
      const sourceBytes = statSync(target).size;
      copyFileSync(target, backup);
      const backupBytes = statSync(backup).size;
      if (backupBytes !== sourceBytes) {
        throw new Error(`备份校验失败（${sourceBytes} != ${backupBytes}）：${target}`);
      }
      backedUp.push({ target, backup, bytes: backupBytes });
    }

    if (cleanupMode === 'recycle') {
      for (const item of backedUp) recycleFile(item.target);
    } else {
      for (const item of backedUp) {
        try {
          unlinkSync(item.target);
        } catch {
          /* 文件可能已被占用，但备份已在，继续 */
        }
      }
    }
    return { mode: cleanupMode, backupDir, files: backedUp };
  }

  for (const target of targets) {
    try {
      unlinkSync(target);
    } catch {
      /* 文件可能已不存在 */
    }
  }
  return { mode: 'unlink', files: targets.map((target) => ({ target })) };
}

/** 读页面状态：验证码/封禁需要整体挂起。 */
async function readSignals(page) {
  return page
    .evaluate(() => {
      const body = (document.body?.innerText || '').slice(0, 4000);
      const visible = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return {
        url: location.href,
        title: document.title,
        verification:
          visible('iframe[src*="captcha"]') ||
          visible('div[class*="captcha"]') ||
          visible('[data-e2e="captcha"]') ||
          /\b(Verify|verification|验证码|安全验证)\b/i.test(body),
        blocked: /\b(Access Denied|Something went wrong|Forbidden|访问受限)\b/i.test(body),
      };
    })
    .catch(() => ({ url: page.url(), title: null, verification: false, blocked: false }));
}

/**
 * P1-5：给候选标注语言，并决定是否在下载/判定前跳过。
 * 纯函数，方便离线测试；contentLanguage 为 auto 时只记录。
 * @returns {{candidate: object, skip: boolean, verdict: object, detected: object}}
 */
export function applyLanguageFilter(candidate, contentLanguage = 'auto') {
  const text = [candidate?.desc, ...(Array.isArray(candidate?.challenges) ? candidate.challenges : []), candidate?.author?.nickname]
    .filter(Boolean)
    .join(' ');
  const detected = detectLanguage(text, { langHint: candidate?.languageHint || '' });
  const verdict = judgeLanguage(contentLanguage, detected);
  return {
    candidate: {
      ...candidate,
      language: {
        code: detected.code,
        confidence: detected.confidence,
        mixed: Boolean(detected.mixed),
        source: detected.source,
        expected: verdict.expected,
        matched: verdict.matched,
        action: verdict.action,
      },
    },
    skip: verdict.action === 'skip',
    verdict,
    detected,
  };
}

/**
 * 运行一次关键词搜索采集。
 * @param {object} options
 * @param {import('playwright-core').Page} options.searchPage
 * @param {(role:string)=>Promise<import('playwright-core').Page>} options.getPage 取指定角色页面
 * @param {object} options.store createStore 返回值
 * @param {object} options.config 运行配置
 * @param {string} options.query 关键词
 * @param {number} [options.limit] 本次最多提取多少条
 * @param {boolean} [options.detail] 是否打开作品页补全字段
 */
export async function runSearch({
  searchPage,
  getPage,
  store,
  config = {},
  query,
  limit,
  detail = true,
  download = false,
  downloadsDir = null,
  preferNoWatermark = null,
  judge = false,
  judgeProfile = null,
  judgePaths = null,
  judgeApi = null,
  judgeConfig = null,
  modelGateway = null,
  budget = null,
  downloadManager = null,
  stateDir = null,
  dedupIndex = null,
  retryQueue = null,
  signal,
  logger,
}) {
  const startedAt = Date.now();
  const maxResults = Math.max(1, Math.min(Number(limit) || Number(config?.search?.maxResultsPerKeyword) || 25, 200));
  const minDelay = Number(config?.collect?.minDelayMs) || 800;
  const maxDelay = Number(config?.collect?.maxDelayMs) || 1500;
  const batchEvery = Number(config?.collect?.batchPauseEvery) || 20;
  const batchPauseMs = Number(config?.collect?.batchPauseMs) || 8000;
  // auto（默认）：只记录检测结果；显式指定语言时才拦截。
  const contentLanguage = String(config?.search?.contentLanguage || 'auto').toLowerCase();
  // P1-6：批量采集只传 config、不传 judgeConfig，这里统一回退到 config.judge，
  // 否则 tiktok_collect 这条主入口会让三层预筛静默失效。
  const judgeOptions = resolveJudgeOptions(config, judgeConfig);
  // P2-7：默认走无水印（playAddr）；显式传 false 或配置 download.preferNoWatermark=false 才退回带水印地址。
  const noWatermark = preferNoWatermark === null
    ? config?.download?.preferNoWatermark !== false
    : preferNoWatermark !== false;
  // P1-6 封面粗筛：开启时才抓封面，失败回退正式判定。
  const coverPrefilter =
    judgeOptions.coverPrefilter === true ||
    ['on', 'true', '1'].includes(String(judgeOptions.coverPrefilter || '').toLowerCase());
  // P1-6 文本预筛：开启时先用文案/话题问文本模型，低分直接拒绝。
  const textPrefilter =
    judgeOptions.textPrefilter === true ||
    ['on', 'true', '1'].includes(String(judgeOptions.textPrefilter || '').toLowerCase());
  // P2-1 素材去重：默认 off；开启后下载前看文案、下载后看指纹，命中即标 duplicate。
  const dedupOptions = resolveDedupOptions(config);
  const dedup = dedupIndex
    || (dedupOptions.enabled && stateDir ? createDedupIndex({ stateDir, options: dedupOptions }) : null);
  const dedupEnabled = Boolean(dedup);

  const summary = {
    ok: false,
    query,
    limit: maxResults,
    found: 0,
    fresh: 0,
    extracted: 0,
    failed: 0,
    downloaded: 0,
    downloadFailed: 0,
    scored: 0,
    accepted: 0,
    rejected: 0,
    archived: [],
    skippedSeen: 0,
    skippedLanguage: 0,
    duplicateSkipped: 0,
    duplicateChecked: 0,
    duplicateHashFailed: 0,
    retryQueued: 0,
    retryExhausted: 0,
    prefilterSkipped: 0,
    prefilterTokensSaved: 0,
    coverChecked: 0,
    coverSkipped: 0,
    coverUnavailable: 0,
    coverTokensSaved: 0,
    textChecked: 0,
    textSkipped: 0,
    textTokensSaved: 0,
    halted: false,
    budgetExhausted: false,
    manualDownloadRequired: false,
    code: null,
    message: null,
    candidates: [],
    durationMs: 0,
  };

  const target = searchUrl(query);
  if (!isAllowedUrl(target)) {
    summary.code = 'INVALID_URL';
    summary.message = '只允许访问 tiktok.com 页面。';
    return summary;
  }

  await searchPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((error) => {
    logger?.warn?.('搜索页导航失败', error?.message);
  });
  await sleep(1500);

  const first = await readSignals(searchPage);
  if (first.verification) {
    const halt = store.writeHalt({ reason: 'CAPTCHA_REQUIRED', url: first.url, query });
    summary.halted = true;
    summary.code = 'CAPTCHA_REQUIRED';
    summary.message = '搜索页出现验证码，已挂起。请在 Edge 窗口内手动完成验证后重试。';
    summary.halt = halt;
    return summary;
  }
  if (first.blocked) {
    summary.code = 'PAGE_BLOCKED';
    summary.message = '搜索页被拦截（Access Denied / Forbidden）。请检查代理出口。';
    return summary;
  }

  const collected = await collectSearchCards(searchPage, {
    limit: maxResults,
    maxRounds: Math.max(4, Math.ceil(maxResults / 10) + 3),
    pauseMs: 1200,
    signal,
  });
  summary.found = collected.cards.length;

  const seen = store.loadSeen();
  const freshCards = collected.cards.filter((card) => !seen.has(card.videoId));
  summary.skippedSeen = collected.cards.length - freshCards.length;
  summary.fresh = freshCards.length;

  if (!detail) {
    for (const card of freshCards) {
      store.markSeen(card.videoId, { query, channel: 'search' });
      store.upsertCandidate({
        videoId: card.videoId,
        url: card.url,
        query,
        status: CANDIDATE_STATUS.DISCOVERED,
        title: card.title,
        author: { uniqueId: card.author },
      });
    }
    summary.ok = true;
    summary.candidates = freshCards.map((card) => ({
      videoId: card.videoId,
      url: card.url,
      title: card.title,
      status: CANDIDATE_STATUS.DISCOVERED,
    }));
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const videoPage = await getPage('video');
  for (let index = 0; index < freshCards.length; index += 1) {
    signal?.throwIfAborted?.();
    const card = freshCards[index];

    const signals = await readSignals(videoPage);
    if (signals.verification) {
      store.writeHalt({ reason: 'CAPTCHA_REQUIRED', url: signals.url, query, videoId: card.videoId });
      summary.halted = true;
      summary.code = 'CAPTCHA_REQUIRED';
      summary.message = '作品页出现验证码，已挂起。请在 Edge 窗口内手动完成验证后重试。';
      break;
    }

    store.markSeen(card.videoId, { query, channel: 'search' });
    const result = await extractVideoDetail(videoPage, {
      videoId: card.videoId,
      url: card.url,
      waitMs: 1500,
    });

    if (result.ok && result.data) {
      let candidate = {
        ...result.data,
        query,
        status: CANDIDATE_STATUS.EXTRACTED,
        channel: result.channel,
      };

      // P1-5：下载/判定之前先看文案语言，语言不符直接留记录，省流量与 token。
      const languageResult = applyLanguageFilter(candidate, contentLanguage);
      candidate = languageResult.candidate;

      if (languageResult.skip) {
        candidate = { ...candidate, status: CANDIDATE_STATUS.SKIPPED_LANGUAGE, languageCheckedAt: new Date().toISOString() };
        store.upsertCandidate(candidate);
        summary.extracted += 1;
        summary.skippedLanguage += 1;
        summary.candidates.push(candidate);
        if (batchEvery > 0 && (index + 1) % batchEvery === 0 && index + 1 < freshCards.length) {
          await sleep(batchPauseMs);
        } else {
          await sleep(randomBetween(minDelay, maxDelay));
        }
        continue;
      }

      // P2-1：下载前先用文案判重。文案几乎照抄（Jaccard ≥ 0.95）的候选直接跳过，不下载、不判定。
      if (dedupEnabled) {
        const pre = evaluateCandidate({
          desc: candidate.desc,
          author: candidate.author?.uniqueId || candidate.author?.nickname || '',
          duration: candidate.duration,
          index: dedup,
          excludeVideoId: candidate.videoId,
          options: dedupOptions,
          stage: 'pre-download',
        });
        if (pre.duplicate) {
          candidate = {
            ...candidate,
            status: CANDIDATE_STATUS.DUPLICATE,
            dedup: {
              of: pre.of,
              videoDistance: pre.videoDistance,
              textSim: pre.textSim,
              reason: pre.reason,
              stage: 'pre-download',
              guard: pre.guard || null,
              checkedAt: new Date().toISOString(),
            },
          };
          store.upsertCandidate(candidate);
          summary.duplicateSkipped += 1;
          summary.extracted += 1;
          summary.candidates.push(candidate);
          continue;
        }
      }

      if (download && downloadsDir) {
        const archived = downloadManager
          ? await downloadManager.download({
              page: videoPage,
              candidate,
              downloadsDir,
              keyword: query,
              preferNoWatermark: noWatermark,
              signal,
              refresh: async (videoId) => {
                const again = await extractVideoDetail(videoPage, { videoId, url: card.url, waitMs: 1500 });
                return again.ok ? again.data : null;
              },
            })
          : await archiveCandidate({
              page: videoPage,
              candidate,
              downloadsDir,
              keyword: query,
              preferNoWatermark: noWatermark,
              logger,
              refresh: async (videoId) => {
                const again = await extractVideoDetail(videoPage, { videoId, url: card.url, waitMs: 1500 });
                return again.ok ? again.data : null;
              },
            });

        if (archived.ok) {
          candidate = {
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
          };
          summary.downloaded += 1;
          // P2-3：下载成功即出队（之前失败过的条目不再重试）。
          retryQueue?.resolve(candidate.videoId, { ok: true });
          summary.archived.push({
            videoId: candidate.videoId,
            file: archived.file,
            bytes: archived.bytes,
            source: archived.source,
            channel: archived.channel || 'page',
            skipped: Boolean(archived.skipped),
          });
        } else {
          candidate = {
            ...candidate,
            status: CANDIDATE_STATUS.DOWNLOAD_FAILED,
            archiveError: { code: archived.code, message: archived.message, channel: archived.channel || null, manualRequired: archived.manualRequired === true },
          };
          summary.downloadFailed += 1;
          // P2-3：可重试的下载错误入队（最多 3 次），超限保持 download_failed。
          if (retryQueue && isRetryableDownloadError(archived.code)) {
            const queued = retryQueue.enqueue({
              videoId: candidate.videoId,
              query,
              code: archived.code,
              message: archived.message,
            });
            candidate = {
              ...candidate,
              retry: {
                attempt: queued.attempt || 0,
                exhausted: queued.exhausted === true,
                nextRunAt: queued.nextRunAt || null,
                code: queued.code || archived.code || null,
              },
            };
            if (queued.ok) summary.retryQueued += 1;
            else if (queued.exhausted) summary.retryExhausted += 1;
          }
          if (archived.manualRequired) {
            summary.code = archived.code || 'DOWNLOAD_MANUAL_REQUIRED';
            summary.message = archived.message || '下载需要人工接管。';
            summary.manualDownloadRequired = true;
            store.upsertCandidate(candidate);
            break;
          }
        }
      }

      // P2-1：下载后、判定前算指纹并与索引比对。命中重复就删掉刚下载的文件，不归档、不调模型。
      if (dedupEnabled && candidate.archive?.file) {
        const hashed = videoHash(candidate.archive.file, { frames: dedupOptions.frames, signal });
        if (hashed.ok) {
          summary.duplicateChecked += 1;
          const post = evaluateCandidate({
            desc: candidate.desc,
            hash: hashed.hash,
            author: candidate.author?.uniqueId || candidate.author?.nickname || '',
            duration: candidate.duration,
            index: dedup,
            excludeVideoId: candidate.videoId,
            options: dedupOptions,
            stage: 'post-download',
          });
          if (post.duplicate) {
            try {
              dropCandidateArtifacts(candidate);
            } catch {
              /* 删除失败不影响判重结果 */
            }
            candidate = {
              ...candidate,
              status: CANDIDATE_STATUS.DUPLICATE,
              archive: null,
              contentHash: hashed.hash,
              dedup: {
                of: post.of,
                videoDistance: post.videoDistance,
                textSim: post.textSim,
                reason: post.reason,
                stage: 'post-download',
                checkedAt: new Date().toISOString(),
              },
            };
            store.upsertCandidate(candidate);
            summary.duplicateSkipped += 1;
            summary.downloaded -= 1;
            summary.extracted += 1;
            summary.candidates.push(candidate);
            continue;
          }
          candidate = { ...candidate, contentHash: hashed.hash };
          dedup.add({
            videoId: candidate.videoId,
            textKey: textKey(candidate.desc),
            hash: hashed.hash,
            author: candidate.author?.uniqueId || candidate.author?.nickname || '',
            duration: candidate.duration,
          });
        } else {
          summary.duplicateHashFailed += 1;
          // 没有指纹时至少把文案写进索引，下一次可以靠“同作者 + 同时长 + 同文案”兜住。
          dedup.add({
            videoId: candidate.videoId,
            textKey: textKey(candidate.desc),
            hash: null,
            author: candidate.author?.uniqueId || candidate.author?.nickname || '',
            duration: candidate.duration,
          });
        }
      }

      if (judge && judgePaths) {
        const verdict = await judgeCandidate({
          candidate,
          profile: judgeProfile,
          config: { judge: judgeOptions },
          paths: judgePaths,
          videoPath: candidate.archive?.file || null,
          page: videoPage,
          api: judgeApi,
          modelGateway,
          budget,
          signal,
          logger,
        });
        summary.scored += 1;
        if (textPrefilter && verdict.ok) {
          summary.textChecked += 1;
        }
        if (coverPrefilter && verdict.ok) {
          summary.coverChecked += 1;
          if (verdict.coverScore === null || verdict.coverScore === undefined) summary.coverUnavailable += 1;
        }
        // P1-6：规则预筛/文本预筛/封面粗筛直接拒绝，不抽帧或不调完整模型；与 rejected 一样删文件删记录。
        if (verdict.ok && verdict.prefiltered) {
          if (verdict.prefilter === 'cover') {
            summary.coverSkipped += 1;
            summary.coverTokensSaved += verdict.estimatedTokensSaved || 0;
          } else if (verdict.prefilter === 'text') {
            summary.textSkipped += 1;
            summary.textTokensSaved += verdict.estimatedTokensSaved || 0;
          } else {
            summary.prefilterSkipped += 1;
            summary.prefilterTokensSaved += verdict.estimatedTokensSaved || 0;
          }
          summary.rejected += 1;
          // 清理失败只记警告不中断批次：单条素材回收站/删除失败不应炸掉整个 runSearch。
          try {
            dropCandidateArtifacts(candidate);
            store.removeCandidate(candidate.videoId);
          } catch (failure) {
            logger?.warn?.(`清理预筛拒绝素材失败 ${candidate.videoId}`, failure?.message || String(failure));
          }
          summary.extracted += 1;
          continue;
        }
        if (!verdict.ok && verdict.code === 'TOKEN_BUDGET_EXHAUSTED') {
          candidate = { ...candidate, judgeError: { code: verdict.code, message: verdict.message } };
          store.upsertCandidate(candidate);
          summary.extracted += 1;
          summary.budgetExhausted = true;
          summary.code = 'TOKEN_BUDGET_EXHAUSTED';
          summary.message = 'Token 预算已耗尽，剩余候选保留现场，未判 rejected。';
          break;
        }
        if (verdict.ok) {
          candidate = {
            ...candidate,
            judge: {
              score: verdict.score,
              verdict: verdict.verdict,
              ruleScore: verdict.ruleScore,
              modelScore: verdict.modelScore,
              reasons: verdict.reasons,
              tags: verdict.tags,
              coverScore: verdict.coverScore ?? null,
              coverNote: verdict.coverNote || null,
              textScore: verdict.textScore ?? null,
              textNote: verdict.textNote || null,
              threshold: verdict.threshold,
              coldStart: verdict.coldStart,
              profileId: judgeProfile?.id || null,
            },
            // P2-6：画面文字与卖点存在候选本身，方便导出/筛选；没有就保持原样。
            ...(verdict.onScreenText ? { onScreenText: verdict.onScreenText } : {}),
            ...(Array.isArray(verdict.sellingPoints) && verdict.sellingPoints.length
              ? { sellingPoints: verdict.sellingPoints }
              : {}),
          };
          if (verdict.verdict === 'accepted') {
            summary.accepted += 1;
            // 判通过即置 ACCEPTED：download=false 时素材无归档文件，仍应走到终态而不是停在 extracted。
            candidate.status = CANDIDATE_STATUS.ACCEPTED;
          } else {
            summary.rejected += 1;
            // 被拒素材不留任何文件与记录：删视频、删同名 sidecar、清候选行；清理失败只记警告不中断批次。
            try {
              dropCandidateArtifacts(candidate);
              store.removeCandidate(candidate.videoId);
            } catch (failure) {
              logger?.warn?.(`清理拒绝素材失败 ${candidate.videoId}`, failure?.message || String(failure));
            }
            summary.extracted += 1;
            continue;
          }
        } else {
          candidate = { ...candidate, judgeError: { code: verdict.code, message: verdict.message } };
        }
      }

      store.upsertCandidate(candidate);
      summary.extracted += 1;
      summary.candidates.push(candidate);
    } else {
      store.upsertCandidate({
        videoId: card.videoId,
        url: card.url,
        query,
        status: CANDIDATE_STATUS.EXTRACT_FAILED,
        title: card.title,
        code: result.code,
        message: result.message,
      });
      summary.failed += 1;
    }

    if (batchEvery > 0 && (index + 1) % batchEvery === 0 && index + 1 < freshCards.length) {
      await sleep(batchPauseMs);
    } else {
      await sleep(randomBetween(minDelay, maxDelay));
    }
  }

  summary.ok = summary.extracted > 0 && !summary.halted && !summary.budgetExhausted && !summary.manualDownloadRequired;
  if (!summary.code && summary.extracted === 0 && summary.failed > 0) {
    summary.code = 'EXTRACT_FAILED';
    summary.message = '所有候选都提取失败，请检查页面结构或代理。';
  }
  summary.durationMs = Date.now() - startedAt;

  store.recordRun({
    type: 'search',
    query,
    found: summary.found,
    fresh: summary.fresh,
    extracted: summary.extracted,
    failed: summary.failed,
    downloaded: summary.downloaded,
    downloadFailed: summary.downloadFailed,
    skippedLanguage: summary.skippedLanguage,
    duplicateSkipped: summary.duplicateSkipped,
    duplicateChecked: summary.duplicateChecked,
    duplicateHashFailed: summary.duplicateHashFailed,
    retryQueued: summary.retryQueued,
    retryExhausted: summary.retryExhausted,
    prefilterSkipped: summary.prefilterSkipped,
    prefilterTokensSaved: summary.prefilterTokensSaved,
    coverChecked: summary.coverChecked,
    coverSkipped: summary.coverSkipped,
    coverUnavailable: summary.coverUnavailable,
    coverTokensSaved: summary.coverTokensSaved,
    textChecked: summary.textChecked,
    textSkipped: summary.textSkipped,
    textTokensSaved: summary.textTokensSaved,
    halted: summary.halted,
    durationMs: summary.durationMs,
  });

  return summary;
}
