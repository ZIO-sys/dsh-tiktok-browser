/**
 * M6：多关键词批量采集。
 *
 * 职责：把"一个关键词一轮 search"编排成"一串关键词跑完"，并保证：
 *  - 中途 halted（验证码/封禁）时立即停止，剩余关键词不跑；
 *  - 断点续跑：当天已成功跑过且有命中的关键词默认跳过，可用 resume:false 强制重跑；
 *  - 汇总每个关键词的 found/fresh/extracted/failed/skippedSeen，写一条 type:'collect' 的运行记录。
 *  - 指定「本次采集数量」（targetVideos > 0）时：只按成功归档数计数，采满立即停；
 *    每词不设条数上限（按 pipeline 上限 200 取），关键词跑完仍未满则继续下一轮。
 *
 * 真正的搜索/提取/下载/判定仍然复用 pipeline.runSearch，这里只做编排与统计。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startOfToday(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 判断某个关键词今天是否已经成功跑过（用于断点续跑）。
 * @param {Array<object>} runs 由 store.readRuns 返回（最新在前）
 */
function ranToday(runs, keyword, now = new Date()) {
  const from = startOfToday(now);
  for (const run of runs) {
    if (!run || run.query !== keyword) continue;
    const at = Date.parse(run.at || '');
    if (!Number.isFinite(at) || at < from) continue;
    if (run.halted) continue;
    if (Number(run.found) > 0) return true;
  }
  return false;
}

/**
 * @param {object} options
 * @param {string[]} options.keywords 关键词列表（必填，去重后逐个跑）
 * @param {(args: object) => Promise<object>} options.search 通常是 controller.search 绑定
 * @param {object} options.store createStore 实例
 * @param {number} [options.maxPerRun] 每个关键词最多取多少条（targetVideos > 0 时不生效）
 * @param {number} [options.targetVideos] 本次要成功归档的视频数量；0/留空 = 旧行为
 * @param {string|null} [options.profileId] 判定用的画像
 * @param {boolean} [options.download] 是否边搜边下载
 * @param {boolean} [options.judge] 是否边搜边判定
 * @param {boolean} [options.resume] 是否跳过今天已成功的关键词（targetVideos > 0 时不生效）
 * @param {number} [options.pauseMs] 关键词之间的间隔
 * @param {(msg: string) => void} [options.log]
 * @param {(progress: object) => void} [options.onProgress] 每个关键词结束后回报累计进度
 * @param {AbortSignal} [options.signal]
 */
