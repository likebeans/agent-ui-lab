import { expect, test, type Page } from '@playwright/test';

function observeStaticRequests(page: Page) {
  const errors: string[] = [];
  const apiRequests: string[] = [];
  const assetFailures: string[] = [];
  const rootAssets: string[] = [];
  const base = process.env.PAGES_TEST_PATH ?? '/pages-test/';
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol !== 'http:') return;
    if (/\/(?:api(?:\/|$)|mcp$)/u.test(url.pathname)) apiRequests.push(url.pathname);
    if (!url.pathname.startsWith(base)) rootAssets.push(url.pathname);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) assetFailures.push(`${response.status()} ${response.url()}`);
  });
  return () => {
    expect(errors).toEqual([]);
    expect(apiRequests).toEqual([]);
    expect(assetFailures).toEqual([]);
    expect(rootAssets).toEqual([]);
  };
}

async function send(page: Page, prompt: string) {
  await page.getByRole('textbox', { name: '发送消息给 Agent' }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}

test('Pages runs the three chat protocols, learning experiments and documents entirely in the browser', async ({
  page,
}) => {
  const verify = observeStaticRequests(page);
  await page.goto('./');
  await expect(page.getByRole('complementary', { name: '当前运行模式' })).toContainText(
    '静态学习版',
  );
  await expect(page.locator('.connection-state')).toHaveText('浏览器内运行');
  await send(page, '帮我规划杭州三日游');
  const stream = page.getByRole('article', { name: 'AG-UI Agent 回复', exact: true });
  await expect(stream.getByRole('status')).toContainText('已完成');
  await expect(stream.locator('.chat-itinerary > div')).toHaveCount(3);
  await stream.getByRole('button', { name: '追溯文字更新', exact: true }).click();
  const playback = stream.getByLabel('AG-UI 事件回放学习');
  await expect(playback).toContainText('没有网络 SSE');
  const prediction = playback.getByRole('region', {
    name: '文本增量是追加还是替换？',
    exact: true,
  });
  await prediction.getByLabel('追加到原有文字后面', { exact: true }).check();
  await prediction.getByRole('button', { name: '用本轮事件验证', exact: true }).click();
  await expect(prediction.getByRole('status')).toContainText('预测与实际结果一致');
  await playback.getByRole('button', { name: '在检查器中定位 TEXT_MESSAGE_CONTENT' }).click();
  await expect(page.locator('.inspector-note')).toContainText('逻辑路由标签不表示 HTTP 请求');
  await expect(page.locator('.trace-list')).toContainText('browser-agent→client');

  await send(page, '生成带预算的旅行表单');
  const form = page.getByRole('article', { name: 'A2UI Agent 回复', exact: true });
  await expect(form.getByLabel('行程天数', { exact: true })).toHaveValue('3');
  await form.getByRole('combobox', { name: '目的地', exact: true }).selectOption('chengdu');
  await form.getByLabel('出行人姓名', { exact: true }).fill('Pages 学习者');
  await form.getByLabel('预算（元）', { exact: true }).fill('4200');
  await form.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(form.locator('[data-a2ui-component-id="status"]')).toContainText(
    '成都 3 天游览计划',
  );
  await expect(form.locator('[data-a2ui-component-id="status"]')).toContainText('预算 4200 元');
  await form.getByText('A2UI Workshop：改声明，观察同一个 renderer', { exact: true }).click();
  await expect(form.getByLabel('预算字段练习验证')).toContainText(
    '浏览器内 action 处理器收到同一预算值',
  );

  await send(page, '打开这个城市的活动应用');
  const app = page.getByRole('article', { name: 'MCP Apps Agent 回复', exact: true });
  await expect(app.locator('.chat-run-status')).toContainText('App 与宿主已连接');
  const frame = app.frameLocator('iframe');
  await expect(frame.getByText('人民公园早茶', { exact: true })).toBeVisible();
  await expect(app.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await frame.getByRole('button', { name: '上海', exact: true }).click();
  await expect(frame.getByText('外滩建筑散步', { exact: true })).toBeVisible();
  await app.getByText('动手验证 MCP Apps 因果链', { exact: false }).click();
  await app.getByRole('button', { name: '定位实际 tools/list 记录' }).click();
  await expect(page.locator('.payload')).toContainText('ui://intelligent-ui/trip-picker');
  await expect(page.locator('.inspector-note')).toContainText('InMemoryTransport');

  const oldFrame = await app.locator('iframe').elementHandle();
  await app.getByLabel('实验 A 的工具输入城市', { exact: true }).selectOption('hangzhou');
  const toolLesson = app.getByRole('region', { name: '工具结果与 UI 资源是否绑定重读' });
  await toolLesson.getByLabel('不需要；原 App 可以接收新的真实工具结果', { exact: true }).check();
  await toolLesson.getByRole('button', { name: '调用工具并切换到杭州' }).click();
  await expect(toolLesson.getByRole('status')).toContainText('预测与实际结果一致');
  await expect(frame.getByText('西湖清晨步道', { exact: true })).toBeVisible();
  expect(await oldFrame!.evaluate((element) => element.isConnected)).toBe(true);
  await app.getByRole('button', { name: '读取所选资源并重载 App' }).click();
  await expect(app.locator('.mcp-experiment-evidence')).toContainText('Host 资源实验已完成');
  await expect(frame.locator('#app')).toHaveAttribute('data-layout', 'list');
  await expect(frame.getByText('西湖清晨步道', { exact: true })).toBeVisible();
  expect(await oldFrame!.evaluate((element) => element.isConnected)).toBe(false);
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('link', { name: '打开学习文档', exact: true }).click();
  await expect(page.getByRole('article', { name: '学习地图', exact: true })).toBeVisible();
  await page.goto('./#docs/project');
  const readme = page.getByRole('article', { name: '项目说明', exact: true });
  await expect(readme).toBeVisible();
  const image = readme.getByRole('img').first();
  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  const base = process.env.PAGES_TEST_PATH ?? '/pages-test/';
  await expect(image).toHaveAttribute('src', `${base}readme/screenshots/agent-chat.png`);
  await page.reload();
  await expect(readme).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Agent UI Lab');
  verify();
});

test('Pages independent labs preserve cancellation, failure, truncation and Surface deletion semantics', async ({
  page,
}) => {
  const verify = observeStaticRequests(page);
  await page.goto('./#agui');
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await page.getByRole('button', { name: '协议取消', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('协议已取消');
  await page.getByRole('button', { name: /RUN_FINISHED.*browser-agent→client/ }).click();
  await expect(page.locator('.payload')).toContainText('cancelled');
  await page.getByRole('button', { name: /POST \/api\/agui\/.*\/cancel/ }).click();
  await expect(page.locator('.inspector-note')).toContainText('本地流继续接收');
  await expect(page.locator('.inspector-note')).not.toContainText('SSE 保持连接');
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await page.getByRole('button', { name: '中断本地流', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('本地流已截断');
  await page.getByRole('button', { name: /AbortController\.abort\(\)/ }).click();
  await expect(page.locator('.inspector-note')).toContainText('仅中断浏览器内的本地流');
  await expect(page.locator('.inspector-note')).not.toContainText('断开 HTTP');
  await page.getByLabel('运行场景').selectOption('error');
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Agent 报错');
  await expect(page.locator('.payload')).toContainText('FIXTURE_UNAVAILABLE');
  await page.getByLabel('运行场景').selectOption('success');
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('运行成功');

  await page.goto('./#a2ui');
  await page.getByRole('button', { name: '生成 A2UI 界面' }).click();
  await page.getByLabel('出行人姓名', { exact: true }).fill('静态版');
  await page.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新生成计划', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除 Surface 并重置' }).click();
  await expect(page.getByRole('heading', { name: '尚未创建 Surface' })).toBeVisible();
  await expect(page.locator('.payload')).toContainText('deleteSurface');

  await page.goto('./#mcp');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.getByRole('button', { name: '打开 MCP App' }).click();
    await expect(page.getByRole('status')).toHaveText('App 与宿主已连接');
    await page.getByRole('button', { name: '关闭 App', exact: true }).click();
  }
  verify();
});

test('Pages phone layout keeps mode disclosure, live App and chapter links usable', async ({
  page,
}) => {
  const verify = observeStaticRequests(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./');
  await expect(page.getByRole('complementary', { name: '当前运行模式' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开协议面板', exact: true })).toBeVisible();
  await send(page, '打开上海的活动应用');
  const app = page.getByRole('article', { name: 'MCP Apps Agent 回复', exact: true });
  await expect(app.locator('.chat-run-status')).toContainText('App 与宿主已连接');
  await app.locator('iframe').scrollIntoViewIfNeeded();
  const frame = app.frameLocator('iframe');
  await frame.getByRole('button', { name: '成都', exact: true }).click();
  await expect(frame.getByText('人民公园早茶', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.screenshot({ path: 'test-results/pages-mobile.png' });
  await page.getByRole('link', { name: '打开学习文档', exact: true }).click();
  await page.getByText('全部章节', { exact: true }).click();
  await page
    .getByRole('navigation', { name: '学习章节' })
    .getByRole('link', { name: /真实开发路径/ })
    .click();
  await expect(page.getByRole('article', { name: '真实开发路径', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.screenshot({ path: 'test-results/pages-mobile-docs.png' });
  verify();
});
