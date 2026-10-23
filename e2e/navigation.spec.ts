import { expect, test } from '@playwright/test';

test('learning navigation, keyboard tabs, theme and mobile layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#overview');
  await expect(page.getByRole('heading', { name: '让 AI 不止于对话。' })).toBeVisible();
  await expect(page.getByText('服务已连接')).toBeVisible();
  await page.screenshot({ path: 'test-results/overview-desktop.png', fullPage: true });

  await page.getByRole('button', { name: '开始第一个实验' }).click();
  await expect(page).toHaveURL(/#agui$/);
  await page.getByRole('tab', { name: '交互实验' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '原理拆解' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByRole('heading', { name: '消息还没生成完，界面为什么已经开始更新？' }),
  ).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: '源码导读' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('shared/agui-agent.ts', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '切换深色模式' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/source-dark.png', fullPage: true });
  await page.getByRole('button', { name: '切换浅色模式' }).click();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('button', { name: '收起导航' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '打开导航' })).toBeFocused();
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('link', { name: '学习总览', exact: true }).click();
  await expect(page.getByRole('heading', { name: '让 AI 不止于对话。' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.screenshot({ path: 'test-results/overview-mobile.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '开始第一个实验' }).click();
  await expect(page.getByRole('complementary', { name: '协议检查器' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  expect(errors).toEqual([]);
});
