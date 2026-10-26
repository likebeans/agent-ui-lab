import { z } from 'zod';
import { EventSchemas } from '@ag-ui/core/schemas';
import type { AGUIEvent } from '@ag-ui/core';
import type { A2uiMessage } from '../../a2ui';
import type { ApprovalStore, ApprovalTransaction } from '../human-approval/ports';
import type { ApprovalFacts, ApprovalResult, ApprovalTask } from '../human-approval/types';

export const WORKFLOW_API = '/api/labs/enrollment-workflow';
export const WORKFLOW_DROP_HEADER = 'X-Workflow-Drop-Response';
export const workflowIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);
export const workflowQuerySchema = z.strictObject({
  taskId: workflowIdSchema,
  commandId: workflowIdSchema.optional(),
  runId: workflowIdSchema.optional(),
  afterSeq: z.coerce.number().int().nonnegative().default(0),
});
export type WorkflowQuery = z.input<typeof workflowQuerySchema>;
export const workflowEnvelopeSchema = z.strictObject({
  command: z.unknown(),
  action: z.unknown().optional(),
});

export interface WorkflowEvent {
  taskId: string;
  runId: string;
  seq: number;
  payload: AGUIEvent;
}

export interface WorkflowCheckpoint {
  task: ApprovalTask;
  cursor: { runId: string; afterSeq: number };
}

export interface WorkflowFacts extends ApprovalFacts {
  checkpoint: WorkflowCheckpoint;
  events: WorkflowEvent[];
  messages: A2uiMessage[];
}

export type WorkflowFactsResult = WorkflowFacts | Extract<ApprovalResult, { status: 'rejected' }>;
export interface WorkflowTransaction extends ApprovalTransaction {
  getEvents(taskId: string): WorkflowEvent[];
  appendEvent(event: WorkflowEvent): void;
}

type SynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;
export interface WorkflowStore extends ApprovalStore {
  transaction<T>(operation: (transaction: WorkflowTransaction) => SynchronousResult<T>): T;
}

export function parseWorkflowEvent(input: unknown): WorkflowEvent {
  return z
    .strictObject({
      taskId: workflowIdSchema,
      runId: workflowIdSchema,
      seq: z.int().positive(),
      payload: EventSchemas,
    })
    .parse(input) as WorkflowEvent;
}

/** A cursor advances only over a continuous prefix of this task's one durable run. */
export function appendWorkflowEvents(
  current: readonly WorkflowEvent[],
  incoming: readonly unknown[],
  taskId: string,
  runId: string,
): WorkflowEvent[] {
  const next = [...current];
  for (const raw of incoming) {
    const event = parseWorkflowEvent(raw);
    if (event.taskId !== taskId || event.runId !== runId)
      throw new Error('事件不属于当前任务与运行。');
    if (event.seq <= next.length) {
      if (JSON.stringify(next[event.seq - 1]) !== JSON.stringify(event))
        throw new Error('重复事件的内容不一致。');
      continue;
    }
    if (event.seq !== next.length + 1) throw new Error('事件序号不连续，请查询 checkpoint。');
    next.push(event);
  }
  return next;
}
