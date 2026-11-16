// proxy-pool.mjs — P2-5 代理池轮换。
//
// 边界（按 P2 约定）：
//  - 只做“换出口 IP”：不代登录、不切换 Edge profile 内容、不绕过平台风控；
//  - 多账号只通过 `browser.profileDir` 做目录隔离，登录仍需用户在 Edge 窗口里手动完成；
//  - 池为空时完全沿用单代理 `proxy.server`，行为与 P1 一致。

import { PROXY_ERROR_CODES } from '../proxy-check.mjs';

export const PROXY_POOL_DEFAULTS = Object.freeze({
  cooldownMs: 10 * 60 * 1000,
  failureThreshold: 2,
});

/** 归一化代理地址：补 http://、去尾部斜杠；非法返回 null。 */
export function normalizeProxyServer(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol)) return null;
    if (!url.hostname || !url.port) return null;
    // url.host 已经带端口，再拼一次会变成 host:port:port。
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** 读取 config.proxy.pool：去空、去重、保序；非法项被丢掉并记在 ignored 里。 */
export function parseProxyPool(pool) {
  const list = Array.isArray(pool) ? pool : String(pool || '').split(/[\s,;]+/);
  const servers = [];
  const ignored = [];
  const seen = new Set();
  for (const item of list) {
    const raw = String(item || '').trim();
    if (!raw) continue;
    const server = normalizeProxyServer(raw);
    if (!server) {
      ignored.push(raw);
      continue;
    }
    if (seen.has(server)) continue;
    seen.add(server);
    servers.push(server);
  }
  return { servers, ignored };
}

/**
 * 代理池：轮换 + 失败冷却。
 * @param {{pool?:string[], fallback?:string, now?:()=>number, cooldownMs?:number, failureThreshold?:number}} options
 */
export function createProxyPool({
  pool = [],
  fallback = '',
  now = () => Date.now(),
  cooldownMs = PROXY_POOL_DEFAULTS.cooldownMs,
  failureThreshold = PROXY_POOL_DEFAULTS.failureThreshold,
} = {}) {
  const parsed = parseProxyPool(pool);
  const servers = parsed.servers;
  const fallbackServer = normalizeProxyServer(fallback);
  let cursor = 0;
  const state = new Map();
  for (const server of servers) {
    state.set(server, { server, failures: 0, uses: 0, cooldownUntil: 0, lastUsedAt: null, lastError: null });
  }

  const enabled = servers.length > 0;

  function entryOf(server) {
    return state.get(normalizeProxyServer(server) || server) || null;
  }

  function cooling(server, at = now()) {
    const entry = entryOf(server);
    return Boolean(entry && entry.cooldownUntil > at);
  }

  /**
   * 取下一个可用代理。
   * @returns {{ok:boolean, server:string|null, source:'pool'|'fallback'|null, index:number, cooling:string[], code?:string, message?:string}}
   */
  function next() {
    const at = now();
    if (!enabled) {
      if (fallbackServer) {
        return { ok: true, server: fallbackServer, source: 'fallback', index: -1, cooling: [] };
      }
      return {
        ok: false,
        server: null,
        source: null,
        index: -1,
        cooling: [],
        code: PROXY_ERROR_CODES.NOT_CONFIGURED,
        message: '未配置代理：proxy.pool 与 proxy.server 都为空。',
      };
    }
    const coolingList = servers.filter((server) => cooling(server, at));
    for (let step = 0; step < servers.length; step += 1) {
      const index = (cursor + step) % servers.length;
      const server = servers[index];
      if (cooling(server, at)) continue;
      cursor = (index + 1) % servers.length;
      const entry = entryOf(server);
      entry.uses += 1;
      entry.lastUsedAt = new Date(at).toISOString();
      return { ok: true, server, source: 'pool', index, cooling: coolingList };
    }
    return {
      ok: false,
      server: null,
      source: null,
      index: -1,
      cooling: coolingList,
      code: 'PROXY_POOL_ALL_COOLING',
      message: `代理池里 ${servers.length} 个代理都在冷却中（每个连续失败 ${failureThreshold} 次冷却 ${Math.round(cooldownMs / 60000)} 分钟）。`,
    };
  }

  /** 成功：清零失败计数并解除冷却。 */
  function reportSuccess(server) {
    const entry = entryOf(server);
    if (!entry) return { ok: false, code: 'PROXY_NOT_IN_POOL', message: '该代理不在池里。' };
    entry.failures = 0;
    entry.cooldownUntil = 0;
    entry.lastError = null;
    return { ok: true, ...entry };
  }

  /** 失败：累计到阈值后冷却 cooldownMs。 */
  function reportFailure(server, error = null) {
    const entry = entryOf(server);
    if (!entry) return { ok: false, code: 'PROXY_NOT_IN_POOL', message: '该代理不在池里。' };
    entry.failures += 1;
    entry.lastError = error ? String(error).slice(0, 200) : 'check failed';
    if (entry.failures >= failureThreshold) {
      entry.cooldownUntil = now() + cooldownMs;
    }
    return {
      ok: true,
      server: entry.server,
      failures: entry.failures,
      cooling: entry.cooldownUntil > now(),
      cooldownUntil: entry.cooldownUntil ? new Date(entry.cooldownUntil).toISOString() : null,
    };
  }

  /** 手动解除全部冷却（设置页“重置冷却”）。 */
  function reset() {
    for (const entry of state.values()) {
      entry.failures = 0;
      entry.cooldownUntil = 0;
      entry.lastError = null;
    }
    cursor = 0;
    return { ok: true, reset: true };
  }

  function status() {
    const at = now();
    return {
      enabled,
      fallback: fallbackServer,
      failureThreshold,
      cooldownMs,
      size: servers.length,
      cooling: servers.filter((server) => cooling(server, at)).length,
      available: servers.filter((server) => !cooling(server, at)).length,
      ignored: parsed.ignored,
      pool: servers.map((server) => {
        const entry = entryOf(server);
        return {
          server,
          failures: entry.failures,
          uses: entry.uses,
          cooling: entry.cooldownUntil > at,
          cooldownUntil: entry.cooldownUntil ? new Date(entry.cooldownUntil).toISOString() : null,
          lastUsedAt: entry.lastUsedAt,
          lastError: entry.lastError,
        };
      }),
    };
  }

  return { enabled, servers, next, reportSuccess, reportFailure, reset, status, cooling };
}
