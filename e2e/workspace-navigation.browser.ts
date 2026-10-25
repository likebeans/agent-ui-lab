import { expect, test, type Page } from '@playwright/test';
import { observeStaticRequests } from './static-requests';

const pages = process.env.PLAYWRIGHT_LAB_MODE === 'pages';

async function send(page: Page, prompt: string) {
  await page.getByRole('textbox', { name: '发送消息给 Agent' }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}

function watch(page: Page) {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(chat|agui|a2ui\/surface|a2ui\/action)$/.test(path))
      requests.push(`${request.method()} ${path}`);
    if (path === '/mcp' && request.method() === 'POST') {
      const method = request.postDataJSON().method;
      if (method === 'resources/read' || method === 'tools/call') requests.push(method);
    }
  });
  const verifyStatic = pages ? observeStaticRequests(page) : () => {};
  return {
    requests,
    verify() {
      expect(errors).toEqual([]);
      verifyStatic();
    },
  };
}

async function openOverview(page: Page) {
  await page.getByRole('link', { name: '独立实验与源码导读', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '让 AI 不止于对话。', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: '发送消息给 Agent' })).toHaveCount(0);
}

async function returnToChat(page: Page) {
  await page.getByRole('link', { name: '返回 Agent 对话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '发送消息给 Agent' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主要导航', exact: true })).toHaveCount(0);
}

