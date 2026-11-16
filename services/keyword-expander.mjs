function clean(value) {
  return String(value || '').trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 60);
}

export function parseKeywordReply(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const open = cleaned.indexOf('[', start >= 0 ? start : 0);
    if (open >= 0) {
      let depth = 0;
      for (let index = open; index < cleaned.length; index += 1) {
        if (cleaned[index] === '[') depth += 1;
        if (cleaned[index] === ']') {
          depth -= 1;
          if (depth === 0) {
            try { parsed = JSON.parse(cleaned.slice(open, index + 1)); } catch {}
            break;
          }
        }
      }
    }
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.keywords;
  return Array.isArray(list) ? list.map(clean).filter(Boolean) : [];
}

export async function expandKeywords({
  seeds = [],
  targetCount = 10,
  queryLanguage = 'en',
  contentLanguage = 'en',
  exclude = [],
  gateway,
  budget = null,
  signal,
} = {}) {
  const seedList = [...new Set((Array.isArray(seeds) ? seeds : []).map(clean).filter(Boolean))].slice(0, 20);
  if (!seedList.length) return { ok: false, code: 'INVALID_ARGUMENT', message: '至少需要一个种子词。' };
  if (!gateway) return { ok: false, code: 'MODEL_NOT_CONFIGURED', message: '模型网关未就绪。' };
  const count = Math.max(3, Math.min(Number(targetCount) || 10, 30));
  // contentLanguage='auto'（P1-5 默认）表示只检测不拦截，扩展词沿用搜索指令语言。
  const targetLanguage = String(contentLanguage || 'auto').toLowerCase() === 'auto'
    ? queryLanguage
    : contentLanguage;
  const languageHint = queryLanguage === targetLanguage
    ? `搜索词使用 ${queryLanguage}，目标视频语言为 ${targetLanguage}`
    : `搜索词使用 ${queryLanguage}，同时补充 ${targetLanguage} 本地表达，目标视频语言为 ${targetLanguage}`;
  const prompt = [
    '你是 TikTok 广告素材关键词扩展助手。只生成用于公开搜索的短关键词，不生成账号、私信或规避审核内容。',
    `种子词：${seedList.join(' | ')}`,
    `需要 ${count} 个新搜索词。${languageHint}。`,
    exclude.length ? `排除：${exclude.join(' | ')}` : '',
    '要求：保留原意、覆盖同义词/玩法/场景/受众表达；不要重复种子词；每个 1-5 个词；不要解释。',
    '严格输出 JSON：{"keywords":["词1","词2"]}',
  ].filter(Boolean).join('\n');

  const result = await gateway.chat({
    kind: 'text',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 700,
    temperature: 0.4,
    budget,
    operation: 'keyword_expand',
    signal,
  });
  if (!result.ok) return { ok: false, code: result.code, message: result.message, budget };
  const raw = parseKeywordReply(result.content);
  const seen = new Set(seedList.concat(exclude).map((item) => item.toLowerCase()));
  const keywords = [];
  for (const item of raw) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(item);
    if (keywords.length >= count) break;
  }
  if (!keywords.length) return { ok: false, code: 'KEYWORDS_UNPARSABLE', message: '模型没有返回可用的扩展词。' };
  return {
    ok: true,
    keywords,
    count: keywords.length,
    model: result.model,
    source: result.source,
    usage: result.usage,
    budget: result.budget || null,
  };
}
