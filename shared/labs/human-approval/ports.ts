import type { ApprovalTask, Enrollment, StoredApprovalCommand } from './types';

export interface ApprovalTransaction {
  getTask(taskId: string): ApprovalTask | null;
  putTask(task: ApprovalTask): void;
  getCommand(teachingSessionId: string, commandId: string): StoredApprovalCommand | null;
  putCommand(command: StoredApprovalCommand): void;
  getEnrollment(taskId: string): Enrollment | null;
  putEnrollment(enrollment: Enrollment): void;
}

type SynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;

// The callback is synchronous. State, command receipts and business facts commit together.
export interface ApprovalStore {
  readonly durability: 'sqlite' | 'memory';
  transaction<T>(operation: (transaction: ApprovalTransaction) => SynchronousResult<T>): T;
}
