// judge-rule.mjs — 规则分：零成本、可解释。不调模型，只看文本与元数据。
// 输出 0-100 的 ruleScore + 命中明细 + veto 标记。

const DURATION_MIN = 15;
const DURATION_MAX = 30;
const DURATION_SOFT_MIN = 8;
const DURATION_SOFT_MAX = 45;

// 画幅硬性要求：只收 9:16 竖屏。宽/高目标 0.5625，允许 ±3% 容差
// （约 0.5456–0.5794，覆盖 1080x1920 / 720x1280 及少量编码取整偏差）。
export const ASPECT_TARGET = 9 / 16;
export const ASPECT_TOLERANCE = 0.03;
const ASPECT_MIN = ASPECT_TARGET * (1 - ASPECT_TOLERANCE);
const ASPECT_MAX = ASPECT_TARGET * (1 + ASPECT_TOLERANCE);

/**
 * 判定候选作品画幅是否严格符合 9:16 竖屏。
 * 分辨率未知（DOM 兜底通道拿不到 width/height）时按「不通过」处理，宁缺毋滥。
 * @param {object} candidate
 * @returns {{ok:boolean, known:boolean, width:number|null, height:number|null, ratio:number|null, reason:string|null}}
 */
export function aspectVerdict(candidate) {
  const width = Number(candidate?.video?.width);
  const height = Number(candidate?.video?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, known: false, width: null, height: null, ratio: null, reason: '分辨率未知，无法确认 9:16 竖屏' };
  }
  const ratio = width / height;
  if (ratio < ASPECT_MIN || ratio > ASPECT_MAX) {
    return {
      ok: false,
      known: true,
      width,
      height,
      ratio: Number(ratio.toFixed(4)),
      reason: `画幅 ${width}x${height}（比例 ${ratio.toFixed(3)}）不是 9:16 竖屏`,
    };
  }
  return { ok: true, known: true, width, height, ratio: Number(ratio.toFixed(4)), reason: null };
}

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
export function ruleScore(candidate, profile, options = {}) {
  const enforceAspect = options?.enforceAspect !== false;
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

  // 5) 画幅：只认 9:16 竖屏（硬性要求，不通过直接一票否决）
  const aspect = aspectVerdict(candidate);
  detail.aspect = aspect.known ? aspect.ratio : null;
  detail.aspectOk = aspect.ok;
  if (aspect.ok) {
    score += 6;
    reasons.push(`竖屏 ${aspect.width}x${aspect.height}，符合 9:16（+6）`);
    tags.push('竖屏');
  } else {
    reasons.push(aspect.reason);
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

  // 7) 画幅硬性要求：非 9:16 竖屏或分辨率未知，一律一票否决
  // 画幅否决只在「启用画幅强制」或「分辨率已知且不合格」时生效；
  // 校准场景传 enforceAspect:false，让分辨率未知的样例仍能参与打分，否则分数恒 0、校准失效。
  if (!aspect.ok && (enforceAspect || aspect.known)) {
    veto = true;
    vetoReason = vetoReason ? `${vetoReason}；${aspect.reason}` : aspect.reason;
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
