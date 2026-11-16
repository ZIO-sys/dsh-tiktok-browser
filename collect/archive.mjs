// archive.mjs — M3：下载作品媒体文件并按「关键词 / 日期」归档，同时写同名 sidecar JSON。
//
// 设计要点（见 tiktok-browser-design.md）：
// - **默认优先 playAddr（无水印）**，失败再退 downloadAddr（带水印、但更稳）。
//   2026-11-10 实机对比确认：同一作品 playAddr 与 downloadAddr 时长/分辨率/音轨完全一致，
//   downloadAddr 画面上有 "♪ TikTok @作者" 浮层，playAddr 没有。
// - playAddr / downloadAddr 都是**带签名、有时效**的 CDN 地址，必须拿到就下，不能缓存隔夜。
// - 归档结构：downloads/<keyword-slug>/<YYYY-MM-DD>/<videoId>.mp4 + <videoId>.json
// - 重跑不重复下载：目标文件已存在且大小合理则跳过。

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** 小于这个字节数视为下载失败（TikTok 的错误页 / 空响应）。 */
const MIN_VIDEO_BYTES = 10 * 1024;

/**
 * 媒体地址类型 → 水印语义。
 * playAddr 是播放流（无水印），downloadAddr 是官方"下载"地址（带 TikTok 浮层水印）。
 */
export const WATERMARK_BY_SOURCE = Object.freeze({
  playAddrBest: 'none',
  playAddr: 'none',
  downloadAddr: 'watermarked',
});

/** 把 source（可能带 "(refreshed)" 后缀）映射成 none / watermarked / unknown。 */
export function watermarkOfSource(source = '') {
  const key = String(source || '').replace(/\(refreshed\)$/i, '').trim();
  return WATERMARK_BY_SOURCE[key] || 'unknown';
}

/** 分块从页面取回二进制的块大小（base64 后约 700KB/次，避免单条 CDP 消息过大）。 */
const CHUNK_BYTES = 512 * 1024;
// M5 优化：流式下载单块大小（页面侧分块读取，避免整段缓冲）。
const STREAM_CHUNK_BYTES = 1024 * 1024;

/**
 * 清洗错误信息：Playwright 的报错会把完整请求头（含 cookie / sessionid）拼进 message，
 * 这些内容绝不能落盘。只保留第一行的简短描述。
 */
export function sanitizeDownloadMessage(text, limit = 200) {
  const raw = String(text || '');
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim()) || '';
  const stripped = firstLine
    .replace(/cookie:\s*[^;]*(;\s*[^;]+)*/gi, 'cookie: <redacted>')
    .replace(/(sessionid|sid_guard|sid_tt|uid_tt|msToken|tt_chain_token)=[^;\s]+/gi, '$1=<redacted>');
  return stripped.slice(0, limit);
}

/** 关键词转目录名：小写、非字母数字转 -、压缩重复、限长。 */
export function keywordSlug(keyword) {
  const slug = String(keyword || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}

/** 本地日期戳 YYYY-MM-DD（用本地时区，方便按"今天"找文件）。 */
export function dateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 归档目录：按日期 <downloads>/<YYYY-MM-DD>/。
 * 2026-11-10 起不再按关键词分层（关键词仍写在 sidecar 的 query 与候选记录里）。
 */
export function archiveDir(downloadsDir, keyword, date = new Date()) {
  return join(downloadsDir, dateStamp(date));
}

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 找已归档的 mp4，兼容两种布局：
 *  - 新（默认）：<downloads>/<YYYY-MM-DD>/<videoId>.mp4
 *  - 旧（P1~P2 遗留）：<downloads>/<keyword>/<YYYY-MM-DD>/<videoId>.mp4
 * 新布局优先，避免重复下载；旧文件继续被识别为"已归档"。
 */
export function findArchived(downloadsDir, keyword, videoId) {
  if (!downloadsDir || !videoId) return null;
  // 纵深防御：videoId 只允许安全字符，杜绝拼路径时的目录穿越（正常数据源是纯数字）。
  const safeId = String(videoId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(safeId)) return null;
  if (!existsSync(downloadsDir)) return null;
  let entries = [];
  try {
    entries = readdirSync(downloadsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !DATE_DIR.test(entry.name)) continue;
    const file = join(downloadsDir, entry.name, `${videoId}.mp4`);
    if (existsSync(file)) return file;
  }
  const root = join(downloadsDir, keywordSlug(keyword));
  if (!existsSync(root)) return null;
  let legacy = [];
  try {
    legacy = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of legacy) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, `${videoId}.mp4`);
    if (existsSync(file)) return file;
  }
  return null;
}

