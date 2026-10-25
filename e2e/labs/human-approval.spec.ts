import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  APPROVAL_API,
  DROP_RESPONSE_HEADER,
  TEACHING_SESSION_HEADER,
  type ApprovalCommand,
} from '../../shared/labs/human-approval/types';

const labRegion = (page: Page) => page.getByRole('region', { name: '人工确认操作区', exact: true });
const savedProposal = (lab: Locator) =>
  lab.getByRole('region', { name: '已保存提议', exact: true });
const record = (lab: Locator) => lab.getByRole('article', { name: '已核实报名记录', exact: true });
const value = (region: Locator, label: string) => region.locator(`dt:has-text("${label}") + dd`);

async function generate(page: Page, name = '测试学员') {
  const lab = labRegion(page);
  await lab.getByLabel('姓名', { exact: true }).fill(name);
  await lab.getByLabel('工作坊', { exact: true }).selectOption('reliable-actions');
  await lab.getByLabel('报名人数', { exact: true }).fill('2');
  await lab.getByRole('button', { name: '生成报名提议', exact: true }).click();
  await expect(savedProposal(lab)).toContainText('等待人工确认');
  return lab;
}

async function experiments(lab: Locator) {
  await lab.getByText('边界实验', { exact: true }).click();
}

function observeCommands(page: Page) {
  const commands: Array<{ command: ApprovalCommand; session: string; drop: string | undefined }> =
    [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== `${APPROVAL_API}/commands`) return;
    commands.push({
      command: request.postDataJSON() as ApprovalCommand,
      session: request.headers()[TEACHING_SESSION_HEADER.toLowerCase()],
      drop: request.headers()[DROP_RESPONSE_HEADER.toLowerCase()],
    });
  });
  return commands;
}

