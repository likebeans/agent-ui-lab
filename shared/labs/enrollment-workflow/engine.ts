import { EventType, type AGUIEvent } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { createApprovalService, type ApprovalServiceOptions } from '../human-approval/engine';
import { approvalCommandSchema } from '../human-approval/schema';
import type { ApprovalResult, ApprovalTask } from '../human-approval/types';
import { actionMatchesCommand, workflowForm } from './surface';
import {
  workflowQuerySchema,
  type WorkflowEvent,
  type WorkflowFactsResult,
  type WorkflowStore,
  type WorkflowTransaction,
} from './contract';

export function createWorkflowService(store: WorkflowStore, options: ApprovalServiceOptions = {}) {
  const approval = createApprovalService(store, { ...options, startRunOnPropose: true });

  function record(
    transaction: WorkflowTransaction,
    task: ApprovalTask,
    previous: ApprovalTask | null,
  ) {
    const runId = task.currentRunId!;
    let seq = transaction.getEvents(task.taskId).length;
    function emit(payload: AGUIEvent) {
      const event: WorkflowEvent = {
        taskId: task.taskId,
        runId,
        seq: ++seq,
        payload: EventSchemas.parse(payload),
      };
      transaction.appendEvent(event);
    }
    if (!previous) emit({ type: EventType.RUN_STARTED, threadId: task.threadId, runId });
    emit({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        taskId: task.taskId,
        version: task.version,
        status: task.status,
        proposalId: task.state.proposal.proposalId,
        proposalVersion: task.state.proposal.proposalVersion,
        content: task.state.proposal.content,
      },
    });
    emit({
      type: EventType.CUSTOM,
      name: 'enrollment/proposal',
      value: {
        proposalId: task.state.proposal.proposalId,
        proposalVersion: task.state.proposal.proposalVersion,
        status: task.state.proposal.status,
      },
    });
    const enrollment = transaction.getEnrollment(task.taskId);
    if (enrollment) {
      emit({
        type: EventType.TOOL_CALL_START,
        toolCallId: `tool-${task.taskId}`,
        toolCallName: 'save_enrollment',
      });
      emit({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: `tool-${task.taskId}`,
        delta: JSON.stringify(enrollment.content),
      });
      emit({ type: EventType.TOOL_CALL_END, toolCallId: `tool-${task.taskId}` });
      emit({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: `tool-${task.taskId}`,
        messageId: `result-${task.taskId}`,
        role: 'tool',
        content: JSON.stringify(enrollment),
      });
    }
    if (task.status === 'succeeded' || task.status === 'cancelled')
      emit({
        type: EventType.RUN_FINISHED,
        threadId: task.threadId,
        runId,
        outcome: { type: task.status === 'succeeded' ? 'success' : 'cancelled' },
      });
  }

  return {
    command(context: unknown, input: unknown, action?: unknown): ApprovalResult {
      const parsed = approvalCommandSchema.safeParse(input);
      if (
        parsed.success &&
        ['propose', 'edit'].includes(parsed.data.payload.type) &&
        !actionMatchesCommand(action, parsed.data)
      )
        return {
          status: 'rejected',
          code: 'INVALID_INPUT',
          reason: '表单动作与命令的内容、任务或版本不一致。',
        };
      return store.transaction((transaction) => {
        const previous = parsed.success ? transaction.getTask(parsed.data.taskId) : null;
        const result = approval.command(context, input);
        if (result.status === 'accepted' && !result.replayed)
          record(transaction, result.result.task, previous);
        return result;
      });
    },
    facts(context: unknown, query: unknown): WorkflowFactsResult {
      const parsed = workflowQuerySchema.safeParse(query);
      if (!parsed.success)
        return {
          status: 'rejected',
          code: 'INVALID_INPUT',
          reason: '恢复查询的身份或事件游标无效。',
        };
      return store.transaction((transaction) => {
        const { taskId, commandId, afterSeq, runId } = parsed.data;
        const facts = approval.facts(context, { taskId, ...(commandId ? { commandId } : {}) });
        if (facts.status !== 'found') return facts;
        const events = transaction.getEvents(taskId);
        const currentRun = facts.task.currentRunId!;
        if ((runId && runId !== currentRun) || afterSeq > events.length)
          return {
            status: 'rejected',
            code: 'INVALID_INPUT',
            reason: '游标不属于此任务的当前运行，或超过已提交事件。',
          };
        return {
          ...facts,
          checkpoint: { task: facts.task, cursor: { runId: currentRun, afterSeq: events.length } },
          events: events.filter((event) => event.seq > afterSeq),
          messages: workflowForm(facts.task, taskId),
        };
      });
    },
  };
}
