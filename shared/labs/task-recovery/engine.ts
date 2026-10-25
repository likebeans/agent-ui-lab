import { EventType, type BaseEvent } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { z } from 'zod';
import {
  initialRecoveryState,
  recoveryIdSchema,
  recoveryStateSchema,
  recoveryTaskSchema,
  type RecoveryState,
  type RecoveryTask,
} from './contract';

const toolResultSchema = z.object({ cards: recoveryStateSchema.shape.cards }).strict();

/** A pure plan: producing or replaying it never executes a tool. */
export function recoveryPlan(task: RecoveryTask, runId: string): BaseEvent[] {
  recoveryTaskSchema.parse(task);
  recoveryIdSchema.parse(runId);
  const current = recoveryStateSchema.parse(task.state);
  const messageId = `${runId}_message`;
  const toolCallId = `${runId}_tool`;
  // A resumed run may already have committed its result. A previous run's tool
  // must not be subtracted when planning a retry with its own IDs.
  const alreadyExecuted =
    task.currentRunId === runId &&
    current.toolCallId === toolCallId &&
    current.toolStatus === 'completed';
  const baselineCount = current.toolExecutionCount - Number(alreadyExecuted);
  if (baselineCount < 0 || baselineCount >= Number.MAX_SAFE_INTEGER)
    throw new Error('工具执行计数无法继续。');
  const startState: RecoveryState = {
    ...initialRecoveryState(),
    status: 'running',
    toolExecutionCount: baselineCount,
  };
  const cards = [
    { id: `${runId}_card_1`, title: '本地样本已整理', detail: '确定性工具返回两条本地样本记录。' },
    {
      id: `${runId}_card_2`,
      title: '恢复记录已就绪',
      detail: '断线恢复只重放已保存的事件，不会再次执行工具。',
    },
  ];
  const events: BaseEvent[] = [
    { type: EventType.RUN_STARTED, threadId: task.threadId, runId },
    { type: EventType.STATE_SNAPSHOT, snapshot: startState },
    { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
    ...[
      '正在读取本地任务样本。',
      '工具结果会与事件一起记录。',
      '重新连接后将从检查点继续展示。',
    ].map((delta) => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta })),
    { type: EventType.TEXT_MESSAGE_END, messageId },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: 'load_recovery_fixture',
      parentMessageId: messageId,
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify({ taskId: task.taskId, source: 'local-fixture' }),
    },
    { type: EventType.TOOL_CALL_END, toolCallId },
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: `${runId}_tool_result`,
      role: 'tool',
      content: JSON.stringify({ cards }),
    },
  ];
  const completed = events.reduce(reduceRecoveryState, startState);
  events.push(
    { type: EventType.STATE_SNAPSHOT, snapshot: completed },
    { type: EventType.RUN_FINISHED, threadId: task.threadId, runId },
  );
  return events.map((event) => EventSchemas.parse(event));
}

/** Reduces recorded facts only; TOOL_CALL_RESULT counts the already committed effect. */
export function reduceRecoveryState(state: RecoveryState, value: BaseEvent): RecoveryState {
  recoveryStateSchema.parse(state);
  const event = EventSchemas.parse(value);
  if (event.type === EventType.RUN_STARTED) {
    return {
      ...initialRecoveryState(),
      status: 'running',
      toolExecutionCount: state.toolExecutionCount,
    };
  }
  if (state.status !== 'running') throw new Error(`${event.type} 到达时没有活动运行。`);

  switch (event.type) {
    case EventType.STATE_SNAPSHOT: {
      const snapshot = recoveryStateSchema.parse(event.snapshot);
      if (snapshot.status !== 'running' || snapshot.toolExecutionCount !== state.toolExecutionCount)
        throw new Error('状态快照不能改变运行阶段或工具执行计数。');
      return snapshot;
    }
    case EventType.TEXT_MESSAGE_START:
      if (state.messageId !== null || (event.role && event.role !== 'assistant'))
        throw new Error('文本消息已经开始或角色不受支持。');
      return { ...state, messageId: event.messageId, text: '' };
    case EventType.TEXT_MESSAGE_CONTENT:
      assertMessage(state, event.messageId);
      return { ...state, text: state.text + event.delta };
    case EventType.TEXT_MESSAGE_END:
      assertMessage(state, event.messageId);
      return state;
    case EventType.TOOL_CALL_START:
      if (
        state.toolStatus !== 'idle' ||
        state.toolCallId !== null ||
        state.messageId === null ||
        (event.parentMessageId !== undefined && event.parentMessageId !== state.messageId)
      )
        throw new Error('工具调用不能开始，或父消息不一致。');
      return { ...state, toolCallId: event.toolCallId, toolStatus: 'arguments' };
    case EventType.TOOL_CALL_ARGS:
      assertTool(state, event.toolCallId, 'arguments');
      return state;
    case EventType.TOOL_CALL_END:
      assertTool(state, event.toolCallId, 'arguments');
      return { ...state, toolStatus: 'running' };
    case EventType.TOOL_CALL_RESULT: {
      assertTool(state, event.toolCallId, 'running');
      if (typeof event.content !== 'string') throw new Error('本实验的工具结果必须是 JSON 文本。');
      const { cards } = toolResultSchema.parse(JSON.parse(event.content));
      const next = recoveryStateSchema.parse({
        ...state,
        cards,
        toolStatus: 'completed',
        toolExecutionCount: state.toolExecutionCount + 1,
      });
      return next;
    }
    case EventType.RUN_FINISHED:
      if (event.outcome?.type === 'interrupt') throw new Error('本实验没有等待输入阶段。');
      if (event.outcome?.type === 'cancelled') return { ...state, status: 'cancelled' };
      if (state.toolStatus !== 'completed') throw new Error('工具结果尚未记录，运行不能完成。');
      return { ...state, status: 'succeeded' };
    case EventType.RUN_ERROR:
      return { ...state, status: 'failed' };
    default:
      throw new Error(`任务恢复实验不支持事件 ${event.type}。`);
  }
}

function assertMessage(state: RecoveryState, messageId: string): void {
  if (state.messageId !== messageId || state.toolStatus !== 'idle')
    throw new Error('文本事件与当前消息不一致。');
}

function assertTool(
  state: RecoveryState,
  toolCallId: string,
  status: RecoveryState['toolStatus'],
): void {
  if (state.toolCallId !== toolCallId || state.toolStatus !== status)
    throw new Error('工具事件与当前调用或阶段不一致。');
}