export async function runCollect({
  keywords = [],
  search,
  store,
  maxPerRun = 40,
  targetVideos = 0,
  profileId = null,
  download = true,
  judge = true,
  resume = true,
  pauseMs = 4000,
  log = () => {},
  onProgress = null,
  signal = null,
} = {}) {
  if (typeof search !== 'function') throw new TypeError('runCollect 需要 search 函数');
  if (!store) throw new TypeError('runCollect 需要 store');

  const list = [...new Set((keywords || []).map((k) => String(k || '').trim()).filter(Boolean))];
  if (!list.length) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'keywords 不能为空。', keywords: [], totals: emptyTotals() };
  }

  const startedAt = Date.now();
  const runs = resume ? store.readRuns({ limit: 500 }) : [];
  const results = [];
  const totals = emptyTotals();
  let halted = null;
  let budgetExhausted = false;
  let manualDownloadRequired = false;

  const goal = Math.max(0, Math.min(200, Math.floor(Number(targetVideos) || 0)));
  const goalMode = goal > 0;
  // 目标模式下不设每词条数上限：按 pipeline 允许的最大值取。
  const perKeywordLimit = goalMode ? 200 : maxPerRun;
  // 只累计 pipeline 确认的实际归档成功数；accepted 可能包含下载失败，不能作为成功数。
  const succeededCount = () => totals.succeeded;

  const target = goalMode ? goal : list.length * Math.max(0, Number(maxPerRun) || 0);
  let round = 0;
  // live：当前关键词正在处理时的实时计数（pipeline 每处理完一条推一次）。
  // 不并入 totals，只用于让设置页在关键词跑完之前就能看到进度。
  const report = (index, keyword, live = null) => {
    if (typeof onProgress !== 'function') return;
    try {
      totals.succeeded = succeededCount();
      const shown = { ...totals };
      if (live) {
        for (const key of [
          'found',
          'fresh',
          'extracted',
          'failed',
          'downloaded',
          'downloadFailed',
          'scored',
          'accepted',
          'rejected',
          'succeeded',
          'skippedSeen',
          'skippedLanguage',
          'skippedAspect',
          'duplicateSkipped',
        ]) {
          shown[key] = Number(totals[key] || 0) + Number(live[key] || 0);
        }
      }
      onProgress({
        index,
        total: list.length,
        round: round + 1,
        keyword: keyword || null,
        found: goalMode ? shown.succeeded : shown.found,
        target,
        succeeded: shown.succeeded,
        totals: shown,
        current: live ? { index: Number(live.index) || 0, total: Number(live.total) || 0, keyword: live.query || keyword || null } : null,
        at: new Date().toISOString(),
      });
    } catch {
      /* 进度回调不应影响采集 */
    }
  };

  report(0, null);

  // 目标模式：关键词跑完仍未达标就再来一轮；每轮至少要新增一个成功，否则停止，避免死循环。
  const maxRounds = goalMode ? 20 : 1;
  let targetReached = false;
  for (; round < maxRounds; round += 1) {
    const beforeRound = succeededCount();
    for (let i = 0; i < list.length; i += 1) {
      const keyword = list[i];
      signal?.throwIfAborted?.();

      if (goalMode && succeededCount() >= goal) {
        targetReached = true;
        break;
      }

      // 目标模式不跳过当天跑过的关键词：目标是「成功数」，重跑才能继续产出。
      if (!goalMode && resume && ranToday(runs, keyword)) {
        log(`[${i + 1}/${list.length}] ${keyword} → 今天已跑过，跳过（resume:false 可强制重跑）`);
        results.push({ query: keyword, skipped: true, reason: 'ran_today' });
        totals.skippedKeywords += 1;
        report(i + 1, keyword);
        continue;
      }

      log(`[${i + 1}/${list.length}] ${keyword} → 开始${goalMode ? `（还差 ${Math.max(0, goal - succeededCount())} 个成功）` : ''}`);
      let outcome;
      try {
        outcome = await search({
          query: keyword,
          limit: perKeywordLimit,
          stopAfter: goalMode ? Math.max(1, goal - succeededCount()) : undefined,
          onItem: (progress) => report(i + 1, keyword, progress),
          detail: true,
          download,
          judge,
          profileId,
          signal,
        });
      } catch (error) {
        outcome = { ok: false, code: 'SEARCH_THREW', message: String(error?.message || error) };
      }

      results.push({ query: keyword, round: round + 1, ...pickCounts(outcome) });
      addCounts(totals, outcome);
      report(i + 1, keyword);

      if (goalMode && succeededCount() >= goal) {
        targetReached = true;
        log(`[${i + 1}/${list.length}] ${keyword} → 已成功采集 ${succeededCount()}/${goal} 个，达标停止`);
        break;
      }

      if (outcome?.halted) {
        halted = outcome.halt || { reason: outcome.code || 'HALTED', query: keyword };
        log(`[${i + 1}/${list.length}] ${keyword} → 触发挂起，停止后续关键词`);
        break;
      }

      if (outcome?.budgetExhausted || outcome?.code === 'TOKEN_BUDGET_EXHAUSTED') {
        budgetExhausted = true;
        log(`[${i + 1}/${list.length}] ${keyword} → Token 预算耗尽，保留断点并停止后续关键词`);
        break;
      }

      if (outcome?.manualDownloadRequired) {
        manualDownloadRequired = true;
        log(`[${i + 1}/${list.length}] ${keyword} → 下载需要人工接管，保留现场并停止后续关键词`);
        break;
      }

      if (i < list.length - 1 && pauseMs > 0) await sleep(pauseMs);
    }

    if (targetReached || halted || budgetExhausted || manualDownloadRequired) break;
    if (!goalMode) break;

    const gained = succeededCount() - beforeRound;
    if (gained <= 0) {
      log(`第 ${round + 1} 轮结束：本轮没有新增成功视频，停止继续轮询（成功 ${succeededCount()}/${goal}）`);
      break;
    }
    log(`第 ${round + 1} 轮结束：成功 ${succeededCount()}/${goal}，继续下一轮`);
  }

  totals.succeeded = succeededCount();
  report(list.length, null);
  const durationMs = Date.now() - startedAt;
  store.recordRun({
    type: 'collect',
    keywords: list,
    profileId,
    maxPerRun,
    targetVideos: goal,
    succeeded: totals.succeeded,
    targetReached,
    download,
    judge,
    halted: Boolean(halted),
    budgetExhausted,
    manualDownloadRequired,
    durationMs,
    totals,
  });

  const legacyOk = results.some((row) => !row.skipped && row.found > 0) || totals.extracted > 0;
  // 目标模式下必须真的采满才算完成；否则任务状态应显示未达标，而不是「已完成」。
  const ok = !budgetExhausted && !manualDownloadRequired && (goalMode ? targetReached : legacyOk);
  const shortfall = goalMode && !targetReached && !halted && !budgetExhausted && !manualDownloadRequired;

  return {
    ok,
    ...(shortfall
      ? {
          code: 'TARGET_NOT_REACHED',
          message: `本次目标 ${goal} 个成功视频，实际成功 ${totals.succeeded} 个；关键词已跑完且本轮没有新增成功，任务提前结束。`,
        }
      : {}),
    keywords: list,
    results,
    totals,
    targetVideos: goal,
    targetReached,
    halted,
    budgetExhausted,
    manualDownloadRequired,
    durationMs,
  };
}

