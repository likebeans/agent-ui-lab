import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { EventType } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  RecoveryEvent,
  RecoveryReadResult,
  RecoveryTask,
} from '../../shared/labs/task-recovery/contract';
import { createSseDecoder, consumeSse } from '../../shared/sse';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = fileURLToPath(new URL('./task-recovery-process.fixture.ts', import.meta.url));
const children = new Set<ChildProcess>();
const directories = new Set<string>();

async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}

async function launch(dataDir: string, stepDelayMs: number) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fixture, dataDir, String(stepDelayMs)],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  children.add(child);
  let diagnostic = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    diagnostic += chunk.toString();
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    diagnostic += chunk.toString();
  });
  const ready = await new Promise<{ base: string; pid: number }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Process did not start: ${diagnostic}`)),
      10_000,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('error', failed);
      child.off('exit', exited);
      child.off('message', message);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Process exited (${code ?? signal}): ${diagnostic}`));
    };
    const message = (value: unknown) => {
      if (value === null || typeof value !== 'object') return;
      const candidate = value as { type?: unknown; base?: unknown; pid?: unknown };
      if (
        candidate.type === 'ready' &&
        typeof candidate.base === 'string' &&
        typeof candidate.pid === 'number'
      ) {
        cleanup();
        resolve({ base: candidate.base, pid: candidate.pid });
      }
    };
    child.on('error', failed);
    child.on('exit', exited);
    child.on('message', message);
  });
  expect(ready.pid).toBe(child.pid);
  expect(ready.pid).not.toBe(process.pid);
  return { child, ...ready };
}

afterEach(async () => {
  await Promise.all([...children].map((child) => stop(child)));
  children.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

async function post(base: string, pathname: string, input: unknown) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function readTask(base: string): Promise<RecoveryTask> {
  return (await (await fetch(`${base}/tasks/process_task`)).json()).task;
}

async function replay(base: string): Promise<RecoveryEvent[]> {
  return (
    await (await fetch(`${base}/tasks/process_task/replay?runId=process_run&afterSeq=0`)).json()
  ).events;
}

async function collect(base: string, afterSeq = 0) {
  const events: RecoveryEvent[] = [];
  await consumeSse(
    await fetch(`${base}/tasks/process_task/events?runId=process_run&afterSeq=${afterSeq}`, {
      signal: AbortSignal.timeout(8_000),
    }),
    (value) => events.push(value as RecoveryEvent),
  );
  return events;
}

async function stopAt(base: string, child: ChildProcess, target: EventType) {
  const response = await fetch(`${base}/tasks/process_task/events?runId=process_run&afterSeq=0`, {
    signal: AbortSignal.timeout(8_000),
  });
  const reader = response.body!.getReader();
  const text = new TextDecoder();
  let killed = false;
  const parser = createSseDecoder((value) => {
    const event = value as RecoveryEvent;
    if (!killed && event.payload.type === target) {
      killed = true;
      child.kill('SIGKILL');
    }
  });
  const exited = once(child, 'exit');
  try {
    while (!killed) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Process stream ended before the kill point.');
      parser.push(text.decode(value, { stream: true }));
    }
    await exited;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

describe('task recovery across actual server processes', () => {
  it.each([
    ['before the tool effect', EventType.TEXT_MESSAGE_CONTENT, 0],
    ['after the tool effect commits', EventType.TOOL_CALL_RESULT, 1],
  ] as const)(
    'continues %s from durable events without repeating completed effects',
    async (_label, target, count) => {
      const dataDir = mkdtempSync(path.join(tmpdir(), 'task-recovery-process-'));
      directories.add(dataDir);
      const first = await launch(dataDir, 140);
      const created = await post(first.base, '/tasks', {
        taskId: 'process_task',
        threadId: 'process_thread',
        commandId: 'process_create',
      });
      expect(created.status).toBe(200);
      const task = (await created.json()).task as RecoveryTask;
      const start = {
        taskId: task.taskId,
        commandId: 'process_start',
        expectedVersion: task.version,
        payload: { type: 'start', runId: 'process_run' },
      };
      const receipt = await post(first.base, '/tasks/process_task/commands', start);
      expect(receipt.status).toBe(200);
      const accepted = await receipt.json();
      await stopAt(first.base, first.child, target);
      expect(first.child.signalCode).toBe('SIGKILL');

      // A second, independent Node process opens the same persisted WAL database.
      const inspection = await launch(dataDir, 60_000);
      expect(inspection.pid).not.toBe(first.pid);
      const resumedTask = await readTask(inspection.base);
      expect(resumedTask).toMatchObject({
        status: 'running',
        state: { toolExecutionCount: count },
      });
      const prefix = await replay(inspection.base);
      expect(prefix.at(-1)?.payload.type).toBe(target);
      expect(
        prefix.filter((event) => event.payload.type === EventType.TOOL_CALL_RESULT),
      ).toHaveLength(count);
      const checkpoint = (await (
        await fetch(`${inspection.base}/tasks/process_task/recovery`)
      ).json()) as RecoveryReadResult;
      expect(checkpoint.task).toEqual(resumedTask);
      expect(checkpoint.task.version - checkpoint.checkpoint.task.version).toBe(
        checkpoint.events.length,
      );
      await stop(inspection.child);

      const remaining = await launch(dataDir, 8);
      const suffix = await collect(remaining.base, prefix.at(-1)!.seq);
      const completed = await readTask(remaining.base);
      expect(completed).toMatchObject({
        status: 'succeeded',
        state: { toolExecutionCount: 1, toolStatus: 'completed' },
      });
      expect(completed.state.cards).toHaveLength(2);
      expect(suffix[0].seq).toBe(prefix.at(-1)!.seq + 1);
      const all = await replay(remaining.base);
      expect(all).toEqual([...prefix, ...suffix]);
      expect(all).toHaveLength(13);
      expect(all.filter((event) => event.payload.type === EventType.TOOL_CALL_RESULT)).toHaveLength(
        1,
      );
      const duplicate = await post(remaining.base, '/tasks/process_task/commands', start);
      expect(await duplicate.json()).toEqual(accepted);
      expect(await readTask(remaining.base)).toEqual(completed);
      await stop(remaining.child);

      const terminal = await launch(dataDir, 1);
      expect(await readTask(terminal.base)).toEqual(completed);
      expect(await replay(terminal.base)).toEqual(all);
      expect(await collect(terminal.base, 13)).toEqual([]);
      await delay(30);
      expect(await readTask(terminal.base)).toEqual(completed);
      expect(await replay(terminal.base)).toEqual(all);
    },
    20_000,
  );
});
