/**
 * M6：多关键词批量采集。
 *
 * 职责：把"一个关键词一轮 search"编排成"一串关键词跑完"，并保证：
 *  - 中途 halted（验证码/封禁）时立即停止，剩余关键词不跑；
 *  - 断点续跑：当天已成功跑过且有命中的关键词默认跳过，可用 resume:false 强制重跑；
 *  - 汇总每个关键词的 found/fresh/extracted/failed/skippedSeen，写一条 type:'collect' 的运行记录。
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
 * @param {number} [options.maxPerRun] 每个关键词最多取多少条
 * @param {string|null} [options.profileId] 判定用的画像
 * @param {boolean} [options.download] 是否边搜边下载
 * @param {boolean} [options.judge] 是否边搜边判定
 * @param {boolean} [options.resume] 是否跳过今天已成功的关键词
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

  const target = list.length * Math.max(0, Number(maxPerRun) || 0);
  const report = (index, keyword) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({
        index,
        total: list.length,
        keyword: keyword || null,
        found: totals.found,
        target,
        totals: { ...totals },
        at: new Date().toISOString(),
      });
    } catch {
      /* 进度回调不应影响采集 */
    }
  };

  report(0, null);

  for (let i = 0; i < list.length; i += 1) {
    const keyword = list[i];
    signal?.throwIfAborted?.();

    if (resume && ranToday(runs, keyword)) {
      log(`[${i + 1}/${list.length}] ${keyword} → 今天已跑过，跳过（resume:false 可强制重跑）`);
      results.push({ query: keyword, skipped: true, reason: 'ran_today' });
      totals.skippedKeywords += 1;
      report(i + 1, keyword);
      continue;
    }

    log(`[${i + 1}/${list.length}] ${keyword} → 开始`);
    let outcome;
    try {
      outcome = await search({ query: keyword, limit: maxPerRun, detail: true, download, judge, profileId, signal });
    } catch (error) {
      outcome = { ok: false, code: 'SEARCH_THREW', message: String(error?.message || error) };
    }

    results.push({ query: keyword, ...pickCounts(outcome) });
    addCounts(totals, outcome);
    report(i + 1, keyword);

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

  report(list.length, null);
  const durationMs = Date.now() - startedAt;
  store.recordRun({
    type: 'collect',
    keywords: list,
    profileId,
    maxPerRun,
    download,
    judge,
    halted: Boolean(halted),
    budgetExhausted,
    manualDownloadRequired,
    durationMs,
    totals,
  });

  return {
    ok: !budgetExhausted && !manualDownloadRequired && (results.some((row) => !row.skipped && row.found > 0) || totals.extracted > 0),
    keywords: list,
    results,
    totals,
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
    accepted: 0,
    rejected: 0,
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
    duplicateSkipped: Number(outcome?.duplicateSkipped) || 0,
    duplicateChecked: Number(outcome?.duplicateChecked) || 0,
    duplicateHashFailed: Number(outcome?.duplicateHashFailed) || 0,
    retryQueued: Number(outcome?.retryQueued) || 0,
    retryExhausted: Number(outcome?.retryExhausted) || 0,
    prefilterSkipped: Number(outcome?.prefilterSkipped) || 0,
    prefilterTokensSaved: Number(outcome?.prefilterTokensSaved) || 0,
    coverChecked: Number(outcome?.coverChecked) || 0,
    coverSkipped: Number(outcome?.coverSkipped) || 0,
    coverUnavailable: Number(outcome?.coverUnavailable) || 0,
    coverTokensSaved: Number(outcome?.coverTokensSaved) || 0,
    textChecked: Number(outcome?.textChecked) || 0,
    textSkipped: Number(outcome?.textSkipped) || 0,
    textTokensSaved: Number(outcome?.textTokensSaved) || 0,
    accepted: Number(outcome?.accepted) || 0,
    rejected: Number(outcome?.rejected) || 0,
    halted: Boolean(outcome?.halted),
  };
}

function addCounts(totals, outcome) {
  const row = pickCounts(outcome);
  totals.keywords += 1;
  for (const key of ['found', 'fresh', 'extracted', 'downloaded', 'failed', 'skippedSeen', 'skippedLanguage', 'duplicateSkipped', 'duplicateChecked', 'duplicateHashFailed', 'retryQueued', 'retryExhausted', 'prefilterSkipped', 'prefilterTokensSaved', 'coverChecked', 'coverSkipped', 'coverUnavailable', 'coverTokensSaved', 'textChecked', 'textSkipped', 'textTokensSaved', 'accepted', 'rejected']) {
    totals[key] += row[key];
  }
}