test('keyboard confirmation at 375px queries one fact, replays the same command and survives opening docs', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const commands = observeCommands(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#labs/human-approval');
  const lab = labRegion(page);
  await expect(lab).toContainText('SQLite 持久化');
  await lab.getByLabel('姓名', { exact: true }).fill('键盘学员');
  await lab.getByLabel('姓名', { exact: true }).press('Tab');
  await expect(lab.getByLabel('工作坊', { exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(lab.getByLabel('报名人数', { exact: true })).toBeFocused();
  await lab.getByLabel('报名人数', { exact: true }).fill('3');
  await page.keyboard.press('Tab');
  await expect(lab.getByRole('button', { name: '生成报名提议', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(savedProposal(lab)).toContainText('键盘学员');
  await expect(value(savedProposal(lab), '提议内容版本')).toHaveText('1');
  const taskId = await value(savedProposal(lab), '任务 ID').innerText();
  expect(taskId).toMatch(/^[a-f\d-]{36}$/u);

  await lab.getByRole('button', { name: '确认报名', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(record(lab)).toContainText('键盘学员');
  await expect(record(lab)).toContainText('3 人');
  expect(commands.filter(({ command }) => command.payload.type === 'approve')).toHaveLength(1);
  const enrollmentId = await value(record(lab), '报名 ID').innerText();
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(lab.getByRole('region', { name: '报名事实', exact: true })).toContainText(
    '报名记录数：1',
  );
  await lab.getByRole('button', { name: '重放上次命令', exact: true }).click();
  await expect(lab.getByRole('status').first()).toContainText('原命令已重放');
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(value(record(lab), '报名 ID')).toHaveText(enrollmentId);
  await expect(lab.getByRole('region', { name: '报名事实', exact: true })).toContainText(
    '报名记录数：1',
  );
  const approvals = commands.filter(({ command }) => command.payload.type === 'approve');
  expect(approvals).toHaveLength(2);
  expect(approvals[1]).toEqual(approvals[0]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);

  await page.getByRole('link', { name: '实验文档', exact: true }).click();
  const reader = page.getByRole('region', { name: '学习文档', exact: true });
  await expect(reader.getByRole('heading', { level: 1 })).toContainText('人工确认与业务事实');
  await reader.getByRole('link', { name: '人工确认实验', exact: true }).click();
  await expect(value(savedProposal(lab), '任务 ID')).toHaveText(taskId);
  await expect(value(record(lab), '报名 ID')).toHaveText(enrollmentId);
  expect(errors).toEqual([]);
});

test('editing requires saving; stale decisions, wrong sessions and changed arguments preserve the known proposal', async ({
  page,
}) => {
  await page.goto('/#labs/human-approval');
  const lab = await generate(page);
  await lab.getByLabel('报名人数', { exact: true }).fill('4');
  await expect(lab.getByRole('button', { name: '确认报名', exact: true })).toBeDisabled();
  await expect(lab).toContainText('有未保存修改');
  await expect(value(savedProposal(lab), '报名人数')).toHaveText('2');
  await lab.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(value(savedProposal(lab), '提议内容版本')).toHaveText('2');
  await expect(value(savedProposal(lab), '报名人数')).toHaveText('4');
  await experiments(lab);
  await lab.getByRole('button', { name: '尝试旧版本确认', exact: true }).click();
  await expect(lab).toContainText('VERSION_CONFLICT');
  await expect(savedProposal(lab)).toContainText('等待人工确认');
  await expect(value(savedProposal(lab), '提议内容版本')).toHaveText('2');
  await lab.getByRole('button', { name: '尝试错误会话确认', exact: true }).click();
  await expect(lab).toContainText('SESSION_MISMATCH');
  await lab.getByRole('button', { name: '确认报名', exact: true }).click();
  await expect(record(lab)).toContainText('4 人');
  const enrollmentId = await value(record(lab), '报名 ID').innerText();
  await lab.getByRole('button', { name: '尝试同键异参', exact: true }).click();
  await expect(lab).toContainText('KEY_REUSED');
  await expect(value(record(lab), '报名 ID')).toHaveText(enrollmentId);
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(lab.getByRole('region', { name: '报名事实', exact: true })).toContainText(
    '报名记录数：1',
  );
});

test('rejecting the saved proposal writes no enrollment and permits a new proposal', async ({
  page,
}) => {
  await page.goto('/#labs/human-approval');
  const lab = await generate(page, '拒绝示例');
  await lab.getByRole('button', { name: '拒绝提议', exact: true }).click();
  await expect(savedProposal(lab)).toContainText('已拒绝');
  await expect(lab.getByRole('button', { name: '确认报名', exact: true })).toBeDisabled();
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(lab.getByRole('region', { name: '报名事实', exact: true })).toContainText(
    '报名记录数：0',
  );
  await expect(record(lab)).toHaveCount(0);
  const oldId = await value(savedProposal(lab), '提议 ID').innerText();
  await lab.getByRole('button', { name: '生成报名提议', exact: true }).click();
  await expect(savedProposal(lab)).toContainText('等待人工确认');
  await expect(value(savedProposal(lab), '提议 ID')).not.toHaveText(oldId);
});

test('a committed confirmation with a lost response recovers by facts and replays without duplication', async ({
  page,
}) => {
  const commands = observeCommands(page);
  await page.goto('/#labs/human-approval');
  const lab = await generate(page, '中断示例');
  await experiments(lab);
  await lab.getByLabel('模拟丢失确认响应', { exact: true }).check();
  await lab
    .getByRole('button', { name: '确认报名', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(lab.getByRole('status').first()).toContainText('结果未知');
  await expect(record(lab)).toHaveCount(0);
  await expect(lab.getByRole('button', { name: '生成报名提议', exact: true })).toBeDisabled();
  await expect(lab.getByRole('button', { name: '以原命令重试', exact: true })).toBeDisabled();
  await expect(lab.getByRole('button', { name: '重置实验', exact: true })).toBeDisabled();
  const approvals = commands.filter(({ command }) => command.payload.type === 'approve');
  expect(approvals).toHaveLength(1);
  expect(approvals[0].drop).toBe('1');
  const original = approvals[0];
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(lab.getByRole('status').first()).toContainText('已通过事实查询核实原命令');
  await expect(lab.getByRole('region', { name: '报名事实', exact: true })).toContainText(
    '报名记录数：1',
  );
  await expect(record(lab)).toContainText('中断示例');
  const enrollmentId = await value(record(lab), '报名 ID').innerText();
  await expect(value(record(lab), '命令 ID')).toHaveText(original.command.commandId);
  await lab.getByRole('button', { name: '重放上次命令', exact: true }).click();
  await expect(lab.getByRole('status').first()).toContainText('原命令已重放');
  const replay = commands.at(-1)!;
  expect(replay.command).toEqual(original.command);
  expect(replay.session).toBe(original.session);
  expect(replay.drop).toBeUndefined();
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(value(record(lab), '报名 ID')).toHaveText(enrollmentId);
  await expect(lab.getByRole('region', { name: '报名事实', exact: true })).toContainText(
    '报名记录数：1',
  );
});

test('a wrapper response stays unknown after empty facts and reload; retry sends the exact saved command', async ({
  page,
}) => {
  const commands = observeCommands(page);
  let intercept = true;
  await page.route(`**${APPROVAL_API}/commands`, async (route) => {
    if (intercept && route.request().postDataJSON().payload.type === 'approve') {
      intercept = false;
      await route.fulfill({ status: 200, json: { error: '教学代理未提供领域结果' } });
    } else await route.continue();
  });
  await page.goto('/#labs/human-approval');
  const lab = await generate(page, '恢复示例');
  await lab.getByRole('button', { name: '确认报名', exact: true }).click();
  await expect(lab.getByRole('status').first()).toContainText('结果未知');
  const original = commands.at(-1)!;
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(lab.getByRole('region', { name: '待定命令恢复', exact: true })).toContainText(
    '结果仍未知',
  );
  await expect(lab.getByRole('region', { name: '报名事实', exact: true })).toContainText(
    '报名记录数：0',
  );
  await expect(lab.getByRole('button', { name: '确认报名', exact: true })).toBeDisabled();
  await expect(lab.getByRole('button', { name: '以原命令重试', exact: true })).toBeEnabled();
  await page.reload();
  await expect(lab.getByRole('status').first()).toContainText('结果未知');
  await expect(lab.getByLabel('原始报名命令', { exact: true })).toContainText(
    original.command.commandId,
  );
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(lab.getByRole('button', { name: '以原命令重试', exact: true })).toBeEnabled();
  await lab.getByRole('button', { name: '以原命令重试', exact: true }).click();
  await expect(record(lab)).toContainText('恢复示例');
  const retried = commands.at(-1)!;
  expect(retried.command).toEqual(original.command);
  expect(retried.session).toBe(original.session);
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(lab.getByRole('region', { name: '报名事实', exact: true })).toContainText(
    '报名记录数：1',
  );
});

test('invalid input has a focused summary, linked inline errors and no request', async ({
  page,
}) => {
  const commands = observeCommands(page);
  await page.goto('/#labs/human-approval');
  const lab = labRegion(page);
  await lab.getByLabel('姓名', { exact: true }).fill('   ');
  await lab.getByLabel('报名人数', { exact: true }).fill('0');
  await lab.getByRole('button', { name: '生成报名提议', exact: true }).click();
  const summary = lab.getByRole('alert');
  await expect(summary).toBeFocused();
  await expect(lab.getByLabel('姓名', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(lab.getByLabel('报名人数', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await summary.getByRole('link', { name: '请填写报名姓名。', exact: true }).click();
  await expect(lab.getByLabel('姓名', { exact: true })).toBeFocused();
  expect(commands).toEqual([]);
});
