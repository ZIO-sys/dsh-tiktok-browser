import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const AIX_NAME = /AIX\s*Downloader|智能下载器/i;

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function localizeName(manifest, extensionDir) {
  const raw = String(manifest?.name || '');
  const match = /^__MSG_([^_]+(?:_[^_]+)*)__$/.exec(raw);
  if (!match) return raw;
  const key = match[1];
  const locales = [manifest.default_locale, 'en', 'zh_CN', 'zh'].filter(Boolean);
  for (const locale of locales) {
    const messages = readJson(join(extensionDir, '_locales', locale, 'messages.json'), null);
    if (messages?.[key]?.message) return String(messages[key].message);
  }
  return raw;
}

function compareVersion(a, b) {
  const left = String(a).split('.').map((part) => Number(part) || 0);
  const right = String(b).split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (right[index] || 0) - (left[index] || 0);
  }
  return 0;
}

export function discoverAixExtension({ profileDir } = {}) {
  const extensionsDir = join(String(profileDir || ''), 'Default', 'Extensions');
  if (!profileDir || !existsSync(extensionsDir)) {
    return { ok: false, code: 'AIX_PROFILE_MISSING', message: '找不到 Edge 插件 profile。' };
  }
  let ids;
  try {
    ids = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    return { ok: false, code: 'AIX_SCAN_FAILED', message: `无法读取扩展目录：${error.message}` };
  }
  for (const id of ids) {
    const versionsDir = join(extensionsDir, id);
    let versions;
    try {
      versions = readdirSync(versionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compareVersion);
    } catch {
      continue;
    }
    for (const version of versions) {
      const extensionDir = join(versionsDir, version);
      const manifest = readJson(join(extensionDir, 'manifest.json'), null);
      if (!manifest) continue;
      const name = localizeName(manifest, extensionDir);
      if (!AIX_NAME.test(name)) continue;
      return {
        ok: true,
        id,
        version: manifest.version || version,
        extensionFolder: version,
        name,
        path: extensionDir,
        profileDir,
        manifestVersion: manifest.manifest_version,
        popupUrl: manifest.action?.default_popup ? `chrome-extension://${id}/${manifest.action.default_popup}` : `chrome-extension://${id}/popup/popup.html`,
        hasTikTokContentScript: Array.isArray(manifest.content_scripts)
          && manifest.content_scripts.some((script) => (script.matches || []).some((pattern) => pattern.includes('tiktok.com'))),
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
      };
    }
  }
  return { ok: false, code: 'AIX_NOT_FOUND', message: '插件专用 Edge profile 中未找到 AIX 智能下载器。' };
}

function normalizeRows(value) {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === 'object') : [];
}

export async function queryAixRows({ extensionPage, tiktokPage, videoId = '', timeoutMs = 15_000, signal } = {}) {
  if (!extensionPage || extensionPage.isClosed?.()) return { ok: false, code: 'AIX_PAGE_MISSING', message: 'AIX 扩展页未打开。' };
  const tiktokUrl = typeof tiktokPage?.url === 'function' ? tiktokPage.url() : '';
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < Math.max(1_000, timeoutMs)) {
    signal?.throwIfAborted?.();
    last = await extensionPage.evaluate(async ({ tiktokUrl: wantedUrl, videoId: wantedId }) => {
      if (!globalThis.chrome?.tabs?.sendMessage) {
        return { ok: false, code: 'AIX_EXTENSION_API_MISSING', message: '扩展页没有 chrome.tabs API。' };
      }
      const tabs = await chrome.tabs.query({});
      const tiktokTabs = tabs.filter((tab) => /^https:\/\/www\.tiktok\.com\//i.test(tab.url || ''));
      const tab = tiktokTabs.find((item) => item.url === wantedUrl)
        || tiktokTabs.find((item) => wantedId && String(item.url || '').includes(wantedId))
        || tiktokTabs[0];
      if (!tab) return { ok: false, code: 'TIKTOK_TAB_MISSING', message: '没有可查询的 TikTok 页面。' };
      const ask = () => new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { tip: 'queryVideo' }, (rows) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, code: 'AIX_CONTENT_UNAVAILABLE', message: chrome.runtime.lastError.message, tabId: tab.id });
            return;
          }
          resolve({ ok: true, tabId: tab.id, tabUrl: tab.url || '', rows: Array.isArray(rows) ? rows : [] });
        });
      });
      let result = await ask();
      if (result.ok && result.rows.length) return result;
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ tip: 'injectcontentshell', id: tab.id }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      result = await ask();
      return result;
    }, { tiktokUrl, videoId });
    if (last?.ok && last.rows.length) return { ...last, rows: normalizeRows(last.rows) };
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return {
    ok: false,
    code: last?.code || 'AIX_NO_MEDIA_ROWS',
    message: last?.message || 'AIX 尚未捕获到视频媒体行。',
    tabId: last?.tabId || null,
    tabUrl: last?.tabUrl || tiktokUrl,
    rows: [],
  };
}

