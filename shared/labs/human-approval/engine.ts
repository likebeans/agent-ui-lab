import type { ApprovalStore, ApprovalTransaction } from './ports';
import {
  approvalCommandFingerprint,
  approvalCommandSchema,
  approvalContextSchema,
  approvalFactsQuerySchema,
  enrollmentFieldErrors,
} from './schema';
import type {
  ApprovalCode,
  ApprovalCommand,
  ApprovalFactsResult,
  ApprovalResult,
  ApprovalTask,
  Enrollment,
  TeachingContext,
} from './types';

export interface ApprovalServiceOptions {
  now?: () => number;
  createId?: (kind: 'proposal' | 'enrollment' | 'run') => string;
  standardTtlMs?: number;
  shortTtlMs?: number;
  /** A composed workflow keeps one run across the human input boundary. */
  startRunOnPropose?: boolean;
}

export interface ApprovalService {
  command(context: unknown, input: unknown): ApprovalResult;
  facts(context: unknown, query: unknown): ApprovalFactsResult;
}

function rejected(
  code: ApprovalCode,
  reason: string,
): Extract<ApprovalResult, { status: 'rejected' }> {
  return { status: 'rejected', code, reason };
}

function conflict(version: number, code: ApprovalCode, reason: string): ApprovalResult {
  return { status: 'conflict', version, code, reason };
}

function accepted(task: ApprovalTask, enrollment: Enrollment | null = null): ApprovalResult {
  return {
    status: 'accepted',
    version: task.version,
    replayed: false,
    result: { task, enrollment },
  };
}

