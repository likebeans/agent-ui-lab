import { expect, test, type Page } from '@playwright/test';

const pages = process.env.PLAYWRIGHT_LAB_MODE === 'pages';

function modulePath(name: string) {
  return pages
    ? new RegExp(`/assets/${name}-[^/?]+\\.js(?:\\?|$)`, 'u')
    : new RegExp(`/src/${name}\\.tsx(?:\\?|$)`, 'u');
}

async function failModule(page: Page, name: string) {
  let requests = 0;
  await page.route(modulePath(name), (route) => {
    requests += 1;
    return route.abort('failed');
  });
  return {
    requests: () => requests,
    restore: () => page.unroute(modulePath(name)),
  };
}

for (const target of [
  { module: 'DocsReader', href: '#docs/map', label: '学习文档', heading: '学习地图' },
  { module: 'App', href: '#overview', label: '独立实验', heading: '让 AI 不止于对话。' },
]) {
  test(`${target.label} module failure preserves chat and supports retry without reloading`, async ({
    page,
  }) => {
    await page.goto('./#chat');
    const composer = page.getByRole('textbox', { name: '发送消息给 Agent' });
    await composer.fill('模块恢复后继续写的草稿');
    const identity = await page.evaluate(() => {
      const marker = crypto.randomUUID();
      document.body.dataset.recoveryIdentity = marker;
      return marker;
    });
    const failure = await failModule(page, target.module);
    await page.locator(`a[href="${target.href}"]`).first().click();
    const fallback = page.getByRole('region', { name: `${target.label}暂时无法打开` });
    await expect(fallback).toBeVisible();
    await expect(fallback.getByRole('heading')).toBeFocused();
    await expect(fallback.getByRole('alert')).toContainText('请检查网络连接后重试');
    expect(failure.requests()).toBeGreaterThan(0);
    await fallback.getByRole('link', { name: '返回 Agent 对话', exact: true }).click();
    await expect(composer).toHaveValue('模块恢复后继续写的草稿');
    await page.locator(`a[href="${target.href}"]`).first().click();
    await expect(fallback).toBeVisible();
    await failure.restore();
    await fallback.getByRole('button', { name: '重试加载', exact: true }).click();
    const heading = page.getByRole('heading', { level: 1 }).filter({ hasText: target.heading });
    await expect(heading).toBeVisible();
    await page.getByRole('link', { name: '返回 Agent 对话', exact: true }).first().click();
    await expect(composer).toHaveValue('模块恢复后继续写的草稿');
    expect(await page.locator('body').getAttribute('data-recovery-identity')).toBe(identity);
  });
}

test('a document failure returns to the existing experiment draft on a phone', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./#labs/a2ui');
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await page.getByRole('button', { name: '生成 A2UI 界面', exact: true }).click();
  const name = page.getByLabel('出行人姓名', { exact: true });
  await name.fill('文档失败后继续编辑');
  await failModule(page, 'DocsReader');
  await page.getByRole('link', { name: '打开学习文档', exact: true }).click();
  const fallback = page.getByRole('region', { name: '学习文档暂时无法打开' });
  await expect(fallback.getByRole('heading')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.screenshot({
    path: testInfo.outputPath('module-recovery-mobile.png'),
    fullPage: true,
  });
  await fallback.getByRole('link', { name: '返回独立实验', exact: true }).click();
  await expect(name).toHaveValue('文档失败后继续编辑');
});

test('an individual experiment module can fail and retry inside the existing workspace', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./#labs/agui');
  await expect(page.getByRole('button', { name: '开始运行', exact: true })).toBeVisible();
  const failure = await failModule(page, pages ? 'A2uiLab' : 'labs/A2uiLab');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.locator('a[href="#labs/a2ui"]').click();
  const fallback = page.getByRole('region', { name: 'A2UI 实验暂时无法打开' });
  await expect(fallback).toBeVisible();
  expect(failure.requests()).toBeGreaterThan(0);
  await failure.restore();
  await fallback.getByRole('button', { name: '重试加载', exact: true }).click();
  await page.getByRole('button', { name: '生成 A2UI 界面', exact: true }).click();
  await expect(page.getByLabel('出行人姓名', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
