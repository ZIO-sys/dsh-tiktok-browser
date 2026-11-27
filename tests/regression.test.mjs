import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchSettings } from '../native-settings-transport.mjs';
import { runDiagnostics } from '../diagnostics.mjs';
import { createSettingsService } from '../services/settings-service.mjs';
import { createModelGateway, resolveModelRoute } from '../services/model-gateway.mjs';
import { parseProxyServer, resolveProxyMode } from '../services/system-proxy.mjs';

const NO_PROXY_ENV = Object.freeze({});

test('自动代理模式兼容配置、代理池和环境变量', () => {
  assert.equal(resolveProxyMode({}, NO_PROXY_ENV), 'system');
  assert.equal(resolveProxyMode({ proxy: { mode: 'auto' } }, NO_PROXY_ENV), 'system');
  assert.equal(resolveProxyMode({ proxy: { server: 'http://127.0.0.1:7890' } }, NO_PROXY_ENV), 'manual');
  assert.equal(resolveProxyMode({ proxy: { pool: ['http://127.0.0.1:7890'] } }, NO_PROXY_ENV), 'manual');
  assert.equal(resolveProxyMode({ proxy: { pool: ['', '  '] } }, NO_PROXY_ENV), 'system');
  assert.equal(resolveProxyMode({}, { TIKTOK_PROXY_SERVER: 'http://127.0.0.1:7890' }), 'manual');
  assert.equal(resolveProxyMode({ proxy: { mode: 'auto' } }, { TIKTOK_PROXY_SERVER: 'http://127.0.0.1:7890' }), 'manual');
  assert.equal(resolveProxyMode({ proxy: { mode: 'system', server: 'http://127.0.0.1:7890' } }, NO_PROXY_ENV), 'system');
  assert.equal(resolveProxyMode({ proxy: { mode: 'manual' } }, NO_PROXY_ENV), 'manual');
});

