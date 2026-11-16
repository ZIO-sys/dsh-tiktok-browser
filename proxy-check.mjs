// proxy-check.mjs — 代理配置解析与连通性自检（CONNECT 隧道 + TLS + HTTP 探测）。

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

export const PROXY_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'PROXY_NOT_CONFIGURED',
  UNREACHABLE: 'PROXY_UNREACHABLE',
  AUTH_FAILED: 'PROXY_AUTH_FAILED',
  UNSUPPORTED: 'PROXY_UNSUPPORTED',
  TIKTOK_UNREACHABLE: 'TIKTOK_UNREACHABLE',
});

const DEFAULT_TARGET = 'www.tiktok.com';
const DEFAULT_TIMEOUT = 25_000;
const RETRY_DELAY_MS = 1_500;

/**
 * 解析代理配置：配置文件 {proxy:{server,username,password,allowDirect}} + 环境变量覆盖。
 * 只支持 http/https 代理；socks5 明确报不支持，避免静默失败。
 */
export function resolveProxyConfig(config = {}, env = process.env) {
  const fromConfig = config?.proxy && typeof config.proxy === 'object' ? config.proxy : {};
  const server = String(env.TIKTOK_PROXY_SERVER || fromConfig.server || '').trim();
  const username = String(env.TIKTOK_PROXY_USERNAME || fromConfig.username || '').trim();
  const password = String(env.TIKTOK_PROXY_PASSWORD || fromConfig.password || '');
  const allowDirect = fromConfig.allowDirect === true;
  if (!server) {
    return { configured: false, server: null, username: '', password: '', allowDirect, protocol: null, host: null, port: null };
  }
  const parsed = parseServer(server);
  return {
    configured: true,
    server,
    username,
    password,
    allowDirect,
    protocol: parsed.protocol,
    host: parsed.host,
    port: parsed.port,
    valid: parsed.ok,
    invalidReason: parsed.reason || null,
  };
}

function parseServer(server) {
  let text = String(server).trim();
  if (!/^[a-z]+:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: '代理地址无法解析，示例：http://127.0.0.1:7890' };
  }
  const protocol = url.protocol.replace(':', '').toLowerCase();
  if (protocol === 'socks5' || protocol === 'socks') {
    return { ok: false, protocol, reason: '暂不支持 socks5 代理，请改用 http 代理端口。' };
  }
  if (protocol !== 'http' && protocol !== 'https') {
    return { ok: false, protocol, reason: `不支持的代理协议：${protocol}` };
  }
  const port = Number(url.port || (protocol === 'https' ? 443 : 80));
  if (!url.hostname || !Number.isInteger(port)) {
    return { ok: false, protocol, reason: '代理地址缺少主机名或端口。' };
  }
  return { ok: true, protocol, host: url.hostname, port };
}

/**
 * 自检代理到 TikTok 的连通性。
 * 返回 { ok, code, message, server, latencyMs, target, detail }。
 */
