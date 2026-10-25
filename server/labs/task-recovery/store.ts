import { createHash } from 'node:crypto';
import { EventType, type AGUIEvent } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import type { EventCursor } from '../../../shared/lab-contract';
import {
  CHECKPOINT_INTERVAL,
  createRecoveryTaskSchema,
  initialRecoveryState,
  isTerminal,
  recoveryCommandSchema,
  recoveryCursorSchema,
  type CreateRecoveryTask,
  type RecoveryCheckpoint,
  type RecoveryCommand,
  type RecoveryCommandResult,
  type RecoveryEvent,
  type RecoveryReadResult,
  type RecoveryStore,
  type RecoveryTask,
} from '../../../shared/labs/task-recovery/contract';
import { recoveryPlan, reduceRecoveryState } from '../../../shared/labs/task-recovery/engine';
import type { LabDatabase } from '../../storage/sqlite';

export class RecoveryStoreError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'RecoveryStoreError';
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(kind: string, input: unknown): string {
  return createHash('sha256').update(stableJson({ kind, input })).digest('hex');
}

interface RunRecord {
  taskId: string;
  runId: string;
  lastSeq: number;
  status: RecoveryTask['status'];
  plan: AGUIEvent[];
}

export function createSqliteRecoveryStore(database: LabDatabase) {
  const { db } = database;
  database.migrate(
    'task-recovery/001',
    `
    CREATE TABLE recovery_tasks (
      task_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
    CREATE INDEX recovery_tasks_thread ON recovery_tasks(thread_id);
    CREATE TABLE recovery_commands (
      command_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
    CREATE TABLE recovery_checkpoints (
      task_id TEXT PRIMARY KEY REFERENCES recovery_tasks(task_id),
      checkpoint_json TEXT NOT NULL
    );
  `,
  );
  database.migrate(
    'task-recovery/002-runs',
    `
    CREATE TABLE recovery_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES recovery_tasks(task_id),
      plan_json TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
      status TEXT NOT NULL
    );
    CREATE INDEX recovery_runs_task ON recovery_runs(task_id);
    CREATE TABLE recovery_events (
      run_id TEXT NOT NULL REFERENCES recovery_runs(run_id),
      seq INTEGER NOT NULL CHECK (seq > 0),
      task_id TEXT NOT NULL REFERENCES recovery_tasks(task_id),
      payload_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE recovery_tool_effects (
      task_id TEXT NOT NULL REFERENCES recovery_tasks(task_id),
      run_id TEXT NOT NULL REFERENCES recovery_runs(run_id),
      tool_call_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (task_id, run_id, tool_call_id)
    );
  `,
  );

  function getSync(taskId: string): RecoveryTask | null {
    const row = db
      .prepare('SELECT snapshot_json FROM recovery_tasks WHERE task_id = ?')
      .get(taskId);
    return row ? (JSON.parse(row.snapshot_json as string) as RecoveryTask) : null;
  }

  function requireTask(taskId: string): RecoveryTask {
    const task = getSync(taskId);
    if (!task) throw new RecoveryStoreError('任务不存在。', 404);
    return task;
  }

  function listSync(threadId?: string): RecoveryTask[] {
    const rows =
      threadId === undefined
        ? db.prepare('SELECT snapshot_json FROM recovery_tasks ORDER BY task_id').all()
        : db
            .prepare(
              'SELECT snapshot_json FROM recovery_tasks WHERE thread_id = ? ORDER BY task_id',
            )
            .all(threadId);
    return rows.map((row) => JSON.parse(row.snapshot_json as string) as RecoveryTask);
  }

  function getRun(runId: string): RunRecord | null {
    const row = db.prepare('SELECT * FROM recovery_runs WHERE run_id = ?').get(runId);
    return row
      ? {
          taskId: row.task_id as string,
          runId: row.run_id as string,
          lastSeq: Number(row.last_seq),
          status: row.status as RecoveryTask['status'],
          plan: (JSON.parse(row.plan_json as string) as unknown[]).map((event) =>
            EventSchemas.parse(event),
          ),
        }
      : null;
  }

  function commandRecord(commandId: string) {
    return db
      .prepare('SELECT fingerprint, result_json FROM recovery_commands WHERE command_id = ?')
      .get(commandId);
  }

  function remember(commandId: string, hash: string, result: unknown) {
    db.prepare('INSERT INTO recovery_commands VALUES (?, ?, ?)').run(
      commandId,
      hash,
      JSON.stringify(result),
    );
  }

  function saveTask(task: RecoveryTask) {
    db.prepare('UPDATE recovery_tasks SET snapshot_json = ? WHERE task_id = ?').run(
      JSON.stringify(task),
      task.taskId,
    );
  }

  function saveCheckpoint(task: RecoveryTask, runId: string, afterSeq: number) {
    const checkpoint: RecoveryCheckpoint = { task, cursor: { runId, afterSeq } };
    db.prepare('INSERT OR REPLACE INTO recovery_checkpoints VALUES (?, ?)').run(
      task.taskId,
      JSON.stringify(checkpoint),
    );
  }

  function checkpointSync(taskId: string): RecoveryCheckpoint | null {
    const row = db
      .prepare('SELECT checkpoint_json FROM recovery_checkpoints WHERE task_id = ?')
      .get(taskId);
    return row ? (JSON.parse(row.checkpoint_json as string) as RecoveryCheckpoint) : null;
  }

  function validateCursor(taskId: string | undefined, raw: EventCursor): RunRecord {
    const cursor = recoveryCursorSchema.parse(raw);
    const run = getRun(cursor.runId);
    if (!run || (taskId !== undefined && run.taskId !== taskId)) {
      throw new RecoveryStoreError('runId 不属于该任务。');
    }
    if (cursor.afterSeq > run.lastSeq) throw new RecoveryStoreError('afterSeq 超过已持久化事件。');
    return run;
  }

  function eventsAfter(runId: string, afterSeq: number): RecoveryEvent[] {
    return db
      .prepare(
        'SELECT task_id, run_id, seq, payload_json FROM recovery_events WHERE run_id = ? AND seq > ? ORDER BY seq',
      )
      .all(runId, afterSeq)
      .map((row) => ({
        taskId: row.task_id as string,
        runId: row.run_id as string,
        seq: Number(row.seq),
        payload: EventSchemas.parse(JSON.parse(row.payload_json as string)),
      }));
  }

  // All components of a recovery response come from the same SQLite transaction.
  function readRecovery(taskId: string): RecoveryReadResult {
    return database.transaction(() => {
      const task = requireTask(taskId);
      const checkpoint = checkpointSync(taskId)!;
      const events =
        task.currentRunId === null
          ? []
          : eventsAfter(checkpoint.cursor.runId, checkpoint.cursor.afterSeq);
      return { task, checkpoint, events, persistence: 'sqlite' };
    });
  }

  function readRun(taskId: string, cursor: EventCursor) {
    return database.transaction(() => {
      requireTask(taskId);
      const run = validateCursor(taskId, cursor);
      return { events: eventsAfter(run.runId, cursor.afterSeq), terminal: isTerminal(run.status) };
    });
  }

  async function create(raw: CreateRecoveryTask, signal?: AbortSignal): Promise<RecoveryTask> {
    signal?.throwIfAborted();
    const input = createRecoveryTaskSchema.parse(raw);
    return database.transaction(() => {
      const hash = fingerprint('create', input);
      const previous = commandRecord(input.commandId);
      if (previous) {
        if (previous.fingerprint !== hash)
          throw new RecoveryStoreError('commandId 已用于不同的输入。', 409);
        return JSON.parse(previous.result_json as string) as RecoveryTask;
      }
      if (getSync(input.taskId)) throw new RecoveryStoreError('taskId 已存在。', 409);
      const task: RecoveryTask = {
        taskId: input.taskId,
        threadId: input.threadId,
        version: 1,
        status: 'queued',
        currentRunId: null,
        state: initialRecoveryState(),
      };
      db.prepare('INSERT INTO recovery_tasks VALUES (?, ?, ?)').run(
        task.taskId,
        task.threadId,
        JSON.stringify(task),
      );
      saveCheckpoint(task, '', 0);
      remember(input.commandId, hash, task);
      return task;
    });
  }

  function append(task: RecoveryTask, run: RunRecord, raw: RecoveryEvent['payload']): RecoveryTask {
    let payload = EventSchemas.parse(raw);
    if ('runId' in payload && payload.runId !== run.runId)
      throw new Error('Plan event has a foreign runId.');
    if ('threadId' in payload && payload.threadId !== task.threadId)
      throw new Error('Plan event has a foreign threadId.');
    if (payload.type === EventType.TOOL_CALL_RESULT) {
      const effect = db
        .prepare(
          'SELECT result_json FROM recovery_tool_effects WHERE task_id = ? AND run_id = ? AND tool_call_id = ?',
        )
        .get(task.taskId, run.runId, payload.toolCallId);
      if (effect) {
        payload = EventSchemas.parse({
          ...payload,
          content: JSON.parse(effect.result_json as string),
        });
      } else {
        // This result row is the deterministic tool's complete local business effect.
        db.prepare('INSERT INTO recovery_tool_effects VALUES (?, ?, ?, ?)').run(
          task.taskId,
          run.runId,
          payload.toolCallId,
          JSON.stringify(payload.content),
        );
      }
    }
    const state = reduceRecoveryState(task.state, payload);
    const count = Number(
      db
        .prepare('SELECT COUNT(*) AS count FROM recovery_tool_effects WHERE task_id = ?')
        .get(task.taskId)!.count,
    );
    if (state.toolExecutionCount !== count)
      throw new Error('Tool execution count disagrees with durable effects.');
    const next: RecoveryTask = { ...task, version: task.version + 1, status: state.status, state };
    const seq = run.lastSeq + 1;
    db.prepare('INSERT INTO recovery_events VALUES (?, ?, ?, ?)').run(
      run.runId,
      seq,
      task.taskId,
      JSON.stringify(payload),
    );
    db.prepare('UPDATE recovery_runs SET last_seq = ?, status = ? WHERE run_id = ?').run(
      seq,
      next.status,
      run.runId,
    );
    saveTask(next);
    if (seq % CHECKPOINT_INTERVAL === 0 || isTerminal(next.status))
      saveCheckpoint(next, run.runId, seq);
    return next;
  }

  async function command(
    raw: RecoveryCommand,
    signal?: AbortSignal,
  ): Promise<RecoveryCommandResult> {
    signal?.throwIfAborted();
    const input = recoveryCommandSchema.parse(raw);
    return database.transaction(() => {
      const hash = fingerprint('command', input);
      const previous = commandRecord(input.commandId);
      if (previous) {
        if (previous.fingerprint !== hash)
          return { status: 'rejected', reason: 'commandId 已用于不同的输入。' };
        return JSON.parse(previous.result_json as string) as RecoveryCommandResult;
      }
      const finish = (result: RecoveryCommandResult): RecoveryCommandResult => {
        remember(input.commandId, hash, result);
        return result;
      };
      const task = getSync(input.taskId);
      if (!task) return finish({ status: 'rejected', reason: '任务不存在。' });
      if (task.version !== input.expectedVersion) {
        return finish({
          status: 'conflict',
          version: task.version,
          reason: '任务版本已改变，请恢复后重试。',
        });
      }
      let next: RecoveryTask;
      const action = input.payload;
      if (action.type === 'cancel') {
        if (task.status !== 'running' || task.currentRunId === null)
          return finish({ status: 'rejected', reason: '只有 running 任务可以取消。' });
        const run = getRun(task.currentRunId)!;
        next = append(task, run, {
          type: EventType.RUN_FINISHED,
          threadId: task.threadId,
          runId: run.runId,
          outcome: { type: 'cancelled' },
        });
      } else {
        if (
          (action.type === 'start' && task.status !== 'queued') ||
          (action.type === 'retry' && !isTerminal(task.status))
        ) {
          return finish({
            status: 'rejected',
            reason: 'start 仅限 queued；retry 仅限 terminal 任务。',
          });
        }
        if (getRun(action.runId))
          return finish({ status: 'rejected', reason: 'runId 必须全局唯一，且不能重用旧 run。' });
        const initial: RecoveryTask = {
          ...task,
          version: task.version + 1,
          currentRunId: action.runId,
          status: 'running',
          state: {
            ...initialRecoveryState(),
            status: 'running',
            toolExecutionCount: task.state.toolExecutionCount,
          },
        };
        // Persist an immutable plan once. Restart/replay never reconstruct or execute a tool.
        const plan = recoveryPlan(initial, action.runId).map((event) => EventSchemas.parse(event));
        if (plan[0]?.type !== EventType.RUN_STARTED)
          throw new Error('Recovery plan must start with RUN_STARTED.');
        db.prepare('INSERT INTO recovery_runs VALUES (?, ?, ?, ?, ?)').run(
          action.runId,
          task.taskId,
          JSON.stringify(plan),
          0,
          initial.status,
        );
        next = append(
          initial,
          {
            taskId: task.taskId,
            runId: action.runId,
            lastSeq: 0,
            status: 'running',
            plan,
          },
          plan[0],
        );
        saveCheckpoint(next, action.runId, 1);
      }
      return finish({ status: 'accepted', version: next.version, result: next });
    });
  }

  // Only the background runner calls this. Reads and transport reconnects never advance a plan.
  function advance(taskId: string, runId: string): RecoveryTask | null {
    return database.transaction(() => {
      const task = getSync(taskId);
      const run = getRun(runId);
      if (
        !task ||
        !run ||
        task.currentRunId !== runId ||
        task.status !== 'running' ||
        run.taskId !== taskId ||
        run.status !== 'running'
      )
        return null;
      const payload = run.plan[run.lastSeq];
      if (!payload) throw new Error('Recovery plan ended without a terminal event.');
      return append(task, run, payload);
    });
  }

  return {
    create,
    command,
    getSync,
    listSync,
    readRecovery,
    readRun,
    advance,
    async get(taskId: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      return getSync(taskId);
    },
    async list(threadId: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      return listSync(threadId);
    },
    async checkpoint(taskId: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      return checkpointSync(taskId);
    },
    async replay(cursor: EventCursor, signal?: AbortSignal): Promise<RecoveryEvent[]> {
      signal?.throwIfAborted();
      return database.transaction(() => {
        const run = validateCursor(undefined, cursor);
        return eventsAfter(run.runId, cursor.afterSeq);
      });
    },
  } satisfies RecoveryStore & {
    getSync: typeof getSync;
    listSync: typeof listSync;
    readRecovery: typeof readRecovery;
    readRun: typeof readRun;
    advance: typeof advance;
  };
}

export type SQLiteRecoveryStore = ReturnType<typeof createSqliteRecoveryStore>;
