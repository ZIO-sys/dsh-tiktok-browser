// browser-pages.mjs — 页面归属：用 window.name 标记本插件创建的页面，避免误操作其他标签页。

export const PAGE_NAMES = Object.freeze({
  prepare: 'deepseek-tiktok-prepare',
  search: 'deepseek-tiktok-search',
  video: 'deepseek-tiktok-video',
  verification: 'deepseek-tiktok-verification',
});

export const PAGE_ROLES = Object.freeze({
  prepare: 'prepare',
  search: 'search',
  video: 'video',
  verification: 'verification',
});

const NAME_TO_ROLE = new Map(Object.entries(PAGE_NAMES).map(([role, name]) => [name, role]));

export function roleForPageName(name) {
  return NAME_TO_ROLE.get(String(name || '')) || null;
}

export function nameForRole(role) {
  return PAGE_NAMES[role] || null;
}

export async function readPageName(page) {
  try {
    return await page.evaluate(() => window.name || '');
  } catch {
    return '';
  }
}

export async function tagPage(page, role) {
  const name = nameForRole(role);
  if (!name) throw new Error(`未知页面角色：${role}`);
  await page.evaluate((value) => {
    window.name = value;
  }, name);
  return name;
}

export async function findPageByName(context, name) {
  for (const page of context.pages()) {
    if ((await readPageName(page)) === name) return page;
  }
  return null;
}

export async function findPageByRole(context, role) {
  return findPageByName(context, nameForRole(role));
}

/**
 * 复用已有归属页面；没有则新建并打标记。
 */
export async function ensurePage(context, role) {
  const existing = await findPageByRole(context, role);
  if (existing && !existing.isClosed()) return existing;
  const page = await context.newPage();
  await tagPage(page, role);
  return page;
}

export function describePage(page) {
  try {
    return { url: page.url(), title: null };
  } catch {
    return { url: null, title: null };
  }
}