export async function checkProxy({ proxy, target = DEFAULT_TARGET, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const started = Date.now();
  const resolved = proxy && typeof proxy === 'object' && 'configured' in proxy ? proxy : resolveProxyConfig({ proxy }, process.env);
  if (!resolved.configured) {
    return {
      ok: false,
      code: PROXY_ERROR_CODES.NOT_CONFIGURED,
      message: '未配置代理。TikTok 在本机必须经代理访问，请先在配置里填写 proxy.server。',
      server: null,
      latencyMs: 0,
      target,
    };
  }
  if (!resolved.valid) {
    const code = /socks/i.test(resolved.invalidReason || '') ? PROXY_ERROR_CODES.UNSUPPORTED : PROXY_ERROR_CODES.UNREACHABLE;
    return { ok: false, code, message: resolved.invalidReason, server: resolved.server, latencyMs: 0, target };
  }
  const attempt = async () => probeThroughProxy(resolved, target, timeoutMs);
  let status;
  let lastError = null;
  for (let round = 0; round < 2; round += 1) {
    try {
      status = await attempt();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const mapped = mapProxyError(error);
      const transient = mapped.code === PROXY_ERROR_CODES.UNREACHABLE && /timeout|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up/i.test(String(error?.code || '') + String(error?.message || ''));
      if (!transient || round === 1) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  try {
    if (lastError) throw lastError;
    const latencyMs = Date.now() - started;
    if (status === 407) {
      return {
        ok: false,
        code: PROXY_ERROR_CODES.AUTH_FAILED,
        message: '代理返回 407，用户名或密码不正确。',
        server: resolved.server,
        latencyMs,
        target,
      };
    }
    if (status >= 200 && status < 500) {
      return { ok: true, code: null, message: null, server: resolved.server, latencyMs, target, httpStatus: status };
    }
    return {
      ok: false,
      code: PROXY_ERROR_CODES.TIKTOK_UNREACHABLE,
      message: `代理已连通，但 TikTok 返回异常状态 ${status}，可能被风控或需要更换出口。`,
      server: resolved.server,
      latencyMs,
      target,
      httpStatus: status,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const mapped = mapProxyError(error);
    return { ok: false, code: mapped.code, message: mapped.message, server: resolved.server, latencyMs, target, detail: mapped.detail };
  }
}

function mapProxyError(error) {
  const code = error?.code || '';
  const text = String(error?.message || '');
  if (code === 'ECONNREFUSED') {
    return { code: PROXY_ERROR_CODES.UNREACHABLE, message: '代理端口拒绝连接，请确认代理软件已启动并监听该端口。', detail: code };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { code: PROXY_ERROR_CODES.UNREACHABLE, message: '代理主机名解析失败，请检查代理地址是否写错。', detail: code };
  }
  if (code === 'ETIMEDOUT' || code === 'PROXY_TIMEOUT' || /timeout/i.test(text)) {
    return { code: PROXY_ERROR_CODES.UNREACHABLE, message: '连接代理超时，请确认代理进程和网络状态。', detail: code || 'timeout' };
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || /certificate|TLS|SSL/i.test(text)) {
    return { code: PROXY_ERROR_CODES.TIKTOK_UNREACHABLE, message: '代理隧道已建立但 TLS 握手失败，可能是中间人证书或出口被拦截。', detail: code || text.slice(0, 120) };
  }
  return { code: PROXY_ERROR_CODES.UNREACHABLE, message: `代理自检失败：${text.slice(0, 200)}`, detail: code || null };
}

/**
 * 建立 CONNECT 隧道，再在隧道内做一次 TLS + HTTP GET，返回 TikTok 的 HTTP 状态码。
 */
function probeThroughProxy(proxy, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const auth =
      proxy.username || proxy.password
        ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`
        : null;
    const headers = { Host: `${target}:443` };
    if (auth) headers['Proxy-Authorization'] = auth;
    const request = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target}:443`,
      headers,
      timeout: timeoutMs,
    });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    let tunnelSocket = null;
    let tlsSocket = null;
    const timer = setTimeout(() => {
      const error = new Error('代理自检超时');
      error.code = 'PROXY_TIMEOUT';
      fail(error);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      request.destroy();
      tunnelSocket?.destroy();
      tlsSocket?.destroy();
    };
    request.on('connect', (response, socket) => {
      tunnelSocket = socket;
      if (response.statusCode !== 200) {
        done(response.statusCode);
        return;
      }
      tlsSocket = tls.connect({ socket, servername: target, rejectUnauthorized: false }, () => {
        tlsSocket.write(`GET / HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\nUser-Agent: Mozilla/5.0\r\n\r\n`);
      });
      tlsSocket.on('data', (chunk) => {
        const line = String(chunk).split('\r\n')[0] || '';
        const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(line);
        if (match) done(Number(match[1]));
      });
      tlsSocket.on('error', fail);
      tlsSocket.on('close', () => {
        if (!settled) {
          const error = new Error('TLS 隧道在收到响应前关闭');
          error.code = 'TLS_CLOSED';
          fail(error);
        }
      });
    });
    request.on('timeout', () => {
      const error = new Error('代理连接超时');
      error.code = 'ETIMEDOUT';
      fail(error);
    });
    request.on('error', fail);
    request.end();
  });
}
