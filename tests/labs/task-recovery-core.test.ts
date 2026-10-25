import { EventType, type BaseEvent } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECOVERY_API,
  RECOVERY_STEP_DELAY_MS,
  initialRecoveryState,
  recoveryStateSchema,
  type RecoveryCheckpoint,
  type RecoveryCommand,
  type RecoveryCommandResult,
  type RecoveryEvent,
  type RecoveryProjection,
  type RecoveryReadResult,
  type RecoveryTask,
} from '../../shared/labs/task-recovery/contract';
import {
  deliverRecoveryEvent,
  projectionFromCheckpoint,
  recoverProjection,
} from '../../shared/labs/task-recovery/client';
import { recoveryPlan, reduceRecoveryState } from '../../shared/labs/task-recovery/engine';
import { createRecoveryFixture } from '../../shared/labs/task-recovery/memory';
import { consumeSse, createSseDecoder } from '../../shared/sse';

function queued(taskId = 'task_one'): RecoveryTask {
  return {
    taskId,
    threadId: 'thread_one',
    version: 1,
    status: 'queued',
    currentRunId: null,
    state: initialRecoveryState(),
  };
}

function recordedRun(runId = 'run_one', seed = queued()) {
  const initial: RecoveryTask = {
    ...seed,
    version: seed.version + 1,
    status: 'running',
    currentRunId: runId,
    state: {
      ...initialRecoveryState(),
      status: 'running',
      toolExecutionCount: seed.state.toolExecutionCount,
    },
  };
  const events: RecoveryEvent[] = recoveryPlan(initial, runId).map((payload, index) => ({
    taskId: seed.taskId,
    runId,
    seq: index + 1,
    payload,
  }));
  const tasks = [initial];
  for (const event of events) {
    const previous = tasks.at(-1)!;
    const state = reduceRecoveryState(previous.state, event.payload);
    tasks.push({ ...previous, version: previous.version + 1, status: state.status, state });
  }
  const checkpoint = (afterSeq: number): RecoveryCheckpoint => ({
    task: tasks[afterSeq],
    cursor: { runId, afterSeq },
  });
  const recovery = (afterSeq: number, authoritySeq = events.length): RecoveryReadResult => ({
    task: tasks[authoritySeq],
    checkpoint: checkpoint(afterSeq),
    events: events.slice(afterSeq, authoritySeq),
    persistence: 'memory-fixture',
  });
  return { events, tasks, checkpoint, recovery };
}

function apply(projection: RecoveryProjection, event: RecoveryEvent): RecoveryProjection {
  const outcome = deliverRecoveryEvent(projection, event);
  expect(outcome.type).toBe('applied');
  return outcome.projection;
}

