// dsh-plugin.mjs — DSH 插件入口：注册 tiktok_* 工具与 /tiktok-open 命令。

import { TOOL_DEFINITIONS } from './tool-definitions.mjs';
import { RunService } from './services/run-service.mjs';
import { createNativeSettingsRoute } from './native-settings.mjs';
import { bindNativeSettingsRoutes } from './native-settings-transport.mjs';

export const name = 'tiktok-browser';
export const inject = ['tools'];

const NATIVE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string' },
    result: { type: 'object', additionalProperties: true },
    images: { type: 'array', items: { type: 'string' } },
    imageStatus: { type: 'string' },
  },
  required: ['tool', 'result', 'images', 'imageStatus'],
};

/**
 * DSH 的工具参数 schema 只支持 JSON Schema 子集，约束关键字要在运行时剔除。
 */
export function nativeParameters(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const copy = { ...schema };
  delete copy.minLength;
  delete copy.maxLength;
  delete copy.minimum;
  delete copy.maximum;
  delete copy.pattern;
  if (copy.properties && typeof copy.properties === 'object') {
    copy.properties = Object.fromEntries(
      Object.entries(copy.properties).map(([key, value]) => [key, nativeParameters(value)]),
    );
  }
  if (copy.items) copy.items = nativeParameters(copy.items);
  return copy;
}

export function renderNativeValue(_args, value) {
  const { tool, result, imageStatus } = value;
  return [
    { type: 'text', text: JSON.stringify({ tool, ...result, imageStatus }, null, 2) },
  ];
}

function createNativeToolDefinitions({ getController }) {
  return TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    parameters: nativeParameters(definition.parameters),
    timeoutMs: 90_000,
    output: { schema: NATIVE_OUTPUT_SCHEMA, render: renderNativeValue },
    async execute(args, exec = {}) {
      exec.signal?.throwIfAborted?.();
      const controller = await getController();
      const result = await controller.execute(definition.name, args || {}, { signal: exec.signal });
      return { tool: definition.name, result, images: [], imageStatus: 'none' };
    },
  }));
}

function createNativeLaunchCommand({ getController }) {
  return {
    name: 'tiktok-open',
    description: '打开 TikTok 专用浏览器窗口（先自检代理，再启动 Edge）。',
    recordInput: false,
    async handler({ signal } = {}) {
      const controller = await getController();
      const result = await controller.open({ signal });
      const text = result.opened
        ? `已打开 TikTok（${result.mode}）${result.keyword ? `：${result.keyword}` : ''}\n${result.url}`
        : `打开失败：${result.code}\n${result.message}`;
      return { text };
    },
  };
}

function optionalService(ctx, name) {
  try {
    return ctx?.get?.(name) || null;
  } catch {
    return null;
  }
}

export async function apply(ctx, config = {}) {
  const disposers = [];
  let controllerPromise = null;
  let disposed = false;
  let settingsFiber = null;

  const getController = () => {
    if (disposed) throw new Error('插件已卸载。');
    controllerPromise ??= import('./core.mjs').then(({ BrowserController }) => new BrowserController({
      config,
      llm: optionalService(ctx, 'llm'),
      attachments: optionalService(ctx, 'attachments'),
    }));
    return controllerPromise;
  };

  const runService = new RunService({
    controller: {
      expandAndCollect: (input) => getController().then((controller) => controller.expandAndCollect(input)),
    },
  });

  const definitions = createNativeToolDefinitions({ getController });
  for (const tool of definitions) disposers.push(ctx.tools.register(tool));

  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (commandCtx) => {
      disposers.push(commandCtx.commands.register(createNativeLaunchCommand({ getController })));
    });
    settingsFiber = bindNativeSettingsRoutes(ctx, () => createNativeSettingsRoute({
      getController,
      getRun: () => runService,
      getDiagnostics: async () => (await getController()).diagnostics(),
    }));
    await settingsFiber.ready();
  }

  return () => {
    disposed = true;
    runService.close();
    void settingsFiber?.dispose?.().catch(() => {});
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch {
        /* 忽略卸载异常 */
      }
    }
    controllerPromise?.then((controller) => controller.close?.()).catch(() => {});
    controllerPromise = null;
  };
}