function emptyTotals() {
  return {
    keywords: 0,
    skippedKeywords: 0,
    found: 0,
    fresh: 0,
    extracted: 0,
    downloaded: 0,
    failed: 0,
    skippedSeen: 0,
    skippedLanguage: 0,
    skippedAspect: 0,
    duplicateSkipped: 0,
    duplicateChecked: 0,
    duplicateHashFailed: 0,
    retryQueued: 0,
    retryExhausted: 0,
    prefilterSkipped: 0,
    prefilterTokensSaved: 0,
    accepted: 0,
    rejected: 0,
    succeeded: 0,
  };
}

function pickCounts(outcome) {
  return {
    ok: Boolean(outcome?.ok),
    code: outcome?.code || null,
    message: outcome?.message || null,
    found: Number(outcome?.found) || 0,
    fresh: Number(outcome?.fresh) || 0,
    extracted: Number(outcome?.extracted) || 0,
    downloaded: Number(outcome?.downloaded) || 0,
    failed: Number(outcome?.failed) || 0,
    skippedSeen: Number(outcome?.skippedSeen) || 0,
    skippedLanguage: Number(outcome?.skippedLanguage) || 0,
    skippedAspect: Number(outcome?.skippedAspect) || 0,
    duplicateSkipped: Number(outcome?.duplicateSkipped) || 0,
    duplicateChecked: Number(outcome?.duplicateChecked) || 0,
    duplicateHashFailed: Number(outcome?.duplicateHashFailed) || 0,
    retryQueued: Number(outcome?.retryQueued) || 0,
    retryExhausted: Number(outcome?.retryExhausted) || 0,
    prefilterSkipped: Number(outcome?.prefilterSkipped) || 0,
    prefilterTokensSaved: Number(outcome?.prefilterTokensSaved) || 0,
    accepted: Number(outcome?.accepted) || 0,
    rejected: Number(outcome?.rejected) || 0,
    succeeded: Number(outcome?.succeeded) || 0,
    halted: Boolean(outcome?.halted),
  };
}

function addCounts(totals, outcome) {
  const row = pickCounts(outcome);
  totals.keywords += 1;
  for (const key of ['found', 'fresh', 'extracted', 'downloaded', 'failed', 'skippedSeen', 'skippedLanguage', 'skippedAspect', 'duplicateSkipped', 'duplicateChecked', 'duplicateHashFailed', 'retryQueued', 'retryExhausted', 'prefilterSkipped', 'prefilterTokensSaved', 'accepted', 'rejected', 'succeeded']) {
    totals[key] += row[key];
  }
}
