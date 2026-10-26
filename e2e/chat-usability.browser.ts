import { expect, test, type Locator, type Page } from '@playwright/test';
import { observeStaticRequests } from './static-requests';

const pages = process.env.PLAYWRIGHT_LAB_MODE === 'pages';
type ChatRequestRecord = { path: string; body?: Record<string, unknown> };
interface ChatUsabilityProbe {
  requests: ChatRequestRecord[];
  waiting: boolean;
  arm: () => void;
  release: () => void;
  wrap: (send: typeof fetch) => typeof fetch;
}
declare global {
  interface Window {
    __chatUsabilityProbe: ChatUsabilityProbe;
  }
}

// Hold the real route response so that both transports can exercise edits made
// while validation is pending. Pages deliberately bypasses network fetch.
function installChatProbe() {
  let armed = false;
  const probe: ChatUsabilityProbe = {
    requests: [],
    waiting: false,
    arm() {
      armed = true;
    },
    release() {},
    wrap: (send) => async (input, options) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href)
        .pathname;
      if (!['/api/chat', '/api/agui', '/api/a2ui/surface', '/api/a2ui/action'].includes(path))
        return send(input, options);
      probe.requests.push({
        path,
        body: typeof options?.body === 'string' ? JSON.parse(options.body) : undefined,
      });
      const hold = path === '/api/chat' && armed;
      if (hold) armed = false;
      const response = await send(input, options);
      if (!hold) return response;
      probe.waiting = true;
      return new Promise<Response>((resolve, reject) => {
        const signal = options?.signal;
        const abort = () => {
          probe.waiting = false;
          signal?.removeEventListener('abort', abort);
          reject(signal?.reason);
        };
        probe.release = () => {
          probe.waiting = false;
          signal?.removeEventListener('abort', abort);
          resolve(response);
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
  };
  window.__chatUsabilityProbe = probe;
  window.fetch = probe.wrap(window.fetch.bind(window));
}

async function observeChat(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const verifyStatic = pages ? observeStaticRequests(page) : () => {};
  await page.addInitScript(installChatProbe);
  if (pages) {
    await page.route(/\/assets\/static-api-[^/?]+\.js(?:\?|$)/u, async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const exported = /export\s*\{\s*([\w$]+)\s+as\s+staticFetch\s*\};?\s*$/u;
      expect(source).toMatch(exported);
      await route.fulfill({
        response,
        body: source.replace(
          exported,
          `const __chatUsabilityFetch = window.__chatUsabilityProbe.wrap($1);
          export { __chatUsabilityFetch as staticFetch };`,
        ),
      });
    });
  }
  return {
    requests: () => page.evaluate(() => window.__chatUsabilityProbe.requests),
    verify() {
      expect(errors).toEqual([]);
      verifyStatic();
    },
  };
}

async function send(page: Page, prompt: string) {
  await page.getByRole('textbox', { name: '发送消息给 Agent' }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}

async function aguiInput(page: Page, reply: Locator) {
  await reply.getByRole('button', { name: '查看本轮 AG-UI 协议', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '协议检查器', exact: true });
  await inspector.getByRole('button', { name: /POST \/api\/agui/u }).click();
  return JSON.parse(await inspector.locator('.payload').innerText()) as {
    messages: { id: string; role: string; content: string }[];
    forwardedProps: { city: string; days: number };
  };
}

test('chat rejects complete invalid durations, edits the original message and inherits only accepted context', async ({
  page,
}) => {
  const observed = await observeChat(page);
  await page.goto('./#chat');
  await send(page, '生成成都七日游表单');
  const forms = page.getByRole('article', { name: 'A2UI Agent 回复', exact: true });
  await expect(forms.first().getByLabel('行程天数', { exact: true })).toHaveValue('7');
  const composer = page.getByRole('textbox', { name: '发送消息给 Agent' });
  const userMessages = page.getByRole('article', { name: '你的消息', exact: true });
  const failed = userMessages.last();
  const invalidPrompts: string[] = [];
  for (const duration of [
    '12天',
    '十一日',
    '8天',
    '0天',
    '-2天',
    '负三日',
    '1.5天',
    '两点五日',
    '两天或三天',
  ]) {
    const prompt = `2人预算3000元，生成上海${duration}的表单`;
    invalidPrompts.push(prompt);
    await send(page, prompt);
    await expect(failed.getByRole('alert')).toContainText(
      duration === '两天或三天' ? '多个不同的行程天数' : '行程天数仅支持 1–7 天的整数',
    );
    await expect(composer).toHaveValue(prompt);
    await expect(userMessages).toHaveCount(2);
    await expect(forms).toHaveCount(1);
    await expect(page.locator('.chat-topbar')).toContainText('成都 · 7 天');
  }
  await failed.getByRole('button', { name: '修改这条消息', exact: true }).click();
  await expect(composer).toBeFocused();
  const corrected = '2人预算3600元，规划两日游';
  await composer.fill(corrected);
  await composer.press('Enter');
  const reply = page.getByRole('article', { name: 'AG-UI Agent 回复', exact: true });
  await expect(reply.getByRole('status')).toContainText('已完成');
  await expect(reply.locator('.chat-itinerary > div')).toHaveCount(2);
  await expect(userMessages).toHaveCount(2);
  await expect(failed.getByRole('alert')).toHaveCount(0);
  await expect(composer).toHaveValue('');
  const input = await aguiInput(page, reply);
  expect(input.forwardedProps).toMatchObject({ city: '成都', days: 2 });
  expect(input.messages.filter((message) => message.content === corrected)).toHaveLength(1);
  expect(input.messages.some((message) => invalidPrompts.includes(message.content))).toBe(false);

  await send(page, '2人预算4000元，再生成一个表单');
  await expect(forms).toHaveCount(2);
  await expect(forms.last().getByLabel('行程天数', { exact: true })).toHaveValue('2');
  await expect(forms.last().getByRole('combobox', { name: '目的地', exact: true })).toHaveValue(
    'chengdu',
  );
  expect(
    (await observed.requests()).filter((request) => request.path === '/api/agui'),
  ).toHaveLength(1);
  observed.verify();
});

test('chat accepts numeric and Chinese boundary durations alongside budget and party size', async ({
  page,
}) => {
  const observed = await observeChat(page);
  await page.goto('./#chat');
  await send(page, '预算5000元，2人，生成上海7天的表单');
  const forms = page.getByRole('article', { name: 'A2UI Agent 回复', exact: true });
  await expect(forms.first().getByLabel('行程天数', { exact: true })).toHaveValue('7');
  await send(page, '再生成一个七日游表单');
  await expect(forms).toHaveCount(2);
  await expect(forms.last().getByLabel('行程天数', { exact: true })).toHaveValue('7');
  await send(page, '2人预算3000元，规划一天，也就是1日游');
  const reply = page.getByRole('article', { name: 'AG-UI Agent 回复', exact: true });
  await expect(reply.getByRole('status')).toContainText('已完成');
  await expect(reply.locator('.chat-itinerary > div')).toHaveCount(1);
  expect((await aguiInput(page, reply)).forwardedProps).toMatchObject({ city: '上海', days: 1 });
  observed.verify();
});

for (const draft of ['等待期间的新草稿', '']) {
  test(`chat validation preserves a deliberately edited next draft (${draft || 'empty'}) and supports explicit correction`, async ({
    page,
  }) => {
    const observed = await observeChat(page);
    await page.goto('./#chat');
    await page.evaluate(() => window.__chatUsabilityProbe.arm());
    const original = '生成上海12天的表单';
    const composer = page.getByRole('textbox', { name: '发送消息给 Agent' });
    await send(page, original);
    try {
      await expect.poll(() => page.evaluate(() => window.__chatUsabilityProbe.waiting)).toBe(true);
      await composer.fill('等待期间编辑');
      await composer.fill(draft);
    } finally {
      await page.evaluate(() => window.__chatUsabilityProbe.release());
    }
    const failed = page.getByRole('article', { name: '你的消息', exact: true });
    await expect(failed.getByRole('alert')).toContainText('行程天数仅支持 1–7 天的整数');
    await expect(composer).toHaveValue(draft);
    await failed.getByRole('button', { name: '重试这条消息', exact: true }).click();
    await expect(failed.getByRole('alert')).toContainText('行程天数仅支持 1–7 天的整数');
    await expect(failed).toHaveCount(1);
    await expect(composer).toHaveValue(draft);
    await failed.getByRole('button', { name: '修改这条消息', exact: true }).click();
    await expect(composer).toHaveValue(original);
    await expect(composer).toBeFocused();
    const corrected = '规划上海两日游';
    await composer.fill(corrected);
    await failed.getByRole('button', { name: '重试这条消息', exact: true }).click();
    await expect(failed.getByRole('alert')).toContainText('行程天数仅支持 1–7 天的整数');
    await expect(composer).toHaveValue(corrected);
    await composer.press('Enter');
    const reply = page.getByRole('article', { name: 'AG-UI Agent 回复', exact: true });
    await expect(reply.getByRole('status')).toContainText('已完成');
    await expect(failed).toHaveCount(1);
    const input = await aguiInput(page, reply);
    expect(input.messages.filter((message) => message.content === corrected)).toHaveLength(1);
    expect(input.messages.some((message) => message.content === original)).toBe(false);
    observed.verify();
  });
}

async function openChatDestination(page: Page, name: string, position: number) {
  const toggle = page.getByRole('button', { name: '打开聊天导航', exact: true });
  await toggle.focus();
  await toggle.press('Enter');
  const navigation = page.getByRole('navigation', { name: '聊天导航', exact: true });
  await expect(navigation).toBeVisible();
  for (let step = 0; step < position; step += 1) await page.keyboard.press('Tab');
  await expect(navigation.getByRole('link', { name, exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(navigation).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '发送消息给 Agent' })).toHaveCount(0);
  expect(
    await page.locator('#chat-prompt').evaluate((node) => {
      (node as HTMLTextAreaElement).focus();
      return document.activeElement === node;
    }),
  ).toBe(false);
}

async function returnFromLabs(page: Page) {
  await page.getByRole('button', { name: '打开导航', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '返回 Agent 对话', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '打开聊天导航', exact: true })).toBeFocused();
}

test('phone chat navigation supports the keyboard and retains completed form, App and composer state', async ({
  page,
}) => {
  const observed = await observeChat(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('./#chat');
  const toggle = page.getByRole('button', { name: '打开聊天导航', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('navigation', { name: '聊天导航', exact: true })).toHaveCount(0);
  await toggle.focus();
  await toggle.press('Enter');
  const navigation = page.getByRole('navigation', { name: '聊天导航', exact: true });
  await expect(navigation.getByRole('link')).toHaveCount(3);
  for (const link of await navigation.getByRole('link').all()) {
    const bounds = await link.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Tab');
  await expect(
    navigation.getByRole('link', { name: '独立实验与源码导读', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(navigation.getByRole('link', { name: '实践路线', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(navigation.getByRole('link', { name: '学习文档', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(navigation).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await send(page, '生成杭州两日游表单');
  const form = page.getByRole('article', { name: 'A2UI Agent 回复', exact: true });
  await form.getByLabel('出行人姓名', { exact: true }).fill('手机学习者');
  await form.getByLabel('行程天数', { exact: true }).fill('4');
  await form.getByRole('combobox', { name: '目的地', exact: true }).selectOption('chengdu');
  await form.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(form.locator('[data-a2ui-component-id="status"]')).toContainText(
    '已为 手机学习者 生成 成都 4 天游览计划',
  );
  await send(page, '打开这个城市的活动应用');
  const reply = page.getByRole('article', { name: 'MCP Apps Agent 回复', exact: true });
  await expect(reply.getByRole('status')).toContainText('App 与宿主已连接');
  const app = reply.frameLocator('iframe');
  await app.getByRole('button', { name: '上海', exact: true }).click();
  await expect(app.getByText('外滩建筑散步', { exact: true })).toBeVisible();
  const originalFrame = await reply.locator('iframe').elementHandle();
  const frame = await originalFrame!.contentFrame();
  const originalDocument = await frame!.evaluateHandle(() => document);
  const composer = page.getByRole('textbox', { name: '发送消息给 Agent' });
  await composer.fill('手机尚未发送的下一轮');
  const before = await observed.requests();

  await openChatDestination(page, '独立实验与源码导读', 1);
  await expect(page).toHaveURL(/#overview$/u);
  await expect(
    page.getByRole('heading', { name: '让 AI 不止于对话。', exact: true }),
  ).toBeVisible();
  await returnFromLabs(page);
  await openChatDestination(page, '实践路线', 2);
  await expect(page).toHaveURL(/#roadmap$/u);
  await expect(page.getByRole('heading', { name: '从会看，到会做。', exact: true })).toBeVisible();
  await returnFromLabs(page);
  await openChatDestination(page, '学习文档', 3);
  await expect(page).toHaveURL(/#docs\/map$/u);
  const reader = page.getByRole('region', { name: '学习文档', exact: true });
  await expect(reader).toBeVisible();
  await reader.getByRole('link', { name: '返回 Agent 对话', exact: true }).first().press('Enter');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(composer).toHaveValue('手机尚未发送的下一轮');
  await expect(form.getByLabel('出行人姓名', { exact: true })).toHaveValue('手机学习者');
  await expect(form.getByLabel('行程天数', { exact: true })).toHaveValue('4');
  await expect(form.getByRole('combobox', { name: '目的地', exact: true })).toHaveValue('chengdu');
  await expect(form.locator('[data-a2ui-component-id="status"]')).toContainText(
    '已为 手机学习者 生成 成都 4 天游览计划',
  );
  await expect(app.getByRole('button', { name: '上海', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(app.getByText('外滩建筑散步', { exact: true })).toBeVisible();
  expect(
    await reply.locator('iframe').evaluate((node, original) => node === original, originalFrame),
  ).toBe(true);
  expect(await frame!.evaluate((original) => document === original, originalDocument)).toBe(true);
  expect(await observed.requests()).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await originalDocument.dispose();
  await originalFrame!.dispose();
  observed.verify();
});

test('chat navigation has phone touch targets through 780px and resets when returning to desktop', async ({
  page,
}) => {
  const observed = await observeChat(page);
  await page.setViewportSize({ width: 780, height: 812 });
  await page.goto('./#chat');
  for (const width of [780, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    for (const name of ['打开聊天导航', '新对话', '切换深色模式', '打开协议面板']) {
      const bounds = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
  await page.getByRole('button', { name: '打开聊天导航', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '聊天导航', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 781, height: 812 });
  await expect(page.getByRole('button', { name: /聊天导航/u })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '聊天导航', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 780, height: 812 });
  await expect(page.getByRole('button', { name: '打开聊天导航', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  observed.verify();
});
