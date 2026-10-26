import { expect, test } from '@playwright/test';
import { WORKFLOW_API } from '../shared/labs/enrollment-workflow/contract';

const pages = process.env.PLAYWRIGHT_LAB_MODE === 'pages';

test('joint enrollment preserves its run, rejects old consent and recovers one fact after a lost response', async ({
  page,
}) => {
  const external: string[] = [];
  if (pages)
    page.on('request', (request) => {
      if (/\/(?:api|mcp)(?:\/|\?|$)/u.test(new URL(request.url()).pathname))
        external.push(request.url());
    });
  await page.goto('./#labs/enrollment-workflow');
  const lab = page.getByRole('region', { name: '活动报名联合实验操作区' });
  const saved = lab.getByRole('region', { name: '已保存提议与报名事实' });
  const evidence = lab.getByRole('region', { name: '任务与事件证据' });
  const read = lab.getByRole('button', { name: '查询事实并恢复', exact: true });
  await expect(read).toBeEnabled();
  await lab.getByRole('button', { name: '开始新任务', exact: true }).click();
  await lab.getByLabel('报名姓名', { exact: true }).fill('联合实验学员');
  await lab.getByLabel('报名人数', { exact: true }).fill('2');
  await lab.getByRole('button', { name: '生成待确认提议', exact: true }).click();
  await expect(saved).toContainText('等待人工确认');
  await expect(lab.getByTestId('workflow-record-count')).toHaveText('0');
  const run = await evidence
    .locator('dt')
    .filter({ hasText: /^运行 ID$/u })
    .locator('+ dd')
    .innerText();
  const taskId = await evidence
    .locator('dt')
    .filter({ hasText: /^任务 ID$/u })
    .locator('+ dd')
    .innerText();
  await lab.locator('summary').filter({ hasText: '验证旧确认与丢失响应' }).click();
  await lab.getByRole('button', { name: '保存当前确认命令', exact: true }).click();
  await lab.getByLabel('报名人数', { exact: true }).fill('3');
  await expect(lab.getByRole('button', { name: '确认此版本并报名', exact: true })).toBeDisabled();
  await lab.getByRole('button', { name: '保存修改并重新核对', exact: true }).click();
  await expect(
    saved
      .locator('dt')
      .filter({ hasText: /^提议版本$/u })
      .locator('+ dd'),
  ).toHaveText('2');
  await lab.getByRole('button', { name: '发送保存的旧确认', exact: true }).click();
  await expect(lab.getByRole('alert')).toContainText('VERSION_CONFLICT');
  await expect(lab.getByTestId('workflow-record-count')).toHaveText('0');
  await expect(evidence).toContainText(run);

  if (!pages) {
    await page.reload();
    await expect(saved).toContainText('等待人工确认');
    await expect(evidence).toContainText(run);
    await expect(evidence).toContainText(taskId);
    await expect(lab.getByLabel('报名人数', { exact: true })).toHaveValue('3');
    await lab.locator('summary').filter({ hasText: '验证旧确认与丢失响应' }).click();
  }
  await lab.getByLabel('模拟命令提交后丢失响应', { exact: true }).check();
  await lab.getByRole('button', { name: '确认此版本并报名', exact: true }).click();
  await expect(lab.getByRole('complementary', { name: '待定命令恢复' })).toBeVisible();
  await expect(lab.getByRole('status')).toContainText('结果未知');
  await read.click();
  await expect(lab.getByTestId('workflow-record-count')).toHaveText('1');
  await expect(saved).toContainText('报名已完成');
  const enrollmentId = await saved
    .locator('dt')
    .filter({ hasText: /^报名 ID$/u })
    .locator('+ dd')
    .innerText();
  const eventCount = await lab
    .getByRole('list', { name: '已提交事件' })
    .getByRole('listitem')
    .count();
  await lab.getByRole('button', { name: '重放最后命令', exact: true }).click();
  await expect(lab.getByRole('status')).toContainText('原命令已重放');
  await expect(saved).toContainText(enrollmentId);
  await expect(lab.getByTestId('workflow-record-count')).toHaveText('1');
  await expect(lab.getByRole('list', { name: '已提交事件' }).getByRole('listitem')).toHaveCount(
    eventCount,
  );
  expect(
    await lab
      .getByRole('list', { name: '已提交事件' })
      .getByRole('button', { name: /TOOL_CALL_RESULT/u })
      .count(),
  ).toBe(1);
  await expect(evidence).toContainText(run);
  if (pages) expect(external).toEqual([]);
});

