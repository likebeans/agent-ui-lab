import { EventType, type BaseEvent } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { z } from 'zod';
import {
  CHECKPOINT_INTERVAL,
  RECOVERY_API,
  RECOVERY_STEP_DELAY_MS,
  createRecoveryTaskSchema,
  initialRecoveryState,
  isTerminal,
  recoveryCommandSchema,
  recoveryCursorSchema,
  recoveryIdSchema,
  type CreateRecoveryTask,
  type RecoveryCheckpoint,
  type RecoveryCommand,
  type RecoveryCommandResult,
  type RecoveryEvent,
  type RecoveryTask,
} from './contract';
import { recoveryPlan, reduceRecoveryState } from './engine';

interface MemoryRun {
  taskId: string;
  runId: string;
  plan: BaseEvent[];
  events: RecoveryEvent[];
  status: RecoveryTask['status'];
}
interface Receipt {
  fingerprint: string;
  result: RecoveryTask | RecoveryCommandResult;
}
class FixtureError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** An isolated, browser-only store. Reloading the page creates a fresh fixture. */
export function createRecoveryFixture(): {
  handle(request: Request): Promise<Response>;
  reset(): void;
  close(): void;
} {
  const tasks = new Map<string, RecoveryTask>();
  const checkpoints = new Map<string, RecoveryCheckpoint>();
  const runs = new Map<string, MemoryRun>();
  const receipts = new Map<string, Receipt>();
  const effects = new Map<string, Set<string>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const subscribers = new Map<string, Set<() => void>>();
  const streams = new Set<() => void>();
  const encoder = new TextEncoder();
  let closed = false;
  let generation = 0;

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-Lab-Transport': 'browser-memory',
      },
    });
  }

  function requireTask(taskId: string): RecoveryTask {
    const task = tasks.get(taskId);
    if (!task) throw new FixtureError('任务不存在。', 404);
    return task;
  }

  function checkpoint(task: RecoveryTask, runId: string, afterSeq: number): void {
    checkpoints.set(task.taskId, structuredClone({ task, cursor: { runId, afterSeq } }));
  }

  function remember(commandId: string, fingerprint: string, result: Receipt['result']): void {
    receipts.set(commandId, { fingerprint, result: structuredClone(result) });
  }

  function create(input: CreateRecoveryTask): RecoveryTask {
    const fingerprint = JSON.stringify({ kind: 'create', input });
    const previous = receipts.get(input.commandId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new FixtureError('commandId 已用于不同的输入。', 409);
      return structuredClone(previous.result as RecoveryTask);
    }
    if (tasks.has(input.taskId)) throw new FixtureError('taskId 已存在。', 409);
    const task: RecoveryTask = {
      taskId: input.taskId,
      threadId: input.threadId,
      version: 1,
      status: 'queued',
      currentRunId: null,
      state: initialRecoveryState(),
    };
    tasks.set(task.taskId, task);
    checkpoint(task, '', 0);
    remember(input.commandId, fingerprint, task);
    return task;
  }

  function append(task: RecoveryTask, run: MemoryRun, raw: BaseEvent): RecoveryTask {
    const payload = EventSchemas.parse(raw);
    if (
      (payload.type === EventType.RUN_STARTED || payload.type === EventType.RUN_FINISHED) &&
      (payload.runId !== run.runId || payload.threadId !== task.threadId)
    )
      throw new Error('计划事件与当前任务运行不一致。');
    const effect =
      payload.type === EventType.TOOL_CALL_RESULT
        ? JSON.stringify([run.runId, payload.toolCallId])
        : null;
    const recorded = effects.get(task.taskId) ?? new Set<string>();
    if (effect !== null && recorded.has(effect)) throw new Error('同一工具效果已记录。');
    const state = reduceRecoveryState(task.state, payload);
    if (state.toolExecutionCount !== recorded.size + Number(effect !== null))
      throw new Error('工具执行计数与本地业务记录不一致。');
    const next: RecoveryTask = { ...task, version: task.version + 1, status: state.status, state };
    const seq = run.events.length + 1;
    // All mutations below are synchronous: observers see one complete step.
    if (effect !== null) {
      recorded.add(effect);
      effects.set(task.taskId, recorded);
    }
    run.events.push({ taskId: task.taskId, runId: run.runId, seq, payload });
    run.status = next.status;
    tasks.set(task.taskId, next);
    if (seq % CHECKPOINT_INTERVAL === 0 || isTerminal(next.status))
      checkpoint(next, run.runId, seq);
    return next;
  }

  function stop(runId: string): void {
    const timer = timers.get(runId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(runId);
  }

  function notify(runId: string): void {
    for (const drain of [...(subscribers.get(runId) ?? [])]) drain();
  }

  function schedule(task: RecoveryTask): void {
    if (
      closed ||
      task.status !== 'running' ||
      task.currentRunId === null ||
      timers.has(task.currentRunId)
    )
      return;
    const { taskId, currentRunId: runId } = task;
    timers.set(
      runId,
      setTimeout(() => {
        timers.delete(runId);
        const current = tasks.get(taskId);
        const run = runs.get(runId);
        if (
          closed ||
          !current ||
          !run ||
          current.currentRunId !== runId ||
          current.status !== 'running' ||
          run.status !== 'running'
        )
          return;
        const payload = run.plan[run.events.length];
        if (!payload) throw new Error('确定性计划缺少终止事件。');
        const next = append(current, run, payload);
        notify(runId);
        schedule(next);
      }, RECOVERY_STEP_DELAY_MS),
    );
  }

  function command(input: RecoveryCommand): RecoveryCommandResult {
    const fingerprint = JSON.stringify({ kind: 'command', input });
    const previous = receipts.get(input.commandId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return { status: 'rejected', reason: 'commandId 已用于不同的输入。' };
      return structuredClone(previous.result as RecoveryCommandResult);
    }
    const finish = (result: RecoveryCommandResult): RecoveryCommandResult => {
      remember(input.commandId, fingerprint, result);
      return result;
    };
    const task = tasks.get(input.taskId);
    if (!task) return finish({ status: 'rejected', reason: '任务不存在。' });
    if (task.version !== input.expectedVersion)
      return finish({
        status: 'conflict',
        version: task.version,
        reason: '任务版本已改变，请恢复后重试。',
      });
    let next: RecoveryTask;
    if (input.payload.type === 'cancel') {
      if (task.status !== 'running' || task.currentRunId === null)
        return finish({ status: 'rejected', reason: '只有 running 任务可以取消。' });
      const run = runs.get(task.currentRunId)!;
      next = append(task, run, {
        type: EventType.RUN_FINISHED,
        threadId: task.threadId,
        runId: run.runId,
        outcome: { type: 'cancelled' },
      });
      stop(run.runId);
    } else {
      const { type, runId } = input.payload;
      if (
        (type === 'start' && task.status !== 'queued') ||
        (type === 'retry' && !isTerminal(task.status))
      )
        return finish({
          status: 'rejected',
          reason: 'start 仅限 queued；retry 仅限 terminal 任务。',
        });
      if (runs.has(runId))
        return finish({ status: 'rejected', reason: 'runId 必须全局唯一，且不能重用旧 run。' });
      next = {
        ...task,
        version: task.version + 1,
        status: 'running',
        currentRunId: runId,
        state: {
          ...initialRecoveryState(),
          status: 'running',
          toolExecutionCount: task.state.toolExecutionCount,
        },
      };
      const run: MemoryRun = {
        taskId: task.taskId,
        runId,
        status: 'running',
        events: [],
        plan: recoveryPlan(next, runId),
      };
      const first = run.plan[0];
      if (first?.type !== EventType.RUN_STARTED)
        throw new Error('运行计划必须以 RUN_STARTED 开始。');
      next = append(next, run, first);
      runs.set(runId, run);
      checkpoint(next, runId, 1);
    }
    return finish({ status: 'accepted', version: next.version, result: next });
  }

  function cursorFrom(url: URL) {
    const afterSeq = url.searchParams.get('afterSeq');
    if (
      url.searchParams.getAll('runId').length !== 1 ||
      url.searchParams.getAll('afterSeq').length !== 1 ||
      afterSeq === null ||
      !/^\d+$/u.test(afterSeq)
    )
      throw new FixtureError('afterSeq 必须是非负安全整数，且必须明确提供 runId。');
    return recoveryCursorSchema.parse({
      runId: url.searchParams.get('runId'),
      afterSeq: Number(afterSeq),
    });
  }

  function readRun(taskId: string, cursor: { runId: string; afterSeq: number }): MemoryRun {
    requireTask(taskId);
    const run = runs.get(cursor.runId);
    if (!run || run.taskId !== taskId) throw new FixtureError('runId 不属于该任务。');
    if (cursor.afterSeq > run.events.length) throw new FixtureError('afterSeq 超过已记录事件。');
    return run;
  }

  function openStream(
    request: Request,
    taskId: string,
    cursor: { runId: string; afterSeq: number },
  ): Response {
    const run = readRun(taskId, cursor);
    let finish = () => {};
    let closeController = true;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let afterSeq = cursor.afterSeq;
        let ended = false;
        const listeners = subscribers.get(run.runId) ?? new Set<() => void>();
        const drain = () => {
          if (ended) return;
          for (const event of run.events.slice(afterSeq)) {
            controller.enqueue(
              encoder.encode(`id: ${event.runId}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`),
            );
            afterSeq = event.seq;
          }
          if (isTerminal(run.status)) finish();
        };
        finish = () => {
          if (ended) return;
          ended = true;
          listeners.delete(drain);
          if (listeners.size === 0) subscribers.delete(run.runId);
          streams.delete(finish);
          request.signal.removeEventListener('abort', finish);
          if (closeController) controller.close();
        };
        subscribers.set(run.runId, listeners);
        listeners.add(drain);
        streams.add(finish);
        request.signal.addEventListener('abort', finish, { once: true });
        if (request.signal.aborted) finish();
        else drain();
      },
      cancel() {
        closeController = false;
        finish();
      },
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Lab-Transport': 'browser-memory',
      },
    });
  }

  function clear(): void {
    generation += 1;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const finish of [...streams]) finish();
    subscribers.clear();
    tasks.clear();
    checkpoints.clear();
    runs.clear();
    receipts.clear();
    effects.clear();
  }

  return {
    async handle(request: Request): Promise<Response> {
      request.signal.throwIfAborted();
      if (closed) return json({ error: 'Task recovery fixture is closed.' }, 503);
      const requestGeneration = generation;
      try {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        if (url.pathname === `${RECOVERY_API}/fixture` && method === 'DELETE') {
          clear();
          return json({ persistence: 'memory-fixture' });
        }
        if (url.pathname === `${RECOVERY_API}/tasks`) {
          if (method === 'GET') {
            const threadId = recoveryIdSchema.parse(url.searchParams.get('threadId'));
            return json({
              tasks: [...tasks.values()]
                .filter((task) => task.threadId === threadId)
                .sort((left, right) =>
                  left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
                ),
              persistence: 'memory-fixture',
            });
          }
          if (method === 'POST') {
            const input = createRecoveryTaskSchema.parse(await request.json());
            request.signal.throwIfAborted();
            if (closed) return json({ error: 'Task recovery fixture is closed.' }, 503);
            if (generation !== requestGeneration)
              throw new FixtureError('Fixture 已重置，请重新发起命令。', 409);
            return json({ task: create(input), persistence: 'memory-fixture' });
          }
        }
        const match = new RegExp(
          `^${RECOVERY_API}/tasks/([^/]+)(?:/(recovery|replay|events|commands))?$`,
          'u',
        ).exec(url.pathname);
        if (!match) return json({ error: '未知的任务恢复路径。' }, 404);
        const taskId = recoveryIdSchema.parse(decodeURIComponent(match[1]));
        const route = match[2];
        if (method === 'GET' && route === undefined)
          return json({ task: requireTask(taskId), persistence: 'memory-fixture' });
        if (method === 'GET' && route === 'recovery') {
          const task = requireTask(taskId);
          const saved = checkpoints.get(taskId)!;
          const events =
            task.currentRunId === null
              ? []
              : readRun(taskId, saved.cursor).events.slice(saved.cursor.afterSeq);
          return json({ task, checkpoint: saved, events, persistence: 'memory-fixture' });
        }
        if (method === 'GET' && (route === 'replay' || route === 'events')) {
          const cursor = cursorFrom(url);
          if (route === 'events') return openStream(request, taskId, cursor);
          return json({
            events: readRun(taskId, cursor).events.slice(cursor.afterSeq),
            persistence: 'memory-fixture',
          });
        }
        if (method === 'POST' && route === 'commands') {
          const input = recoveryCommandSchema.parse(await request.json());
          request.signal.throwIfAborted();
          if (closed) return json({ error: 'Task recovery fixture is closed.' }, 503);
          if (generation !== requestGeneration)
            throw new FixtureError('Fixture 已重置，请重新发起命令。', 409);
          if (input.taskId !== taskId) throw new FixtureError('命令 taskId 与 URL 不匹配。');
          const result = command(input);
          if (result.status === 'accepted') {
            const current = requireTask(taskId);
            if (current.status === 'running') schedule(current);
            else if (current.currentRunId !== null) stop(current.currentRunId);
            if (current.currentRunId !== null) notify(current.currentRunId);
          }
          return json(
            result,
            result.status === 'accepted' ? 200 : result.status === 'conflict' ? 409 : 400,
          );
        }
        return json({ error: '此路径不支持该 HTTP 方法。' }, 405);
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason;
        if (error instanceof FixtureError) return json({ error: error.message }, error.status);
        if (error instanceof z.ZodError)
          return json({ error: error.issues[0]?.message ?? '输入无效。' }, 400);
        if (error instanceof SyntaxError || error instanceof URIError)
          return json({ error: '请求 JSON 或路径格式不合法。' }, 400);
        throw error;
      }
    },
    reset() {
      clear();
    },
    close() {
      closed = true;
      clear();
    },
  };
}
