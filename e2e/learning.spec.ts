import { expect, test, type Page } from '@playwright/test';

async function send(page: Page, prompt: string) {
  await page.getByRole('textbox', { name: '发送消息给 Agent' }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}

test('AG-UI freezes rendering, replays recorded states and grades a real reducer experiment', async ({
  page,
}) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().endsWith('/api/agui')) requests.push(request.url());
  });
  await page.goto('/');
  await send(page, '帮我规划杭州三日游');
  const reply = page.getByRole('article', { name: 'AG-UI Agent 回复' });
  await reply.getByRole('button', { name: '暂停展示并观察' }).click();
  const panel = reply.getByLabel('AG-UI 事件回放学习');
  const position = await panel.getByRole('slider', { name: '回放事件位置' }).inputValue();
  await expect(reply.getByRole('status')).toContainText('已完成');
  await expect(panel.getByRole('slider', { name: '回放事件位置' })).toHaveValue(position);
  await panel.getByRole('button', { name: '从头回放' }).click();
  await expect(reply.locator('.chat-itinerary > div')).toHaveCount(0);
  await panel.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(panel.getByRole('slider', { name: '回放事件位置' })).toHaveValue('1');
  await reply.getByRole('button', { name: '结束回放，回到实时' }).click();
  await expect(reply.locator('.chat-itinerary > div')).toHaveCount(3);
  await reply.getByRole('button', { name: '追溯文字更新', exact: true }).click();
  await expect(panel.locator('.causal-evidence > strong')).toHaveText('TEXT_MESSAGE_CONTENT');
  await panel.getByRole('button', { name: '在检查器中定位 TEXT_MESSAGE_CONTENT' }).click();
  await expect(page.locator('.payload')).toContainText('TEXT_MESSAGE_CONTENT');
  const evidence = page.locator('.payload');
  const actualEvent = JSON.parse(await evidence.innerText());
  await panel.getByText('改一条事件，试运行 reducer', { exact: true }).click();
  const input = panel.getByRole('textbox', { name: '实验事件 JSON' });
  expect(JSON.parse(await input.inputValue())).toEqual(actualEvent);
  await input.fill(JSON.stringify({ ...actualEvent, delta: '本地实验增量' }));
  await panel.getByRole('button', { name: '验证并试运行事件' }).click();
  await expect(panel.locator('.experiment-result')).toContainText('本地实验增量');
  await expect(reply.locator('.agent-prose').first()).not.toContainText('本地实验增量');
  await input.fill('{"type":"UNKNOWN"}');
  await panel.getByRole('button', { name: '验证并试运行事件' }).click();
  await expect(panel.getByRole('alert')).toContainText('事件被拒绝');
  const lesson = panel.getByRole('region', { name: '文本增量是追加还是替换？' });
  await lesson.getByLabel('替换原有文字', { exact: true }).check();
  await lesson.getByRole('button', { name: '用本轮事件验证' }).click();
  await expect(lesson.getByRole('status')).toContainText('实际结果与你的预测不同');
  await lesson.getByRole('button', { name: '定位本次协议记录' }).click();
  await expect(page.locator('.payload')).toContainText('"appended": true');
  await reply.getByText('事件如何变成这条回复', { exact: false }).click();
  await reply.getByText('事件如何变成这条回复', { exact: false }).click();
  await expect(lesson.getByRole('status')).toContainText('实际结果与你的预测不同');
  expect(requests).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('A2UI validates local declarations and verifies the budget through a real action', async ({
  page,
}) => {
  const errors: string[] = [];
  const actions: Array<{ action: { context: Record<string, unknown> } }> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().endsWith('/api/a2ui/action')) actions.push(request.postDataJSON());
  });
  await page.goto('/');
  await send(page, '生成杭州三日游需求表单');
  const form = page.getByRole('article', { name: 'A2UI Agent 回复' }).first();
  await expect(form.getByLabel('出行人姓名')).toBeVisible();
  await expect(form.getByLabel('预算（元）', { exact: true })).toHaveCount(0);
  await form.getByText('A2UI Workshop：改声明，观察同一个 renderer', { exact: true }).click();
  const workshop = form.getByLabel('A2UI 声明 Workshop', { exact: true });
  const editor = workshop.getByRole('textbox', { name: 'A2UI Surface 草稿 JSON' });
  const original = JSON.parse(await editor.inputValue());
  const lesson = workshop.getByRole('region', { name: '本地绑定会改组件声明吗？' });
  await lesson.getByLabel('只更新数据模型，组件声明不变', { exact: true }).check();
  await lesson.getByRole('button', { name: '运行本地绑定实验' }).click();
  await expect(lesson.getByRole('status')).toContainText('预测与实际结果一致');
  await expect(form.getByLabel('行程天数', { exact: true })).toHaveValue('4');
  expect(actions).toHaveLength(0);
  await lesson.getByRole('button', { name: '定位本次协议记录' }).click();
  await expect(page.locator('.payload')).toContainText('"httpRequest": false');

  await workshop.getByRole('button', { name: '错误绑定路径（应拒绝）' }).click();
  await workshop.getByRole('button', { name: '验证并应用到真实界面' }).click();
  await expect(workshop.getByRole('alert')).toContainText('/form/notARealField');
  await expect(form.getByLabel('行程天数', { exact: true })).toHaveValue('4');
  await expect(editor).toContainText('/form/notARealField');
  await workshop.getByRole('button', { name: '布局引用移除（保留定义）' }).click();
  await workshop.getByRole('button', { name: '验证并应用到真实界面' }).click();
  await expect(form.getByLabel('出行人姓名')).toHaveCount(0);
  expect(
    JSON.parse(await editor.inputValue()).components.some(
      (item: { id: string }) => item.id === 'traveler',
    ),
  ).toBe(true);

  await workshop.getByRole('button', { name: '预算字段 + action.context' }).click();
  await workshop.getByRole('button', { name: '验证并应用到真实界面' }).click();
  await expect(form.getByLabel('预算（元）', { exact: true })).toHaveValue('3000');
  await form.getByLabel('出行人姓名').fill('学习者');
  await form.getByLabel('预算（元）', { exact: true }).fill('4200');
  await form.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(workshop.getByLabel('预算字段练习验证')).toContainText(
    '已完成：action.context.budget 与状态中的“预算 4200 元”一致',
  );
  expect(actions).toHaveLength(1);
  expect(actions[0].action.context).toMatchObject({ budget: '4200', traveler: '学习者' });
  await expect(form.locator('[data-a2ui-component-id="status"]')).toContainText('预算 4200 元');
  await workshop.getByRole('button', { name: '重置为初始声明与模型' }).click();
  await expect(form.getByLabel('预算（元）', { exact: true })).toHaveCount(0);
  expect(JSON.parse(await editor.inputValue())).toEqual(original);
  await expect(lesson.getByRole('status')).toHaveCount(0);

  await send(page, '生成带预算和同行人数的出行表单');
  const expanded = page.getByRole('article', { name: 'A2UI Agent 回复' }).last();
  await expect(expanded.getByLabel('预算（元）', { exact: true })).toHaveValue('3000');
  await expect(expanded.getByLabel('同行人数', { exact: true })).toHaveValue('2');
  await expect(form.getByLabel('预算（元）', { exact: true })).toHaveCount(0);
  await expanded.getByText('A2UI Workshop：改声明，观察同一个 renderer', { exact: true }).click();
  await lesson.getByLabel('只更新数据模型，组件声明不变', { exact: true }).check();
  await expanded.getByLabel('数据模型和组件声明都会变化', { exact: true }).check();
  await expect(lesson.getByLabel('只更新数据模型，组件声明不变', { exact: true })).toBeChecked();
  await expect(expanded.getByLabel('数据模型和组件声明都会变化', { exact: true })).toBeChecked();
  const expandedEditor = expanded.getByRole('textbox', { name: 'A2UI Surface 草稿 JSON' });
  const changedButton = JSON.parse(await expandedEditor.inputValue());
  changedButton.components.find((item: { id: string }) => item.id === 'submit').id =
    'unsupported-button';
  const column = changedButton.components.find((item: { id: string }) => item.id === 'form');
  column.children = column.children.map((id: string) =>
    id === 'submit' ? 'unsupported-button' : id,
  );
  await expandedEditor.fill(JSON.stringify(changedButton));
  await expanded.getByRole('button', { name: '验证并应用到真实界面' }).click();
  await expanded.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(expanded.getByRole('alert')).toContainText('此 Surface 不支持该动作');
  expect(actions.at(-1)!.action).toMatchObject({ sourceComponentId: 'unsupported-button' });
  expect(errors).toEqual([]);
});