test('joint enrollment keeps a phone draft through documentation and exposes explicit memory reset after reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./#labs/enrollment-workflow');
  const lab = page.getByRole('region', { name: '活动报名联合实验操作区' });
  await expect(lab.getByRole('button', { name: '查询事实并恢复', exact: true })).toBeEnabled();
  await lab.getByRole('button', { name: '开始新任务', exact: true }).click();
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await lab.getByLabel('报名姓名', { exact: true }).fill('手机草稿');
  await lab.getByRole('button', { name: '生成待确认提议', exact: true }).click();
  await expect(lab.getByRole('region', { name: '已保存提议与报名事实' })).toContainText(
    '等待人工确认',
  );
  await lab.getByLabel('报名姓名', { exact: true }).fill('保留未提交草稿');
  await page.getByRole('link', { name: '打开学习文档', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '活动报名：恢复与确认联合实验', level: 1 }),
  ).toBeVisible();
  await page.getByRole('link', { name: '返回独立实验', exact: true }).first().click();
  await expect(lab.getByLabel('报名姓名', { exact: true })).toHaveValue('保留未提交草稿');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.reload();
  if (pages) {
    await expect(lab.getByRole('alert')).toContainText('NOT_FOUND');
    await expect(lab.getByRole('button', { name: '生成待确认提议', exact: true })).toBeDisabled();
    await lab.getByRole('button', { name: '开始新任务', exact: true }).click();
    await expect(lab.getByRole('button', { name: '生成待确认提议', exact: true })).toBeEnabled();
  } else {
    await expect(lab.getByLabel('报名姓名', { exact: true })).toHaveValue('手机草稿');
    await expect(lab.getByRole('region', { name: '已保存提议与报名事实' })).toContainText(
      '等待人工确认',
    );
  }
});

test('a concurrent saved version preserves the rejected local draft until an explicit choice', async ({
  page,
  context,
}) => {
  test.skip(pages, 'Independent Pages tabs intentionally have separate memory authorities.');
  await page.goto('./#labs/enrollment-workflow');
  const lab = page.getByRole('region', { name: '活动报名联合实验操作区' });
  await expect(lab.getByRole('button', { name: '查询事实并恢复', exact: true })).toBeEnabled();
  await lab.getByRole('button', { name: '生成待确认提议', exact: true }).click();
  await expect(lab.getByRole('region', { name: '已保存提议与报名事实' })).toContainText(
    '等待人工确认',
  );
  const stored = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((key) => key.startsWith('enrollment-workflow:'))!;
    return { key, value: sessionStorage.getItem(key)! };
  });
  const other = await context.newPage();
  try {
    await other.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), stored);
    await other.goto(page.url());
    const remote = other.getByRole('region', { name: '活动报名联合实验操作区' });
    await expect(remote.getByLabel('报名人数', { exact: true })).toBeEnabled();
    await lab.getByLabel('报名人数', { exact: true }).fill('3');
    await remote.getByLabel('报名人数', { exact: true }).fill('4');
    await remote.getByRole('button', { name: '保存修改并重新核对', exact: true }).click();
    const remoteFacts = remote.getByRole('region', { name: '已保存提议与报名事实' });
    await expect(
      remoteFacts
        .locator('dt')
        .filter({ hasText: /^提议版本$/u })
        .locator('+ dd'),
    ).toHaveText('2');
    await lab.getByRole('button', { name: '保存修改并重新核对', exact: true }).click();
    await expect(lab.getByRole('alert')).toContainText('VERSION_CONFLICT');
    await expect(lab.getByText('已保存版本改变，本地草稿仍保留。', { exact: true })).toBeVisible();
    await expect(lab.getByLabel('报名人数', { exact: true })).toHaveValue('3');
    await expect(
      lab
        .getByRole('region', { name: '已保存提议与报名事实' })
        .locator('dt')
        .filter({ hasText: /^报名人数$/u })
        .locator('+ dd'),
    ).toHaveText('4');
    await expect(lab.getByRole('button', { name: '确认此版本并报名', exact: true })).toBeDisabled();
    await lab.getByRole('button', { name: '保留草稿并重新保存', exact: true }).click();
    await lab.getByRole('button', { name: '保存修改并重新核对', exact: true }).click();
    const saved = lab.getByRole('region', { name: '已保存提议与报名事实' });
    await expect(
      saved
        .locator('dt')
        .filter({ hasText: /^提议版本$/u })
        .locator('+ dd'),
    ).toHaveText('3');
    await expect(
      saved
        .locator('dt')
        .filter({ hasText: /^报名人数$/u })
        .locator('+ dd'),
    ).toHaveText('3');
    await expect(lab.getByTestId('workflow-record-count')).toHaveText('0');
  } finally {
    await other.close();
  }
});

