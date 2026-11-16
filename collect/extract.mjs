// extract.mjs — 作品页提取：通道 A 内联 JSON 优先，通道 B DOM 兜底。

const INLINE_SCRIPT_IDS = ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE', '__NEXT_DATA__'];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 读取页面内联 JSON（多个候选脚本，逐个尝试解析）。 */
export async function readInlineStates(page) {
  const texts = await page
    .evaluate((ids) => {
      const out = [];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.textContent && el.textContent.trim()) {
          out.push({ id, text: el.textContent });
        }
      }
      return out;
    }, INLINE_SCRIPT_IDS)
    .catch(() => []);

  const states = [];
  for (const entry of texts) {
    try {
      states.push({ id: entry.id, data: JSON.parse(entry.text) });
    } catch {
      /* 忽略无法解析的脚本 */
    }
  }
  return states;
}

/** 在多个已知路径中寻找 itemStruct。 */
export function pickItemStruct(states, videoId) {
  for (const state of states) {
    const data = state?.data;
    if (!data || typeof data !== 'object') continue;

    const scope = data.__DEFAULT_SCOPE__ || data.defaultScope || null;
    const detail = scope?.['webapp.video-detail'] || scope?.webappVideoDetail || null;
    const fromDetail = detail?.itemInfo?.itemStruct;
    if (fromDetail && (!videoId || String(fromDetail.id) === String(videoId))) {
      return { item: fromDetail, channel: `inline:${state.id}:video-detail` };
    }

    const direct = data.itemInfo?.itemStruct;
    if (direct && (!videoId || String(direct.id) === String(videoId))) {
      return { item: direct, channel: `inline:${state.id}:itemInfo` };
    }

    const itemModule = data.ItemModule || data.itemModule || null;
    if (itemModule && videoId && itemModule[videoId]) {
      return { item: itemModule[videoId], channel: `inline:${state.id}:ItemModule` };
    }
  }
  return { item: null, channel: null };
}

