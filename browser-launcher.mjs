// browser-launcher.mjs — 准备页导航与页面状态判定（登录墙 / 验证码 / 拦截）。

import { PAGE_NAMES, ensurePage, findPageByRole, tagPage } from './browser-pages.mjs';

export const PREPARE_PAGE_NAME = PAGE_NAMES.prepare;
export const PREPARE_HOME = 'https://www.tiktok.com/';

const NAVIGATION_TIMEOUT = 45_000;
const SIGNAL_TIMEOUT = 1_200;

/**
 * 把 signal 取消映射为 Promise 拒绝，避免导航挂起时无法中断。
 */
export function abortable(pending, signal, lateResult) {
  if (!signal) return pending;
  if (signal.aborted) {
    Promise.resolve(pending).then(lateResult).catch(() => {});
    return Promise.reject(signal.reason || new Error('操作已取消。'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      Promise.resolve(pending).then(lateResult).catch(() => {});
      reject(signal.reason || new Error('操作已取消。'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(pending).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * 取得准备页：复用带归属标记的页面，必要时新建并导航到 TikTok 首页。
 */
export async function ensurePreparePage(context, { signal, navigate = true, logger = null } = {}) {
  let page = await findPageByRole(context, 'prepare');
  if (!page || page.isClosed()) {
    page = await ensurePage(context, 'prepare');
  } else {
    await tagPage(page, 'prepare').catch(() => {});
  }
  if (navigate) {
    await navigatePrepare(page, { signal, logger });
  }
  return page;
}

export async function navigatePrepare(page, { signal, logger = null } = {}) {
  try {
    await abortable(
      page.goto(PREPARE_HOME, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT }),
      signal,
      () => {},
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    logger?.warn?.('[tiktok-browser] 打开 TikTok 首页失败：', error?.message || error);
  }
  return page;
}

async function isVisible(page, selector) {
  try {
    const locator = page.locator(selector).first();
    return await locator.isVisible({ timeout: SIGNAL_TIMEOUT });
  } catch {
    return false;
  }
}

async function hasText(page, pattern) {
  try {
    const body = await page.locator('body').innerText({ timeout: SIGNAL_TIMEOUT });
    return pattern.test(body);
  } catch {
    return false;
  }
}

/**
 * 判定页面当前状态：登录墙、验证码、地区/网络拦截。
 */
export async function readPageSignals(page) {
  let url = '';
  let title = '';
  try {
    url = page.url();
    title = await page.title();
  } catch {
    // 页面可能已关闭。
  }
  const loginRequired =
    /\/login/i.test(url) ||
    (await isVisible(page, '[data-e2e="login-modal"], [data-e2e="login-button"], div[role="dialog"] form')) ||
    (await hasText(page, /\b(Log in|Sign up|登录|注册)\b/));
  const verificationRequired =
    (await isVisible(page, 'iframe[src*="captcha"], div[class*="captcha"], [data-e2e="captcha"]')) ||
    (await hasText(page, /\b(Verify|verification|验证码|安全验证)\b/));
  const blocked = await hasText(page, /\b(Access Denied|Something went wrong|Forbidden|访问受限)\b/);
  return { url, title, loginRequired, verificationRequired, blocked };
}

export function describePageState(signals) {
  if (signals.verificationRequired) return 'verification';
  if (signals.loginRequired) return 'login';
  if (signals.blocked) return 'blocked';
  return 'ready';
}
