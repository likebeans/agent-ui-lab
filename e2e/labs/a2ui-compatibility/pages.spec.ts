import { expect, test } from '@playwright/test';
import {
  compatibilityLab,
  exerciseCompatibilityConflicts,
  exerciseCompatibilityFallbacks,
  exerciseCompatibilityValidation,
} from '../../a2ui-compatibility.helpers';

import { observeStaticRequests } from '../../static-requests';

test('Pages W3 capabilities, field validation, conflicts and stale actions use only page memory', async ({
  page,
}) => {
  const verify = observeStaticRequests(page);
  await page.goto('./#labs/a2ui-compatibility');
  const lab = compatibilityLab(page);
  await expect(lab).toContainText('两个浏览器页面不共享状态');
  await exerciseCompatibilityFallbacks(page);
  await lab.getByRole('button', { name: '重置并使用新 ID', exact: true }).click();
  await lab.getByRole('combobox', { name: '声明场景', exact: true }).selectOption('standard');
  await exerciseCompatibilityValidation(page);
  await lab.getByRole('button', { name: '重置并使用新 ID', exact: true }).click();
  await exerciseCompatibilityConflicts(page);
  await lab.getByText('查看证据与应用边界', { exact: true }).click();
  await lab.getByRole('button', { name: '定位组件声明记录', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '协议检查器', exact: true });
  await expect(inspector.locator('.trace-list')).toContainText('browser-agent→client');
  await expect(inspector.locator('.payload')).toContainText('updateComponents');
  await expect(inspector.locator('.payload')).not.toContainText('expectedRevision');
  await expect(inspector.locator('.payload')).not.toContainText('documentId');
  await page.getByRole('link', { name: '实验文档', exact: true }).click();
  await expect(page).toHaveURL(/#docs\/labs%2Fa2ui-compatibility$/u);
  await page.reload();
  const reader = page.getByRole('region', { name: '学习文档', exact: true });
  await expect(reader.getByRole('heading', { level: 1 })).toContainText(
    'W3：A2UI 兼容、校验与编辑冲突',
  );
  await reader
    .getByRole('article')
    .getByRole('link', { name: 'A2UI 兼容与编辑冲突实验', exact: true })
    .click();
  await expect(page).toHaveURL(/#labs\/a2ui-compatibility$/u);
  await page.setViewportSize({ width: 375, height: 812 });
  await exerciseCompatibilityConflicts(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.screenshot({ path: 'test-results/w3-pages-mobile.png', fullPage: true });
  verify();
});

test('Pages W3 saved-action replies protect current inputs and documents stay within one page', async ({
  page,
  context,
}) => {
  const verify = observeStaticRequests(page);
  await page.goto('./#labs/a2ui-compatibility');
  const lab = compatibilityLab(page);
  await lab.getByRole('button', { name: '创建表单', exact: true }).click();
  const id = await lab.getByLabel('文档 ID', { exact: true }).inputValue();
  const days = lab.getByLabel('行程天数', { exact: true });
  await lab.getByLabel('出行人姓名', { exact: true }).fill('静态草稿保护');
  await days.fill('3');
  await lab.getByRole('button', { name: '保存当前动作', exact: true }).click();
  await days.fill('2');
  await lab.getByRole('button', { name: '发送已保存动作', exact: true }).click();
  await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
  await expect(days).toHaveValue('2');
  await expect(lab.getByRole('region', { name: '草稿冲突', exact: true })).toHaveCount(0);
  await lab.getByRole('button', { name: '重新生成计划', exact: true }).click();
  await expect(lab.getByTestId('accepted-actions')).toHaveText('2');
  await lab.getByRole('button', { name: '远端增加预算字段', exact: true }).click();
  const budget = lab.getByLabel('总预算（元）', { exact: true });
  await budget.fill('100');
  await lab.getByRole('button', { name: '保存当前动作', exact: true }).click();
  await budget.fill('2000');
  await lab.getByRole('button', { name: '发送已保存动作', exact: true }).click();
  await expect(lab.getByRole('alert')).toHaveText('预算未满足服务端业务规则。');
  await expect(budget).toHaveValue('2000');
  await expect(budget).not.toHaveAttribute('aria-invalid', 'true');
  await lab.getByRole('button', { name: '重新生成计划', exact: true }).click();
  await expect(lab.getByTestId('accepted-actions')).toHaveText('3');

  const secondPage = await context.newPage();
  const verifySecond = observeStaticRequests(secondPage);
  await secondPage.goto('./#labs/a2ui-compatibility');
  const second = compatibilityLab(secondPage);
  await second.getByLabel('文档 ID', { exact: true }).fill(id);
  await second.getByRole('button', { name: '读取远端', exact: true }).click();
  await expect(second.getByRole('alert')).toHaveText('文档不存在。');
  await expect(second.getByTestId('revision')).toHaveCount(0);
  verifySecond();
  await secondPage.close();
  verify();
});