test('workspace navigation preserves chat drafts, learning results and inspector selection', async ({
  page,
}) => {
  const observed = watch(page);
  await page.goto('./#chat');
  await send(page, '生成带预算的杭州三日游表单');
  const form = page.getByRole('article', { name: 'A2UI Agent 回复', exact: true });
  await form.getByLabel('出行人姓名', { exact: true }).fill('导航后继续编辑');
  await form.getByLabel('预算（元）', { exact: true }).fill('4200');
  await form.getByText('A2UI Workshop：改声明，观察同一个 renderer', { exact: true }).click();
  const lesson = form.getByRole('region', { name: '本地绑定会改组件声明吗？', exact: true });
  await lesson.getByLabel('只更新数据模型，组件声明不变', { exact: true }).check();
  await lesson.getByRole('button', { name: '运行本地绑定实验' }).click();
  await expect(lesson.getByRole('status')).toContainText('预测与实际结果一致');
  await lesson.getByRole('button', { name: '定位本次协议记录' }).click();
  const inspector = page.getByRole('complementary', { name: '协议检查器', exact: true });
  await inspector.getByRole('textbox', { name: '筛选协议消息' }).fill('learning/a2ui-binding');
  const payload = await inspector.locator('.payload').innerText();
  const days = await form.getByLabel('行程天数', { exact: true }).inputValue();
  const composer = page.getByRole('textbox', { name: '发送消息给 Agent' });
  await composer.fill('尚未发送的下一轮');
  const before = [...observed.requests];

  await openOverview(page);
  await page.getByRole('link', { name: '学习文档', exact: true }).click();
  const reader = page.getByRole('region', { name: '学习文档', exact: true });
  await expect(reader).toBeVisible();
  await reader.getByRole('link', { name: '返回独立实验', exact: true }).first().click();
  await returnToChat(page);
  await expect(form.getByLabel('出行人姓名', { exact: true })).toHaveValue('导航后继续编辑');
  await expect(form.getByLabel('预算（元）', { exact: true })).toHaveValue('4200');
  await expect(form.getByLabel('行程天数', { exact: true })).toHaveValue(days);
  await expect(lesson.getByRole('status')).toContainText('预测与实际结果一致');
  await expect(composer).toHaveValue('尚未发送的下一轮');
  await expect(inspector.getByRole('textbox', { name: '筛选协议消息' })).toHaveValue(
    'learning/a2ui-binding',
  );
  await expect(inspector.locator('.payload')).toHaveText(payload);
  expect(observed.requests).toEqual(before);

  await page.goBack();
  await expect(
    page.getByRole('heading', { name: '让 AI 不止于对话。', exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(composer).toHaveValue('尚未发送的下一轮');
  await expect(form.getByLabel('出行人姓名', { exact: true })).toHaveValue('导航后继续编辑');
  await page.getByRole('button', { name: /新对话/ }).click();
  await expect(form).toHaveCount(0);
  await expect(composer).toHaveValue('');
  await openOverview(page);
  await returnToChat(page);
  await expect(form).toHaveCount(0);
  observed.verify();
});

test('workspace navigation keeps a live chat run and its thread without replaying requests', async ({
  page,
}) => {
  const observed = watch(page);
  await page.goto('./#chat');
  await send(page, '帮我规划杭州三日游');
  const replies = page.getByRole('article', {
    name: 'AG-UI Agent 回复',
    exact: true,
    includeHidden: true,
  });
  const first = replies.first();
  await expect(first.locator('.chat-run-status')).toContainText('正在生成');
  await openOverview(page);
  await expect(first.locator('.chat-run-status')).toContainText('已完成');
  await returnToChat(page);
  await expect(first.locator('.chat-itinerary > div')).toHaveCount(3);
  const inspector = page.getByRole('complementary', { name: '协议检查器', exact: true });
  await inspector.getByRole('button', { name: /POST \/api\/agui/ }).click();
  const firstInput = JSON.parse(await inspector.locator('.payload').innerText());
  await send(page, '按照现在的需求，再规划一次');
  await expect(replies).toHaveCount(2);
  await expect(replies.nth(1).locator('.chat-run-status')).toContainText('已完成');
  await inspector.getByRole('button', { name: /POST \/api\/agui/ }).click();
  const secondInput = JSON.parse(await inspector.locator('.payload').innerText());
  expect(secondInput.threadId).toBe(firstInput.threadId);
  expect(secondInput.runId).not.toBe(firstInput.runId);
  if (!pages)
    expect(observed.requests.filter((entry) => entry === 'POST /api/agui')).toHaveLength(2);
  observed.verify();
});

test('workspace navigation on a phone preserves both drafts and keeps hidden controls inaccessible', async ({
  page,
}) => {
  const observed = watch(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('./#labs/a2ui-compatibility');
  const lab = page.getByRole('region', { name: 'A2UI 兼容与编辑冲突操作区', exact: true });
  await lab.getByRole('button', { name: '创建表单', exact: true }).click();
  await lab.getByLabel('出行人姓名', { exact: true }).fill('手机独立实验草稿');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await returnToChat(page);
  await send(page, '生成杭州三日游表单');
  const form = page.getByRole('article', { name: 'A2UI Agent 回复', exact: true });
  await form.getByLabel('出行人姓名', { exact: true }).fill('手机聊天草稿');
  const composer = page.getByRole('textbox', { name: '发送消息给 Agent' });
  await composer.fill('手机未发出的消息');
  await page.goBack();
  await expect(lab.getByLabel('出行人姓名', { exact: true })).toHaveValue('手机独立实验草稿');
  await expect(composer).toHaveCount(0);
  await page.getByRole('link', { name: '实验文档', exact: true }).click();
  const reader = page.getByRole('region', { name: '学习文档', exact: true });
  await expect(reader).toBeVisible();
  await reader.getByRole('link', { name: '返回独立实验', exact: true }).first().click();
  await expect(page.getByRole('link', { name: '实验文档', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await returnToChat(page);
  await expect(form.getByLabel('出行人姓名', { exact: true })).toHaveValue('手机聊天草稿');
  await expect(composer).toHaveValue('手机未发出的消息');
  await form.getByRole('button', { name: '查看本轮 A2UI 协议', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '本轮协议详情' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '打开协议面板', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  observed.verify();
});

test('workspace navigation retains the MCP iframe and returns to the same independent lab', async ({
  page,
}) => {
  const observed = watch(page);
  await page.goto('./#chat');
  await send(page, '打开杭州的活动应用');
  const reply = page.getByRole('article', { name: 'MCP Apps Agent 回复', exact: true });
  const app = reply.frameLocator('iframe');
  await app.getByRole('button', { name: '成都', exact: true }).click();
  await expect(app.getByText('人民公园早茶', { exact: true })).toBeVisible();
  const originalFrame = await reply.locator('iframe').elementHandle();
  const frame = await originalFrame!.contentFrame();
  const originalDocument = await frame!.evaluateHandle(() => document);
  const before = [...observed.requests];
  await openOverview(page);
  await page.getByRole('link', { name: 'A2UI 兼容与编辑冲突 05', exact: true }).click();
  const lab = page.getByRole('region', { name: 'A2UI 兼容与编辑冲突操作区', exact: true });
  await lab.getByRole('button', { name: '创建表单', exact: true }).click();
  await lab.getByLabel('出行人姓名', { exact: true }).fill('独立实验草稿');
  const documentId = await lab.getByLabel('文档 ID', { exact: true }).inputValue();
  await returnToChat(page);
  expect(
    await reply
      .locator('iframe')
      .evaluate((element, original) => element === original, originalFrame),
  ).toBe(true);
  expect(await frame!.evaluate((original) => document === original, originalDocument)).toBe(true);
  await expect(app.getByText('人民公园早茶', { exact: true })).toBeVisible();
  expect(observed.requests).toEqual(before);
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goBack();
  await expect(lab.getByLabel('文档 ID', { exact: true })).toHaveValue(documentId);
  await expect(lab.getByLabel('出行人姓名', { exact: true })).toHaveValue('独立实验草稿');
  await expect(page.getByRole('button', { name: '切换浅色模式', exact: true })).toBeVisible();
  await originalDocument.dispose();
  await originalFrame!.dispose();
  observed.verify();
});
