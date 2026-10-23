import { expect, test } from '@playwright/test';

test('manifest-only lab runs, focuses structured evidence and opens discovered documentation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#overview');
  const nav = page.getByRole('navigation', { name: '主要导航' });
  await nav.getByRole('link', { name: /实验接入示例/ }).click();
  await expect(page).toHaveURL(/#labs\/foundation$/);
  const lab = page.getByRole('region', { name: '实验接入示例操作区' });
  await lab.getByLabel('要观察的内容').fill('  一次实验🌱  ');
  await lab.getByRole('button', { name: '运行接入示例', exact: true }).click();
  await expect(lab.getByRole('status')).toContainText('5 个字符');
  await lab.getByRole('button', { name: '定位本次结果记录' }).click();
  const inspector = page.getByRole('complementary', { name: '协议检查器' });
  await expect(inspector.locator('.payload')).toContainText('一次实验🌱');
  await inspector.getByText('关联身份 · foundation', { exact: true }).click();
  await expect(inspector.locator('.trace-identity')).toContainText('foundation/result');
  await expect(inspector.locator('.trace-identity')).toContainText('run-');
  await expect(inspector.locator('.payload')).not.toContainText('labId');
  await page.getByRole('link', { name: '实验文档', exact: true }).click();
  await expect(page).toHaveURL(/#docs\/labs%2Ffoundation$/);
  const reader = page.getByRole('region', { name: '学习文档', exact: true });
  await expect(reader.getByRole('heading', { level: 1 })).toContainText('W0：实验基础与并行开发');
  await page.reload();
  await expect(reader.getByRole('heading', { level: 1 })).toContainText('W0：实验基础与并行开发');
  await reader
    .getByRole('article')
    .getByRole('link', { name: '实验接入示例', exact: true })
    .click();
  await expect(page).toHaveURL(/#labs\/foundation$/);
  await page.setViewportSize({ width: 375, height: 812 });
  await lab.getByLabel('要观察的内容').fill('手机');
  await lab.getByRole('button', { name: '运行接入示例', exact: true }).click();
  await expect(lab.getByRole('status')).toContainText('2 个字符');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  expect(errors).toEqual([]);
});

test('chat AG-UI payload and trace share the actual run identity', async ({ page }) => {
  await page.goto('/#chat');
  await page.getByRole('textbox', { name: '发送消息给 Agent' }).fill('帮我规划杭州一日游');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const reply = page.getByRole('article', { name: 'AG-UI Agent 回复', exact: true });
  await expect(reply.getByRole('status')).toContainText('已完成');
  await reply.getByRole('button', { name: '查看本轮 AG-UI 协议', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '协议检查器' });
  await inspector.getByRole('button', { name: /RUN_STARTED.*server→client/ }).click();
  const payload = JSON.parse(await inspector.locator('.payload').innerText());
  await inspector.getByText('关联身份 · agui', { exact: true }).click();
  await expect(inspector.locator('.trace-identity')).toContainText(payload.runId);
  await expect(inspector.locator('.trace-identity')).toContainText(payload.threadId);
  await expect(inspector.locator('.trace-identity')).toContainText('turnId');
  expect(payload).not.toHaveProperty('labId');
});
