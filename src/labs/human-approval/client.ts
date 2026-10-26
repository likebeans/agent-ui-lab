import type { LabMode, LabRuntime } from '../../../shared/lab-contract';
import {
  APPROVAL_API,
  DROP_RESPONSE_HEADER,
  TEACHING_SESSION_HEADER,
  WORKSHOPS,
  type ApprovalCommand,
  type ApprovalFactsResult,
  type ApprovalResult,
  type ApprovalTask,
  type Enrollment,
  type EnrollmentInput,
  type FieldErrors,
} from '../../../shared/labs/human-approval/types';

export const APPROVAL_REQUEST_TIMEOUT_MS = 10_000;

export type Reply<T> = { kind: 'known'; value: T } | { kind: 'unknown'; reason: string };

export interface SavedCommand {
  teachingSessionId: string;
  command: ApprovalCommand;
  purpose: 'operation' | 'replay' | 'experiment';
}

// This is a viewer's recovery locator, never a saved task or business record.
export interface RecoveryLocator {
  version: 1;
  teachingSessionId: string;
  taskId: string | null;
  pending: SavedCommand | null;
  archivedPending: SavedCommand | null;
}

const codes = new Set([
  'INVALID_INPUT',
  'NOT_FOUND',
  'SESSION_MISMATCH',
  'KEY_REUSED',
  'VERSION_CONFLICT',
  'PROPOSAL_VERSION_CONFLICT',
  'INVALID_STATE',
  'EXPIRED',
]);
const taskStatuses = new Set([
  'queued',
  'running',
  'waiting-input',
  'succeeded',
  'failed',
  'cancelled',
]);
const proposalStatuses = new Set(['pending', 'approved', 'rejected', 'expired']);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const member = (values: ReadonlySet<string>, value: unknown): boolean =>
  typeof value === 'string' && values.has(value);

function isInput(value: unknown): value is EnrollmentInput {
  return (
    object(value) &&
    typeof value.attendeeName === 'string' &&
    value.attendeeName.trim().length > 0 &&
    value.attendeeName.length <= 80 &&
    WORKSHOPS.some((workshop) => workshop.id === value.workshopId) &&
    integer(value.seats, 1) &&
    value.seats <= 6
  );
}

export function sameInput(left: EnrollmentInput, right: EnrollmentInput): boolean {
  return (
    left.attendeeName === right.attendeeName &&
    left.workshopId === right.workshopId &&
    left.seats === right.seats
  );
}

function isTask(value: unknown): value is ApprovalTask {
  if (
    !object(value) ||
    !identifier(value.taskId) ||
    !identifier(value.threadId) ||
    !integer(value.version) ||
    !member(taskStatuses, value.status) ||
    !(value.currentRunId === null || identifier(value.currentRunId)) ||
    !object(value.state) ||
    !object(value.state.proposal)
  )
    return false;
  const proposal = value.state.proposal;
  return (
    identifier(proposal.proposalId) &&
    integer(proposal.proposalVersion, 1) &&
    identifier(proposal.teachingSessionId) &&
    isInput(proposal.content) &&
    member(proposalStatuses, proposal.status) &&
    timestamp(proposal.createdAt) &&
    timestamp(proposal.expiresAt) &&
    (proposal.decidedAt === null || timestamp(proposal.decidedAt))
  );
}

function isEnrollment(value: unknown): value is Enrollment {
  return (
    object(value) &&
    identifier(value.enrollmentId) &&
    identifier(value.taskId) &&
    identifier(value.proposalId) &&
    integer(value.proposalVersion, 1) &&
    identifier(value.teachingSessionId) &&
    identifier(value.commandId) &&
    isInput(value.content) &&
    timestamp(value.createdAt)
  );
}

function isFieldErrors(value: unknown): value is FieldErrors {
  return (
    object(value) &&
    Object.entries(value).every(
      ([key, message]) => ['attendeeName', 'workshopId', 'seats'].includes(key) && text(message),
    )
  );
}

function enrollmentMatchesTask(enrollment: Enrollment | null, task: ApprovalTask): boolean {
  const proposal = task.state.proposal;
  return (
    (enrollment === null && proposal.status !== 'approved') ||
    (enrollment !== null &&
      enrollment.taskId === task.taskId &&
      enrollment.proposalId === proposal.proposalId &&
      enrollment.proposalVersion === proposal.proposalVersion &&
      enrollment.teachingSessionId === proposal.teachingSessionId &&
      proposal.status === 'approved' &&
      sameInput(enrollment.content, proposal.content))
  );
}

