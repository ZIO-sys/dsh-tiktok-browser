// judge-rule.mjs — 规则分：零成本、可解释。不调模型，只看文本与元数据。
// 输出 0-100 的 ruleScore + 命中明细 + veto 标记。

const DURATION_MIN = 15;
const DURATION_MAX = 30;
const DURATION_SOFT_MIN = 8;
const DURATION_SOFT_MAX = 45;

function normalize(text) {
  return String(text || '').toLowerCase();
}

function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((token) => token.length >= 2);
}

function hitsAny(haystack, needles) {
  return (needles || []).filter((needle) => needle && haystack.includes(normalize(needle)));
}

/**
 * 规则打分。
 * @param {object} candidate 候选记录（desc/author/challenges/duration/video.width|height/stats）
 * @param {object} profile 画像卡（mustHave/niceToHave/mustNot/keywords/guidance/durationRange）
 * @returns {{ok:boolean, ruleScore:number, reasons:string[], tags:string[], veto:boolean, vetoReason:string|null, detail:object}}
 */
export function ruleScore(candidate, profile) {
  const reasons = [];
  const tags = [];
  const detail = { keywordHits: [], mustHaveHits: [], niceToHaveHits: [], mustNotHits: [], duration: null, aspect: null };

  const desc = normalize(candidate?.desc);
  const authorText = normalize(candidate?.author?.uniqueId || candidate?.author || '');
  const challengeText = (Array.isArray(candidate?.challenges) ? candidate.challenges : []).map(normalize).join(' ');
  const haystack = `${desc} ${authorText} ${challengeText}`;
  const tokens = new Set(tokenize(`${desc} ${challengeText}`));

  let score = 50;

  // 1) 画像关键词命中（每个 +6，最多 +24）
  const keywords = profile?.keywords || [];
  const keywordHits = hitsAny(haystack, keywords);
  detail.keywordHits = keywordHits;
  if (keywordHits.length) {
    const bonus = Math.min(24, keywordHits.length * 6);
    score += bonus;
    reasons.push(`文案/话题命中画像关键词 ${keywordHits.slice(0, 4).join('、')}（+${bonus}）`);
    tags.push(...keywordHits.slice(0, 3));
  }

  // 2) mustHave：文本可判定的部分（每个 +8，最多 +24）
  const mustHave = profile?.mustHave || [];
  const mustHaveHits = mustHave.filter((needle) => hitsAny(haystack, [needle]).length || tokenize(needle).some((token) => tokens.has(token)));
  detail.mustHaveHits = mustHaveHits;
  if (mustHaveHits.length) {
    const bonus = Math.min(24, mustHaveHits.length * 8);
    score += bonus;
    reasons.push(`命中必须项 ${mustHaveHits.slice(0, 3).join('、')}（+${bonus}）`);
  }

  // 3) niceToHave（每个 +4，最多 +12）
  const niceToHaveHits = hitsAny(haystack, profile?.niceToHave || []);
  detail.niceToHaveHits = niceToHaveHits;
  if (niceToHaveHits.length) {
    const bonus = Math.min(12, niceToHaveHits.length * 4);
    score += bonus;
    reasons.push(`命中加分项 ${niceToHaveHits.slice(0, 3).join('、')}（+${bonus}）`);
  }

  // 4) 时长：15–30s 最佳，8–45s 可接受，其余扣分
  const duration = Number(candidate?.duration);
  if (Number.isFinite(duration) && duration > 0) {
    detail.duration = duration;
    if (duration >= DURATION_MIN && duration <= DURATION_MAX) {
      score += 12;
      reasons.push(`时长 ${duration}s 落在 15–30s 最佳区间（+12）`);
      tags.push('时长合适');
    } else if (duration >= DURATION_SOFT_MIN && duration <= DURATION_SOFT_MAX) {
      score += 2;
      reasons.push(`时长 ${duration}s 略偏离最佳区间（+2）`);
    } else if (duration < DURATION_SOFT_MIN) {
      score -= 8;
      reasons.push(`时长 ${duration}s 过短，难以承载玩法展示（-8）`);
    } else {
      score -= 6;
      reasons.push(`时长 ${duration}s 偏长，广告完播率风险（-6）`);
    }
  }

  // 5) 竖屏：9:16 加分，横屏扣分
  const width = Number(candidate?.video?.width);
  const height = Number(candidate?.video?.height);
  if (width > 0 && height > 0) {
    const ratio = width / height;
    detail.aspect = Number(ratio.toFixed(3));
    if (ratio < 0.75) {
      score += 6;
      reasons.push(`竖屏 ${width}x${height}，适配短视频投放（+6）`);
      tags.push('竖屏');
    } else if (ratio > 1.2) {
      score -= 8;
      reasons.push(`横屏 ${width}x${height}，不适合竖版投放（-8）`);
    }
  }

  // 6) mustNot 一票否决
  const mustNotHits = hitsAny(haystack, profile?.mustNot || []);
  detail.mustNotHits = mustNotHits;
  let veto = false;
  let vetoReason = null;
  if (mustNotHits.length) {
    veto = true;
    vetoReason = `命中一票否决项：${mustNotHits.slice(0, 3).join('、')}`;
    reasons.push(vetoReason);
    score = 0;
  }

  return {
    ok: true,
    ruleScore: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    tags,
    veto,
    vetoReason,
    detail,
  };
}
