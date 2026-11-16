// cover.mjs — P1-6 封面粗筛：用作品封面（1 张图）先做一次低成本视觉粗判。
// 封面 URL 是 TikTok CDN 的签名地址，必须优先在页面上下文里 fetch（带 referer/cookie）；
// Node 直连通常超时或 403，失败时由调用方回退到 3 帧正式判定，不阻断流程。

export const COVER_MAX_BYTES = 4 * 1024 * 1024;
export const COVER_TIMEOUT_MS = 8000;

/** 从候选记录里取封面 URL（优先静态封面，其次动态封面）。 */
export function coverUrlOf(candidate) {
  const video = candidate?.video || {};
  const url = video.cover || video.dynamicCover || null;
  return typeof url === 'string' && url.startsWith('http') ? url : null;
}

function toBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function mimeOf(type) {
  const value = String(type || '').toLowerCase();
  return value.startsWith('image/') ? value.split(';')[0] : 'image/jpeg';
}

/**
 * 抓封面并转成视觉模型可用的单帧。
 * @returns {Promise<{ok:boolean, frame?:{mime:string,data:string,bytes:number,source:string}, bytes?:number, source?:string, code?:string, message?:string}>}
 */
export async function fetchCoverFrame({
  page = null,
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = COVER_TIMEOUT_MS,
  maxBytes = COVER_MAX_BYTES,
  signal,
} = {}) {
  if (!url || typeof url !== 'string') {
    return { ok: false, code: 'NO_COVER_URL', message: '候选没有封面地址。' };
  }

  // 通道 A：页面上下文 fetch（同源、带 cookie 与 referer，成功率最高）。
  if (page && typeof page.evaluate === 'function') {
    try {
      const result = await page.evaluate(
        async ({ target, limit }) => {
          try {
            const response = await fetch(target, { credentials: 'include' });
            if (!response.ok) return { ok: false, code: `COVER_HTTP_${response.status}` };
            const type = response.headers.get('content-type') || '';
            const buffer = await response.arrayBuffer();
            if (buffer.byteLength > limit) return { ok: false, code: 'COVER_TOO_LARGE' };
            const bytes = new Uint8Array(buffer);
            let binary = '';
            const chunk = 0x8000;
            for (let index = 0; index < bytes.length; index += chunk) {
              binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
            }
            return { ok: true, mime: type, base64: btoa(binary), bytes: bytes.length };
          } catch (error) {
            return { ok: false, code: 'COVER_FETCH_FAILED', message: String(error?.message || error).slice(0, 200) };
          }
        },
        { target: url, limit: maxBytes },
      );
      if (result?.ok && result.base64) {
        const bytes = Number(result.bytes) || 0;
        return {
          ok: true,
          frame: { mime: mimeOf(result.mime), data: result.base64, bytes, source: 'page' },
          bytes,
          source: 'page',
        };
      }
      if (result?.code) {
        // 页面通道明确失败时再试直连；两者都失败才回退。
        const fallback = await fetchDirect({ url, fetchImpl, timeoutMs, maxBytes, signal });
        if (fallback.ok) return fallback;
        return { ok: false, code: result.code, message: result.message || '页面内抓取封面失败。' };
      }
    } catch (error) {
      // page.evaluate 本身失败（页面被关/导航中），继续尝试直连。
    }
  }

  return fetchDirect({ url, fetchImpl, timeoutMs, maxBytes, signal });
}

async function fetchDirect({ url, fetchImpl, timeoutMs, maxBytes, signal }) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, code: 'NO_FETCH', message: '当前环境没有 fetch。' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || COVER_TIMEOUT_MS));
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort);
  try {
    const response = await fetchImpl(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        referer: 'https://www.tiktok.com/',
        accept: 'image/avif,image/webp,image/jpeg,image/png,*/*',
      },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, code: `COVER_HTTP_${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) return { ok: false, code: 'COVER_TOO_LARGE' };
    return {
      ok: true,
      frame: { mime: mimeOf(response.headers.get('content-type')), data: toBase64(buffer), bytes: buffer.byteLength, source: 'fetch' },
      bytes: buffer.byteLength,
      source: 'fetch',
    };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return { ok: false, code: aborted ? 'COVER_TIMEOUT' : 'COVER_FETCH_FAILED', message: String(error?.message || error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
