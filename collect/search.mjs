// search.mjs — 搜索页：滚动收集作品卡片，只读不互动。

export const SEARCH_URL = 'https://www.tiktok.com/search?q=';

const VIDEO_HREF = /^https?:\/\/(?:www\.)?tiktok\.com\/@([^/?#]+)\/video\/(\d+)/i;

/**
 * 从当前搜索页读取已渲染的作品卡片。
 * 返回 [{ videoId, url, author, title }]，按出现顺序去重。
 */
export async function readSearchCards(page) {
  const raw = await page
    .evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      return anchors.map((anchor) => {
        const img = anchor.querySelector('img');
        return {
          href: anchor.href || '',
          label: (anchor.getAttribute('aria-label') || '').trim(),
          alt: (img?.getAttribute('alt') || '').trim(),
          text: (anchor.textContent || '').trim().slice(0, 200),
        };
      });
    })
    .catch(() => []);

  const cards = [];
  const seen = new Set();
  for (const item of raw) {
    const match = VIDEO_HREF.exec(item.href || '');
    if (!match) continue;
    const videoId = match[2];
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    const title = (item.label || item.alt || item.text || '').trim();
    cards.push({
      videoId,
      url: `https://www.tiktok.com/@${match[1]}/video/${videoId}`,
      author: match[1],
      title: title || null,
    });
  }
  return cards;
}

/**
 * 等待搜索结果首屏渲染。搜索页是 SPA，卡片渲染通常需要 3–10 秒；
 * 直接读取会拿到空骨架，误判为「没有结果」。
 */
export async function waitForSearchCards(page, { timeoutMs = 25000, intervalMs = 500, signal } = {}) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 25000);
  let lastCount = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted?.();
    lastCount = (await readSearchCards(page)).length;
    if (lastCount > 0) return lastCount;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return lastCount;
}

/** 滚动加载下一批。用滚轮而不是 window.scrollTo：结果列表可能位于内部滚动容器。 */
async function scrollToBottom(page) {
  await page.mouse.move(640, 480).catch(() => {});
  for (let step = 0; step < 4; step += 1) {
    await page.mouse.wheel(0, 1400).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await page
    .evaluate(() => {
      const el = document.scrollingElement || document.body;
      if (el) el.scrollTop = el.scrollHeight;
    })
    .catch(() => {});
}

/**
 * 滚动收集候选，直到数量达到 limit 或连续多轮无新增。
 * @returns {Promise<{cards: Array, rounds: number, exhausted: boolean}>}
 */
export async function collectSearchCards(page, { limit = 40, maxRounds = 16, pauseMs = 1800, waitMs = 25000, signal } = {}) {
  const collected = new Map();
  let idleRounds = 0;
  let rounds = 0;

  // 先等首屏卡片渲染，避免把「还在加载」误判成「没有结果」。
  await waitForSearchCards(page, { timeoutMs: waitMs, signal });

  for (let round = 0; round < maxRounds; round += 1) {
    signal?.throwIfAborted?.();
    rounds += 1;
    const before = collected.size;
    const cards = await readSearchCards(page);
    for (const card of cards) {
      if (!collected.has(card.videoId)) collected.set(card.videoId, card);
      if (collected.size >= limit) break;
    }
    if (collected.size >= limit) {
      return { cards: [...collected.values()].slice(0, limit), rounds, exhausted: false };
    }
    if (collected.size === before) {
      idleRounds += 1;
      if (idleRounds >= 3) {
        return { cards: [...collected.values()], rounds, exhausted: true };
      }
    } else {
      idleRounds = 0;
    }
    await scrollToBottom(page);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  return { cards: [...collected.values()], rounds, exhausted: false };
}

export function searchUrl(query) {
  return `${SEARCH_URL}${encodeURIComponent(String(query || '').trim())}`;
}