describe('deterministic recovery plan and reducer', () => {
  it('emits thirteen official AG-UI records with real run/thread and no envelope fields', () => {
    const task = queued();
    const plan = recoveryPlan(task, 'run_one');
    expect(plan).toEqual(recoveryPlan(structuredClone(task), 'run_one'));
    expect(plan.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.STATE_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    expect(plan[0]).toMatchObject({ threadId: task.threadId, runId: 'run_one' });
    for (const event of plan) {
      expect(EventSchemas.parse(event)).toEqual(event);
      expect(event).not.toHaveProperty('seq');
      expect(event).not.toHaveProperty('taskId');
    }
    const final = plan.reduce(reduceRecoveryState, task.state);
    expect(final).toMatchObject({
      status: 'succeeded',
      toolStatus: 'completed',
      toolExecutionCount: 1,
    });
    expect(final.cards).toHaveLength(2);
    expect(final.text).toBe(
      plan
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => EventSchemas.parse(event))
        .map((event) => (event.type === EventType.TEXT_MESSAGE_CONTENT ? event.delta : ''))
        .join(''),
    );
    expect(task).toEqual(queued());
  });

  it('retains historical tool counts on retry and reproduces an already advanced current plan', () => {
    const first = recordedRun();
    const completed = first.tasks.at(-1)!;
    expect(recoveryPlan(completed, 'run_one')).toEqual(first.events.map((event) => event.payload));
    const second = recordedRun('run_two', completed);
    expect(second.tasks[1].state.toolExecutionCount).toBe(1);
    expect(second.events[1].payload).toMatchObject({ snapshot: { toolExecutionCount: 1 } });
    expect(second.tasks.at(-1)!.state.toolExecutionCount).toBe(2);
    expect(second.tasks.at(-1)!.state.messageId).not.toBe(completed.state.messageId);
    expect(second.tasks.at(-1)!.state.toolCallId).not.toBe(completed.state.toolCallId);
    expect(second.tasks.at(-1)!.state.cards[0].id).not.toBe(completed.state.cards[0].id);
    expect(recoveryPlan(second.tasks[11], 'run_two')).toEqual(
      second.events.map((event) => event.payload),
    );
  });

  it('accepts maximum-length run IDs and reduces cancellation without inventing a tool execution', () => {
    const run = recordedRun('r'.repeat(96));
    expect(recoveryStateSchema.parse(run.tasks.at(-1)!.state)).toEqual(run.tasks.at(-1)!.state);
    const cancelled = reduceRecoveryState(run.tasks[4].state, {
      type: EventType.RUN_FINISHED,
      threadId: 'thread_one',
      runId: 'r'.repeat(96),
      outcome: { type: 'cancelled' },
    } as BaseEvent);
    expect(cancelled).toMatchObject({ status: 'cancelled', toolExecutionCount: 0 });
    const error = reduceRecoveryState(run.tasks[1].state, {
      type: EventType.RUN_ERROR,
      message: 'local fixture failure',
    } as BaseEvent);
    expect(error.status).toBe('failed');
  });

  it('rejects invalid official payloads, unsupported events, foreign tool IDs and unsafe snapshots', () => {
    const run = recordedRun();
    expect(() =>
      reduceRecoveryState(run.tasks[3].state, {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'run_one_message',
        delta: 7,
      } as unknown as BaseEvent),
    ).toThrow();
    expect(() =>
      reduceRecoveryState(run.tasks[3].state, {
        type: EventType.CUSTOM,
        name: 'ignored',
        value: null,
      } as BaseEvent),
    ).toThrow();
    expect(() =>
      reduceRecoveryState(run.tasks[8].state, {
        type: EventType.TOOL_CALL_END,
        toolCallId: 'other_tool',
      } as BaseEvent),
    ).toThrow();
    expect(() =>
      reduceRecoveryState(run.tasks[1].state, {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { ...run.tasks[1].state, toolExecutionCount: 100 },
      } as BaseEvent),
    ).toThrow();
    expect(() => reduceRecoveryState(run.tasks[1].state, run.events.at(-1)!.payload)).toThrow();
    expect(() =>
      reduceRecoveryState(run.tasks[1].state, {
        type: EventType.STATE_SNAPSHOT,
        snapshot: {
          ...run.tasks[1].state,
          cards: [
            { id: 'same', title: 'one', detail: '' },
            { id: 'same', title: 'two', detail: '' },
          ],
        },
      } as BaseEvent),
    ).toThrow();
  });
});

