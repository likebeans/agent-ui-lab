import { expect, test, type Locator, type Page } from '@playwright/test';
import type { TaskLocator } from '../shared/labs/task-locator';

const pages = process.env.PLAYWRIGHT_LAB_MODE === 'pages';
const labs = [
  {
    id: 'human-approval',
    region: '人工确认操作区',
    saved: '已保存提议',
    name: '姓名',
    generate: '生成报名提议',
    approve: '确认报名',
    reset: '重置实验',
    query: '查询事实',
    drop: '模拟丢失确认响应',
  },
  {
    id: 'enrollment-workflow',
    region: '活动报名联合实验操作区',
    saved: '已保存提议与报名事实',
    name: '报名姓名',
    generate: '生成待确认提议',
    approve: '确认此版本并报名',
    reset: '开始新任务',
    query: '查询事实并恢复',
    drop: '模拟命令提交后丢失响应',
  },
] as const;
type Lab = (typeof labs)[number];

const region = (page: Page, lab: Lab) =>
  page.getByRole('region', { name: lab.region, exact: true });
const locatorPanel = (lab: Locator) =>
  lab.getByRole('region', { name: '任务定位信息', exact: true });
const savedPanel = (lab: Locator, spec: Lab) =>
  lab.getByRole('region', { name: spec.saved, exact: true });
const evidenceValue = (panel: Locator, label: string) =>
  panel
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`, 'u') })
    .locator('+ dd');
const openButton = (panel: Locator) =>
  panel.getByRole('button', { name: '打开已有任务', exact: true });

function observe(page: Page, spec: Lab) {
  const commands: string[] = [];
  const queries: string[] = [];
  const external: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/labs/${spec.id}/commands`) commands.push(request.postData() ?? '');
    if (path === `/api/labs/${spec.id}/facts`) queries.push(request.url());
    if (/\/(?:api|mcp)(?:\/|$)/u.test(path)) external.push(path);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return {
    commands,
    queries,
    verify() {
      expect(errors).toEqual([]);
      if (pages) expect(external).toEqual([]);
    },
  };
}

async function generate(page: Page, spec: Lab, name: string) {
  const lab = region(page, spec);
  await lab.getByLabel(spec.name, { exact: true }).fill(name);
  await lab.getByRole('button', { name: spec.generate, exact: true }).click();
  await expect(savedPanel(lab, spec)).toContainText(name);
  await expect(lab.getByRole('button', { name: spec.approve, exact: true })).toBeEnabled();
  return lab;
}

async function exported(lab: Locator) {
  const field = locatorPanel(lab).getByLabel('当前任务定位信息', { exact: true });
  await expect(field).toBeVisible();
  const text = await field.inputValue();
  return { text, locator: JSON.parse(text) as TaskLocator };
}

async function importLocator(panel: Locator, text: string) {
  await panel.getByLabel('粘贴任务定位信息', { exact: true }).fill(text);
  await openButton(panel).click();
}

async function confirmDiscard(panel: Locator) {
  const confirmation = panel.getByRole('group', { name: '放弃草稿确认', exact: true });
  await expect(confirmation).toBeFocused();
  await confirmation.getByRole('button', { name: '放弃草稿并打开任务', exact: true }).click();
}

