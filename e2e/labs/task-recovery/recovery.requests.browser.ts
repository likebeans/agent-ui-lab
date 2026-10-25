import { expect, test, type Locator, type Page } from '@playwright/test';
import { build } from 'esbuild';

const pages =
  process.env.LAB_RECOVERY_TEST_MODE === 'pages' || process.env.PLAYWRIGHT_LAB_MODE === 'pages';
type Fault = {
  kind: 'create' | 'recovery' | 'cancel' | 'reset';
  body?: boolean;
  commit?: boolean;
  ignoreAbort?: boolean;
};
type RequestRecord = { path: string; method: string; action?: string };
interface RequestProbe {
  arm: (fault: Fault) => void;
  wrap: (send: typeof fetch) => typeof fetch;
  release: () => void;
  requests: RequestRecord[];
  hanging: boolean;
  aborts: number;
}
declare global {
  interface Window {
    __w1Requests: RequestProbe;
  }
}

// The local UI uses fetch. The Pages harness uses the same wrapper at runtime.request,
// because the real Pages adapter deliberately never calls network fetch.
function installRequestProbe() {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = (milliseconds) => timeout(milliseconds === 8_000 ? 500 : milliseconds);
  let fault: Fault | undefined;
  const probe: RequestProbe = {
    arm: (next) => {
      fault = next;
      probe.hanging = false;
    },
    release: () => {},
    requests: [],
    hanging: false,
    aborts: 0,
    wrap: (send) => async (input, options) => {
      const request = new Request(
        new URL(input instanceof Request ? input.url : String(input), location.href),
        options,
      );
      const path = new URL(request.url).pathname;
      if (!path.startsWith('/api/labs/task-recovery/')) return send(input, options);
      const action = path.endsWith('/commands')
        ? ((await request.clone().json()).payload.type as string)
        : undefined;
      probe.requests.push({ path, method: request.method, action });
      const kind =
        path.endsWith('/fixture') && request.method === 'DELETE'
          ? 'reset'
          : path.endsWith('/tasks') && request.method === 'POST'
            ? 'create'
            : path.endsWith('/recovery')
              ? 'recovery'
              : action === 'cancel'
                ? 'cancel'
                : undefined;
      if (!fault || kind !== fault.kind) return send(input, options);
      const selected = fault;
      fault = undefined;
      const response =
        selected.commit === false
          ? new Response('{}', { headers: { 'Content-Type': 'application/json' } })
          : await send(input, options);
      const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
      const body = selected.body ? await response.text() : '';
      probe.hanging = true;
      if (selected.body) {
        return new Response(
          new ReadableStream({
            start(controller) {
              let ended = false;
              const abort = () => {
                probe.aborts += 1;
                if (selected.ignoreAbort || ended) return;
                ended = true;
                controller.error(signal?.reason);
              };
              signal?.addEventListener('abort', abort, { once: true });
              if (signal?.aborted) abort();
              probe.release = () => {
                signal?.removeEventListener('abort', abort);
                if (ended) return;
                ended = true;
                controller.enqueue(new TextEncoder().encode(body));
                controller.close();
              };
            },
          }),
          { status: response.status, headers: response.headers },
        );
      }
      return new Promise<Response>((resolve, reject) => {
        const abort = () => {
          probe.aborts += 1;
          signal?.removeEventListener('abort', abort);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        probe.release = () => {
          signal?.removeEventListener('abort', abort);
          resolve(response);
        };
      });
    },
  };
  window.__w1Requests = probe;
  window.fetch = probe.wrap(window.fetch.bind(window));
}

let pagesModule = '';
test.beforeAll(async () => {
  if (!pages) return;
  // Bundle only this test module in memory: preview servers do not expose TS source.
  // This mounts the production component and engine without changing the host or dist.
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import TaskRecoveryLab from './src/labs/task-recovery/Lab';
        import { createRecoveryFixture } from './shared/labs/task-recovery/memory';
        const fixture = createRecoveryFixture();
        const controller = new AbortController();
        const runtime = {
          mode: 'pages', identity: { labId: 'task-recovery' }, signal: controller.signal,
          request: window.__w1Requests.wrap((input, options) => fixture.handle(
            new Request(new URL(String(input), location.href), options))),
          trace() {}, focusTrace() {},
        };
        document.getElementById('root').hidden = true;
        const host = document.createElement('div');
        host.dataset.w1TimeoutHarness = '';
        document.body.append(host);
        createRoot(host, { identifierPrefix: 'w1-timeout-' }).render(React.createElement(TaskRecoveryLab, {
          runtime, active: true, onResetTrace() {},
        }));
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    define: { 'import.meta.env.MODE': JSON.stringify('pages') },
    loader: { '.module.css': 'empty', '.css': 'empty' },
    logLevel: 'silent',
  });
  pagesModule = result.outputFiles[0].text;
});

