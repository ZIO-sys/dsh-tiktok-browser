// system-proxy.mjs — 读取 Windows 系统代理设置（HKCU Internet Settings）。
// 只做只读探测：不修改注册表、不写配置、不启动浏览器。
// 结果带 30 秒缓存；非 Windows 平台返回 supported:false。

import { execFile } from 'node:child_process';

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const CACHE_TTL_MS = 30_000;

let cache = { at: 0, value: null };

/**
 * 解析代理模式：显式配置优先；未设置时按旧配置兼容推断
 * （已填 server 或 pool 的既有用户视为 manual，全新配置视为 system）。
 */
export function resolveProxyMode(config = {}, env = process.env) {
  const proxy = config?.proxy && typeof config.proxy === 'object' ? config.proxy : {};
  const explicit = String(proxy.mode || '').trim().toLowerCase();
  if (explicit === 'system' || explicit === 'manual') return explicit;
  // auto 与历史空值都按旧配置推断；环境变量代理也必须视为 manual，避免被系统模式绕过。
  const hasServer = String(env?.TIKTOK_PROXY_SERVER || proxy.server || '').trim() !== '';
  const rawPool = proxy.pool;
  const hasPool = Array.isArray(rawPool)
    ? rawPool.some((item) => String(item || '').trim() !== '')
    : String(rawPool || '').trim() !== '';
  return hasServer || hasPool ? 'manual' : 'system';
}

/**
 * 解析注册表 ProxyServer 值：
 * - `127.0.0.1:10808` → 原样返回
 * - `http=127.0.0.1:10808;https=127.0.0.1:10808` → 优先 https，再 http，再 socks，最后任一首值
 */
export function parseProxyServer(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!text.includes('=')) return text;
  const map = new Map();
  for (const part of text.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const scheme = part.slice(0, index).trim().toLowerCase();
    const address = part.slice(index + 1).trim();
    if (scheme && address) map.set(scheme, address);
  }
  if (map.size === 0) return text.includes(':') ? text : null;
  const httpProxy = map.get('https') || map.get('http');
  if (httpProxy) return httpProxy;
  const socksProxy = map.get('socks') || map.get('socks5');
  // 保留 SOCKS 协议，让代理校验明确报“不支持”，而不是误当成 HTTP 代理探测。
  if (socksProxy) return `socks://${socksProxy}`;
  return [...map.values()][0] || null;
}

function queryRegistryValue(name) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }
    execFile('reg', ['query', REG_KEY, '/v', name], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      // 输出形如：`    ProxyEnable    REG_DWORD    0x1`
      const line = String(stdout || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => item.startsWith(name) && item.includes('REG_'));
      if (!line) {
        resolve(null);
        return;
      }
      resolve(line.split(/\s{2,}/).pop() || null);
    });
  });
}

function parseDword(value) {
  const text = String(value || '').trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(text)) return Number.parseInt(text, 16);
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  return 0;
}

/**
 * 探测 Windows 系统代理。
 * 返回 { supported, enabled, server, pacUrl, source }；
 * `enabled=true` 且 `server` 非空才可直接使用；仅 PAC 时 server 为空、pacUrl 有值。
 */
export async function detectSystemProxy({ force = false } = {}) {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, server: null, pacUrl: null, source: null };
  }
  if (!force && cache.value && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  const [enableRaw, serverRaw, pacRaw] = await Promise.all([
    queryRegistryValue('ProxyEnable'),
    queryRegistryValue('ProxyServer'),
    queryRegistryValue('AutoConfigURL'),
  ]);
  const enabled = parseDword(enableRaw) === 1;
  const pacUrl = pacRaw ? String(pacRaw).trim() || null : null;
  let server = parseProxyServer(serverRaw);
  if (!enabled) server = null;
  const value = { supported: true, enabled, server: server || null, pacUrl, source: 'registry:HKCU/Internet Settings' };
  cache = { at: Date.now(), value };
  return value;
}

/**
 * 直连探测 TikTok 可达性（用于系统代理未启用时的诊断提示）。
 * 返回 { ok, latencyMs, error }；不改变任何配置。
 */
export function probeDirectTiktok({ target = 'www.tiktok.com', timeoutMs = 5_000 } = {}) {
  const net = import('node:net');
  const started = Date.now();
  return net.then(({ default: netModule }) => new Promise((resolve) => {
    const socket = new netModule.Socket();
    let settled = false;
    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - started, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (error) => finish(false, error?.code || String(error)));
    socket.connect(443, target, () => finish(true));
  }));
}
