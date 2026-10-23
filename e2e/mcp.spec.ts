import { expect, test } from '@playwright/test';

test('MCP App initializes and calls the real server through its Host', async ({ page }) => {
  const errors: string[] = [];
  const calls: { name: string; city?: string }[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().endsWith('/mcp') || request.method() !== 'POST') return;
    const message = request.postDataJSON();
    if (message.method === 'tools/call')
      calls.push({ name: message.params.name, city: message.params.arguments?.city });
  });
  await page.goto('/#mcp');
  await page.getByRole('button', { name: '打开 MCP App' }).click();
  await expect(page.getByRole('status')).toHaveText('App 与宿主已连接', { timeout: 20_000 });
  const frame = page.frameLocator('iframe[title="城市活动选择器 MCP App"]');
  await expect(frame.getByRole('button', { name: '杭州', exact: true })).toBeVisible();
  await frame.getByRole('button', { name: '杭州', exact: true }).click();
  await expect(frame.getByText('西湖清晨步道', { exact: true })).toBeVisible();
  expect(calls).toContainEqual({ name: 'get_trip_activities', city: 'hangzhou' });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(() =>
      frame.locator('html').evaluate((element) => element.scrollHeight <= window.innerHeight),
    )
    .toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/mcp-complete.png', fullPage: true });

  await page.getByRole('button', { name: '切换深色模式' }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/mcp-dark.png', fullPage: true });
  await page.getByRole('button', { name: '切换浅色模式' }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('iframe').scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      frame.locator('html').evaluate((element) => element.scrollHeight <= window.innerHeight),
    )
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  expect(
    await frame.locator('html').evaluate((element) => element.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await page.locator('iframe').screenshot({ path: 'test-results/mcp-mobile-app.png' });
  await page.screenshot({ path: 'test-results/mcp-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.getByRole('button', { name: '关闭 App' }).click();
    await expect(page.getByRole('button', { name: '打开 MCP App' })).toBeVisible();
    await page.getByRole('button', { name: '打开 MCP App' }).click();
    await expect(page.getByRole('status')).toHaveText('App 与宿主已连接', { timeout: 20_000 });
    await expect(frame.getByRole('button', { name: '成都', exact: true })).toBeVisible();
  }
  await page.getByRole('link', { name: '学习总览', exact: true }).click();
  await expect(page.getByRole('heading', { name: '让 AI 不止于对话。' })).toBeVisible();
  expect(errors).toEqual([]);
});
