import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../../config/runtime';
import { createServer } from '../../server';
import { openLabDatabase } from '../../server/storage/sqlite';
import {
  APPROVAL_API,
  TEACHING_SESSION_HEADER,
  type ApprovalTask,
} from '../../shared/labs/human-approval/types';
import { RECOVERY_API } from '../../shared/labs/task-recovery/contract';
import { staticFetch } from '../../shared/static-api';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function directory() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'lab-integration-'));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function start(dataDir: string) {
  const app = createServer({ ...loadRuntimeConfig(), dataDir });
  const server = createHttpServer(app);
  let stopped = false;
  const close = async () => {
    if (stopped) return;
    stopped = true;
    app.locals.closeLabs();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  cleanups.push(close);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
}

async function post(origin: string, pathname: string, value: unknown) {
  const response = await fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TEACHING_SESSION_HEADER]: 'joint-session' },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function facts(origin: string) {
  const response = await fetch(`${origin}${APPROVAL_API}/facts?taskId=shared_task`, {
    headers: { [TEACHING_SESSION_HEADER]: 'joint-session' },
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function recoveryTask(origin: string) {
  const response = await fetch(`${origin}${RECOVERY_API}/tasks/shared_task`);
  expect(response.status).toBe(200);
  return (await response.json()).task;
}

describe('registered lab integration', () => {
  it('runs recovery and approval in one database, closes live streams, and restores both on restart', async () => {
    const dataDir = directory();
    const first = await start(dataDir);
    const created = await post(first.origin, `${RECOVERY_API}/tasks`, {
      taskId: 'shared_task',
      threadId: 'joint_thread',
      commandId: 'create_task',
    });
    await post(first.origin, `${RECOVERY_API}/tasks/shared_task/commands`, {
      taskId: 'shared_task',
      commandId: 'start_task',
      expectedVersion: created.task.version,
      payload: { type: 'start', runId: 'joint_run' },
    });
    const proposed = await post(first.origin, `${APPROVAL_API}/commands`, {
      taskId: 'shared_task',
      commandId: 'create_task',
      expectedVersion: 0,
      payload: {
        type: 'propose',
        input: { attendeeName: '整合学习者', workshopId: 'agent-ui-basics', seats: 2 },
        validity: 'standard',
      },
    });
    const proposalTask: ApprovalTask = proposed.result.task;
    const approve = {
      taskId: proposalTask.taskId,
      commandId: 'approve_task',
      expectedVersion: proposalTask.version,
      payload: {
        type: 'approve',
        proposalId: proposalTask.state.proposal.proposalId,
        proposalVersion: proposalTask.state.proposal.proposalVersion,
      },
    };
    const receipt = await post(first.origin, `${APPROVAL_API}/commands`, approve);
    expect(receipt.status).toBe('accepted');
    expect(await facts(first.origin)).toMatchObject({ recordCount: 1, receipt: null });

    const response = await fetch(
      `${first.origin}${RECOVERY_API}/tasks/shared_task/events?runId=joint_run&afterSeq=0`,
      { signal: AbortSignal.timeout(10_000) },
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const stream = response.text();
    await expect
      .poll(async () => (await recoveryTask(first.origin)).state.toolExecutionCount, {
        timeout: 5_000,
        interval: 50,
      })
      .toBe(1);
    expect((await recoveryTask(first.origin)).status).toBe('running');
    await first.close();
    expect(await stream).toContain('joint_run');

    const second = await start(dataDir);
    await expect
      .poll(async () => (await recoveryTask(second.origin)).status, {
        timeout: 5_000,
        interval: 50,
      })
      .toBe('succeeded');
    expect(await recoveryTask(second.origin)).toMatchObject({
      currentRunId: 'joint_run',
      state: { toolExecutionCount: 1, cards: expect.any(Array) },
    });
    expect((await recoveryTask(second.origin)).state.cards).toHaveLength(2);
    expect(await facts(second.origin)).toMatchObject({
      recordCount: 1,
      task: { status: 'succeeded' },
      enrollment: { commandId: approve.commandId },
    });
    expect(await post(second.origin, `${APPROVAL_API}/commands`, approve)).toEqual({
      ...receipt,
      replayed: true,
    });
    expect((await facts(second.origin)).recordCount).toBe(1);
  }, 15_000);

  it('keeps caller-owned databases open after application cleanup and initialization failure', () => {
    const dataDir = directory();
    const database = openLabDatabase({ dataDir });
    cleanups.push(() => database.close());
    const config = { ...loadRuntimeConfig(), dataDir };
    const app = createServer(config, { database });
    app.locals.closeLabs();
    app.locals.closeLabs();
    const migrations = database.db
      .prepare('SELECT id FROM lab_migrations ORDER BY id')
      .all()
      .map((row) => row.id);
    expect(migrations).toContain('human-approval/001-initial');
    expect(migrations.some((id) => String(id).startsWith('task-recovery/'))).toBe(true);
    database.db
      .prepare('UPDATE lab_migrations SET checksum = ? WHERE id = ?')
      .run('changed', 'human-approval/001-initial');
    expect(() => createServer(config, { database })).toThrow(/changed/u);
    expect(database.db.prepare('SELECT 1 AS value').get()?.value).toBe(1);
  });

  it('preserves module JSON error contracts through the Pages dispatch entry point', async () => {
    const malformed = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    };
    const approval = await staticFetch(`${APPROVAL_API}/commands`, malformed);
    expect(approval.status).toBe(400);
    expect(await approval.json()).toMatchObject({ status: 'rejected', code: 'INVALID_INPUT' });
    const compatibility = await staticFetch('/api/labs/a2ui-compatibility/documents', malformed);
    expect(compatibility.status).toBe(400);
    expect(await compatibility.json()).toMatchObject({ kind: 'invalid' });
  });
});
