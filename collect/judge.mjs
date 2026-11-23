// judge.mjs — 判定编排：ruleScore(0.4) + modelScore(0.6) → 最终分与结论。
// 冷启动（样例库为空）阈值放宽到 50；rejected 只写 JSON，不下载。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractFrames } from './frames.mjs';
import { scoreWithModel } from './judge-model.mjs';
import { ruleScore } from './judge-rule.mjs';

const DEFAULT_THRESHOLD = 60;
const COLD_START_THRESHOLD = 50;
const DEFAULT_MODEL_WEIGHT = 0.6;
// P1-6 规则预筛：规则分低于「阈值−20」或命中 mustNot 时直接 rejected，不抽帧、不调模型。
const PREFILTER_MARGIN = 20;
// 一次视觉判定的粗略估算（3 帧 + 提示词），只用于报告里的“节省 token”，不写入账本。
const PREFILTER_TOKEN_ESTIMATE = 600;

function libraryHasSamples(paths) {
  const indexPath = join(paths.libraryDir, 'sample-index.json');
  if (!existsSync(indexPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
    return Array.isArray(raw?.samples) && raw.samples.length > 0;
  } catch {
    return false;
  }
}

function modelMetaOf(candidate) {
  return {
    desc: candidate.desc,
    author: candidate.author?.uniqueId || candidate.author?.nickname,
    duration: candidate.duration,
    challenges: candidate.challenges,
    playCount: candidate.stats?.playCount,
  };
}

/**
 * 给单条候选打分。
 * 判定结果只回传调用方（写入候选库由调用方决定）；被拒素材不落盘任何 JSON。
 * @returns {Promise<{ok:boolean, videoId?:string, score?:number, verdict?:string, ruleScore?:number, modelScore?:number|null, reasons?:string[], tags?:string[], veto?:boolean, coldStart?:boolean, threshold?:number, code?:string, message?:string}>}
 */
export async function judgeCandidate({
  candidate,
  profile,
  config = {},
  paths,
  videoPath = null,
  api = null,
  modelGateway = null,
  budget = null,
  env = process.env,
  signal,
  fetchImpl,
  logger = null,
} = {}) {
  const judgeConfig = config?.judge || {};
  const coldStart = !libraryHasSamples(paths);
  const threshold = Number(judgeConfig.threshold ?? profile?.threshold ?? (coldStart ? COLD_START_THRESHOLD : DEFAULT_THRESHOLD));
  const modelWeight = Number(judgeConfig.modelWeight ?? DEFAULT_MODEL_WEIGHT);

  const rule = ruleScore(candidate, profile);
  const reasons = [...rule.reasons];
  const tags = [...rule.tags];

  // P1-6：规则预筛开启时，明显不合格（命中 mustNot 或规则分远低于阈值）的素材直接拒绝。
  const prefilter = String(judgeConfig.prefilter || 'off').toLowerCase() === 'rule';
  if (prefilter && (rule.veto || rule.ruleScore < threshold - PREFILTER_MARGIN)) {
    const prefilterReason = rule.veto ? 'must-not' : 'low-rule-score';
    const score = rule.veto ? 0 : rule.ruleScore;
    return {
      ok: true,
      videoId: candidate.videoId,
      score,
      verdict: 'rejected',
      ruleScore: score,
      modelScore: null,
      reasons,
      tags,
      veto: rule.veto,
      prefiltered: true,
      prefilter: 'rule',
      prefilterReason,
      prefilterLimit: threshold - PREFILTER_MARGIN,
      estimatedTokensSaved: PREFILTER_TOKEN_ESTIMATE,
      coldStart,
      threshold,
    };
  }

  if (rule.veto) {
    const record = {
      videoId: candidate.videoId,
      url: candidate.url,
      query: candidate.query,
      desc: candidate.desc,
      profileId: profile?.id,
      score: 0,
      ruleScore: 0,
      modelScore: null,
      verdict: 'rejected',
      veto: true,
      reasons,
      tags,
      judgedAt: new Date().toISOString(),
    };
    return { ok: true, videoId: candidate.videoId, score: 0, verdict: 'rejected', ruleScore: 0, modelScore: null, reasons, tags, veto: true, coldStart, threshold };
  }

  let modelScore = null;
  let modelMeta = null;
  if (judgeConfig.useModel !== false) {
    let frames = [];
    if (videoPath && existsSync(videoPath)) {
      const extracted = extractFrames(videoPath, { durationSec: candidate.duration, count: judgeConfig.frameCount ?? 3, signal });
      if (extracted.ok) frames = extracted.frames;
      else reasons.push(`抽帧失败：${extracted.message}`);
    } else {
      reasons.push('本地没有视频文件，模型分跳过');
    }

    if (frames.length) {
      const result = await scoreWithModel({
        frames,
        profile,
        meta: modelMetaOf(candidate),
        api: api ?? judgeConfig.api,
        gateway: modelGateway,
        budget,
        threshold,
        env,
        signal,
        fetchImpl,
      });
      if (!result.ok && result.code === 'TOKEN_BUDGET_EXHAUSTED') {
        return { ok: false, code: result.code, message: result.message, videoId: candidate.videoId };
      }
      if (result.ok) {
        modelScore = result.score;
        reasons.push(...result.reasons);
        tags.push(...result.tags);
        modelMeta = { model: result.model, source: result.source, latencyMs: result.latencyMs, usage: result.usage };
      } else {
        reasons.push(`模型分失败：${result.message || result.code}`);
      }
    }
  }

  let score;
  if (modelScore === null) {
    // 没有模型分时退化为纯规则分（避免把好素材一刀切掉）
    score = rule.ruleScore;
  } else {
    score = Math.round(rule.ruleScore * (1 - modelWeight) + modelScore * modelWeight);
  }
  score = Math.max(0, Math.min(100, score));
  const verdict = score >= threshold ? 'accepted' : 'rejected';

  const record = {
    videoId: candidate.videoId,
    url: candidate.url,
    query: candidate.query,
    desc: candidate.desc,
    profileId: profile?.id,
    profileName: profile?.name,
    score,
    ruleScore: rule.ruleScore,
    modelScore,
    model: modelMeta?.model || null,
    modelSource: modelMeta?.source || null,
    modelUsage: modelMeta?.usage || null,
    verdict,
    veto: false,
    reasons: reasons.slice(0, 12),
    tags: [...new Set(tags)].slice(0, 12),
    coldStart,
    threshold,
    judgedAt: new Date().toISOString(),
  };

  return {
    ok: true,
    videoId: candidate.videoId,
    score,
    verdict,
    ruleScore: rule.ruleScore,
    modelScore,
    reasons: record.reasons,
    tags: record.tags,
    veto: false,
    coldStart,
    threshold,
  };
}