export function isResult(value: unknown): value is ApprovalResult {
  if (!object(value) || 'error' in value) return false;
  if (value.status === 'rejected')
    return (
      member(codes, value.code) &&
      text(value.reason) &&
      (value.fieldErrors === undefined || isFieldErrors(value.fieldErrors))
    );
  if (value.status === 'conflict')
    return integer(value.version) && member(codes, value.code) && text(value.reason);
  return (
    value.status === 'accepted' &&
    integer(value.version) &&
    typeof value.replayed === 'boolean' &&
    object(value.result) &&
    isTask(value.result.task) &&
    value.result.task.version === value.version &&
    (value.result.enrollment === null || isEnrollment(value.result.enrollment)) &&
    enrollmentMatchesTask(value.result.enrollment, value.result.task)
  );
}

export function isFacts(value: unknown): value is ApprovalFactsResult {
  if (!object(value) || 'error' in value) return false;
  if (value.status === 'rejected') return isResult(value);
  return (
    value.status === 'found' &&
    timestamp(value.asOf) &&
    isTask(value.task) &&
    (value.enrollment === null || isEnrollment(value.enrollment)) &&
    enrollmentMatchesTask(value.enrollment, value.task) &&
    value.recordCount === (value.enrollment === null ? 0 : 1) &&
    (value.receipt === null ||
      (isResult(value.receipt) &&
        (value.receipt.status !== 'accepted' ||
          (value.receipt.result.task.taskId === value.task.taskId &&
            value.receipt.result.task.state.proposal.teachingSessionId ===
              value.task.state.proposal.teachingSessionId)))) &&
    (value.durability === 'sqlite' || value.durability === 'memory')
  );
}

export function acceptedMatchesCommand(
  result: Extract<ApprovalResult, { status: 'accepted' }>,
  saved: SavedCommand,
): boolean {
  const { command, teachingSessionId } = saved;
  const { task, enrollment } = result.result;
  const proposal = task.state.proposal;
  if (
    task.taskId !== command.taskId ||
    proposal.teachingSessionId !== teachingSessionId ||
    result.version !== command.expectedVersion + 1
  )
    return false;
  const action = command.payload;
  if (action.type === 'propose')
    return proposal.status === 'pending' && sameInput(proposal.content, action.input);
  if (proposal.proposalId !== action.proposalId) return false;
  if (action.type === 'edit')
    return (
      proposal.status === 'pending' &&
      proposal.proposalVersion === action.proposalVersion + 1 &&
      sameInput(proposal.content, action.input)
    );
  if (proposal.proposalVersion !== action.proposalVersion) return false;
  return action.type === 'approve'
    ? proposal.status === 'approved' && enrollment?.commandId === command.commandId
    : proposal.status === 'rejected' && enrollment === null;
}

function isCommand(value: unknown): value is ApprovalCommand {
  if (
    !object(value) ||
    !identifier(value.commandId) ||
    !identifier(value.taskId) ||
    !integer(value.expectedVersion) ||
    !object(value.payload)
  )
    return false;
  const action = value.payload;
  if (action.type === 'propose')
    return isInput(action.input) && (action.validity === 'standard' || action.validity === 'short');
  if (!identifier(action.proposalId) || !integer(action.proposalVersion, 1)) return false;
  return action.type === 'edit'
    ? isInput(action.input)
    : action.type === 'approve' || action.type === 'reject';
}

function isSavedCommand(value: unknown): value is SavedCommand {
  return (
    object(value) &&
    identifier(value.teachingSessionId) &&
    isCommand(value.command) &&
    (value.purpose === 'operation' || value.purpose === 'replay' || value.purpose === 'experiment')
  );
}

const storageKey = (mode: LabMode) => `agent-ui-lab.human-approval.locator.v1.${mode}`;

export function loadLocator(mode: LabMode): {
  locator: RecoveryLocator | null;
  storageAvailable: boolean;
} {
  try {
    const raw = sessionStorage.getItem(storageKey(mode));
    if (!raw) return { locator: null, storageAvailable: true };
    const value: unknown = JSON.parse(raw);
    if (
      !object(value) ||
      value.version !== 1 ||
      !identifier(value.teachingSessionId) ||
      !(value.taskId === null || identifier(value.taskId)) ||
      !(value.pending === null || isSavedCommand(value.pending)) ||
      !(value.archivedPending === null || isSavedCommand(value.archivedPending)) ||
      (value.pending !== null && value.pending.command.taskId !== value.taskId)
    )
      return { locator: null, storageAvailable: false };
    return { locator: value as unknown as RecoveryLocator, storageAvailable: true };
  } catch {
    return { locator: null, storageAvailable: false };
  }
}

