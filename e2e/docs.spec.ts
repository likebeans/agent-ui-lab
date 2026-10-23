import { expect, test, type Page } from '@playwright/test';

async function send(page: Page, prompt: string) {
  await page.getByRole('textbox', { name: '发送消息给 Agent' }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}

function reader(page: Page) {
  return page.getByRole('region', { name: '学习文档', exact: true });
}

function returnLink(page: Page, name = '返回 Agent 对话') {
  return reader(page).locator('header').getByRole('link', { name, exact: true });
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('reader renders Markdown chapters, searches full text and follows links and browser history', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/#chat');
  await page.getByRole('link', { name: '打开学习文档', exact: true }).click();
  await expect(page).toHaveURL(/#docs\/map$/);
  await expect(reader(page).getByRole('heading', { level: 1 })).toContainText('Agent UI 学习地图');
  const chapters = reader(page).getByRole('navigation', { name: '学习章节' });
  await expect(chapters.getByRole('link')).toHaveCount(10);
  const map = reader(page).getByRole('article', { name: '学习地图', exact: true });
  await expect(map.getByRole('table').first()).toContainText('Agent 在执行过程中发生了什么？');

  const relativeLink = map.getByRole('link', { name: 'A2UI：从声明到组件', exact: true });
  await expect(relativeLink).toHaveAttribute('href', '#docs/a2ui');
  await relativeLink.click();
  await expect(page).toHaveURL(/#docs\/a2ui$/);
  const a2ui = reader(page).getByRole('article', { name: 'A2UI：从声明到组件', exact: true });
  await expect(a2ui.locator('pre').first()).toContainText('"version": "v0.9.1"');
  await expect(a2ui.getByRole('table')).toContainText('ChoicePicker');
  const heading = a2ui.getByRole('heading', { name: /^数据绑定为什么能双向工作/ });
  await heading.getByRole('link', { name: '链接到 数据绑定为什么能双向工作' }).click();
  const deepLink = page.url();
  expect(decodeURIComponent(new URL(deepLink).hash)).toBe(
    '#docs/a2ui?section=数据绑定为什么能双向工作',
  );
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await page.reload();
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await page.goBack();
  await expect(page).toHaveURL(/#docs\/a2ui$/);
  await page.goBack();
  await expect(page).toHaveURL(/#docs\/map$/);
  await page.goForward();
  await expect(page).toHaveURL(/#docs\/a2ui$/);
  await expect(a2ui.getByRole('heading', { level: 1 })).toBeVisible();

  const search = reader(page).getByRole('searchbox', { name: '搜索学习文档' });
  await search.fill('postmessagetransport');
  await expect(reader(page).getByRole('status')).toHaveText('找到 1 篇相关文档');
  await reader(page)
    .getByRole('link', { name: /MCP Apps：从工具到应用.*阅读本章/ })
    .click();
  await expect(page).toHaveURL(/#docs\/mcp-apps$/);
  await expect(search).toHaveValue('');
  await expect(reader(page).getByRole('article')).toContainText('PostMessageTransport');
  await search.fill('no-such-chapter-9a62');
  await expect(reader(page).getByRole('status')).toHaveText('找到 0 篇相关文档');
  await expect(reader(page).getByText('试试“预算”“SSE”或“握手”。')).toBeVisible();
  await reader(page).getByRole('button', { name: '清空文档搜索' }).click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(chapters.getByRole('link')).toHaveCount(10);

  const stableCode = await reader(page).locator('pre').first().elementHandle();
  await search.fill('PostMessageTransport');
  await expect.poll(() => stableCode!.evaluate((element) => element.isConnected)).toBe(true);
  await reader(page)
    .getByRole('link', { name: /MCP Apps：从工具到应用.*阅读本章/ })
    .click();
  await expect(search).toHaveValue('');
  await expect(reader(page).getByRole('heading', { level: 1 })).toBeFocused();
  await stableCode!.dispose();

  await chapters.getByRole('link', { name: /项目说明/ }).click();
  const project = reader(page).getByRole('article', { name: '项目说明', exact: true });
  await expect(project.getByRole('heading', { level: 1 })).toContainText('Agent UI Lab');
  await expect(project.locator('pre').first()).toContainText('npm run dev');
  const screenshots = project.getByRole('img');
  await expect(screenshots).toHaveCount(7);
  for (const image of await screenshots.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect(image).toHaveAttribute('src', /^\/readme\/screenshots\/[a-z0-9-]+\.png$/u);
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  }
  await project.getByRole('link', { name: '快速开始', exact: true }).click();
  await expect(page).toHaveURL(/#docs\/project\?section=/);
  await expect(project.getByRole('heading', { name: /^快速开始/ })).toBeFocused();
  await expect(project.getByRole('link', { name: '学习地图', exact: true })).toHaveAttribute(
    'href',
    '#docs/map',
  );
  await project.getByRole('link', { name: '学习地图', exact: true }).click();
  await expect(page).toHaveURL(/#docs\/map$/);

  for (const hash of ['#docs/does-not-exist', '#docs/%E0%A4%A?section=%ZZ']) {
    await page.goto(`/${hash}`);
    await expect(reader(page).getByRole('heading', { name: '未找到这个章节' })).toBeVisible();
    await reader(page).getByRole('link', { name: '打开学习地图', exact: true }).click();
    await expect(page).toHaveURL(/#docs\/map$/);
    await expect(map).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('A2UI tutorial roundtrip preserves edited values, learning results and the selected trace', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(chat|a2ui\/surface|a2ui\/action)$/.test(new URL(request.url()).pathname)) {
      requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  await page.goto('/#chat');
  await send(page, '生成带预算和同行人数的杭州出行表单');
  const reply = page.getByRole('article', { name: 'A2UI Agent 回复', exact: true });
  await reply.getByLabel('出行人姓名', { exact: true }).fill('阅读后继续的学习者');
  await reply.getByLabel('预算（元）', { exact: true }).fill('4200');
  await reply.getByText('A2UI Workshop：改声明，观察同一个 renderer', { exact: true }).click();
  const lesson = reply.getByRole('region', { name: '本地绑定会改组件声明吗？', exact: true });
  await lesson.getByLabel('只更新数据模型，组件声明不变', { exact: true }).check();
  await lesson.getByRole('button', { name: '运行本地绑定实验' }).click();
  await expect(lesson.getByRole('status')).toContainText('预测与实际结果一致');
  const days = await reply.getByLabel('行程天数', { exact: true }).inputValue();
  await lesson.getByRole('button', { name: '定位本次协议记录' }).click();
  const inspector = page.getByRole('complementary', { name: '协议检查器', exact: true });
  await inspector.getByRole('textbox', { name: '筛选协议消息' }).fill('learning/a2ui-binding');
  await expect(inspector.locator('.payload')).toContainText('"httpRequest": false');
  const trace = await inspector.locator('.payload').innerText();
  const requestsBeforeReading = [...requests];
  const tutorial = reply.getByRole('link', { name: '阅读 A2UI 完整教程', exact: true });
  await tutorial.click();
  await expect(page).toHaveURL(/#docs\/a2ui$/);
  await expect(reader(page).getByRole('heading', { level: 1 })).toContainText('A2UI：从声明到组件');
  await expect(page.getByRole('textbox', { name: '发送消息给 Agent' })).toHaveCount(0);
  await reader(page)
    .getByRole('article')
    .getByRole('link', { name: '从观察到独立开发', exact: true })
    .click();
  await expect(page).toHaveURL(/#docs\/learning-method$/);
  await expect(reader(page).getByRole('heading', { level: 1 })).toContainText('从观察到独立开发');
  expect(requests).toEqual(requestsBeforeReading);
  await returnLink(page).click();
  await expect(page).toHaveURL(/#chat$/);
  await expect(tutorial).toBeFocused();
  await expect(reply.getByLabel('出行人姓名', { exact: true })).toHaveValue('阅读后继续的学习者');
  await expect(reply.getByLabel('预算（元）', { exact: true })).toHaveValue('4200');
  await expect(reply.getByLabel('行程天数', { exact: true })).toHaveValue(days);
  await expect(lesson.getByRole('status')).toContainText('预测与实际结果一致');
  await expect(inspector.getByRole('textbox', { name: '筛选协议消息' })).toHaveValue(
    'learning/a2ui-binding',
  );
  await expect(inspector.locator('.payload')).toHaveText(trace);
  expect(requests).toEqual(requestsBeforeReading);
  expect(errors).toEqual([]);
});

test('AG-UI keeps receiving a live run while reading and stops automatic replay', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const runs: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/agui') runs.push(request.method());
  });
  await page.goto('/#chat');
  await send(page, '帮我规划杭州三日游');
  const reply = page.getByRole('article', {
    name: 'AG-UI Agent 回复',
    exact: true,
    includeHidden: true,
  });
  await expect(reply.getByRole('status')).toContainText('正在生成');
  await page.getByRole('link', { name: '打开学习文档', exact: true }).click();
  await expect(reader(page).getByRole('article')).toBeVisible();
  await expect.poll(() => reply.locator('.chat-run-status').innerText()).toContain('已完成');
  await returnLink(page).click();
  await reply.getByRole('button', { name: '暂停展示并观察' }).click();
  const panel = reply.getByLabel('AG-UI 事件回放学习');
  await panel.getByRole('button', { name: '从头回放', exact: true }).click();
  await panel.getByRole('button', { name: '自动回放', exact: true }).click();
  await reply.getByRole('link', { name: '阅读 AG-UI 完整教程', exact: true }).click();
  const position = await panel
    .getByRole('slider', { name: '回放事件位置', includeHidden: true })
    .inputValue();
  await expect
    .poll(() =>
      panel.getByRole('button', { name: '自动回放', exact: true, includeHidden: true }).count(),
    )
    .toBe(1);
  await expect(reader(page).getByRole('heading', { level: 1 })).toContainText('AG-UI');
  await returnLink(page).click();
  await expect(panel.getByRole('slider', { name: '回放事件位置' })).toHaveValue(position);
  await expect(panel.getByRole('button', { name: '自动回放', exact: true })).toBeVisible();
  expect(runs).toEqual(['POST']);
  expect(errors).toEqual([]);
});

test('MCP tutorial keeps the same live iframe and city without repeating tool or resource requests', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/mcp') {
      const message = request.postDataJSON();
      if (message.method === 'resources/read' || message.method === 'tools/call') {
        requests.push(message.method);
      }
    }
  });
  await page.goto('/#chat');
  await send(page, '打开杭州的活动应用');
  const reply = page.getByRole('article', { name: 'MCP Apps Agent 回复', exact: true });
  const app = reply.frameLocator('iframe');
  await expect(app.getByText('西湖清晨步道', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: '成都', exact: true }).click();
  await expect(app.getByText('人民公园早茶', { exact: true })).toBeVisible();
  await expect(app.getByRole('button', { name: '成都', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(app.getByRole('button', { name: '成都', exact: true })).toBeEnabled();
  expect(requests.filter((method) => method === 'resources/read')).toHaveLength(1);
  expect(requests.filter((method) => method === 'tools/call')).toHaveLength(2);
  const requestsBeforeReading = [...requests];
  const originalIframe = await reply.locator('iframe').elementHandle();
  const originalFrame = await originalIframe!.contentFrame();
  const originalDocument = await originalFrame!.evaluateHandle(() => document);
  const tutorial = reply.getByRole('link', { name: '阅读 MCP Apps 完整教程', exact: true });
  await tutorial.click();
  await expect(page).toHaveURL(/#docs\/mcp-apps$/);
  await expect(reader(page).getByRole('heading', { level: 1 })).toContainText(
    'MCP Apps：从工具结果到可交互应用',
  );
  await expect(page.locator('iframe')).toBeHidden();
  expect(
    await page
      .locator('iframe')
      .evaluate((element, original) => element === original, originalIframe),
  ).toBe(true);
  expect(
    await originalFrame!.evaluate((savedDocument) => document === savedDocument, originalDocument),
  ).toBe(true);
  await expect(
    originalFrame!.getByRole('button', { name: '成都', exact: true, includeHidden: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(originalFrame!.getByText('人民公园早茶', { exact: true })).toHaveText(
    '人民公园早茶',
  );
  expect(requests).toEqual(requestsBeforeReading);
  await reader(page)
    .getByRole('navigation', { name: '学习章节' })
    .getByRole('link', { name: /消息对照速查/ })
    .click();
  await expect(page).toHaveURL(/#docs\/reference$/);
  await returnLink(page).click();
  await expect(page).toHaveURL(/#chat$/);
  await expect(tutorial).toBeFocused();
  expect(
    await reply
      .locator('iframe')
      .evaluate((element, original) => element === original, originalIframe),
  ).toBe(true);
  expect(
    await originalFrame!.evaluate((savedDocument) => document === savedDocument, originalDocument),
  ).toBe(true);
  await expect(app.getByRole('button', { name: '成都', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(app.getByText('人民公园早茶', { exact: true })).toBeVisible();
  expect(requests).toEqual(requestsBeforeReading);

  await app.getByRole('button', { name: '上海', exact: true }).click();
  await expect(app.getByText('外滩建筑散步', { exact: true })).toBeVisible();
  expect(requests).toEqual([...requestsBeforeReading, 'tools/call']);
  await originalDocument.dispose();
  await originalIframe!.dispose();
  expect(errors).toEqual([]);
});

test('lab documentation returns to the same page and source tab with the experiment intact', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const surfaces: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/a2ui/surface') surfaces.push(request.method());
  });
  await page.goto('/#a2ui');
  await page.getByRole('button', { name: '生成 A2UI 界面', exact: true }).click();
  await page.getByLabel('出行人姓名', { exact: true }).fill('独立实验学习者');
  await page.getByRole('combobox', { name: '目的地', exact: true }).selectOption('chengdu');
  await page.getByLabel('行程天数', { exact: true }).fill('5');
  const inspector = page.getByRole('complementary', { name: '协议检查器', exact: true });
  await inspector.getByRole('textbox', { name: '筛选协议消息' }).fill('binding/write');
  await expect(inspector.locator('.payload')).toContainText('/form/days');
  const trace = await inspector.locator('.payload').innerText();
  await page.getByRole('tab', { name: '源码导读', exact: true }).click();
  const docsLink = page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name: '学习文档', exact: true });
  await docsLink.click();
  await expect(page).toHaveURL(/#docs\/map$/);
  await expect(page.getByRole('tab', { name: '源码导读', exact: true })).toHaveCount(0);
  await reader(page)
    .getByRole('navigation', { name: '学习章节' })
    .getByRole('link', { name: /A2UI：从声明到组件/ })
    .click();
  await expect(page).toHaveURL(/#docs\/a2ui$/);
  await expect(returnLink(page, '返回独立实验')).toHaveAttribute('href', '#a2ui');
  await returnLink(page, '返回独立实验').click();
  await expect(page).toHaveURL(/#a2ui$/);
  await expect(docsLink).toBeFocused();
  await expect(page.getByRole('tab', { name: '源码导读', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel', { name: '源码导读', exact: true })).toContainText(
    'shared/a2ui.ts',
  );
  await page.getByRole('tab', { name: '交互实验', exact: true }).click();
  await expect(page.getByLabel('出行人姓名', { exact: true })).toHaveValue('独立实验学习者');
  await expect(page.getByRole('combobox', { name: '目的地', exact: true })).toHaveValue('chengdu');
  await expect(page.getByLabel('行程天数', { exact: true })).toHaveValue('5');
  await expect(inspector.getByRole('textbox', { name: '筛选协议消息' })).toHaveValue(
    'binding/write',
  );
  await expect(inspector.locator('.payload')).toHaveText(trace);
  expect(surfaces).toEqual(['POST']);
  expect(errors).toEqual([]);
});

test('phone reader opens every chapter without page overflow and synchronizes theme and contents navigation', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#chat');
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await page.getByRole('link', { name: '打开学习文档', exact: true }).click();
  await expect(reader(page).getByRole('heading', { level: 1 })).toContainText('Agent UI 学习地图');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    reader(page).getByRole('button', { name: '切换浅色模式', exact: true }),
  ).toBeVisible();

  const chapters = reader(page).getByRole('navigation', { name: '学习章节' });
  const destinations = [
    ['map', 'Agent UI 学习地图'],
    ['first-session', '第一次学习：30 分钟对话'],
    ['learning-method', '从观察到独立开发'],
    ['ag-ui', 'AG-UI：从事件流到真实界面'],
    ['mcp-apps', 'MCP Apps：从工具结果到可交互应用'],
    ['reference', '消息对照速查'],
    ['exercises', '练习清单'],
    ['real-development', '从学习实验到真实开发'],
    ['project', 'Agent UI Lab'],
    ['a2ui', 'A2UI：从声明到组件'],
  ];
  for (const [slug, heading] of destinations) {
    await test.step(`read ${slug} at 375px`, async () => {
      if (slug !== 'map') {
        await expect(chapters).toBeHidden();
        await reader(page).getByText('全部章节', { exact: true }).click();
        await chapters.locator(`a[href="#docs/${slug}"]`).click();
      }
      await expect(page).toHaveURL(new RegExp(`#docs/${slug}$`));
      await expect(
        reader(page).getByRole('article').getByRole('heading', { level: 1 }),
      ).toContainText(heading);
      await expect(chapters).toBeHidden();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
              window.innerWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
    });
  }

  await reader(page).locator('summary').filter({ hasText: '本章目录' }).click();
  const contents = reader(page).getByRole('navigation', { name: '本章目录', exact: true });
  await contents.getByRole('link', { name: '动作不是 userAction', exact: true }).click();
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe(
    '#docs/a2ui?section=动作不是-useraction',
  );
  const heading = reader(page).getByRole('heading', { name: /^动作不是 userAction/ });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await expect(contents).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
          window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  await reader(page).getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await returnLink(page).click();
  await expect(page).toHaveURL(/#chat$/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: '切换深色模式', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