test('MCP Apps changes real tool data without a resource read, then reloads an alternate layout', async ({
  page,
}) => {
  const errors: string[] = [];
  const requests: Array<{
    method: string;
    params?: { uri?: string; arguments?: { city: string } };
  }> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/mcp')) {
      requests.push(request.postDataJSON());
    }
  });
  await page.goto('/');
  await send(page, '打开杭州的活动应用');
  const app = page.getByRole('article', { name: 'MCP Apps Agent 回复' });
  await expect(app.locator('.chat-run-status')).toContainText('App 与宿主已连接');
  const frame = app.frameLocator('iframe');
  await expect(frame.getByText('西湖清晨步道', { exact: true })).toBeVisible();
  const firstFrame = await app.locator('iframe').elementHandle();
  await app.getByText('动手验证 MCP Apps 因果链', { exact: false }).click();
  await app.getByRole('button', { name: '定位实际 tools/list 记录' }).click();
  await expect(page.locator('.payload')).toContainText('ui://intelligent-ui/trip-picker');
  const resourcesBefore = requests.filter((entry) => entry.method === 'resources/read').length;
  const toolsBefore = requests.filter((entry) => entry.method === 'tools/call').length;
  await app.getByLabel('实验 A 的工具输入城市', { exact: true }).selectOption('chengdu');
  const prediction = app.getByRole('region', { name: '工具结果与 UI 资源是否绑定重读' });
  await prediction
    .getByLabel('必须；每次 tools/call 后都要 resources/read', { exact: true })
    .check();
  await prediction.getByRole('button', { name: '调用工具并切换到成都' }).click();
  await expect(prediction.getByRole('status')).toContainText('实际结果与你的预测不同');
  await expect(frame.getByText('人民公园早茶', { exact: true })).toBeVisible();
  expect(await firstFrame!.evaluate((element) => element.isConnected)).toBe(true);
  expect(requests.filter((entry) => entry.method === 'resources/read')).toHaveLength(
    resourcesBefore,
  );
  expect(requests.filter((entry) => entry.method === 'tools/call')).toHaveLength(toolsBefore + 1);
  await prediction.getByText('查看本次实验的证据', { exact: true }).click();
  const evidence = JSON.parse(await prediction.locator('pre').innerText());
  expect(evidence.comparison).toEqual({ resourceReads: 0, iframeMounts: 0, toolCalls: 1 });
  expect(evidence.iframePreserved).toBe(true);
  await prediction.getByRole('button', { name: '定位本次协议记录' }).click();
  await expect(page.locator('.payload')).toContainText('人民公园早茶');

  await app
    .getByLabel('实验 B 的 UI 布局资源', { exact: true })
    .selectOption('ui://intelligent-ui/trip-picker-list');
  await app.getByRole('button', { name: '读取所选资源并重载 App' }).click();
  const layout = app.locator('.mcp-experiment-evidence');
  await expect(layout).toContainText('Host 资源实验已完成');
  await expect(frame.locator('#app')).toHaveAttribute('data-layout', 'list');
  await expect(frame.getByText('人民公园早茶', { exact: true })).toBeVisible();
  expect(await firstFrame!.evaluate((element) => element.isConnected)).toBe(false);
  expect(requests.filter((entry) => entry.method === 'resources/read')).toHaveLength(
    resourcesBefore + 1,
  );
  expect(requests.filter((entry) => entry.method === 'tools/call')).toHaveLength(toolsBefore + 1);
  await layout.getByText('查看本次布局实验的证据', { exact: true }).click();
  const layoutEvidence = JSON.parse(await layout.locator('pre').innerText());
  expect(layoutEvidence.comparison).toEqual({ resourceReads: 1, iframeMounts: 1, toolCalls: 0 });
  expect(layoutEvidence.iframeRecreated).toBe(true);
  expect(layoutEvidence.toolMetadata).toMatchObject({
    changed: false,
    advertisedResourceUri: 'ui://intelligent-ui/trip-picker',
  });
  await expect(prediction.getByRole('status')).toContainText('实际结果与你的预测不同');
  await app.getByRole('button', { name: '定位实际 initialized 记录' }).click();
  await expect(page.locator('.payload')).toContainText('ui/notifications/initialized');
  await app.getByRole('button', { name: '定位本次 resources/read 记录' }).click();
  await expect(page.locator('.payload')).toContainText('ui://intelligent-ui/trip-picker-list');
  await frame.getByRole('button', { name: '上海', exact: true }).click();
  await expect(frame.getByText('外滩建筑散步', { exact: true })).toBeVisible();

  await prediction.getByRole('button', { name: '重新预测' }).click();
  await app.getByLabel('实验 A 的工具输入城市', { exact: true }).selectOption('hangzhou');
  await prediction.getByLabel('不需要；原 App 可以接收新的真实工具结果', { exact: true }).check();
  await page.route('**/mcp', async (route) => {
    const message = route.request().postDataJSON();
    if (message?.method === 'tools/call') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { isError: true, content: [{ type: 'text', text: '实验工具暂不可用' }] },
        }),
      });
    } else await route.continue();
  });
  await prediction.getByRole('button', { name: '调用工具并切换到杭州' }).click();
  await expect(prediction.getByRole('alert')).toContainText('本次不判分');
  await expect(prediction.getByRole('status')).toHaveCount(0);
  await expect(frame.getByText('外滩建筑散步', { exact: true })).toBeVisible();
  await page.unroute('**/mcp');
  await prediction.getByRole('button', { name: '调用工具并切换到杭州' }).click();
  await expect(prediction.getByRole('status')).toContainText('预测与实际结果一致');
  await expect(frame.getByText('西湖清晨步道', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
