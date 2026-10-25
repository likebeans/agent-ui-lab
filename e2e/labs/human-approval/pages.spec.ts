import { expect, test, type Locator, type Page } from '@playwright/test';

const labRegion = (page: Page) => page.getByRole('region', { name: '人工确认操作区', exact: true });
const value = (region: Locator, label: string) => region.locator(`dt:has-text("${label}") + dd`);

test('Pages switching labs recovers the existing in-memory task without forcing a reset', async ({
  page,
}) => {
  await page.goto('./#labs/human-approval');
  const lab = labRegion(page);
  await lab.getByRole('button', { name: '生成报名提议', exact: true }).click();
  const proposal = lab.getByRole('region', { name: '已保存提议', exact: true });
  await expect(proposal).toContainText('等待人工确认');
  const taskId = await value(proposal, '任务 ID').innerText();
  await page.evaluate(() => {
    window.location.hash = '#labs/foundation';
  });
  await expect(page.getByRole('region', { name: '实验接入示例操作区', exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = '#labs/human-approval';
  });
  await expect(lab).toContainText('先查询模拟状态');
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(value(proposal, '任务 ID')).toHaveText(taskId);
  await expect(lab.getByRole('button', { name: '确认报名', exact: true })).toBeEnabled();
  await expect(lab.getByRole('button', { name: '重置浏览器模拟', exact: true })).toHaveCount(0);
  await lab.getByRole('button', { name: '确认报名', exact: true }).click();
  await expect(lab.getByRole('article', { name: '已核实报名记录', exact: true })).toBeVisible();
});

function observeBrowserOnly(page: Page) {
  const requests: string[] = [];
  const errors: string[] = [];
  const failedAssets: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/^https?:$/u.test(url.protocol) && /\/api(?:\/|$)/u.test(url.pathname))
      requests.push(url.pathname);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) failedAssets.push(`${response.status()} ${response.url()}`);
  });
  return () => {
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
    expect(failedAssets).toEqual([]);
  };
}

test('Pages approval uses browser facts, preserves the task while reading docs and explicitly resets after reload', async ({
  page,
}) => {
  const verify = observeBrowserOnly(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./#labs/human-approval');
  const lab = labRegion(page);
  await expect(lab).toContainText('浏览器内模拟，刷新后重置');
  await lab.getByLabel('姓名', { exact: true }).fill('静态示例');
  await lab.getByLabel('报名人数', { exact: true }).fill('2');
  await lab.getByRole('button', { name: '生成报名提议', exact: true }).focus();
  await page.keyboard.press('Enter');
  const proposal = lab.getByRole('region', { name: '已保存提议', exact: true });
  await expect(proposal).toContainText('等待人工确认');
  const taskId = await value(proposal, '任务 ID').innerText();
  await lab.getByLabel('报名人数', { exact: true }).fill('3');
  await expect(lab.getByRole('button', { name: '确认报名', exact: true })).toBeDisabled();
  await lab.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(value(proposal, '提议内容版本')).toHaveText('2');
  await lab.getByText('边界实验', { exact: true }).click();
  await lab.getByRole('button', { name: '尝试旧版本确认', exact: true }).click();
  await expect(lab).toContainText('VERSION_CONFLICT');
  await lab.getByLabel('模拟丢失确认响应', { exact: true }).check();
  await lab.getByRole('button', { name: '确认报名', exact: true }).click();
  await expect(lab.getByRole('status').first()).toContainText('结果未知');
  await expect(lab.getByRole('button', { name: '生成报名提议', exact: true })).toBeDisabled();
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  const facts = lab.getByRole('region', { name: '报名事实', exact: true });
  await expect(facts).toContainText('报名记录数：1');
  await expect(facts).toContainText('当前页面内存模拟');
  const record = lab.getByRole('article', { name: '已核实报名记录', exact: true });
  await expect(record).toContainText('静态示例');
  await expect(record).toContainText('3 人');
  const enrollmentId = await value(record, '报名 ID').innerText();
  await lab.getByRole('button', { name: '重放上次命令', exact: true }).click();
  await expect(lab.getByRole('status').first()).toContainText('原命令已重放');
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(value(record, '报名 ID')).toHaveText(enrollmentId);
  await expect(facts).toContainText('报名记录数：1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);

  await page.getByRole('link', { name: '实验文档', exact: true }).click();
  const reader = page.getByRole('region', { name: '学习文档', exact: true });
  await expect(reader.getByRole('heading', { level: 1 })).toContainText('人工确认与业务事实');
  await reader.getByRole('link', { name: '人工确认实验', exact: true }).click();
  await expect(value(proposal, '任务 ID')).toHaveText(taskId);
  await expect(value(record, '报名 ID')).toHaveText(enrollmentId);

  await page.reload();
  await expect(lab).toContainText('先查询模拟状态');
  await expect(lab.getByRole('article', { name: '已核实报名记录', exact: true })).toHaveCount(0);
  await expect(lab.getByRole('button', { name: '生成报名提议', exact: true })).toBeDisabled();
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(lab).toContainText('刷新后的模拟状态已清空');
  await expect(lab.getByRole('alert')).toContainText('NOT_FOUND');
  await lab.getByRole('button', { name: '重置浏览器模拟', exact: true }).click();
  await lab.getByRole('button', { name: '生成报名提议', exact: true }).click();
  await expect(proposal).toContainText('等待人工确认');
  await expect(value(proposal, '任务 ID')).not.toHaveText(taskId);
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(facts).toContainText('报名记录数：0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  verify();
});

test('Pages retains pending command data after reload without replaying it into a fresh simulation', async ({
  page,
}) => {
  const verify = observeBrowserOnly(page);
  await page.goto('./#labs/human-approval');
  const lab = labRegion(page);
  await lab.getByRole('button', { name: '生成报名提议', exact: true }).click();
  await expect(lab.getByRole('region', { name: '已保存提议', exact: true })).toContainText(
    '等待人工确认',
  );
  await lab.getByText('边界实验', { exact: true }).click();
  await lab.getByLabel('模拟丢失确认响应', { exact: true }).check();
  await lab.getByRole('button', { name: '确认报名', exact: true }).click();
  await expect(lab.getByRole('status').first()).toContainText('结果未知');
  const original = JSON.parse(await lab.getByLabel('原始报名命令', { exact: true }).innerText());
  await page.reload();
  await expect(lab.getByLabel('原始报名命令', { exact: true })).toContainText(original.commandId);
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(lab).toContainText('刷新后的模拟状态已清空');
  await expect(lab.getByRole('region', { name: '待定命令恢复', exact: true })).toContainText(
    'NOT_FOUND',
  );
  await expect(lab.getByRole('status').first()).toContainText('结果未知');
  await expect(lab.getByRole('button', { name: '以原命令重试', exact: true })).toBeDisabled();
  await lab.getByRole('button', { name: '重置浏览器模拟', exact: true }).click();
  await lab.getByText('上次页面的待定命令线索', { exact: true }).click();
  await expect(lab).toContainText(original.commandId);
  await lab.getByRole('button', { name: '生成报名提议', exact: true }).click();
  await expect(lab.getByRole('region', { name: '已保存提议', exact: true })).toContainText(
    '等待人工确认',
  );
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(lab.getByRole('region', { name: '报名事实', exact: true })).toContainText(
    '报名记录数：0',
  );
  verify();
});