function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * 在页面上下文里 fetch 媒体地址（浏览器网络栈，自动带 cookie 与代理）。
 * 优先建立流式 reader（页面侧只保留当前块），不支持时回退整段缓冲到 window.__dlBuf。
 * 返回 {status,bytes,type,contentLength,supportsStreaming}。
 */
async function fetchIntoPage(page, url, timeoutMs) {
  return page.evaluate(
    async ({ target, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(target, {
          credentials: 'include',
          referer: 'https://www.tiktok.com/',
          signal: controller.signal,
        });
        const type = res.headers.get('content-type') || null;
        const contentLength = Number(res.headers.get('content-length') || 0) || null;
        if (res.status !== 200 || !res.body || typeof res.body.getReader !== 'function') {
          const buf = new Uint8Array(await res.arrayBuffer());
          window.__dlBuf = buf;
          window.__dlState = null;
          return { status: res.status, bytes: buf.length, type, contentLength: buf.length, supportsStreaming: false };
        }
        const reader = res.body.getReader();
        const first = await reader.read();
        window.__dlState = { reader, controller, chunk: first.done ? null : first.value || null, offset: 0, done: !!first.done };
        window.__dlBuf = null;
        return {
          status: res.status,
          bytes: contentLength || 0,
          type,
          contentLength,
          supportsStreaming: true,
        };
      } catch (error) {
        window.__dlBuf = null;
        window.__dlState = null;
        return { status: 0, bytes: 0, type: null, contentLength: null, supportsStreaming: false, error: String(error?.message || error) };
      } finally {
        clearTimeout(timer);
      }
    },
    { target: url, timeout: timeoutMs },
  );
}

/** 从流式 reader 顺序取一块（页面侧只保留当前块）。 */
async function readStreamChunk(page, maxBytes) {
  return page.evaluate(
    async ({ limit }) => {
      const state = window.__dlState;
      if (!state) return null;
      if (state.done && !state.chunk) return { done: true };
      const parts = [];
      let total = 0;
      try {
        while (total < limit) {
          if (state.chunk && state.offset < state.chunk.length) {
            const take = Math.min(limit - total, state.chunk.length - state.offset);
            parts.push(state.chunk.subarray(state.offset, state.offset + take));
            total += take;
            state.offset += take;
            if (state.offset >= state.chunk.length) {
              state.chunk = null;
              state.offset = 0;
            }
            continue;
          }
          if (state.done) break;
          const next = await state.reader.read();
          if (next.done) {
            state.done = true;
            break;
          }
          state.chunk = next.value || new Uint8Array(0);
          state.offset = 0;
        }
      } catch (error) {
        state.error = String(error?.message || error);
      }
      if (state.error) return { done: false, b64: '', error: state.error };
      if (!total) {
        const done = !!state.done;
        if (done) window.__dlState = null;
        return { done, b64: '' };
      }
      const merged = new Uint8Array(total);
      let cursor = 0;
      for (const part of parts) {
        merged.set(part, cursor);
        cursor += part.length;
      }
      let text = '';
      for (let i = 0; i < merged.length; i += 1) text += String.fromCharCode(merged[i]);
      return { done: false, b64: btoa(text) };
    },
    { limit: maxBytes },
  );
}