function fact(panel: Locator, name: string) {
  return panel
    .locator('dt')
    .filter({ hasText: new RegExp(`^${name}$`, 'u') })
    .locator('..')
    .locator('dd');
}
async function open(page: Page) {
  await page.addInitScript(installRequestProbe);
  await page.goto('./#labs/task-recovery');
  const originalLab = page.getByRole('region', { name: '任务恢复实验操作区', exact: true });
  await expect(originalLab).toHaveAttribute('aria-busy', 'false');
  let host = page.locator('#root');
  if (pages) {
    await page.route('**/w1-timeout-test-module.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: pagesModule,
      }),
    );
    await page.addScriptTag({
      type: 'module',
      url: new URL('w1-timeout-test-module.js', page.url()).href,
    });
    host = page.locator('[data-w1-timeout-harness]');
    await expect(host).toBeVisible();
  }
  const lab = host.getByRole('region', { name: '任务恢复实验操作区', exact: true });
  await expect(lab).toHaveAttribute('aria-busy', 'false');
  return {
    lab,
    authority: lab.getByRole('region', { name: '服务端权威状态 · 最近查询', exact: true }),
    taskInput: lab.getByLabel('Task ID（任务，可选）'),
    query: lab.getByRole('button', { name: '查询任务', exact: true }),
  };
}
async function arm(page: Page, fault: Fault) {
  await page.evaluate((next) => window.__w1Requests.arm(next), fault);
}
async function timedOut(page: Page, lab: Locator) {
  await expect.poll(() => page.evaluate(() => window.__w1Requests.hanging)).toBe(true);
  await expect(lab).toHaveAttribute('aria-busy', 'false', { timeout: 2_500 });
  await expect(lab.getByRole('alert')).toContainText(/超时.*未知.*查询任务/u);
  await expect(lab.getByRole('button', { name: '查询任务', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__w1Requests.aborts)).toBeGreaterThan(0);
}
async function mutations(page: Page, action?: string) {
  return page.evaluate(
    (selected) =>
      window.__w1Requests.requests.filter(
        (request) => request.method === 'POST' && (!selected || request.action === selected),
      ),
    action,
  );
}

test('ordinary request timeout preserves a possibly committed create identity for fact query', async ({
  page,
}) => {
  const { lab, authority, taskInput, query } = await open(page);
  await arm(page, { kind: 'create' });
  await lab.getByRole('button', { name: '新建任务', exact: true }).click();
  await timedOut(page, lab);
  const taskId = await taskInput.inputValue();
  expect(taskId).toMatch(/^task-/u);
  expect(new URL(page.url()).searchParams.get('recoveryTask')).toBe(taskId);
  await expect(fact(authority, '任务状态')).toHaveText('尚未读取');
  await expect(lab.getByRole('button', { name: '开始执行', exact: true })).toBeDisabled();
  expect(await mutations(page)).toHaveLength(1);
  await query.click();
  await expect(authority).toContainText('queued');
  await expect(taskInput).toHaveValue(taskId);
  await expect(lab.getByRole('button', { name: '开始执行', exact: true })).toBeEnabled();
  expect(await mutations(page)).toHaveLength(1);
});

test('ordinary request timeout bounds recovery body reads and ignores late data after task changes', async ({
  page,
}) => {
  const { lab, authority, taskInput, query } = await open(page);
  await lab.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(lab.getByRole('button', { name: '开始执行', exact: true })).toBeEnabled();
  const firstTask = await taskInput.inputValue();
  // A host can return headers and then stall a body even after transport abort.
  await arm(page, { kind: 'recovery', body: true, ignoreAbort: true });
  await lab.getByRole('button', { name: '恢复连接', exact: true }).click();
  await timedOut(page, lab);
  await taskInput.fill('');
  await lab.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(lab.getByRole('button', { name: '开始执行', exact: true })).toBeEnabled();
  const secondTask = await taskInput.inputValue();
  expect(secondTask).not.toBe(firstTask);
  await lab.getByRole('button', { name: '开始执行', exact: true }).click();
  await expect(lab.getByRole('button', { name: '断开接流', exact: true })).toBeEnabled();
  const secondRun = await fact(lab, '当前 run').innerText();
  await page.evaluate(() => window.__w1Requests.release());
  // SSE must outlive the shortened ordinary-request deadline. The queued response
  // held for the first task must not replace this running task or its projection.
  await page.waitForTimeout(750);
  await expect(taskInput).toHaveValue(secondTask);
  await expect(fact(lab, 'Task / 任务')).toHaveText(secondTask);
  await expect(fact(lab, '当前 run')).toHaveText(secondRun);
  await expect(authority).toContainText('running');
  await expect(lab.getByRole('button', { name: '断开接流', exact: true })).toBeEnabled();
  await expect(lab.getByRole('alert')).toHaveCount(0);
  await taskInput.fill(firstTask);
  await query.click();
  await expect(fact(lab, 'Task / 任务')).toHaveText(firstTask);
  await expect(authority).toContainText('queued');
  await expect(lab).toHaveAttribute('aria-busy', 'false');
  expect(await mutations(page)).toHaveLength(3);
});

for (const commit of [false, true]) {
  test(`ordinary request timeout leaves cancel unconfirmed until fact query (committed=${commit})`, async ({
    page,
  }) => {
    const { lab, authority, query } = await open(page);
    await lab.getByRole('button', { name: '新建任务', exact: true }).click();
    await lab.getByRole('button', { name: '开始执行', exact: true }).click();
    await expect(lab.getByRole('button', { name: '取消任务', exact: true })).toBeEnabled();
    await arm(page, { kind: 'cancel', commit });
    await lab.getByRole('button', { name: '取消任务', exact: true }).click();
    await timedOut(page, lab);
    await expect(fact(lab, '取消确认')).toHaveText('取消未确认，请查询任务状态');
    await expect(authority).not.toContainText('cancelled');
    expect(await mutations(page, 'cancel')).toHaveLength(1);
    await query.click();
    await expect(lab).toHaveAttribute('aria-busy', 'false');
    await expect(fact(lab, '取消确认')).toHaveText(
      commit ? '服务端已确认取消' : '取消未确认，请查询任务状态',
    );
    if (commit) await expect(authority).toContainText('cancelled');
    else await expect(authority).not.toContainText('cancelled');
    expect(await mutations(page, 'cancel')).toHaveLength(1);
  });
}

test('ordinary request timeout also bounds the Pages fixture reset', async ({ page }) => {
  test.skip(!pages, 'The reset request belongs to the Pages memory fixture.');
  const { lab, taskInput, query } = await open(page);
  await lab.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(lab.getByRole('button', { name: '开始执行', exact: true })).toBeEnabled();
  const taskId = await taskInput.inputValue();
  await arm(page, { kind: 'reset' });
  await lab.getByRole('button', { name: '重置内存样本', exact: true }).click();
  await lab.getByRole('button', { name: '确认重置内存样本', exact: true }).click();
  await timedOut(page, lab);
  await expect(taskInput).toHaveValue(taskId);
  await expect(lab.getByRole('status')).not.toContainText('内存样本已重置');
  await query.click();
  await expect(lab.getByRole('alert')).toContainText('未找到任务');
});
