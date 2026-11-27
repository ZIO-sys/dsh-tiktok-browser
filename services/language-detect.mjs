/**
 * 语言检测（纯规则，不调模型、不发网络请求）。
 *
 * 目的：在下载与视觉判定之前，用文案/话题标签粗判视频语言，省流量和 token。
 * 只做“脚本级 + 停用词”判断，不追求模型级准确；不确定时返回 unknown，调用方应当放行。
 */

export const LANGUAGE_CODES = Object.freeze([
  'auto', 'en', 'es', 'pt', 'id', 'ja', 'ko', 'de', 'fr', 'ar', 'th', 'vi', 'zh',
]);

export const LANGUAGE_LABELS = Object.freeze({
  auto: '自动（只记录）',
  en: '英语',
  es: '西班牙语',
  pt: '葡萄牙语',
  id: '印尼语',
  ja: '日语',
  ko: '韩语',
  de: '德语',
  fr: '法语',
  ar: '阿拉伯语',
  th: '泰语',
  vi: '越南语',
  zh: '中文',
});

/** 低于这个置信度不做拦截，只记录。 */
export const LANGUAGE_CONFIDENCE_THRESHOLD = 0.6;

const LATIN_STOPWORDS = {
  en: ['the', 'and', 'you', 'your', 'this', 'that', 'with', 'for', 'are', 'have', 'not', 'but', 'from', 'they', 'will', 'what', 'when', 'how', 'all', 'can', 'get', 'out', 'one', 'use', 'make', 'like', 'just', 'now', 'new', 'best', 'game', 'games', 'tutorial', 'to', 'of', 'is', 'it', 'in', 'on', 'my', 'we', 'do', 'so', 'if', 'at', 'be', 'or'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'para', 'con', 'por', 'como', 'más', 'mas', 'pero', 'sus', 'ya', 'este', 'esta', 'esto', 'son', 'muy', 'sin', 'sobre', 'también', 'tambien', 'juego', 'juegos', 'vídeo', 'video', 'tutorial', 'cómo', 'hacer', 'es', 'mi', 'tu', 'se', 'del', 'al'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'do', 'da', 'dos', 'das', 'em', 'um', 'uma', 'para', 'com', 'por', 'como', 'mais', 'mas', 'não', 'nao', 'seu', 'sua', 'isso', 'isto', 'são', 'sao', 'muito', 'sem', 'sobre', 'também', 'tambem', 'jogo', 'jogos', 'vídeo', 'video', 'tutorial', 'fazer', 'meu', 'minha', 'no', 'na'],
  id: ['yang', 'dan', 'di', 'ini', 'itu', 'dengan', 'untuk', 'dari', 'tidak', 'akan', 'pada', 'juga', 'saya', 'kamu', 'kami', 'bisa', 'ada', 'lebih', 'sudah', 'dalam', 'ke', 'seperti', 'video', 'game', 'permainan', 'tutorial', 'cara', 'buat', 'atau', 'sangat'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'für', 'fur', 'auf', 'von', 'zu', 'den', 'dem', 'des', 'sich', 'auch', 'wird', 'sind', 'im', 'hat', 'dass', 'kann', 'wie', 'oder', 'aber', 'mehr', 'video', 'spiel', 'spiele', 'tutorial', 'so', 'man', 'was', 'wir', 'ich'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'un', 'une', 'pour', 'avec', 'dans', 'sur', 'pas', 'que', 'qui', 'au', 'aux', 'ce', 'cette', 'il', 'elle', 'nous', 'vous', 'sont', 'plus', 'mais', 'comme', 'très', 'tres', 'jeu', 'jeux', 'vidéo', 'video', 'tutoriel', 'faire', 'mon', 'ma', 'du', 'en'],
  vi: ['và', 'va', 'của', 'cua', 'là', 'la', 'có', 'co', 'không', 'khong', 'được', 'duoc', 'những', 'nhung', 'này', 'nay', 'cho', 'với', 'voi', 'một', 'mot', 'các', 'cac', 'người', 'nguoi', 'như', 'nhu', 'rất', 'rat', 'video', 'trò', 'tro', 'chơi', 'choi', 'cách', 'cach'],
};