test('refreshing a pending command queries its original task and requires an explicit reset for Pages', async ({
  page,
}) => {
  await page.goto('./#labs/enrollment-workflow');
  const lab = page.getByRole('region', { name: '活动报名联合实验操作区' });
  await expect(lab.getByRole('button', { name: '查询事实并恢复', exact: true })).toBeEnabled();
  await lab.locator('summary').filter({ hasText: '验证旧确认与丢失响应' }).click();
  await lab.getByLabel('模拟命令提交后丢失响应', { exact: true }).check();
  await lab.getByRole('button', { name: '生成待确认提议', exact: true }).click();
  const recovery = lab.getByRole('complementary', { name: '待定命令恢复' });
  await expect(recovery).toBeVisible();
  const commandId = await recovery.locator('code').innerText();
  const taskId = await lab
    .getByRole('region', { name: '任务与事件证据' })
    .locator('dt')
    .filter({ hasText: /^任务 ID$/u })
    .locator('+ dd')
    .innerText();
  await page.reload();
  if (pages) {
    await expect(lab.getByRole('alert')).toContainText('NOT_FOUND');
    await expect(recovery.locator('code')).toHaveText(commandId);
    await expect(recovery.getByRole('button', { name: '重试原命令', exact: true })).toBeDisabled();
    await expect(lab.getByRole('button', { name: '开始新任务', exact: true })).toBeDisabled();
    await recovery.getByRole('button', { name: '结束已清空模拟的恢复', exact: true }).click();
    await expect(recovery).toHaveCount(0);
    await expect(lab.getByRole('button', { name: '生成待确认提议', exact: true })).toBeDisabled();
    await lab.getByRole('button', { name: '开始新任务', exact: true }).click();
    await expect(lab.getByRole('button', { name: '生成待确认提议', exact: true })).toBeEnabled();
    await expect(lab.getByRole('region', { name: '任务与事件证据' })).not.toContainText(taskId);
  } else {
    await expect(lab.getByRole('region', { name: '已保存提议与报名事实' })).toContainText(
      '等待人工确认',
    );
    await expect(recovery).toHaveCount(0);
    await expect(lab.getByTestId('workflow-record-count')).toHaveText('0');
    await expect(lab.getByRole('region', { name: '任务与事件证据' })).toContainText(taskId);
    await lab.locator('summary').filter({ hasText: '验证旧确认与丢失响应' }).click();
    await lab.getByRole('button', { name: '重放最后命令', exact: true }).click();
    await expect(lab.getByRole('status')).toContainText('原命令已重放');
    await expect(lab.getByTestId('workflow-record-count')).toHaveText('0');
    await expect(lab.getByRole('list', { name: '已提交事件' }).getByRole('listitem')).toHaveCount(
      3,
    );
  }
});

