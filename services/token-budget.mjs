// token-budget.mjs — 单次任务级 Token 预算，支持预留、结算与可选 JSONL 账本。
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function isTokenCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function createError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

/** 简单的四字符约一 Token 估算，可通过构造参数替换。 */
export function defaultEstimateText(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

export class TokenBudget {
  #limit;
  #estimator;
  #ledgerPath;
  #sequence = 0;
  #reserved = 0;
  #used = 0;
  #estimated = 0;
  #active = new Map();
  #operations = [];

  constructor({ limit, estimateText = defaultEstimateText, ledgerPath = null } = {}) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new TypeError('limit 必须是正整数。');
    }
    if (typeof estimateText !== 'function') {
      throw new TypeError('estimateText 必须是函数。');
    }
    this.#limit = limit;
    this.#estimator = estimateText;
    this.#ledgerPath = ledgerPath == null || ledgerPath === '' ? null : String(ledgerPath);
  }

  estimateText(text) {
    const value = this.#estimator(String(text ?? ''));
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('estimateText 必须返回非负有限数。');
    }
    return Math.ceil(value);
  }

  reserve({ operation, estimatedTokens, metadata = null } = {}) {
    if (typeof operation !== 'string' || !operation.trim()) {
      throw new TypeError('operation 必须是非空字符串。');
    }
    if (!isTokenCount(estimatedTokens)) {
      throw new TypeError('estimatedTokens 必须是非负整数。');
    }

    const name = operation.trim();
    const remaining = this.#remaining();
    if (estimatedTokens > remaining) {
      const error = createError(
        'TOKEN_BUDGET_EXHAUSTED',
        `Token 预算不足：${name} 需要 ${estimatedTokens}，剩余 ${remaining}。`,
        { operation: name, requested: estimatedTokens, remaining },
      );
      this.#append({ event: 'exhausted', operation: name, requested: estimatedTokens, remaining, code: error.code });
      throw error;
    }

    const record = {
      id: `reservation-${++this.#sequence}`,
      operation: name,
      estimatedTokens,
      metadata,
      status: 'reserved',
      totalTokens: null,
      estimated: false,
    };
    this.#active.set(record.id, record);
    this.#operations.push(record);
    this.#reserved += estimatedTokens;
    this.#append(this.#ledgerRecord('reserve', record));
    return this.#publicRecord(record);
  }

  settle(reservation, usage = null) {
    const record = this.#takeActive(reservation);
    const actualTotal = this.#usageTotal(usage);
    const estimated = actualTotal == null;
    const totalTokens = estimated ? record.estimatedTokens : actualTotal;

    record.status = 'settled';
    record.totalTokens = totalTokens;
    record.estimated = estimated;
    this.#reserved -= record.estimatedTokens;
    this.#used += totalTokens;
    if (estimated) this.#estimated += totalTokens;
    this.#append(this.#ledgerRecord('settle', record));
    return this.#publicRecord(record);
  }

  release(reservation) {
    const record = this.#takeActive(reservation);
    record.status = 'released';
    this.#reserved -= record.estimatedTokens;
    this.#append(this.#ledgerRecord('release', record));
    return this.#publicRecord(record);
  }

  state() {
    return {
      limit: this.#limit,
      reserved: this.#reserved,
      used: this.#used,
      remaining: this.#remaining(),
      estimated: this.#estimated,
      operations: this.#operations.map((record) => {
        const { metadata, ...summary } = record;
        return { ...summary };
      }),
    };
  }

  #remaining() {
    return Math.max(0, this.#limit - this.#used - this.#reserved);
  }

  #takeActive(reservation) {
    const id = typeof reservation === 'string' ? reservation : reservation?.id;
    const record = this.#active.get(id);
    if (!record) {
      throw createError('TOKEN_BUDGET_RESERVATION_INVALID', '预留不存在或已完成结算/释放。');
    }
    this.#active.delete(id);
    return record;
  }

  #usageTotal(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const totalTokens = usage.totalTokens ?? usage.total_tokens;
    if (isTokenCount(totalTokens)) return totalTokens;
    const promptTokens = usage.promptTokens ?? usage.prompt_tokens;
    const completionTokens = usage.completionTokens ?? usage.completion_tokens;
    const hasPrompt = isTokenCount(promptTokens);
    const hasCompletion = isTokenCount(completionTokens);
    if (!hasPrompt && !hasCompletion) return null;
    return (hasPrompt ? promptTokens : 0) + (hasCompletion ? completionTokens : 0);
  }

  #publicRecord(record) {
    return { ...record };
  }

  #ledgerRecord(event, record) {
    return {
      event,
      reservationId: record.id,
      operation: record.operation,
      estimatedTokens: record.estimatedTokens,
      totalTokens: record.totalTokens,
      estimated: record.estimated,
      status: record.status,
    };
  }

  #append(event) {
    if (!this.#ledgerPath) return;
    // 仅写入白名单数值和状态，绝不写 metadata、API key 或视频文案。
    mkdirSync(dirname(this.#ledgerPath), { recursive: true });
    appendFileSync(this.#ledgerPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, 'utf8');
  }
}

export function createTokenBudget(options) {
  return new TokenBudget(options);
}