describe('recovery delivery and checkpoint replay', () => {
  it('deduplicates every record including text fragments, tool results and snapshots', () => {
    const run = recordedRun();
    let projection = projectionFromCheckpoint(run.checkpoint(0));
    for (const event of run.events) {
      projection = apply(projection, event);
      const before = structuredClone(projection);
      const repeated = deliverRecoveryEvent(projection, structuredClone(event));
      expect(repeated).toEqual({ type: 'duplicate', projection });
      expect(repeated.projection).toBe(projection);
      expect(projection).toEqual(before);
    }
    expect(projection.state).toEqual(run.tasks.at(-1)!.state);
    expect(projection.state.cards).toHaveLength(2);
    expect(projection.state.toolExecutionCount).toBe(1);
  });

  it('keeps cursor and state on a gap, stale run or foreign task, then accepts the missing event', () => {
    const run = recordedRun();
    const projection = projectionFromCheckpoint(run.checkpoint(3));
    const gap = deliverRecoveryEvent(projection, run.events[4]);
    expect(gap).toEqual({ type: 'gap', projection, cursor: { runId: 'run_one', afterSeq: 3 } });
    expect(deliverRecoveryEvent(projection, { ...run.events[3], runId: 'old_run' })).toEqual({
      type: 'stale-run',
      projection,
    });
    expect(deliverRecoveryEvent(projection, { ...run.events[3], taskId: 'another_task' })).toEqual({
      type: 'foreign-task',
      projection,
    });
    expect(gap.projection).toBe(projection);
    expect(apply(projection, run.events[3]).state.text).toBe(run.tasks[4].state.text);
  });

  it('ignores a completed old run after retry without adding old text, cards or counts', () => {
    const first = recordedRun();
    const second = recordedRun('run_two', first.tasks.at(-1)!);
    const projection = projectionFromCheckpoint(second.checkpoint(1));
    for (const event of first.events) {
      const outcome = deliverRecoveryEvent(projection, event);
      expect(outcome.type).toBe('stale-run');
      expect(outcome.projection).toBe(projection);
    }
    expect(projection.state).toMatchObject({ text: '', cards: [], toolExecutionCount: 1 });
  });

  it('replays every checkpoint suffix to the same state, including retry counts', () => {
    const first = recordedRun();
    const second = recordedRun('run_two', first.tasks.at(-1)!);
    for (const run of [first, second]) {
      for (let cursor = 0; cursor <= run.events.length; cursor += 1) {
        const result = run.recovery(cursor);
        const before = structuredClone(result);
        expect(recoverProjection(result)).toEqual({
          taskId: result.task.taskId,
          runId: result.task.currentRunId,
          afterSeq: run.events.length,
          state: result.task.state,
        });
        expect(result).toEqual(before);
      }
    }
  });

  it('uses only the queued/null/zero empty-run sentinel', () => {
    const task = queued();
    const checkpoint = { task, cursor: { runId: '', afterSeq: 0 } };
    expect(
      recoverProjection({ task, checkpoint, events: [], persistence: 'memory-fixture' }),
    ).toEqual({ taskId: task.taskId, runId: '', afterSeq: 0, state: task.state });
    expect(() =>
      projectionFromCheckpoint({ ...checkpoint, cursor: { runId: task.taskId, afterSeq: 0 } }),
    ).toThrow();
    expect(() =>
      projectionFromCheckpoint({ ...checkpoint, cursor: { runId: '', afterSeq: 1 } }),
    ).toThrow();
    expect(() =>
      projectionFromCheckpoint({
        ...recordedRun().checkpoint(1),
        cursor: { runId: '', afterSeq: 1 },
      }),
    ).toThrow();
  });

  it('rejects missing tails even when omitted records would not alter reducer state', () => {
    const run = recordedRun();
    // TEXT_MESSAGE_END changes no fields, so state equality alone cannot detect this truncation.
    const result = run.recovery(6, 7);
    expect(result.task.state).toEqual(result.checkpoint.task.state);
    expect(() => recoverProjection({ ...result, events: [] })).toThrow(/不完整/);
    expect(() => recoverProjection({ ...run.recovery(4), events: run.events.slice(5) })).toThrow();
    const duplicate = run.recovery(4);
    duplicate.events[1] = duplicate.events[0];
    expect(() => recoverProjection(duplicate)).toThrow();
    const gap = run.recovery(4);
    gap.events[0] = { ...gap.events[0], seq: 6 };
    expect(() => recoverProjection(gap)).toThrow();
  });

  it('rejects task/run/thread mismatch, future checkpoints and authority divergence', () => {
    const run = recordedRun();
    for (const patch of [
      { taskId: 'another_task' },
      { threadId: 'another_thread' },
      { currentRunId: 'another_run' },
    ]) {
      const result = run.recovery(4);
      result.task = { ...result.task, ...patch };
      expect(() => recoverProjection(result)).toThrow();
    }
    const changedState = run.recovery(4);
    changedState.task = {
      ...changedState.task,
      state: { ...changedState.task.state, text: 'authority only' },
    };
    expect(() => recoverProjection(changedState)).toThrow(/权威任务状态/);
    const foreign = run.recovery(4);
    foreign.events[0] = { ...foreign.events[0], taskId: 'other_task' };
    expect(() => recoverProjection(foreign)).toThrow(/foreign-task/);
    const thread = run.recovery(12);
    thread.events[0] = {
      ...thread.events[0],
      payload: { ...thread.events[0].payload, threadId: 'other_thread' } as BaseEvent,
    };
    expect(() => recoverProjection(thread)).toThrow(/thread/);
    expect(() =>
      projectionFromCheckpoint({
        ...run.checkpoint(4),
        cursor: { runId: 'wrong_run', afterSeq: 4 },
      }),
    ).toThrow();
    expect(() =>
      projectionFromCheckpoint({
        ...run.checkpoint(4),
        cursor: { runId: 'run_one', afterSeq: 100 },
      }),
    ).toThrow();
  });

  it.each([
    { seq: 0 },
    { seq: -1 },
    { seq: 1.5 },
    { seq: Number.MAX_SAFE_INTEGER + 1 },
    { seq: '4' },
    {
      payload: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'run_one_message', delta: false },
    },
    { payload: { type: 'MADE_UP_EVENT' } },
    { extraEnvelopeField: true },
  ])('rejects invalid envelope or official payload %j without changing projection', (patch) => {
    const run = recordedRun();
    const projection = projectionFromCheckpoint(run.checkpoint(3));
    const before = structuredClone(projection);
    expect(() =>
      deliverRecoveryEvent(projection, { ...run.events[3], ...patch } as RecoveryEvent),
    ).toThrow();
    expect(projection).toEqual(before);
  });

  it('rejects a first event without RUN_STARTED and a second RUN_STARTED', () => {
    const run = recordedRun();
    expect(() =>
      deliverRecoveryEvent(projectionFromCheckpoint(run.checkpoint(0)), {
        ...run.events[1],
        seq: 1,
      }),
    ).toThrow(/RUN_STARTED/);
    expect(() =>
      deliverRecoveryEvent(projectionFromCheckpoint(run.checkpoint(1)), {
        ...run.events[0],
        seq: 2,
      }),
    ).toThrow(/RUN_STARTED/);
    expect(() =>
      deliverRecoveryEvent(projectionFromCheckpoint(run.checkpoint(0)), {
        ...run.events[0],
        payload: {
          type: EventType.RUN_STARTED,
          threadId: 'thread_one',
          runId: 'other_run',
        } as BaseEvent,
      }),
    ).toThrow(/envelope/);
  });
});

