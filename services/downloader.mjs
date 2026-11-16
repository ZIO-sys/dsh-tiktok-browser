import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { archiveCandidate, archiveExistingFile, fetchVideoToFile } from '../collect/archive.mjs';
import { findFfmpeg } from '../collect/frames.mjs';
import { discoverAixExtension, downloadWithAix } from './aix-adapter.mjs';

const MIN_VIDEO_BYTES = 10 * 1024;
const VALID_CHANNELS = new Set(['page', 'aix', 'auto']);

export function resolveDownloadChannel(config = {}, env = process.env, override = null) {
  const value = String(override || config?.download?.channel || env.TIKTOK_DOWNLOAD_CHANNEL || 'page').toLowerCase();
  return VALID_CHANNELS.has(value) ? value : 'page';
}

export function isLikelyMp4(file) {
  if (!file || !existsSync(file)) return false;
  try {
    if (statSync(file).size < MIN_VIDEO_BYTES) return false;
    const fd = openSync(file, 'r');
    try {
      const header = Buffer.alloc(12);
      const read = readSync(fd, header, 0, header.length, 0);
      if (read < 8) return false;
      const brand = header.subarray(4, 8).toString('ascii');
      return brand === 'ftyp' || brand === 'moov' || brand === 'mdat' || brand === 'wide';
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function probeMediaDuration(file) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg || !file || !existsSync(file)) return null;
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function durationMatchesCandidate(duration, expected) {
  if (duration == null || duration === '' || expected == null || expected === '') return true;
  const actual = Number(duration);
  const target = Number(expected);
  if (!Number.isFinite(actual) || !Number.isFinite(target) || target <= 0) return true;
  return Math.abs(actual - target) <= Math.max(5, target * 0.15);
}

async function ensureVideoPlaying(page) {
  if (!page || page.isClosed?.()) return false;
  try {
    return await page.evaluate(async () => {
      const element = document.querySelector('video');
      if (!element) return false;
      element.muted = true;
      try { await element.play(); } catch {}
      return !element.paused;
    });
  } catch {
    return false;
  }
}

export function createDownloadManager({ config = {}, paths, env = process.env, getContext, logger = null } = {}) {
  let extensionCache = null;

  function extension() {
    extensionCache ??= discoverAixExtension({ profileDir: paths?.browserProfileDir });
    return extensionCache;
  }

  function status() {
    const found = extension();
    const channel = resolveDownloadChannel(config, env);
    return {
      channel,
      aix: found.ok
        ? {
            ok: true,
            id: found.id,
            version: found.version,
            name: found.name,
            hasTikTokContentScript: found.hasTikTokContentScript,
          }
        : { ok: false, code: found.code, message: found.message },
    };
  }

  async function pageDownload({ page, candidate, downloadsDir, keyword, preferNoWatermark, refresh }) {
    const archived = await archiveCandidate({
      page,
      candidate,
      downloadsDir,
      keyword,
      preferNoWatermark,
      refresh,
      logger,
    });
    return { ...archived, channel: 'page' };
  }

  async function aixDownload({ page, candidate, downloadsDir, keyword, signal }) {
    const found = extension();
    if (!found.ok) {
      return { ok: false, channel: 'aix', code: found.code, message: found.message };
    }
    const context = getContext?.() || page?.context?.();
    if (!context) return { ok: false, channel: 'aix', code: 'AIX_CONTEXT_MISSING', message: '浏览器上下文未就绪。' };
    if (!page || page.isClosed?.()) return { ok: false, channel: 'aix', code: 'AIX_VIDEO_PAGE_MISSING', message: '没有可用的 TikTok 作品页。' };

    try {
      const target = String(candidate?.url || '');
      if (target && page.url() !== target) {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      await ensureVideoPlaying(page);
      await new Promise((resolve) => setTimeout(resolve, 4_000));

      const stagingRoot = join(paths.stateDir, 'aix-staging');
      const stagingDir = join(stagingRoot, `${candidate.videoId}-${Date.now()}`);
      mkdirSync(stagingDir, { recursive: true });

      const result = await downloadWithAix({
        context,
        tiktokPage: page,
        extension: found,
        videoId: candidate.videoId,
        desc: candidate.desc,
        url: candidate.url,
        mediaUrls: [candidate.video?.downloadAddr, candidate.video?.playAddr].filter(Boolean),
        stagingDir,
        signal,
        timeoutMs: 60_000,
      });
      if (result.extensionPage && !result.extensionPage.isClosed?.()) {
        await result.extensionPage.close().catch(() => {});
      }
      if (!result.ok) {
        if (result.row?.url && config?.download?.aix?.allowAixUrlPageFetch === true) {
          const targetFile = join(stagingDir, `${candidate.videoId}.mp4`);
          const fetched = await fetchVideoToFile(page, result.row.url, targetFile, {
            referer: candidate.url,
            timeoutMs: 120_000,
          });
          const mediaDuration = fetched.ok ? probeMediaDuration(targetFile) : null;
          if (fetched.ok && isLikelyMp4(targetFile) && durationMatchesCandidate(mediaDuration, candidate.duration)) {
            const imported = archiveExistingFile({
              candidate,
              downloadsDir,
              keyword,
              sourceFile: targetFile,
              source: 'aix-url',
              watermark: 'none',
              mediaDuration,
              logger,
            });
            if (imported.ok) {
              try {
                rmSync(targetFile, { force: true });
              } catch {
                // staging 清理失败不影响归档结果。
              }
            }
            return {
              ...imported,
              channel: 'aix',
              extensionId: found.id,
              extensionVersion: found.version,
              aixMode: 'url-page-fetch',
              nativeAixError: { code: result.code, message: result.message },
              mediaDuration,
              watermark: 'none',
            };
          }
          return {
            ok: false,
            channel: 'aix',
            code: fetched.ok ? 'AIX_DURATION_MISMATCH' : fetched.code || 'AIX_URL_FETCH_FAILED',
            message: fetched.ok
              ? `AIX 视频时长 ${mediaDuration ?? '未知'} 秒与作品 ${candidate.duration ?? '未知'} 秒不匹配，未归档。`
              : `AIX 原生下载失败，URL 页面抓取也未成功：${fetched.message || '文件无效'}`,
            nativeAixError: { code: result.code, message: result.message },
            manualRequired: true,
          };
        }
        return {
          ok: false,
          channel: 'aix',
          code: result.code || 'AIX_DOWNLOAD_FAILED',
          message: result.message || 'AIX 自动下载失败，请在 Edge 中人工接管。',
          manualRequired: true,
          extensionId: found.id,
          extensionVersion: found.version,
        };
      }
      if (!isLikelyMp4(result.file)) {
        return {
          ok: false,
          channel: 'aix',
          code: 'AIX_FILE_INVALID',
          message: 'AIX 下载文件不是有效 MP4 或小于 10KB。',
          file: result.file,
          manualRequired: true,
        };
      }
      const mediaDuration = probeMediaDuration(result.file);
      if (!durationMatchesCandidate(mediaDuration, candidate.duration)) {
        return {
          ok: false,
          channel: 'aix',
          code: 'AIX_DURATION_MISMATCH',
          message: `AIX 文件时长 ${mediaDuration ?? '未知'} 秒与作品 ${candidate.duration ?? '未知'} 秒不匹配，已拒绝归档。`,
          file: result.file,
          manualRequired: true,
        };
      }

      const imported = archiveExistingFile({
        candidate,
        downloadsDir,
        keyword,
        sourceFile: result.file,
        source: 'aix',
        watermark: 'none',
        mediaDuration,
        logger,
      });
      if (imported.ok && result.file.startsWith(stagingRoot)) {
        try {
          rmSync(result.file, { force: true });
        } catch {
          // staging 清理失败不影响归档结果。
        }
      }
      return {
        ...imported,
        channel: 'aix',
        extensionId: found.id,
        extensionVersion: found.version,
        aixMode: 'background-download',
        mediaDuration,
        watermark: 'unknown',
      };
    } catch (error) {
      return {
        ok: false,
        channel: 'aix',
        code: 'AIX_AUTOMATION_FAILED',
        message: `AIX 自动下载失败：${error?.message || error}`,
        manualRequired: true,
      };
    }
  }

  async function download({ page, candidate, downloadsDir, keyword, preferNoWatermark = true, refresh = null, signal, channel = null }) {
    const selected = resolveDownloadChannel(config, env, channel);
    if (selected === 'page') {
      return pageDownload({ page, candidate, downloadsDir, keyword, preferNoWatermark, refresh });
    }
    const aix = await aixDownload({ page, candidate, downloadsDir, keyword, signal });
    if (aix.ok || selected === 'aix') return aix;

    if (config?.download?.aix?.allowPageFallback === true && config?.download?.aix?.manualFallback === false) {
      const fallback = await pageDownload({ page, candidate, downloadsDir, keyword, preferNoWatermark, refresh });
      return { ...fallback, fallbackFrom: 'aix', aixError: { code: aix.code, message: aix.message } };
    }
    return aix;
  }

  return { status, download };
}