export function mediaUrlKey(value) {
  try {
    const url = new URL(String(value || ''));
    return `${url.hostname}${url.pathname}`;
  } catch {
    return '';
  }
}

export function chooseAixRow(rows, { videoId = '', desc = '', url = '', mediaUrls = [], strictMedia = false } = {}) {
  const list = normalizeRows(rows);
  if (!list.length) return null;
  const id = String(videoId || '');
  const text = String(desc || '').slice(0, 80);
  const candidates = list.filter((row) => {
    const mediaUrl = String(row.url || '');
    if (!mediaUrl || /\.(?:jpg|jpeg|png|webp|gif|mp3|m4a)(?:$|\?)/i.test(mediaUrl)) return false;
    return !/\/webapp-desktop\/playback1\.mp4(?:$|\?)/i.test(mediaUrl);
  });
  const pool = candidates.length ? candidates : list;
  const referenceKeys = (Array.isArray(mediaUrls) ? mediaUrls : [mediaUrls]).map(mediaUrlKey).filter(Boolean);
  if (referenceKeys.length) {
    const byMedia = pool.find((row) => referenceKeys.includes(mediaUrlKey(row.url)));
    if (byMedia) return byMedia;
    if (strictMedia) return null;
  }
  const exact = pool.find((row) => [row.videoId, row.awemeId, row.id].some((value) => value && String(value) === id));
  if (exact) return exact;
  const byUrl = pool.find((row) => id && [row.originalUrl, row.fromUrl].some((value) => String(value || '').includes(id)));
  if (byUrl) return byUrl;
  if (url) {
    const pageUrl = pool.find((row) => [row.originalUrl, row.fromUrl, row.pageUrl].some((value) => String(value || '') === url));
    if (pageUrl) return pageUrl;
  }
  if (text) {
    const byTitle = pool.find((row) => String(row.title || row.desc || '').includes(text));
    if (byTitle) return byTitle;
  }
  const bytesOf = (row) => Number(row.bytSize) || Number(row.bytes) || 0;
  return [...pool].sort((left, right) => bytesOf(right) - bytesOf(left))[0];
}

/**
 * @deprecated 实验接口。实测移动端 feed 可能返回与请求 videoId 不一致的推荐作品，
 * 不得用于生产下载路径；生产只使用 AIX content script 的 queryVideo 结果。
 */
