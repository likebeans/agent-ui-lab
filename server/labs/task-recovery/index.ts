import { json, Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  RECOVERY_STEP_DELAY_MS,
  recoveryCommandSchema,
  recoveryCursorSchema,
  recoveryIdSchema,
  type RecoveryTask,
} from '../../../shared/labs/task-recovery/contract';
import type { LabDatabase } from '../../storage/sqlite';
import { createSqliteRecoveryStore, RecoveryStoreError } from './store';

export function createTaskRecoveryRouter(options: { database: LabDatabase; stepDelayMs?: number }) {
  const delay = options.stepDelayMs ?? RECOVERY_STEP_DELAY_MS;
  if (!Number.isFinite(delay) || delay < 0)
    throw new Error('stepDelayMs must be a nonnegative finite number.');
  const store = createSqliteRecoveryStore(options.database);
  const router = Router();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const subscribers = new Map<string, Set<() => void>>();
  const streams = new Set<() => void>();
  let closed = false;

  function notify(runId: string) {
    for (const drain of [...(subscribers.get(runId) ?? [])]) drain();
  }

  function stopRun(runId: string) {
    const timer = timers.get(runId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(runId);
  }

  function schedule(task: RecoveryTask) {
    if (
      closed ||
      task.status !== 'running' ||
      task.currentRunId === null ||
      timers.has(task.currentRunId)
    )
      return;
    const { taskId, currentRunId: runId } = task;
    const timer = setTimeout(() => {
      timers.delete(runId);
      if (closed) return;
      const next = store.advance(taskId, runId);
      notify(runId);
      if (next) schedule(next);
    }, delay);
    timer.unref();
    timers.set(runId, timer);
  }

  function cursorFromQuery(request: Request) {
    const after = request.query.afterSeq;
    if (typeof after !== 'string' || !/^\d+$/u.test(after)) {
      throw new RecoveryStoreError('afterSeq 必须是非负安全整数。');
    }
    return recoveryCursorSchema.parse({ runId: request.query.runId, afterSeq: Number(after) });
  }

  function openStream(request: Request, response: Response) {
    const taskId = recoveryIdSchema.parse(request.params.taskId);
    const cursor = cursorFromQuery(request);
    let batch = store.readRun(taskId, cursor);
    let afterSeq = cursor.afterSeq;
    let waitingForDrain = false;
    let ended = false;
    const listeners = subscribers.get(cursor.runId) ?? new Set<() => void>();
    subscribers.set(cursor.runId, listeners);

    const finish = () => {
      if (ended) return;
      ended = true;
      listeners.delete(drain);
      if (listeners.size === 0) subscribers.delete(cursor.runId);
      streams.delete(finish);
      response.off('drain', onDrain);
      response.off('close', finish);
      if (!response.writableEnded) response.end();
    };
    const onDrain = () => {
      waitingForDrain = false;
      drain();
    };
    const drain = () => {
      if (ended || waitingForDrain) return;
      batch = store.readRun(taskId, { runId: cursor.runId, afterSeq });
      for (const event of batch.events) {
        const ready = response.write(
          `id: ${event.runId}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
        );
        afterSeq = event.seq;
        if (!ready) {
          waitingForDrain = true;
          return;
        }
      }
      if (batch.terminal) finish();
    };

    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.on('close', finish);
    response.on('drain', onDrain);
    listeners.add(drain);
    streams.add(finish);
    response.flushHeaders();
    drain();
  }

  const requireOpen = (_request: Request, response: Response, next: () => void) => {
    if (closed) response.status(503).json({ error: 'Task recovery adapter is closed.' });
    else next();
  };
  router.use(requireOpen);
  router.use(json({ limit: '128kb' }));
  router.use(requireOpen);
  router.get('/tasks', async (request, response) => {
    const threadId = recoveryIdSchema.parse(request.query.threadId);
    response.json({ tasks: await store.list(threadId), persistence: 'sqlite' });
  });
  router.post('/tasks', async (request, response) => {
    response.json({ task: await store.create(request.body), persistence: 'sqlite' });
  });
  router.get('/tasks/:taskId', (request, response) => {
    const task = store.getSync(recoveryIdSchema.parse(request.params.taskId));
    if (!task) throw new RecoveryStoreError('任务不存在。', 404);
    response.json({ task, persistence: 'sqlite' });
  });
  router.get('/tasks/:taskId/recovery', (request, response) => {
    response.json(store.readRecovery(recoveryIdSchema.parse(request.params.taskId)));
  });
  router.get('/tasks/:taskId/replay', (request, response) => {
    const taskId = recoveryIdSchema.parse(request.params.taskId);
    response.json({
      events: store.readRun(taskId, cursorFromQuery(request)).events,
      persistence: 'sqlite',
    });
  });
  router.get('/tasks/:taskId/events', openStream);
  router.post('/tasks/:taskId/commands', async (request, response) => {
    const taskId = recoveryIdSchema.parse(request.params.taskId);
    const input = recoveryCommandSchema.parse(request.body);
    if (input.taskId !== taskId) throw new RecoveryStoreError('命令 taskId 与 URL 不匹配。');
    const result = await store.command(input);
    if (result.status === 'accepted') {
      // An idempotent retry returns its original receipt; schedule only the authoritative current run.
      const current = store.getSync(taskId)!;
      if (current.status === 'running') schedule(current);
      else if (current.currentRunId !== null) stopRun(current.currentRunId);
      if (current.currentRunId !== null) notify(current.currentRunId);
    }
    response
      .status(result.status === 'accepted' ? 200 : result.status === 'conflict' ? 409 : 400)
      .json(result);
  });
  router.use(((error, _request, response, next) => {
    if (error instanceof RecoveryStoreError)
      response.status(error.status).json({ error: error.message });
    else if (error instanceof z.ZodError)
      response.status(400).json({ error: error.issues[0]?.message ?? '输入无效。' });
    else next(error);
  }) satisfies ErrorRequestHandler);

  for (const task of store.listSync()) schedule(task);

  return {
    router,
    close() {
      if (closed) return;
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const finish of [...streams]) finish();
      subscribers.clear();
    },
  };
}
