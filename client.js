window.__ModuleLoader__.load({
  id: 'dsh-tiktok-browser-local',
  factory: (require) => {
    const React = require('react');
    const { createElement: h, useEffect, useRef, useState } = React;
    const PREFIX = '/api/tiktok-browser';
    const ROUTES = new Set([
      '/state',
      '/config/configure',
      '/keywords/expand',
      '/directory/pick',
      '/run/start',
      '/run/stop',
      '/profiles/material/build',
      '/profiles/material/save',
      '/profiles/material/delete',
      '/profiles/material/history',
      '/profiles/material/restore',
      '/library/purge',
      '/library/restore-defaults',
      '/library/candidates',
      '/library/export',
      '/library/reveal',
      '/library/sample/polarity',
      '/library/sample/delete',
      '/feedback/list',
      '/feedback/save',
      '/feedback/remove',
      '/feedback/reflow',
      '/diagnostics',
      '/proxy/pool/reset',
      '/proxy/system',
      '/retry/list',
      '/retry/clear',
      '/report/generate',
      '/report/reveal',
    ]);
    const column = { display: 'flex', flexDirection: 'column', gap: 12 };
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
    const muted = { color: 'var(--dsw-alias-label-tertiary, #666)', fontSize: 12, margin: 0, lineHeight: 1.6 };
    const control = {
      font: 'inherit',
      color: 'var(--dsw-alias-label-primary, #111)',
      background: 'var(--dsw-alias-bg-base, #fff)',
      border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
      borderRadius: 8,
      padding: '8px 10px',
      width: '100%',
      boxSizing: 'border-box',
    };
    const card = {
      border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
      borderRadius: 10,
      padding: 14,
      background: 'var(--dsw-alias-bg-base, #fff)',
    };
    const buttonStyle = {
      font: 'inherit',
      padding: '7px 12px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, #ccc)',
      background: 'var(--dsw-alias-bg-base, #fff)',
      color: 'var(--dsw-alias-label-primary, #111)',
      cursor: 'pointer',
    };
    const primaryStyle = {
      ...buttonStyle,
      background: 'var(--dsw-alias-bg-accent, #165dff)',
      borderColor: 'var(--dsw-alias-bg-accent, #165dff)',
      color: '#fff',
    };
    const dangerStyle = {
      ...buttonStyle,
      borderColor: 'var(--dsw-alias-label-danger, #c00)',
      color: 'var(--dsw-alias-label-danger, #c00)',
    };
    const CATEGORIES = ['基础设置', '样例与画像', '视频观看', '下载与归档', '素材库', '自检与用量'];
    const CANDIDATE_PAGE_SIZE = 30;
    // 素材列表只展示最近 3 天采集的素材；超期记录仅从列表隐藏，不删文件、不改库数据。
    const LIBRARY_HIDE_AFTER_DAYS = 3;
    // 服务端单次最多返回 100 条：客户端取全库快照后自己完成检索、隐藏与分页。
    const CANDIDATE_FETCH_LIMIT = 100;
    const CANDIDATE_MAX_FETCH_PAGES = 40;
    const CANDIDATE_TABLE_MIN_WIDTH = 980;
    const CANDIDATE_STATUS_LABELS = {
      discovered: '已发现',
      extracted: '已提取',
      extract_failed: '提取失败',
      scored: '已评分',
      accepted: '已通过',
      archived: '已归档',
      download_failed: '下载失败',
      rejected: '已拒绝',
      skipped_language: '语言不符',
      skipped_aspect: '画幅不符',
      duplicate: '重复',
    };
    const HISTORY_SOURCE_LABELS = { build: '生成', edit: '编辑保存', restore: '恢复前留档', import: '导入' };
    const formatHistoryAt = (value) => {
      const date = value ? new Date(value) : null;
      if (!date || Number.isNaN(date.getTime())) return '时间未知';
      return date.toLocaleString('zh-CN', { hour12: false });
    };

    function createSettingsTransport(globals = globalThis, rpc = globals.__DSH_TRANSPORT__?.rpc) {
      const carrier = globals.__DSH_TRANSPORT__;
      const address = globals.location;
      const http = address && ['http:', 'https:'].includes(address.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
      const desktop = ['dsh-app:', 'dsh:'].includes(address?.protocol) && address.hostname === 'app';
      const fetcher = typeof carrier?.fetch === 'function'
        ? carrier.fetch.bind(carrier)
        : (http || desktop) && typeof globals.fetch === 'function' ? globals.fetch.bind(globals) : null;
      let token = '';

      async function parseResponse(response) {
        let value;
        try { value = await response.json(); } catch { throw new Error(`设置接口未返回 JSON（HTTP ${response.status || '未知'}）。`); }
        if (!response.ok) throw new Error(value.error || `设置操作失败（HTTP ${response.status}）。`);
        return value;
      }

      async function request(route, input, { timeoutMs = 120_000 } = {}) {
        if (!ROUTES.has(route)) throw new Error('只允许本插件的设置接口。');
        if (input !== undefined && !token) throw new Error('请先刷新设置页。');
        if (!fetcher && typeof rpc?.call !== 'function') throw new Error('当前 DSH 页面没有可用的插件设置通信接口。');
        const signal = AbortSignal.timeout(timeoutMs);
        try {
          let response;
          if (fetcher) {
            response = await fetcher(PREFIX + route, {
              method: input === undefined ? 'GET' : 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
              signal,
              headers: {
                'content-type': 'application/json',
                ...(token ? { 'x-tiktok-settings-token': token } : {}),
              },
              ...(input === undefined ? {} : { body: JSON.stringify(input) }),
            });
          } else {
            const reply = await rpc.call('/tiktok-settings', 'request', {
              path: route,
              ...(input === undefined ? {} : { input }),
              token,
            }, signal);
            if (!reply?.ok) throw new Error(reply?.error?.message || 'DSH 设置通信失败。');
            const outcome = reply.value;
            if (!Number.isInteger(outcome?.status) || !outcome.body) throw new Error('DSH 设置接口版本不匹配。');
            response = { ok: outcome.status >= 200 && outcome.status < 300, status: outcome.status, json: async () => outcome.body };
          }
          const value = await parseResponse(response);
          if (route === '/state') {
            if (typeof value.token !== 'string' || !value.token) throw new Error('设置页没有取得有效会话。');
            token = value.token;
            const { token: hidden, ...rest } = value;
            return rest;
          }
          return value;
        } catch (error) {
          if (error.name === 'TimeoutError') throw new Error('本机设置服务响应超时。');
          throw error;
        }
      }

      async function upload(file, profileId, polarity = 'positive') {
        if (!token) throw new Error('请先刷新设置页。');
        if (!fetcher) throw new Error('当前宿主不支持流式样例上传，请更新 DSH 后重试。');
        if (!file || file.size < 10 * 1024) throw new Error('视频文件小于 10KB。');
        if (file.size > 500 * 1024 * 1024) throw new Error('视频超过 500MB。');
        const mode = polarity === 'negative' ? 'negative' : 'positive';
        const url = `${PREFIX}/upload?filename=${encodeURIComponent(file.name)}&profileId=${encodeURIComponent(profileId || '')}&polarity=${mode}`;
        const response = await fetcher(url, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': file.type || 'application/octet-stream', 'x-tiktok-settings-token': token },
          body: file,
          signal: AbortSignal.timeout(600_000),
        });
        return parseResponse(response);
      }

      return { request, upload };
    }

    // 新用户首次打开时，文本与数值输入框均不预填；留空提交时才回退到这些内部默认值。
    const INPUT_DEFAULTS = Object.freeze({
      materialThreshold: 60,
      maxResultsPerKeyword: 25,
      targetCount: 10,
      targetVideos: 20,
      videoDistance: 6,
      textSimilarity: 0.85,
    });

    function numberInputValue(value) {
      return value === '' ? '' : Number(value);
    }

    function numberOrDefault(value, fallback) {
      return value === '' || value === null || value === undefined ? fallback : Number(value);
    }

    function normalize(config = {}) {
      return {
        downloadsDir: String(config.downloadsDir || ''),
        rejectedDir: String(config.storage?.rejectedDir || ''),
        port: numberInputValue(config.port ?? ''),
        proxy: {
          mode: ['auto', 'system', 'manual'].includes(config.proxy?.mode) ? config.proxy.mode : 'auto',
          server: String(config.proxy?.server || ''),
          pool: (Array.isArray(config.proxy?.pool) ? config.proxy.pool : []).join('\n'),
        },
        model: {
          source: String(config.model?.source || 'legacy'),
          provider: String(config.model?.provider || ''),
          model: String(config.model?.model || ''),
          textModel: String(config.model?.textModel || ''),
          visionModel: String(config.model?.visionModel || ''),
          api: {
            baseUrl: String(config.model?.api?.baseUrl || config.judge?.api?.baseUrl || ''),
            apiKey: '',
            model: String(config.model?.api?.model || config.judge?.api?.model || ''),
          },
        },
        search: {
          maxResultsPerKeyword: numberInputValue(config.search?.maxResultsPerKeyword ?? ''),
          tokenBudget: numberInputValue(config.search?.tokenBudget ?? ''),
          dailyTokenBudget: numberInputValue(config.search?.dailyTokenBudget ?? ''),
          targetCount: numberInputValue(config.search?.targetCount ?? ''),
          targetVideos: numberInputValue(config.search?.targetVideos ?? ''),
          queryLanguage: String(config.search?.queryLanguage || 'en'),
          contentLanguage: String(config.search?.contentLanguage || 'auto'),
          defaultProfileId: String(config.search?.defaultProfileId || ''),
        },
        judge: {
          threshold: Number(config.judge?.threshold ?? 60),
          modelWeight: Number(config.judge?.modelWeight ?? 0.6),
          prefilter: String(config.judge?.prefilter || 'off'),
        },
        dedup: {
          enabled: config.dedup?.enabled === true,
          videoDistance: numberInputValue(config.dedup?.videoDistance ?? ''),
          textSimilarity: numberInputValue(config.dedup?.textSimilarity ?? ''),
        },
        download: {
          channel: String(config.download?.channel || 'page'),
          preferNoWatermark: config.download?.preferNoWatermark !== false,
          aix: {
            allowAixUrlPageFetch: config.download?.aix?.allowAixUrlPageFetch === true,
            manualFallback: config.download?.aix?.manualFallback !== false,
            allowPageFallback: config.download?.aix?.allowPageFallback === true,
          },
        },
      };
    }

    function patchAt(object, path, value) {
      const next = structuredClone(object);
      let current = next;
      for (let index = 0; index < path.length - 1; index += 1) current = current[path[index]];
      current[path[path.length - 1]] = value;
      return next;
    }

    const toLines = (list) => (Array.isArray(list) ? list.join('\n') : '');
    const parseLines = (text) => String(text || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 40);
    // 种子词/排除词允许换行或逗号、分号分隔，去重后限制条数（后端 stringArray 有上限）。
    const parseTerms = (text, maxItems = 20) => [...new Set(String(text || '').split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean))].slice(0, maxItems);

    function materialDraftFrom(profile) {
      if (!profile?.id) return null;
      return {
        id: profile.id,
        name: profile.name || '',
        threshold: Number(profile.threshold) || 60,
        guidance: profile.guidance || '',
        keywords: toLines(profile.keywords),
        mustHave: toLines(profile.mustHave),
        niceToHave: toLines(profile.niceToHave),
        mustNot: toLines(profile.mustNot),
      };
    }

    const LANGUAGES = [
      ['auto', '自动（只记录）'],
      ['en', '英语'], ['es', '西班牙语'], ['pt', '葡萄牙语'], ['id', '印尼语'], ['ja', '日语'],
      ['ko', '韩语'], ['de', '德语'], ['fr', '法语'], ['ar', '阿拉伯语'], ['th', '泰语'], ['vi', '越南语'],
    ];

    function SettingsPage({ rpc } = {}) {
      const [api] = useState(() => createSettingsTransport(globalThis, rpc));
      const [state, setState] = useState(null);
      const [draft, setDraft] = useState(() => normalize({}));
      const [category, setCategory] = useState('基础设置');
      const [ready, setReady] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState('');
      const [preview, setPreview] = useState(null);
      const [diagnostics, setDiagnostics] = useState(null);
      const [uploadStatus, setUploadStatus] = useState(null);
      const [materialDraft, setMaterialDraft] = useState(null);
      const [materialForm, setMaterialForm] = useState({ profileId: '', name: '', threshold: '' });
      const [uploadProfileId, setUploadProfileId] = useState('');
      const [purgeConfirm, setPurgeConfirm] = useState(false);
      const [profileDeleteConfirm, setProfileDeleteConfirm] = useState(null);
      const [seeds, setSeeds] = useState('');
      const [exclude, setExclude] = useState('');
      const [candidates, setCandidates] = useState(null);
      const [candidateFilter, setCandidateFilter] = useState({ status: 'all', query: '', sinceDays: 0, date: '', minScore: 0, videoId: '', page: 0, reload: 0 });
      const [candidateBusy, setCandidateBusy] = useState(false);
      const [candidateError, setCandidateError] = useState('');
      const [uploadPolarity, setUploadPolarity] = useState('positive');
      const [materialHistory, setMaterialHistory] = useState(null);
      const [historyBusy, setHistoryBusy] = useState('');
      // 注意：新增 useState 一律追加在最后，避免打乱既有索引（测试按位置注入草稿）。
      const [exportResult, setExportResult] = useState(null);
      const [reflowConfirm, setReflowConfirm] = useState(null);
      const [reflowDescribe, setReflowDescribe] = useState(false);
      const [lastSyncedAt, setLastSyncedAt] = useState('');
      // 页码跳转：输入框与提示信息（追加在最后，符合上面的 useState 位置约定）。
      const [pageInput, setPageInput] = useState('');
      // 分页提示：{ text, tone } —— tone 为 'info'（越界自动回落）或 'error'（输入不合法）。
      const [pageHint, setPageHint] = useState(null);
      // 候选库整库快照：隐藏与 videoId 检索都在客户端派生，服务端只负责状态/关键词/时间/评分过滤。
      const [candidateRows, setCandidateRows] = useState([]);
      const [candidateStatuses, setCandidateStatuses] = useState([]);
      // 系统代理探测结果（「检测系统代理」按钮写入，null 表示尚未检测）。
      const [systemProxy, setSystemProxy] = useState(null);
      // 样例子库的文件夹导航：null = 画像文件夹列表（根）；否则为进入的画像 id（'unassigned' 表示未归属）。
      const [sampleFolder, setSampleFolder] = useState(null);
      // 进入画像文件夹后选中的子文件夹极性：'positive' | 'negative'（null 表示还停在正/反样例选择层）。
      const [sampleFolderPolarity, setSampleFolderPolarity] = useState(null);
      // 待确认删除的样例 id（非空时渲染删除确认条）。
      const [sampleDeleteConfirm, setSampleDeleteConfirm] = useState(null);
      const initialized = useRef(false);
      const alive = useRef(true);
      // 素材列表横向滚动：容器与底部代理滚动条双向同步，保证滚动条不必翻到页面底部才可见。
      const tableScrollRef = useRef(null);
      const tableProxyRef = useRef(null);

      function clockText() {
        return new Date().toLocaleTimeString('zh-CN', { hour12: false });
      }

      async function refresh(resetDraft = false) {
        try {
          const value = await api.request('/state', undefined, { timeoutMs: 25_000 });
          if (!alive.current) return value;
          setState(value);
          setError('');
          setReady(true);
          if (!initialized.current || resetDraft) {
            setDraft(normalize(value.settings?.config));
            // 回填已保存的种子词/排除词；配置里还没有这两个键时保持首次空白。
            const savedSearch = value.settings?.config?.search || {};
            if (Array.isArray(savedSearch.seeds)) setSeeds(savedSearch.seeds.join('\n'));
            if (Array.isArray(savedSearch.exclude)) setExclude(savedSearch.exclude.join('\n'));
            initialized.current = true;
          }
          return value;
        } catch (failure) {
          if (alive.current) {
            setReady(false);
            setError(failure.message || String(failure));
          }
          return null;
        }
      }

      async function manualRefresh() {
        if (busy) return;
        setBusy('refresh');
        setError('');
        setNotice('');
        try {
          const value = await refresh(true);
          if (alive.current) {
            setLastSyncedAt(clockText());
            setNotice(value ? `已刷新 · ${clockText()}` : '刷新失败，请检查设置服务是否连接。');
          }
        } finally {
          if (alive.current) setBusy('');
        }
      }

      useEffect(() => {
        alive.current = true;
        void refresh();
        const timer = setInterval(() => {
          if (!busy) void refresh(false);
        }, 2500);
        return () => { alive.current = false; clearInterval(timer); };
      }, [api, busy]);

      // 候选库快照：先按状态/关键词/时间/评分把整库取下来，再在客户端派生“隐藏超 3 天”与
      // videoId 精确检索、切片分页。这样即使宿主进程还跑着旧的服务端代码（忽略 videoId、
      // 不做自动隐藏），界面行为也保持一致。
      // videoId 与页码都不进 candidateKey：输入、检索、翻页都只重新派生，不重复请求整库。
      const candidateKey = `${candidateFilter.status}|${candidateFilter.query}|${candidateFilter.sinceDays}|${candidateFilter.date}|${candidateFilter.minScore}|${candidateFilter.reload}`;
      useEffect(() => {
        if (category !== '素材库') return undefined;
        let cancelled = false;
        setCandidateBusy(true);
        (async () => {
          const rows = [];
          let statuses = candidateStatuses;
          let offset = 0;
          let lastTotal = 0;
          for (let round = 0; round < CANDIDATE_MAX_FETCH_PAGES; round += 1) {
            const value = await api.request('/library/candidates', {
              status: candidateFilter.status,
              query: candidateFilter.query,
              sinceDays: Number(candidateFilter.sinceDays) || 0,
              date: String(candidateFilter.date || '').trim(),
              minScore: Number(candidateFilter.minScore) || 0,
              videoId: '',
              limit: CANDIDATE_FETCH_LIMIT,
              offset,
            }, { timeoutMs: 30_000 });
            if (cancelled) return;
            const batch = Array.isArray(value?.candidates) ? value.candidates : [];
            if (Array.isArray(value?.statuses) && value.statuses.length) statuses = value.statuses;
            lastTotal = Number(value?.total) || rows.length + batch.length;
            rows.push(...batch);
            offset += batch.length;
            if (!value?.hasMore || !batch.length || offset >= lastTotal) break;
          }
          if (cancelled) return;
          setCandidateStatuses(statuses);
          setCandidateRows(rows);
          setCandidateError('');
          setCandidateBusy(false);
        })().catch((failure) => {
          if (cancelled) return;
          setCandidateRows([]);
          setCandidateError(failure.message || String(failure));
          setCandidateBusy(false);
        });
        return () => { cancelled = true; };
      }, [category, candidateKey, api]);

      // 由快照派生当前页：隐藏超 3 天 → videoId 精确匹配 → 切片。任何一步变化都只重算派生结果。
      useEffect(() => {
        if (category !== '素材库') return;
        const now = Date.now();
        const hideAfterMs = LIBRARY_HIDE_AFTER_DAYS * 24 * 60 * 60 * 1000;
        const wantedVideoId = String(candidateFilter.videoId || '').trim().toLowerCase();
        const wantedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(candidateFilter.date || '').trim()) ? String(candidateFilter.date).trim() : '';
        // 显式放宽时间范围、按 videoId 检索或按日期筛选时不隐藏，避免“筛选条件形同虚设”。
        const keepOld = Boolean(wantedVideoId) || Boolean(wantedDate) || Number(candidateFilter.sinceDays) > LIBRARY_HIDE_AFTER_DAYS;
        const visible = keepOld
          ? candidateRows
          : candidateRows.filter((row) => {
            const stamp = Date.parse(row?.collectedAt || row?.updatedAt || '');
            return !Number.isFinite(stamp) || now - stamp <= hideAfterMs;
          });
        // 按「采集日期」筛单日：服务端已按同一口径过滤，这里再兜一层，兼容宿主未热更新时返回的全量数据。
        const dated = wantedDate
          ? visible.filter((row) => {
            const stamp = Date.parse(row?.collectedAt || row?.updatedAt || '');
            if (!Number.isFinite(stamp)) return false;
            const d = new Date(stamp);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            return key === wantedDate;
          })
          : visible;
        const matched = wantedVideoId
          ? dated.filter((row) => String(row?.videoId || '').trim().toLowerCase() === wantedVideoId)
          : dated;
        const total = matched.length;
        const totalPages = Math.max(1, Math.ceil(total / CANDIDATE_PAGE_SIZE));
        const page = Math.min(candidateFilter.page, totalPages - 1);
        const offset = page * CANDIDATE_PAGE_SIZE;
        const counts = { byStatus: {} };
        for (const row of matched) {
          const status = row?.status || 'unknown';
          counts.byStatus[status] = (counts.byStatus[status] || 0) + 1;
        }
        setCandidates({
          total,
          offset,
          candidates: matched.slice(offset, offset + CANDIDATE_PAGE_SIZE),
          hasMore: offset + CANDIDATE_PAGE_SIZE < total,
          counts,
          statuses: candidateStatuses,
          hiddenByAge: keepOld ? 0 : candidateRows.length - visible.length,
        });
        if (page !== candidateFilter.page) {
          setPageHint({
            text: total === 0
              ? '没有符合条件的素材，已回到列表首页。'
              : `共 ${totalPages} 页，已跳转到第 ${totalPages} 页。`,
            tone: 'info',
          });
          updateCandidateFilter({ page });
        }
      }, [category, candidateRows, candidateStatuses, candidateFilter.page, candidateFilter.videoId, candidateFilter.sinceDays, candidateFilter.date]);

      async function perform(key, action, success = '已保存。') {
        if (busy) return null;
        setBusy(key);
        setError('');
        setNotice('');
        try {
          const value = await action();
          if (value && value.ok === false) {
            if (alive.current) setError(value.message || `操作失败（${value.code || '未知错误'}）。`);
          } else if (alive.current) {
            setNotice(success);
          }
          await refresh(false);
          if (alive.current) setLastSyncedAt(clockText());
          return value;
        } catch (failure) {
          if (alive.current) setError(failure.message || String(failure));
          return null;
        } finally {
          if (alive.current) setBusy('');
        }
      }

      function basicPatch() {
        const model = {
          source: draft.model.source,
          provider: draft.model.source === 'dsh' ? draft.model.provider : '',
          // 非 dsh 来源只用「默认模型名」这一栏；不要再回退 draft.model.model，
          // 那是 DSH 模型下拉的残留值，会把「默认模型」的视觉/文本默认模型污染成别的模型。
          model: draft.model.source === 'dsh' ? draft.model.model : draft.model.api.model,
          textModel: draft.model.textModel,
          visionModel: draft.model.visionModel,
          api: { baseUrl: draft.model.api.baseUrl, model: draft.model.api.model },
        };
        if (draft.model.api.apiKey.trim()) model.api.apiKey = draft.model.api.apiKey.trim();
        const patch = {
          downloadsDir: draft.downloadsDir,
          storage: { rejectedDir: draft.rejectedDir },
          port: numberInputValue(draft.port),
          proxy: {
            mode: draft.proxy.mode,
            server: draft.proxy.server,
            pool: parseLines(draft.proxy.pool).slice(0, 20),
          },
          model,
        };
        return patch;
      }

      async function detectProxy() {
        setBusy('detectProxy');
        try {
          const info = await api.request('/proxy/system', {});
          setSystemProxy(info || {});
        } catch (error) {
          setSystemProxy({ error: String(error?.message || error) });
        } finally {
          setBusy('');
        }
      }

      async function saveBasic() {
        const value = await perform('saveBasic', async () => {
          const result = await api.request('/config/configure', { patch: basicPatch() });
          setDraft((old) => ({ ...old, model: { ...old.model, api: { ...old.model.api, apiKey: '' } } }));
          return result;
        }, '基础设置已保存。');
        return value !== null;
      }

      async function saveSearch() {
        const patch = {
          search: {
            maxResultsPerKeyword: numberInputValue(draft.search.maxResultsPerKeyword),
            tokenBudget: numberInputValue(draft.search.tokenBudget),
            dailyTokenBudget: numberInputValue(draft.search.dailyTokenBudget),
            targetCount: numberInputValue(draft.search.targetCount),
            targetVideos: numberInputValue(draft.search.targetVideos),
            queryLanguage: draft.search.queryLanguage,
            contentLanguage: draft.search.contentLanguage,
            defaultProfileId: draft.search.defaultProfileId,
            // 种子词/排除词此前只在前端现取现发，从未写进配置，重进设置页就被默认值覆盖。
            seeds: parseTerms(seeds, 20),
            exclude: parseTerms(exclude, 30),
          },
          judge: { threshold: Number(draft.judge.threshold), modelWeight: Number(draft.judge.modelWeight), prefilter: draft.judge.prefilter },
          dedup: {
            enabled: Boolean(draft.dedup.enabled),
            videoDistance: numberInputValue(draft.dedup.videoDistance),
            textSimilarity: numberInputValue(draft.dedup.textSimilarity),
          },
        };
        return (await perform('saveSearch', () => api.request('/config/configure', { patch }), '搜索设置已保存。')) !== null;
      }

      async function saveDownload() {
        const patch = {
          downloadsDir: draft.downloadsDir,
          download: {
            channel: draft.download.channel,
            preferNoWatermark: Boolean(draft.download.preferNoWatermark),
            aix: {
              allowAixUrlPageFetch: draft.download.aix.allowAixUrlPageFetch,
              manualFallback: draft.download.aix.manualFallback,
              allowPageFallback: draft.download.aix.allowPageFallback,
            },
          },
        };
        return (await perform('saveDownload', () => api.request('/config/configure', { patch }), '下载设置已保存。')) !== null;
      }

      async function pickArchiveDirectory() {
        if (busy) return;
        setBusy('pickDir');
        setError('');
        setNotice('');
        try {
          const value = await api.request('/directory/pick', { current: draft.downloadsDir }, { timeoutMs: 300_000 });
          if (value?.path) {
            setDraft((old) => patchAt(old, ['downloadsDir'], value.path));
            setNotice('已选择归档目录，点击“保存下载设置”后生效。');
          } else if (value?.cancelled) {
            setNotice('已取消文件夹选择。');
          } else {
            setError(value?.message || `选择文件夹失败（${value?.code || '未知错误'}）。可以直接在输入框手动填写绝对路径。`);
          }
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (alive.current) setBusy('');
        }
      }

      async function uploadSamples(files) {
        if (!files?.length) return;
        const targetProfile = uploadProfileId.trim() || draft.search.defaultProfileId || '';
        const polarity = uploadPolarity === 'negative' ? 'negative' : 'positive';
        setBusy('upload');
        setError('');
        setUploadStatus({ current: 0, total: files.length, name: '', errors: [] });
        let done = 0;
        const errors = [];
        for (const file of files) {
          setUploadStatus({ current: done + 1, total: files.length, name: file.name, errors });
          try {
            await api.upload(file, targetProfile, polarity);
            done += 1;
          } catch (failure) {
            errors.push(`${file.name}: ${failure.message || failure}`);
          }
        }
        setUploadStatus({ current: done, total: files.length, name: '', errors });
        setNotice(`已上传 ${done}/${files.length} 个${polarity === 'negative' ? '反' : '正'}样例${targetProfile ? `，归入 ${targetProfile}` : '（未指定归属）'}。`);
        if (done > 0 && targetProfile) {
          setMaterialForm((old) => (old.profileId.trim() ? old : { ...old, profileId: targetProfile }));
        }
        setBusy('');
        await refresh(false);
      }

      async function togglePolarity(sampleId, polarity) {
        if (busy) return;
        setBusy('polarity');
        setError('');
        try {
          const value = await api.request('/library/sample/polarity', { sampleId, polarity }, { timeoutMs: 20_000 });
          if (value?.ok === false) setError(value.message || '切换样例极性失败。');
          else {
            setNotice(`已将 ${sampleId} 标记为${polarity === 'negative' ? '反样例' : '正样例'}。`);
            await refresh(false);
          }
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (alive.current) setBusy('');
        }
      }

      async function deleteSample(sampleId) {
        if (!sampleId || busy) return;
        setBusy('sampleDelete');
        setError('');
        try {
          const value = await api.request('/library/sample/delete', { sampleId }, { timeoutMs: 30_000 });
          if (value?.ok === false) setError(value.message || '删除样例失败。');
          else {
            const count = Array.isArray(value?.files) ? value.files.length : 0;
            setNotice(`已删除样例 ${sampleId}${count ? `，并清理 ${count} 个库内文件` : ''}。`);
            setSampleDeleteConfirm(null);
            await refresh(false);
          }
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (alive.current) setBusy('');
        }
      }

      async function previewKeywords() {
        const value = await perform('preview', () => api.request('/keywords/expand', {
          seeds: seeds.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean),
          targetCount: numberOrDefault(draft.search.targetCount, INPUT_DEFAULTS.targetCount),
          queryLanguage: draft.search.queryLanguage,
          contentLanguage: draft.search.contentLanguage,
          exclude: exclude.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean),
        }, { timeoutMs: 120_000 }), '扩展词预览已生成。');
        if (value) setPreview(value);
      }

      async function startRun() {
        if (!(await saveSearch())) return;
        await perform('startRun', () => api.request('/run/start', {
          seeds: seeds.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean),
          targetCount: numberOrDefault(draft.search.targetCount, INPUT_DEFAULTS.targetCount),
          queryLanguage: draft.search.queryLanguage,
          contentLanguage: draft.search.contentLanguage,
          exclude: exclude.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean),
          profileId: draft.search.defaultProfileId || null,
          maxPerRun: numberOrDefault(draft.search.maxResultsPerKeyword, INPUT_DEFAULTS.maxResultsPerKeyword),
          targetVideos: numberOrDefault(draft.search.targetVideos, INPUT_DEFAULTS.targetVideos),
        }, { timeoutMs: 30_000 }), '采集任务已启动。');
      }

      async function buildMaterial() {
        if (!materialForm.profileId.trim()) {
          setError('请先填写素材筛选画像 ID，例如 puzzle-match3。');
          return;
        }
        const value = await perform('buildMaterial', () => api.request('/profiles/material/build', {
          profileId: materialForm.profileId.trim(),
          name: materialForm.name,
          threshold: numberOrDefault(materialForm.threshold, INPUT_DEFAULTS.materialThreshold),
          calibrate: true,
          minSamples: 3,
          includeUnassigned: true,
        }, { timeoutMs: 90_000 }), '素材筛选画像已生成。');
        if (value?.ok) {
          setMaterialDraft(materialDraftFrom(value.profile));
          setMaterialHistory(null);
          setMaterialForm({ profileId: value.profile.id, name: value.profile.name || '', threshold: Number(value.profile.threshold) || 60 });
        }
      }

      async function saveMaterial() {
        if (!materialDraft) return;
        const value = await perform('saveMaterial', () => api.request('/profiles/material/save', {
          id: materialDraft.id,
          patch: {
            name: materialDraft.name,
            threshold: numberOrDefault(materialDraft.threshold, INPUT_DEFAULTS.materialThreshold),
            guidance: materialDraft.guidance,
            keywords: parseLines(materialDraft.keywords),
            mustHave: parseLines(materialDraft.mustHave),
            niceToHave: parseLines(materialDraft.niceToHave),
            mustNot: parseLines(materialDraft.mustNot),
          },
        }), '素材筛选画像修改已保存。');
        if (value?.ok) setMaterialDraft(materialDraftFrom(value.profile));
      }

      // 历史版本：只读列表 + 一键恢复；恢复接口会先把当前版本写进历史，再替换文件。
      async function loadHistory() {
        const id = materialDraft?.id;
        if (!id) {
          setError('先打开一个画像，再查看历史版本。');
          return;
        }
        setHistoryBusy('material');
        setError('');
        try {
          const value = await api.request('/profiles/material/history', { id }, { timeoutMs: 20_000 });
          if (value?.ok === false) {
            setError(value.message || '读取历史版本失败。');
            setMaterialHistory([]);
          } else {
            setMaterialHistory(value?.versions || []);
          }
        } catch (failure) {
          if (alive.current) setError(failure.message || String(failure));
        } finally {
          if (alive.current) setHistoryBusy('');
        }
      }

      async function restoreVersion(version) {
        const id = materialDraft?.id;
        if (!id || historyBusy) return;
        setHistoryBusy('material');
        setError('');
        setNotice('');
        try {
          const value = await api.request('/profiles/material/restore', { id, version }, { timeoutMs: 20_000 });
          if (value?.ok === false) {
            setError(value.message || '恢复失败。');
          } else if (value?.profile) {
            setMaterialDraft(materialDraftFrom(value.profile));
            setNotice(`已恢复到 ${version}；恢复前的版本也已留档。`);
            await refresh(true);
          }
        } catch (failure) {
          if (alive.current) setError(failure.message || String(failure));
        } finally {
          if (alive.current) setHistoryBusy('');
        }
        await loadHistory();
      }

      function historyPanel(versions) {
        const small = { ...buttonStyle, padding: '4px 8px', fontSize: 12 };
        if (versions === null) {
          return h('div', { style: row },
            h('button', {
              type: 'button',
              style: small,
              disabled: Boolean(historyBusy),
              onClick: () => void loadHistory(),
            }, historyBusy === 'material' ? '读取中…' : '历史版本'));
        }
        const list = Array.isArray(versions) ? versions : [];
        return h('div', { style: { ...column, gap: 8 } },
          h('div', { style: row },
            h('strong', { style: { fontSize: 13 } }, `历史版本（${list.length}）`),
            h('button', { type: 'button', style: small, disabled: Boolean(historyBusy), onClick: () => void loadHistory() },
              historyBusy === 'material' ? '刷新中…' : '刷新'),
            h('button', {
              type: 'button',
              style: small,
              onClick: () => setMaterialHistory(null),
            }, '收起')),
          list.length === 0
            ? note('还没有历史版本；每次生成、保存或恢复前都会自动留一份，最多保留 20 个。')
            : h('div', { style: column }, ...list.map((item) => h('div', {
              key: item.version,
              style: { ...row, justifyContent: 'space-between', borderTop: '1px solid var(--dsw-alias-border-l2, #eee)', paddingTop: 6 },
            },
              h('div', { style: { ...column, gap: 2 } },
                h('span', { style: { fontSize: 12 } }, `${formatHistoryAt(item.at)} · ${HISTORY_SOURCE_LABELS[item.source] || item.source}`),
                note(`名称：${item.name || '—'} · 阈值：${item.threshold ?? '—'} · 正样例：${item.sampleCount ?? '—'}${item.negativeCount ? ` · 反样例：${item.negativeCount}` : ''}`)),
              h('button', {
                type: 'button',
                style: small,
                disabled: Boolean(historyBusy),
                onClick: () => void restoreVersion(item.version),
              }, '恢复')))));
      }

      async function purgeLibrary() {
        if (busy) return;
        if (!purgeConfirm) {
          setPurgeConfirm(true);
          setNotice('再次点击“确认清空”才会删除；清空前会把索引与画像 JSON 备份到 library/backups。');
          return;
        }
        setPurgeConfirm(false);
        const value = await perform('purge', () => api.request('/library/purge', { confirm: true }, { timeoutMs: 120_000 }), '样例与画像已清空。');
        if (value?.ok) {
          setMaterialDraft(null);
        }
      }

      async function deleteProfile(id) {
        if (busy) return;
        if (profileDeleteConfirm !== id) {
          setProfileDeleteConfirm(id);
          setNotice(`再次点击“确认删除”才会删除画像 ${id}；该画像名下的样例视频副本会一起删除，不可恢复。`);
          return;
        }
        setProfileDeleteConfirm(null);
        const value = await perform('deleteProfile', () => api.request('/profiles/material/delete', { id }, { timeoutMs: 60_000 }), `已删除画像 ${id}。`);
        if (value?.ok) {
          if (materialDraft?.id === id) {
            setMaterialDraft(null);
            setMaterialHistory(null);
          }
          if (sampleFolder === id) {
            setSampleFolder(null);
            setSampleFolderPolarity(null);
            setSampleDeleteConfirm(null);
          }
          const removed = Number(value.removedSamples) || 0;
          setNotice(`已删除画像 ${id}${removed ? `，连同 ${removed} 条样例视频一并删除` : ''}。`);
          await refresh(true);
        }
      }

      function updateCandidateFilter(patch) {
        setCandidateFilter((old) => ({ ...old, ...patch }));
      }

      // 页码跳转：校验输入后跳页；非法或越界只提示，不改变当前页。
      function jumpToPage() {
        const raw = String(pageInput ?? '').trim();
        const total = Number(candidates?.total) || 0;
        const totalPages = Math.max(1, Math.ceil(total / CANDIDATE_PAGE_SIZE));
        if (!raw) {
          setPageHint({ text: '请输入要跳转的页码。', tone: 'error' });
          return;
        }
        if (!/^\d+$/.test(raw)) {
          setPageHint({ text: '页码必须是正整数，例如 2。', tone: 'error' });
          return;
        }
        const wanted = Number(raw);
        if (wanted < 1 || wanted > totalPages) {
          setPageHint({ text: `页码需在 1 到 ${totalPages} 之间（当前共 ${totalPages} 页）。`, tone: 'error' });
          return;
        }
        setPageHint(null);
        setPageInput('');
        updateCandidateFilter({ page: wanted - 1 });
      }

      // 检索：整库快照已在本地，输入即过滤；这里只负责回到第 1 页并给出结果提示。
      function runVideoIdSearch() {
        const wanted = String(candidateFilter.videoId || '').trim();
        if (!wanted) {
          setPageHint({ text: '请输入要检索的 videoId。', tone: 'error' });
          return;
        }
        setPageHint(null);
        setPageInput('');
        updateCandidateFilter({ videoId: wanted, page: 0 });
      }

      function clearVideoIdSearch() {
        setPageHint(null);
        setPageInput('');
        updateCandidateFilter({ videoId: '', page: 0 });
      }

      async function revealFile(file, kind = 'library') {
        if (!file || busy) return;
        setBusy('reveal');
        setError('');
        try {
          const value = await api.request(kind === 'report' ? '/report/reveal' : '/library/reveal', { file }, { timeoutMs: 20_000 });
          if (value?.ok === false) setError(value.message || '无法定位文件。');
          else setNotice(`已在资源管理器定位：${value?.file || file}`);
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (alive.current) setBusy('');
        }
      }

      async function saveFeedback(videoId, patch) {
        if (busy) return;
        setBusy('feedback');
        setError('');
        try {
          const value = await api.request('/feedback/save', { videoId, ...patch }, { timeoutMs: 20_000 });
          if (value?.ok === false) setError(value.message || '保存反馈失败。');
          else {
            setNotice(`已保存 ${videoId} 的反馈。`);
            updateCandidateFilter({ reload: (candidateFilter.reload || 0) + 1 });
          }
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (alive.current) setBusy('');
        }
      }

      async function removeFeedback(videoId) {
        if (busy) return;
        setBusy('feedback');
        setError('');
        try {
          const value = await api.request('/feedback/remove', { videoId }, { timeoutMs: 20_000 });
          if (value?.ok === false) setError(value.message || '撤销反馈失败。');
          else {
            setNotice(`已撤销 ${videoId} 的反馈（样例库未改动）。`);
            updateCandidateFilter({ reload: (candidateFilter.reload || 0) + 1 });
          }
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (alive.current) setBusy('');
        }
      }

      /**
       * 显式回流：把「≥4 分」加入正样例 /「≤2 分」加入负样例。
       * 只有用户点第二次确认才会写样例库；逐条调用，失败不中断。
       */
      async function reflowByScore(kind) {
        if (busy) return;
        const polarity = kind === 'negative' ? 'negative' : 'positive';
        setBusy('reflow');
        setError('');
        setNotice('');
        setReflowConfirm(null);
        try {
          const query = polarity === 'negative' ? { maxScore: 2 } : { minScore: 4 };
          const list = await api.request('/feedback/list', query, { timeoutMs: 20_000 });
          const entries = list?.entries || [];
          if (!entries.length) {
            setNotice(`没有${polarity === 'negative' ? ' ≤2 分' : ' ≥4 分'}的反馈记录，未改动样例库。`);
            return;
          }
          let done = 0;
          const errors = [];
          for (const item of entries) {
            try {
              await api.request('/feedback/reflow', {
                videoId: item.videoId,
                polarity,
                describe: reflowDescribe,
              }, { timeoutMs: 300_000 });
              done += 1;
            } catch (failure) {
              errors.push(`${item.videoId}: ${failure.message || failure}`);
            }
          }
          setNotice(`已回流 ${done}/${entries.length} 条到${polarity === 'negative' ? '反' : '正'}样例，请在“样例与画像”手动重建画像后才会生效。`);
          if (errors.length) setError(`失败 ${errors.length} 条：${errors.slice(0, 3).join('；')}`);
          await refresh(false);
          updateCandidateFilter({ reload: (candidateFilter.reload || 0) + 1 });
        } catch (failure) {
          setError(failure.message || String(failure));
        } finally {
          if (alive.current) setBusy('');
        }
      }

      async function exportCandidates() {
        if (busy) return;
        setBusy('export');
        setError('');
        setNotice('');
        try {
          const value = await api.request('/library/export', {
            status: candidateFilter.status,
            query: candidateFilter.query,
            sinceDays: Number(candidateFilter.sinceDays) || 0,
            date: String(candidateFilter.date || '').trim(),
          }, { timeoutMs: 60_000 });
          if (value?.ok === false) setError(value.message || '导出失败。');
          else {
            setExportResult(value);
            setNotice(`已导出 ${value.rows} 条到 ${value.file}`);
          }
          return value;
        } catch (failure) {
          setError(failure.message || String(failure));
          return null;
        } finally {
          if (alive.current) setBusy('');
        }
      }

      function copyVideoId(videoId) {
        const text = String(videoId || '');
        const clipboard = globalThis.navigator?.clipboard;
        if (clipboard?.writeText) {
          clipboard.writeText(text).then(
            () => setNotice(`已复制 videoId：${text}`),
            () => setNotice(`videoId：${text}`),
          );
          return;
        }
        setNotice(`videoId：${text}`);
      }

      function todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      function field(label, value, onChange, options = {}) {
        return h('label', { style: column }, h('span', null, label), h('input', {
          type: options.type || 'text',
          value,
          min: options.min,
          max: options.max,
          placeholder: options.placeholder,
          disabled: options.disabled,
          onChange: (event) => onChange(event.target.value),
          style: control,
        }));
      }

      function area(label, value, onChange, rows = 4) {
        return h('label', { style: column }, label, h('textarea', {
          rows,
          value,
          onChange: (event) => onChange(event.target.value),
          style: { ...control, resize: 'vertical' },
        }));
      }

      function select(label, value, options, onChange, disabled = false) {
        return h('label', { style: column }, label, h('select', {
          value,
          disabled,
          onChange: (event) => onChange(event.target.value),
          style: control,
        }, ...options.map(([key, text]) => h('option', { key, value: key }, key === '' ? '' : text))));
      }

      function toggle(label, checked, onChange) {
        return h('label', { style: row }, h('input', {
          type: 'checkbox',
          checked,
          onChange: (event) => onChange(event.target.checked),
        }), label);
      }

      function section(title, ...children) {
        return h('section', { style: { ...card, ...column } }, h('h3', { style: { margin: 0, fontSize: 15 } }, title), ...children);
      }

      function note(text) {
        return text ? h('p', { style: muted }, text) : null;
      }

      function sampleLibraryBrowser() {
        const library = state?.library || {};
        const samples = Array.isArray(library.samples) ? library.samples : [];
        const counts = library.byProfile || {};
        const folderKeys = Object.keys(counts).filter((key) => Number(counts[key]) > 0);
        folderKeys.sort((a, b) => (a === 'unassigned' ? 1 : 0) - (b === 'unassigned' ? 1 : 0) || a.localeCompare(b));
        const profileLabel = (id) => {
          if (id === 'unassigned') return '未归属';
          const hit = profiles.find((item) => item.id === id);
          return hit?.name || id;
        };
        const smallButton = (label, onClick, extra = {}) => h('button', {
          type: 'button',
          style: { ...buttonStyle, padding: '2px 8px', fontSize: 12, ...extra },
          disabled: busyAny,
          onClick,
        }, label);
        const crumb = (...parts) => h('div', { style: { ...row, gap: 6 } },
          ...parts.flatMap((part, index) => (index === 0 ? [part] : [h('span', { key: `crumb-sep-${index}`, style: muted }, '/'), part])));
        const folderRow = (label, count, onClick) => h('button', {
          type: 'button',
          style: { ...buttonStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '8px 10px', textAlign: 'left' },
          disabled: busyAny,
          onClick,
        }, h('span', null, `📁 ${label}`), h('span', { style: muted }, `${count} 条`));
        const backToRoot = () => {
          setSampleFolder(null);
          setSampleFolderPolarity(null);
          setSampleDeleteConfirm(null);
        };
        const backToProfile = () => {
          setSampleFolderPolarity(null);
          setSampleDeleteConfirm(null);
        };

        if (sampleFolder === null) {
          return h('div', { style: column },
            folderKeys.length
              ? folderKeys.map((key) => h('div', { key }, folderRow(profileLabel(key), Number(counts[key]) || 0, () => {
                setSampleFolder(key);
                setSampleFolderPolarity(null);
                setSampleDeleteConfirm(null);
              })))
              : note('样例库还是空的，先在上面上传视频样例。'));
        }

        const current = samples.filter((sample) => (sample.profileId || 'unassigned') === sampleFolder);
        const positive = current.filter((sample) => sample.polarity !== 'negative');
        const negative = current.filter((sample) => sample.polarity === 'negative');

        if (sampleFolderPolarity === null) {
          return h('div', { style: column },
            crumb(smallButton('全部画像', backToRoot), h('span', null, profileLabel(sampleFolder))),
            folderRow('正样例', positive.length, () => {
              setSampleFolderPolarity('positive');
              setSampleDeleteConfirm(null);
            }),
            folderRow('反样例', negative.length, () => {
              setSampleFolderPolarity('negative');
              setSampleDeleteConfirm(null);
            }));
        }

        const rows = sampleFolderPolarity === 'negative' ? negative : positive;
        const polarityLabel = sampleFolderPolarity === 'negative' ? '反样例' : '正样例';
        return h('div', { style: column },
          crumb(smallButton('全部画像', backToRoot), smallButton(profileLabel(sampleFolder), backToProfile), h('span', null, polarityLabel)),
          rows.length
            ? rows.map((sample) => h('div', { key: sample.id, style: { ...card, ...column, gap: 6, padding: 10 } },
              note(`${sample.duration ? `${sample.duration} 秒 · ` : ''}${sample.addedAt ? formatHistoryAt(sample.addedAt) : '时间未知'} · ${sample.hasFeatures ? '已完成视觉特征' : '仅基础数据'}${sample.desc ? ` · ${sample.desc}` : ''}`),
              h('div', { style: row },
                smallButton('打开所在文件夹', () => void revealFile(sample.file, 'library')),
                sampleDeleteConfirm === sample.id
                  ? h('span', { style: { ...row, gap: 6 } },
                    h('span', { style: { ...muted, color: 'var(--dsw-alias-label-danger, #c00)' } }, '删除会连库内视频副本一起删，不可恢复。'),
                    h('button', {
                      type: 'button',
                      style: { ...dangerStyle, padding: '4px 8px', fontSize: 12 },
                      disabled: busyAny,
                      onClick: () => void deleteSample(sample.id),
                    }, '确认删除'),
                    smallButton('取消', () => setSampleDeleteConfirm(null)))
                  : h('button', {
                    type: 'button',
                    style: { ...dangerStyle, padding: '4px 8px', fontSize: 12 },
                    disabled: busyAny,
                    onClick: () => setSampleDeleteConfirm(sample.id),
                  }, '删除样例'))))
            : note('这个文件夹里还没有样例。'));
      }

      const profiles = state?.profiles || [];
      const runState = state?.run || { status: 'idle' };
      const tokenState = runState.budget || null;
      const dailyBudget = state?.dailyBudget || null;
      const dailyExhausted = dailyBudget?.exhausted === true;
      const aix = state?.download?.aix || null;
      const retryState = state?.retry || null;

      // 采集进度：后端每跑完一个关键词就回报累计 found/target；运行中每分钟主动拉一次 /state。
      const runProgress = runState?.progress || null;
      const progressFound = Math.max(0, Number(runProgress?.found) || 0);
      const progressTarget = Math.max(0, Number(runProgress?.target) || 0);
      const progressIndex = Math.max(0, Number(runProgress?.index) || 0);
      const progressTotal = Math.max(0, Number(runProgress?.total) || 0);
      useEffect(() => {
        if (!runState?.running) return undefined;
        const timer = setInterval(() => { void refresh(false); }, 60_000);
        return () => clearInterval(timer);
      }, [runState?.running, api]);
      const configuredProviders = state?.model?.providers || [];
      const configuredModels = (state?.model?.models || []).filter((item) => item.provider === draft.model.provider);
      // 文本/视觉模型下拉框选项：全量模型目录（不按提供商过滤）+ 当前值兜底，
      // 保证历史手填过的模型名不会在下拉框里显示成空白。
      function modelSelectOptions(current = '') {
        const seen = new Set();
        const options = [];
        // 默认模型 / DSH 来源需要提供商前缀来路由；自定义 OpenAI 接口只发送原始模型 ID。
        const qualified = draft.model.source !== 'openai-compatible';
        for (const item of state?.model?.models || []) {
          if (!item?.id || !item?.provider) continue;
          const value = qualified ? `${item.provider}/${item.id}` : item.id;
          if (seen.has(value)) continue;
          seen.add(value);
          options.push([value, `${item.name || item.id}（${item.provider}）${item.inputModalities?.includes('image') ? ' · 支持图像' : ''}`]);
        }
        const value = String(current || '').trim();
        if (value && !seen.has(value)) options.push([value, `${value}（当前配置）`]);
        return options;
      }
      const busyAny = Boolean(busy);

      function materialEditor() {
        if (!materialDraft) {
          return null;
        }
        const current = profiles.find((item) => item.id === materialDraft.id);
        return h('div', { style: { ...card, ...column } },
          h('div', { style: row },
            note(`画像 ID：${materialDraft.id}（只读）`),
            note(`正样例：${current?.sampleCount ?? 0} 条${current?.negativeCount ? ` · 反样例：${current.negativeCount} 条` : ''}`)),
          h('div', { style: { display: 'grid', gridTemplateColumns: '2fr 120px', gap: 10 } },
            field('画像名称', materialDraft.name, (value) => setMaterialDraft((old) => ({ ...old, name: value }))),
            field('阈值', materialDraft.threshold, (value) => setMaterialDraft((old) => ({ ...old, threshold: numberInputValue(value) })), { type: 'number', min: 0, max: 100 })),
          area('画像描述（素材筛选标准）', materialDraft.guidance, (value) => setMaterialDraft((old) => ({ ...old, guidance: value })), 5, '描述这类素材要什么、不要什么，判定时会作为说明使用'),
          area('关键词，每行一个', materialDraft.keywords, (value) => setMaterialDraft((old) => ({ ...old, keywords: value })), 4),
          area('必须包含，每行一个', materialDraft.mustHave, (value) => setMaterialDraft((old) => ({ ...old, mustHave: value })), 3),
          area('尽量包含，每行一个', materialDraft.niceToHave, (value) => setMaterialDraft((old) => ({ ...old, niceToHave: value })), 3),
          area('排除项，每行一个', materialDraft.mustNot, (value) => setMaterialDraft((old) => ({ ...old, mustNot: value })), 3),
          h('div', { style: row },
            h('button', { type: 'button', style: primaryStyle, disabled: busyAny, onClick: () => void saveMaterial() }, busy === 'saveMaterial' ? '保存中…' : '保存素材画像修改'),
            h('button', {
              type: 'button',
              style: buttonStyle,
              disabled: busyAny,
              onClick: () => {
                const source = profiles.find((item) => item.id === materialDraft.id);
                if (source) setMaterialDraft(materialDraftFrom(source));
              },
            }, '重置为当前文件'),
            h('button', { type: 'button', style: buttonStyle, onClick: () => { setMaterialDraft(null); setMaterialHistory(null); } }, '收起')),
          historyPanel(materialHistory));
      }

      function statusBadge(status) {
        const palette = {
          accepted: ['#e8f7ee', '#0a7a3d'],
          archived: ['#e8f1ff', '#1554b3'],
          download_failed: ['#fff3e0', '#a3560a'],
          extract_failed: ['#fff3e0', '#a3560a'],
          rejected: ['#fdeaea', '#a11b1b'],
          skipped_language: ['#f3e9ff', '#6b2fb3'],
          skipped_aspect: ['#fdeef3', '#a3285c'],
          duplicate: ['#eef2f7', '#3c4a5c'],
        };
        const [background, color] = palette[status] || ['#f0f0f0', '#555'];
        return { background, color, borderRadius: 10, padding: '2px 8px', fontSize: 11, whiteSpace: 'nowrap' };
      }

      function candidateTable() {
        if (candidateError) {
          return h('p', { role: 'alert', style: { color: 'var(--dsw-alias-label-danger, #c00)' } }, candidateError);
        }
        const list = candidates?.candidates || [];
        if (!list.length) return note(candidateBusy ? '正在读取候选库…' : '没有符合条件的候选。');
        const cell = { padding: '7px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2, #eee)', verticalAlign: 'top' };
        const head = { ...cell, textAlign: 'left', fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #555)', whiteSpace: 'nowrap' };
        const small = { ...buttonStyle, padding: '4px 8px', fontSize: 12 };
        return h('div', null,
          h('div', {
            ref: tableScrollRef,
            onScroll: (event) => {
              const target = event.currentTarget;
              const proxy = tableProxyRef.current;
              if (proxy && Math.abs(proxy.scrollLeft - target.scrollLeft) > 1) proxy.scrollLeft = target.scrollLeft;
            },
            style: { overflow: 'auto', maxHeight: 'min(60vh, 560px)', overscrollBehavior: 'contain' },
          },
          h('table', { style: { width: '100%', minWidth: CANDIDATE_TABLE_MIN_WIDTH, borderCollapse: 'collapse', fontSize: 12 } },
            h('thead', null, h('tr', null,
              ...['状态', 'videoId', '作者', '文案', '分数', '文件', '时间', '反馈', '操作'].map((label) => h('th', { key: label, style: { ...head, position: 'sticky', top: 0, zIndex: 1, background: 'var(--dsw-alias-bg-base, #fff)' } }, label)))),
            h('tbody', null, ...list.map((item) => h('tr', { key: item.videoId },
              h('td', { style: cell }, h('span', { style: statusBadge(item.status) }, CANDIDATE_STATUS_LABELS[item.status] || item.status)),
              h('td', { style: { ...cell, fontFamily: 'ui-monospace, Consolas, monospace' } }, item.videoId),
              h('td', { style: cell }, item.author || '—'),
              h('td', { style: { ...cell, minWidth: 200, maxWidth: 300 } },
                item.desc || '—',
                item.language && h('span', { style: { ...muted, marginLeft: 6, fontSize: 11 } }, `[${item.language}]`)),
              h('td', { style: cell }, item.score === null ? '—' : item.score),
              h('td', { style: { ...cell, whiteSpace: 'nowrap' } },
                item.archive.exists
                  ? `${Math.round(((item.archive.bytes || 0) / 1024 / 1024) * 10) / 10} MB`
                  : item.archive.bytes ? '文件缺失' : '未归档'),
              h('td', { style: { ...cell, whiteSpace: 'nowrap' } }, item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—'),
              h('td', { style: { ...cell, whiteSpace: 'nowrap' } },
                h('button', {
                  type: 'button',
                  style: { ...small, padding: '2px 6px', color: item.feedback?.favorite ? '#b8860b' : undefined },
                  disabled: busyAny,
                  title: item.feedback?.favorite ? '取消收藏' : '收藏',
                  onClick: () => void saveFeedback(item.videoId, { favorite: !(item.feedback?.favorite === true) }),
                }, item.feedback?.favorite ? '★' : '☆'),
                h('select', {
                  value: item.feedback?.score ?? '',
                  disabled: busyAny,
                  title: '人工评分',
                  onChange: (event) => void saveFeedback(item.videoId, { score: event.target.value === '' ? null : Number(event.target.value) }),
                  style: { marginLeft: 4, fontSize: 11, padding: '2px 2px' },
                }, ...['', '1', '2', '3', '4', '5'].map((value) => h('option', { key: value || 'none', value }, value === '' ? '—' : value))),
                h('input', {
                  type: 'text',
                  defaultValue: (item.feedback?.tags || []).join(','),
                  disabled: busyAny,
                  title: '逗号分隔，最多 8 个',
                  onBlur: (event) => {
                    const next = String(event.target.value || '').trim();
                    const previous = (item.feedback?.tags || []).join(',');
                    if (next !== previous) void saveFeedback(item.videoId, { tags: next });
                  },
                  style: { marginLeft: 4, width: 84, fontSize: 11, padding: '2px 4px' },
                }),
                item.feedback && h('button', {
                  type: 'button',
                  style: { ...small, marginLeft: 4, padding: '2px 6px' },
                  disabled: busyAny,
                  title: '撤销这条反馈（不影响样例库）',
                  onClick: () => void removeFeedback(item.videoId),
                }, '撤销')),
              h('td', { style: { ...cell, whiteSpace: 'nowrap' } },
                h('button', {
                  type: 'button',
                  style: small,
                  disabled: busyAny || !item.archive.exists,
                  title: item.archive.exists ? item.archive.file : '归档文件不存在，无法定位',
                  onClick: () => void revealFile(item.archive.file),
                }, '打开目录'),
                h('button', {
                  type: 'button',
                  style: { ...small, marginLeft: 6 },
                  onClick: () => copyVideoId(item.videoId),
                }, '复制 ID'))))))),
          h('div', {
            ref: tableProxyRef,
            onScroll: (event) => {
              const proxy = event.currentTarget;
              const target = tableScrollRef.current;
              if (target && Math.abs(target.scrollLeft - proxy.scrollLeft) > 1) target.scrollLeft = proxy.scrollLeft;
            },
            title: '左右拖动可横向查看完整表格',
            style: {
              position: 'sticky',
              bottom: 0,
              zIndex: 3,
              overflowX: 'auto',
              overflowY: 'hidden',
              height: 16,
              background: 'var(--dsw-alias-bg-base, #fff)',
              borderTop: '1px solid var(--dsw-alias-border-l2, #eee)',
            },
          }, h('div', { style: { width: CANDIDATE_TABLE_MIN_WIDTH, height: 1 } })));
      }

      return h('div', { style: { ...column, maxWidth: '100%', minWidth: 0, paddingBottom: 40 } },
        h('div', { style: { ...row, justifyContent: 'space-between' } },
          h('div', null, h('h2', { style: { margin: 0 } }, '大肥鱼 TikTok 助手'), note('只读采集 · 双画像 · 无水印归档')),
          h('div', { style: row },
            h('span', { style: { ...muted, border: '1px solid currentColor', borderRadius: 16, padding: '5px 10px' } }, ready ? '设置服务已连接' : '未连接'),
            lastSyncedAt && h('span', { style: { ...muted, fontSize: 12 } }, `最后更新 ${lastSyncedAt}`),
            h('button', { type: 'button', style: buttonStyle, disabled: busyAny, onClick: () => void manualRefresh() }, busy === 'refresh' ? '刷新中…' : '刷新'))),
        error && h('p', { role: 'alert', style: { color: 'var(--dsw-alias-label-danger, #c00)' } }, error),
        notice && h('p', { role: 'status', style: muted }, notice),
        h('div', { role: 'tablist', 'aria-label': 'TikTok 设置分类', style: row },
          ...CATEGORIES.map((name) => h('button', {
            key: name,
            type: 'button',
            role: 'tab',
            'aria-selected': category === name,
            style: category === name ? primaryStyle : buttonStyle,
            onClick: () => setCategory(name),
          }, name))),

        category === '基础设置' && h('div', { style: column },
          section('模型来源',
            select('模型配置方式', draft.model.source, [
              ['legacy', '默认模型（新开对话默认选择的模型）'],
              ['openai-compatible', '自定义 OpenAI 兼容接口'],
              ['dsh', '选择 DSH 已配置的提供商与模型'],
            ], (value) => setDraft((old) => patchAt(old, ['model', 'source'], value))),
            draft.model.source === 'legacy' && note(state?.model?.defaultSelection
              ? `当前宿主默认模型：${state.model.defaultSelection.provider} / ${state.model.defaultSelection.model}（宿主里改了默认模型，这里会自动跟随）`
              : '未读取到宿主默认模型，运行时会回退到旧版兼容配置（配置文件 / 环境变量 / DSH 网关）。'),
            draft.model.source === 'dsh' && h('div', { style: column },
              select('DSH 提供商', draft.model.provider, [['', ''], ...configuredProviders.map((item) => [item.id, item.name || item.id])], (value) => setDraft((old) => ({ ...old, model: { ...old.model, provider: value, model: '' } }))),
              select('DSH 模型', draft.model.model, [['', ''], ...configuredModels.map((item) => [item.id, `${item.name || item.id}${item.inputModalities?.includes('image') ? ' · 支持图像' : ''}`])], (value) => setDraft((old) => patchAt(old, ['model', 'model'], value))),
              (state?.model?.errors || []).length > 0 && note(state.model.errors.map((item) => `${item.provider || '模型'}: ${item.message}`).join('；'))),
            draft.model.source === 'openai-compatible' && h('div', { style: column },
              field('Base URL', draft.model.api.baseUrl, (value) => setDraft((old) => patchAt(old, ['model', 'api', 'baseUrl'], value))),
              field('API Key', draft.model.api.apiKey, (value) => setDraft((old) => patchAt(old, ['model', 'api', 'apiKey'], value)), { type: 'password' }),
              field('通用模型名（可选）', draft.model.api.model, (value) => setDraft((old) => patchAt(old, ['model', 'api', 'model'], value)))),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
              select('文本模型（可选）', draft.model.textModel, [['', ''], ...modelSelectOptions(draft.model.textModel)], (value) => setDraft((old) => patchAt(old, ['model', 'textModel'], value))),
              select('视觉模型（可选）', draft.model.visionModel, [['', ''], ...modelSelectOptions(draft.model.visionModel)], (value) => setDraft((old) => patchAt(old, ['model', 'visionModel'], value)))),
            note('文本模型用于关键词扩展等文本任务，视觉模型用于抽帧判定。')),
          section('运行环境',
            h('div', { style: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 } },
              select('代理模式', draft.proxy.mode, [['auto', '自动（按已填代理判断）'], ['system', '跟随系统代理（推荐）'], ['manual', '手动填写代理地址']], (value) => setDraft((old) => patchAt(old, ['proxy', 'mode'], value))),
              h('div', { style: { display: 'flex', alignItems: 'flex-end' } },
                h('button', { type: 'button', style: buttonStyle, disabled: busy === 'detectProxy', onClick: () => void detectProxy() }, busy === 'detectProxy' ? '检测中…' : '检测系统代理'))),
            note(!systemProxy
              ? '自动模式会在已有代理地址、代理池或 TIKTOK_PROXY_SERVER 时使用手动代理，否则跟随系统代理；「跟随系统代理」不单独给 Edge 指定地址，可点右侧按钮实时检测。'
              : systemProxy.error
                ? '检测失败：' + systemProxy.error
                : systemProxy.supported === false
                  ? '当前系统不支持自动读取系统代理，请改用「手动」模式填写代理地址。'
                  : systemProxy.enabled && systemProxy.server
                    ? '系统代理已启用：' + systemProxy.server
                    : systemProxy.pacUrl
                      ? '系统代理使用 PAC 脚本：' + systemProxy.pacUrl
                      : '未检测到已启用的系统代理。'),
            field('代理地址（单代理 / 池的兜底）', draft.proxy.server, (value) => setDraft((old) => patchAt(old, ['proxy', 'server'], value))),
            h('label', { style: column }, '代理池（每行一个，留空沿用单代理）', h('textarea', {
              rows: 3,
              value: draft.proxy.pool,
              onChange: (event) => setDraft((old) => patchAt(old, ['proxy', 'pool'], event.target.value)),
              style: { ...control, resize: 'vertical' },
            })),
            note(`代理池 ${state?.proxyPool?.size || 0} 个 · 可用 ${state?.proxyPool?.available || 0} · 冷却 ${state?.proxyPool?.cooling || 0}（连续失败 ${state?.proxyPool?.failureThreshold || 2} 次冷却 ${Math.round((state?.proxyPool?.cooldownMs || 600000) / 60000)} 分钟）${(state?.proxyPool?.ignored || []).length ? ` · 已忽略 ${state.proxyPool.ignored.length} 个非法地址` : ''}`),
            h('div', { style: row },
              h('button', { type: 'button', style: buttonStyle, disabled: busyAny || !(state?.proxyPool?.size > 0), onClick: () => void perform('proxyReset', () => api.request('/proxy/pool/reset', {}), '代理冷却已重置。') }, busy === 'proxyReset' ? '重置中…' : '重置代理冷却')),
            h('div', { style: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 } },
              field('视频归档目录', draft.downloadsDir, (value) => setDraft((old) => patchAt(old, ['downloadsDir'], value))),
              field('CDP 端口', draft.port, (value) => setDraft((old) => patchAt(old, ['port'], numberInputValue(value))), { type: 'number', min: 1024, max: 65535 })),
            field('被拒素材目录（留空 = 直接删除）', draft.rejectedDir, (value) => setDraft((old) => patchAt(old, ['rejectedDir'], value))),
            h('div', { style: row }, h('button', { type: 'button', style: primaryStyle, disabled: busyAny, onClick: () => void saveBasic() }, busy === 'saveBasic' ? '保存中…' : '保存基础设置')))),

        category === '样例与画像' && h('div', { style: column },
          section('上传视频样例',
            note('支持 mp4/mov/webm/mkv，单个不超过 500MB；上传后自动抽帧并由视觉模型描述。'),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
              select('样例归属画像', draft.search.defaultProfileId, [['', '未指定'], ...profiles.map((item) => [item.id, item.name || item.id])], (value) => setDraft((old) => patchAt(old, ['search', 'defaultProfileId'], value))),
              field('新画像 ID（可选）', uploadProfileId, setUploadProfileId)),
            note('填写“新画像 ID”时，本次上传直接归入该画像；留空则用左侧选择。'),
            note('归属与 ID 都留空时，记为“未归属样例”，未归属样例可在生成素材筛选画像时自动归入。'),
            h('label', { style: column }, '选择视频文件', h('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/webm,video/x-matroska', multiple: true, disabled: busyAny, onChange: (event) => void uploadSamples(Array.from(event.target.files || [])) })),
            toggle('作为反样例', uploadPolarity === 'negative', (checked) => setUploadPolarity(checked ? 'negative' : 'positive')),
            uploadStatus && note(`上传 ${uploadStatus.current}/${uploadStatus.total}${uploadStatus.name ? ` · 当前 ${uploadStatus.name}` : ''}`),
            ...(uploadStatus?.errors || []).map((item) => h('p', { key: item, style: { ...muted, color: 'var(--dsw-alias-label-danger, #c00)' } }, item)),
            sampleLibraryBrowser()),
          section('生成素材筛选画像',
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 120px', gap: 10 } },
              field('画像 ID', materialForm.profileId, (value) => setMaterialForm((old) => ({ ...old, profileId: value }))),
              field('画像名称', materialForm.name, (value) => setMaterialForm((old) => ({ ...old, name: value }))),
              field('阈值', materialForm.threshold, (value) => setMaterialForm((old) => ({ ...old, threshold: numberInputValue(value) })), { type: 'number', min: 0, max: 100 })),
            h('div', { style: row },
              h('button', { type: 'button', style: buttonStyle, disabled: busyAny, onClick: () => void buildMaterial() }, busy === 'buildMaterial' ? '生成中…' : '生成素材筛选画像')),
            note('至少 3 条正样例（反样例不计入）。当前 ID 正样例不足时，会自动把“未归属”样例归入该 ID。'),
            materialEditor()),
          section('现有画像',
            note(`素材筛选画像 ${profiles.length} 张`),
            state?.feedback?.pendingRebuild > 0 && note(`有 ${state.feedback.pendingRebuild} 条回流样例在画像最近一次更新之后，点“生成素材筛选画像”重建后才会生效。`),
            ...profiles.map((item) => h('div', { key: `material-${item.id}`, style: { ...row, justifyContent: 'space-between' } },
              note(`${item.id} · ${item.name} · 阈值 ${item.threshold} · 正样例 ${item.sampleCount || 0}${item.negativeCount ? ` · 反样例 ${item.negativeCount}` : ''}${item.generated ? '' : ' · 内置/配置画像（只读）'}`),
              h('div', { style: { ...row, gap: 6 } },
                item.generated && h('button', {
                  type: 'button',
                  style: buttonStyle,
                  onClick: () => {
                    setMaterialDraft(materialDraftFrom(item));
                    setMaterialHistory(null);
                    setMaterialForm({ profileId: item.id, name: item.name || '', threshold: Number(item.threshold) || 60 });
                    setNotice(`已载入素材筛选画像 ${item.id}，可在上方修改后保存。`);
                  },
                }, '编辑'),
                item.generated && (profileDeleteConfirm === item.id
                  ? h('div', { style: { ...row, gap: 6 } },
                    h('span', { style: { color: '#f87171', fontSize: 12 } }, '删除会连该画像的样例视频一起删，不可恢复。'),
                    h('button', { type: 'button', style: dangerStyle, disabled: busyAny, onClick: () => void deleteProfile(item.id) }, '确认删除'),
                    h('button', { type: 'button', style: buttonStyle, onClick: () => setProfileDeleteConfirm(null) }, '取消'))
                  : h('button', { type: 'button', style: dangerStyle, disabled: busyAny, onClick: () => void deleteProfile(item.id) }, '删除')))))),
          section('重置样例与画像',
            note(`将删除全部 ${state?.library?.count || 0} 条样例（含样例库里的视频副本，约 ${Math.round(((state?.library?.samples || []).reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)) / 1024 / 1024)} MB）和全部画像。删除前会把索引与画像 JSON 备份到 library/backups，视频副本不重复备份。`),
            h('div', { style: row },
              h('button', { type: 'button', style: purgeConfirm ? dangerStyle : buttonStyle, disabled: busyAny || ((state?.library?.count || 0) === 0 && profiles.length === 0), onClick: () => void purgeLibrary() }, busy === 'purge' ? '清空中…' : purgeConfirm ? '确认清空（不可恢复）' : '清空全部样例与画像'),
              purgeConfirm && h('button', { type: 'button', style: buttonStyle, onClick: () => { setPurgeConfirm(false); setNotice('已取消清空。'); } }, '取消')))),

        category === '视频观看' && h('div', { style: column },
          h('div', { style: row },
            h('button', { type: 'button', style: primaryStyle, disabled: busyAny || runState.running || dailyExhausted, onClick: () => void startRun() }, busy === 'startRun' ? '启动中…' : '开始采集'),
            h('div', { style: { width: 150 } }, field('本次采集数量', draft.search.targetVideos, (value) => setDraft((old) => patchAt(old, ['search', 'targetVideos'], numberInputValue(value))), { type: 'number', min: 1, max: 200, placeholder: 'max：200' }))),
          runState.running || progressTarget > 0
            ? note(progressTarget > 0
              ? `已成功采集 ${progressFound} / ${progressTarget} 个视频${progressTotal > 0 ? ` · 关键词 ${progressIndex}/${progressTotal}` : ''}${runState.running ? ' · 采集中' : ' · 上次采集'}`
              : '采集任务已启动，正在扩展关键词，进度稍后出现…')
            : note('开始采集会先自动保存当前搜索设置，再按下方种子词与画像启动；只改设置时用下方的「保存」。'),
          section('搜索任务',
            area('目标种子词，每行一个', seeds, setSeeds, 4),
            area('排除词，每行一个（可选）', exclude, setExclude, 2),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 } },
              select('搜索指令语言', draft.search.queryLanguage, LANGUAGES, (value) => setDraft((old) => patchAt(old, ['search', 'queryLanguage'], value))),
              select('目标视频语言', draft.search.contentLanguage, LANGUAGES, (value) => setDraft((old) => patchAt(old, ['search', 'contentLanguage'], value))),
              field('AI 扩展数量', draft.search.targetCount, (value) => setDraft((old) => patchAt(old, ['search', 'targetCount'], numberInputValue(value))), { type: 'number', min: 0, max: 30 })),
            select('判定画像', draft.search.defaultProfileId, [['', '使用默认画像'], ...profiles.map((item) => [item.id, item.name || item.id])], (value) => setDraft((old) => patchAt(old, ['search', 'defaultProfileId'], value))),
            select('低成本预筛', draft.judge.prefilter, [['off', '关闭（每条都抽帧 + 调模型）'], ['rule', '规则预筛（低分/命中 mustNot 不抽帧、不调模型）']], (value) => setDraft((old) => patchAt(old, ['judge', 'prefilter'], value))),
            draft.judge.prefilter === 'rule'
              ? note('规则预筛已开启：规则分低于「阈值 − 20」或命中 mustNot 的素材直接拒绝，不抽帧、不调模型。')
              : note('预筛关闭：每条候选都会抽 3 帧并调用视觉模型。开启“规则预筛”可让明显不合格的素材零成本被拒。'),
            toggle('素材去重（同素材换标题/重发不重复归档）', draft.dedup.enabled, (value) => setDraft((old) => patchAt(old, ['dedup', 'enabled'], value))),
            draft.dedup.enabled
              ? note(`素材去重已开启：下载前先比文案（token 集 Jaccard ≥ 0.95 直接跳过），下载后再比 8 帧画面指纹（汉明 ≤ ${numberOrDefault(draft.dedup.videoDistance, INPUT_DEFAULTS.videoDistance)} 判重，文案 ≥ ${numberOrDefault(draft.dedup.textSimilarity, INPUT_DEFAULTS.textSimilarity)} 且汉明 ≤ 12 也判重）；命中记为“重复”，不归档、不调模型。`)
              : note('素材去重关闭：同一条素材换标题重发会被当成新素材重复归档、重复判定。开启后索引写在 state/dedup-index.jsonl。'),
            draft.dedup.enabled && h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 } },
              field('画面判重汉明距离上限（0-64）', draft.dedup.videoDistance, (value) => setDraft((old) => patchAt(old, ['dedup', 'videoDistance'], numberInputValue(value))), { type: 'number', min: 0, max: 64 }),
              field('文案判重相似度（0-1）', draft.dedup.textSimilarity, (value) => setDraft((old) => patchAt(old, ['dedup', 'textSimilarity'], numberInputValue(value))), { type: 'number', min: 0, max: 1 })),
            note(`已索引素材 ${state?.dedup?.indexed ?? 0} 条${state?.dedup?.enabled ? '' : '（去重关闭时不读索引）'}。`),
            draft.search.contentLanguage === 'auto'
              && note('目标视频语言为“自动”时只记录检测结果，不拦截下载与判定。选定具体语言后，文案语言明显不符的素材会标为“语言不符”，不下载、不判定，省流量与 token。'),
            profiles.length === 0 && note('当前没有可用画像。请先在“样例与画像”生成素材筛选画像，否则采集会被拒绝。'),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 } },
              field('本次任务 token 上限', draft.search.tokenBudget, (value) => setDraft((old) => patchAt(old, ['search', 'tokenBudget'], numberInputValue(value))), { type: 'number', min: 1 }),
              field('每日 token 上限（0 = 不限）', draft.search.dailyTokenBudget, (value) => setDraft((old) => patchAt(old, ['search', 'dailyTokenBudget'], numberInputValue(value))), { type: 'number', min: 0 })),
            dailyBudget && note(`今日 ${dailyBudget.dateKey || ''}：已用 ${dailyBudget.usedToday || 0}${dailyBudget.enabled ? ` / 上限 ${dailyBudget.dailyLimit || 0} / 剩余 ${dailyBudget.remaining || 0}` : ' · 每日上限未启用'}${dailyBudget.estimatedTokens ? `（其中估算 ${dailyBudget.estimatedTokens}）` : ''}`),
            dailyExhausted && h('p', { role: 'alert', style: { color: 'var(--dsw-alias-label-danger, #c00)' } }, '今日 token 预算已用完：调大每日上限或等到明天，否则任务会被直接拒绝。'),
            h('div', { style: row },
              h('button', { type: 'button', style: buttonStyle, disabled: busyAny || runState.running, onClick: () => void previewKeywords() }, busy === 'preview' ? '扩展中…' : 'AI 扩展预览'),
              h('button', { type: 'button', style: buttonStyle, disabled: busyAny, onClick: () => void saveSearch() }, busy === 'saveSearch' ? '保存中…' : '保存'),
              h('button', { type: 'button', style: buttonStyle, disabled: busyAny || !runState.running, onClick: () => void perform('stopRun', () => api.request('/run/stop', {}), '已请求停止任务。') }, '停止')),
            preview && h('div', { style: card }, note(preview.skipped ? 'AI 扩展数量为 0，未调用模型，仅使用种子词。' : `模型 ${preview.model || ''} · 新增 ${preview.count || 0} 个扩展词`), h('div', { style: row }, ...(preview.skipped ? (preview.seeds || []) : (preview.keywords || [])).map((item) => h('span', { key: item, style: { ...muted, border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 14, padding: '4px 9px' } }, item))), preview.budget && note(`本次预算已用 ${preview.budget.used || 0} / ${preview.budget.limit || 0}`))),
          section('任务状态',
            note(`状态 ${runState.status || 'idle'} · 阶段 ${runState.phase || '-'}${runState.startedAt ? ` · 开始 ${new Date(runState.startedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`),
            runState.error && h('p', { role: 'alert', style: { color: 'var(--dsw-alias-label-danger, #c00)' } }, `${runState.error.code || ''} ${runState.error.message || ''}`),
            tokenState && note(`Token ${tokenState.used || 0} / ${tokenState.limit || 0} · 预留 ${tokenState.reserved || 0} · 剩余 ${tokenState.remaining || 0}${tokenState.estimated ? ` · 估算 ${tokenState.estimated}` : ''}`),
            (runState.keywords || []).length > 0 && h('div', { style: row }, ...runState.keywords.map((item) => h('span', { key: item, style: { ...muted, border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 14, padding: '4px 9px' } }, item))),
            runState.result?.result && note(`命中 ${runState.result.result.totals?.found || 0} · 新增 ${runState.result.result.totals?.extracted || 0} · 通过 ${runState.result.result.totals?.accepted || 0} · 拒绝 ${runState.result.result.totals?.rejected || 0} · 成功 ${runState.result.result.totals?.succeeded || 0}`))),

        category === '下载与归档' && h('div', { style: column },
          section('归档目录',
            field('视频归档目录（绝对路径）', draft.downloadsDir, (value) => setDraft((old) => patchAt(old, ['downloadsDir'], value))),
            h('div', { style: row },
              h('button', { type: 'button', style: buttonStyle, disabled: busyAny, onClick: () => void pickArchiveDirectory() }, busy === 'pickDir' ? '等待选择…' : '选择文件夹'),
              h('button', { type: 'button', style: primaryStyle, disabled: busyAny, onClick: () => void saveDownload() }, busy === 'saveDownload' ? '保存中…' : '保存归档目录')),
            note('选择或输入绝对路径后保存；新目录会自动创建，后续视频和 sidecar 直接归档到这里。路径切换不影响已归档文件。')),
          section('下载通道',
            toggle('优先无水印（playAddr，默认开）', draft.download.preferNoWatermark, (value) => setDraft((old) => patchAt(old, ['download', 'preferNoWatermark'], value))),
            draft.download.preferNoWatermark
              ? note('已开启：优先用播放流 playAddr（无水印）。')
              : note('已关闭：使用官方 downloadAddr，画面带 "♪ TikTok @作者" 水印（更稳但不可直接用）。'),
            select('默认通道', draft.download.channel, [
              ['page', '页面上下文下载（稳定，兼容旧行为）'],
              ['aix', 'AIX 无水印通道'],
              ['auto', 'AIX 优先，失败按策略处理'],
            ], (value) => setDraft((old) => patchAt(old, ['download', 'channel'], value))),
            h('div', { style: card },
              note(aix?.ok ? `AIX ${aix.version} · ${aix.name} · TikTok 捕获${aix.hasTikTokContentScript ? '已启用' : '缺失'}` : `AIX 未就绪：${aix?.message || '未检测'}`),
              note(aix?.ok ? 'AIX 原生下载在当前 TikTok CDN 上可能被拒绝；可启用下方“URL 页面抓取”安全兜底。' : '请先在插件专用 Edge profile 中安装并启用 AIX 智能下载器。')),
            toggle('允许 AIX 无水印 URL 经 TikTok 页面抓取归档', draft.download.aix.allowAixUrlPageFetch, (value) => setDraft((old) => patchAt(old, ['download', 'aix', 'allowAixUrlPageFetch'], value))),
            toggle('AIX 失败时保留人工接管入口', draft.download.aix.manualFallback, (value) => setDraft((old) => patchAt(old, ['download', 'aix', 'manualFallback'], value))),
            toggle('人工接管仍失败后回退页面下载', draft.download.aix.allowPageFallback, (value) => setDraft((old) => patchAt(old, ['download', 'aix', 'allowPageFallback'], value))),
            note('URL 页面抓取会校验 MP4 文件头、最小体积和视频时长，时长与作品不一致时拒绝归档，避免保存推荐流的下一条视频。'),
            h('div', { style: row }, h('button', { type: 'button', style: primaryStyle, disabled: busyAny, onClick: () => void saveDownload() }, busy === 'saveDownload' ? '保存中…' : '保存下载设置'))),
          section('归档校验',
            note('外部下载文件先进入 runtime staging，通过 MP4 文件头、最小体积和视频时长校验后才写入关键词/日期目录并生成同名 sidecar。')),
          section('AIX 可用性',
            ...(aix ? [note(`状态：${aix.ok ? '已检测' : '不可用'}`), aix.code && note(`错误码：${aix.code}`), aix.message && note(aix.message)] : [note('尚未读取 AIX 状态')]))),

        category === '素材库' && h('div', { style: column },
          section('候选素材',
            h('div', { style: { display: 'grid', gridTemplateColumns: '150px 1fr 130px', gap: 10, alignItems: 'end' } },
              select('状态筛选', candidateFilter.status, [['all', '全部状态'], ...(candidates?.statuses || []).map((item) => [item, CANDIDATE_STATUS_LABELS[item] || item])], (value) => updateCandidateFilter({ status: value, page: 0 })),
              h('label', { style: column },
                h('span', null, '采集日期'),
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h('input', {
                    type: 'date',
                    value: candidateFilter.date,
                    max: todayKey(),
                    style: { ...control, flex: '1 1 auto', minWidth: 0 },
                    onChange: (event) => updateCandidateFilter({ date: event.target.value, page: 0 }),
                  }),
                  h('button', {
                    type: 'button',
                    style: { ...buttonStyle, padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap' },
                    onClick: () => updateCandidateFilter({ date: todayKey(), page: 0 }),
                  }, '今天'),
                  h('button', {
                    type: 'button',
                    style: { ...buttonStyle, padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap' },
                    disabled: !candidateFilter.date,
                    onClick: () => updateCandidateFilter({ date: '', page: 0 }),
                  }, '清除'))),
              select('人工评分', String(candidateFilter.minScore || 0), [['0', '不限分数'], ['1', '≥1 分'], ['2', '≥2 分'], ['3', '≥3 分'], ['4', '≥4 分'], ['5', '=5 分']], (value) => updateCandidateFilter({ minScore: Number(value), page: 0 }))),
            h('div', {
              style: {
                ...card,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                borderLeft: '3px solid var(--dsw-alias-brand-primary, #1677ff)',
              },
            },
              h('div', { style: { ...row, justifyContent: 'space-between', alignItems: 'baseline', gap: 8 } },
                h('strong', { style: { fontSize: 13 } }, 'videoId 检索'),
                note('粘贴完整 videoId，回车或点“检索”直接定位到该视频')),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('div', { style: { position: 'relative', flex: '1 1 240px', minWidth: 180 } },
                  h('input', {
                    type: 'text',
                    value: candidateFilter.videoId,
                    style: { ...control, width: '100%', paddingRight: candidateFilter.videoId ? 30 : undefined },
                    onChange: (event) => {
                      setPageHint(null);
                      updateCandidateFilter({ videoId: event.target.value, page: 0 });
                    },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        runVideoIdSearch();
                      }
                    },
                  }),
                  candidateFilter.videoId && h('button', {
                    type: 'button',
                    title: '清空检索条件',
                    style: { position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 0, background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 0, color: 'var(--dsw-alias-label-secondary, #888)' },
                    onClick: clearVideoIdSearch,
                  }, '×')),
                h('button', { type: 'button', style: { ...primaryStyle, minWidth: 72 }, disabled: candidateBusy || busyAny, onClick: runVideoIdSearch }, candidateBusy ? '检索中…' : '检索'),
                h('button', { type: 'button', style: buttonStyle, disabled: candidateBusy || busyAny || !candidateFilter.videoId, onClick: clearVideoIdSearch }, '清空检索')),
              h('div', { style: { ...row, gap: 10, flexWrap: 'wrap', alignItems: 'baseline' } },
                candidateFilter.videoId
                  ? h('span', { style: { ...muted, color: 'var(--dsw-alias-label-primary, #222)' } }, `检索 “${candidateFilter.videoId.trim()}”：命中 ${candidates?.total ?? 0} 条`)
                  : h('span', { style: muted }, `共 ${candidates?.total ?? 0} 条`),
                candidateFilter.date && h('span', { style: muted }, `采集日期 ${candidateFilter.date}`),
                Number(candidates?.hiddenByAge) > 0 && h('span', { style: muted }, `已自动隐藏 ${candidates.hiddenByAge} 条超过 ${LIBRARY_HIDE_AFTER_DAYS} 天的旧素材（源文件与数据都保留）`),
                h('span', { style: muted }, `反馈 ${state?.feedback?.summary?.total || 0} 条 · 收藏 ${state?.feedback?.summary?.favorite || 0} · 已评分 ${state?.feedback?.summary?.scored || 0}${state?.feedback?.pendingRebuild ? ` · 待重建 ${state.feedback.pendingRebuild}` : ''}`))),
            h('div', { style: row },
              h('button', { type: 'button', style: buttonStyle, disabled: candidateBusy || busyAny, onClick: () => updateCandidateFilter({ reload: (candidateFilter.reload || 0) + 1 }) }, candidateBusy ? '读取中…' : '刷新列表'),
              h('button', { type: 'button', style: buttonStyle, disabled: candidateBusy || busyAny, onClick: () => void exportCandidates() }, busy === 'export' ? '导出中…' : '导出 CSV'),
              exportResult?.file && h('button', { type: 'button', style: buttonStyle, disabled: busyAny, onClick: () => void revealFile(exportResult.file, 'report') }, '打开 CSV'),
              h('span', { style: muted }, `共 ${candidates?.total ?? 0} 条 · 第 ${Math.floor((candidates?.offset || 0) / CANDIDATE_PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil((Number(candidates?.total) || 0) / CANDIDATE_PAGE_SIZE))} 页 · 每页 ${CANDIDATE_PAGE_SIZE} 条`),
              h('button', { type: 'button', style: buttonStyle, disabled: candidateBusy || (candidates?.offset || 0) <= 0, onClick: () => updateCandidateFilter({ page: Math.max(0, candidateFilter.page - 1) }) }, '上一页'),
              h('button', { type: 'button', style: buttonStyle, disabled: candidateBusy || !candidates?.hasMore, onClick: () => updateCandidateFilter({ page: candidateFilter.page + 1 }) }, '下一页'),
              h('span', { style: { ...muted, display: 'flex', alignItems: 'center', gap: 6 } },
                h('input', {
                  type: 'number',
                  min: 1,
                  value: pageInput,
                  style: { ...control, width: 76, padding: '5px 8px' },
                  onChange: (event) => setPageInput(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      jumpToPage();
                    }
                  },
                }),
                h('button', { type: 'button', style: buttonStyle, disabled: candidateBusy, onClick: jumpToPage }, '跳转'))),
            pageHint && h('p', {
              role: 'status',
              style: {
                ...muted,
                color: pageHint.tone === 'error'
                  ? 'var(--dsw-alias-label-danger, #c00)'
                  : 'var(--dsw-alias-label-secondary, #555)',
              },
            }, pageHint.text),
            h('div', { style: row }, ...Object.entries(candidates?.counts?.byStatus || {}).sort((a, b) => b[1] - a[1]).map(([status, count]) => h('span', { key: status, style: { ...muted, border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 14, padding: '3px 9px' } }, `${CANDIDATE_STATUS_LABELS[status] || status} ${count}`))),
            candidateTable()),
          section('评分回流（写样例库前必须手动确认）',
            note(`待重建提示：${state?.feedback?.pendingRebuild || 0} 条回流发生在画像最近一次更新之后，需要到“样例与画像”手动重建画像才会生效。`),
            toggle('回流时调用视觉模型生成描述', reflowDescribe, setReflowDescribe),
            h('div', { style: row },
              h('button', {
                type: 'button',
                style: reflowConfirm === 'positive' ? dangerStyle : buttonStyle,
                disabled: busyAny,
                onClick: () => {
                  if (reflowConfirm === 'positive') void reflowByScore('positive');
                  else setReflowConfirm('positive');
                },
              }, busy === 'reflow' ? '回流中…' : reflowConfirm === 'positive' ? '确认：把 ≥4 分加入正样例' : '把 ≥4 分加入正样例'),
              h('button', {
                type: 'button',
                style: reflowConfirm === 'negative' ? dangerStyle : buttonStyle,
                disabled: busyAny,
                onClick: () => {
                  if (reflowConfirm === 'negative') void reflowByScore('negative');
                  else setReflowConfirm('negative');
                },
              }, busy === 'reflow' ? '回流中…' : reflowConfirm === 'negative' ? '确认：把 ≤2 分加入负样例' : '把 ≤2 分加入负样例'),
              reflowConfirm && h('button', { type: 'button', style: buttonStyle, onClick: () => { setReflowConfirm(null); setNotice('已取消回流。'); } }, '取消')),
            note('加入后需要重建画像，评分本身不会自动改画像。'))),

        category === '自检与用量' && h('div', { style: column },
          section('插件自检',
            h('div', { style: row },
              h('button', { type: 'button', style: buttonStyle, disabled: busyAny, onClick: async () => {
                const value = await perform('diagnostics', () => api.request('/diagnostics', {}, { timeoutMs: 120_000 }), '自检完成。');
                if (value) setDiagnostics(value);
              } }, busy === 'diagnostics' ? '自检中…' : '运行自检')),
            diagnostics && h('div', { style: column },
              note(`自检结果：${diagnostics.summary || (diagnostics.ok ? '全部通过' : '存在未通过项')}`),
              ...(diagnostics.checks || []).map((item) => note(`${item.ok ? '通过' : '未通过'} · ${item.label}：${item.detail || ''}${item.fix ? ` · 建议：${item.fix}` : ''}`)))),
          section('Token 用量',
            tokenState && note(`当前任务 ${tokenState.used || 0} / ${tokenState.limit || 0}，估算 ${tokenState.estimated || 0}，剩余 ${tokenState.remaining || 0}`),
            dailyBudget && note(`今日 ${dailyBudget.dateKey || ''}：已用 ${dailyBudget.usedToday || 0}${dailyBudget.enabled ? ` / 上限 ${dailyBudget.dailyLimit || 0} / 剩余 ${dailyBudget.remaining || 0}` : ' · 每日上限未启用'} · 已结算 ${dailyBudget.settledEvents || 0} 次${dailyBudget.estimatedTokens ? ` · 估算 ${dailyBudget.estimatedTokens}` : ''}`),
            dailyBudget && Object.entries(dailyBudget.byOperation || {}).sort((left, right) => right[1] - left[1]).map(([operation, tokens]) => note(`今日 ${operation}：${tokens} Token`)),
            ...(state?.tokenUsage || []).slice(-12).reverse().map((item, index) => note(`${item.timestamp ? new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false }) : '-'} · ${item.operation || item.reservationId || '-'} · ${item.event || ''} · ${item.totalTokens ?? item.estimatedTokens ?? 0} Token${item.estimated ? '（估算）' : ''}`)),
            !state?.tokenUsage?.length && note('暂无 token 账本记录。')),
          section('重试队列',
            note(`待重试 ${retryState?.pending ?? 0} 条 · 已到点 ${retryState?.due ?? 0} 条 · 已用尽 ${retryState?.exhausted ?? 0} 条 · 已处理 ${retryState?.resolved ?? 0} 条（每条最多 ${retryState?.maxAttempts ?? 3} 次）`),
            h('div', { style: row },
              h('button', { type: 'button', style: buttonStyle, disabled: busyAny || !(retryState?.total > 0), onClick: () => void perform('retryClear', () => api.request('/retry/clear', {}), '重试队列已清空。') }, busy === 'retryClear' ? '清空中…' : '清空重试队列')),
            ...(retryState?.entries || []).slice(0, 5).map((item) => note(`${item.videoId} · 第 ${item.attempt} 次 · ${item.code || '-'} · 下次 ${item.nextRunAt ? new Date(item.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : '-'}`))),
          section('运行环境',
            note(`视觉打分：${state?.model?.active?.model || '未配置'}（${state?.model?.active?.modelSource === 'dsh' ? 'DSH 模型' : state?.model?.active?.modelSource === 'openai-compatible' ? 'OpenAI 兼容接口' : '来源未知'}）`),
            note(`文本模型：${state?.settings?.config?.model?.textModel || '未单独指定'}`),
            note(`下载通道：${state?.download?.channel || '-'} · AIX ${aix?.ok ? `${aix.version}` : '不可用'}`),
            note(`样例库：${state?.library?.count || 0} 条样例`)))
      );
    }

    function apply(ctx) {
      let rpc;
      try { rpc = (ctx.get?.('connection') || ctx.connection)?.rpc; } catch {}
      const Page = rpc ? () => h(SettingsPage, { rpc }) : SettingsPage;
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'tiktok-browser',
        order: 17,
        label: () => '刷 TikTok',
      }, Page));
    }

    return { name: 'tiktok-browser-settings', inject: ['slots', 'connection'], apply, SettingsPage, createSettingsTransport, normalize };
  },
});
