import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createServer } from '../../server';
import { loadRuntimeConfig } from '../../config/runtime';
import { applyA2uiMessages, resolveA2uiAction } from '../../shared/a2ui';
import { workflowForm } from '../../shared/labs/enrollment-workflow/surface';
import { createWorkflowStaticHandler } from '../../shared/labs/enrollment-workflow/static';
import { WORKFLOW_API, type WorkflowFacts } from '../../shared/labs/enrollment-workflow/contract';
import type { ApprovalCommand } from '../../shared/labs/human-approval/types';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function start(dataDir: string) {
  const app = createServer({ ...loadRuntimeConfig(), dataDir });
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    app.locals.closeLabs();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  cleanups.push(close);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
}
const headers = {
  'Content-Type': 'application/json',
  'X-Teaching-Session': 'http-workflow-session',
};

it('rejects malformed JSON through the real application with the same contract as Pages', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'workflow-malformed-'));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const { origin } = await start(dataDir);
  const response = await fetch(`${origin}${WORKFLOW_API}/commands`, {
    method: 'POST',
    headers,
    body: '{',
  });
  expect(response.status).toBe(400);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = await response.json();
  expect(body).toEqual({
    status: 'rejected',
    code: 'INVALID_INPUT',
    reason: '请求正文必须是有效 JSON。',
  });
  const pages = await createWorkflowStaticHandler()(`${WORKFLOW_API}/commands`, {
    method: 'POST',
    headers,
    body: '{',
  });
  expect(pages?.status).toBe(response.status);
  expect(await pages?.json()).toEqual(body);
});

it('HTTP restarts restore waiting and committed facts, with one enrollment after dropped response and exact retry', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'workflow-http-'));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const first = await start(dataDir);
  const taskId = 'http-workflow-task';
  const action = resolveA2uiAction(applyA2uiMessages(null, workflowForm(null, taskId))!, 'submit');
  const propose: ApprovalCommand = {
    taskId,
    commandId: 'http-propose',
    expectedVersion: 0,
    payload: {
      type: 'propose',
      validity: 'standard',
      input: { attendeeName: '示例学员', workshopId: 'agent-ui-basics', seats: 1 },
    },
  };
  async function post(origin: string, command: ApprovalCommand, drop = false, form?: unknown) {
    return fetch(`${origin}${WORKFLOW_API}/commands`, {
      method: 'POST',
      headers: { ...headers, ...(drop ? { 'X-Workflow-Drop-Response': '1' } : {}) },
      body: JSON.stringify({ command, ...(form ? { action: form } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
  }
  async function facts(origin: string): Promise<WorkflowFacts> {
    const response = await fetch(`${origin}${WORKFLOW_API}/facts?taskId=${taskId}`, { headers });
    expect(response.status).toBe(200);
    return response.json();
  }
  expect((await post(first.origin, propose, false, action)).status).toBe(200);
  const waiting = await facts(first.origin);
  await first.close();
  const second = await start(dataDir);
  expect(await facts(second.origin)).toMatchObject({ task: waiting.task, events: waiting.events });
  const approve: ApprovalCommand = {
    taskId,
    commandId: 'http-approve',
    expectedVersion: waiting.task.version,
    payload: {
      type: 'approve',
      proposalId: waiting.task.state.proposal.proposalId,
      proposalVersion: waiting.task.state.proposal.proposalVersion,
    },
  };
  await expect(post(second.origin, approve, true)).rejects.toThrow();
  const committed = await facts(second.origin);
  expect(committed.recordCount).toBe(1);
  await second.close();
  const third = await start(dataDir);
  expect(await facts(third.origin)).toMatchObject({
    task: committed.task,
    events: committed.events,
    enrollment: committed.enrollment,
    recordCount: 1,
  });
  const replay = await post(third.origin, approve);
  expect(await replay.json()).toMatchObject({
    status: 'accepted',
    replayed: true,
    result: { enrollment: committed.enrollment },
  });
  const after = await facts(third.origin);
  expect(after.events).toEqual(committed.events);
  expect(after.enrollment?.enrollmentId).toBe(committed.enrollment?.enrollmentId);
  const foreign = await fetch(`${third.origin}${WORKFLOW_API}/facts?taskId=${taskId}`, {
    headers: { ...headers, 'X-Teaching-Session': 'different-session' },
  });
  expect(foreign.status).toBe(403);
});