export async function fetchAixTikTokRow({ extensionPage, videoId, signal } = {}) {
  if (!extensionPage || extensionPage.isClosed?.()) return { ok: false, code: 'AIX_PAGE_MISSING', message: 'AIX 扩展页未打开。' };
  if (!/^\d{8,}$/.test(String(videoId || ''))) return { ok: false, code: 'AIX_VIDEO_ID_INVALID', message: 'videoId 无效。' };
  signal?.throwIfAborted?.();
  return extensionPage.evaluate(async ({ id }) => {
    const random = (chars, length) => {
      let text = '';
      for (let index = 0; index < length; index += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
      return text;
    };
    const seconds = Math.round(Date.now() / 1_000);
    const params = {
      aweme_id: id,
      version_name: '26.1.3',
      version_code: '260103',
      build_number: '26.1.3',
      manifest_version_code: '260103',
      update_version_code: '260103',
      openudid: random('0123456789abcdef', 16),
      uuid: random('0123456789', 16),
      _rticket: 1_000 * seconds,
      ts: seconds,
      device_brand: 'Google',
      device_type: 'Pixel 4',
      device_platform: 'android',
      resolution: '1080*1920',
      dpi: '420',
      os_version: '10',
      os_api: '29',
      carrier_region: 'US',
      sys_region: 'US',
      region: 'US',
      app_name: 'trill',
      app_language: 'en',
      language: 'en',
      timezone_name: 'America/New_York',
      timezone_offset: '-14400',
      channel: 'googleplay',
      ac: 'wifi',
      mcc_mnc: '310260',
      is_my_cn: '0',
      aid: '1180',
      ssmix: 'a',
      as: 'a1qwert123',
      cp: 'cbfhckdckkde1',
    };
    const query = Object.entries(params).map(([key, value], index) => `${index ? '&' : '?'}${key}=${encodeURIComponent(value)}`).join('');
    try {
      const response = await fetch(`https://api-h2.tiktokv.com/aweme/v1/feed/${query}`, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok) return { ok: false, code: 'AIX_API_HTTP', message: `AIX 媒体接口返回 ${response.status}。` };
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b && typeof DecompressionStream === 'function') {
        text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      } else {
        text = new TextDecoder().decode(bytes);
      }
      const payload = JSON.parse(text);
      const item = payload?.aweme_list?.[0];
      const mediaUrl = item?.video?.play_addr?.url_list?.[0] || item?.video?.download_addr?.url_list?.[0];
      if (!mediaUrl) return { ok: false, code: 'AIX_API_NO_MEDIA', message: 'AIX 媒体接口没有返回视频地址。' };
      const title = String(item.desc || '').slice(0, 60);
      return {
        ok: true,
        row: {
          type: 'video',
          thumb: item.video?.cover?.url_list?.[0] || '',
          url: mediaUrl,
          bytSize: 0,
          size: 0,
          videoType: 'mp4',
          isSelect: false,
          fileName: title,
          superSpecialFileName: title,
          title,
          poster: item.video?.cover?.url_list?.[0] || '',
          desc: item.desc || '',
          videoId: String(item.aweme_id || id),
          originalUrl: `https://www.tiktok.com/@${item.author?.unique_id || '_'}/video/${id}`,
        },
      };
    } catch (error) {
      return { ok: false, code: 'AIX_API_FAILED', message: `AIX 媒体接口请求失败：${error.message}` };
    }
  }, { id: String(videoId) });
}

export async function injectAixRow({ extensionPage, tiktokPage, row, videoId = '' } = {}) {
  if (!extensionPage || !row?.url) return { ok: false, code: 'AIX_ROW_INVALID', message: '缺少可注入的 AIX 媒体行。' };
  const tiktokUrl = typeof tiktokPage?.url === 'function' ? tiktokPage.url() : '';
  return extensionPage.evaluate(async ({ row: value, tiktokUrl: wantedUrl, videoId: wantedId }) => {
    const tabs = await chrome.tabs.query({});
    const tiktokTabs = tabs.filter((tab) => /^https:\/\/www\.tiktok\.com\//i.test(tab.url || ''));
    const tab = tiktokTabs.find((item) => item.url === wantedUrl)
      || tiktokTabs.find((item) => wantedId && String(item.url || '').includes(wantedId))
      || tiktokTabs[0];
    if (!tab) return { ok: false, code: 'TIKTOK_TAB_MISSING', message: '没有可注入的 TikTok 页面。' };
    await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { tip: 'addAudioRowFromBg', lists: [value] }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { ok: true, tabId: tab.id };
  }, { row, tiktokUrl, videoId });
}

export async function setAixRefererRules({ extensionPage, ids = [908001, 908002] } = {}) {
  if (!extensionPage || extensionPage.isClosed?.()) return { ok: false, code: 'AIX_PAGE_MISSING', message: 'AIX 扩展页未打开。' };
  return extensionPage.evaluate(async ({ ids: ruleIds }) => {
    if (!chrome.declarativeNetRequest?.updateDynamicRules) {
      return { ok: false, code: 'AIX_DNR_MISSING', message: '扩展页没有 declarativeNetRequest API。' };
    }
    const make = (id, domain) => ({
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.tiktok.com/' },
          { header: 'Origin', operation: 'set', value: 'https://www.tiktok.com' },
        ],
      },
      condition: { urlFilter: `||${domain}`, resourceTypes: ['xmlhttprequest', 'media', 'other'] },
    });
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: ruleIds,
        addRules: [make(ruleIds[0], 'tiktok.com'), make(ruleIds[1], 'tiktokcdn.com')],
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ok: true, ids: ruleIds };
    } catch (error) {
      return { ok: false, code: 'AIX_DNR_FAILED', message: error.message };
    }
  }, { ids });
}

