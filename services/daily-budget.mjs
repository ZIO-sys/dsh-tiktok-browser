// daily-budget.mjs — 按本地日期（默认 Asia/Shanghai）汇总 token 账本，给出每日预算状态。
//
// 账本由 services/token-budget.mjs 追加写，事件有 reserve / settle / release / exhausted。
// 这里只统计 settle：未结算的预留不计入已用，避免进程崩溃后余额永久为负。
import { existsSync, readFileSync } from 'node:fs';

export const DAILY_BUDGET_TIME_ZONE = 'Asia/Shanghai';
export const DEFAULT_DAILY_TOKEN_BUDGET = 200_000;
export const DAILY_BUDGET_EXHAUSTED = 'DAILY_TOKEN_BUDGET_EXHAUSTED';

const formatters = new Map();

function dateFormatter(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 把时刻换算成指定时区的本地日期（YYYY-MM-DD）。 */
export function localDateKey(value = new Date(), timeZone = DAILY_BUDGET_TIME_ZONE) {
  const date = toDate(value);
  if (!date) throw new TypeError('now 必须是有效时间。');
  return dateFormatter(timeZone || DAILY_BUDGET_TIME_ZONE).format(date);
}

/**
 * 汇总账本里“本地今天”已结算的 token。
 * @returns {{dateKey: string, usedToday: number, estimatedTokens: number, settledEvents: number, skippedLines: number, byOperation: Record<string, number>}}
 */
export function readDailyUsage({ ledgerPath = null, now = new Date(), timeZone = DAILY_BUDGET_TIME_ZONE } = {}) {
  const dateKey = localDateKey(now, timeZone);
  const summary = {
    dateKey,
    usedToday: 0,
    estimatedTokens: 0,
    settledEvents: 0,
    skippedLines: 0,
    byOperation: {},
  };
  if (!ledgerPath || !existsSync(ledgerPath)) return summary;
  let text;
  try {
    text = readFileSync(ledgerPath, 'utf8');
  } catch {
    return summary;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      summary.skippedLines += 1;
      continue;
    }
    if (!record || typeof record !== 'object' || record.event !== 'settle') continue;
    const tokens = Number(record.totalTokens);
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      summary.skippedLines += 1;
      continue;
    }
    const at = record.timestamp ? toDate(record.timestamp) : null;
    if (!at) {
      summary.skippedLines += 1;
      continue;
    }
    if (localDateKey(at, timeZone) !== dateKey) continue;
    summary.usedToday += tokens;
    summary.settledEvents += 1;
    if (record.estimated === true) summary.estimatedTokens += tokens;
    const operation = String(record.operation || 'unknown').slice(0, 80);
    summary.byOperation[operation] = (summary.byOperation[operation] || 0) + tokens;
  }
  return summary;
}

/**
 * 每日预算状态：dailyLimit<=0/缺省时视为不限；taskLimit 为单次任务上限。
 * effectiveLimit = min(taskLimit, 今日剩余)，供创建 TokenBudget 使用。
 */
export function computeDailyBudget({
  ledgerPath = null,
  dailyLimit = DEFAULT_DAILY_TOKEN_BUDGET,
  taskLimit = null,
  now = new Date(),
  timeZone = DAILY_BUDGET_TIME_ZONE,
} = {}) {
  const usage = readDailyUsage({ ledgerPath, now, timeZone });
  const limit = Number(dailyLimit);
  const task = Number(taskLimit);
  const enabled = Number.isSafeInteger(limit) && limit > 0;
  const taskLimitValue = Number.isSafeInteger(task) && task > 0 ? task : null;
  const remaining = enabled ? Math.max(0, limit - usage.usedToday) : null;
  const effectiveLimit = enabled
    ? Math.min(taskLimitValue == null ? remaining : taskLimitValue, remaining)
    : taskLimitValue;
  return {
    enabled,
    dailyLimit: enabled ? limit : null,
    usedToday: usage.usedToday,
    remaining,
    taskLimit: taskLimitValue,
    effectiveLimit,
    exhausted: enabled && remaining <= 0,
    dateKey: usage.dateKey,
    estimatedTokens: usage.estimatedTokens,
    settledEvents: usage.settledEvents,
    skippedLines: usage.skippedLines,
    byOperation: usage.byOperation,
  };
}

/** 统一的“今日预算耗尽”返回体，调用方直接 return。 */
export function dailyBudgetExhaustedResult(daily = {}) {
  const used = Number(daily.usedToday) || 0;
  const limit = Number(daily.dailyLimit) || 0;
  return {
    ok: false,
    code: DAILY_BUDGET_EXHAUSTED,
    message: `今日 token 预算已用完（已用 ${used} / 上限 ${limit}）。明天自动恢复，或在“视频观看”里调大每日上限（0 表示不限）。`,
    daily,
  };
}

export function createDailyBudget(options) {
  return computeDailyBudget(options);
}
