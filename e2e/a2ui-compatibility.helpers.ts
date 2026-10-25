import { expect, type Page } from '@playwright/test';

export function compatibilityLab(page: Page) {
  return page.getByRole('region', { name: 'A2UI 兼容与编辑冲突操作区', exact: true });
}

export async function createCompatibilityForm(page: Page) {
  const lab = compatibilityLab(page);
  await lab.getByRole('button', { name: '创建表单', exact: true }).click();
  await expect(lab.getByTestId('revision')).toHaveText('1');
  await expect(lab.getByLabel('行程天数', { exact: true })).toHaveValue('2');
  return lab;
}

export async function exerciseCompatibilityFallbacks(page: Page) {
  const lab = await createCompatibilityForm(page);
  const name = lab.getByLabel('出行人姓名', { exact: true });
  await name.fill('能力切换后的草稿');
  const limited = lab.getByLabel('模拟不支持 ChoicePicker 的客户端', { exact: true });
  await limited.check();
  await expect(lab.getByRole('heading', { name: '当前客户端使用文字降级' })).toBeVisible();
  await expect(lab.getByText('不支持的组件：ChoicePicker。', { exact: true })).toBeVisible();
  await lab.getByRole('button', { name: '读取远端', exact: true }).click();
  await expect(lab.getByTestId('revision')).toHaveText('1');
  await limited.uncheck();
  await expect(name).toHaveValue('能力切换后的草稿');

  for (const [scenario, reason] of [
    ['unknown-catalog', 'https://example.invalid/a2ui/extended-catalog.json'],
    ['unknown-component', 'WeatherMap'],
  ]) {
    await lab.getByRole('button', { name: '重置并使用新 ID', exact: true }).click();
    await lab.getByRole('combobox', { name: '声明场景', exact: true }).selectOption(scenario);
    await lab.getByRole('button', { name: '创建表单', exact: true }).click();
    await expect(lab.getByRole('heading', { name: '当前客户端使用文字降级' })).toBeVisible();
    await expect(lab.getByRole('list')).toContainText(reason);
    await expect(lab.getByLabel('出行人姓名', { exact: true })).toHaveCount(0);
    await expect(lab.getByRole('button', { name: '生成计划', exact: true })).toHaveCount(0);
  }
}

export async function exerciseCompatibilityValidation(page: Page) {
  const lab = await createCompatibilityForm(page);
  const name = lab.getByLabel('出行人姓名', { exact: true });
  await lab.getByRole('button', { name: '生成计划', exact: true }).click();
  const summary = lab.getByRole('alert').filter({ hasText: '请检查以下字段' });
  await expect(summary).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  const describedBy = await name.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText('请填写出行人姓名。');
  await summary.getByRole('button', { name: '请填写出行人姓名。', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(name).toBeFocused();
  await expect(lab).toContainText('客户端字段校验未通过，未发送动作。');
  await name.fill('W3 学习者');
  await lab.getByLabel('行程天数', { exact: true }).fill('8');
  await lab.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(summary).toContainText('行程天数必须是 1 到 7 的整数。');
  await expect(lab.getByTestId('accepted-actions')).toHaveText('0');
  await lab.getByLabel('行程天数', { exact: true }).fill('2');

  await lab.getByRole('button', { name: '远端增加预算字段', exact: true }).click();
  await expect(lab.getByTestId('revision')).toHaveText('2');
  const budget = lab.getByLabel('总预算（元）', { exact: true });
  await expect(budget).toHaveValue('3000');
  await expect(name).toHaveValue('W3 学习者');
  await budget.fill('100');
  await lab.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('总预算至少需要 1000 元（每天 500 元）。');
  await expect(summary).toContainText('服务端业务校验');
  await expect(summary).toContainText('budget · /form/budget · save_trip');
  await expect(budget).toHaveAttribute('aria-invalid', 'true');
  await expect(lab.getByTestId('revision')).toHaveText('2');
  await expect(lab.getByTestId('accepted-actions')).toHaveText('0');
  await budget.fill('2000');
  await lab.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
  await expect(lab.getByTestId('revision')).toHaveText('3');
  await expect(lab.locator('[data-a2ui-component-id="status"]')).toContainText('预算 2000 元');
  await expect(budget).not.toHaveAttribute('aria-invalid', 'true');
  await expect(lab.getByRole('alert')).toHaveCount(0);
}

export async function exerciseCompatibilityConflicts(page: Page) {
  const lab = await createCompatibilityForm(page);
  const days = lab.getByLabel('行程天数', { exact: true });
  const conflicts = lab.getByRole('region', { name: '草稿冲突', exact: true });
  await days.fill('5');
  await lab.getByRole('button', { name: '远端延长一天', exact: true }).click();
  await expect(conflicts).toContainText(/远端新值\s*3/u);
  await expect(days).toHaveValue('5');
  await lab.getByRole('button', { name: '读取远端', exact: true }).click();
  await expect(conflicts).toBeVisible();
  await expect(days).toHaveValue('5');
  await lab.getByRole('button', { name: '保留我的行程天数', exact: true }).click();
  await expect(conflicts).toHaveCount(0);
  await expect(days).toHaveValue('5');
  await lab.getByRole('button', { name: '远端延长一天', exact: true }).click();
  await expect(conflicts).toContainText('远端新值4');
  await lab.getByRole('button', { name: '采用远端行程天数', exact: true }).click();
  await expect(days).toHaveValue('4');
  await lab.getByLabel('出行人姓名', { exact: true }).fill('版本检查');
  await lab.getByRole('button', { name: '保存当前动作', exact: true }).click();
  await lab.getByRole('button', { name: '远端延长一天', exact: true }).click();
  await lab.getByRole('button', { name: '发送已保存动作', exact: true }).click();
  await expect(lab.getByRole('alert')).toHaveText('文档版本已变化，请合并最新快照后重试。');
  await expect(lab.getByTestId('accepted-actions')).toHaveText('0');
  await expect(days).toHaveValue('5');
  await lab.getByRole('button', { name: '保存当前动作', exact: true }).click();
  await lab.getByRole('button', { name: '远端重建 Surface', exact: true }).click();
  await lab.getByRole('button', { name: '发送已保存动作', exact: true }).click();
  await expect(lab.getByRole('alert')).toHaveText('动作属于已替换或其他文档的 Surface。');
  await expect(lab.getByTestId('accepted-actions')).toHaveText('0');
  await lab.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
}