export async function clearAixRefererRules({ extensionPage, ids = [908001, 908002] } = {}) {
  if (!extensionPage || extensionPage.isClosed?.()) return;
  await extensionPage.evaluate(async ({ ids: ruleIds }) => {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIds });
    } catch {
      // 清理失败不影响下载结果。
    }
  }, { ids }).catch(() => {});
}

export async function triggerAixDownload({ extensionPage, row, tabId = null, signal, useCache = true } = {}) {
  if (!extensionPage || extensionPage.isClosed?.()) return { ok: false, code: 'AIX_PAGE_MISSING', message: 'AIX 扩展页未打开。' };
  if (!row?.url) return { ok: false, code: 'AIX_ROW_INVALID', message: 'AIX 媒体行缺少下载地址。' };
  signal?.throwIfAborted?.();
  return extensionPage.evaluate(async ({ row: value, tabId: wantedTab, useCache: cache }) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      return { ok: false, code: 'AIX_EXTENSION_API_MISSING', message: '扩展页没有 chrome.runtime API。' };
    }
    const fallback = () => new Promise((resolve) => {
      chrome.runtime.sendMessage({ tip: 'downloadOthersRow', row: { ...value, isSelect: false } }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    if (!cache || !wantedTab) {
      await fallback();
      return { ok: true, mode: 'runtime' };
    }
    const name = String(value.superSpecialFileName || value.fileName || value.title || 'TikTok video');
    const result = await new Promise((resolve) => {
      chrome.tabs.sendMessage(wantedTab, {
        tip: 'downloadCacheRow',
        url: value.url,
        superSpecialFileName: name,
        title: name,
      }, () => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, message: chrome.runtime.lastError.message });
          return;
        }
        resolve({ ok: true, mode: 'cache' });
      });
    });
    if (result.ok) return result;
    await fallback();
    return { ok: true, mode: 'runtime', fallbackReason: result.message };
  }, { row, tabId, useCache });
}

export async function triggerExtensionDownload({ extensionPage, row, videoId = '', filename = '', signal } = {}) {
  if (!extensionPage || extensionPage.isClosed?.()) return { ok: false, code: 'AIX_PAGE_MISSING', message: 'AIX 扩展页未打开。' };
  if (!row?.url) return { ok: false, code: 'AIX_ROW_INVALID', message: 'AIX 媒体行缺少下载地址。' };
  signal?.throwIfAborted?.();
  return extensionPage.evaluate(async ({ row: value, videoId: id, filename: wantedName }) => {
    if (!globalThis.chrome?.downloads?.download) {
      return { ok: false, code: 'AIX_DOWNLOADS_API_MISSING', message: '扩展页没有 chrome.downloads API。' };
    }
    const safeName = String(wantedName || `${id || 'tiktok'}.mp4`).replace(/[\\/:*?<>|]+/g, '_').slice(0, 120);
    return new Promise((resolve) => {
      chrome.downloads.download({
        url: value.url,
        filename: `TikTok-AIX/${safeName.endsWith('.mp4') ? safeName : `${safeName}.mp4`}`,
        conflictAction: 'uniquify',
        saveAs: false,
        headers: [{ name: 'Referer', value: 'https://www.tiktok.com/' }],
      }, (downloadId) => {
        if (chrome.runtime.lastError || !Number.isInteger(downloadId)) {
          resolve({ ok: false, code: 'AIX_EXTENSION_DOWNLOAD_FAILED', message: chrome.runtime.lastError?.message || '扩展下载未返回 ID。' });
          return;
        }
        resolve({ ok: true, downloadId, filename: safeName });
      });
    });
  }, { row, videoId, filename });
}

function downloadMatches(item, { row, videoId, startedAt }) {
  if (!item || item.startTime && Date.parse(item.startTime) < startedAt - 3_000) return false;
  if (row?.url && item.url === row.url) return true;
  if (videoId && String(item.filename || '').includes(String(videoId))) return true;
  return /\.(?:mp4|mov|webm)(?:$|\?)/i.test(String(item.url || item.filename || ''));
}