/** 从 window.__dlBuf 分块取 base64（避免单条 CDP 消息过大）。 */
async function readPageChunk(page, offset, length) {
  return page.evaluate(
    ({ off, len }) => {
      const buf = window.__dlBuf;
      if (!buf) return null;
      const slice = buf.subarray(off, off + len);
      let text = '';
      for (let i = 0; i < slice.length; i += 1) text += String.fromCharCode(slice[i]);
      return btoa(text);
    },
    { off: offset, len: length },
  );
}

/**
 * 下载一个媒体地址到文件。
 *
 * 主通道：在 tiktok.com 页面上下文内 fetch —— 实测只有浏览器网络栈（带 tt_chain_token 等 cookie）
 * 才能拿到 CDN 的 200，Node 侧 request / curl 都会被 Akamai 403 或连接重置。
 * 兜底：page.request.get（某些节点/域名下可用）。
 *
 * @returns {Promise<{ok:boolean, bytes:number, contentType:string|null, code:string|null, message:string|null}>}
 */
export async function fetchVideoToFile(page, url, destFile, { referer, timeoutMs = 120_000 } = {}) {
  const tmp = `${destFile}.${process.pid}.part`;
  try {
    return await fetchVideoToFileInner(page, url, destFile, tmp, { referer, timeoutMs });
  } finally {
    // 防半成品泄漏：任何失败路径（写循环中断、体积不足、兜底失败）都要清掉 .part。
    if (existsSync(tmp)) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // 尽力清理，忽略错误
      }
    }
  }
}

