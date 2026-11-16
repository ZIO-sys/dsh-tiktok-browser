import { randomUUID } from 'node:crypto';

function textList(value, limit = 30) {
  return (Array.isArray(value) ? value : String(value || '').split(/[\n,，;；]+/))
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function runError(message, code = 'RUN_INVALID') {
  return Object.assign(new Error(message), { code, status: 400 });
}

export class RunService {
  #controller;
  #job = null;
  #abort = null;

  constructor({ controller }) {
    if (!controller) throw new TypeError('RunService 需要 controller。');
    this.#controller = controller;
  }

  state() {
    if (!this.#job) return { status: 'idle', running: false, active: false };
    return { ...this.#job, running: this.#job.status === 'running', active: this.#job.status === 'running' };
  }

  start(input = {}) {
    if (this.#job?.status === 'running') throw runError('已有一个采集任务在运行。', 'RUN_ACTIVE');
    const seeds = textList(input.seeds, 20);
    if (!seeds.length) throw runError('至少填写一个种子词。');
    const profileId = input.profileId == null ? null : String(input.profileId).slice(0, 80);
    const targetCount = Math.max(3, Math.min(Number(input.targetCount) || 10, 30));
    const maxPerRun = Math.max(1, Math.min(Number(input.maxPerRun) || 5, 50));
    const queryLanguage = String(input.queryLanguage || 'en').slice(0, 16);
    const contentLanguage = String(input.contentLanguage || 'auto').slice(0, 16);
    const exclude = textList(input.exclude, 30);
    const download = input.download !== false;
    const judge = input.judge !== false;
    const resume = input.resume === true;
    const pauseMs = Math.max(0, Math.min(Number(input.pauseMs) || 4_000, 60_000));

    const id = randomUUID();
    const abort = new AbortController();
    this.#abort = abort;
    this.#job = {
      id,
      status: 'running',
      phase: 'expanding',
      seeds,
      keywords: [],
      profileId,
      queryLanguage,
      contentLanguage,
      targetCount,
      maxPerRun,
      startedAt: new Date().toISOString(),
      endedAt: null,
      error: null,
      result: null,
      budget: null,
    };

    void this.#controller.expandAndCollect({
      seeds,
      targetCount,
      queryLanguage,
      contentLanguage,
      exclude,
      profileId,
      maxPerRun,
      download,
      judge,
      resume,
      pauseMs,
      onProgress: (progress) => {
        if (this.#job?.id !== id) return;
        this.#job = {
          ...this.#job,
          phase: progress.phase || this.#job.phase,
          keywords: progress.keywords || this.#job.keywords,
          expansion: progress.expansion || this.#job.expansion,
          budget: progress.budget || this.#job.budget,
          progress: progress.progress || this.#job.progress,
        };
      },
      signal: abort.signal,
    }).then((result) => {
      if (this.#job?.id !== id) return;
      const ok = result?.ok === true && !result?.result?.manualDownloadRequired && !result?.result?.budgetExhausted;
      this.#job = {
        ...this.#job,
        status: ok ? 'completed' : 'failed',
        phase: 'finished',
        endedAt: new Date().toISOString(),
        result,
        keywords: result?.keywords || this.#job.keywords,
        budget: result?.budget || this.#job.budget,
        error: ok ? null : {
          code: result?.result?.code || result?.code || 'RUN_INCOMPLETE',
          message: result?.result?.message || result?.message || '任务未完整完成。',
        },
      };
    }).catch((error) => {
      if (this.#job?.id !== id) return;
      const stopped = abort.signal.aborted || error?.name === 'AbortError';
      this.#job = {
        ...this.#job,
        status: stopped ? 'stopped' : 'failed',
        phase: 'finished',
        endedAt: new Date().toISOString(),
        error: stopped ? null : { code: error?.code || 'RUN_FAILED', message: error?.message || String(error) },
      };
    }).finally(() => {
      if (this.#abort === abort) this.#abort = null;
    });

    return this.state();
  }

  stop() {
    if (this.#job?.status !== 'running') return this.state();
    this.#abort?.abort(new Error('用户已停止采集任务。'));
    this.#job = { ...this.#job, phase: 'stopping' };
    return this.state();
  }

  close() {
    this.#abort?.abort(new Error('插件正在卸载。'));
    this.#abort = null;
  }
}