function absolute(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

/**
 * 从 video.bitrateInfo 里挑最高码率的播放地址（同码率优先 h264，兼容剪辑软件）。
 * 网页默认的 video.playAddr 有时只指向低档，这里显式挑一次。
 */
export function pickBestPlay(video = {}) {
  const list = Array.isArray(video.bitrateInfo) ? video.bitrateInfo : [];
  const options = [];
  for (const item of list) {
    const addr = item?.PlayAddr || {};
    const raw = (Array.isArray(addr.UrlList) && addr.UrlList[0]) || addr.Uri || '';
    const url = absolute(raw);
    if (!url) continue;
    const codec = String(item?.CodecType || '').toLowerCase();
    options.push({
      url,
      bitrate: num(item?.Bitrate) || 0,
      width: num(addr.Width),
      height: num(addr.Height),
      codec: codec || null,
      h264: codec.includes('h264') ? 1 : 0,
    });
  }
  if (!options.length) return null;
  options.sort((left, right) => (right.bitrate - left.bitrate) || (right.h264 - left.h264));
  return options[0];
}

/** 把 itemStruct 归一化为稳定的候选字段。 */
export function normalizeItem(item, { videoId, url } = {}) {
  if (!item || typeof item !== 'object') return null;
  const video = item.video || {};
  const stats = item.stats || item.statsV2 || {};
  const author = item.author || {};
  const music = item.music || {};

  const id = String(item.id || videoId || '');
  const best = pickBestPlay(video);
  return {
    videoId: id,
    url: url || (id && author.uniqueId ? `https://www.tiktok.com/@${author.uniqueId}/video/${id}` : null),
    desc: typeof item.desc === 'string' ? item.desc : null,
    createTime: num(item.createTime),
    duration: num(video.duration) ?? num(item.duration),
    author: {
      uniqueId: author.uniqueId || null,
      nickname: author.nickname || null,
      secUid: author.secUid || null,
    },
    stats: {
      playCount: num(stats.playCount),
      diggCount: num(stats.diggCount),
      commentCount: num(stats.commentCount),
      shareCount: num(stats.shareCount),
      collectCount: num(stats.collectCount),
    },
    music: {
      title: music.title || null,
      author: music.authorName || music.author || null,
      original: Boolean(music.original),
    },
    challenges: Array.isArray(item.challenges)
      ? item.challenges.map((c) => c?.title).filter(Boolean)
      : [],
    video: {
      width: num(video.width),
      height: num(video.height),
      ratio: video.ratio || null,
      cover: absolute(video.cover || video.originCover),
      dynamicCover: absolute(video.dynamicCover),
      playAddr: absolute(video.playAddr),
      // 最高码率档（无水印）；bitrateInfo 缺失时回落 null，由下载器退到 playAddr。
      playAddrBest: best?.url || null,
      playAddrBitrate: best?.bitrate || null,
      playAddrWidth: best?.width || null,
      playAddrHeight: best?.height || null,
      playAddrCodec: best?.codec || null,
      downloadAddr: absolute(video.downloadAddr),
    },
  };
}

/** 通道 B：从可见 DOM 抓最小字段集。 */
export async function extractFromDom(page) {
  const raw = await page
    .evaluate(() => {
      const text = (selector) => {
        const el = document.querySelector(selector);
        return el ? (el.textContent || '').trim() : null;
      };
      const attr = (selector, name) => {
        const el = document.querySelector(selector);
        return el ? el.getAttribute(name) : null;
      };
      const video = document.querySelector('video');
      const canonical = document.querySelector('link[rel="canonical"]');
      return {
        desc: text('[data-e2e="browse-video-desc"]'),
        author: text('[data-e2e="browse-username"]') || text('[data-e2e="browse-user-link"]'),
        like: text('[data-e2e="like-count"]'),
        comment: text('[data-e2e="comment-count"]'),
        share: text('[data-e2e="share-count"]'),
        music: text('[data-e2e="browse-music"]'),
        src: video?.currentSrc || video?.src || null,
        poster: video?.poster || null,
        canonical: canonical?.href || null,
        pageUrl: location.href,
        title: document.title,
      };
    })
    .catch(() => null);

  if (!raw) return null;
  const match = /\/video\/(\d+)/.exec(raw.canonical || raw.pageUrl || '');
  return {
    videoId: match ? match[1] : null,
    url: raw.canonical || raw.pageUrl || null,
    desc: raw.desc || raw.title || null,
    createTime: null,
    duration: null,
    author: { uniqueId: raw.author || null, nickname: raw.author || null, secUid: null },
    stats: {
      playCount: null,
      diggCount: raw.like || null,
      commentCount: raw.comment || null,
      shareCount: raw.share || null,
      collectCount: null,
    },
    music: { title: raw.music || null, author: null, original: false },
    challenges: [],
    video: {
      width: null,
      height: null,
      ratio: null,
      cover: raw.poster || null,
      dynamicCover: null,
      playAddr: raw.src || null,
      downloadAddr: null,
    },
  };
}

/**
 * 提取单条作品：先内联 JSON，失败再 DOM 兜底。
 * @returns {Promise<{ok:boolean, data:object|null, channel:string|null, code:string|null, message:string|null}>}
 */
export async function extractVideoDetail(page, { videoId, url, waitMs = 1500 } = {}) {
  if (url) {
    await page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      .catch(() => {});
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  const states = await readInlineStates(page);
  const picked = pickItemStruct(states, videoId);
  if (picked.item) {
    const data = normalizeItem(picked.item, { videoId, url: url || page.url() });
    if (data) return { ok: true, data, channel: picked.channel, code: null, message: null };
  }

  const dom = await extractFromDom(page);
  if (dom && (dom.videoId || videoId)) {
    const data = { ...dom, videoId: dom.videoId || String(videoId || '') };
    return { ok: true, data, channel: 'dom', code: null, message: null };
  }

  return {
    ok: false,
    data: null,
    channel: null,
    code: 'EXTRACT_FAILED',
    message: '内联 JSON 与 DOM 均未取到作品字段（页面可能未加载完或被拦截）。',
  };
}
