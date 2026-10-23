import { expect, test } from '@playwright/test';

test('A2UI renders the server tree and returns resolved form data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#a2ui');
  await page.getByRole('button', { name: '生成 A2UI 界面' }).click();
  await expect(page.getByLabel('A2UI 生成界面')).toBeVisible();
  await page.getByRole('combobox', { name: '目的地', exact: true }).selectOption('chengdu');
  await page.getByLabel('出行人姓名', { exact: true }).fill('学习者');
  await page.getByLabel('行程天数', { exact: true }).fill('3');
  const actionRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/a2ui/action') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: '生成计划', exact: true }).click();
  const action = (await actionRequest).postDataJSON();
  expect(action.version).toBe('v0.9.1');
  expect(action.action.context.destination).toEqual(['chengdu']);
  expect(action.action.context.traveler).toBe('学习者');
  await expect(page.getByLabel('A2UI 生成界面')).toContainText('学习者');
  await expect(page.getByLabel('A2UI 生成界面')).toContainText('成都');
  await expect(page.getByRole('button', { name: '重新生成计划', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/a2ui-complete.png', fullPage: true });

  await page.getByRole('tab', { name: '原理拆解' }).click();
  await page.getByRole('tab', { name: '交互实验' }).click();
  await expect(page.getByLabel('出行人姓名', { exact: true })).toHaveValue('学习者');

  await page.getByLabel('筛选协议消息').fill('action/');
  await page.getByRole('button', { name: /action\/save_trip/ }).click();
  await expect(page.locator('.payload')).toContainText('学习者');
  await page.getByLabel('筛选协议消息').fill('');
  await page.getByRole('button', { name: '删除 Surface 并重置' }).click();
  await expect(page.getByRole('heading', { name: '尚未创建 Surface' })).toBeVisible();
  await expect(page.locator('.payload')).toContainText('deleteSurface');
  await page.getByRole('button', { name: '生成 A2UI 界面' }).click();
  await expect(page.getByLabel('出行人姓名', { exact: true })).toHaveValue('');
  expect(errors).toEqual([]);
});
