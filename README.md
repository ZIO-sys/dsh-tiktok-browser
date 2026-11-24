# tiktok-browser（dsh-tiktok-browser-local）

关键词驱动的 TikTok 广告投放素材采集插件：**只读浏览**（不点赞、不评论、不转发、不关注），按关键词自动翻搜索结果、命中即下载、按关键词分目录归档，并用规则 + 视觉模型给每条素材打分，筛出适合投放的素材。

## 安装与启用

插件目录即 `tiktok-browser/`，通过 DSH 本地插件机制加载（`package.json` + `cordis.bundle.yml` + `dsh-plugin.mjs`）。启用后对话里出现 14 个 `tiktok_*` 工具，并在 DSH 设置侧栏增加“刷 TikTok”。

### 安装（三种方式任选）

**方式一：直接填 npm 包名（推荐，不需要 git）**

在 DSH 的设置 → 插件 → 添加插件 里，`target` 填：

```
dsh-tiktok-browser-local@0.2.6
```

包管理器会自动下载插件并安装它的依赖（`playwright-core`），装完即可用。

**方式二：从 GitHub 装**

```powershell
git clone https://github.com/ZIO-sys/dsh-tiktok-browser.git
```

然后在 DSH 里任选一种方式装上这个目录：

- **图形界面**：设置 → 插件（Plugins）→ 添加插件 → 选择刚克隆下来的 `dsh-tiktok-browser` 目录；
- **对话工具**：`plugin_manager` 的 `action: "install_bundle"`，`target` 填该目录的绝对路径。

用这种方式装，装完还要在该目录执行一次 `pnpm install`（或 `npm install`），把 `playwright-core` 依赖装上。

**方式三：拷目录（目标机器不能上网、也没有 git 时）**

把整个 `dsh-tiktok-browser` 目录拷到目标机器，按方式二的图形界面/对话工具装上，再在该目录执行 `pnpm install`。

装好后确认插件状态为已应用（applied），侧栏出现「刷 TikTok」即可。本插件是 Host-only bundle，没有构建步骤；安装时 DSH 把这个目录作为本地插件链接进来，不会复制文件，所以**不要删除克隆/拷贝下来的目录**，否则插件会失效。升级就是 `git pull`（或重新下载）后重启 DSH。

### 依赖说明（0.2.6 起）

从 0.2.6 开始，`playwright-core` 是本插件的正式依赖（`package.json` 的 `dependencies`），**不需要你单独安装**：走 npm 包名安装时包管理器会自动装好。插件对它的加载是**惰性**的——缺依赖时插件本身仍能正常注册，设置页和自检都能打开，只有在真正要开浏览器时才会提示缺什么、怎么补。

如果你用「拷目录」方式安装且没跑 `pnpm install`，自检里「浏览器驱动 playwright-core」会显示未通过，此时在该目录执行 `pnpm install`，或在 DSH 的 profile 目录执行 `pnpm add playwright-core` 即可。

## 图形设置页

设置侧栏“刷 TikTok”包含：

- **基础设置**：DSH/自定义 OpenAI 兼容模型、代理、归档目录、CDP 端口
- **样例与画像**：流式上传视频、生成素材筛选画像与独立观看兴趣画像
- **视频观看**：目标种子词、AI 扩展预览、搜索/目标语言、每词条数、token 上限、启动/停止
- **下载与归档**：可编辑归档绝对路径、Windows 原生文件夹选择器、page/aix/auto 通道、AIX 检测、URL 页面抓取兜底与人工接管
- **自检与用量**：Edge/代理/模型/AIX 自检、token 账本、日报生成

设置后端位于 `native-settings.mjs` / `native-settings-transport.mjs`，只接受本机同源请求、会话 token、字段白名单和脱敏 DTO；API Key 保存后不回显。

### AIX 无水印下载

插件会自动检测专用 Edge profile 中的 AIX 智能下载器。当前 TikTok CDN 会拒绝 AIX 原生 `chrome.downloads` 请求；启用 `download.aix.allowAixUrlPageFetch` 后，会使用 AIX 捕获的无水印媒体地址，在 TikTok 页面上下文中抓取，并校验 MP4 文件头、最小体积和视频时长后再归档。默认下载通道仍为 `page`。

运行时数据目录默认 `~/.dsh/tiktok-browser/`，可用环境变量 `TIKTOK_BROWSER_HOME` 覆盖（开发时指向工作区 `.tiktok-live/`）。

## 必需环境

| 项 | 说明 |
| --- | --- |
| 代理 | 需要能访问 TikTok 的 HTTP 代理。用环境变量 `TIKTOK_PROXY_SERVER` 指定，或在设置页 / `config.json` 的 `proxy.server` 里填（示例 `http://127.0.0.1:7890`，端口按你自己的代理软件填）。TikTok 直连不可用。 |
| 浏览器 | 使用本机 Microsoft Edge（`channel: msedge`），以 CDP 方式启动，登录态持久化在 `browser-profile/`。 |
| 登录 | 首次需在 Edge 窗口里手动登录一次 TikTok；之后 `sessionid` 等 cookie 跨进程持久化，无需重复登录。 |
| ffmpeg | 抽帧用。优先 `TIKTOK_FFMPEG`，否则自动扫描 `%APPDATA%\Python\Python3*\site-packages\imageio_ffmpeg\binaries\ffmpeg*.exe`。 |
| 视觉模型 | 任意 OpenAI 兼容的多模态接口（本地部署或云端均可）。在设置页「模型来源」里选「自定义 OpenAI 兼容接口」并填 Base URL / API Key / 模型名；也可用环境变量 `TIKTOK_JUDGE_API_KEY` / `TIKTOK_JUDGE_BASE_URL` / `TIKTOK_JUDGE_MODEL`。都不填时回退到 DSH 当前的默认模型。 |

