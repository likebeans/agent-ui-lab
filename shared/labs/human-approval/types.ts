import type { TaskCommand, TaskSnapshot } from '../../lab-contract';

export const APPROVAL_API = '/api/labs/human-approval';
export const TEACHING_SESSION_HEADER = 'X-Teaching-Session';
export const DROP_RESPONSE_HEADER = 'X-Approval-Drop-Response';

export const WORKSHOPS = [
  { id: 'agent-ui-basics', title: 'Agent UI 入门工作坊' },
  { id: 'reliable-actions', title: '可靠业务动作工作坊' },
] as const;

export interface EnrollmentInput {
  attendeeName: string;
  workshopId: (typeof WORKSHOPS)[number]['id'];
  seats: number;
}

export interface TeachingContext {
  teachingSessionId: string;
}

export type ApprovalAction =
  | { type: 'propose'; input: EnrollmentInput; validity: 'standard' | 'short' }
  | { type: 'edit'; proposalId: string; proposalVersion: number; input: EnrollmentInput }
  | { type: 'approve' | 'reject'; proposalId: string; proposalVersion: number };

export type ApprovalCommand = TaskCommand<ApprovalAction>;

export interface ApprovalProposal {
  proposalId: string;
  proposalVersion: number;
  teachingSessionId: string;
  content: EnrollmentInput;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

export interface ApprovalState {
  proposal: ApprovalProposal;
}

export type ApprovalTask = TaskSnapshot<ApprovalState>;

export interface Enrollment {
  enrollmentId: string;
  taskId: string;
  proposalId: string;
  proposalVersion: number;
  teachingSessionId: string;
  commandId: string;
  content: EnrollmentInput;
  createdAt: number;
}

export type ApprovalCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'SESSION_MISMATCH'
  | 'KEY_REUSED'
  | 'VERSION_CONFLICT'
  | 'PROPOSAL_VERSION_CONFLICT'
  | 'INVALID_STATE'
  | 'EXPIRED';

export type FieldErrors = Partial<Record<keyof EnrollmentInput, string>>;

export type ApprovalResult =
  | {
      status: 'accepted';
      version: number;
      replayed: boolean;
      result: { task: ApprovalTask; enrollment: Enrollment | null };
    }
  | { status: 'conflict'; version: number; code: ApprovalCode; reason: string }
  | { status: 'rejected'; code: ApprovalCode; reason: string; fieldErrors?: FieldErrors };

export interface ApprovalFacts {
  status: 'found';
  asOf: number;
  task: ApprovalTask;
  enrollment: Enrollment | null;
  recordCount: number;
  receipt: ApprovalResult | null;
  durability: 'sqlite' | 'memory';
}

export type ApprovalFactsResult = ApprovalFacts | Extract<ApprovalResult, { status: 'rejected' }>;

export interface ApprovalFactsQuery {
  taskId: string;
  commandId?: string;
}

export interface StoredApprovalCommand {
  teachingSessionId: string;
  commandId: string;
  taskId: string;
  fingerprint: string;
  result: ApprovalResult;
}
