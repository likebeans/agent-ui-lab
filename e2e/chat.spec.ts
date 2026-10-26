import { expect, test, type Page } from '@playwright/test';

async function send(page: Page, prompt: string) {
  await page.getByRole('textbox', { name: '发送消息给 Agent' }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}

test('one conversation moves from streamed events to generated components to a tool application', async ({
  page,
}) => {
  const errors: string[] = [];
  const requests: { url: string; body: any }[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(api\/agui|api\/a2ui\/surface|mcp)$/.test(request.url()))
      requests.push({ url: request.url(), body: request.postDataJSON() });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '聊一聊，让界面自然发生。' })).toBeVisible();
  await page.screenshot({ path: 'test-results/chat-welcome.png' });
  await send(page, '帮我规划杭州三日游，喜欢慢节奏');
  const stream = page.getByRole('article', { name: 'AG-UI Agent 回复' });
  await expect(stream.getByRole('status')).toContainText('已完成');
  await expect(stream.locator('.chat-itinerary > div')).toHaveCount(3);
  await stream.getByText('事件如何变成这条回复', { exact: false }).click();
  await expect(stream.getByText('TEXT_MESSAGE_CONTENT', { exact: true }).first()).toBeVisible();
  await send(page, '把这些出行需求做成一个表单');
  const form = page.getByRole('article', { name: 'A2UI Agent 回复' });
  await expect(form.getByRole('combobox', { name: '目的地', exact: true })).toHaveValue('hangzhou');
  await expect(form.getByLabel('行程天数', { exact: true })).toHaveValue('3');
  await form.getByText('声明如何变成 React 组件', { exact: false }).click();
  await form.getByRole('button', { name: /^定位声明 destination：/ }).click();
  await expect(form.locator('[data-a2ui-component-id="destination"]')).toHaveAttribute(
    'aria-current',
    'true',
  );
  await form.getByText('声明如何变成 React 组件', { exact: false }).click();
  await form.getByLabel('出行人姓名').fill('学习者');
  await form.getByRole('combobox', { name: '目的地', exact: true }).selectOption('chengdu');
  await form.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(form.locator('[data-a2ui-component-id="status"]')).toContainText(
    '已为 学习者 生成 成都 3 天游览计划',
  );
  await expect(page.locator('.interaction-message')).toHaveCount(2);
  await send(page, '打开这个城市的活动应用');
  const app = page.getByRole('article', { name: 'MCP Apps Agent 回复' });
  await expect(app.getByRole('status')).toContainText('App 与宿主已连接');
  const frame = app.frameLocator('iframe');
  await expect(frame.getByText('人民公园早茶', { exact: true })).toBeVisible();
  await frame.getByRole('button', { name: '上海', exact: true }).click();
  await expect(frame.getByText('外滩建筑散步', { exact: true })).toBeVisible();
  await expect(page.locator('.interaction-message')).toHaveCount(4);
  await expect(stream).toBeAttached();
  await expect(form).toBeAttached();
  await app.getByRole('button', { name: '查看本轮 MCP Apps 协议' }).click();
  await expect(page.getByRole('complementary', { name: '协议检查器' })).toBeVisible();
  const aguiInput = requests.find((request) => request.url.endsWith('/api/agui'))!.body;
  expect(aguiInput.messages.at(-1).content).toContain('杭州三日游');
  expect(
    requests.some(
      (request) =>
        request.body.method === 'tools/call' && request.body.params.arguments.city === 'chengdu',
    ),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/chat-mcp.png' });
  await page.getByRole('button', { name: '切换深色模式' }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/chat-dark.png' });

  await form.getByLabel('行程天数', { exact: true }).fill('4');
  await form.getByRole('button', { name: '重新生成计划', exact: true }).click();
  await expect(page.locator('.interaction-message')).toHaveCount(6);
  await frame.getByRole('button', { name: '杭州', exact: true }).click();
  await expect(page.locator('.interaction-message')).toHaveCount(8);
  await send(page, '按照现在的需求，再规划一次');
  const replies = page.getByRole('article', { name: 'AG-UI Agent 回复' });
  await expect(replies).toHaveCount(2);
  const nextPlan = replies.nth(1);
  await expect(nextPlan.locator('.chat-run-status')).toContainText('已完成');
  await expect(nextPlan.locator('.chat-itinerary > div')).toHaveCount(4);
  const followupInput = requests
    .filter((request) => request.url.endsWith('/api/agui'))
    .at(-1)!.body;
  expect(followupInput.threadId).toBe(aguiInput.threadId);
  expect(followupInput.runId).not.toBe(aguiInput.runId);
  expect(followupInput.forwardedProps).toMatchObject({ city: '杭州', days: 4 });
  expect(
    followupInput.messages.some((message: { content: string }) =>
      message.content.includes('学习者'),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('chat recovers from a failed surface and a truncated stream, and discards an abandoned route', async ({
  page,
}) => {
  await page.goto('/');
  await page.route(
    '**/api/a2ui/surface',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '表单服务暂不可用' }),
      }),
    { times: 1 },
  );
  await send(page, '生成上海两日游表单');
  await expect(page.getByRole('alert')).toContainText('表单服务暂不可用');
  await send(page, '再生成一个表单');
  const form = page.getByRole('article', { name: 'A2UI Agent 回复' }).last();
  await expect(form.getByRole('combobox', { name: '目的地', exact: true })).toHaveValue('shanghai');

  await page.route(
    '**/api/agui',
    (route) => {
      const input = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId })}\n\n`,
      });
    },
    { times: 1 },
  );
  await send(page, '规划上海两日游');
  const reply = page.getByRole('article', { name: 'AG-UI Agent 回复' });
  await expect(reply.getByRole('status')).toContainText('连接已中断');
  await reply.getByRole('button', { name: '重试这一轮' }).click();
  await expect(reply.getByRole('status')).toContainText('已完成');
  await expect(reply.locator('.chat-itinerary > div')).toHaveCount(2);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(
    '**/api/chat',
    async (route) => {
      started();
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          protocol: 'agui',
          context: { city: '成都', days: 7 },
          explanation: '迟到的旧请求',
        }),
      });
    },
    { times: 1 },
  );
  await send(page, '规划成都七日游');
  await intercepted;
  await page.getByRole('button', { name: '新对话', exact: false }).click();
  release();
  await send(page, '生成一个表单');
  const freshForm = page.getByRole('article', { name: 'A2UI Agent 回复' });
  await expect(freshForm.getByRole('combobox', { name: '目的地', exact: true })).toHaveValue(
    'hangzhou',
  );
  await expect(freshForm.getByLabel('行程天数', { exact: true })).toHaveValue('3');
  await expect(page.getByRole('article', { name: 'AG-UI Agent 回复' })).toHaveCount(0);
});

for (const { days, prompt } of [
  { days: '4', prompt: '再生成一个表单' },
  { days: '3', prompt: '生成上海七日游表单' },
]) {
  test(`a delayed route preserves a successful form submission of ${days} days`, async ({
    page,
  }) => {
    await page.goto('/');
    await send(page, '生成杭州三日游表单');
    const forms = page.getByRole('article', { name: 'A2UI Agent 回复', exact: true });
    const form = forms.first();
    await expect(form.getByLabel('行程天数', { exact: true })).toHaveValue('3');
    await form.getByLabel('出行人姓名', { exact: true }).fill('并发学习者');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const intercepted = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route(
      '**/api/chat',
      async (route) => {
        const response = await route.fetch();
        started();
        await held;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    try {
      await send(page, prompt);
      await intercepted;
      await form.getByLabel('行程天数', { exact: true }).fill(days);
      await form.getByRole('button', { name: '生成计划', exact: true }).click();
      await expect(form.locator('[data-a2ui-component-id="status"]')).toContainText(
        `杭州 ${days} 天游览计划`,
      );
    } finally {
      release();
    }

    await expect(forms).toHaveCount(2);
    const nextForm = forms.nth(1);
    await expect(nextForm.getByLabel('行程天数', { exact: true })).toHaveValue(days);
    await expect(nextForm.getByRole('combobox', { name: '目的地', exact: true })).toHaveValue(
      'hangzhou',
    );
    await expect(page.locator('.chat-topbar')).toContainText(`${days} 天`);
    const nextRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/agui',
    );
    await send(page, '按照现在的需求，再规划一次');
    expect((await nextRequest).postDataJSON().forwardedProps).toMatchObject({
      city: '杭州',
      days: Number(days),
    });
  });
}

test('a delayed route keeps new prompt fields alongside a later App city selection', async ({
  page,
}) => {
  await page.goto('/');
  await send(page, '打开杭州的活动应用');
  const app = page.getByRole('article', { name: 'MCP Apps Agent 回复', exact: true });
  await expect(app.locator('.chat-run-status')).toContainText('App 与宿主已连接');

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(
    '**/api/chat',
    async (route) => {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    await send(page, '生成上海七日游表单');
    await intercepted;
    await app.frameLocator('iframe').getByRole('button', { name: '杭州', exact: true }).click();
    await expect(page.locator('.interaction-message')).toHaveCount(2);
  } finally {
    release();
  }

  const form = page.getByRole('article', { name: 'A2UI Agent 回复', exact: true });
  await expect(form.getByRole('combobox', { name: '目的地', exact: true })).toHaveValue('hangzhou');
  await expect(form.getByLabel('行程天数', { exact: true })).toHaveValue('7');
  await expect(page.locator('.chat-topbar')).toContainText('7 天');
});

for (const failure of ['service', 'timeout'] as const) {
  for (const draft of ['等待期间的新草稿', ''] as const) {
    test(`a ${failure} route failure preserves the next draft (${draft || 'empty'}) and retries the failed message`, async ({
      page,
    }) => {
      if (failure === 'timeout') {
        await page.addInitScript(() => {
          const schedule = window.setTimeout;
          window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
            schedule(handler, delay === 8000 ? 700 : delay, ...args)) as typeof window.setTimeout;
        });
      }
      await page.goto('./#chat');
      let intercepted!: () => void;
      const waiting = new Promise<void>((resolve) => {
        intercepted = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let attempts = 0;
      await page.route('**/api/chat', async (route) => {
        attempts += 1;
        if (attempts > 1) return route.continue();
        intercepted();
        await held;
        await route.fulfill({ status: 503, json: { error: '路由服务暂不可用' } });
      });
      const original = '帮我规划杭州三日游';
      const composer = page.getByRole('textbox', { name: '发送消息给 Agent' });
      await send(page, original);
      await waiting;
      // Also exercise editing and then deliberately clearing the next draft.
      await composer.fill('等待期间编辑');
      await composer.fill(draft);
      if (failure === 'service') release();
      const failed = page.getByRole('article', { name: '你的消息', exact: true });
      try {
        await expect(failed.getByRole('alert')).toContainText(
          failure === 'service' ? '路由服务暂不可用' : '请求超时',
        );
        await expect(composer).toHaveValue(draft);
        await expect(failed).toContainText(original);
        expect(attempts).toBe(1);
        const submitted = page.waitForRequest(
          (request) => new URL(request.url()).pathname === '/api/agui',
        );
        await failed.getByRole('button', { name: '重试这条消息', exact: true }).click();
        const run = (await submitted).postDataJSON();
        expect(
          run.messages.filter((message: { content: string }) => message.content === original),
        ).toHaveLength(1);
        await expect(
          page.getByRole('article', { name: 'AG-UI Agent 回复' }).getByRole('status'),
        ).toContainText('已完成');
        await expect(composer).toHaveValue(draft);
        await expect(failed).toHaveCount(1);
        await expect(failed.getByRole('alert')).toHaveCount(0);
        expect(attempts).toBe(2);
      } finally {
        release();
      }
    });
  }
}

test('mobile chat supports Enter submission, cancellation, inspection and a fresh thread', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByRole('textbox', { name: '发送消息给 Agent' }).fill('上海两日游');
  await page.getByRole('textbox', { name: '发送消息给 Agent' }).press('Enter');
  const reply = page.getByRole('article', { name: 'AG-UI Agent 回复' });
  await reply.getByRole('button', { name: '取消运行', exact: true }).click();
  await expect(reply.getByRole('status')).toContainText('已取消');
  await reply.getByRole('button', { name: '查看本轮 AG-UI 协议' }).click();
  await expect(page.getByRole('dialog', { name: '本轮协议详情' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.screenshot({ path: 'test-results/chat-mobile.png' });
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(page.getByRole('article', { name: 'AG-UI Agent 回复' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '发送消息给 Agent' })).toBeFocused();
});
