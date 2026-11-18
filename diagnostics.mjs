// diagnostics.mjs — 本机自检：Node、Edge、代理配置与连通性、浏览器进程、页面状态。

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import process from 'node:process';

import { probeEdgeInstallation, readBrowserState, BROWSER_ERROR_CODES } from './browser-host.mjs';
import { findPageByRole } from './browser-pages.mjs';
import { readPageSignals } from './browser-launcher.mjs';
import { checkProxy, resolveProxyConfig, PROXY_ERROR_CODES } from './proxy-check.mjs';
import { discoverAixExtension } from './services/aix-adapter.mjs';
import { detectSystemProxy, resolveProxyMode } from './services/system-proxy.mjs';

const MIN_NODE = [22, 13];
const NODE_EXEC_ENV = 'TIKTOK_NODE_EXECUTABLE';

/**
 * 读取用户级环境变量（HKCU\Environment）。
 * 独立 Node 的指向写在用户环境变量里，但当前 DSH 进程可能还没重启、process.env 里没有它，
 * 所以这里直接查注册表，保证“刚设置完就自检”也能看到。
 */
function readUserEnv(name) {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = out.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`, 'i'));
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function probeNodeExecutable(file) {
  if (!existsSync(file)) {
    return {
      ok: false,
      code: 'NODE_NOT_FOUND',
      detail: file,
      fix: `找不到 ${file}，请确认 ${NODE_EXEC_ENV} 指向的是真实的 node.exe。`,
    };
  }
  let version = '';
  try {
    version = String(
      execFileSync(file, ['-v'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    )
      .trim()
      .replace(/^v/i, '');
  } catch (error) {
    // 某些受限环境不允许创建子进程（EPERM），此时退而用安装路径里的版本号判断，
    // 例如 C:\\...\\nodejs-v22.23.4\\node.exe。
    const fromPath = String(file).match(/v?(\d+)\.(\d+)\.(\d+)/);
    if (fromPath) {
      const [major, minor] = [Number(fromPath[1]), Number(fromPath[2])];
      const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
      if (ok) {
        return {
          ok: true,
          code: null,
          detail: `v${fromPath[1]}.${fromPath[2]}.${fromPath[3]}（独立安装：${file}，版本取自安装路径）`,
          fix: null,
        };
      }
    }
    return {
      ok: false,
      code: 'NODE_VERSION_UNSUPPORTED',
      detail: `${file} 无法运行：${String(error?.message || error).slice(0, 120)}`,
      fix: `请确认 ${NODE_EXEC_ENV} 指向的是可执行的 node.exe。`,
    };
  }
  const [major, minor] = version.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    ok,
    code: ok ? null : 'NODE_VERSION_UNSUPPORTED',
    detail: `v${version}（独立安装：${file}）`,
    fix: ok ? null : `当前 ${file} 是 v${version}，需要 ${MIN_NODE[0]}.${MIN_NODE[1]} 或更高版本。`,
  };
}

function check(id, label, run) {
  return { id, label, run };
}

export function describeNode(env = process.env) {
  // 优先用显式指定的独立 Node（环境变量或用户级注册表），这样设置完不必等 DSH 重启。
  const explicit = String(env?.[NODE_EXEC_ENV] || '').trim() || readUserEnv(NODE_EXEC_ENV);
  if (explicit) {
    const probe = probeNodeExecutable(explicit);
    return {
      id: 'node',
      label: 'Node.js 运行时',
      ok: probe.ok,
      code: probe.code,
      detail: probe.detail,
      fix: probe.fix,
    };
  }
  const [major, minor] = String(process.versions.node || '0.0').split('.').map(Number);
  const version = process.versions.node;
  const electron = Boolean(process.versions.electron);
  const ok = !electron && (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]));
  return {
    id: 'node',
    label: 'Node.js 运行时',
    ok,
    code: ok ? null : electron ? 'NODE_ELECTRON_RUNTIME' : 'NODE_VERSION_UNSUPPORTED',
    detail: `v${version}${electron ? '（Electron 内置）' : ''}`,
    fix: ok ? null : `请安装独立 Node.js ${MIN_NODE[0]}.${MIN_NODE[1]} 或更高版本，并在设置里指向它（${NODE_EXEC_ENV}）。`,
  };
}

export function describeEdge(probe = probeEdgeInstallation) {
  const result = probe();
  return {
    id: 'edge',
    label: 'Microsoft Edge 安装',
    ok: result.ok,
    code: result.ok ? null : BROWSER_ERROR_CODES.MISSING,
    detail: result.ok ? result.path : '未找到 msedge.exe',
    fix: result.ok ? null : '请安装 Microsoft Edge（本插件用系统 Edge 打开专用窗口）。',
  };
}

export function describeProxyConfig(proxy) {
  if (!proxy.configured) {
    return {
      id: 'proxy-config',
      label: '代理配置',
      ok: false,
      code: PROXY_ERROR_CODES.NOT_CONFIGURED,
      detail: '未填写代理地址',
      fix: '在 ~/.dsh/tiktok-browser/config.json 填写 proxy.server（例如 http://127.0.0.1:7890）。',
    };
  }
  return {
    id: 'proxy-config',
    label: '代理配置',
    ok: Boolean(proxy.valid),
    code: proxy.valid ? null : PROXY_ERROR_CODES.UNSUPPORTED,
    detail: proxy.valid ? proxy.server : proxy.invalidReason,
    fix: proxy.valid ? null : '请改成 http 代理地址，或换用支持 HTTP CONNECT 的端口。',
  };
}

export function describeSystemProxyConfig(system) {
  if (!system?.supported) {
    return {
      id: 'proxy-config',
      label: '代理配置',
      ok: false,
      code: PROXY_ERROR_CODES.NOT_CONFIGURED,
      detail: '当前系统不支持自动读取系统代理',
      fix: '请改用「手动」模式填写代理地址。',
    };
  }
  if (system.pacUrl && !system.server) {
    return {
      id: 'proxy-config',
      label: '代理配置',
      ok: true,
      code: null,
      detail: '系统代理使用 PAC 脚本，将由浏览器处理',
      fix: null,
    };
  }
  if (system.enabled && system.server) {
    return {
      id: 'proxy-config',
      label: '代理配置',
      ok: true,
      code: null,
      detail: `跟随系统代理：${system.server}`,
      fix: null,
    };
  }
  return {
    id: 'proxy-config',
    label: '代理配置',
    ok: false,
    code: PROXY_ERROR_CODES.NOT_CONFIGURED,
    detail: '未检测到已启用的系统代理',
    fix: '请在 Windows 设置里打开代理，或改用「手动」模式填写代理地址。',
  };
}

export function describeBrowserState(state) {
  if (!state) {
    return {
      id: 'browser',
      label: '浏览器进程',
      ok: false,
      code: 'BROWSER_NOT_RUNNING',
      detail: '未发现运行中的专用 Edge',
      fix: '调用 tiktok_open 启动浏览器。',
    };
  }
  const pid = Number(state.pid) || 0;
  let alive = false;
  if (pid > 0) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  return {
    id: 'browser',
    label: '浏览器进程',
    ok: alive && state.ready === true,
    code: alive ? null : 'BROWSER_NOT_RUNNING',
    detail: `pid=${pid || '未知'} port=${state.port || '未知'}`,
    fix: alive ? null : '调用 tiktok_open 重新启动浏览器。',
  };
}

/**
 * 运行全部自检。返回 { ok, reportId, at, checks, summary }。
 */
export async function runDiagnostics({
  paths,
  config = {},
  env = process.env,
  context = null,
  proxyCheck = checkProxy,
  probe = probeEdgeInstallation,
  readState = readBrowserState,
  systemProxyProbe = detectSystemProxy,
} = {}) {
  const mode = resolveProxyMode(config, env);
  const system = mode === 'system' ? await systemProxyProbe({ force: true }) : null;
  const proxy = mode === 'system' && system?.server
    ? resolveProxyConfig({ proxy: { server: system.server } }, {})
    : resolveProxyConfig(config, env);
  const proxyConfigCheck = mode === 'system' ? describeSystemProxyConfig(system) : describeProxyConfig(proxy);
  const state = paths?.browserControlDir ? readState(paths.browserControlDir) : null;
  const checks = [describeNode(env), describeEdge(probe), proxyConfigCheck, describeBrowserState(state)];

  const proxyConnectivity = mode === 'system' && system?.pacUrl && !system?.server
    ? { ok: true, note: '系统代理使用 PAC 脚本，连通性由浏览器处理。' }
    : !proxyConfigCheck.ok
      ? { ok: false, code: proxyConfigCheck.code, message: proxyConfigCheck.detail }
      : await proxyCheck({ proxy }).catch((error) => ({
        ok: false,
        code: PROXY_ERROR_CODES.UNREACHABLE,
        message: error?.message || '代理自检异常',
        latencyMs: 0,
      }));
  checks.push({
    id: 'proxy-connectivity',
    label: '代理连通 TikTok',
    ok: Boolean(proxyConnectivity.ok),
    code: proxyConnectivity.code || null,
    detail: proxyConnectivity.ok
      ? proxyConnectivity.note || `${proxyConnectivity.server} → ${proxyConnectivity.target}（${proxyConnectivity.latencyMs}ms）`
      : proxyConnectivity.message || '代理不可用',
    fix: proxyConnectivity.ok ? null : '检查代理软件是否运行、手动端口或系统代理设置是否正确。',
  });

  const downloadChannel = config?.download?.channel || 'page';
  const aix = discoverAixExtension({ profileDir: paths?.browserProfileDir });
  checks.push({
    id: 'aix-downloader',
    label: 'AIX 智能下载器',
    ok: aix.ok || downloadChannel === 'page',
    code: aix.ok ? null : aix.code,
    detail: aix.ok
      ? `${aix.name} ${aix.version}${aix.hasTikTokContentScript ? ' · 已启用 TikTok 捕获' : ' · 缺少 TikTok 内容脚本'}`
      : `${aix.message}（当前下载通道：${downloadChannel}）`,
    fix: aix.ok || downloadChannel === 'page'
      ? null
      : '在插件专用 Edge profile 中安装/启用 AIX 智能下载器，或把下载通道改为 page。',
  });

  if (context) {
    try {
      const page = await findPageByRole(context, 'prepare');
      if (!page || page.isClosed()) {
        checks.push({
          id: 'page',
          label: 'TikTok 页面',
          ok: false,
          code: 'PAGE_NOT_FOUND',
          detail: '浏览器已启动但未找到专用页面',
          fix: '调用 tiktok_open 重新打开页面。',
        });
      } else {
        const signals = await readPageSignals(page);
        checks.push({
          id: 'page',
          label: 'TikTok 页面',
          ok: !signals.loginRequired && !signals.verificationRequired && !signals.blocked,
          code: signals.verificationRequired
            ? 'CAPTCHA_REQUIRED'
            : signals.loginRequired
              ? 'LOGIN_REQUIRED'
              : signals.blocked
                ? 'PAGE_BLOCKED'
                : null,
          detail: `${signals.title || '(无标题)'} · ${signals.url}`,
          fix:
            signals.loginRequired || signals.verificationRequired
              ? '在弹出的 Edge 窗口里手动完成登录或验证，完成后重试。'
              : null,
        });
      }
    } catch (error) {
      checks.push({
        id: 'page',
        label: 'TikTok 页面',
        ok: false,
        code: 'PAGE_CHECK_FAILED',
        detail: String(error?.message || error).slice(0, 200),
        fix: '重新调用 tiktok_open。',
      });
    }
  }

  const failed = checks.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    reportId: randomUUID(),
    at: new Date().toISOString(),
    checks,
    summary: failed.length === 0 ? '全部自检通过' : `${failed.length} 项未通过：${failed.map((item) => item.label).join('、')}`,
  };
}
