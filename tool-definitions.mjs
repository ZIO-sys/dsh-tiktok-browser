// tool-definitions.mjs — M1 工具定义（tiktok_open / tiktok_status / tiktok_diagnostics）。

export const TOOL_DEFINITIONS = [
  {
    name: 'tiktok_open',
    description:
      '打开专用 Microsoft Edge 窗口并进入 TikTok。启动前会先检查代理，代理不可用时直接返回错误码而不打开页面。返回浏览器状态、页面状态与是否需要登录或验证。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string', description: '可选关键词；填写时打开搜索页，留空则打开首页。' },
        reuse: { type: 'boolean', description: '是否复用已打开的专用窗口，默认 true。' },
      },
      required: [],
    },
  },
  {
    name: 'tiktok_status',
    description: '读取 TikTok 专用浏览器的当前状态：进程、端口、页面地址、标题、登录与验证标记。',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'tiktok_search',
    description:
      '在 TikTok 搜索页按关键词搜索，滚动收集作品卡片，并逐条打开作品页提取完整字段（标题、作者、统计、音乐、视频地址）。结果写入本地候选库。只读浏览，不点赞、不评论、不转发。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '搜索关键词，例如 "desk setup" 或 "capcut template"。' },
        limit: { type: 'integer', description: '本次最多处理多少条作品，默认取配置 search.maxResultsPerKeyword（40）。' },
        detail: { type: 'boolean', description: '是否逐条打开作品页提取完整字段，默认 true；false 时只记录搜索结果卡片。' },
        download: { type: 'boolean', description: '是否在提取成功后立刻下载视频并归档到 downloads/<关键词>/<日期>/，默认 false。' },
        preferNoWatermark: { type: 'boolean', description: '是否优先无水印地址（playAddr），默认 true（downloadAddr 带 TikTok 水印，只在 playAddr 失败时兜底）。' },
        judge: { type: 'boolean', description: '是否在提取（或下载）后立即按画像打分，默认 false。开启后命中阈值的记为 accepted，未命中的记为 rejected 并只留 JSON。' },
        profileId: { type: 'string', description: '打分使用的画像 ID，例如 "ar-filter-game" 或 "puzzle-match3"；judge 为 true 时缺省取配置里的第一个画像。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'tiktok_download',
    description:
      '把本地候选库里尚未归档的作品下载到 downloads/<关键词>/<日期>/<videoId>.mp4，并写同名 .json 元数据。已存在同名文件时跳过。只下载，不点赞、不评论、不转发。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '只下载该关键词下的候选；留空则不限关键词。' },
        videoIds: { type: 'array', items: { type: 'string' }, description: '指定作品 ID 列表，优先于 query。' },
        limit: { type: 'integer', description: '最多下载几条，默认 10，范围 1–200。' },
        preferNoWatermark: { type: 'boolean', description: '优先无水印地址（playAddr），默认 true；false 时用带水印的 downloadAddr。' },
      },
      required: [],
    },
  },
  {
    name: 'tiktok_candidates',
    description: '读取本地候选库：已发现的视频及其字段、各状态数量、当前是否有验证码挂起。不打开浏览器。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['discovered', 'extracted', 'extract_failed', 'scored', 'accepted', 'archived', 'download_failed', 'rejected', 'skipped_language', 'duplicate'],
          description: '可选，按状态过滤。',
        },
        limit: { type: 'integer', description: '返回条数，默认 50，范围 1–500。' },
      },
      required: [],
    },
  },
  {
    name: 'tiktok_export',
    description:
      '把本地候选库导出为 CSV（state/exports/candidates-YYYY-MM-DD.csv，UTF-8 BOM，Excel 直接打开中文不乱码）。支持按状态、关键词、最近天数过滤，行数与设置页“素材库”的筛选结果一致。只读候选库，不发请求、不调模型。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'discovered', 'extracted', 'extract_failed', 'scored', 'accepted', 'archived', 'download_failed', 'rejected', 'skipped_language', 'duplicate'],
          description: '可选，按状态过滤；all 或留空导出全部。',
        },
        query: { type: 'string', description: '可选，按关键词/作者/videoId/文案过滤。' },
        sinceDays: { type: 'integer', description: '可选，只导出最近 N 天更新的候选；0 表示不限。' },
      },
      required: [],
    },
  },
  {
    name: 'tiktok_judge',
    description:
      '对已入库候选做素材判定：规则分（关键词/画像/时长/画幅/mustNot 否决）+ 视觉模型分（抽关键帧问多模态模型匹配度），加权得出总分，低于阈值标记 rejected 并删除视频只留 JSON。只读判定，不点赞、不评论、不转发。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '只判定该关键词下的候选；留空则不限关键词。' },
        videoIds: { type: 'array', items: { type: 'string' }, description: '指定作品 ID 列表，优先于 query。' },
        limit: { type: 'integer', description: '最多判定几条，默认 10，范围 1–200。' },
        profileId: { type: 'string', description: '画像 ID，如 ar-filter-game / puzzle-match3；留空用默认画像。' },
      },
      required: [],
    },
  },
  {
    name: 'tiktok_profiles',
    description: '列出当前可用的素材画像（mustHave / niceToHave / mustNot / 阈值）与判定配置（阈值、模型权重、模型名）。不打开浏览器。',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'tiktok_diagnostics',
    description: '运行本机自检：Node 版本、Edge 安装、代理配置与连通性、浏览器进程与页面状态。不启动浏览器、不发送任何内容。',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'tiktok_library_list',
    description: '查看样例库：已导入的样例数量、按画像分布、每条样例的文件与模型视觉描述。不打开浏览器、不下载。',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'tiktok_library_add',
    description: '导入一条样例到样例库（用于生成/校准素材画像）。可传本地视频路径 file，或传已下载候选的 videoId。会复制文件、抽 3 帧、调用视觉模型生成结构化描述。polarity=negative 表示“不想要的素材”，其视觉标签会进入画像的 mustNot。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '本地视频文件绝对路径（.mp4/.mov/.webm/.mkv）。' },
        videoId: { type: 'string', description: '已归档候选的 videoId，二选一。' },
        profileId: { type: 'string', description: '归属画像 id，可留空。' },
        polarity: { type: 'string', enum: ['positive', 'negative'], description: '样例极性：positive（默认，要的素材）或 negative（反样例，只贡献 mustNot）。' },
        describe: { type: 'boolean', description: '是否调用视觉模型生成描述，默认 true。' },
      },
      required: [],
    },
  },
  {
    name: 'tiktok_profile_build',
    description: '用样例库里的样例生成（或重建）一张画像卡：聚合关键词与视觉标签，产出 mustHave / niceToHave / mustNot / 阈值。calibrate=true 时按样例规则分分位校准阈值。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profileId: { type: 'string', description: '画像 id，例如 ar-filter-game。' },
        name: { type: 'string', description: '画像显示名。' },
        threshold: { type: 'integer', description: '手动指定阈值 0-100；留空则自动。' },
        calibrate: { type: 'boolean', description: '是否按样例规则分校准阈值，默认 false。' },
        minSamples: { type: 'integer', description: '最少样例数，默认 3。' },
      },
      required: ['profileId'],
    },
  },
  {
    name: 'tiktok_collect',
    description: '批量采集：按关键词列表逐个搜索并（默认）下载、判定。支持断点续跑——今天已成功跑过的关键词自动跳过。中途遇到验证码会整体挂起并停止后续关键词。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '关键词列表，按顺序跑。',
        },
        maxPerRun: { type: 'integer', description: '每个关键词最多取多少条，默认 40，范围 1-200。' },
        profileId: { type: 'string', description: '判定用画像 id，例如 ar-filter-game。' },
        download: { type: 'boolean', description: '是否边搜边下载，默认 true。' },
        judge: { type: 'boolean', description: '是否边搜边判定，默认 true。' },
        resume: { type: 'boolean', description: '是否跳过今天已成功的关键词，默认 true。' },
        pauseMs: { type: 'integer', description: '关键词之间的间隔毫秒，默认 4000。' },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'tiktok_report',
    description: '生成本地 Markdown 采集报告：运行记录、状态分布、按关键词统计、失败原因、被拒理由。只读本地状态，不发请求、不调模型。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sinceDays: { type: 'integer', description: '统计最近多少天，默认 1。' },
      },
      required: [],
    },
  },
  {
    name: 'tiktok_config',
    description:
      '读取或修改插件配置（config.json）。不传 patch 时返回当前配置；传 patch 时做合并式更新并落盘。可改代理、搜索条数、判定阈值与模型参数等。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        patch: {
          type: 'object',
          description: '要合并进配置的对象，例如 {"judge":{"threshold":65},"search":{"maxResultsPerKeyword":30}}。省略则只读。',
        },
      },
      required: [],
    },
  },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((item) => item.name);