export function saveLocator(mode: LabMode, locator: RecoveryLocator): boolean {
  try {
    sessionStorage.setItem(storageKey(mode), JSON.stringify(locator));
    return true;
  } catch {
    return false;
  }
}

async function requestDomain<T>(
  runtime: LabRuntime,
  path: string,
  options: RequestInit,
  identity: { taskId: string; threadId: string },
  requestPayload: unknown,
  eventType: 'human-approval/result' | 'human-approval/facts',
  validate: (value: unknown) => value is T,
): Promise<Reply<T>> {
  const browser = runtime.mode === 'pages';
  runtime.trace({
    ...identity,
    eventType: 'human-approval/request',
    direction: browser ? 'client→browser-agent' : 'client→server',
    transport: browser ? 'browser-memory' : 'HTTP',
    label: `${options.method ?? 'GET'} ${path}`,
    payload: requestPayload,
    note: browser ? '逻辑路由；浏览器内模拟，没有 HTTP 请求。' : undefined,
  });
  const controller = new AbortController();
  const signal = AbortSignal.any([
    runtime.signal,
    controller.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  let timedOut = false;
  let abort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('审批请求等待超时。', 'TimeoutError'));
  }, APPROVAL_REQUEST_TIMEOUT_MS);
  try {
    const { response, body } = await Promise.race([
      (async () => {
        signal.throwIfAborted();
        const response = await runtime.request(path, { ...options, signal });
        const body = await response.text();
        return { response, body };
      })(),
      interrupted,
    ]);
    signal.throwIfAborted();
    let raw: unknown;
    let parsed = false;
    try {
      raw = JSON.parse(body);
      parsed = true;
    } catch {
      raw = body;
    }
    if (!runtime.signal.aborted)
      runtime.trace({
        ...identity,
        eventType,
        direction: browser ? 'browser-agent→client' : 'server→client',
        transport: browser ? 'browser-memory' : 'HTTP',
        label: eventType === 'human-approval/facts' ? '报名事实查询原始结果' : '报名命令原始结果',
        payload: raw,
        note: response.status >= 500 ? `HTTP ${response.status}，结果未知。` : undefined,
      });
    if (response.status >= 500)
      return { kind: 'unknown', reason: `接口返回 ${response.status}；不能据此判断命令是否提交。` };
    if (!parsed || !validate(raw))
      return { kind: 'unknown', reason: '响应不符合报名领域契约，无法判断命令结果。' };
    return { kind: 'known', value: raw };
  } catch {
    return {
      kind: 'unknown',
      reason: timedOut
        ? '等待完整响应超时，命令可能已经提交。请先查询事实，必要时使用原命令重试。'
        : '未收到可验证的完整结果，连接或响应解析可能中断。',
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export function sendCommand(
  runtime: LabRuntime,
  saved: SavedCommand,
  dropResponse = false,
): Promise<Reply<ApprovalResult>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [TEACHING_SESSION_HEADER]: saved.teachingSessionId,
  };
  if (dropResponse) headers[DROP_RESPONSE_HEADER] = '1';
  return requestDomain(
    runtime,
    `${APPROVAL_API}/commands`,
    { method: 'POST', headers, body: JSON.stringify(saved.command) },
    { taskId: saved.command.taskId, threadId: saved.teachingSessionId },
    saved.command,
    'human-approval/result',
    (value): value is ApprovalResult =>
      isResult(value) && (value.status !== 'accepted' || acceptedMatchesCommand(value, saved)),
  );
}

export function queryFacts(
  runtime: LabRuntime,
  teachingSessionId: string,
  taskId: string,
  commandId?: string,
): Promise<Reply<ApprovalFactsResult>> {
  const query = { taskId, ...(commandId ? { commandId } : {}) };
  const search = new URLSearchParams(query);
  return requestDomain(
    runtime,
    `${APPROVAL_API}/facts?${search}`,
    { headers: { [TEACHING_SESSION_HEADER]: teachingSessionId } },
    { taskId, threadId: teachingSessionId },
    query,
    'human-approval/facts',
    (value): value is ApprovalFactsResult =>
      isFacts(value) &&
      (value.status !== 'found' ||
        (value.task.taskId === taskId &&
          value.task.state.proposal.teachingSessionId === teachingSessionId)),
  );
}