async function fetchVideoToFileInner(page, url, destFile, tmp, { referer, timeoutMs = 120_000 } = {}) {
  if (!url) return { ok: false, bytes: 0, contentType: null, code: 'NO_MEDIA_URL', message: '没有可用的媒体地址。' };

  mkdirSync(join(destFile, '..'), { recursive: true });

  // 页面内 fetch 必须发生在 tiktok.com 源上，否则 CORS 不允许读取响应体。
  try {
    const current = page.url();
    if (!/^https:\/\/([a-z0-9-]+\.)?tiktok\.com\//i.test(current)) {
      await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
  } catch {
    // 导航失败不致命，下面 fetch 会给出真实错误。
  }

  let meta = null;
  try {
    meta = await fetchIntoPage(page, url, timeoutMs);
  } catch (error) {
    meta = { status: 0, bytes: 0, type: null, error: error?.message || String(error) };
  }

  // M5 优化：优先使用流式 reader 分块下载，页面侧只保留当前块，避免整段进内存与 base64 双重开销。
  // 老通道（__dlBuf 整段缓冲）保留为兜底：旧浏览器 / 特殊响应（不可流式）仍可用。
  // 注意：content-length 可能为 0/缺失（bytes=0），此时仍需走流式路径（不能因 bytes<MIN_VIDEO_BYTES 而跳过）。
  if (meta && meta.status === 200 && meta.supportsStreaming) {
    let fd = null;
    let streamOpen = false;
    let streamError = null;
    try {
      fd = openSync(tmp, 'w');
      let written = 0;
      for (;;) {
        const chunk = await readStreamChunk(page, STREAM_CHUNK_BYTES);
        if (!chunk) throw new Error('流式读取失败：页面侧未初始化或已释放。');
        if (chunk.done) break;
        if (chunk.error) throw new Error(chunk.error);
        const buf = Buffer.from(chunk.b64, 'base64');
        writeSync(fd, buf);
        written += buf.length;
        if (meta.contentLength && written >= meta.contentLength) break;
      }
      closeSync(fd);
      fd = null;
      streamOpen = true;
      if (written < MIN_VIDEO_BYTES) {
        return {
          ok: false,
          bytes: written,
          contentType: meta.type,
          code: 'DOWNLOAD_TOO_SMALL',
          message: `下载内容只有 ${written} 字节，疑似错误页。`,
        };
      }
      renameSync(tmp, destFile);
      return { ok: true, bytes: written, contentType: meta.type, code: null, message: null };
    } catch (error) {
      streamError = error;
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
      // 流式失败时回退老通道，不直接报错。
    } finally {
      if (!streamOpen) {
        try {
          await page.evaluate(() => {
            if (window.__dlState) {
              try {
                window.__dlState.controller?.abort?.();
              } catch {
                // ignore
              }
              window.__dlState = null;
            }
          });
        } catch {
          // ignore
        }
      }
    }
    // 流式失败且老通道也不可用时，直接报错（避免继续走 page.request.get 浪费一次请求）。
    if (streamError && (!meta.bytes || meta.bytes < MIN_VIDEO_BYTES)) {
      return {
        ok: false,
        bytes: 0,
        contentType: meta.type,
        code: 'DOWNLOAD_FAILED',
        message: sanitizeDownloadMessage(streamError?.message || String(streamError)),
      };
    }
  }

  if (meta && meta.status === 200 && meta.bytes >= MIN_VIDEO_BYTES) {
    let fd = null;
    try {
      fd = openSync(tmp, 'w');
      let written = 0;
      for (let off = 0; off < meta.bytes; off += CHUNK_BYTES) {
        const len = Math.min(CHUNK_BYTES, meta.bytes - off);
        const b64 = await readPageChunk(page, off, len);
        if (b64 == null) throw new Error('页面缓冲已释放，分块读取失败。');
        const chunk = Buffer.from(b64, 'base64');
        writeSync(fd, chunk);
        written += chunk.length;
      }
      closeSync(fd);
      fd = null;
      if (written < MIN_VIDEO_BYTES) {
        return {
          ok: false,
          bytes: written,
          contentType: meta.type,
          code: 'DOWNLOAD_TOO_SMALL',
          message: `下载内容只有 ${written} 字节，疑似错误页。`,
        };
      }
      renameSync(tmp, destFile);
      return { ok: true, bytes: written, contentType: meta.type, code: null, message: null };
    } catch (error) {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
      return {
        ok: false,
        bytes: 0,
        contentType: meta.type,
        code: 'DOWNLOAD_FAILED',
        message: sanitizeDownloadMessage(error?.message || String(error)),
      };
    } finally {
      try {
        await page.evaluate(() => {
          window.__dlBuf = null;
        });
      } catch {
        // ignore
      }
    }
  }

  if (meta && meta.status && meta.status !== 200) {
    return {
      ok: false,
      bytes: meta.bytes || 0,
      contentType: meta.type,
      code: 'DOWNLOAD_HTTP_' + meta.status,
      message: `媒体地址返回 HTTP ${meta.status}（签名可能已过期）。`,
    };
  }

  // 兜底：Node 侧请求。
  let response;
  try {
    response = await page.request.get(url, {
      headers: { referer: referer || 'https://www.tiktok.com/', accept: '*/*' },
      timeout: timeoutMs,
      failOnStatusCode: false,
    });
  } catch (error) {
    return {
      ok: false,
      bytes: 0,
      contentType: null,
      code: 'DOWNLOAD_FAILED',
      message: sanitizeDownloadMessage(meta?.error || error?.message || String(error)),
    };
  }

  const status = response.status();
  if (status !== 200 && status !== 206) {
    return {
      ok: false,
      bytes: 0,
      contentType: response.headers()['content-type'] || null,
      code: 'DOWNLOAD_HTTP_' + status,
      message: `媒体地址返回 HTTP ${status}（签名可能已过期）。`,
    };
  }

  let buffer;
  try {
    buffer = await response.body();
  } catch (error) {
    return {
      ok: false,
      bytes: 0,
      contentType: null,
      code: 'DOWNLOAD_FAILED',
      message: sanitizeDownloadMessage(error?.message || String(error)),
    };
  }

  if (!buffer || buffer.length < MIN_VIDEO_BYTES) {
    return {
      ok: false,
      bytes: buffer?.length || 0,
      contentType: response.headers()['content-type'] || null,
      code: 'DOWNLOAD_TOO_SMALL',
      message: `下载内容只有 ${buffer?.length || 0} 字节，疑似错误页。`,
    };
  }

  writeFileSync(tmp, buffer);
  renameSync(tmp, destFile);

  return {
    ok: true,
    bytes: buffer.length,
    contentType: response.headers()['content-type'] || null,
    code: null,
    message: null,
  };
}

/** sidecar JSON 里保留的字段（避免把巨大的原始 JSON 全写进去）。 */
function sidecarPayload(candidate, extra) {
  return {
    videoId: candidate.videoId || null,
    url: candidate.url || null,
    query: candidate.query || null,
    desc: candidate.desc || null,
    createTime: candidate.createTime ?? null,
    duration: candidate.duration ?? null,
    author: candidate.author || null,
    stats: candidate.stats || null,
    music: candidate.music || null,
    challenges: candidate.challenges || [],
    video: candidate.video
      ? {
          width: candidate.video.width ?? null,
          height: candidate.video.height ?? null,
          ratio: candidate.video.ratio ?? null,
          cover: candidate.video.cover || null,
          dynamicCover: candidate.video.dynamicCover || null,
        }
      : null,
    archivedAt: new Date().toISOString(),
    ...extra,
  };
}

/**
 * 把外部下载器（如 AIX）得到的文件复制进现有归档结构，并写同名 sidecar。
 * 不移动用户默认下载目录中的文件；调用方只应清理自己创建的 staging 文件。
 */
export function archiveExistingFile({
  candidate,
  downloadsDir,
  keyword,
  sourceFile,
  source = 'external',
  watermark = 'unknown',
  mediaDuration = null,
  logger = null,
} = {}) {
  const videoId = String(candidate?.videoId || '');
  if (!videoId) return { ok: false, code: 'NO_VIDEO_ID', message: '候选缺少 videoId。' };
  if (!sourceFile || !existsSync(sourceFile)) return { ok: false, code: 'SOURCE_MISSING', message: '外部下载文件不存在。' };
  const bytes = statSync(sourceFile).size;
  if (bytes < MIN_VIDEO_BYTES) return { ok: false, code: 'SOURCE_TOO_SMALL', message: `外部文件只有 ${bytes} 字节。` };

  const existing = findArchived(downloadsDir, keyword, videoId);
  if (existing && fileSize(existing) >= MIN_VIDEO_BYTES) {
    return { ok: true, skipped: true, file: existing, bytes: fileSize(existing), source, code: null, message: null };
  }

  const dir = archiveDir(downloadsDir, keyword);
  mkdirSync(dir, { recursive: true });
  const mp4File = join(dir, `${videoId}.mp4`);
  const jsonFile = join(dir, `${videoId}.json`);
  const temp = `${mp4File}.${process.pid}.import`;
  try {
    copyFileSync(sourceFile, temp);
    const copiedBytes = statSync(temp).size;
    if (copiedBytes !== bytes) throw new Error(`复制校验失败（${bytes} != ${copiedBytes}）`);
    renameSync(temp, mp4File);
    const payload = sidecarPayload(candidate, {
      file: `${videoId}.mp4`,
      bytes,
      source,
      channel: source,
      watermark,
      mediaDuration,
      importedFrom: sourceFile,
      contentType: 'video/mp4',
    });
    writeFileSync(jsonFile, JSON.stringify(payload, null, 2), 'utf8');
    logger?.info?.(`已导入外部下载 ${videoId} (${source}, ${bytes} 字节)`);
    return { ok: true, skipped: false, file: mp4File, bytes, source, watermark, mediaDuration, code: null, message: null };
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 清理临时文件失败不改变导入结论。
    }
    return { ok: false, code: 'IMPORT_FAILED', message: sanitizeDownloadMessage(error?.message || String(error)) };
  }
}

