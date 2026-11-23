import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCollect } from '../collect/batch.mjs';
import { createLibrary } from '../collect/library.mjs';
import { runSearch } from '../collect/pipeline.mjs';
import { BrowserController } from '../core.mjs';
import { resolveRuntimePaths } from '../runtime-paths.mjs';
import { exportCandidatesCsv } from '../services/export.mjs';
import { expandKeywords } from '../services/keyword-expander.mjs';
import { RunService } from '../services/run-service.mjs';
import { createSettingsService } from '../services/settings-service.mjs';
import { TOOL_DEFINITIONS } from '../tool-definitions.mjs';

function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const env = { TIKTOK_BROWSER_HOME: root };
  return { root, env, paths: resolveRuntimePaths({ env }) };
}

function localDateKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function batchStore() {
  return {
    readRuns: () => [],
    recordRun: () => {},
  };
}

function makeLlm(reply = '{"keywords":["游戏"],"mustHave":["真人"],"description":"真人游戏素材。"}') {
  const calls = [];
  return {
    calls,
    async resolveModelInfo(provider, model) {
      calls.push({ type: 'resolve', provider, model });
      return { inputModalities: ['text'], reasoning: { efforts: [{ id: 'off' }] } };
    },
    async *stream(input) {
      calls.push({ type: 'stream', input });
      yield { type: 'text-delta', index: 0, text: reply };
      yield { type: 'usage', usage: { total_tokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

const hostModel = { currentSelection: () => ({ provider: 'workbuddy', model: 'glm-5.2' }) };

test('AI 扩展数量 0 可保存，采集数量上限统一为 200', () => {
  const { root, paths } = fixture('tiktok-settings-024-');
  try {
    const service = createSettingsService({ paths });
    const updated = service.update({ search: { targetCount: 0, targetVideos: 200 } });
    assert.equal(updated.config.search.targetCount, 0);
    assert.equal(updated.config.search.targetVideos, 200);
    assert.throws(() => service.update({ search: { targetVideos: 201 } }), /200/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AI 扩展数量 0 返回空扩展列表，也绝不调用模型', async () => {
  let called = 0;
  const result = await expandKeywords({
    seeds: ['b', 'a', 'b', 'a'],
    targetCount: 0,
    exclude: [],
    gateway: { chat: async () => { called += 1; return { ok: true }; } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.deepEqual(result.keywords, []);
  assert.equal(result.count, 0);
  assert.equal(called, 0);
});

test('AI 扩展为 0 的预览不被已耗尽的模型预算拦截', async () => {
  const { root, env, paths } = fixture('tiktok-preview-zero-');
  try {
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(join(paths.stateDir, 'token-usage.jsonl'), `${JSON.stringify({
      event: 'settle', timestamp: new Date().toISOString(), totalTokens: 10, operation: 'test',
    })}\n`, 'utf8');
    const llm = makeLlm();
    const controller = new BrowserController({
      env,
      paths,
      llm,
      agentDefaultModel: hostModel,
      config: { search: { dailyTokenBudget: 1, tokenBudget: 1000 } },
    });
    const skipped = await controller.previewKeywords({ seeds: ['seed'], targetCount: 0 });
    assert.equal(skipped.ok, true);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.budget, null);
    assert.deepEqual(skipped.seeds, ['seed']);
    assert.deepEqual(skipped.keywords, []);
    const blocked = await controller.previewKeywords({ seeds: ['seed'], targetCount: 1 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'DAILY_TOKEN_BUDGET_EXHAUSTED');
    assert.equal(llm.calls.filter((item) => item.type === 'stream').length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RunService 将目标数量钳制到 200，并保留 AI 扩展 0', async () => {
  let captured = null;
  const controller = {
    expandAndCollect: async (input) => {
      captured = input;
      return { ok: true, keywords: input.seeds, result: { ok: true } };
    },
  };
  const service = new RunService({ controller });
  service.start({ seeds: ['seed'], targetCount: 0, targetVideos: 999 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captured.targetCount, 0);
  assert.equal(captured.targetVideos, 200);
  assert.equal(service.state().status, 'completed');
});

function searchFixture(videoId, downloadOk) {
  const item = {
    id: videoId,
    desc: 'portrait gameplay video',
    createTime: 1,
    author: { uniqueId: 'creator', nickname: 'Creator' },
    video: { width: 1080, height: 1920, duration: 10, playAddr: 'https://example.invalid/video.mp4' },
    stats: {},
    challenges: [],
  };
  const url = `https://www.tiktok.com/@creator/video/${videoId}`;
  const inline = JSON.stringify({ itemInfo: { itemStruct: item } });
  const searchPage = {
    url: () => 'https://www.tiktok.com/search?q=test',
    goto: async () => {},
    reload: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    mouse: { move: async () => {}, wheel: async () => {} },
    evaluate: async (fn) => {
      const source = String(fn);
      if (source.includes('querySelectorAll') && source.includes('/video/')) {
        return [{ href: url, label: 'gameplay', alt: '', text: 'gameplay' }];
      }
      if (source.includes('verification') && source.includes('blocked')) {
        return { url: searchPage.url(), title: 'TikTok', verification: false, blocked: false };
      }
      return null;
    },
  };
  const videoPage = {
    url: () => url,
    goto: async () => {},
    evaluate: async (fn) => {
      const source = String(fn);
      if (source.includes('document.getElementById(id)')) return [{ id: 'SIGI_STATE', text: inline }];
      if (source.includes('verification')) return { url, title: 'TikTok', verification: false, blocked: false };
      return null;
    },
  };
  const candidates = new Map();
  const seen = new Set();
  const store = {
    loadSeen: () => new Set(seen),
    markSeen: (id) => { seen.add(id); },
    upsertCandidate: (row) => { candidates.set(row.videoId, row); return row; },
    removeCandidate: (id) => { candidates.delete(id); },
    recordRun: () => {},
  };
  return {
    store,
    candidates,
    options: {
      searchPage,
      getPage: async () => videoPage,
      store,
      config: { dedup: { enabled: false }, collect: { minDelayMs: 0, maxDelayMs: 0, batchPauseEvery: 0 } },
      query: 'test',
      limit: 1,
      stopAfter: 1,
      detail: true,
      download: true,
      downloadsDir: join(tmpdir(), 'unused-tiktok-downloads'),
      judgeProfile: { id: 'p', threshold: 0, mustHave: [], mustNot: [], niceToHave: [] },
      judgeConfig: { useModel: false, threshold: 0, prefilter: 'off' },
      judgePaths: { libraryDir: join(tmpdir(), 'unused-tiktok-library') },
      downloadManager: {
        download: async () => (downloadOk
          ? { ok: true, file: join(tmpdir(), `${videoId}.mp4`), bytes: 100, source: 'test', channel: 'test' }
          : { ok: false, code: 'DOWNLOAD_FAILED', message: '模拟下载失败', channel: 'test' }),
      },
      scrollRounds: 0,
      waitMs: 0,
      pauseMs: 0,
    },
  };
}

test('成功计数：下载失败即使判定通过也不算成功，也不改成 accepted 状态', async () => {
  const fixtureData = searchFixture('900000000000000001', false);
  const summary = await runSearch({ ...fixtureData.options, judge: true });
  assert.equal(summary.accepted, 1);
  assert.equal(summary.downloaded, 0);
  assert.equal(summary.succeeded, 0);
  assert.equal(summary.targetReached, false);
  assert.equal(fixtureData.candidates.get('900000000000000001').status, 'download_failed');
});

test('成功计数：判定通过且归档成功才达标', async () => {
  const fixtureData = searchFixture('900000000000000002', true);
  const summary = await runSearch({ ...fixtureData.options, judge: true });
  assert.equal(summary.accepted, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.targetReached, true);
  assert.equal(fixtureData.candidates.get('900000000000000002').status, 'accepted');
});

test('成功计数：关闭判定时只按实际归档成功达标', async () => {
  const success = searchFixture('900000000000000003', true);
  const passed = await runSearch({ ...success.options, judge: false });
  assert.equal(passed.downloaded, 1);
  assert.equal(passed.succeeded, 1);
  assert.equal(passed.targetReached, true);

  const failure = searchFixture('900000000000000004', false);
  const failed = await runSearch({ ...failure.options, judge: false });
  assert.equal(failed.downloaded, 0);
  assert.equal(failed.succeeded, 0);
  assert.equal(failed.targetReached, false);
});

test('批量采集不信任没有成功数支撑的 targetReached，并按实际成功累计停止', async () => {
  const calls = [];
  const noSuccess = await runCollect({
    keywords: ['a', 'b'],
    targetVideos: 1,
    store: batchStore(),
    pauseMs: 0,
    search: async ({ query }) => {
      calls.push(query);
      return { ok: true, found: 1, extracted: 1, accepted: 1, succeeded: 0, targetReached: true };
    },
  });
  assert.equal(noSuccess.ok, false);
  assert.equal(noSuccess.code, 'TARGET_NOT_REACHED');
  assert.equal(noSuccess.targetReached, false);
  assert.deepEqual(calls, ['a', 'b']);

  const successCalls = [];
  const success = await runCollect({
    keywords: ['a', 'b', 'c'],
    targetVideos: 2,
    store: batchStore(),
    pauseMs: 0,
    search: async ({ query }) => {
      successCalls.push(query);
      return { ok: true, found: 1, extracted: 1, accepted: 1, succeeded: 1 };
    },
  });
  assert.equal(success.ok, true);
  assert.equal(success.targetReached, true);
  assert.equal(success.totals.succeeded, 2);
  assert.deepEqual(successCalls, ['a', 'b']);
});

test('样例文件夹按全量索引统计，不再截断前 500 条', () => {
  const { root, env, paths } = fixture('tiktok-library-count-');
  try {
    mkdirSync(paths.libraryDir, { recursive: true });
    const samples = Array.from({ length: 501 }, (_, index) => ({
      sampleId: `s${index}`,
      videoId: `v${index}`,
      profileId: index === 500 ? 'late-folder' : 'first-folder',
      polarity: 'positive',
      file: join(paths.libraryDir, 'samples', `s${index}.mp4`),
      meta: {},
    }));
    writeFileSync(join(paths.libraryDir, 'sample-index.json'), JSON.stringify({ version: 1, samples }), 'utf8');
    const controller = new BrowserController({ env, paths });
    const result = controller.library();
    assert.equal(result.count, 501);
    assert.equal(result.byProfile['first-folder'], 500);
    assert.equal(result.byProfile['late-folder'], 1);
    assert.equal(result.samples.length, 501);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('画像校准只调用一次文本合成模型，随后仅更新阈值', async () => {
  const { root, env, paths } = fixture('tiktok-profile-calibrate-');
  try {
    mkdirSync(paths.libraryDir, { recursive: true });
    const samples = Array.from({ length: 3 }, (_, index) => ({
      sampleId: `s${index}`,
      videoId: `v${index}`,
      profileId: 'p',
      polarity: 'positive',
      file: join(paths.libraryDir, 'samples', `s${index}.mp4`),
      meta: { desc: `gameplay ${index}`, challenges: [], duration: 10 },
      features: { subjects: ['真人'], scene: '游戏', style: '录屏', colors: '彩色', camera: '固定', captions: '无', hasPerson: true, hasInteraction: true, tags: ['游戏'] },
    }));
    writeFileSync(join(paths.libraryDir, 'sample-index.json'), JSON.stringify({ version: 1, samples }), 'utf8');
    const llm = makeLlm();
    const controller = new BrowserController({
      env,
      paths,
      llm,
      agentDefaultModel: hostModel,
      config: { search: { dailyTokenBudget: 0, tokenBudget: 10000 } },
    });
    const result = await controller.profileBuild({ profileId: 'p', calibrate: true });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.synthesis.ok, true);
    assert.equal(llm.calls.filter((item) => item.type === 'stream').length, 1);
    const saved = JSON.parse(readFileSync(join(paths.libraryDir, 'profiles', 'p.json'), 'utf8'));
    assert.equal(saved.threshold, result.profile.threshold);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('素材库列表与 CSV 共用采集日期过滤，工具调用也透传 date', async () => {
  const { root, env, paths } = fixture('tiktok-date-export-');
  try {
    mkdirSync(paths.stateDir, { recursive: true });
    const firstDay = new Date(2026, 9, 1, 12, 0, 0);
    const secondDay = new Date(2026, 9, 2, 12, 0, 0);
    const wanted = localDateKey(firstDay);
    const rows = [
      { videoId: 'd1', status: 'archived', collectedAt: firstDay.toISOString(), updatedAt: secondDay.toISOString(), desc: 'first', query: 'q', archive: {} },
      { videoId: 'd2', status: 'archived', collectedAt: secondDay.toISOString(), updatedAt: firstDay.toISOString(), desc: 'second', query: 'q', archive: {} },
    ];
    writeFileSync(join(paths.stateDir, 'candidates.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const controller = new BrowserController({ env, paths });
    const listed = controller.libraryCandidates({ date: wanted, limit: 30 });
    assert.equal(listed.total, 1);
    assert.equal(listed.candidates[0].videoId, 'd1');
    const exported = await controller.execute('tiktok_export', { date: wanted });
    assert.equal(exported.ok, true);
    assert.equal(exported.rows, 1);
    assert.equal(exported.filters.date, wanted);
    const csv = readFileSync(exported.file, 'utf8');
    assert.equal(csv.trim().split(/\r?\n/).length, 2);
    assert.match(csv, /d1/);
    assert.doesNotMatch(csv, /d2/);
    const schema = TOOL_DEFINITIONS.find((item) => item.name === 'tiktok_export');
    assert.equal(schema.parameters.properties.date.type, 'string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('删除画像级联清理所属样例和历史，且不越界删除库外文件', () => {
  const { root, paths } = fixture('tiktok-profile-delete-');
  try {
    const library = createLibrary({ libraryDir: paths.libraryDir });
    mkdirSync(library.samplesDir, { recursive: true });
    mkdirSync(library.profilesDir, { recursive: true });
    const inside = join(library.samplesDir, 'inside.mp4');
    const outside = join(root, 'outside.mp4');
    const sidecar = join(library.samplesDir, 'inside.json');
    writeFileSync(inside, 'video', 'utf8');
    writeFileSync(outside, 'keep', 'utf8');
    writeFileSync(sidecar, '{}', 'utf8');
    writeFileSync(join(library.profilesDir, 'p.json'), JSON.stringify({ id: 'p', name: 'P' }), 'utf8');
    const historyDir = join(library.profilesDir, '.history', 'p');
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, 'old.json'), '{}', 'utf8');
    writeFileSync(join(paths.libraryDir, 'sample-index.json'), JSON.stringify({ version: 1, samples: [
      { sampleId: 'inside', videoId: 'v1', profileId: 'p', file: inside },
      { sampleId: 'outside', videoId: 'v2', profileId: 'p', file: outside },
    ] }), 'utf8');
    const result = library.removeProfile({ profileId: 'p' });
    assert.equal(result.ok, true);
    assert.equal(result.removedSamples, 2);
    assert.equal(existsSync(inside), false);
    assert.equal(existsSync(sidecar), false);
    assert.equal(existsSync(outside), true);
    assert.equal(existsSync(historyDir), false);
    assert.equal(library.listSamples().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('发布清单删除旧预筛和观看兴趣模块，并包含 LICENSE 与全部测试', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.version, '0.2.4');
  for (const removed of ['collect/cover.mjs', 'services/selling-points.mjs', 'services/interest-profile.mjs']) {
    assert.equal(packageJson.dsh.bundle.files.includes(removed), false);
    assert.equal(existsSync(new URL(`../${removed}`, import.meta.url)), false);
  }
  assert.equal(packageJson.dsh.bundle.files.includes('LICENSE'), true);
  assert.equal(existsSync(new URL('../LICENSE', import.meta.url)), true);
  assert.match(packageJson.scripts.test, /release-0\.2\.4\.test\.mjs/);
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /生成观看兴趣画像|封面预筛（/);
  assert.match(client, /低成本预筛/);
  assert.match(client, /sampleFolderPolarity/);
  assert.match(client, /type: 'date'/);
});
