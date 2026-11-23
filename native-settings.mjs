import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { dailyBudgetExhaustedResult } from './services/daily-budget.mjs';

export const SETTINGS_PREFIX = '/api/tiktok-browser';
export const SETTINGS_RPC_CHANNEL = '/tiktok-settings';
const MAX_JSON_BYTES = 524_288;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv']);
// 只读查询 / 资源管理器定位，采集运行中也允许，不涉及配置写入。
const SAFE_DURING_RUN = new Set([
  '/library/candidates',
  '/library/export',
  '/library/reveal',
  '/feedback/list',
  '/proxy/system',
  '/proxy/pool/reset',
  '/report/reveal',
  // 历史版本列表只读，采集运行中也可以查看。
  '/profiles/material/history',
]);

const send = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
};

function fail(message, status = 400, code = null) {
  return Object.assign(new Error(message), { status, code });
}

async function readJsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail('只接收 JSON 设置。', 400);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw fail('设置请求过长。', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch {
    throw fail('设置必须是 JSON 对象。', 400);
  }
}

function safeEqual(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.length === right.length
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function recentTokens(file, limit = 80) {
  try {
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-limit);
    return lines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// 文件夹选择脚本：DSH 服务进程不是前台进程，FolderBrowserDialog 会被前台窗口（浏览器）
// 遮挡，用户看不到对话框。这里在 ShowDialog 期间用后台 runspace 轮询找到 #32770 对话框
// 并强制置顶 + 抢前台，保证对话框一定出现在最前面。
const PICK_DIALOG_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TikTokPickWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  public static IntPtr Find(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid) return true;
      var sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      if (sb.ToString() == "#32770" && IsWindowVisible(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Promote(IntPtr h) {
    bool ok = SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002);
    SetForegroundWindow(h);
    return ok;
  }
}
'@ | Out-Null
$poller = [powershell]::Create()
$poller.Runspace = [runspacefactory]::CreateRunspace()
$poller.Runspace.Open()
$null = $poller.AddScript({
  param($targetPid)
  for ($i = 0; $i -lt 3600; $i++) {
    Start-Sleep -Milliseconds 100
    try {
      $h = [TikTokPickWin]::Find([uint32]$targetPid)
      if ($h -ne [IntPtr]::Zero) { [TikTokPickWin]::Promote($h) | Out-Null; return }
    } catch { }
  }
}).AddArgument($PID)
$null = $poller.BeginInvoke()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select TikTok archive folder'
$dialog.ShowNewFolderButton = $true
if ($env:TIKTOK_PICK_DIR -and (Test-Path -LiteralPath $env:TIKTOK_PICK_DIR)) { $dialog.SelectedPath = $env:TIKTOK_PICK_DIR }
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  # 不能用 [Console]::Out.Write：DSH 宿主没有控制台，子进程输出编码会回落到系统 ANSI（936/GBK），
  # 中文路径写出的字节不是 UTF-8，Node 侧解码成乱码后校验失败。这里直接写 UTF-8 原始字节。
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)
  $stream = [Console]::OpenStandardOutput()
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
}
`;

function pickDirectory(current = '') {
  return new Promise((resolve) => {
    const script = PICK_DIALOG_SCRIPT;
    // 不依赖宿主 PATH；精简运行环境中仅写 powershell.exe 会 spawn ENOENT。
    const powershell = process.platform === 'win32'
      ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const child = spawn(powershell, ['-NoProfile', '-STA', '-Command', script], {
      windowsHide: false,
      env: { ...process.env, TIKTOK_PICK_DIR: String(current || '').slice(0, 1000) },
    });
    // 保留原始字节并在退出后统一解码，避免 UTF-8 多字节字符跨 chunk 时被截断。
    const stdoutChunks = [];
    const stderrChunks = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, code: 'DIRECTORY_PICK_TIMEOUT', message: '文件夹选择超时。' });
    }, 300_000);
    child.stdout.on('data', (chunk) => { stdoutChunks.push(chunk); });
    child.stderr.on('data', (chunk) => { stderrChunks.push(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'DIRECTORY_PICK_FAILED', message: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const selected = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (!selected) {
        resolve(code === 0 ? { ok: true, cancelled: true } : { ok: false, code: 'DIRECTORY_PICK_FAILED', message: stderr || `退出码 ${code}` });
        return;
      }
      if (!isAbsolute(selected) || !existsSync(selected) || !statSync(selected).isDirectory()) {
        resolve({ ok: false, code: 'DIRECTORY_INVALID', message: '选择的路径不是有效绝对目录。' });
        return;
      }
      resolve({ ok: true, cancelled: false, path: selected });
    });
  });
}

export function createNativeSettingsRoute({
  getController,
  getRun,
  getDiagnostics,
} = {}) {
  const token = randomBytes(32).toString('hex');
  let catalogCache = null;
  let catalogAt = 0;

  async function modelCatalog() {
    if (catalogCache && Date.now() - catalogAt < 60_000) return catalogCache;
    catalogCache = await (await getController()).modelCatalog();
    catalogAt = Date.now();
    return catalogCache;
  }

  async function state() {
    const controller = await getController();
    const [catalog] = await Promise.all([modelCatalog()]);
    const configState = controller.config();
    const library = controller.library();
    const profiles = controller.profiles();
    return {
      token,
      at: new Date().toISOString(),
      settings: configState,
      model: {
        ...catalog,
        active: controller.profiles().judge,
      },
      profiles: profiles.profiles,
      library: {
        count: library.count,
        byProfile: library.byProfile,
        positiveCount: library.positiveCount,
        negativeCount: library.negativeCount,
        unassigned: library.unassigned,
        defaultsHidden: library.defaultsHidden,
        samples: library.samples,
        dir: library.dir,
      },
      download: controller.downloadStatus(),
      dedup: controller.dedupStatus(),
      retry: controller.retryStatus(),
      proxyPool: controller.proxyPoolStatus(),
      feedback: (() => {
        const value = controller.listCandidateFeedback({});
        return { summary: value.summary, pendingRebuild: value.pendingRebuild, limits: value.limits };
      })(),
      run: getRun ? getRun().state() : { status: 'idle', running: false },
      tokenUsage: recentTokens(join(controller.paths.stateDir, 'token-usage.jsonl')),
      dailyBudget: controller.dailyBudgetStatus(),
      capabilities: {
        streamingUpload: true,
        dshModels: catalog.available,
        aix: controller.downloadStatus().aix,
      },
    };
  }

  async function uploadedFile(req, url, controller) {
    const rawName = String(url.searchParams.get('filename') || '').slice(0, 240);
    const ext = extname(rawName).toLowerCase();
    if (!rawName || !VIDEO_EXTENSIONS.has(ext)) throw fail('只支持 mp4/mov/webm/mkv 视频。', 400, 'UPLOAD_TYPE_INVALID');
    const profileId = String(url.searchParams.get('profileId') || '').slice(0, 80);
    const polarity = url.searchParams.get('polarity') === 'negative' ? 'negative' : 'positive';
    const directory = join(controller.paths.libraryDir, '.uploads');
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `${randomUUID()}${ext}`);
    let size = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) callback(fail('视频超过 500MB 上限。', 413, 'UPLOAD_TOO_LARGE'));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(temporary, { flags: 'wx' }));
      if (size < 10 * 1024) throw fail('视频小于 10KB，无法作为样例。', 400, 'UPLOAD_TOO_SMALL');
      const added = await controller.libraryAdd({
        file: temporary,
        profileId: profileId || null,
        polarity,
        describe: true,
      });
      return { ...added, upload: { filename: rawName, bytes: size, polarity } };
    } finally {
      try { rmSync(temporary, { force: true }); } catch {}
    }
  }

  return {
    kind: 'prefix',
    path: SETTINGS_PREFIX,
    async handler(req, res) {
      try {
        const host = req.headers.host;
        if (!host || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return send(res, 403, { error: '设置页只接受本机来源。' });
        const origin = `${req.socket?.encrypted ? 'https' : 'http'}://${host}`;
        const url = new URL(req.url, origin);
        if (url.origin !== origin) return send(res, 403, { error: '拒绝跨来源设置请求。' });
        if (req.headers.origin && req.headers.origin !== origin && !/^(?:dsh-app|dsh):\/\/app$/i.test(req.headers.origin)) {
          return send(res, 403, { error: '拒绝跨来源设置请求。' });
        }
        if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { error: '拒绝跨来源设置请求。' });

        if (req.method === 'GET' && url.pathname === `${SETTINGS_PREFIX}/state`) return send(res, 200, await state());
        if (req.method !== 'POST') return send(res, 404, { error: '设置地址不存在。' });
        if (!safeEqual(req.headers['x-tiktok-settings-token'], token)) return send(res, 403, { error: '请先刷新设置页，再执行此操作。' });

        const controller = await getController();
        if (url.pathname === `${SETTINGS_PREFIX}/upload`) return send(res, 200, await uploadedFile(req, url, controller));

        const input = await readJsonBody(req);
        const route = url.pathname.slice(SETTINGS_PREFIX.length);
        const run = getRun?.();
        if (route !== '/run/stop' && !SAFE_DURING_RUN.has(route) && run?.state().running) {
          throw fail('采集任务运行中，请先停止任务再修改设置。', 409, 'RUN_ACTIVE');
        }
        switch (route) {
          case '/config/configure': {
            if (Object.keys(input).some((key) => key !== 'patch') || !input.patch || typeof input.patch !== 'object') {
              throw fail('只接受 patch 对象。');
            }
            const result = controller.updateConfig(input.patch);
            if (!result.ok) throw fail(result.message || '保存失败。', 400, result.code);
            catalogCache = null;
            return send(res, 200, result);
          }
          case '/keywords/expand':
            return send(res, 200, await controller.previewKeywords(input));
          case '/directory/pick':
            return send(res, 200, await pickDirectory(typeof input.current === 'string' ? input.current : ''));
          case '/run/start': {
            if (!run) throw fail('任务服务未就绪。', 503);
            const daily = controller.dailyBudgetStatus();
            if (daily.exhausted) throw fail(dailyBudgetExhaustedResult(daily).message, 429, 'DAILY_TOKEN_BUDGET_EXHAUSTED');
            return send(res, 200, run.start(input));
          }
          case '/run/stop':
            if (!run) throw fail('任务服务未就绪。', 503);
            return send(res, 200, run.stop());
          case '/profiles/material/build':
            return send(res, 200, await controller.profileBuild(input));
          case '/profiles/material/save':
            return send(res, 200, controller.saveMaterialProfile(input));
          case '/profiles/material/delete':
            return send(res, 200, controller.removeMaterialProfile(input));
          case '/profiles/material/history':
            return send(res, 200, controller.listMaterialProfileHistory(input));
          case '/profiles/material/restore':
            return send(res, 200, controller.restoreMaterialProfile(input));
          case '/library/purge':
            return send(res, 200, controller.purgeLibrary(input));
          case '/library/restore-defaults':
            return send(res, 200, controller.restoreDefaultProfiles());
          case '/library/candidates':
            return send(res, 200, controller.libraryCandidates(input));
          case '/library/export':
            return send(res, 200, controller.exportCandidates({
              status: input.status ?? '',
              query: input.query ?? '',
              sinceDays: Number(input.sinceDays) || 0,
              date: input.date ?? '',
            }));
          case '/library/sample/polarity':
            return send(res, 200, controller.librarySetPolarity(input));
          case '/library/sample/delete': {
            const value = controller.libraryRemoveSample(input);
            if (!value.ok) throw fail(value.message || '删除样例失败。', 400, value.code || null);
            return send(res, 200, value);
          }
          case '/feedback/list':
            return send(res, 200, controller.listCandidateFeedback(input));
          case '/feedback/save':
            return send(res, 200, controller.saveCandidateFeedback(input));
          case '/feedback/remove':
            return send(res, 200, controller.removeCandidateFeedback(input));
          case '/feedback/reflow': {
            const value = await controller.reflowFeedback({
              videoId: input.videoId,
              polarity: input.polarity === 'negative' ? 'negative' : 'positive',
              profileId: input.profileId || null,
              describe: input.describe !== false,
            });
            if (!value.ok) throw fail(value.message || '回流失败。', 400, value.code || null);
            return send(res, 200, value);
          }
          case '/library/reveal':
            return send(res, 200, controller.revealPath({ file: input.file, scope: 'any' }));
          case '/report/reveal':
            return send(res, 200, controller.revealPath({ file: input.file, scope: 'reports' }));
          case '/diagnostics':
            return send(res, 200, await (getDiagnostics ? getDiagnostics() : controller.diagnostics()));
          case '/proxy/system':
            return send(res, 200, await controller.systemProxyInfo());
          case '/proxy/pool/reset':
            return send(res, 200, { ok: true, ...controller.resetProxyPool(), status: controller.proxyPoolStatus() });
          case '/retry/list':
            return send(res, 200, { ok: true, ...controller.retryStatus() });
          case '/retry/clear':
            return send(res, 200, { ok: true, ...controller.clearRetryQueue(), status: controller.retryStatus() });
          case '/report/generate':
            return send(res, 200, controller.report({ sinceDays: Number(input.sinceDays) || 1 }));
          default:
            return send(res, 404, { error: '设置地址不存在。' });
        }
      } catch (error) {
        const status = Number(error?.status) || 500;
        return send(res, status, { error: error?.message || String(error), code: error?.code || null });
      }
    },
  };
}