export async function waitForAixDownload({
  extensionPage,
  row,
  videoId = '',
  sinceMs = Date.now(),
  timeoutMs = 120_000,
  signal,
} = {}) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < Math.max(1_000, timeoutMs)) {
    signal?.throwIfAborted?.();
    last = await extensionPage.evaluate(async () => {
      if (!globalThis.chrome?.downloads?.search) {
        return { ok: false, code: 'AIX_DOWNLOADS_API_MISSING', message: '扩展页没有 chrome.downloads API。' };
      }
      const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 });
      return { ok: true, items: Array.isArray(items) ? items : [] };
    });
    if (last?.ok) {
      const item = last.items.find((candidate) => downloadMatches(candidate, { row, videoId, startedAt: sinceMs }));
      if (item?.state === 'complete' && existsSync(item.filename)) {
        return {
          ok: true,
          file: item.filename,
          bytes: Number(item.fileSize) || statSync(item.filename).size,
          downloadId: item.id,
          url: item.url,
          mime: item.mime || null,
        };
      }
      if (item?.state === 'interrupted') {
        return {
          ok: false,
          code: 'AIX_DOWNLOAD_INTERRUPTED',
          message: `AIX 下载中断：${item.error || '未知原因'}`,
          downloadId: item.id,
          url: item.url,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return { ok: false, code: 'AIX_DOWNLOAD_TIMEOUT', message: '等待 AIX 下载完成超时，请人工检查扩展弹窗。' };
}

export async function setAixDownloadDirectory({ extensionPage, directory }) {
  if (!extensionPage || !directory) return { ok: false, code: 'AIX_PAGE_MISSING', message: '缺少扩展页或下载目录。' };
  try {
    const session = await extensionPage.context().newCDPSession(extensionPage);
    await session.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: directory,
      eventsEnabled: true,
    });
    await session.detach().catch(() => {});
    return { ok: true, directory };
  } catch (error) {
    return { ok: false, code: 'AIX_DOWNLOAD_DIR_FAILED', message: `设置 AIX 下载目录失败：${error.message}` };
  }
}

export async function downloadWithAix({
  context,
  tiktokPage,
  extension,
  videoId,
  desc = '',
  url = '',
  mediaUrls = [],
  stagingDir,
  signal,
  timeoutMs = 120_000,
} = {}) {
  if (!context || !extension?.ok) return { ok: false, code: 'AIX_NOT_READY', message: 'AIX 扩展未就绪。' };
  let extensionPage = null;
  try {
    extensionPage = await context.newPage();
    await extensionPage.goto(extension.popupUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (stagingDir) {
      const dir = await setAixDownloadDirectory({ extensionPage, directory: stagingDir });
      if (!dir.ok) return dir;
    }
    const rowDeadline = Date.now() + 12_000;
    let queried = { ok: false, code: 'AIX_NO_MEDIA_ROWS', rows: [] };
    let row = null;
    do {
      const current = await queryAixRows({ extensionPage, tiktokPage, videoId, signal, timeoutMs: 4_000 });
      if (current.ok && current.rows?.length) {
        queried = current;
        row = chooseAixRow(current.rows, { videoId, desc, url, mediaUrls, strictMedia: mediaUrls.length > 0 });
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    } while (Date.now() < rowDeadline && !signal?.aborted);
    if (!queried.ok) return { ...queried, extensionPage };
    if (!row) {
      return {
        ok: false,
        code: mediaUrls.length ? 'AIX_CURRENT_MEDIA_NOT_CAPTURED' : 'AIX_ROW_NOT_FOUND',
        message: mediaUrls.length
          ? 'AIX 未捕获到与当前作品媒体地址匹配的视频行，已停止以避免下载到推荐的下一条视频。'
          : 'AIX 没有返回可用的视频行。',
        rows: queried.rows || [],
        extensionPage,
      };
    }
    if ((Number(row.bytSize) || 0) < 10 * 1024) {
      return {
        ok: false,
        code: 'AIX_VIDEO_ROW_NOT_READY',
        message: 'AIX 只捕获到非视频片段或小于 10KB 的媒体，请确认视频已开始播放。',
        rows: queried.rows || [],
      };
    }
    await setAixRefererRules({ extensionPage });
    const triggered = await triggerAixDownload({ extensionPage, row, tabId: queried.tabId, signal, useCache: false });
    if (!triggered.ok) {
      await clearAixRefererRules({ extensionPage });
      return { ...triggered, row, extensionPage };
    }
    const downloaded = await waitForAixDownload({
      extensionPage,
      row,
      videoId,
      sinceMs: Date.now(),
      timeoutMs,
      signal,
    });
    await clearAixRefererRules({ extensionPage });
    return { ...downloaded, row, extensionPage };
  } catch (error) {
    return { ok: false, code: 'AIX_AUTOMATION_FAILED', message: `AIX 自动下载失败：${error.message}`, extensionPage };
  }
}
