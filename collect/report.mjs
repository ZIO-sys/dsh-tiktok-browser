/**
 * M6：采集报告（Markdown）。
 *
 * 只读本地状态文件（candidates.jsonl / runs.jsonl），不发网络请求、不调用模型：
 *  - 本次/今日跑了什么关键词、每个关键词命中多少；
 *  - 状态分布（accepted / rejected / archived / extracted / failed）；
 *  - 失败原因分布；
 *  - 被拒素材的典型理由（帮助判断画像是否过严）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function fmtDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDateTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${fmtDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function countBy(rows, pick) {
  const out = {};
  for (const row of rows) {
    const key = pick(row) || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((cell) => String(cell ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/**
 * @param {object} options
 * @param {object} options.store createStore 实例
 * @param {string} options.reportsDir 报告输出目录
 * @param {number} [options.sinceDays] 统计最近多少天（默认 1 = 今天）
 * @param {Date} [options.now]
 */
export function buildReport({ store, reportsDir, sinceDays = 1, now = new Date() } = {}) {
  if (!store) throw new TypeError('buildReport 需要 store');
  if (!reportsDir) throw new TypeError('buildReport 需要 reportsDir');

  const since = now.getTime() - Math.max(1, Number(sinceDays) || 1) * 24 * 60 * 60 * 1000;
  // 报告必须覆盖全部候选：limit 截断会让统计静默失真（M8 修复）。
  // listCandidates 无 limit 时读全量；M9 的 jsonl 压缩保证全量读不会随时间无限变慢。
  const all = store.listCandidates();
  const recent = all.filter((row) => {
    const at = Date.parse(row.updatedAt || row.extractedAt || '');
    return Number.isFinite(at) ? at >= since : true;
  });
  const runs = store.readRuns({ limit: 200 }).filter((run) => {
    const at = Date.parse(run.at || '');
    return Number.isFinite(at) ? at >= since : false;
  });

  const counts = store.countCandidates();
  const recentByStatus = countBy(recent, (row) => row.status);
  const byQuery = countBy(recent, (row) => row.query);
  const failCodes = countBy(
    recent.filter((row) => row.status === 'download_failed' || row.status === 'extract_failed'),
    (row) => row.archiveError?.code || row.extractError?.code || row.status,
  );
  const rejectReasons = {};
  const NEGATIVE = /不符|没有|无|不是|缺少|未能|不匹配|不像|不够|拒|未出现|没有出现/;
  for (const row of recent) {
    if (row.status !== 'rejected') continue;
    const reasons = row.judge?.reasons || row.judgeReason || [];
    const list = (Array.isArray(reasons) ? reasons : [reasons]).map((item) => String(item || '')).filter(Boolean);
    // 模型理由追加在规则理由之后；优先取“负面表述”的理由，退而取最后两条。
    const negative = list.filter((item) => NEGATIVE.test(item));
    const picked = (negative.length ? negative : list.slice(-2)).slice(0, 2);
    for (const reason of picked) {
      const key = String(reason || '').slice(0, 40);
      if (key) rejectReasons[key] = (rejectReasons[key] || 0) + 1;
    }
  }
  const acceptedRows = recent.filter((row) => row.status === 'accepted');
  const topReject = Object.entries(rejectReasons).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const lines = [];
  lines.push(`# TikTok 素材采集报告 · ${fmtDate(now)}`);
  lines.push('');
  lines.push(`- 生成时间：${fmtDateTime(now)}`);
  lines.push(`- 统计范围：最近 ${sinceDays} 天`);
  lines.push(`- 库内累计：${counts.total} 条（${Object.entries(counts.byStatus).map(([k, v]) => `${k} ${v}`).join('，') || '空'}）`);
  lines.push('');

  lines.push('## 本次运行');
  if (!runs.length) {
    lines.push('最近没有运行记录。');
  } else {
    const rows = runs.slice(0, 12).map((run) => {
      const totals = run.totals || {};
      const found = run.found ?? totals.found ?? '';
      const fresh = run.fresh ?? totals.fresh ?? '';
      const stored = run.extracted ?? run.downloaded ?? totals.downloaded ?? totals.accepted ?? '';
      return [
        String(run.at || '').replace('T', ' ').slice(0, 16),
        run.type || 'search',
        run.query || (run.keywords || []).join(' / '),
        found,
        fresh,
        stored,
        run.halted ? '挂起' : '完成',
        run.durationMs ? `${Math.round(run.durationMs / 1000)}s` : '',
      ];
    });
    lines.push(table(['时间', '类型', '关键词', '命中', '新增', '入库', '状态', '耗时'], rows));
  }
  lines.push('');

  lines.push('## 状态分布（最近）');
  if (!recent.length) {
    lines.push('最近没有新素材。');
  } else {
    lines.push(
      table(
        ['状态', '数量'],
        Object.entries(recentByStatus).sort((a, b) => b[1] - a[1]),
      ),
    );
  }
  lines.push('');

  lines.push('## 语言过滤（最近）');
  {
    const skipped = recent.filter((row) => row.status === 'skipped_language');
    const detectedRows = recent.filter((row) => row.language && row.language.code);
    if (!skipped.length && !detectedRows.length) {
      lines.push('最近没有语言检测记录（旧候选未检测语言）。');
    } else {
      lines.push(`- 因语言不符跳过：${skipped.length} 条（不下载、不判定）`);
      const byDetected = countBy(detectedRows, (row) => row.language.code || 'unknown');
      lines.push(table(['检测语言', '条数'], Object.entries(byDetected).sort((a, b) => b[1] - a[1])));
      if (skipped.length) {
        const byPair = countBy(skipped, (row) => `${row.language?.expected || '?'} ← ${row.language?.code || 'unknown'}`);
        lines.push(table(['目标 ← 实际', '条数'], Object.entries(byPair).sort((a, b) => b[1] - a[1])));
      }
    }
  }
  lines.push('');

  lines.push('## 规则预筛（最近）');
  {
    const prefilteredRuns = runs.filter((run) => Number(run.prefilterSkipped ?? run.totals?.prefilterSkipped) > 0);
    const skippedTotal = runs.reduce((sum, run) => sum + (Number(run.prefilterSkipped ?? run.totals?.prefilterSkipped) || 0), 0);
    const savedTokens = runs.reduce((sum, run) => sum + (Number(run.prefilterTokensSaved ?? run.totals?.prefilterTokensSaved) || 0), 0);
    if (!skippedTotal) {
      lines.push('最近没有规则预筛拒绝（预筛关闭，或没有低分/命中 mustNot 的素材）。');
    } else {
      lines.push(`- 规则预筛拒绝：${skippedTotal} 条（不抽帧、不调模型，来自 ${prefilteredRuns.length} 次运行）`);
      lines.push(`- 估算节省 token：约 ${savedTokens}`);
    }
  }
  lines.push('');

  lines.push('## 水印来源（最近）');
  {
    const archived = recent.filter((row) => row.archive?.file);
    const effective = (row) => {
      const mark = row.archive?.watermark;
      if (mark === 'none' || mark === 'watermarked') return mark;
      const source = String(row.archive?.source || '');
      if (/^playAddr/i.test(source)) return 'none';
      if (/^downloadAddr/i.test(source)) return 'watermarked';
      if (/^aix/i.test(source)) return 'none';
      return 'unknown';
    };
    const counts = countBy(archived, effective);
    if (!archived.length) {
      lines.push('最近没有新归档。');
    } else {
      lines.push(`- 无水印：${counts.none || 0} 条（playAddr / AIX 通道）`);
      lines.push(`- 带水印：${counts.watermarked || 0} 条（downloadAddr 兜底，建议重下）`);
      if (counts.unknown) lines.push(`- 未知：${counts.unknown} 条（P2-7 之前的老记录没有 watermark 字段）`);
    }
  }
  lines.push('');

  lines.push('## 素材去重（最近）');
  {
    const dupSkipped = runs.reduce((sum, run) => sum + (Number(run.duplicateSkipped ?? run.totals?.duplicateSkipped) || 0), 0);
    const dupChecked = runs.reduce((sum, run) => sum + (Number(run.duplicateChecked ?? run.totals?.duplicateChecked) || 0), 0);
    const hashFailed = runs.reduce((sum, run) => sum + (Number(run.duplicateHashFailed ?? run.totals?.duplicateHashFailed) || 0), 0);
    const dupRows = recent.filter((row) => row.status === 'duplicate');
    if (!dupSkipped && !dupChecked && !dupRows.length) {
      lines.push('最近没有判重记录（开关关闭，或没有进入判重阶段的素材）。');
    } else {
      lines.push(`- 判重命中：${dupSkipped} 次（不归档、不调模型）`);
      lines.push(`- 已算指纹并比对：${dupChecked} 条${hashFailed ? `，指纹失败 ${hashFailed} 条（退化为只比文案）` : ''}`);
      if (dupRows.length) {
        const byStage = countBy(dupRows, (row) => `${row.dedup?.stage || 'unknown'} / ${row.dedup?.reason || 'unknown'}`);
        lines.push(table(['阶段 / 依据', '条数'], Object.entries(byStage).sort((a, b) => b[1] - a[1])));
      }
    }
  }
  lines.push('');

  lines.push('## 按关键词');
  if (!byQuery || !Object.keys(byQuery).length) {
    lines.push('无。');
  } else {
    lines.push(table(['关键词', '条数'], Object.entries(byQuery).sort((a, b) => b[1] - a[1])));
  }
  lines.push('');

  if (Object.keys(failCodes).length) {
    lines.push('## 失败原因');
    lines.push(table(['原因', '次数'], Object.entries(failCodes).sort((a, b) => b[1] - a[1])));
    lines.push('');
  }

  if (topReject.length) {
    lines.push('## 被拒的典型理由');
    lines.push(table(['理由', '次数'], topReject));
    lines.push('');
  }

  if (acceptedRows.length) {
    lines.push('## 通过的素材');
    const rows = acceptedRows.slice(0, 20).map((row) => [
      row.videoId,
      String(row.author?.uniqueId || row.author?.nickname || row.nickname || '').slice(0, 18),
      row.judge?.score ?? '',
      row.judge?.modelScore ?? '',
      row.archive?.file ? '已下载' : '未下载',
      String(row.desc || '').replace(/\s+/g, ' ').slice(0, 30),
    ]);
    lines.push(table(['videoId', '作者', '总分', '模型分', '文件', '文案'], rows));
    lines.push('');
  }

  const markdown = `${lines.join('\n')}\n`;
  mkdirSync(reportsDir, { recursive: true });
  const file = join(reportsDir, `report-${fmtDate(now)}.md`);
  writeFileSync(file, markdown, 'utf8');
  return {
    ok: true,
    file,
    markdown,
    stats: {
      recent: recent.length,
      total: counts.total,
      byStatus: counts.byStatus,
      skippedLanguage: recent.filter((row) => row.status === 'skipped_language').length,
      skippedAspect: recent.filter((row) => row.status === 'skipped_aspect').length,
      prefilterSkipped: runs.reduce((sum, run) => sum + (Number(run.prefilterSkipped ?? run.totals?.prefilterSkipped) || 0), 0),
      watermarked: recent.filter((row) => row.archive?.watermark === 'watermarked').length,
      duplicateSkipped: runs.reduce((sum, run) => sum + (Number(run.duplicateSkipped ?? run.totals?.duplicateSkipped) || 0), 0),
      duplicateChecked: runs.reduce((sum, run) => sum + (Number(run.duplicateChecked ?? run.totals?.duplicateChecked) || 0), 0),
    },
  };
}
