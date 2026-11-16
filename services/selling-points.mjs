// selling-points.mjs — P2-6 卖点提取：用文本模型从画面文字 + 文案里抽 ≤3 条卖点。
//
// 成本与边界：
//  - 单条约 ≤800 token（prompt 控制在 1200 字符内，max_tokens 300）；
//  - 默认关闭（judge.sellingPoints=false），失败只记 sellingNote，绝不影响主判定；
//  - 不重试（429/5xx 直接放弃），避免把一次判定变成三次调用。

export const SELLING_POINT_LIMITS = Object.freeze({
  maxPoints: 3,
  maxChars: 24,
  maxTokens: 300,
  maxPromptChars: 1200,
});

function failure(code, message) {
  return { ok: false, code, message };
}

/** 拼卖点提示词：只给文字信息（文案/话题/画面文字/画像），不看画面。 */
export function buildSellingPointsPrompt({ profile = {}, meta = {}, onScreenText = '' } = {}) {
  const lines = [
    '你是 TikTok 小游戏广告素材分析助手。请从下面的文字信息里提炼这条素材的卖点（观众为什么会停下来看/想玩）。',
    `输出要求：最多 ${SELLING_POINT_LIMITS.maxPoints} 条，每条不超过 ${SELLING_POINT_LIMITS.maxChars} 个汉字，名词短语或短句，不要编号、不要解释。`,
    '优先写“玩法钩子/视觉冲击/情绪点/奖励反馈”这类具体卖点；信息不足时宁可少写。',
    '',
    `目标画像：${profile.name || '未命名'}`,
    `必须符合：${(profile.mustHave || []).join('；') || '无'}`,
    `一票否决：${(profile.mustNot || []).join('；') || '无'}`,
    '',
    '文字信息：',
    `- 文案：${String(meta.desc || '').slice(0, 240) || '（无）'}`,
    `- 话题：${(meta.challenges || []).slice(0, 6).join(' ') || '（无）'}`,
    `- 画面文字：${String(onScreenText || '').slice(0, 120) || '（无）'}`,
    '',
    '严格只输出一个 JSON 对象，不要代码块、不要解释：',
    '{"sellingPoints": ["卖点1", "卖点2"]}',
  ];
  return lines.join('\n').slice(0, SELLING_POINT_LIMITS.maxPromptChars);
}

function cleanPoint(value) {
  const text = String(value ?? '')
    .replace(/^[\s\-*•·\d.、)）]+/u, '')
    .replace(/["'“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.slice(0, SELLING_POINT_LIMITS.maxChars);
}

/**
 * 解析模型回复：支持 {"sellingPoints":[...]} / {"points":[...]} / 裸数组 / 每行一条。
 * 始终去重、≤3 条、单条 ≤24 字。
 */
export function parseSellingPoints(reply) {
  const text = String(reply || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  if (!text) return [];

  const push = (list) => {
    const out = [];
    for (const item of list) {
      const point = cleanPoint(item);
      if (!point) continue;
      if (out.some((existing) => existing === point)) continue;
      out.push(point);
      if (out.length >= SELLING_POINT_LIMITS.maxPoints) break;
    }
    return out;
  };

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return push(parsed);
    if (parsed && typeof parsed === 'object') {
      const list = parsed.sellingPoints || parsed.points || parsed.selling_points || parsed.highlights;
      if (Array.isArray(list)) return push(list);
      if (typeof list === 'string') return push(list.split(/[\n;；,，]+/));
    }
  } catch {
    // 落到括号提取与逐行解析
  }

  const arrayMatch = /\{(?:[^{}]*)"(?:sellingPoints|points|selling_points|highlights)"\s*:\s*\[([\s\S]*?)\]/.exec(text);
  if (arrayMatch) {
    const items = [...arrayMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\"/g, '"'));
    if (items.length) return push(items);
  }
  const bracket = /\[([\s\S]*?)\]/.exec(text);
  if (bracket) {
    const items = [...bracket[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\"/g, '"'));
    if (items.length) return push(items);
  }
  return push(text.split(/\r?\n/).filter((line) => line.trim() && !/^\s*[{}\[\]]/.test(line)));
}

/**
 * 抽卖点。失败返回 ok:false，调用方只记 note，不改判定。
 * @returns {Promise<{ok:boolean, points?:string[], code?:string, message?:string, model?:string, usage?:object, latencyMs?:number}>}
 */
export async function extractSellingPoints({
  profile = {},
  meta = {},
  onScreenText = '',
  gateway = null,
  budget = null,
  signal,
} = {}) {
  if (!gateway) return failure('SELLING_POINTS_NO_GATEWAY', '没有模型网关，跳过卖点提取。');
  const hasText = Boolean(String(meta.desc || '').trim() || (meta.challenges || []).length || String(onScreenText || '').trim());
  if (!hasText) return failure('SELLING_POINTS_NO_INPUT', '没有文案、话题或画面文字，跳过卖点提取。');

  const result = await gateway.chat({
    kind: 'text',
    messages: [{ role: 'user', content: buildSellingPointsPrompt({ profile, meta, onScreenText }) }],
    maxTokens: SELLING_POINT_LIMITS.maxTokens,
    temperature: 0.2,
    budget,
    operation: 'selling_points',
    // 卖点是加分项，不做重试，避免一次判定变三次调用。
    retry: { attempts: 0 },
    signal,
  });
  if (!result.ok) {
    return {
      ok: false,
      code: result.code || 'SELLING_POINTS_FAILED',
      message: result.message,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  }
  const points = parseSellingPoints(result.content);
  if (!points.length) {
    return {
      ok: false,
      code: 'SELLING_POINTS_EMPTY',
      message: '模型没有给出可用卖点。',
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  }
  return {
    ok: true,
    points,
    model: result.model,
    source: result.source,
    usage: result.usage,
    latencyMs: result.latencyMs,
  };
}
