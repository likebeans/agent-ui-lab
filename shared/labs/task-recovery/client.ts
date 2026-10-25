import { EventType } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { z } from 'zod';
import {
  recoveryCursorSchema,
  recoveryIdSchema,
  recoveryStateSchema,
  recoveryTaskSchema,
  type DeliveryOutcome,
  type RecoveryCheckpoint,
  type RecoveryEvent,
  type RecoveryProjection,
  type RecoveryReadResult,
} from './contract';
import { reduceRecoveryState } from './engine';

const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const checkpointSchema = z
  .object({
    task: recoveryTaskSchema,
    cursor: z
      .object({
        runId: z.union([recoveryIdSchema, z.literal('')]),
        afterSeq: sequenceSchema,
      })
      .strict(),
  })
  .strict();
const envelopeSchema = z
  .object({
    taskId: recoveryIdSchema,
    runId: recoveryIdSchema,
    seq: sequenceSchema.min(1),
    payload: z.unknown(),
  })
  .strict();
const projectionSchema = z
  .object({
    taskId: recoveryIdSchema,
    runId: z.union([recoveryIdSchema, z.literal('')]),
    afterSeq: sequenceSchema,
    state: recoveryStateSchema,
  })
  .strict();
const readSchema = z
  .object({
    task: recoveryTaskSchema,
    checkpoint: checkpointSchema,
    events: z.array(z.unknown()),
    persistence: z.enum(['sqlite', 'memory-fixture']),
  })
  .strict();

export function projectionFromCheckpoint(value: RecoveryCheckpoint): RecoveryProjection {
  const { task, cursor } = checkpointSchema.parse(value);
  if (task.currentRunId === null) {
    if (cursor.runId !== '' || cursor.afterSeq !== 0)
      throw new Error('排队任务的 checkpoint 必须使用空运行和零 cursor。');
  } else {
    recoveryCursorSchema.parse(cursor);
    if (cursor.runId !== task.currentRunId)
      throw new Error('Checkpoint cursor 与任务的当前运行不一致。');
  }
  if (cursor.afterSeq > task.version) throw new Error('Checkpoint cursor 超过已记录的任务版本。');
  return {
    taskId: task.taskId,
    runId: cursor.runId,
    afterSeq: cursor.afterSeq,
    state: task.state,
  };
}

/** Every ignored event returns the original projection without advancing its cursor. */
export function deliverRecoveryEvent(
  projection: RecoveryProjection,
  value: RecoveryEvent,
): DeliveryOutcome {
  const current = projectionSchema.parse(projection);
  if (current.runId === '' && (current.state.status !== 'queued' || current.afterSeq !== 0))
    throw new Error('只有排队任务可以使用空运行 cursor。');
  const event = parseEvent(value);
  if (event.taskId !== current.taskId) return { type: 'foreign-task', projection };
  if (event.runId !== current.runId) return { type: 'stale-run', projection };
  if (event.seq <= current.afterSeq) return { type: 'duplicate', projection };
  if (event.seq !== current.afterSeq + 1) {
    return {
      type: 'gap',
      projection,
      cursor: { runId: current.runId, afterSeq: current.afterSeq },
    };
  }
  const payload = EventSchemas.parse(event.payload);
  if ((event.seq === 1) !== (payload.type === EventType.RUN_STARTED))
    throw new Error('每次运行必须以唯一的 RUN_STARTED 事件开始。');
  return {
    type: 'applied',
    projection: {
      ...current,
      afterSeq: event.seq,
      state: reduceRecoveryState(current.state, payload),
    },
  };
}

/** Reconstruct from records, then prove that the complete suffix reaches authority. */
export function recoverProjection(value: RecoveryReadResult): RecoveryProjection {
  const result = readSchema.parse(value);
  const authority = result.task;
  const checkpoint = result.checkpoint;
  if (
    checkpoint.task.taskId !== authority.taskId ||
    checkpoint.task.threadId !== authority.threadId ||
    checkpoint.task.currentRunId !== authority.currentRunId
  )
    throw new Error('恢复结果的 task、thread 或 run 与 checkpoint 不一致。');
  if (
    authority.version < checkpoint.task.version ||
    authority.version - checkpoint.task.version !== result.events.length
  )
    throw new Error('恢复事件不完整：checkpoint 后的事件数与权威版本不一致。');

  let projection = projectionFromCheckpoint(checkpoint);
  for (const rawEvent of result.events) {
    const event = parseEvent(rawEvent);
    const payload = EventSchemas.parse(event.payload);
    if (
      (payload.type === EventType.RUN_STARTED || payload.type === EventType.RUN_FINISHED) &&
      payload.threadId !== authority.threadId
    )
      throw new Error('恢复事件的 thread 与权威任务不一致。');
    const outcome = deliverRecoveryEvent(projection, event);
    if (outcome.type !== 'applied')
      throw new Error(`恢复事件必须属于当前 task/run 并完整连续：${outcome.type}。`);
    projection = outcome.projection;
  }
  // Parsing both states with the same strict schema gives a stable property order.
  if (JSON.stringify(projection.state) !== JSON.stringify(authority.state))
    throw new Error('事件重放结果与权威任务状态不一致。');
  return projection;
}

function parseEvent(value: unknown): RecoveryEvent {
  const envelope = envelopeSchema.parse(value);
  const payload = EventSchemas.parse(envelope.payload);
  if (
    (payload.type === EventType.RUN_STARTED || payload.type === EventType.RUN_FINISHED) &&
    payload.runId !== envelope.runId
  )
    throw new Error('AG-UI payload 的运行 ID 与 envelope 不一致。');
  return { ...envelope, payload };
}
