import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EventType } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRecoveryRouter } from '../../server/labs/task-recovery';
import { createSqliteRecoveryStore } from '../../server/labs/task-recovery/store';
import { openLabDatabase, type LabDatabase } from '../../server/storage/sqlite';
import {
  RECOVERY_API,
  type RecoveryEvent,
  type RecoveryReadResult,
  type RecoveryTask,
} from '../../shared/labs/task-recovery/contract';
import { reduceRecoveryState } from '../../shared/labs/task-recovery/engine';
import { createSseDecoder, consumeSse } from '../../shared/sse';

const instances: Array<{
  server: Server;
  adapter: ReturnType<typeof createTaskRecoveryRouter>;
  database: LabDatabase;
  dataDir: string;
}> = [];

async function startServer(stepDelayMs = 15, outerParser = true) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'task-recovery-http-'));
  const database = openLabDatabase({ dataDir });
  const adapter = createTaskRecoveryRouter({ database, stepDelayMs });
  const app = express();
  if (outerParser) app.use(express.json({ limit: '128kb' }));
  app.use(RECOVERY_API, adapter.router);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  instances.push({ server, adapter, database, dataDir });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${RECOVERY_API}`;
  return { base, adapter, database, server };
}

afterEach(async () => {
  for (const { server, adapter, database, dataDir } of instances.splice(0)) {
    adapter.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function post(base: string, pathname: string, input: unknown) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function createTask(base: string, taskId = 'task_one', threadId = 'thread_one') {
  const response = await post(base, '/tasks', { taskId, threadId, commandId: `create_${taskId}` });
  expect(response.status).toBe(200);
  return ((await response.json()) as { task: RecoveryTask }).task;
}

function eventUrl(base: string, taskId: string, runId: string, afterSeq = 0) {
  return `${base}/tasks/${taskId}/events?runId=${runId}&afterSeq=${afterSeq}`;
}

async function getTask(base: string, taskId = 'task_one'): Promise<RecoveryTask> {
  return (await (await fetch(`${base}/tasks/${taskId}`)).json()).task;
}

async function begin(base: string, task: RecoveryTask, runId = 'run_one') {
  const command = {
    taskId: task.taskId,
    commandId: `start_${runId}`,
    expectedVersion: task.version,
    payload: { type: 'start', runId },
  };
  const response = await post(base, `/tasks/${task.taskId}/commands`, command);
  expect(response.status).toBe(200);
  return { command, accepted: await response.json() };
}

async function partialStream(base: string, runId: string, stopAt: number) {
  const response = await fetch(`${base}/tasks/task_one/events?runId=${runId}&afterSeq=0`, {
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const events: RecoveryEvent[] = [];
  const decoder = new TextDecoder();
  const parser = createSseDecoder((value) => events.push(value as RecoveryEvent));
  try {
    while ((events.at(-1)?.seq ?? 0) < stopAt) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Stream closed before the requested event.');
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return events;
}

async function streamToEnd(base: string, runId: string, afterSeq: number, taskId = 'task_one') {
  const response = await fetch(
    `${base}/tasks/${taskId}/events?runId=${runId}&afterSeq=${afterSeq}`,
    {
      headers: { 'Last-Event-ID': 'ignored_run:99999' },
      signal: AbortSignal.timeout(5_000),
    },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const raw = await response.text();
  const events: RecoveryEvent[] = [];
  for (const frame of raw.split(/\r?\n\r?\n/u).filter(Boolean)) {
    const lines = frame.split(/\r?\n/u);
    const event = JSON.parse(
      lines.find((line) => line.startsWith('data: '))!.slice(6),
    ) as RecoveryEvent;
    expect(lines.find((line) => line.startsWith('id: '))).toBe(`id: ${event.runId}:${event.seq}`);
    expect(EventSchemas.parse(event.payload)).toEqual(event.payload);
    expect(event.payload).not.toHaveProperty('seq');
    events.push(event);
  }
  return events;
}

function assertRecovery(result: RecoveryReadResult) {
  expect(result.persistence).toBe('sqlite');
  expect(result.task.version).toBe(result.checkpoint.task.version + result.events.length);
  expect(result.events.map((event) => event.seq)).toEqual(
    result.events.map((_event, index) => result.checkpoint.cursor.afterSeq + index + 1),
  );
  expect(
    result.events.reduce(
      (state, event) => reduceRecoveryState(state, event.payload),
      result.checkpoint.task.state,
    ),
  ).toEqual(result.task.state);
}

describe('persistent task recovery HTTP API', () => {
  it('continues after a real SSE disconnect and recovers without repeating tools or changing terminal data', async () => {
    const { base } = await startServer(30);
    const task = await createTask(base);
    const queued = (await (
      await fetch(`${base}/tasks/task_one/recovery`)
    ).json()) as RecoveryReadResult;
    expect(queued.checkpoint.cursor).toEqual({ runId: '', afterSeq: 0 });
    assertRecovery(queued);
    const { command, accepted } = await begin(base, task);
    const prefix = await partialStream(base, 'run_one', 5);
    const disconnected = await getTask(base);
    expect(disconnected.status).toBe('running');
    expect(disconnected.state.toolExecutionCount).toBe(0);
    // No SSE subscriber remains while the timer continues the task.
    await delay(90);
    const recovered = (await (
      await fetch(`${base}/tasks/task_one/recovery`)
    ).json()) as RecoveryReadResult;
    assertRecovery(recovered);
    expect(recovered.task.version).toBeGreaterThan(disconnected.version);
    const suffix = await streamToEnd(base, 'run_one', prefix.at(-1)!.seq);
    const all = [...prefix, ...suffix];
    expect(all).toHaveLength(13);
    expect(all.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(all[0].payload.type).toBe(EventType.RUN_STARTED);
    expect(all.at(-1)!.payload.type).toBe(EventType.RUN_FINISHED);
    expect(all.filter((event) => event.payload.type === EventType.TOOL_CALL_RESULT)).toHaveLength(
      1,
    );
    const final = await getTask(base);
    expect(final).toMatchObject({ status: 'succeeded', state: { toolExecutionCount: 1 } });
    expect(final.state.cards).toHaveLength(2);
    expect(final.state.text).toContain('本地任务样本');
    const replay = await (
      await fetch(`${base}/tasks/task_one/replay?runId=run_one&afterSeq=0`)
    ).json();
    expect(replay.events).toEqual(all);
    expect(await streamToEnd(base, 'run_one', 13)).toEqual([]);
    assertRecovery(
      (await (await fetch(`${base}/tasks/task_one/recovery`)).json()) as RecoveryReadResult,
    );
    const duplicate = await post(base, '/tasks/task_one/commands', command);
    expect(await duplicate.json()).toEqual(accepted);
    expect(await getTask(base)).toEqual(final);
  });

  it('confirms cancellation with a terminal event and keeps old streams pinned across retry', async () => {
    const { base } = await startServer(60_000);
    const task = await createTask(base);
    const { accepted } = await begin(base, task);
    const stream = fetch(eventUrl(base, task.taskId, 'run_one'), {
      signal: AbortSignal.timeout(5_000),
    });
    const oldResponse = await stream;
    const command = {
      taskId: task.taskId,
      commandId: 'cancel_one',
      expectedVersion: accepted.version,
      payload: { type: 'cancel' },
    };
    const cancelled = await post(base, '/tasks/task_one/commands', command);
    expect(cancelled.status).toBe(200);
    const receipt = await cancelled.json();
    expect(receipt).toMatchObject({
      status: 'accepted',
      version: accepted.version + 1,
      result: { status: 'cancelled', state: { status: 'cancelled', toolExecutionCount: 0 } },
    });
    const oldEvents: RecoveryEvent[] = [];
    const oldEnded = consumeSse(oldResponse, (event) => oldEvents.push(event as RecoveryEvent));
    const retry = await post(base, '/tasks/task_one/commands', {
      taskId: task.taskId,
      commandId: 'retry_one',
      expectedVersion: receipt.version,
      payload: { type: 'retry', runId: 'run_two' },
    });
    expect(retry.status).toBe(200);
    const retried = await retry.json();
    expect(retried).toMatchObject({
      status: 'accepted',
      version: receipt.version + 2,
      result: { status: 'running', currentRunId: 'run_two' },
    });
    await oldEnded;
    expect(oldEvents.map((event) => [event.runId, event.seq])).toEqual([
      ['run_one', 1],
      ['run_one', 2],
    ]);
    expect(oldEvents.at(-1)?.payload).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
    });
    for (const event of oldEvents) expect(EventSchemas.parse(event.payload)).toEqual(event.payload);
    expect(await streamToEnd(base, 'run_one', 0)).toEqual(oldEvents);
    expect(await streamToEnd(base, 'run_one', 2)).toEqual([]);
    const repeated = await post(base, '/tasks/task_one/commands', command);
    expect(await repeated.json()).toEqual(receipt);
    expect(await getTask(base)).toEqual(retried.result);
    const recovery = (await (
      await fetch(`${base}/tasks/task_one/recovery`)
    ).json()) as RecoveryReadResult;
    expect(recovery.checkpoint.cursor).toEqual({ runId: 'run_two', afterSeq: 1 });
    assertRecovery(recovery);
    const nextCancel = await post(base, '/tasks/task_one/commands', {
      ...command,
      commandId: 'cancel_two',
      expectedVersion: retried.version,
    });
    const terminal = await nextCancel.json();
    expect(terminal.result.status).toBe('cancelled');
    const reusedRun = await post(base, '/tasks/task_one/commands', {
      taskId: task.taskId,
      commandId: 'reuse_old_run',
      expectedVersion: terminal.version,
      payload: { type: 'retry', runId: 'run_one' },
    });
    expect(reusedRun.status).toBe(400);
    expect(
      (
        await post(base, '/tasks/task_one/commands', {
          ...command,
          commandId: 'cancel_terminal',
          expectedVersion: terminal.version,
        })
      ).status,
    ).toBe(400);
  });

  it('stops timers and active streams on close while leaving task facts and caller database intact', async () => {
    const { base, adapter, database } = await startServer(15);
    const task = await createTask(base);
    await begin(base, task);
    const response = await fetch(eventUrl(base, task.taskId, 'run_one'), {
      signal: AbortSignal.timeout(5_000),
    });
    adapter.close();
    adapter.close();
    const otherStore = createSqliteRecoveryStore(database);
    const stopped = otherStore.readRecovery(task.taskId);
    const persisted = await otherStore.replay({ runId: 'run_one', afterSeq: 0 });
    const events: RecoveryEvent[] = [];
    await consumeSse(response, (event) => events.push(event as RecoveryEvent));
    expect(events).toEqual(persisted);
    expect(stopped.task.status).toBe('running');
    await delay(45);
    expect(otherStore.readRecovery(task.taskId)).toEqual(stopped);
    expect(await otherStore.replay({ runId: 'run_one', afterSeq: 0 })).toEqual(persisted);
    expect((await fetch(`${base}/tasks/task_one`)).status).toBe(503);
  });

  it('rejects a command whose request body finishes after the adapter closes', async () => {
    const { base, adapter, database, server } = await startServer(1, false);
    const task = await createTask(base);
    const store = createSqliteRecoveryStore(database);
    const command = JSON.stringify({
      taskId: task.taskId,
      commandId: 'start_after_close',
      expectedVersion: task.version,
      payload: { type: 'start', runId: 'closed_run' },
    });
    let closedDuringBody = false;
    server.once('request', (incoming) => {
      incoming.once('data', () => {
        closedDuringBody = true;
        adapter.close();
      });
    });
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(`${base}/tasks/${task.taskId}/commands`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(command),
          },
        });
        request.on('error', reject);
        request.on('response', (result) => {
          let body = '';
          result.setEncoding('utf8');
          result.on('data', (chunk: string) => {
            body += chunk;
          });
          result.on('error', reject);
          result.on('end', () => resolve({ status: result.statusCode, body }));
        });
        request.setTimeout(5_000, () => request.destroy(new Error('Request body timed out.')));
        request.write(command.slice(0, 1));
        void (async () => {
          await expect.poll(() => closedDuringBody).toBe(true);
          expect(store.getSync(task.taskId)).toEqual(task);
          request.end(command.slice(1));
        })().catch((error: Error) => request.destroy(error));
      },
    );
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'Task recovery adapter is closed.' });
    await delay(30);
    expect(store.readRecovery(task.taskId)).toMatchObject({ task, events: [] });
    expect(database.db.prepare('SELECT COUNT(*) AS count FROM recovery_runs').get()?.count).toBe(0);
  });

  it('rejects foreign, malformed and future cursors before opening HTTP or SSE responses', async () => {
    const { base } = await startServer(60_000);
    const task = await createTask(base);
    await begin(base, task);
    await createTask(base, 'task_two');
    for (const endpoint of ['events', 'replay']) {
      for (const query of [
        'runId=missing&afterSeq=0',
        'runId=run_one&afterSeq=2',
        'runId=run_one&afterSeq=-1',
        'runId=run_one&afterSeq=1.5',
        'runId=run_one&afterSeq=9007199254740992',
        'runId=run_one&afterSeq=1e0',
        'runId=run_one&afterSeq=0&afterSeq=1',
        'runId=run_one',
      ]) {
        const response = await fetch(`${base}/tasks/task_one/${endpoint}?${query}`);
        expect(response.status, query).toBe(400);
        expect(response.headers.get('content-type')).toContain('application/json');
        await response.json();
      }
      expect(
        (await fetch(`${base}/tasks/task_two/${endpoint}?runId=run_one&afterSeq=0`)).status,
      ).toBe(400);
    }
    const snapshot = (await (
      await fetch(`${base}/tasks/task_one/recovery`)
    ).json()) as RecoveryReadResult;
    expect(snapshot.checkpoint.cursor).toEqual({ runId: 'run_one', afterSeq: 1 });
    expect(snapshot.events).toEqual([]);
    assertRecovery(snapshot);
  });
  it('retries completed tasks with a reset projection and one new tool effect while preserving the previous run', async () => {
    const { base } = await startServer(2);
    const task = await createTask(base);
    await begin(base, task);
    const firstEvents = await streamToEnd(base, 'run_one', 0);
    const completed = await getTask(base);
    expect(completed.state.toolExecutionCount).toBe(1);
    const response = await post(base, '/tasks/task_one/commands', {
      taskId: task.taskId,
      commandId: 'retry_completed',
      expectedVersion: completed.version,
      payload: { type: 'retry', runId: 'run_second' },
    });
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt.result).toMatchObject({
      status: 'running',
      currentRunId: 'run_second',
      state: {
        text: '',
        messageId: null,
        cards: [],
        toolCallId: null,
        toolStatus: 'idle',
        toolExecutionCount: 1,
      },
    });
    const secondEvents = await streamToEnd(base, 'run_second', 0);
    expect(secondEvents).toHaveLength(13);
    expect(secondEvents[1].payload).toMatchObject({
      type: EventType.STATE_SNAPSHOT,
      snapshot: { toolExecutionCount: 1 },
    });
    expect(secondEvents.at(-1)?.seq).toBe(13);
    const final = await getTask(base);
    expect(final).toMatchObject({
      status: 'succeeded',
      state: { toolExecutionCount: 2, toolCallId: 'run_second_tool' },
    });
    expect(final.state.cards[0].id).toBe('run_second_card_1');
    expect(await streamToEnd(base, 'run_one', 0)).toEqual(firstEvents);
    expect(await getTask(base)).toEqual(final);
  });

  it('preserves original conflict and rejected responses after the task version changes', async () => {
    const { base } = await startServer(60_000);
    const task = await createTask(base);
    const rejected = {
      taskId: task.taskId,
      commandId: 'rejected_cancel',
      expectedVersion: task.version,
      payload: { type: 'cancel' },
    };
    const rejectResponse = await post(base, '/tasks/task_one/commands', rejected);
    expect(rejectResponse.status).toBe(400);
    const rejection = await rejectResponse.json();
    const { accepted } = await begin(base, task);
    const conflict = { ...rejected, commandId: 'conflict_cancel' };
    const conflictResponse = await post(base, '/tasks/task_one/commands', conflict);
    expect(conflictResponse.status).toBe(409);
    const conflictReceipt = await conflictResponse.json();
    expect(
      (
        await post(base, '/tasks/task_one/commands', {
          ...rejected,
          commandId: 'accepted_cancel',
          expectedVersion: accepted.version,
        })
      ).status,
    ).toBe(200);
    const repeatRejected = await post(base, '/tasks/task_one/commands', rejected);
    expect(repeatRejected.status).toBe(400);
    expect(await repeatRejected.json()).toEqual(rejection);
    const repeatConflict = await post(base, '/tasks/task_one/commands', conflict);
    expect(repeatConflict.status).toBe(409);
    expect(await repeatConflict.json()).toEqual(conflictReceipt);
    expect(
      (
        await post(base, '/tasks/task_one/commands', {
          ...rejected,
          commandId: 'create_task_one',
        })
      ).status,
    ).toBe(400);
    const repeatedCreate = await post(base, '/tasks', {
      taskId: task.taskId,
      threadId: task.threadId,
      commandId: 'create_task_one',
    });
    expect(await repeatedCreate.json()).toEqual({ task, persistence: 'sqlite' });
  });

  it('checks accepted command idempotency before CAS and requires a globally new run', async () => {
    const { base } = await startServer(60_000);
    const task = await createTask(base);
    const command = {
      taskId: task.taskId,
      commandId: 'start_one',
      expectedVersion: task.version,
      payload: { type: 'start', runId: 'run_one' },
    };
    const started = await post(base, `/tasks/${task.taskId}/commands`, command);
    expect(started.status).toBe(200);
    const accepted = await started.json();
    expect(accepted).toMatchObject({
      status: 'accepted',
      version: task.version + 2,
      result: { status: 'running', currentRunId: 'run_one' },
    });
    const duplicate = await post(base, `/tasks/${task.taskId}/commands`, {
      payload: { runId: 'run_one', type: 'start' },
      expectedVersion: task.version,
      commandId: 'start_one',
      taskId: task.taskId,
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(accepted);
    const reused = await post(base, `/tasks/${task.taskId}/commands`, {
      ...command,
      payload: { type: 'start', runId: 'different_run' },
    });
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ status: 'rejected' });
    const stale = await post(base, `/tasks/${task.taskId}/commands`, {
      ...command,
      commandId: 'stale_cancel',
      payload: { type: 'cancel' },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ status: 'conflict', version: accepted.version });
    const other = await createTask(base, 'task_two');
    const collision = await post(base, '/tasks/task_two/commands', {
      commandId: 'collision',
      taskId: other.taskId,
      expectedVersion: other.version,
      payload: { type: 'start', runId: 'run_one' },
    });
    expect(collision.status).toBe(400);
    for (const payload of [
      { type: 'start', runId: 'extra_run' },
      { type: 'retry', runId: 'retry_running' },
    ]) {
      expect(
        (
          await post(base, '/tasks/task_one/commands', {
            taskId: task.taskId,
            commandId: `invalid_${payload.type}`,
            expectedVersion: accepted.version,
            payload,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await post(base, '/tasks/task_two/commands', {
          taskId: other.taskId,
          commandId: 'cancel_queued',
          expectedVersion: other.version,
          payload: { type: 'cancel' },
        })
      ).status,
    ).toBe(400);
    const wrongTask = await post(base, '/tasks/task_two/commands', command);
    expect(wrongTask.status).toBe(400);
    const running = await (await fetch(`${base}/tasks/${task.taskId}`)).json();
    expect(running.task).toEqual(accepted.result);
  });
  it('creates queued tasks idempotently, rejects reused inputs and lists only their thread', async () => {
    const { base } = await startServer();
    const task = await createTask(base);
    expect(task).toMatchObject({
      taskId: 'task_one',
      threadId: 'thread_one',
      currentRunId: null,
      status: 'queued',
      state: { status: 'queued', toolExecutionCount: 0 },
    });
    const repeated = await post(base, '/tasks', {
      commandId: 'create_task_one',
      threadId: 'thread_one',
      taskId: 'task_one',
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ task, persistence: 'sqlite' });
    const changed = await post(base, '/tasks', {
      commandId: 'create_task_one',
      threadId: 'thread_other',
      taskId: 'task_one',
    });
    expect(changed.status).toBe(409);
    await createTask(base, 'task_two', 'thread_other');
    expect(await (await fetch(`${base}/tasks?threadId=thread_one`)).json()).toEqual({
      tasks: [task],
      persistence: 'sqlite',
    });
    expect(await (await fetch(`${base}/tasks/task_one`)).json()).toEqual({
      task,
      persistence: 'sqlite',
    });
    expect((await fetch(`${base}/tasks/missing`)).status).toBe(404);
    expect((await fetch(`${base}/tasks?threadId=bad%20id`)).status).toBe(400);
    expect((await post(base, '/tasks', { taskId: 'invalid' })).status).toBe(400);
  });
});
