import { expect, test } from '@playwright/test';
import {
  compatibilityLab,
  createCompatibilityForm,
  exerciseCompatibilityConflicts,
  exerciseCompatibilityDocumentSwitch,
  exerciseCompatibilityFallbacks,
  exerciseCompatibilityValidation,
} from './a2ui-compatibility.helpers';
import {
  exerciseCompatibilityDropRejections,
  exerciseCompatibilityDropReset,
  exerciseCompatibilityLostResponse,
  exerciseCompatibilityLostSavedResponse,
} from './a2ui-compatibility-recovery.helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/#labs/a2ui-compatibility');
});

test('the one-shot loss control requires a read and never automatically resubmits', async ({
  page,
}) => {
  const headers: (string | undefined)[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/actions')) {
      headers.push(request.headers()['x-a2ui-compatibility-drop-response']);
      const envelope = request.postDataJSON();
      expect(Object.keys(envelope).sort()).toEqual(['action', 'expectedRevision']);
      expect(envelope.action).toMatchObject({ version: 'v0.9.1' });
      expect(JSON.stringify(envelope)).not.toContain('Drop-Response');
    }
  });
  await exerciseCompatibilityLostResponse(page);
  expect(headers).toEqual(['1', undefined]);
});

for (const laterDays of ['2', '5']) {
  test(`the loss control preserves saved-action later draft ${laterDays} until an explicit conflict choice`, async ({
    page,
  }) => {
    await exerciseCompatibilityLostSavedResponse(page, laterDays);
  });
}

test('the loss control consumes domain rejections and clears on reset or document switch', async ({
  page,
}) => {
  await exerciseCompatibilityDropRejections(page);
  await compatibilityLab(page)
    .getByRole('button', { name: '重置并使用新 ID', exact: true })
    .click();
  await exerciseCompatibilityDropReset(page);
});

test('capability checks fall back without fetching catalogs and preserve a hidden draft', async ({
  page,
}) => {
  const errors: string[] = [];
  const catalogs: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/catalog\.json|extended-catalog\.json/u.test(request.url())) catalogs.push(request.url());
  });
  await exerciseCompatibilityFallbacks(page);
  expect(catalogs).toEqual([]);
  expect(errors).toEqual([]);
});

test('client errors send no action and server budget errors locate the same controlled field', async ({
  page,
}) => {
  const actions: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/actions')) actions.push(request.postDataJSON());
  });
  await exerciseCompatibilityValidation(page);
  expect(actions).toHaveLength(2);
  expect(actions[0]).toMatchObject({
    expectedRevision: 2,
    action: { version: 'v0.9.1', action: { context: { budget: '100' } } },
  });
  expect((actions[0] as { action: object }).action).not.toHaveProperty('expectedRevision');
});

test('draft conflicts require a choice and obsolete revision or Surface actions never execute', async ({
  page,
}) => {
  const codes: string[] = [];
  page.on('response', async (response) => {
    if (response.url().endsWith('/actions') && response.status() === 409) {
      codes.push((await response.json()).code);
    }
  });
  await exerciseCompatibilityConflicts(page);
  expect(codes).toEqual(['revision-mismatch', 'surface-mismatch']);
});

test('switching documents clears saved actions while same-document stale actions remain testable', async ({
  page,
}) => {
  await exerciseCompatibilityDocumentSwitch(page);
});

for (const laterDays of ['5', '2']) {
  test(`saved-action acknowledgement preserves later input ${laterDays}, including the original baseline`, async ({
    page,
  }) => {
    const lab = await createCompatibilityForm(page);
    const days = lab.getByLabel('行程天数', { exact: true });
    await lab.getByLabel('出行人姓名', { exact: true }).fill('草稿保护');
    await days.fill('3');
    await lab.getByRole('button', { name: '保存当前动作', exact: true }).click();
    await days.fill(laterDays);
    await lab.getByRole('button', { name: '发送已保存动作', exact: true }).click();
    await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
    await expect(days).toHaveValue(laterDays);
    await expect(lab.getByRole('region', { name: '草稿冲突', exact: true })).toHaveCount(0);
    await lab.getByRole('button', { name: '重新生成计划', exact: true }).click();
    await expect(lab.getByTestId('accepted-actions')).toHaveText('2');
    await expect(days).toHaveValue(laterDays);
    await expect(lab.locator('[data-a2ui-component-id="status"]')).toContainText(
      `${laterDays} 天游览计划`,
    );
  });
}

