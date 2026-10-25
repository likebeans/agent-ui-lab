import type { BaseEvent } from '@ag-ui/core';
import { z } from 'zod';
import type {
  CommandResult,
  EventCursor,
  TaskCheckpoint,
  TaskCommand,
  TaskEvent,
  TaskSnapshot,
  TaskStatus,
  TaskStore,
} from '../../lab-contract';

export const RECOVERY_LAB_ID = 'task-recovery';
export const RECOVERY_API = '/api/labs/task-recovery';
export const CHECKPOINT_INTERVAL = 4;
export const RECOVERY_STEP_DELAY_MS = 300;

export interface RecoveryCard {
  id: string;
  title: string;
  detail: string;
}

export interface RecoveryState {
  status: TaskStatus;
  text: string;
  messageId: string | null;
  cards: RecoveryCard[];
  toolCallId: string | null;
  toolStatus: 'idle' | 'arguments' | 'running' | 'completed';
  toolExecutionCount: number;
}

export type RecoveryTask = TaskSnapshot<RecoveryState>;
export type RecoveryEvent = TaskEvent<BaseEvent>;
export type RecoveryCheckpoint = TaskCheckpoint<RecoveryState>;
export type RecoveryAction =
  { type: 'start'; runId: string } | { type: 'retry'; runId: string } | { type: 'cancel' };
export type RecoveryCommand = TaskCommand<RecoveryAction>;
export type RecoveryCommandResult = CommandResult<RecoveryTask>;

export interface CreateRecoveryTask {
  taskId: string;
  threadId: string;
  commandId: string;
}

export interface RecoveryStore extends TaskStore<RecoveryState> {
  create(input: CreateRecoveryTask, signal?: AbortSignal): Promise<RecoveryTask>;
  list(threadId: string, signal?: AbortSignal): Promise<RecoveryTask[]>;
  command(command: RecoveryCommand, signal?: AbortSignal): Promise<RecoveryCommandResult>;
}

export interface RecoveryReadResult {
  task: RecoveryTask;
  checkpoint: RecoveryCheckpoint;
  events: RecoveryEvent[];
  persistence: 'sqlite' | 'memory-fixture';
}

export const recoveryIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/u);
export const recoveryDerivedIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u);
export const recoveryStatusSchema = z.enum([
  'queued',
  'running',
  'waiting-input',
  'succeeded',
  'failed',
  'cancelled',
]);
export const recoveryStateSchema = z
  .object({
    status: recoveryStatusSchema,
    text: z.string().max(100_000),
    messageId: recoveryDerivedIdSchema.nullable(),
    cards: z
      .array(
        z
          .object({
            id: recoveryDerivedIdSchema,
            title: z.string().max(1000),
            detail: z.string().max(10_000),
          })
          .strict(),
      )
      .max(100),
    toolCallId: recoveryDerivedIdSchema.nullable(),
    toolStatus: z.enum(['idle', 'arguments', 'running', 'completed']),
    toolExecutionCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine((state) => new Set(state.cards.map((card) => card.id)).size === state.cards.length, {
    message: 'Recovery card IDs must be unique.',
  })
  .refine((state) => (state.toolStatus === 'idle') === (state.toolCallId === null), {
    message: 'An active tool must have a tool call ID.',
  });
export const recoveryTaskSchema = z
  .object({
    taskId: recoveryIdSchema,
    threadId: recoveryIdSchema,
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    status: recoveryStatusSchema,
    currentRunId: recoveryIdSchema.nullable(),
    state: recoveryStateSchema,
  })
  .strict()
  .refine((task) => task.status === task.state.status, {
    message: 'Task status and projected state status must agree.',
  })
  .refine((task) => (task.currentRunId === null) === (task.status === 'queued'), {
    message: 'Only a queued task can have no current run.',
  });
export const createRecoveryTaskSchema = z
  .object({
    taskId: recoveryIdSchema,
    threadId: recoveryIdSchema,
    commandId: recoveryIdSchema,
  })
  .strict();
export const recoveryCommandSchema = z
  .object({
    commandId: recoveryIdSchema,
    taskId: recoveryIdSchema,
    expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    payload: z.discriminatedUnion('type', [
      z.object({ type: z.literal('start'), runId: recoveryIdSchema }).strict(),
      z.object({ type: z.literal('retry'), runId: recoveryIdSchema }).strict(),
      z.object({ type: z.literal('cancel') }).strict(),
    ]),
  })
  .strict();
export const recoveryCursorSchema = z
  .object({
    runId: recoveryIdSchema,
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export function isTerminal(status: TaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function initialRecoveryState(): RecoveryState {
  return {
    status: 'queued',
    text: '',
    messageId: null,
    cards: [],
    toolCallId: null,
    toolStatus: 'idle',
    toolExecutionCount: 0,
  };
}

export interface RecoveryProjection {
  taskId: string;
  runId: string;
  afterSeq: number;
  state: RecoveryState;
}

export type DeliveryOutcome =
  | { type: 'applied'; projection: RecoveryProjection }
  | { type: 'duplicate' | 'stale-run' | 'foreign-task'; projection: RecoveryProjection }
  | { type: 'gap'; projection: RecoveryProjection; cursor: EventCursor };