/**
 * 归档一条候选：下载 mp4 + 写同名 json。
 * @param {object} options
 * @param {import('playwright-core').Page} options.page
 * @param {object} options.candidate 归一化后的候选（含 video.downloadAddr / video.playAddr）
 * @param {string} options.downloadsDir
 * @param {string} options.keyword
 * @param {boolean} [options.preferNoWatermark] 默认 true：优先 playAddr（无水印）；false 时优先 downloadAddr（带水印）
 * @param {(url:string)=>Promise<object|null>} [options.refresh] 地址失效时重新提取候选的回调
 */
export async function archiveCandidate({ page, candidate, downloadsDir, keyword, preferNoWatermark = true, refresh = null, logger = null }) {
  // 纵深防御：videoId 只允许安全字符，杜绝拼路径时的目录穿越（正常数据源是纯数字）。
  const videoId = candidate?.videoId == null ? '' : String(candidate.videoId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(videoId)) {
    return { ok: false, code: 'BAD_VIDEO_ID', message: 'videoId 含非法字符，拒绝归档。' };
  }
  if (!videoId) {
    return { ok: false, code: 'NO_VIDEO_ID', message: '候选缺少 videoId。' };
  }

  const existing = findArchived(downloadsDir, keyword, videoId);
  if (existing && fileSize(existing) >= MIN_VIDEO_BYTES) {
    return { ok: true, skipped: true, file: existing, bytes: fileSize(existing), source: null, watermark: null, code: null, message: null };
  }

  const dir = archiveDir(downloadsDir, keyword);
  mkdirSync(dir, { recursive: true });
  const mp4File = join(dir, `${videoId}.mp4`);
  const jsonFile = join(dir, `${videoId}.json`);

  const media = candidate?.video || {};
  const order = preferNoWatermark
    ? ['playAddrBest', 'playAddr', 'downloadAddr']
    : ['downloadAddr', 'playAddrBest', 'playAddr'];
  const sources = order
    .map((key) => ({ key, url: media[key] }))
    .filter((entry) => typeof entry.url === 'string' && entry.url.length > 0);

  if (sources.length === 0) {
    return { ok: false, code: 'NO_MEDIA_URL', message: '候选没有 downloadAddr / playAddr，无法下载。' };
  }

  let last = null;
  for (const source of sources) {
    const result = await fetchVideoToFile(page, source.url, mp4File, { referer: candidate.url || undefined });
    if (result.ok) {
      const watermark = watermarkOfSource(source.key);
      const payload = sidecarPayload(candidate, {
        file: `${videoId}.mp4`,
        bytes: result.bytes,
        source: source.key,
        contentType: result.contentType,
        watermark,
        preferNoWatermark,
      });
      writeFileSync(jsonFile, JSON.stringify(payload, null, 2), 'utf8');
      logger?.info?.(`已归档 ${videoId} (${source.key}, ${result.bytes} 字节, 水印=${watermark})`);
      return { ok: true, skipped: false, file: mp4File, bytes: result.bytes, source: source.key, watermark, code: null, message: null };
    }
    last = result;
    logger?.warn?.(`下载失败 ${videoId} via ${source.key}: ${result.code} ${sanitizeDownloadMessage(result.message)}`);
  }

  // 所有地址都失败：若给了 refresh 回调，重新提取一次再试（签名过期场景）。
  if (refresh) {
    const fresh = await refresh(videoId);
    if (fresh?.video) {
      for (const key of order) {
        const url = fresh.video[key];
        if (typeof url !== 'string' || !url) continue;
        const result = await fetchVideoToFile(page, url, mp4File, { referer: fresh.url || candidate.url || undefined });
        if (result.ok) {
          const source = `${key}(refreshed)`;
          const watermark = watermarkOfSource(source);
          const payload = sidecarPayload({ ...candidate, ...fresh }, {
            file: `${videoId}.mp4`,
            bytes: result.bytes,
            source,
            contentType: result.contentType,
            watermark,
            preferNoWatermark,
          });
          writeFileSync(jsonFile, JSON.stringify(payload, null, 2), 'utf8');
          return { ok: true, skipped: false, file: mp4File, bytes: result.bytes, source, watermark, code: null, message: null };
        }
        last = result;
      }
    }
  }

  return {
    ok: false,
    code: last?.code || 'DOWNLOAD_FAILED',
    message: sanitizeDownloadMessage(last?.message || '下载失败。'),
  };
}
