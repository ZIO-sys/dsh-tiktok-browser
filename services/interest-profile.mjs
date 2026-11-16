function parseObject(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  for (let start = cleaned.indexOf('{'); start >= 0; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(cleaned.slice(start, index + 1)); } catch {}
          break;
        }
      }
    }
  }
  return null;
}

function list(value, limit = 12) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim().slice(0, 80)).filter(Boolean).slice(0, limit)
    : [];
}

export function normalizeInterestProfile(raw, { id = 'interest', sampleCount = 0 } = {}) {
  const profile = {
    id,
    name: String(raw?.name || '观看兴趣画像').slice(0, 80),
    summary: String(raw?.summary || '').slice(0, 600),
    interests: list(raw?.interests),
    creators: list(raw?.creators),
    visualThemes: list(raw?.visualThemes),
    languages: list(raw?.languages, 8),
    positiveSeeds: list(raw?.positiveSeeds, 20),
    negativeKeywords: list(raw?.negativeKeywords, 20),
    searchDirections: list(raw?.searchDirections, 12),
    confidence: Math.max(0, Math.min(100, Number(raw?.confidence) || 0)),
    sampleCount: Number(sampleCount) || 0,
    generatedAt: new Date().toISOString(),
  };
  if (!profile.summary && !profile.interests.length && !profile.positiveSeeds.length) return null;
  return profile;
}

export async function buildInterestProfile({ samples = [], gateway, budget = null, signal, id = 'interest' } = {}) {
  if (!Array.isArray(samples) || !samples.length) return { ok: false, code: 'NO_SAMPLES', message: '没有可用于生成兴趣画像的样例。' };
  if (!gateway) return { ok: false, code: 'MODEL_NOT_CONFIGURED', message: '模型网关未就绪。' };
  const evidence = samples.slice(0, 30).map((sample, index) => ({
    index: index + 1,
    desc: String(sample.meta?.desc || '').slice(0, 280),
    author: sample.meta?.author || sample.meta?.nickname || '',
    challenges: Array.isArray(sample.meta?.challenges) ? sample.meta.challenges.slice(0, 8) : [],
    tags: Array.isArray(sample.features?.tags) ? sample.features.tags.slice(0, 8) : [],
    subjects: Array.isArray(sample.features?.subjects) ? sample.features.subjects.slice(0, 6) : [],
    scene: sample.features?.scene || '',
    style: sample.features?.style || '',
    captions: sample.features?.captions || '',
  }));
  const prompt = [
    '你在根据用户收藏/上传的短视频样例推断“观看兴趣画像”，用于后续公开搜索与推荐排序，不用于推断敏感身份。',
    '只基于给定文案和视觉标签，不要猜测年龄、性别、政治、健康、宗教等敏感属性。',
    `样例：${JSON.stringify(evidence)}`,
    '严格输出一个 JSON 对象，不要代码块：',
    '{"name":"画像名","summary":"80字以内兴趣总结","interests":["兴趣主题"],"creators":["创作者类型"],"visualThemes":["视觉主题"],"languages":["语言代码"],"positiveSeeds":["可用于TikTok搜索的种子词"],"negativeKeywords":["应排除内容"],"searchDirections":["后续扩展方向"],"confidence":0-100}',
  ].join('\n');
  const result = await gateway.chat({
    kind: 'text',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1200,
    temperature: 0.2,
    budget,
    operation: 'interest_profile',
    signal,
  });
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  const parsed = parseObject(result.content);
  const profile = normalizeInterestProfile(parsed, { id, sampleCount: samples.length });
  if (!profile) return { ok: false, code: 'INTEREST_PROFILE_UNPARSABLE', message: '模型回复无法解析为兴趣画像。' };
  return { ok: true, profile, model: result.model, source: result.source, usage: result.usage };
}
