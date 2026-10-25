import { expect, test, type Locator, type Page } from '@playwright/test';

const pages =
  process.env.LAB_RECOVERY_TEST_MODE === 'pages' || process.env.PLAYWRIGHT_LAB_MODE === 'pages';
function panels(page: Page) {
  const lab = page.getByRole('region', { name: '任务恢复实验操作区', exact: true });
  return {
    lab,
    authority: lab.getByRole('region', { name: '服务端权威状态 · 最近查询', exact: true }),
    projection: lab.getByRole('region', { name: '客户端投影 · 已确认连续记录', exact: true }),
  };
}
function fact(panel: Locator, name: string) {
  return panel
    .locator('dt')
    .filter({ hasText: new RegExp(`^${name}$`, 'u') })
    .locator('..')
    .locator('dd');
}
async function createAndStart(page: Page) {
  const { lab } = panels(page);
  await lab.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(lab.getByRole('button', { name: '开始执行', exact: true })).toBeEnabled();
  await lab.getByRole('button', { name: '开始执行', exact: true }).click();
  await expect(lab.getByRole('button', { name: '断开接流', exact: true })).toBeEnabled();
}

test('disconnect, checkpoint recovery, duplicate delivery and refresh preserve completed facts', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/\/api\/labs\/task-recovery/u.test(request.url())) requests.push(request.url());
  });
  await page.goto('./#labs/task-recovery');
  const { lab, authority, projection } = panels(page);
  await expect(lab).toBeVisible();
  await expect(lab.getByLabel('运行方式与持久化边界')).toContainText(
    pages ? 'memory-fixture 内存模拟' : 'SQLite 任务存储',
  );
  await createAndStart(page);
  await lab.getByRole('button', { name: '断开接流', exact: true }).click();
  await expect(lab).toContainText('已断开接流');
  await expect(lab).toContainText('未请求取消');

  const taskId = await lab.getByLabel('Task ID（任务，可选）').inputValue();
  const selectedUrl = page.url();
  if (!pages) {
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/labs/task-recovery/tasks/${taskId}`);
        return (await response.json()).task?.status;
      })
      .toBe('succeeded');
  }
  await lab.getByRole('button', { name: '恢复连接', exact: true }).click();
  await expect(authority).toContainText('succeeded');
  await expect(projection).toContainText('succeeded');
  await expect(fact(authority, '本地 toolExecutionCount')).toHaveText('1');
  const content = lab.getByRole('region', { name: '4. 从记录还原的内容', exact: true });
  await expect(
    content.getByRole('list', { name: '本地样本结果卡片' }).getByRole('listitem'),
  ).toHaveCount(2);
  const originalText = await content.locator('p').first().innerText();
  const originalCursor = await fact(projection, 'cursor / afterSeq').innerText();

  // A restored terminal checkpoint may have no suffix; the UI fetches a recorded event for injection.
  await lab.getByText('投递故障实验', { exact: true }).click();
  await lab.getByRole('button', { name: '注入重复事件', exact: true }).click();
  await expect(lab.getByRole('status')).toContainText(/重复|duplicate/u);
  await expect(content.locator('p').first()).toHaveText(originalText);
  await expect(fact(projection, 'cursor / afterSeq')).toHaveText(originalCursor);
  await expect(fact(authority, '本地 toolExecutionCount')).toHaveText('1');
  await lab.getByRole('button', { name: '注入序号缺口', exact: true }).click();
  await expect(lab.getByRole('status')).toContainText(/缺口.*恢复/u);
  await expect(fact(projection, 'cursor / afterSeq')).toHaveText(originalCursor);
  await expect(content.getByRole('listitem')).toHaveCount(2);

  await page.screenshot({
    path: testInfo.outputPath(`w1-${pages ? 'pages' : 'sqlite'}-recovered.png`),
    fullPage: true,
  });
  await page.reload();
  await expect(page).toHaveURL(selectedUrl);
  if (pages) {
    await expect(lab.getByRole('alert')).toContainText('memory-fixture');
    await expect(lab).toContainText('刷新后会清空');
    expect(requests).toEqual([]);
  } else {
    await expect(authority).toContainText('succeeded');
    await expect(fact(authority, '本地 toolExecutionCount')).toHaveText('1');
    await expect(content.locator('p').first()).toHaveText(originalText);
    await expect(content.getByRole('listitem')).toHaveCount(2);
  }
  expect(errors).toEqual([]);
});

test('cancel is confirmed by the server and retry isolates late old-run delivery', async ({
  page,
}) => {
  await page.goto('./#labs/task-recovery');
  const { lab, authority, projection } = panels(page);
  await createAndStart(page);
  let releaseLookup = () => {};
  const heldLookup = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  let lookupWaiting = false;
  if (!pages) {
    const taskId = await lab.getByLabel('Task ID（任务，可选）').inputValue();
    await page.route(`**/api/labs/task-recovery/tasks/${taskId}`, async (route) => {
      lookupWaiting = true;
      await heldLookup;
      await route.continue();
    });
  }
  try {
    await lab.getByRole('button', { name: '取消任务', exact: true }).click();
    if (!pages) {
      await expect.poll(() => lookupWaiting).toBe(true);
      await expect(fact(lab, '取消确认')).toHaveText('取消请求中，尚未确认');
      await expect(fact(lab, '接流连接')).toHaveText('已断开接流');
      await expect(fact(lab, '接流连接').locator('[data-live]')).toHaveAttribute(
        'data-live',
        'false',
      );
    }
  } finally {
    releaseLookup();
  }
  await expect(lab).toContainText('服务端已确认取消');
  await expect(authority).toContainText('cancelled');
  await expect(projection).toContainText('cancelled');
  const previousCount = Number(await fact(authority, '本地 toolExecutionCount').innerText());
  await lab.getByRole('button', { name: '重新执行（新 run）', exact: true }).click();
  await expect(lab.getByRole('button', { name: '断开接流', exact: true })).toBeEnabled();
  await lab.getByText('投递故障实验', { exact: true }).click();
  await lab.getByRole('button', { name: '注入旧 run 事件', exact: true }).click();
  await expect(lab.getByRole('status')).toContainText(/旧 run.*忽略|stale-run/u);
  await expect(authority).toContainText('succeeded');
  await expect(projection).toContainText('succeeded');
  await expect(fact(authority, '本地 toolExecutionCount')).toHaveText(String(previousCount + 1));
  await expect(
    lab.getByRole('list', { name: '本地样本结果卡片' }).getByRole('listitem'),
  ).toHaveCount(2);
});

test('Pages fixture reset clears an unselected thread task list', async ({ page }) => {
  test.skip(!pages, 'The reset control belongs to the browser memory fixture.');
  await page.goto('./#labs/task-recovery');
  const { lab } = panels(page);
  const taskInput = lab.getByLabel('Task ID（任务，可选）');
  for (const taskId of ['reset_task_one', 'reset_task_two']) {
    await expect(taskInput).toBeEnabled();
    await taskInput.fill(taskId);
    await lab.getByRole('button', { name: '新建任务', exact: true }).click();
    await expect(lab.getByRole('button', { name: '开始执行', exact: true })).toBeEnabled();
  }
  await taskInput.fill('');
  await lab.getByRole('button', { name: '查询任务', exact: true }).click();
  const choices = lab.getByRole('list', { name: '此会话的任务', exact: true });
  await expect(choices.getByRole('button')).toHaveCount(2);
  await lab.getByRole('button', { name: '重置内存样本', exact: true }).click();
  await lab.getByRole('button', { name: '确认重置内存样本', exact: true }).click();
  await expect(lab.getByRole('status')).toContainText('内存样本已重置');
  await expect(choices).toHaveCount(0);
  await expect(taskInput).toHaveValue('');
  await lab.getByRole('button', { name: '查询任务', exact: true }).click();
  await expect(lab.getByRole('status')).toContainText('此 thread 暂无任务');
  await expect(choices).toHaveCount(0);
});

test('mobile layout, docs return and original event trace remain usable', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('./#labs/task-recovery');
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const { lab, authority } = panels(page);
  await createAndStart(page);
  await expect(authority).toContainText('succeeded');
  const selectedTask = await lab.getByLabel('Task ID（任务，可选）').inputValue();
  await page.getByRole('link', { name: '实验文档', exact: true }).click();
  const reader = page.getByRole('region', { name: '学习文档', exact: true });
  await expect(reader.getByRole('heading', { level: 1 })).toContainText('W1：任务恢复与事件重放');
  await reader.getByRole('link', { name: '返回独立实验', exact: true }).first().click();
  await expect(lab).toBeVisible();
  await expect(lab.getByLabel('Task ID（任务，可选）')).toHaveValue(selectedTask);
  await expect(authority).toContainText('succeeded');
  await expect(fact(authority, '本地 toolExecutionCount')).toHaveText('1');
  await lab.getByRole('button', { name: '定位最近事件记录', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '协议检查器', exact: true });
  await expect(inspector).toBeVisible();
  await expect(inspector.locator('.payload')).toContainText(/"type":\s*"RUN_FINISHED"/u);
  const payload = JSON.parse(await inspector.locator('.payload').innerText());
  expect(typeof payload.type).toBe('string');
  expect(payload).not.toHaveProperty('taskId');
  expect(payload).not.toHaveProperty('seq');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.screenshot({
    path: testInfo.outputPath(`w1-${pages ? 'pages' : 'sqlite'}-mobile.png`),
    fullPage: true,
  });
});