test('Windows 代理地址解析保留 SOCKS 协议以便明确拒绝', () => {
  assert.equal(parseProxyServer('127.0.0.1:7890'), '127.0.0.1:7890');
  assert.equal(parseProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891'), '127.0.0.1:7891');
  assert.equal(parseProxyServer('socks=127.0.0.1:1080'), 'socks://127.0.0.1:1080');
  assert.equal(parseProxyServer('proxy-with-default-port'), 'proxy-with-default-port');
  assert.equal(parseProxyServer(''), null);
});

test('默认模型实时读取宿主选择，并支持跨提供商覆盖', () => {
  const host = { currentSelection: () => ({ provider: 'workbuddy', model: 'glm-5.2' }) };
  const route = resolveModelRoute({ config: { model: { source: 'legacy' } }, env: NO_PROXY_ENV, agentDefaultModel: host });
  assert.equal(route.provider, 'workbuddy');
  assert.equal(route.model, 'glm-5.2');

  const overridden = resolveModelRoute({
    config: { model: { source: 'legacy', textModel: 'other/deepseek-v4-flash' } },
    kind: 'text',
    env: NO_PROXY_ENV,
    agentDefaultModel: host,
  });
  assert.equal(overridden.provider, 'other');
  assert.equal(overridden.model, 'deepseek-v4-flash');

  const qualifiedId = resolveModelRoute({
    config: { model: { source: 'dsh', textModel: 'workbuddy/openai/gpt-4o' } },
    kind: 'text',
    env: NO_PROXY_ENV,
    agentDefaultModel: host,
  });
  assert.equal(qualifiedId.provider, 'workbuddy');
  assert.equal(qualifiedId.model, 'openai/gpt-4o');
});

test('实际模型调用使用覆盖项指定的提供商和模型', async () => {
  const calls = [];
  const llm = {
    async resolveModelInfo(provider, model) {
      calls.push({ type: 'resolve', provider, model });
      return { inputModalities: ['text'], reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } };
    },
    async *stream(input) {
      calls.push({ type: 'stream', input });
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield { type: 'usage', usage: { total_tokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const gateway = createModelGateway({
    config: { model: { source: 'legacy', textModel: 'other/deepseek-v4-flash' } },
    env: NO_PROXY_ENV,
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'workbuddy', model: 'glm-5.2', reasoningEffort: 'high' }) },
  });
  const result = await gateway.chat({ kind: 'text', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(result.ok, true, result.message);
  assert.equal(calls[0].provider, 'other');
  assert.equal(calls[0].model, 'deepseek-v4-flash');
  assert.equal(calls[1].input.provider, 'other');
  assert.equal(calls[1].input.model, 'deepseek-v4-flash');
});

test('自定义 OpenAI 接口不会截断包含斜杠的模型 ID', () => {
  const route = resolveModelRoute({
    config: {
      model: {
        source: 'openai-compatible',
        textModel: 'openai/gpt-4o',
        api: { baseUrl: 'https://example.invalid/v1', model: 'fallback-model' },
      },
    },
    kind: 'text',
    env: NO_PROXY_ENV,
    agentDefaultModel: null,
  });
  assert.equal(route.source, 'openai-compatible');
  assert.equal(route.provider, null);
  assert.equal(route.model, 'openai/gpt-4o');
});

test('旧代理凭据不回显，保存时清理，代理模式可切回自动', () => {
  const root = mkdtempSync(join(tmpdir(), 'tiktok-browser-settings-'));
  const configFile = join(root, 'config.json');
  try {
    writeFileSync(configFile, JSON.stringify({
      proxy: { mode: 'system', username: 'legacy-user', password: 'legacy-secret' },
      model: { api: { apiKey: 'model-secret' } },
    }), 'utf8');
    const service = createSettingsService({ paths: { configFile } });
    const before = service.public();
    assert.equal(before.config.proxy.username, undefined);
    assert.equal(before.config.proxy.password, undefined);
    assert.equal(before.config.model.api.apiKey, undefined);
    assert.equal(before.credentials.modelApiKey.configured, true);

    const updated = service.update({ proxy: { mode: 'auto' } });
    assert.equal(updated.config.proxy.mode, 'auto');
    assert.equal(service.raw().proxy.username, undefined);
    assert.equal(service.raw().proxy.password, undefined);
    assert.equal(readFileSync(configFile, 'utf8').includes('legacy-secret'), false);

    const legacyEmpty = service.update({ proxy: { mode: '' } });
    assert.equal(legacyEmpty.config.proxy.mode, '');
    assert.equal(resolveProxyMode(service.raw(), NO_PROXY_ENV), 'system');
    assert.throws(() => service.update({ proxy: { mode: 'invalid' } }), /proxy\.mode/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('系统代理检测路由已通过原生设置传输层白名单', async () => {
  const route = {
    handler(request, response) {
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, url: request.url, token: request.headers['x-tiktok-settings-token'] }));
    },
  };
  const outcome = await dispatchSettings(route, { path: '/proxy/system', input: {}, token: 'test-token' });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.ok, true);
  assert.equal(outcome.body.url, '/api/tiktok-browser/proxy/system');
  assert.equal(outcome.body.token, 'test-token');

  const rejected = await dispatchSettings(route, { path: '/not-allowed', input: {}, token: 'test-token' });
  assert.equal(rejected.status, 400);
});

test('自检识别固定系统代理和 PAC，不再误报手动地址为空', async () => {
  let checked = 0;
  const common = {
    paths: { browserProfileDir: join(tmpdir(), 'tiktok-browser-test-no-profile'), browserControlDir: null },
    env: NO_PROXY_ENV,
    probe: () => ({ ok: true, path: 'edge' }),
    readState: () => null,
  };
  const fixed = await runDiagnostics({
    ...common,
    config: { proxy: { mode: 'system' } },
    systemProxyProbe: async () => ({ supported: true, enabled: true, server: '127.0.0.1:7890', pacUrl: null }),
    proxyCheck: async ({ proxy }) => {
      checked += 1;
      assert.equal(proxy.server, '127.0.0.1:7890');
      return { ok: true, server: proxy.server, target: 'www.tiktok.com', latencyMs: 1 };
    },
  });
  assert.equal(fixed.checks.find((item) => item.id === 'proxy-config').ok, true);
  assert.equal(fixed.checks.find((item) => item.id === 'proxy-connectivity').ok, true);
  assert.equal(checked, 1);

  const pac = await runDiagnostics({
    ...common,
    config: { proxy: { mode: 'system' } },
    systemProxyProbe: async () => ({ supported: true, enabled: false, server: null, pacUrl: 'https://example.invalid/proxy.pac' }),
    proxyCheck: async () => { throw new Error('PAC 模式不应做手动代理探测'); },
  });
  assert.equal(pac.checks.find((item) => item.id === 'proxy-config').ok, true);
  assert.match(pac.checks.find((item) => item.id === 'proxy-connectivity').detail, /PAC/);
});

test('发布包包含系统代理模块且版本为 v0.2.8', async () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.version, '0.2.8');
  assert.equal(packageJson.dsh.bundle.files.includes('services/system-proxy.mjs'), true);
  for (const file of packageJson.dsh.bundle.files) {
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), true, `发布包缺少文件：${file}`);
  }
});