export function createApprovalService(
  store: ApprovalStore,
  options: ApprovalServiceOptions = {},
): ApprovalService {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? ((kind) => `${kind}-${globalThis.crypto.randomUUID()}`);
  const standardTtlMs = options.standardTtlMs ?? 300_000;
  const shortTtlMs = options.shortTtlMs ?? 5_000;

  function execute(
    transaction: ApprovalTransaction,
    context: TeachingContext,
    command: ApprovalCommand,
    task: ApprovalTask | null,
  ): ApprovalResult {
    const payload = command.payload;
    const version = task?.version ?? 0;
    if (!task && payload.type !== 'propose') return rejected('NOT_FOUND', '任务不存在。');
    if (command.expectedVersion !== version)
      return conflict(version, 'VERSION_CONFLICT', '任务版本已改变，请查询最新提议。');

    if (!task) {
      // Only a validated propose command reaches this branch.
      if (payload.type !== 'propose') return rejected('NOT_FOUND', '任务不存在。');
      const createdAt = now();
      const proposalTask: ApprovalTask = {
        taskId: command.taskId,
        threadId: context.teachingSessionId,
        version: 1,
        status: 'waiting-input',
        currentRunId: options.startRunOnPropose ? createId('run') : null,
        state: {
          proposal: {
            proposalId: createId('proposal'),
            proposalVersion: 1,
            teachingSessionId: context.teachingSessionId,
            content: structuredClone(payload.input),
            status: 'pending',
            createdAt,
            expiresAt: createdAt + (payload.validity === 'short' ? shortTtlMs : standardTtlMs),
            decidedAt: null,
          },
        },
      };
      transaction.putTask(proposalTask);
      return accepted(proposalTask);
    }

    if (payload.type === 'propose')
      return conflict(version, 'INVALID_STATE', '任务已有提议，请使用新的任务标识。');

    const proposal = task.state.proposal;
    if (payload.proposalId !== proposal.proposalId) return rejected('NOT_FOUND', '提议不存在。');
    if (payload.proposalVersion !== proposal.proposalVersion)
      return conflict(version, 'PROPOSAL_VERSION_CONFLICT', '提议内容版本已改变，请核对最新内容。');
    if (task.status !== 'waiting-input' || proposal.status !== 'pending')
      return conflict(version, 'INVALID_STATE', '提议已经结束，不能再次修改或决定。');

    const asOf = now();
    if (asOf >= proposal.expiresAt) return rejected('EXPIRED', '提议已过期，请重新生成。');

    if (payload.type === 'edit') {
      const edited: ApprovalTask = {
        ...task,
        version: version + 1,
        state: {
          ...task.state,
          proposal: {
            ...proposal,
            proposalVersion: proposal.proposalVersion + 1,
            content: structuredClone(payload.input),
          },
        },
      };
      transaction.putTask(edited);
      return accepted(edited);
    }

    const enrollment: Enrollment | null =
      payload.type === 'approve'
        ? {
            enrollmentId: createId('enrollment'),
            taskId: task.taskId,
            proposalId: proposal.proposalId,
            proposalVersion: proposal.proposalVersion,
            teachingSessionId: context.teachingSessionId,
            commandId: command.commandId,
            content: structuredClone(proposal.content),
            createdAt: asOf,
          }
        : null;
    const decided: ApprovalTask = {
      ...task,
      version: version + 1,
      status: payload.type === 'approve' ? 'succeeded' : 'cancelled',
      currentRunId: task.currentRunId ?? (payload.type === 'approve' ? createId('run') : null),
      state: {
        ...task.state,
        proposal: {
          ...proposal,
          status: payload.type === 'approve' ? 'approved' : 'rejected',
          decidedAt: asOf,
        },
      },
    };
    transaction.putTask(decided);
    if (enrollment) transaction.putEnrollment(enrollment);
    return accepted(decided, enrollment);
  }

  return {
    command(context, input) {
      const parsedContext = approvalContextSchema.safeParse(context);
      if (!parsedContext.success) return rejected('INVALID_INPUT', '请提供有效的教学会话标识。');
      const parsed = approvalCommandSchema.safeParse(input);
      if (!parsed.success) {
        const fieldErrors = enrollmentFieldErrors(parsed.error);
        return {
          ...rejected('INVALID_INPUT', parsed.error.issues[0]?.message ?? '命令格式不合法。'),
          ...(fieldErrors ? { fieldErrors } : {}),
        };
      }
      const command = parsed.data;
      const teachingSessionId = parsedContext.data.teachingSessionId;
      const fingerprint = approvalCommandFingerprint(input);
      return store.transaction((transaction) => {
        const task = transaction.getTask(command.taskId);
        // Ownership must be checked even when a command receipt already exists.
        if (task && task.state.proposal.teachingSessionId !== teachingSessionId)
          return rejected('SESSION_MISMATCH', '任务不属于当前教学会话。');

        const receipt = transaction.getCommand(teachingSessionId, command.commandId);
        if (receipt) {
          if (receipt.taskId !== command.taskId || receipt.fingerprint !== fingerprint)
            return conflict(task?.version ?? 0, 'KEY_REUSED', '命令标识已用于其他操作或参数。');
          return receipt.result.status === 'accepted'
            ? { ...receipt.result, replayed: true }
            : receipt.result;
        }

        const result = execute(transaction, parsedContext.data, command, task);
        transaction.putCommand({
          teachingSessionId,
          commandId: command.commandId,
          taskId: command.taskId,
          fingerprint,
          result,
        });
        return result;
      });
    },
    facts(context, query) {
      const parsedContext = approvalContextSchema.safeParse(context);
      if (!parsedContext.success) return rejected('INVALID_INPUT', '请提供有效的教学会话标识。');
      const parsed = approvalFactsQuerySchema.safeParse(query);
      if (!parsed.success) return rejected('INVALID_INPUT', '事实查询格式不合法。');
      const { taskId, commandId } = parsed.data;
      const { teachingSessionId } = parsedContext.data;
      return store.transaction((transaction) => {
        const task = transaction.getTask(taskId);
        if (task && task.state.proposal.teachingSessionId !== teachingSessionId)
          return rejected('SESSION_MISMATCH', '任务不属于当前教学会话。');
        const receipt = commandId ? transaction.getCommand(teachingSessionId, commandId) : null;
        if (receipt && receipt.taskId !== taskId)
          return rejected('KEY_REUSED', '命令标识属于其他任务，不能用于此次事实查询。');
        if (!task) return rejected('NOT_FOUND', '任务不存在。');
        const asOf = now();
        const proposal = task.state.proposal;
        const snapshot: ApprovalTask =
          proposal.status === 'pending' && asOf >= proposal.expiresAt
            ? { ...task, state: { ...task.state, proposal: { ...proposal, status: 'expired' } } }
            : task;
        const enrollment = transaction.getEnrollment(taskId);
        return {
          status: 'found',
          asOf,
          task: snapshot,
          enrollment,
          recordCount: enrollment ? 1 : 0,
          receipt: receipt?.result ?? null,
          durability: store.durability,
        };
      });
    },
  };
}