test('reading after a lost saved-action acknowledgement keeps later edits and requires a choice', async ({
  page,
}) => {
  const lab = await createCompatibilityForm(page);
  const days = lab.getByLabel('行程天数', { exact: true });
  await lab.getByLabel('出行人姓名', { exact: true }).fill('保存动作后继续编辑');
  await days.fill('3');
  await lab.getByRole('button', { name: '保存当前动作', exact: true }).click();
  await days.fill('2');
  let actionRequests = 0;
  let releaseReply!: () => void;
  const holdReply = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  await page.route('**/api/labs/a2ui-compatibility/documents/*/actions', async (route) => {
    actionRequests += 1;
    const response = await route.fetch();
    expect(await response.json()).toMatchObject({
      kind: 'accepted',
      snapshot: { revision: 2, acceptedActions: 1 },
    });
    await holdReply;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await lab.getByRole('button', { name: '发送已保存动作', exact: true }).click();
    await expect(lab.getByRole('alert')).toContainText('请求超时', { timeout: 12_000 });
    await lab.getByRole('button', { name: '读取远端', exact: true }).click();
    await expect(lab.getByTestId('revision')).toHaveText('2');
    await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
    await expect(days).toHaveValue('2');
    const conflicts = lab.getByRole('region', { name: '草稿冲突', exact: true });
    await expect(conflicts).toContainText('远端新值3');
    await lab.getByRole('button', { name: '读取远端', exact: true }).click();
    await expect(conflicts).toBeVisible();
    expect(actionRequests).toBe(1);
    await lab.getByRole('button', { name: '保留我的行程天数', exact: true }).click();
    await expect(conflicts).toHaveCount(0);
    await expect(days).toHaveValue('2');
    await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
  } finally {
    releaseReply();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('a rejected saved action does not mark a newer valid draft as invalid', async ({ page }) => {
  const lab = await createCompatibilityForm(page);
  await lab.getByLabel('出行人姓名', { exact: true }).fill('校验归属');
  await lab.getByRole('button', { name: '远端增加预算字段', exact: true }).click();
  const budget = lab.getByLabel('总预算（元）', { exact: true });
  await budget.fill('100');
  await lab.getByRole('button', { name: '保存当前动作', exact: true }).click();
  await budget.fill('2000');
  await lab.getByRole('button', { name: '发送已保存动作', exact: true }).click();
  await expect(lab.getByRole('alert')).toHaveText('预算未满足服务端业务规则。');
  await expect(budget).toHaveValue('2000');
  await expect(budget).not.toHaveAttribute('aria-invalid', 'true');
  await expect(lab.getByRole('heading', { name: '请检查以下字段' })).toHaveCount(0);
  await expect(lab).toContainText('当前草稿已保留，可用表单按钮提交当前值。');
  await lab.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
});

test('two pages share server authority while stale requests preserve drafts and counts', async ({
  page,
  context,
}) => {
  const first = await createCompatibilityForm(page);
  const id = await first.getByLabel('文档 ID', { exact: true }).inputValue();
  const secondPage = await context.newPage();
  await secondPage.goto('/#labs/a2ui-compatibility');
  const second = compatibilityLab(secondPage);
  await second.getByLabel('文档 ID', { exact: true }).fill(id);
  await second.getByRole('button', { name: '读取远端', exact: true }).click();
  await expect(second.getByTestId('revision')).toHaveText('1');

  const days = first.getByLabel('行程天数', { exact: true });
  await days.fill('5');
  await second.getByRole('button', { name: '远端延长一天', exact: true }).click();
  await expect(second.getByTestId('revision')).toHaveText('2');
  await first.getByRole('button', { name: '读取远端', exact: true }).click();
  await expect(days).toHaveValue('5');
  await expect(first.getByRole('region', { name: '草稿冲突', exact: true })).toContainText(
    '远端新值3',
  );
  await first.getByRole('button', { name: '保留我的行程天数', exact: true }).click();
  await first.getByLabel('出行人姓名', { exact: true }).fill('并发页面 A');
  await first.getByRole('button', { name: '保存当前动作', exact: true }).click();
  await second.getByRole('button', { name: '远端延长一天', exact: true }).click();
  const rejected = page.waitForResponse((response) => response.url().endsWith('/actions'));
  await first.getByRole('button', { name: '发送已保存动作', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(first.getByTestId('accepted-actions')).toHaveText('0');
  await expect(first.getByTestId('revision')).toHaveText('3');
  await expect(days).toHaveValue('5');
  await first.getByRole('button', { name: '采用远端行程天数', exact: true }).click();
  await expect(days).toHaveValue('4');
  await first.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(first.getByTestId('accepted-actions')).toHaveText('1');
  await second.getByRole('button', { name: '读取远端', exact: true }).click();
  await expect(second.getByTestId('accepted-actions')).toHaveText('1');
  await expect(second.getByLabel('出行人姓名', { exact: true })).toHaveValue('并发页面 A');
  await secondPage.close();
});

test('a lost acknowledgement times out and a read confirms the outcome without resubmission', async ({
  page,
}) => {
  const lab = await createCompatibilityForm(page);
  await lab.getByLabel('出行人姓名', { exact: true }).fill('超时后读取');
  let releaseReply!: () => void;
  const holdReply = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  await page.route('**/api/labs/a2ui-compatibility/documents/*/actions', async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await holdReply;
    await route.fulfill({ response }).catch(() => {});
  });
  await lab.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(lab.getByRole('alert')).toHaveText(
    '请求超时。请先读取远端确认版本与成功动作计数，再决定是否重试。',
    { timeout: 12_000 },
  );
  await expect(lab.getByRole('button', { name: '读取远端', exact: true })).toBeEnabled();
  await lab.getByRole('button', { name: '读取远端', exact: true }).click();
  await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
  await expect(lab.getByLabel('出行人姓名', { exact: true })).toHaveValue('超时后读取');
  releaseReply();
  await page.unrouteAll({ behavior: 'wait' });
});

for (const failure of [
  ...[403, 404, 500].map((status) => ({
    label: `generic HTTP ${status}`,
    response: { status, json: { error: '表单服务暂时不可用。' } },
    message: `HTTP ${status}：表单服务暂时不可用。`,
  })),
  {
    label: 'non-JSON HTTP 500',
    response: { status: 500, contentType: 'text/html', body: '<html>Unavailable</html>' },
    message: 'HTTP 500：响应不是有效的 JSON。',
  },
  {
    label: 'an unknown JSON reply',
    response: { status: 200, json: { kind: 'future-reply' } },
    message: 'HTTP 200：响应格式无效，无法确认应用结果。',
  },
  {
    label: 'an incomplete snapshot',
    response: { status: 200, json: { kind: 'snapshot', snapshot: {} } },
    message: 'HTTP 200：响应格式无效，无法确认应用结果。',
  },
]) {
  test(`read reports ${failure.label} and preserves the editable draft`, async ({ page }) => {
    const lab = await createCompatibilityForm(page);
    const days = lab.getByLabel('行程天数', { exact: true });
    await days.fill('5');
    let requests = 0;
    await page.route('**/api/labs/a2ui-compatibility/documents/*', (route) => {
      requests += 1;
      return route.fulfill(failure.response);
    });
    await lab.getByRole('button', { name: '读取远端', exact: true }).click();
    await expect(lab.getByRole('alert')).toHaveText(failure.message);
    await expect(days).toHaveValue('5');
    await expect(lab.getByTestId('revision')).toHaveText('1');
    await expect(lab.getByRole('button', { name: '读取远端', exact: true })).toBeEnabled();
    expect(requests).toBe(1);
  });
}

test('a failed saved-action request cannot attribute another accepted action to itself', async ({
  page,
}) => {
  const lab = await createCompatibilityForm(page);
  const days = lab.getByLabel('行程天数', { exact: true });
  await lab.getByLabel('出行人姓名', { exact: true }).fill('结果归属待确认');
  await days.fill('3');
  await lab.getByRole('button', { name: '保存当前动作', exact: true }).click();
  await days.fill('5');
  let requests = 0;
  await page.route('**/api/labs/a2ui-compatibility/documents/*/actions', async (route) => {
    requests += 1;
    // This request fails before execution, while another client saves days=2.
    const other = route.request().postDataJSON();
    other.action.action.context.days = '2';
    const response = await page.request.post(route.request().url(), { data: other });
    expect(await response.json()).toMatchObject({
      kind: 'accepted',
      snapshot: { revision: 2, acceptedActions: 1 },
    });
    await route.fulfill({ status: 500, json: { error: '动作结果无法读取。' } });
  });
  await lab.getByRole('button', { name: '发送已保存动作', exact: true }).click();
  await expect(lab.getByRole('alert')).toHaveText('HTTP 500：动作结果无法读取。');
  await lab.getByRole('button', { name: '读取远端', exact: true }).click();
  await expect(lab.getByTestId('accepted-actions')).toHaveText('1');
  await expect(days).toHaveValue('5');
  await expect(lab.getByRole('region', { name: '草稿冲突', exact: true })).toContainText(
    '远端新值2',
  );
  await expect(lab.getByRole('status')).not.toContainText('服务端接受动作');
  expect(requests).toBe(1);
});

test('documentation roundtrip retains conflicts and the phone layout supports both themes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 375, height: 812 });
  const skip = page.getByRole('link', { name: '跳到主要内容', exact: true });
  await expect(skip).toHaveCSS('clip-path', 'inset(50%)');
  await skip.focus();
  await expect(skip).toHaveCSS('clip-path', 'none');
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(skip).toHaveCSS('clip-path', 'inset(50%)');
  const lab = await createCompatibilityForm(page);
  await lab.getByLabel('行程天数', { exact: true }).fill('5');
  await lab.getByRole('button', { name: '远端延长一天', exact: true }).click();
  await lab.getByRole('region', { name: '草稿冲突', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.screenshot({ path: 'test-results/w3-mobile-conflict-light.png', fullPage: true });
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await page.screenshot({ path: 'test-results/w3-mobile-conflict-dark.png', fullPage: true });
  await page.getByRole('link', { name: '打开学习文档', exact: true }).click();
  await expect(page).toHaveURL(/#docs\/labs%2Fa2ui-compatibility$/u);
  const reader = page.getByRole('region', { name: '学习文档', exact: true });
  await expect(reader.getByRole('heading', { level: 1 })).toContainText(
    'W3：A2UI 兼容、校验与编辑冲突',
  );
  await reader.locator('header').getByRole('link', { name: /返回/ }).click();
  await expect(lab.getByLabel('行程天数', { exact: true })).toHaveValue('5');
  await expect(lab.getByRole('region', { name: '草稿冲突', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await lab.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/w3-desktop-conflict.png', fullPage: true });
  expect(errors).toEqual([]);
});
