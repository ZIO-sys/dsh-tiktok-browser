// profiles.mjs — 画像卡（判定标准）。默认两张：AR 滤镜/体感互动小游戏、益智解谜 match-3。
// 用户可在 ~/.dsh/tiktok-browser/config.json 的 judge.profiles 里覆盖或追加。

export const DEFAULT_PROFILES = [
  {
    id: 'ar-filter-game',
    name: 'AR 滤镜 / 体感互动小游戏',
    keywords: [
      'ar', 'filter', 'face', 'effect', 'head', 'body', 'motion', 'interactive',
      'challenge', 'viral', 'trend', 'game', '小游戏', '滤镜', '特效', '互动', '体感',
    ],
    mustHave: ['真人出镜', '脸或身体出现在画面中', '互动玩法'],
    niceToHave: ['前 3 秒有强钩子', '字幕提示玩法', '生活场景', '情绪反应'],
    mustNot: ['纯图文轮播', '游戏录屏无真人', '无互动元素的静态画面', 'photo slideshow', 'static image', 'no face'],
    guidance:
      '这是 TikTok minis 的 AR 滤镜 / 体感互动小游戏素材。优先要"真人 + 脸/身体 + 可见的即时反应"的镜头；玩法要一眼看懂（眨眼、张嘴、摇头、举手触发特效）；前 3 秒最好直接展示效果对比。',
    threshold: 60,
  },
  {
    id: 'puzzle-match3',
    name: '益智解谜 / match-3 小游戏',
    keywords: [
      'match', 'puzzle', 'tile', 'block', 'brain', 'casual', 'merge', 'sort',
      '解谜', '消除', '三消', '拼图', '益智',
    ],
    mustHave: ['玩法画面清晰', '棋盘或关卡可辨识'],
    niceToHave: ['前 3 秒展示消除/过关瞬间', '有失败或紧张感', '真人反应镜头', '字幕引导'],
    mustNot: ['纯真人无玩法画面', '与解谜无关的生活 vlog', 'talking head only', 'no gameplay'],
    guidance:
      '这是 TikTok minis 的益智解谜 / match-3 素材。优先要"玩法画面清晰 + 有即时反馈（消除、连击、过关）"的镜头；前 3 秒最好直接给出一次消除或过关的爽点。',
    threshold: 60,
  },
];

import { areDefaultProfilesHidden, loadGeneratedProfiles } from './library.mjs';

/** 合并默认卡 / 用户配置卡 / 样例库自动生成卡（同 id 时生成卡优先，但保留默认卡里更严格的 mustNot）。 */
export function listProfiles(config, libraryDir = null) {
  const custom = config?.judge?.profiles;
  const hasCustom = Array.isArray(custom) && custom.length > 0;
  const base = hasCustom ? custom : DEFAULT_PROFILES;
  const generated = libraryDir ? loadGeneratedProfiles(libraryDir) : [];
  // 用户清空画像库后，代码内置的两张默认卡也一并隐藏，直到主动恢复。
  const hidden = !hasCustom && libraryDir ? areDefaultProfilesHidden(libraryDir) : false;
  const baseline = hidden ? [] : base;
  if (!baseline.length && !generated.length) return [];
  if (!generated.length) return baseline;

  const merged = baseline.map((profile) => ({ ...profile }));
  for (const card of generated) {
    const index = merged.findIndex((profile) => profile.id === card.id);
    if (index < 0) {
      merged.push({ ...card, generated: true });
      continue;
    }
    const original = merged[index];
    merged[index] = {
      ...original,
      ...card,
      // 生成/人工编辑过的画像以文件为准，允许把 mustNot 显式清空。
      mustNot: Array.isArray(card.mustNot) ? card.mustNot : original.mustNot,
      threshold: Number(card.threshold) || original.threshold,
      generated: true,
    };
  }
  return merged;
}

export function findProfile(config, id, libraryDir = null) {
  const profiles = listProfiles(config, libraryDir);
  if (!id) return profiles[0] || null;
  return profiles.find((profile) => profile.id === id) || null;
}
