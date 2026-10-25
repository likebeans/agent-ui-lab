import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  APPROVAL_API,
  TEACHING_SESSION_HEADER,
  type ApprovalCommand,
} from '../../shared/labs/human-approval/types';

const labRegion = (page: Page) => page.getByRole('region', { name: '人工确认操作区', exact: true });
const value = (region: Locator, label: string) => region.locator(`dt:has-text("${label}") + dd`);

async function proposal(page: Page) {
  await page.goto('/#labs/human-approval');
  const lab = labRegion(page);
  await lab.getByRole('button', { name: '生成报名提议', exact: true }).click();
  await expect(lab.getByRole('status')).toContainText('报名提议已生成');
  return lab;
}

test('a request that never settles times out to unknown and unlocks fact recovery', async ({
  page,
}) => {
  await page.clock.install();
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${APPROVAL_API}/commands`, async (route) => {
    if (route.request().postDataJSON().payload.type === 'approve') {
      await waiting;
      await route.abort().catch(() => {});
    } else await route.continue();
  });
  try {
    const lab = await proposal(page);
    await lab.getByRole('button', { name: '确认报名', exact: true }).click();
    await expect(lab.getByRole('status')).toContainText('正在发送');
    await page.clock.fastForward(10_100);
    await expect(lab.getByRole('status')).toContainText('结果未知');
    await expect(lab.getByRole('button', { name: '查询事实', exact: true })).toBeEnabled();
    await expect(lab.getByRole('region', { name: '待定命令恢复', exact: true })).toContainText(
      '超时',
    );
    await lab.getByRole('button', { name: '查询事实', exact: true }).click();
    await expect(lab.getByRole('region', { name: '报名事实', exact: true })).toContainText(
      '报名记录数：0',
    );
    await expect(lab.getByRole('button', { name: '以原命令重试', exact: true })).toBeEnabled();
  } finally {
    release();
  }
});

test('replaying the original proposal receipt cannot contradict a newer confirmed fact', async ({
  page,
  request,
}) => {
  let original: { command: ApprovalCommand; session: string } | undefined;
  page.on('request', (sent) => {
    if (new URL(sent.url()).pathname !== `${APPROVAL_API}/commands`) return;
    const command = sent.postDataJSON() as ApprovalCommand;
    if (command.payload.type === 'propose')
      original = {
        command,
        session: sent.headers()[TEACHING_SESSION_HEADER.toLowerCase()],
      };
  });
  const lab = await proposal(page);
  const saved = lab.getByRole('region', { name: '已保存提议', exact: true });
  const decision = {
    taskId: original!.command.taskId,
    commandId: crypto.randomUUID(),
    expectedVersion: 1,
    payload: {
      type: 'approve',
      proposalId: await value(saved, '提议 ID').innerText(),
      proposalVersion: 1,
    },
  };
  const response = await request.post(`${APPROVAL_API}/commands`, {
    headers: { [TEACHING_SESSION_HEADER]: original!.session },
    data: decision,
  });
  expect(response.ok()).toBe(true);
  await lab.getByRole('button', { name: '查询事实', exact: true }).click();
  await expect(lab.getByRole('region', { name: '报名事实', exact: true })).toContainText(
    '报名记录数：1',
  );
  await lab.getByRole('button', { name: '重放上次命令', exact: true }).click();
  await expect(lab.getByRole('status')).toContainText('历史版本 1');
  await expect(lab.getByRole('status')).not.toContainText('尚未写入报名记录');
  await expect(value(saved, '任务版本')).toHaveText('2');
  await expect(saved).toContainText('已确认');
  await expect(lab.getByRole('article', { name: '已核实报名记录', exact: true })).toBeVisible();
});
