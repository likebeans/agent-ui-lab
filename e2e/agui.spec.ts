import { expect, test } from '@playwright/test';

test('AG-UI streams state and text, supports confirmed cancellation and error recovery', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#agui');
  await page.getByLabel('目的地', { exact: true }).selectOption('成都');
  await page.getByLabel('旅行偏好').fill('想要安静散步和美食');
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('运行成功');
  await expect(page.locator('.message-bubble.assistant').first()).toContainText('成都');
  await expect(page.locator('.task-item.done')).toHaveCount(3);
  await expect(page.locator('.payload')).toContainText('"success"');
  await page.screenshot({ path: 'test-results/agui-complete.png', fullPage: true });

  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await page.getByRole('button', { name: '协议取消', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('协议已取消');
  await page.getByRole('button', { name: /RUN_FINISHED.*server→client/ }).click();
  await expect(page.locator('.payload')).toContainText('cancelled');

  await page.getByLabel('运行场景').selectOption('error');
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Agent 报错');
  await expect(page.locator('.payload')).toContainText('FIXTURE_UNAVAILABLE');
  await expect(page.getByRole('button', { name: '重试运行', exact: true })).toBeEnabled();
  await page.getByLabel('运行场景').selectOption('success');
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('运行成功');

  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await page.getByRole('button', { name: '中断 HTTP', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('HTTP 流已截断');
  await expect(page.getByRole('button', { name: '重试运行', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('AG-UI does not get stuck when an SSE response ends without a terminal event', async ({
  page,
}) => {
  await page.goto('/#agui');
  await page.route(
    '**/api/agui',
    async (route) => {
      const input = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId })}\n\n`,
      });
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('HTTP 流已截断');
  await expect(page.getByRole('button', { name: '重试运行', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重试运行', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('运行成功');
});