test('an uncommitted unknown command survives reload and retries the exact original envelope after querying', async ({
  page,
}) => {
  test.skip(pages, 'This case interrupts the HTTP request before the server commits.');
  const sent: Array<{ body: unknown; session: string | undefined }> = [];
  await page.route(`**${WORKFLOW_API}/commands`, async (route) => {
    sent.push({
      body: route.request().postDataJSON(),
      session: route.request().headers()['x-teaching-session'],
    });
    if (sent.length === 1) await route.abort('failed');
    else await route.continue();
  });
  await page.goto('./#labs/enrollment-workflow');
  const lab = page.getByRole('region', { name: '活动报名联合实验操作区' });
  await expect(lab.getByRole('button', { name: '查询事实并恢复', exact: true })).toBeEnabled();
  await lab.getByLabel('报名姓名', { exact: true }).fill('原命令中的学员');
  await lab.getByLabel('报名人数', { exact: true }).fill('2');
  await lab.getByRole('button', { name: '生成待确认提议', exact: true }).click();
  const recovery = lab.getByRole('complementary', { name: '待定命令恢复' });
  await expect(recovery).toBeVisible();
  await expect(lab.getByRole('status')).toContainText('结果未知');
  await expect(recovery.getByRole('button', { name: '重试原命令', exact: true })).toBeDisabled();
  await page.reload();
  await expect(lab.getByRole('alert')).toContainText('NOT_FOUND');
  await expect(recovery.getByRole('button', { name: '重试原命令', exact: true })).toBeEnabled();
  expect(sent).toHaveLength(1);
  await recovery.getByRole('button', { name: '重试原命令', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  await expect(lab.getByLabel('报名姓名', { exact: true })).toHaveValue('原命令中的学员');
  await expect(lab.getByLabel('报名人数', { exact: true })).toHaveValue('2');
  await expect(lab.getByTestId('workflow-record-count')).toHaveText('0');
});

test('an incomplete recovery form preserves the current draft and a pending command', async ({
  page,
}) => {
  test.skip(pages, 'This case alters the actual HTTP facts response.');
  await page.goto('./#labs/enrollment-workflow');
  const lab = page.getByRole('region', { name: '活动报名联合实验操作区' });
  await expect(lab.getByRole('button', { name: '查询事实并恢复', exact: true })).toBeEnabled();
  await lab.getByRole('button', { name: '生成待确认提议', exact: true }).click();
  await expect(lab.getByRole('region', { name: '已保存提议与报名事实' })).toContainText(
    '等待人工确认',
  );
  await lab.getByLabel('报名姓名', { exact: true }).fill('恢复失败仍保留的草稿');
  await page.route(`**${WORKFLOW_API}/facts?*`, async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({ response, json: { ...value, messages: [] } });
  });
  await lab.getByRole('button', { name: '查询事实并恢复', exact: true }).click();
  await expect(lab.getByRole('alert')).toContainText('未收到符合契约的完整结果');
  await expect(lab.getByLabel('报名姓名', { exact: true })).toHaveValue('恢复失败仍保留的草稿');
  await page.unroute(`**${WORKFLOW_API}/facts?*`);
  await lab.getByRole('button', { name: '查询事实并恢复', exact: true }).click();
  await expect(lab.getByLabel('报名姓名', { exact: true })).toBeEnabled();
  await lab.getByLabel('报名姓名', { exact: true }).fill('提交但尚未收到回执');
  await lab.locator('summary').filter({ hasText: '验证旧确认与丢失响应' }).click();
  await lab.getByLabel('模拟命令提交后丢失响应', { exact: true }).check();
  await lab.getByRole('button', { name: '保存修改并重新核对', exact: true }).click();
  const recovery = lab.getByRole('complementary', { name: '待定命令恢复' });
  await expect(recovery).toBeVisible();
  const command = await recovery.locator('code').innerText();
  await page.route(`**${WORKFLOW_API}/facts?*`, async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({ response, json: { ...value, messages: [] } });
  });
  await lab.getByRole('button', { name: '查询事实并恢复', exact: true }).click();
  await expect(lab.getByRole('alert')).toContainText('未收到符合契约的完整结果');
  await expect(recovery.locator('code')).toHaveText(command);
  await expect(lab.getByLabel('报名姓名', { exact: true })).toHaveValue('提交但尚未收到回执');
  await page.unroute(`**${WORKFLOW_API}/facts?*`);
  await lab.getByRole('button', { name: '查询事实并恢复', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  await expect(lab.getByRole('region', { name: '已保存提议与报名事实' })).toContainText(
    '提交但尚未收到回执',
  );
  await expect(lab.getByTestId('workflow-record-count')).toHaveText('0');
});