const SCRIPTS = [
  { code: 'ja', kana: /[\u3040-\u30ff]/g, han: true },
  { code: 'ko', pattern: /[\uac00-\ud7af\u1100-\u11ff]/g },
  { code: 'ar', pattern: /[\u0600-\u06ff\u0750-\u077f]/g },
  { code: 'th', pattern: /[\u0e00-\u0e7f]/g },
  { code: 'ru', pattern: /[\u0400-\u04ff]/g },
  { code: 'hi', pattern: /[\u0900-\u097f]/g },
  { code: 'zh', pattern: /[\u4e00-\u9fff]/g },
];

const VIETNAMESE_MARKS = /[\u0103\u00e2\u0111\u00ea\u00f4\u01a1\u01b0\u1ea0-\u1ef9]/g;
const DIACRITIC_HINTS = [
  { code: 'es', pattern: /[ñ¿¡]/g },
  { code: 'pt', pattern: /[ãõ]/g },
  { code: 'de', pattern: /[ß]/g },
  { code: 'fr', pattern: /[àèùçœ]/g },
];

function countMatches(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function normalizeText(input) {
  return String(input ?? '')
    .normalize('NFKC')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[@#]\S+/g, ' ')
    .toLowerCase();
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function lettersOf(text) {
  return (text.match(/\p{L}/gu) || []).length;
}

function detectLatin(text) {
  const tokens = text.split(/[^\p{L}]+/u).filter((token) => token.length > 1);
  const scores = {};
  for (const [code, words] of Object.entries(LATIN_STOPWORDS)) {
    const set = new Set(words);
    let hits = 0;
    for (const token of tokens) if (set.has(token)) hits += 1;
    scores[code] = hits;
  }
  for (const hint of DIACRITIC_HINTS) {
    if (countMatches(text, hint.pattern) > 0) scores[hint.code] = (scores[hint.code] || 0) + 1.5;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topCode, topHits] = ranked[0] || ['unknown', 0];
  const secondHits = ranked[1] ? ranked[1][1] : 0;
  if (!tokens.length || topHits < 2) {
    return { code: 'unknown', confidence: topHits > 0 ? 0.3 : 0, mixed: false, scores };
  }
  const coverage = Math.min(1, topHits / tokens.length);
  const dominance = topHits / Math.max(1, topHits + secondHits);
  const confidence = Math.min(0.95, 0.3 + 0.6 * coverage + 0.25 * (dominance - 0.5));
  const mixed = secondHits >= Math.max(2, topHits * 0.65) && dominance < 0.65;
  return { code: topCode, confidence: round3(confidence), mixed, scores };
}

/** 拉丁字母书写的语言。用于判断元数据 hint 与脚本证据冲突时该信谁。 */
const LATIN_LANGUAGES = new Set(['en', 'es', 'pt', 'id', 'de', 'fr', 'vi']);

/** 判定“这段文案确实是该脚本写的”所需的最少字符数与占比。 */
const SCRIPT_MIN_CHARS = 6;
const SCRIPT_MIN_SHARE = 0.5;
const SCRIPT_MIN_COVERAGE = 0.08;

function detectScript(text) {
  const letters = lettersOf(text);
  if (!letters) return { code: 'unknown', confidence: 0, mixed: false, scripts: {}, scriptLetters: 0 };
  const counts = {};
  for (const script of SCRIPTS) {
    let count;
    if (script.kana) {
      const kana = countMatches(text, script.kana);
      // 只有出现假名时才把汉字计入日语，否则纯中文会被误判成日语。
      count = kana > 0 && script.han ? kana + countMatches(text, /\u4e00-\u9fff/g) : kana;
    } else {
      count = countMatches(text, script.pattern);
    }
    if (count > 0) counts[script.code] = count;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { code: 'unknown', confidence: 0, mixed: false, scripts: counts, scriptLetters: 0 };
  const [code, count] = ranked[0];
  const scriptLetters = ranked.reduce((sum, [, n]) => sum + n, 0);
  // share：在“识别到的非拉丁脚本字符”里占多少；coverage：在全文所有字母里占多少。
  const share = count / Math.max(1, scriptLetters);
  const coverage = count / letters;
  // 置信度表示“这段文案确实是用该脚本写的”，而不是“该脚本占全文的比例”。
  // 旧公式用 count/letters，韩文/日文文案里混入大量英文品牌词时会被判成“不自信”而放行。
  const enough = count >= SCRIPT_MIN_CHARS && share >= SCRIPT_MIN_SHARE && coverage >= SCRIPT_MIN_COVERAGE;
  const confidence = enough
    ? round3(Math.min(0.99, 0.55 + 0.4 * share + 0.3 * Math.min(1, coverage * 2)))
    : round3(Math.min(0.59, coverage));
  const mixed = ranked.length > 1 && ranked[1][1] / Math.max(1, scriptLetters) >= 0.3;
  return { code, confidence, mixed, scripts: counts, scriptLetters };
}

/**
 * 检测一段文案的语言。
 * @param {string} input 文案/标题/话题
 * @param {object} [options]
 * @param {string} [options.langHint] TikTok 元数据里声明的语言（优先采信）
 * @returns {{code:string, confidence:number, mixed:boolean, source:'hint'|'script'|'latin'|'none', sampleLength:number}}
 */
export function detectLanguage(input, { langHint = '' } = {}) {
  const text = normalizeText(input);
  const sampleLength = lettersOf(text);
  const hint = String(langHint || '').toLowerCase().split(/[-_]/)[0];
  const hintValid = Boolean(hint) && LANGUAGE_CODES.includes(hint) && hint !== 'auto';
  if (sampleLength < 2) {
    if (hintValid) return { code: hint, confidence: 0.5, mixed: false, source: 'hint', sampleLength };
    return { code: 'unknown', confidence: 0, mixed: false, source: 'none', sampleLength };
  }

  const vietnameseMarks = countMatches(text, VIETNAMESE_MARKS);
  const script = detectScript(text);
  if (hintValid) {
    // 元数据声明的语言（TikTok 的 language 字段）经常跟着账号/创作者设置走，
    // 韩文文案被标成 en 时会以 confidence 1 直接绕过语言过滤。脚本证据足够强时以脚本为准。
    const hintIsLatin = LATIN_LANGUAGES.has(hint);
    const scriptStrong = script.code !== 'unknown'
      && Number(script.confidence) >= LANGUAGE_CONFIDENCE_THRESHOLD;
    if (hintIsLatin && scriptStrong && !LATIN_LANGUAGES.has(script.code)) {
      return { ...script, source: 'script', sampleLength };
    }
    return { code: hint, confidence: 1, mixed: false, source: 'hint', sampleLength };
  }
  if (script.code !== 'unknown' && script.code !== 'zh') {
    return { ...script, source: 'script', sampleLength };
  }
  if (script.code === 'zh') {
    if (vietnameseMarks >= 2) return { code: 'vi', confidence: 0.7, mixed: script.mixed, source: 'latin', sampleLength };
    return { ...script, source: 'script', sampleLength };
  }
  const latin = detectLatin(text);
  if (vietnameseMarks >= 2 && latin.code !== 'vi') {
    return { code: 'vi', confidence: Math.max(latin.confidence, 0.7), mixed: latin.mixed, source: 'latin', sampleLength };
  }
  return { ...latin, source: 'latin', sampleLength };
}

/**
 * 判断“已检测语言”是否满足目标语言。目标为 auto 时永远 pass（只记录）。
 * @returns {{action:'record'|'pass'|'skip', expected:string|null, matched:boolean|null, confident:boolean}}
 */
export function judgeLanguage(target, detected) {
  const expected = String(target || 'auto').trim().toLowerCase();
  if (!expected || expected === 'auto') {
    return { action: 'record', expected: null, matched: null, confident: false };
  }
  const confident = detected
    && detected.code !== 'unknown'
    && Number(detected.confidence) >= LANGUAGE_CONFIDENCE_THRESHOLD;
  if (!confident) return { action: 'pass', expected, matched: null, confident: false };
  const matched = detected.code === expected;
  return { action: matched ? 'pass' : 'skip', expected, matched, confident: true };
}
