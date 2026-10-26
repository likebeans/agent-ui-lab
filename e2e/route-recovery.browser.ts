import { expect, test, type Page } from '@playwright/test';

const pages = process.env.PLAYWRIGHT_LAB_MODE === 'pages';

function modulePath(name: string) {
  return pages
    ? new RegExp(`/assets/${name}-[^/?]+\\.js(?:\\?|$)`, 'u')
    : new RegExp(`/src/${name}\\.tsx(?:\\?|$)`, 'u');
}

async function failModule(page: Page, name: string) {
  let requests = 0;
  await page.route(modulePath(name), (route) => {
    requests += 1;
    return route.abort('failed');
  });
  return {
    requests: () => requests,
    restore: () => page.unroute(modulePath(name)),
  };
}

type ChatRequestRecord = { path: string; body?: Record<string, unknown> };
declare global {
  interface Window {
    __chatModuleRequests: ChatRequestRecord[];
  }
}

async function observeChatRequests(page: Page) {
  const requests: ChatRequestRecord[] = [];
  if (pages) {
    await page.addInitScript(() => {
      window.__chatModuleRequests = [];
    });
    // Observe the real browser-memory adapter, which intentionally bypasses network fetch.
    await page.route(modulePath('static-api'), async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const exported = /export\s*\{\s*([\w$]+)\s+as\s+staticFetch\s*\};?\s*$/u;
      expect(source).toMatch(exported);
      await route.fulfill({
        response,
        body: source.replace(
          exported,
          `function __observeChatModuleRequest(path, options = {}) {
            window.__chatModuleRequests.push({
              path, body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
            });
            return $1(path, options);
          }
          export { __observeChatModuleRequest as staticFetch };`,
        ),
      });
    });
  } else {
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && (path.startsWith('/api/') || path === '/mcp'))
        requests.push({ path, body: request.postDataJSON() });
    });
  }
  return async () => (pages ? page.evaluate(() => window.__chatModuleRequests) : [...requests]);
}