type Fixture = ReturnType<typeof createRecoveryFixture>;
const fixtures: Fixture[] = [];
function fixture(): Fixture {
  const instance = createRecoveryFixture();
  fixtures.push(instance);
  return instance;
}
function request(f: Fixture, path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  return f.handle(
    new Request(`https://fixture.example${RECOVERY_API}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    }),
  );
}
async function createTask(f: Fixture, taskId = 'task_one', threadId = 'thread_one') {
  const response = await request(f, '/tasks', 'POST', {
    taskId,
    threadId,
    commandId: `create_${taskId}`,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('X-Lab-Transport')).toBe('browser-memory');
  return ((await response.json()) as { task: RecoveryTask }).task;
}
async function readTask(f: Fixture, taskId = 'task_one') {
  return ((await (await request(f, `/tasks/${taskId}`)).json()) as { task: RecoveryTask }).task;
}
async function readRecovery(f: Fixture, taskId = 'task_one'): Promise<RecoveryReadResult> {
  return (await request(f, `/tasks/${taskId}/recovery`)).json() as Promise<RecoveryReadResult>;
}
async function sendCommand(
  f: Fixture,
  task: RecoveryTask,
  commandId: string,
  payload: RecoveryCommand['payload'],
  expectedVersion = task.version,
) {
  return request(f, `/tasks/${task.taskId}/commands`, 'POST', {
    taskId: task.taskId,
    commandId,
    expectedVersion,
    payload,
  });
}
async function accepted(response: Response): Promise<RecoveryTask> {
  expect(response.status).toBe(200);
  const result = (await response.json()) as RecoveryCommandResult;
  if (result.status !== 'accepted') throw new Error('Expected an accepted command.');
  expect(result.version).toBe(result.result.version);
  return result.result;
}
async function start(f: Fixture, task: RecoveryTask, runId = 'run_one') {
  return accepted(await sendCommand(f, task, `start_${runId}`, { type: 'start', runId }));
}
async function replay(f: Fixture, taskId = 'task_one', runId = 'run_one', afterSeq = 0) {
  const response = await request(f, `/tasks/${taskId}/replay?runId=${runId}&afterSeq=${afterSeq}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { events: RecoveryEvent[] }).events;
}

describe('Pages in-memory recovery fixture', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const f of fixtures.splice(0)) f.close();
    vi.useRealTimers();
  });

  it('creates isolated queued tasks, retains create receipts and lists only the requested thread', async () => {
    const f = fixture();
    const task = await createTask(f);
    expect(task).toEqual(queued());
    expect(recoverProjection(await readRecovery(f))).toMatchObject({ runId: '', afterSeq: 0 });
    await start(f, task);
    expect(await createTask(f)).toEqual(task);
    await createTask(f, 'other_task', 'other_thread');
    const listed = await (await request(f, '/tasks?threadId=thread_one')).json();
    expect(listed).toMatchObject({
      tasks: [{ taskId: 'task_one' }],
      persistence: 'memory-fixture',
    });
    expect(listed.tasks).toHaveLength(1);
    const isolated = fixture();
    expect((await request(isolated, '/tasks/task_one')).status).toBe(404);
    expect(
      (
        await request(f, '/tasks', 'POST', {
          taskId: 'changed_task',
          threadId: 'thread_one',
          commandId: 'create_task_one',
        })
      ).status,
    ).toBe(409);
  });

  it('starts synchronously at seq1/version+2 and checkpoints every four events and at completion', async () => {
    const f = fixture();
    const task = await createTask(f);
    const running = await start(f, task);
    expect(running).toMatchObject({
      version: task.version + 2,
      status: 'running',
      currentRunId: 'run_one',
    });
    expect(await replay(f)).toHaveLength(1);
    expect((await readRecovery(f)).checkpoint.cursor).toEqual({ runId: 'run_one', afterSeq: 1 });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(RECOVERY_STEP_DELAY_MS * 4);
    const partial = await readRecovery(f);
    expect(partial.checkpoint.cursor.afterSeq).toBe(4);
    expect(partial.events.map((event) => event.seq)).toEqual([5]);
    expect(recoverProjection(partial).state).toEqual(partial.task.state);
    await vi.runAllTimersAsync();
    const completed = await readRecovery(f);
    expect(completed.task).toMatchObject({
      status: 'succeeded',
      version: running.version + 12,
      state: { toolExecutionCount: 1 },
    });
    expect(completed.checkpoint.task).toEqual(completed.task);
    expect(completed.checkpoint.cursor.afterSeq).toBe(13);
    expect(completed.events).toEqual([]);
    expect(recoverProjection(completed).state.cards).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    const before = await readTask(f);
    expect(await replay(f)).toHaveLength(13);
    expect(await replay(f, 'task_one', 'run_one', 13)).toEqual([]);
    expect(await readTask(f)).toEqual(before);
  });

  it('freezes accepted/conflict/rejected receipts before CAS and rejects global key collisions', async () => {
    const f = fixture();
    const task = await createTask(f);
    const running = await start(f, task);
    await vi.advanceTimersByTimeAsync(RECOVERY_STEP_DELAY_MS * 2);
    expect(
      await accepted(
        await sendCommand(f, task, 'start_run_one', { type: 'start', runId: 'run_one' }),
      ),
    ).toEqual(running);
    const stale = await sendCommand(f, task, 'stale_cancel', { type: 'cancel' });
    expect(stale.status).toBe(409);
    const conflict = await stale.json();
    await vi.advanceTimersByTimeAsync(RECOVERY_STEP_DELAY_MS);
    expect(await (await sendCommand(f, task, 'stale_cancel', { type: 'cancel' })).json()).toEqual(
      conflict,
    );
    expect((await sendCommand(f, task, 'start_run_one', { type: 'cancel' })).status).toBe(400);
    expect((await sendCommand(f, task, 'create_task_one', { type: 'cancel' })).status).toBe(400);
    const current = await readTask(f);
    const rejected = await sendCommand(f, current, 'bad_start', { type: 'start', runId: 'unused' });
    expect(rejected.status).toBe(400);
    const rejection = await rejected.json();
    await vi.runAllTimersAsync();
    expect(
      await (await sendCommand(f, current, 'bad_start', { type: 'start', runId: 'unused' })).json(),
    ).toEqual(rejection);
    expect(
      (
        await request(f, '/tasks', 'POST', {
          taskId: 'new_task',
          threadId: 'thread_one',
          commandId: 'start_run_one',
        })
      ).status,
    ).toBe(409);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('conflicts concurrent versions, confirms immediate cancel, and isolates the next run', async () => {
    const f = fixture();
    const task = await createTask(f);
    const responses = await Promise.all([
      sendCommand(f, task, 'concurrent_one', { type: 'start', runId: 'run_one' }),
      sendCommand(f, task, 'concurrent_two', { type: 'start', runId: 'run_two' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const running = await readTask(f);
    const cancelled = await accepted(
      await sendCommand(f, running, 'cancel_one', { type: 'cancel' }),
    );
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      version: running.version + 1,
      state: { toolExecutionCount: 0 },
    });
    const oldRun = await replay(f, task.taskId, running.currentRunId!);
    expect(oldRun.map((event) => event.payload.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
    expect(EventSchemas.parse(oldRun[1].payload)).toMatchObject({ outcome: { type: 'cancelled' } });
    expect((await readRecovery(f)).checkpoint.task).toEqual(cancelled);
    expect(vi.getTimerCount()).toBe(0);
    const retried = await accepted(
      await sendCommand(f, cancelled, 'retry_new', { type: 'retry', runId: 'run_retry' }),
    );
    expect(retried.version).toBe(cancelled.version + 2);
    expect(await replay(f, task.taskId, running.currentRunId!)).toEqual(oldRun);
    expect((await sendCommand(f, retried, 'cancel_one', { type: 'cancel' })).status).toBe(400);
    // Reusing the exact original cancel receipt must not cancel the new run.
    expect(await accepted(await sendCommand(f, running, 'cancel_one', { type: 'cancel' }))).toEqual(
      cancelled,
    );
    await vi.runAllTimersAsync();
    const done = await readTask(f);
    expect(done).toMatchObject({
      currentRunId: 'run_retry',
      status: 'succeeded',
      state: { toolExecutionCount: 1 },
    });
    expect(
      (await sendCommand(f, done, 'retry_old', { type: 'retry', runId: running.currentRunId! }))
        .status,
    ).toBe(400);
    const other = await createTask(f, 'task_other');
    expect(
      (await sendCommand(f, other, 'start_reused', { type: 'start', runId: 'run_retry' })).status,
    ).toBe(400);
  });

  it('preserves committed tool effects across cancellation after result and repeated retries', async () => {
    const f = fixture();
    const task = await createTask(f);
    await start(f, task);
    await vi.advanceTimersByTimeAsync(RECOVERY_STEP_DELAY_MS * 10);
    const withResult = await readTask(f);
    expect(withResult).toMatchObject({
      status: 'running',
      state: { toolStatus: 'completed', toolExecutionCount: 1 },
    });
    const cancelled = await accepted(
      await sendCommand(f, withResult, 'cancel_result', { type: 'cancel' }),
    );
    expect(cancelled.state.toolExecutionCount).toBe(1);
    const retried = await accepted(
      await sendCommand(f, cancelled, 'retry_result', { type: 'retry', runId: 'run_next' }),
    );
    expect(retried.state).toMatchObject({
      text: '',
      cards: [],
      toolStatus: 'idle',
      toolExecutionCount: 1,
    });
    await vi.advanceTimersByTimeAsync(RECOVERY_STEP_DELAY_MS);
    expect((await replay(f, task.taskId, 'run_next'))[1].payload).toMatchObject({
      snapshot: { toolExecutionCount: 1 },
    });
    await vi.runAllTimersAsync();
    const done = await readTask(f);
    expect(done.state.toolExecutionCount).toBe(2);
    await replay(f, task.taskId, 'run_one');
    recoverProjection(await readRecovery(f));
    expect((await readTask(f)).state.toolExecutionCount).toBe(2);
  });

  it('emits framed SSE, continues after reader cancellation, and replays only the captured run', async () => {
    const f = fixture();
    const task = await createTask(f);
    await start(f, task);
    const response = await request(f, '/tasks/task_one/events?runId=run_one&afterSeq=0');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    const wire = new TextDecoder().decode(first.value);
    expect(wire).toContain('id: run_one:1\ndata: ');
    const initial: RecoveryEvent[] = [];
    const parser = createSseDecoder((value) => initial.push(value as RecoveryEvent));
    parser.push(wire);
    parser.finish();
    expect(initial.map((event) => event.seq)).toEqual([1]);
    await expect(reader.cancel()).resolves.toBeUndefined();
    reader.releaseLock();
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();
    const completed = await readTask(f);
    const suffix: RecoveryEvent[] = [];
    await consumeSse(await request(f, '/tasks/task_one/events?runId=run_one&afterSeq=1'), (value) =>
      suffix.push(value as RecoveryEvent),
    );
    expect(suffix.map((event) => event.seq)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 2),
    );
    const next = await accepted(
      await sendCommand(f, completed, 'retry_sse', { type: 'retry', runId: 'run_new' }),
    );
    const old: RecoveryEvent[] = [];
    await consumeSse(
      await request(f, '/tasks/task_one/events?runId=run_one&afterSeq=12'),
      (value) => old.push(value as RecoveryEvent),
    );
    expect(old.map((event) => event.runId)).toEqual(['run_one']);
    expect((await readTask(f)).currentRunId).toBe(next.currentRunId);
  });

  it('streams live records to completion and aborting a subscription leaves the runner active', async () => {
    const f = fixture();
    await start(f, await createTask(f));
    const abort = new AbortController();
    const response = await request(
      f,
      '/tasks/task_one/events?runId=run_one&afterSeq=1',
      'GET',
      undefined,
      abort.signal,
    );
    const reader = response.body!.getReader();
    const pending = reader.read();
    abort.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    reader.releaseLock();
    const events: RecoveryEvent[] = [];
    const collected = consumeSse(
      await request(f, '/tasks/task_one/events?runId=run_one&afterSeq=0'),
      (value) => events.push(value as RecoveryEvent),
    );
    await vi.runAllTimersAsync();
    await collected;
    expect(events).toHaveLength(13);
    expect(events.at(-1)!.payload.type).toBe(EventType.RUN_FINISHED);
  });

  it.each([
    '',
    '?runId=run_one',
    '?runId=run_one&afterSeq=-1',
    '?runId=run_one&afterSeq=1.5',
    '?runId=run_one&afterSeq=1e0',
    '?runId=run_one&afterSeq=9007199254740992',
    '?runId=run_one&afterSeq=2',
    '?runId=wrong_run&afterSeq=0',
    '?runId=run_one&afterSeq=0&afterSeq=1',
    '?runId=run_one&runId=other&afterSeq=0',
  ])('rejects invalid or ahead replay/SSE cursor %s', async (query) => {
    const f = fixture();
    await start(f, await createTask(f));
    for (const route of ['replay', 'events']) {
      const response = await request(f, `/tasks/task_one/${route}${query}`);
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
    }
  });

  it('rejects a foreign task cursor and gives the explicit query priority over Last-Event-ID', async () => {
    const f = fixture();
    await start(f, await createTask(f));
    await createTask(f, 'other_task');
    expect((await request(f, '/tasks/other_task/replay?runId=run_one&afterSeq=0')).status).toBe(
      400,
    );
    const response = await f.handle(
      new Request(
        `https://fixture.example${RECOVERY_API}/tasks/task_one/events?runId=run_one&afterSeq=0`,
        {
          headers: { 'Last-Event-ID': 'wrong_run:999' },
        },
      ),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('id: run_one:1\n');
    await reader.cancel();
  });

  it.each(['reset', 'close', 'delete'] as const)(
    '%s cancels all timers and finishes streams',
    async (operation) => {
      const f = fixture();
      await start(f, await createTask(f));
      await start(f, await createTask(f, 'other_task'), 'other_run');
      const readers = await Promise.all(
        ['task_one/events?runId=run_one', 'other_task/events?runId=other_run'].map(
          async (route) => {
            const response = await request(f, `/tasks/${route}&afterSeq=1`);
            return response.body!.getReader();
          },
        ),
      );
      const pending = readers.map((reader) => reader.read());
      expect(vi.getTimerCount()).toBe(2);
      if (operation === 'delete') expect((await request(f, '/fixture', 'DELETE')).status).toBe(200);
      else f[operation]();
      expect(vi.getTimerCount()).toBe(0);
      expect(await Promise.all(pending)).toEqual([
        { done: true, value: undefined },
        { done: true, value: undefined },
      ]);
      for (const reader of readers) reader.releaseLock();
      await vi.runAllTimersAsync();
      expect((await request(f, '/tasks/task_one')).status).toBe(operation === 'close' ? 503 : 404);
      if (operation !== 'close') expect(await createTask(f)).toEqual(queued());
    },
  );

  it('does not let an in-flight create repopulate a reset or closed fixture', async () => {
    const f = fixture();
    let finishJson!: (input: unknown) => void;
    const delayed = new Request(`https://fixture.example${RECOVERY_API}/tasks`, { method: 'POST' });
    vi.spyOn(delayed, 'json').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishJson = resolve;
        }),
    );
    const response = f.handle(delayed);
    f.reset();
    finishJson({ taskId: 'late_task', threadId: 'thread_one', commandId: 'late_create' });
    expect((await response).status).toBe(409);
    expect((await request(f, '/tasks/late_task')).status).toBe(404);
  });
});