## 工具清单（14）

| 工具 | 作用 |
| --- | --- |
| `tiktok_open` | 启动 Edge（CDP）并打开 TikTok；可带关键词直接进搜索页。 |
| `tiktok_status` | 读当前页面、播放状态、代理与登录态。 |
| `tiktok_search` | 关键词搜索，滚动加载候选并逐条提取详情；可选 `download` 直接下载、`judge` 直接判定。 |
| `tiktok_download` | 按关键词或 `videoIds` 下载候选（已归档自动跳过）。 |
| `tiktok_candidates` | 查询候选库（按状态过滤）。 |
| `tiktok_export` | 导出候选库为 CSV（`state/exports/candidates-YYYY-MM-DD.csv`，UTF-8 BOM）。 |
| `tiktok_judge` | 对已入库候选做规则 + 模型打分，写 `accepted` / `rejected`。 |
| `tiktok_profiles` | 列出画像卡（默认 AR 滤镜 / 益智解谜 + 自动生成的）。 |
| `tiktok_diagnostics` | 自检：node / Edge / 代理配置 / 代理连通性 / 浏览器状态。 |
| `tiktok_library_list` | 列样例库。 |
| `tiktok_library_add` | 导入样例（本地 mp4 或 TikTok 链接），抽帧 + 模型描述，存 sidecar。 |
| `tiktok_profile_build` | 用样例聚合生成画像卡，可选按样例分布校准阈值。 |
| `tiktok_collect` | 多关键词批量采集：搜索 → 提取 → 下载 → 判定，支持断点续跑（当天已成功的关键词自动跳过）。 |
| `tiktok_report` | 生成 Markdown 日报到 `state/reports/report-YYYY-MM-DD.md`。 |
| `tiktok_config` | 读/改 `config.json`（不传 `patch` 为只读）。 |

## 数据布局

```
<runtime>/
  config.json                    # 配置（阈值、每关键词条数、代理等）
  state/
    candidates.jsonl             # 候选库（同 videoId 后写覆盖）
    seen.jsonl                   # 已见 videoId（跨关键词去重）
    runs.jsonl                   # 每次 search/collect 的运行记录
    reports/report-YYYY-MM-DD.md # 日报
  control/
    halt.json                    # 出现验证码/风控时的挂起标记（删除即恢复）
  library/
    samples/<sampleId>.mp4       # 样例视频
    sample-index.json            # 样例索引（含 features）
    profiles/<id>.json           # 自动生成的画像卡
    _rejected/<videoId>.json     # 被判拒的素材记录（只存 JSON）
  downloads/<keyword-slug>/<date>/<videoId>.mp4 + <videoId>.json
```

## 判定逻辑

- **规则分**（`collect/judge-rule.mjs`，起分 50）：关键词命中 +6/个（上限 +24）、mustHave +8/个（上限 +24）、niceToHave +4/个、时长 15–30s +12、竖屏 +6；`mustNot` 命中直接否决。
- **模型分**（`collect/judge-model.mjs`）：抽 3–5 帧 + 文案发给多模态模型，返回 0–100 与理由；接口默认流式（SSE）已兼容，解析带括号配平 + 字段兜底。
- **最终分** = `0.4 × 规则分 + 0.6 × 模型分`，低于画像阈值（默认 60，冷启动 50）判 `rejected`。

## 已知限制

- TikTok 对高频搜索会弹验证码；命中后 `collect` 写 `control/halt.json` 并中止，删掉该文件可续跑。
- `downloads/` 下的 CDN 签名地址有时效，必须「拿到就下」，不能缓存隔夜。
- 下载走页面内 `fetch(credentials:'include')`，因为签名 CDN 直连（含 Playwright `page.request`）会被 403 / ECONNRESET。
- 设置通过图形页和 `tiktok_config` 工具共享同一 SettingsService；未知字段、越界值会被拒绝。
- AIX 原生 `chrome.downloads` 对部分 TikTok CDN 返回 `SERVER_FORBIDDEN` 或超时；当前推荐启用“AIX 无水印 URL + 页面抓取”兜底。

## 使用须知与免责声明

- 本插件只做**只读浏览**：不点赞、不评论、不转发、不关注、不发私信，也不修改账号数据。
- 请自行遵守 TikTok 的服务条款与当地法律法规；高频请求会触发验证码或风控，风险由使用者自行承担。
- 采集到的视频版权归原作者所有，仅可用于内部选品/素材参考，请勿二次分发或用于侵权用途。
- 插件不会上传你的 cookie、代理账号或 API Key；运行时数据都留在本机（默认 `~/.dsh/tiktok-browser/`）。
- 本项目按 MIT 协议开源，作者不对使用后果提供担保。

## 开发

开发脚本在 `dev/`（冒烟测试、探针、离线单测），不参与插件分发。运行需：

```powershell
$env:NODE_PATH="<你的 DSH profile 目录>/node_modules"
$env:TIKTOK_BROWSER_HOME="<工作区>/.tiktok-live"
$env:TIKTOK_PROXY_SERVER="http://127.0.0.1:7890"
node dev/test-m6-batch.mjs "关键词A" "关键词B"
```