async function sendChat(page: Page, mode: string, prompt: string) {
  await page.getByRole('combobox', { name: '协议选择' }).selectOption(mode);
  await page.getByRole('textbox', { name: '发送消息给 Agent' }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}

for (const target of [
  { module: 'DocsReader', href: '#docs/map', label: '学习文档', heading: '学习地图' },
  { module: 'App', href: '#overview', label: '独立实验', heading: '让 AI 不止于对话。' },
]) {
  test(`${target.label} module failure preserves chat and supports retry without reloading`, async ({
    page,
  }) => {
    await page.goto('./#chat');
    const composer = page.getByRole('textbox', { name: '发送消息给 Agent' });
    await composer.fill('模块恢复后继续写的草稿');
    const identity = await page.evaluate(() => {
      const marker = crypto.randomUUID();
      document.body.dataset.recoveryIdentity = marker;
      return marker;
    });
    const failure = await failModule(page, target.module);
    await page.locator(`a[href="${target.href}"]`).first().click();
    const fallback = page.getByRole('region', { name: `${target.label}暂时无法打开` });
    await expect(fallback).toBeVisible();
    await expect(fallback.getByRole('heading')).toBeFocused();
    await expect(fallback.getByRole('alert')).toContainText('请检查网络连接后重试');
    expect(failure.requests()).toBeGreaterThan(0);
    await fallback.getByRole('link', { name: '返回 Agent 对话', exact: true }).click();
    await expect(composer).toHaveValue('模块恢复后继续写的草稿');
    await page.locator(`a[href="${target.href}"]`).first().click();
    await expect(fallback).toBeVisible();
    await failure.restore();
    await fallback.getByRole('button', { name: '重试加载', exact: true }).click();
    const heading = page.getByRole('heading', { level: 1 }).filter({ hasText: target.heading });
    await expect(heading).toBeVisible();
    await page.getByRole('link', { name: '返回 Agent 对话', exact: true }).first().click();
    await expect(composer).toHaveValue('模块恢复后继续写的草稿');
    expect(await page.locator('body').getAttribute('data-recovery-identity')).toBe(identity);
  });
}

for (const target of [
  { lab: 'a2ui', module: 'A2uiLab', localModule: 'labs/A2uiLab', name: 'A2UI' },
  {
    lab: 'agui',
    module: 'AguiChatTurn',
    localModule: 'components/AguiChatTurn',
    name: 'AG-UI',
  },
]) {
  test(`${target.name} chat module retries in the original reply without rerouting or replaying completed work`, async ({
    page,
  }) => {
    const readRequests = await observeChatRequests(page);
    await page.goto('./#chat');
    const composer = page.getByRole('textbox', { name: '发送消息给 Agent' });
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    const previousName = target.lab === 'agui' ? 'A2UI' : 'AG-UI';
    await sendChat(page, target.lab === 'agui' ? 'a2ui' : 'agui', '杭州三日游');
    const previous = page.getByRole('article', { name: `${previousName} Agent 回复`, exact: true });
    if (target.lab === 'agui') {
      await previous.getByLabel('出行人姓名', { exact: true }).fill('保留表单操作');
      await previous.getByRole('button', { name: '生成计划', exact: true }).click();
      await expect(previous.locator('[data-a2ui-component-id="status"]')).toContainText(
        '已为 保留表单操作 生成',
      );
      await previous.getByLabel('出行人姓名', { exact: true }).fill('保留未提交表单草稿');
      await previous.getByLabel('行程天数', { exact: true }).fill('5');
    } else {
      await expect(previous.getByRole('status')).toContainText('已完成');
    }
    await previous.evaluate((node) => {
      node.dataset.previousReply = 'preserved';
    });

    await sendChat(page, 'mcp', '打开杭州的活动应用');
    const app = page.getByRole('article', { name: 'MCP Apps Agent 回复', exact: true });
    await expect(app.getByRole('status')).toContainText('App 与宿主已连接');
    const frame = app.frameLocator('iframe');
    await frame.getByRole('button', { name: '上海', exact: true }).click();
    await expect(frame.getByText('外滩建筑散步', { exact: true })).toBeVisible();
    const frameIdentity = await frame.locator('body').evaluate((node) => {
      node.dataset.recoveryIdentity = crypto.randomUUID();
      return node.dataset.recoveryIdentity;
    });
    const pageIdentity = await page.locator('body').evaluate((node) => {
      node.dataset.recoveryIdentity = crypto.randomUUID();
      return node.dataset.recoveryIdentity;
    });
    const successfulRequests = await readRequests();
    const failure = await failModule(page, pages ? target.module : target.localModule);
    await sendChat(page, target.lab, '按照当前需求继续生成');
    const reply = page.getByRole('article', { name: `${target.name} Agent 回复`, exact: true });
    const recovery = reply.getByRole('region', { name: `${target.name} 回复暂时无法打开` });
    await expect(recovery).toBeVisible();
    await expect(recovery.getByRole('heading')).toBeFocused();
    expect(failure.requests()).toBeGreaterThan(0);
    const turnIdentity = await reply.evaluate((node) => {
      node.dataset.recoveryIdentity = crypto.randomUUID();
      return node.dataset.recoveryIdentity;
    });
    await composer.fill('模块恢复后继续编辑的聊天草稿');
    await expect(send).toBeEnabled();
    const failedRequests = await readRequests();
    expect(failedRequests.slice(successfulRequests.length).map(({ path }) => path)).toEqual([
      '/api/chat',
    ]);
    const routeCount = failedRequests.filter(({ path }) => path === '/api/chat').length;

    // A second failed attempt must release pending again and leave this same turn recoverable.
    const blockedRequests = failure.requests();
    await recovery.getByRole('button', { name: '重试加载', exact: true }).click();
    await expect.poll(failure.requests).toBeGreaterThan(blockedRequests);
    await expect(recovery).toBeVisible();
    await expect(send).toBeEnabled();
    expect(await readRequests()).toEqual(failedRequests);
    await failure.restore();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const intercepted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let retryRequests = 0;
    await page.route(
      modulePath(pages ? target.module : target.localModule),
      async (route) => {
        retryRequests += 1;
        started();
        await held;
        await route.continue();
      },
      { times: 1 },
    );
    try {
      await recovery.getByRole('button', { name: '重试加载', exact: true }).click();
      await intercepted;
      await expect(reply.getByRole('status')).toContainText('正在打开');
      await expect(send).toBeDisabled();
      await expect(composer).toHaveValue('模块恢复后继续编辑的聊天草稿');
    } finally {
      release();
    }
    if (target.lab === 'a2ui') {
      await expect(reply.getByLabel('出行人姓名', { exact: true })).toBeVisible();
    } else {
      await expect(reply.getByRole('status')).toContainText('已完成');
    }
    await expect(recovery).toHaveCount(0);
    await expect(send).toBeEnabled();
    await expect(composer).toHaveValue('模块恢复后继续编辑的聊天草稿');
    await expect(reply).toHaveCount(1);
    await expect(reply).toHaveAttribute('data-recovery-identity', turnIdentity);
    await expect(previous).toHaveAttribute('data-previous-reply', 'preserved');
    if (target.lab === 'agui') {
      await expect(previous.getByLabel('出行人姓名', { exact: true })).toHaveValue(
        '保留未提交表单草稿',
      );
      await expect(previous.getByLabel('行程天数', { exact: true })).toHaveValue('5');
      await expect(previous.locator('[data-a2ui-component-id="status"]')).toContainText(
        '已为 保留表单操作 生成',
      );
    }
    await expect(frame.locator('body')).toHaveAttribute('data-recovery-identity', frameIdentity);
    await expect(frame.getByText('外滩建筑散步', { exact: true })).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-recovery-identity', pageIdentity);
    expect(new URL(page.url()).hash).toBe('#chat');
    expect(retryRequests).toBe(1);
    const recoveredRequests = await readRequests();
    expect(recoveredRequests.filter(({ path }) => path === '/api/chat')).toHaveLength(routeCount);
    const added = recoveredRequests.slice(failedRequests.length);
    expect(added.map(({ path }) => path)).toEqual([
      target.lab === 'a2ui' ? '/api/a2ui/surface' : '/api/agui',
    ]);
    const original = successfulRequests.find(({ path }) =>
      target.lab === 'agui' ? path === '/api/a2ui/surface' : path === '/api/agui',
    )!;
    expect(added[0].body?.threadId).toBe(original.body?.threadId);
  });
}

if (pages) {
  test('Pages retries failed A2UI stylesheets before mounting the reply without replaying completed work', async ({
    page,
  }) => {
    const readRequests = await observeChatRequests(page);
    const stylesheetPath = /\/assets\/A2uiSurfaceRenderer-[^/?]+\.css(?:\?|$)/u;
    let stylesheetRequests = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const intercepted = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route(stylesheetPath, async (route) => {
      stylesheetRequests += 1;
      if (stylesheetRequests <= 2) return route.abort('failed');
      started();
      await held;
      await route.continue();
    });
    await page.goto('./#chat');
    await sendChat(page, 'agui', '杭州三日游');
    const previous = page.getByRole('article', { name: 'AG-UI Agent 回复', exact: true });
    await expect(previous.getByRole('status')).toContainText('已完成');
    const previousContent = previous.locator('.chat-itinerary');
    const previousIdentity = await previousContent.evaluate((node) => {
      node.dataset.recoveryIdentity = crypto.randomUUID();
      return node.dataset.recoveryIdentity;
    });
    const pageIdentity = await page.locator('body').evaluate((node) => {
      node.dataset.recoveryIdentity = crypto.randomUUID();
      return node.dataset.recoveryIdentity;
    });
    const successfulRequests = await readRequests();
    expect(successfulRequests.filter(({ path }) => path === '/api/chat')).toHaveLength(1);
    expect(successfulRequests.filter(({ path }) => path === '/api/agui')).toHaveLength(1);
    expect(stylesheetRequests).toBe(0);

    await sendChat(page, 'a2ui', '生成杭州三日游的表单');
    const reply = page.getByRole('article', { name: 'A2UI Agent 回复', exact: true });
    const recovery = reply.getByRole('region', { name: 'A2UI 回复暂时无法打开' });
    const name = reply.getByLabel('出行人姓名', { exact: true });
    const composer = page.getByRole('textbox', { name: '发送消息给 Agent' });
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    await expect(recovery).toBeVisible();
    await expect(recovery.getByRole('heading')).toBeFocused();
    await expect(name).toHaveCount(0);
    expect(stylesheetRequests).toBe(1);
    const turnIdentity = await reply.evaluate((node) => {
      node.dataset.recoveryIdentity = crypto.randomUUID();
      return node.dataset.recoveryIdentity;
    });
    await composer.fill('样式恢复后继续编辑的聊天草稿');
    await expect(send).toBeEnabled();
    const failedRequests = await readRequests();
    expect(failedRequests.slice(successfulRequests.length).map(({ path }) => path)).toEqual([
      '/api/chat',
    ]);
    expect(failedRequests.filter(({ path }) => path === '/api/chat')).toHaveLength(2);
    expect(failedRequests.filter(({ path }) => path.startsWith('/api/a2ui/'))).toHaveLength(0);

    // Vite remembers even failed CSS preloads; every retry must make a real stylesheet request.
    await recovery.getByRole('button', { name: '重试加载', exact: true }).click();
    await expect.poll(() => stylesheetRequests).toBe(2);
    await expect(recovery).toBeVisible();
    await expect(name).toHaveCount(0);
    await expect(send).toBeEnabled();
    await expect(composer).toHaveValue('样式恢复后继续编辑的聊天草稿');
    expect(await readRequests()).toEqual(failedRequests);

    try {
      await recovery.getByRole('button', { name: '重试加载', exact: true }).click();
      await intercepted;
      await expect(reply.getByRole('status')).toContainText('正在打开');
      await expect(name).toHaveCount(0);
      await expect(send).toBeDisabled();
      await expect(composer).toHaveValue('样式恢复后继续编辑的聊天草稿');
      expect(await readRequests()).toEqual(failedRequests);
    } finally {
      release();
    }
    await expect(name).toBeVisible();
    const field = reply.locator('[data-a2ui-component-id="traveler"]');
    await expect(field).toHaveCSS('display', 'flex');
    await expect(field).toHaveCSS('flex-direction', 'column');
    await expect(field).toHaveCSS('gap', '7px');
    await expect(recovery).toHaveCount(0);
    await expect(send).toBeEnabled();
    await expect(composer).toHaveValue('样式恢复后继续编辑的聊天草稿');
    await expect(reply).toHaveCount(1);
    await expect(reply).toHaveAttribute('data-recovery-identity', turnIdentity);
    await expect(previousContent).toHaveAttribute('data-recovery-identity', previousIdentity);
    await expect(page.locator('body')).toHaveAttribute('data-recovery-identity', pageIdentity);
    expect(new URL(page.url()).hash).toBe('#chat');
    expect(stylesheetRequests).toBe(3);
    const recoveredRequests = await readRequests();
    expect(recoveredRequests.slice(0, failedRequests.length)).toEqual(failedRequests);
    const added = recoveredRequests.slice(failedRequests.length);
    expect(added.map(({ path }) => path)).toEqual(['/api/a2ui/surface']);
    expect(added[0].body?.threadId).toBe(
      successfulRequests.find(({ path }) => path === '/api/agui')!.body?.threadId,
    );

    await name.fill('CSS 恢复学习者');
    await reply.getByLabel('行程天数', { exact: true }).fill('5');
    await reply.getByRole('button', { name: '生成计划', exact: true }).click();
    await expect(reply.locator('[data-a2ui-component-id="status"]')).toContainText(
      '已为 CSS 恢复学习者 生成',
    );
    const submittedRequests = await readRequests();
    expect(submittedRequests.slice(0, recoveredRequests.length)).toEqual(recoveredRequests);
    expect(submittedRequests.slice(recoveredRequests.length).map(({ path }) => path)).toEqual([
      '/api/a2ui/action',
    ]);
    expect(submittedRequests.filter(({ path }) => path === '/api/chat')).toHaveLength(2);
    expect(submittedRequests.filter(({ path }) => path === '/api/agui')).toHaveLength(1);
    expect(submittedRequests.filter(({ path }) => path === '/api/a2ui/surface')).toHaveLength(1);
    expect(submittedRequests.filter(({ path }) => path === '/api/a2ui/action')).toHaveLength(1);
    expect(submittedRequests.at(-1)?.body).toMatchObject({
      action: { context: { traveler: 'CSS 恢复学习者', days: '5' } },
    });
    await expect(composer).toHaveValue('样式恢复后继续编辑的聊天草稿');
    await expect(previousContent).toHaveAttribute('data-recovery-identity', previousIdentity);
  });
}

test('a document failure returns to the existing experiment draft on a phone', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./#labs/a2ui');
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await page.getByRole('button', { name: '生成 A2UI 界面', exact: true }).click();
  const name = page.getByLabel('出行人姓名', { exact: true });
  await name.fill('文档失败后继续编辑');
  await failModule(page, 'DocsReader');
  await page.getByRole('link', { name: '打开学习文档', exact: true }).click();
  const fallback = page.getByRole('region', { name: '学习文档暂时无法打开' });
  await expect(fallback.getByRole('heading')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.screenshot({
    path: testInfo.outputPath('module-recovery-mobile.png'),
    fullPage: true,
  });
  await fallback.getByRole('link', { name: '返回独立实验', exact: true }).click();
  await expect(name).toHaveValue('文档失败后继续编辑');
});

test('an individual experiment module can fail and retry inside the existing workspace', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./#labs/agui');
  await expect(page.getByRole('button', { name: '开始运行', exact: true })).toBeVisible();
  const failure = await failModule(page, pages ? 'A2uiLab' : 'labs/A2uiLab');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.locator('a[href="#labs/a2ui"]').click();
  const fallback = page.getByRole('region', { name: 'A2UI 实验暂时无法打开' });
  await expect(fallback).toBeVisible();
  expect(failure.requests()).toBeGreaterThan(0);
  await failure.restore();
  await fallback.getByRole('button', { name: '重试加载', exact: true }).click();
  await page.getByRole('button', { name: '生成 A2UI 界面', exact: true }).click();
  await expect(page.getByLabel('出行人姓名', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
