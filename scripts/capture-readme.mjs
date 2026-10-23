import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const baseURL = process.env.README_BASE_URL ?? 'http://127.0.0.1:5173';
const destination = new URL('../public/readme/screenshots/', import.meta.url);
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
page.on('pageerror', (error) => errors.push(error.message));

async function save(name) {
  await page.screenshot({ path: fileURLToPath(new URL(name, destination)) });
  console.log(`Saved ${name}`);
}

async function openChat() {
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: '聊一聊，让界面自然发生。' })).toBeVisible();
  await expect(page.locator('.connection-state')).toContainText('服务已连接');
}

async function send(prompt) {
  await page.getByRole('textbox', { name: '发送消息给 Agent' }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}

async function alignReply(reply) {
  await reply.evaluate((element) => {
    const scroll = element.closest('.conversation-scroll');
    scroll.scrollTop +=
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24;
  });
}

try {
  await openChat();
  await page.getByRole('button', { name: '关闭协议面板', exact: true }).click();
  await save('agent-chat.png');

  await page.getByRole('button', { name: '打开协议面板', exact: true }).click();
  await send('帮我规划杭州三日游，喜欢慢节奏和本地小吃');
  const stream = page.getByRole('article', { name: 'AG-UI Agent 回复', exact: true });
  await expect(stream.getByRole('status')).toContainText('已完成');
  await expect(stream.locator('.chat-itinerary > div')).toHaveCount(3);
  await stream.getByRole('button', { name: '查看本轮 AG-UI 协议' }).click();
  const inspector = page.getByRole('complementary', { name: '协议检查器', exact: true });
  await inspector.getByRole('textbox', { name: '筛选协议消息' }).fill('STATE_DELTA');
  await expect(inspector.locator('.payload')).toContainText('STATE_DELTA');
  await alignReply(stream);
  await save('ag-ui-events.png');

  await stream.getByRole('button', { name: '追溯文字更新', exact: true }).click();
  const playback = stream.getByLabel('AG-UI 事件回放学习');
  await playback.getByRole('button', { name: '在检查器中定位 TEXT_MESSAGE_CONTENT' }).click();
  const lesson = playback.getByRole('region', { name: '文本增量是追加还是替换？', exact: true });
  await lesson.getByLabel('追加到原有文字后面', { exact: true }).check();
  await lesson.getByRole('button', { name: '用本轮事件验证', exact: true }).click();
  await expect(lesson.getByRole('status')).toContainText('预测与实际结果一致');
  await lesson.getByRole('button', { name: '定位本次协议记录', exact: true }).click();
  await lesson.scrollIntoViewIfNeeded();
  await save('ag-ui-learning.png');

  await openChat();
  await page.setViewportSize({ width: 1440, height: 1160 });
  await send('生成带预算的杭州三日游表单');
  const form = page.getByRole('article', { name: 'A2UI Agent 回复', exact: true });
  await form.getByLabel('出行人姓名').fill('学习者');
  await form.getByRole('combobox', { name: '目的地', exact: true }).selectOption('chengdu');
  await form.getByLabel('预算（元）', { exact: true }).fill('4200');
  await form.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(form.locator('[data-a2ui-component-id="status"]')).toContainText('预算 4200 元');
  await form.getByText('声明如何变成 React 组件', { exact: false }).click();
  await form.getByRole('button', { name: /^定位声明 days：/ }).click();
  await form.getByRole('button', { name: '在检查器中查看当前组件声明' }).click();
  await expect(inspector.locator('.payload')).toContainText('/form/days');
  await alignReply(form);
  await save('a2ui-form.png');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await openChat();
  await send('打开上海的城市活动应用');
  const app = page.getByRole('article', { name: 'MCP Apps Agent 回复', exact: true });
  const frame = app.frameLocator('iframe');
  await expect(app.locator('.chat-run-status')).toContainText('App 与宿主已连接');
  await expect(frame.getByText('外滩建筑散步', { exact: true })).toBeVisible();
  await app.getByText('动手验证 MCP Apps 因果链', { exact: false }).click();
  await app.getByRole('button', { name: '定位实际 tools/list 记录' }).click();
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await alignReply(app);
  await save('mcp-app.png');

  await page.getByRole('button', { name: '关闭协议面板', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await app.locator('iframe').evaluate((element) => {
    const scroll = element.closest('.conversation-scroll');
    scroll.scrollTop +=
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16;
  });
  await save('mobile-chat.png');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click();
  await page.getByRole('link', { name: '打开学习文档', exact: true }).click();
  await page
    .getByRole('navigation', { name: '学习章节' })
    .getByRole('link', { name: /第一次学习/ })
    .click();
  await expect(page.getByRole('article', { name: '第一次学习', exact: true })).toBeVisible();
  await page.getByRole('heading', { level: 1 }).evaluate((element) => element.blur());
  await save('learning-docs.png');

  expect(errors).toEqual([]);
  console.log('Captured seven screenshots from the running project.');
} finally {
  await browser.close();
}
