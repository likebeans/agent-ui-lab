import { expect, type Page } from '@playwright/test';
import { createCompatibilityForm } from './a2ui-compatibility.helpers';

const dropLabel = '下一次提交成功后丢失响应';

export async function exerciseCompatibilityLostResponse(page: Page) {
  const lab = await createCompatibilityForm(page);
  const drop = lab.getByRole('checkbox', { name: dropLabel, exact: true });
  const name = lab.getByLabel('出行人姓名', { exact: true });
  const days = lab.getByLabel('行程天数', { exact: true });
  const submit = lab.getByRole('button', { name: '生成计划', exact: true });

  await drop.check();
  // Reading, saving and client-side rejection do not initiate an action.
  await lab.getByRole('button', { name: '读取远端', exact: true }).click();
  await expect(drop).toBeChecked();
  await submit.click();
  await expect(lab).toContainText('客户端字段校验未通过，未发送动作。');
  await expect(drop).toBeChecked();
  await name.fill('读者操作丢失回执');
  await days.fill('3');
  await lab.getByRole('button', { name: '保存当前动作', exact: true }).click();
  await expect(drop).toBeChecked();
  await submit.click();

  const unknown = lab.getByRole('region', { name: '动作结果待确认', exact: true });
  await expect(unknown).toContainText('动作结果未知');
  await expect(drop).not.toBeChecked();
  await expect(lab.getByTestId('revision')).toHaveText('1');
  await expect(lab.getByTestId('accepted-actions')).toHaveText('0');
  await expect(days).toHaveValue('3');
  await expect(name).toHaveValue('读者操作丢失回执');
  await expect(lab.getByRole('button', { name: '发送已保存动作', exact: true })).toBeDisabled();
  await expect(lab.getByRole('status')).not.toContainText('服务端接受动作');
  // A second click cannot silently submit while the first result is unknown.
  await submit.click();
  await expect(lab.getByTestId('accepted-actions')).toHaveText('0');
  await lab.getByRole('button', { name: '读取远端确认结果', exact: true }).click();
  await expect(unknown).toHaveCount(0);
  await expect(lab.getByTestId('revision')).toHaveText('2');
  await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
  await expect(days).toHaveValue('3');
  await expect(lab).toContainText('版本与计数不能单独证明是哪次动作成功');
  await expect(lab.getByRole('status')).not.toContainText('服务端接受动作');

  // No fault header remains on a later ordinary submission.
  await lab.getByRole('button', { name: '重新生成计划', exact: true }).click();
  await expect(lab.getByTestId('revision')).toHaveText('3');
  await expect(lab.getByTestId('accepted-actions')).toHaveText('2');
  await expect(unknown).toHaveCount(0);
}

export async function exerciseCompatibilityLostSavedResponse(page: Page, laterDays: string) {
  const lab = await createCompatibilityForm(page);
  const days = lab.getByLabel('行程天数', { exact: true });
  await lab.getByLabel('出行人姓名', { exact: true }).fill('保存动作后继续编辑');
  await days.fill('3');
  await lab.getByRole('button', { name: '保存当前动作', exact: true }).click();
  await days.fill(laterDays);
  await lab.getByRole('checkbox', { name: dropLabel, exact: true }).check();
  await lab.getByRole('button', { name: '发送已保存动作', exact: true }).click();
  await expect(lab.getByRole('region', { name: '动作结果待确认', exact: true })).toBeVisible();
  await expect(lab.getByTestId('revision')).toHaveText('1');
  await expect(lab.getByTestId('accepted-actions')).toHaveText('0');
  await expect(days).toHaveValue(laterDays);
  await lab.getByRole('button', { name: '读取远端确认结果', exact: true }).click();
  await expect(lab.getByTestId('revision')).toHaveText('2');
  await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
  await expect(days).toHaveValue(laterDays);
  const conflicts = lab.getByRole('region', { name: '草稿冲突', exact: true });
  await expect(conflicts).toContainText('远端新值3');
  await lab.getByRole('button', { name: '读取远端', exact: true }).click();
  await expect(conflicts).toBeVisible();
  await lab.getByRole('button', { name: '重新生成计划', exact: true }).click();
  await expect(lab.getByRole('alert')).toHaveText('先处理所有字段冲突，再提交当前草稿。');
  await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
  await lab.getByRole('button', { name: '保留我的行程天数', exact: true }).click();
  await expect(conflicts).toHaveCount(0);
  await expect(days).toHaveValue(laterDays);
  await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
  await lab.getByRole('button', { name: '重新生成计划', exact: true }).click();
  await expect(lab.getByTestId('accepted-actions')).toHaveText('2');
  await expect(lab.locator('[data-a2ui-component-id="status"]')).toContainText(
    `${laterDays} 天游览计划`,
  );
}

export async function exerciseCompatibilityDropRejections(page: Page) {
  const lab = await createCompatibilityForm(page);
  const drop = lab.getByRole('checkbox', { name: dropLabel, exact: true });
  await lab.getByLabel('出行人姓名', { exact: true }).fill('拒绝仍可读取');
  await lab.getByRole('button', { name: '远端增加预算字段', exact: true }).click();
  const budget = lab.getByLabel('总预算（元）', { exact: true });
  await budget.fill('100');
  await drop.check();
  await lab.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(
    lab.getByRole('alert').filter({ hasText: '预算未满足服务端业务规则。' }),
  ).toBeVisible();
  await expect(drop).not.toBeChecked();
  await expect(lab.getByRole('region', { name: '动作结果待确认', exact: true })).toHaveCount(0);
  await expect(lab.getByTestId('accepted-actions')).toHaveText('0');
  await budget.fill('2000');
  await lab.getByRole('button', { name: '保存当前动作', exact: true }).click();
  await drop.check();
  await lab.getByRole('button', { name: '远端延长一天', exact: true }).click();
  await expect(drop).toBeChecked();
  await lab.getByRole('button', { name: '发送已保存动作', exact: true }).click();
  await expect(lab.getByRole('alert')).toHaveText('文档版本已变化，请合并最新快照后重试。');
  await expect(drop).not.toBeChecked();
  await expect(lab.getByRole('region', { name: '动作结果待确认', exact: true })).toHaveCount(0);
  await expect(lab.getByTestId('accepted-actions')).toHaveText('0');
  await lab.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
}

export async function exerciseCompatibilityDropReset(page: Page) {
  const lab = await createCompatibilityForm(page);
  const documentInput = lab.getByLabel('文档 ID', { exact: true });
  const firstDocument = await documentInput.inputValue();
  const drop = lab.getByRole('checkbox', { name: dropLabel, exact: true });
  await drop.check();
  await lab.getByRole('button', { name: '重置并使用新 ID', exact: true }).click();
  await createCompatibilityForm(page);
  await expect(drop).not.toBeChecked();
  await drop.check();
  await documentInput.fill(firstDocument);
  await lab.getByRole('button', { name: '读取远端', exact: true }).click();
  await expect(drop).not.toBeChecked();
}