for (const spec of labs) {
  test(`${spec.id}: copies a strict locator and restores a completed task after reset using facts only`, async ({
    page,
  }) => {
    const observed = observe(page, spec);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`./#labs/${spec.id}`);
    const lab = await generate(page, spec, '定位恢复学员');
    await lab.getByRole('button', { name: spec.approve, exact: true }).click();
    await expect(savedPanel(lab, spec)).toContainText(
      spec.id === 'human-approval' ? '已确认' : '报名已完成',
    );
    const original = await exported(lab);
    expect(Object.keys(original.locator)).toEqual([
      'version',
      'labId',
      'mode',
      'teachingSessionId',
      'taskId',
    ]);
    expect(original.locator).toMatchObject({
      version: 1,
      labId: spec.id,
      mode: pages ? 'pages' : 'local',
    });
    expect(original.text).not.toContain('定位恢复学员');
    const record =
      spec.id === 'human-approval'
        ? lab.getByRole('article', { name: '已核实报名记录', exact: true })
        : savedPanel(lab, spec);
    const enrollmentId = await evidenceValue(record, '报名 ID').innerText();
    const runId =
      spec.id === 'enrollment-workflow'
        ? await evidenceValue(
            lab.getByRole('region', { name: '任务与事件证据' }),
            '运行 ID',
          ).innerText()
        : null;
    const eventCount =
      spec.id === 'enrollment-workflow'
        ? await lab.getByRole('list', { name: '已提交事件' }).getByRole('listitem').count()
        : null;

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    });
    const panel = locatorPanel(lab);
    await panel.getByRole('button', { name: '复制定位信息', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('自动复制不可用');
    const output = panel.getByLabel('当前任务定位信息', { exact: true });
    await expect(output).toBeFocused();
    expect(
      await output.evaluate(
        (field: HTMLTextAreaElement) => field.selectionEnd - field.selectionStart,
      ),
    ).toBe(original.text.length);
    await panel.getByRole('button', { name: '选择定位信息', exact: true }).click();
    await expect(output).toBeFocused();

    await lab.getByRole('button', { name: spec.reset, exact: true }).click();
    await generate(page, spec, '切换前的另一个任务');
    const replacement = await exported(lab);
    expect(replacement.locator.taskId).not.toBe(original.locator.taskId);
    const commandCount = observed.commands.length;
    await importLocator(panel, original.text);
    await expect(lab).toContainText('已打开已有任务。报名记录数：1；本次只查询事实。');
    await expect(output).toHaveValue(original.text);
    await expect(lab.getByLabel(spec.name, { exact: true })).toHaveValue('定位恢复学员');
    await expect(evidenceValue(record, '报名 ID')).toHaveText(enrollmentId);
    expect(observed.commands).toHaveLength(commandCount);
    const inspector = page.getByRole('complementary', { name: '协议检查器', exact: true });
    await expect(inspector.locator('.trace-row strong').filter({ hasText: /^POST /u })).toHaveCount(
      0,
    );
    await expect(
      inspector.locator('.trace-row strong').filter({ hasText: /表单动作/u }),
    ).toHaveCount(0);
    if (spec.id === 'human-approval') {
      await expect(lab.getByRole('button', { name: '重放上次命令', exact: true })).toBeDisabled();
    } else {
      await expect(
        lab.getByRole('button', { name: '重放最后命令', exact: true, includeHidden: true }),
      ).toBeDisabled();
      await expect(
        evidenceValue(lab.getByRole('region', { name: '任务与事件证据' }), '运行 ID'),
      ).toHaveText(runId!);
      await expect(lab.getByRole('list', { name: '已提交事件' }).getByRole('listitem')).toHaveCount(
        eventCount!,
      );
    }
    for (const control of await panel.locator('button, textarea').all()) {
      if (!(await control.isVisible())) continue;
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    observed.verify();
  });

  test(`${spec.id}: invalid imports and failed queries retain the current identity and an initial unsaved draft`, async ({
    page,
  }) => {
    const observed = observe(page, spec);
    await page.goto(`./#labs/${spec.id}`);
    const lab = await generate(page, spec, '旧任务学员');
    const original = await exported(lab);
    await lab.getByRole('button', { name: spec.reset, exact: true }).click();
    await lab.getByLabel(spec.name, { exact: true }).fill('尚未创建任务的草稿');
    const panel = locatorPanel(lab);
    const commands = observed.commands.length;
    const queries = observed.queries.length;
    const storage = await page.evaluate(() => JSON.stringify(sessionStorage));
    for (const text of [
      '{',
      JSON.stringify({ ...original.locator, pending: null }),
      JSON.stringify({
        ...original.locator,
        labId: spec.id === 'human-approval' ? 'enrollment-workflow' : 'human-approval',
      }),
      JSON.stringify({ ...original.locator, mode: pages ? 'local' : 'pages' }),
    ]) {
      await importLocator(panel, text);
      await expect(panel.getByRole('alert')).toBeFocused();
      await expect(panel.getByLabel('粘贴任务定位信息', { exact: true })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      await expect(lab.getByLabel(spec.name, { exact: true })).toHaveValue('尚未创建任务的草稿');
      await expect(panel.getByLabel('当前任务定位信息', { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => JSON.stringify(sessionStorage))).toBe(storage);
    }
    expect(observed.queries).toHaveLength(queries);
    await importLocator(panel, original.text);
    const confirmation = panel.getByRole('group', { name: '放弃草稿确认', exact: true });
    await expect(confirmation).toBeFocused();
    await confirmation.getByRole('button', { name: '保留草稿，取消打开', exact: true }).click();
    await expect(lab.getByLabel(spec.name, { exact: true })).toHaveValue('尚未创建任务的草稿');
    expect(observed.queries).toHaveLength(queries);
    for (const [patch, code] of [
      [{ taskId: `missing-${crypto.randomUUID()}` }, 'NOT_FOUND'],
      [{ teachingSessionId: `other-${crypto.randomUUID()}` }, 'SESSION_MISMATCH'],
    ] as const) {
      await importLocator(panel, JSON.stringify({ ...original.locator, ...patch }));
      await confirmDiscard(panel);
      await expect(panel.getByRole('alert')).toContainText(code);
      await expect(panel.getByLabel('当前任务定位信息', { exact: true })).toHaveCount(0);
      await expect(lab.getByLabel(spec.name, { exact: true })).toHaveValue('尚未创建任务的草稿');
      expect(await page.evaluate(() => JSON.stringify(sessionStorage))).toBe(storage);
    }
    expect(observed.commands).toHaveLength(commands);
    await importLocator(panel, original.text);
    await confirmDiscard(panel);
    await expect(lab.getByLabel(spec.name, { exact: true })).toHaveValue('旧任务学员');
    await expect(panel.getByLabel('当前任务定位信息', { exact: true })).toHaveValue(original.text);
    observed.verify();
  });

  test(`${spec.id}: a new tab restores local facts and exposes the Pages memory boundary`, async ({
    page,
    context,
  }) => {
    await page.goto(`./#labs/${spec.id}`);
    const lab = await generate(page, spec, '跨标签页学员');
    const original = await exported(lab);
    const other = await context.newPage();
    try {
      const observed = observe(other, spec);
      await other.goto(page.url());
      const remote = region(other, spec);
      const panel = locatorPanel(remote);
      await importLocator(panel, original.text);
      if (pages) {
        await expect(panel.getByRole('alert')).toContainText('NOT_FOUND');
        await expect(panel.getByRole('alert')).toContainText('独立标签页或刷新后无法恢复');
        await expect(panel.getByLabel('当前任务定位信息', { exact: true })).toHaveCount(0);
        await expect(savedPanel(remote, spec)).not.toContainText('跨标签页学员');
        await expect(
          remote.getByRole('button', { name: spec.generate, exact: true }),
        ).toBeEnabled();
      } else {
        await expect(panel.getByLabel('当前任务定位信息', { exact: true })).toHaveValue(
          original.text,
        );
        await expect(savedPanel(remote, spec)).toContainText('跨标签页学员');
        await expect(remote.getByLabel(spec.name, { exact: true })).toHaveValue('跨标签页学员');
      }
      expect(observed.commands).toEqual([]);
      observed.verify();
    } finally {
      await other.close();
    }
    if (pages) {
      const observed = observe(page, spec);
      await page.reload();
      await expect(openButton(locatorPanel(lab))).toBeEnabled();
      await importLocator(locatorPanel(lab), original.text);
      await expect(locatorPanel(lab).getByRole('alert')).toContainText('NOT_FOUND');
      await expect(lab.getByRole('button', { name: spec.generate, exact: true })).toBeDisabled();
      await expect(savedPanel(lab, spec)).not.toContainText('跨标签页学员');
      expect(observed.commands).toEqual([]);
      await expect(
        page
          .getByRole('complementary', { name: '协议检查器' })
          .locator('.trace-row strong')
          .filter({ hasText: /^POST /u }),
      ).toHaveCount(0);
      observed.verify();
    }
  });

  test(`${spec.id}: a pending command disables task switching until its facts are known`, async ({
    page,
  }) => {
    const observed = observe(page, spec);
    await page.goto(`./#labs/${spec.id}`);
    const lab = await generate(page, spec, '待定保护学员');
    const original = await exported(lab);
    if (spec.id === 'human-approval') await lab.getByText('边界实验', { exact: true }).click();
    else await lab.locator('summary').filter({ hasText: '验证旧确认与丢失响应' }).click();
    await lab.getByLabel(spec.drop, { exact: true }).check();
    const panel = locatorPanel(lab);
    await panel.getByLabel('粘贴任务定位信息', { exact: true }).fill(original.text);
    await lab.getByRole('button', { name: spec.approve, exact: true }).click();
    await expect(lab).toContainText('结果未知');
    await expect(openButton(panel)).toBeDisabled();
    await expect(panel.getByLabel('粘贴任务定位信息', { exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '复制定位信息', exact: true })).toBeEnabled();
    const commands = observed.commands.length;
    const queries = observed.queries.length;
    await panel.getByRole('form', { name: '打开已有任务', exact: true }).evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(observed.commands).toHaveLength(commands);
    expect(observed.queries).toHaveLength(queries);
    await expect(panel.getByLabel('当前任务定位信息', { exact: true })).toHaveValue(original.text);
    await lab.getByRole('button', { name: spec.query, exact: true }).click();
    await expect(openButton(panel)).toBeEnabled();
    await expect(lab).toContainText(spec.id === 'human-approval' ? '报名记录数：1' : '报名已完成');
    observed.verify();
  });

  test(`${spec.id}: malformed, foreign and unknown HTTP responses never replace the draft or locator`, async ({
    page,
  }) => {
    test.skip(
      pages,
      'This test alters real HTTP facts responses; Pages query boundaries are covered above.',
    );
    const observed = observe(page, spec);
    await page.goto(`./#labs/${spec.id}`);
    const lab = await generate(page, spec, '当前任务学员');
    const original = await exported(lab);
    await lab.getByLabel(spec.name, { exact: true }).fill('任何错误都保留这份草稿');
    const panel = locatorPanel(lab);
    const path = `**/api/labs/${spec.id}/facts?*`;
    const commands = observed.commands.length;
    const storage = await page.evaluate(() => JSON.stringify(sessionStorage));
    for (const failure of ['unknown', 'foreign', 'incomplete'] as const) {
      await page.route(path, async (route) => {
        if (failure === 'unknown') {
          await route.fulfill({ status: 503, json: { error: '教学中断' } });
          return;
        }
        const response = await route.fetch();
        const value = await response.json();
        if (failure === 'foreign') value.task.threadId = 'foreign-session';
        else if (spec.id === 'enrollment-workflow') value.messages = [];
        else delete value.task.state.proposal.content;
        await route.fulfill({ response, json: value });
      });
      await importLocator(panel, original.text);
      await confirmDiscard(panel);
      await expect(panel.getByRole('alert')).toContainText('查询结果未知');
      await expect(lab.getByLabel(spec.name, { exact: true })).toHaveValue(
        '任何错误都保留这份草稿',
      );
      await expect(panel.getByLabel('当前任务定位信息', { exact: true })).toHaveValue(
        original.text,
      );
      await expect(savedPanel(lab, spec)).toContainText('当前任务学员');
      expect(await page.evaluate(() => JSON.stringify(sessionStorage))).toBe(storage);
      expect(observed.commands).toHaveLength(commands);
      await page.unroute(path);
    }
    observed.verify();
  });

  test(`${spec.id}: an in-flight open locks switching and a late response after unmount cannot replace the current identity`, async ({
    page,
  }) => {
    test.skip(pages, 'This test controls the lifetime of a real HTTP response.');
    const observed = observe(page, spec);
    await page.goto(`./#labs/${spec.id}`);
    const lab = await generate(page, spec, '迟到目标任务');
    const original = await exported(lab);
    await lab.getByRole('button', { name: spec.reset, exact: true }).click();
    await generate(page, spec, '应保留的当前任务');
    const current = await exported(lab);
    const path = `**/api/labs/${spec.id}/facts?*`;
    let arrived!: () => void;
    const received = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished!: () => void;
    const handled = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await page.route(path, async (route) => {
      const response = await route.fetch();
      arrived();
      await held;
      try {
        await route.fulfill({ response });
      } catch {
        // The route may already have been aborted when its lab unmounted.
      } finally {
        finished();
      }
    });
    const panel = locatorPanel(lab);
    const commands = observed.commands.length;
    await importLocator(panel, original.text);
    await received;
    await expect(panel.getByLabel('粘贴任务定位信息', { exact: true })).toBeDisabled();
    await expect(lab.getByRole('button', { name: spec.reset, exact: true })).toBeDisabled();
    const draftSubmit =
      spec.id === 'enrollment-workflow'
        ? lab.getByRole('region', { name: '报名草稿', exact: true }).getByRole('button')
        : lab.getByRole('button', { name: spec.generate, exact: true });
    await expect(draftSubmit).toBeDisabled();
    await expect(panel.getByLabel('当前任务定位信息', { exact: true })).toHaveValue(current.text);
    await page.evaluate(() => {
      window.location.hash = '#labs/foundation';
    });
    await expect(
      page.getByRole('region', { name: '实验接入示例操作区', exact: true }),
    ).toBeVisible();
    release();
    await handled;
    await page.unroute(path);
    await page.evaluate((id) => {
      window.location.hash = `#labs/${id}`;
    }, spec.id);
    await expect(locatorPanel(lab).getByLabel('当前任务定位信息', { exact: true })).toHaveValue(
      current.text,
    );
    if (spec.id === 'human-approval')
      await lab.getByRole('button', { name: spec.query, exact: true }).click();
    await expect(lab.getByLabel(spec.name, { exact: true })).toHaveValue('应保留的当前任务');
    expect(observed.commands).toHaveLength(commands);
    observed.verify();
  });
}
