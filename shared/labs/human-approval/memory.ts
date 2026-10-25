import type { ApprovalStore, ApprovalTransaction } from './ports';
import type { ApprovalTask, Enrollment, StoredApprovalCommand } from './types';

interface MemoryState {
  tasks: Map<string, ApprovalTask>;
  commands: Map<string, Map<string, StoredApprovalCommand>>;
  enrollments: Map<string, Enrollment>;
}

interface TransactionFrame {
  state: MemoryState;
  open: boolean;
}

export function createMemoryApprovalStore(): ApprovalStore {
  let state: MemoryState = { tasks: new Map(), commands: new Map(), enrollments: new Map() };
  let active: TransactionFrame | undefined;

  return {
    durability: 'memory',
    transaction(operation) {
      if (Object.prototype.toString.call(operation) === '[object AsyncFunction]')
        throw new Error('Approval transaction callbacks must be synchronous.');
      const parent = active;
      const frame: TransactionFrame = {
        state: structuredClone(parent?.state ?? state),
        open: true,
      };
      active = frame;
      function current(): MemoryState {
        if (!frame.open) throw new Error('Approval transaction is closed.');
        return frame.state;
      }
      const transaction: ApprovalTransaction = {
        getTask(taskId) {
          return structuredClone(current().tasks.get(taskId) ?? null);
        },
        putTask(task) {
          const tasks = current().tasks;
          const existing = tasks.get(task.taskId);
          if (
            existing &&
            existing.state.proposal.teachingSessionId !== task.state.proposal.teachingSessionId
          )
            throw new Error('Cannot change an approval task teaching session.');
          tasks.set(task.taskId, structuredClone(task));
        },
        getCommand(teachingSessionId, commandId) {
          return structuredClone(current().commands.get(teachingSessionId)?.get(commandId) ?? null);
        },
        putCommand(command) {
          const commands = current().commands;
          const session =
            commands.get(command.teachingSessionId) ?? new Map<string, StoredApprovalCommand>();
          if (session.has(command.commandId)) throw new Error('UNIQUE approval command key.');
          session.set(command.commandId, structuredClone(command));
          commands.set(command.teachingSessionId, session);
        },
        getEnrollment(taskId) {
          return structuredClone(current().enrollments.get(taskId) ?? null);
        },
        putEnrollment(enrollment) {
          const { tasks, enrollments } = current();
          if (
            enrollments.has(enrollment.taskId) ||
            [...enrollments.values()].some(
              (existing) =>
                existing.enrollmentId === enrollment.enrollmentId ||
                existing.proposalId === enrollment.proposalId,
            )
          )
            throw new Error('UNIQUE approval enrollment.');
          const task = tasks.get(enrollment.taskId);
          if (!task || task.state.proposal.teachingSessionId !== enrollment.teachingSessionId)
            throw new Error('FOREIGN KEY approval enrollment task and teaching session.');
          enrollments.set(enrollment.taskId, structuredClone(enrollment));
        },
      };
      try {
        const result = operation(transaction);
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          void Promise.resolve(result).catch(() => {});
          throw new Error('Approval transaction callbacks must be synchronous.');
        }
        if (parent) parent.state = frame.state;
        else state = frame.state;
        return result;
      } finally {
        frame.open = false;
        active = parent;
      }
    },
  };
}
