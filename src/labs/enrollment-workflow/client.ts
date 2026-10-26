import { z } from 'zod';
import type { LabRuntime } from '../../../shared/lab-contract';
import { validateTaskLocator, type TaskLocator } from '../../../shared/labs/task-locator';
import { LAB_INSTANCE_ID } from '../../../shared/instance';
import {
  a2uiClientActionSchema,
  a2uiMessagesSchema,
  applyA2uiMessages,
  resolveA2uiAction,
  type A2uiSurface,
} from '../../../shared/a2ui';
import {
  actionMatchesCommand,
  workflowForm,
} from '../../../shared/labs/enrollment-workflow/surface';
import { approvalCommandSchema } from '../../../shared/labs/human-approval/schema';
import {
  TEACHING_SESSION_HEADER,
  type ApprovalCommand,
  type ApprovalResult,
} from '../../../shared/labs/human-approval/types';
import {
  WORKFLOW_API,
  WORKFLOW_DROP_HEADER,
  workflowIdSchema,
  parseWorkflowEvent,
  type WorkflowFacts,
  type WorkflowFactsResult,
} from '../../../shared/labs/enrollment-workflow/contract';
import { acceptedMatchesCommand, isFacts, isResult, type Reply } from '../human-approval/client';

const savedSchema = z.strictObject({
  session: workflowIdSchema,
  command: approvalCommandSchema,
  action: a2uiClientActionSchema.optional(),
});
export type WorkflowSaved = z.infer<typeof savedSchema>;
const locatorSchema = z.strictObject({
  session: workflowIdSchema,
  taskId: workflowIdSchema,
  pending: savedSchema.nullable(),
  last: savedSchema.nullable(),
});
export type WorkflowLocator = z.infer<typeof locatorSchema>;

function key(mode: LabRuntime['mode']) {
  return `enrollment-workflow:${LAB_INSTANCE_ID}:${mode}`;
}
export function newWorkflowLocator(): WorkflowLocator {
  return {
    session: `session-${crypto.randomUUID()}`,
    taskId: `task-${crypto.randomUUID()}`,
    pending: null,
    last: null,
  };
}
export function loadWorkflowLocator(mode: LabRuntime['mode']): {
  locator: WorkflowLocator;
  restored: boolean;
  storageAvailable: boolean;
} {
  try {
    const value = sessionStorage.getItem(key(mode));
    if (!value) return { locator: newWorkflowLocator(), restored: false, storageAvailable: true };
    const parsed = locatorSchema.safeParse(JSON.parse(value));
    if (
      parsed.success &&
      [parsed.data.pending, parsed.data.last].every(
        (saved) =>
          !saved ||
          (saved.session === parsed.data.session && saved.command.taskId === parsed.data.taskId),
      )
    )
      return { locator: parsed.data, restored: true, storageAvailable: true };
    return { locator: newWorkflowLocator(), restored: false, storageAvailable: true };
  } catch {
    return { locator: newWorkflowLocator(), restored: false, storageAvailable: false };
  }
}
export function saveWorkflowLocator(mode: LabRuntime['mode'], locator: WorkflowLocator): boolean {
  try {
    sessionStorage.setItem(key(mode), JSON.stringify(locator));
    return true;
  } catch {
    return false;
  }
}

export function restoreWorkflowSurface(
  value: Pick<WorkflowFacts, 'task' | 'messages'>,
): A2uiSurface {
  const surface = applyA2uiMessages(null, value.messages);
  const expected = applyA2uiMessages(null, workflowForm(value.task, value.task.taskId))!;
  if (
    !surface ||
    surface.catalogId !== expected.catalogId ||
    Object.keys(surface.components).length !== Object.keys(expected.components).length ||
    Object.entries(expected.components).some(
      ([id, component]) => JSON.stringify(surface.components[id]) !== JSON.stringify(component),
    ) ||
    !actionMatchesCommand(resolveA2uiAction(surface, 'submit'), {
      taskId: value.task.taskId,
      commandId: 'validate-restored-form',
      expectedVersion: value.task.version,
      payload: {
        type: 'edit',
        proposalId: value.task.state.proposal.proposalId,
        proposalVersion: value.task.state.proposal.proposalVersion,
        input: value.task.state.proposal.content,
      },
    })
  )
    throw new Error('恢复表单与已保存任务的身份、版本或内容不一致。');
  return surface;
}

function isWorkflowFacts(value: unknown): value is WorkflowFactsResult {
  if (!isFacts(value)) return false;
  if (value.status !== 'found') return true;
  const extra = value as unknown as Record<string, unknown>;
  const checkpoint = z
    .object({
      task: z.unknown(),
      cursor: z.object({ runId: workflowIdSchema, afterSeq: z.int().nonnegative() }),
    })
    .safeParse(extra.checkpoint);
  if (
    !checkpoint.success ||
    JSON.stringify(checkpoint.data.task) !== JSON.stringify(value.task) ||
    checkpoint.data.cursor.runId !== value.task.currentRunId ||
    !Array.isArray(extra.events) ||
    !a2uiMessagesSchema.safeParse(extra.messages).success
  )
    return false;
  try {
    restoreWorkflowSurface({
      task: value.task,
      messages: a2uiMessagesSchema.parse(extra.messages),
    });
    const events = extra.events.map(parseWorkflowEvent);
    return events.every(
      (event, index) =>
        event.taskId === value.task.taskId &&
        event.runId === value.task.currentRunId &&
        event.seq === checkpoint.data.cursor.afterSeq - events.length + index + 1,
    );
  } catch {
    return false;
  }
}

async function request<T>(
  runtime: LabRuntime,
  path: string,
  session: string,
  body: unknown | undefined,
  validate: (value: unknown) => value is T,
  drop = false,
  externalSignal?: AbortSignal,
): Promise<Reply<T>> {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    runtime.signal,
    controller.signal,
    ...(externalSignal ? [externalSignal] : []),
  ]);
  const timer = setTimeout(
    () => controller.abort(new DOMException('请求超时', 'TimeoutError')),
    10_000,
  );
  let abort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const browser = runtime.mode === 'pages';
  runtime.trace({
    direction: browser ? 'client→browser-agent' : 'client→server',
    transport: browser ? 'browser-memory' : 'HTTP',
    eventType: 'enrollment-workflow/request',
    threadId: session,
    label: `${body === undefined ? 'GET' : 'POST'} ${path}`,
    payload: body ?? path,
    note: browser ? '逻辑路由；本次调用在浏览器内执行。' : undefined,
  });
  try {
    const { response, raw } = await Promise.race([
      (async () => {
        signal.throwIfAborted();
        const response = await runtime.request(path, {
          method: body === undefined ? 'GET' : 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            [TEACHING_SESSION_HEADER]: session,
            ...(drop ? { [WORKFLOW_DROP_HEADER]: '1' } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { response, raw: await response.text() };
      })(),
      interrupted,
    ]);
    signal.throwIfAborted();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    runtime.trace({
      direction: browser ? 'browser-agent→client' : 'server→client',
      transport: browser ? 'browser-memory' : 'HTTP',
      threadId: session,
      eventType: 'enrollment-workflow/result',
      label: '组合流程原始响应',
      payload: value,
    });
    if (response.status >= 500 || !validate(value))
      return { kind: 'unknown', reason: '未收到符合契约的完整结果，请先查询事实；原命令仍保留。' };
    return { kind: 'known', value };
  } catch {
    return {
      kind: 'unknown',
      reason: '连接或完整响应等待中断，命令可能已提交。请先查询事实，再决定是否重试原命令。',
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export function sendWorkflow(runtime: LabRuntime, saved: WorkflowSaved, drop = false) {
  return request<ApprovalResult>(
    runtime,
    `${WORKFLOW_API}/commands`,
    saved.session,
    { command: saved.command, ...(saved.action ? { action: saved.action } : {}) },
    (value): value is ApprovalResult =>
      isResult(value) &&
      (value.status !== 'accepted' ||
        acceptedMatchesCommand(value, {
          teachingSessionId: saved.session,
          command: saved.command,
          purpose: 'operation',
        })),
    drop,
  );
}

export function readWorkflow(runtime: LabRuntime, locator: WorkflowLocator, signal?: AbortSignal) {
  const search = new URLSearchParams({
    taskId: locator.taskId,
    afterSeq: '0',
    ...((locator.pending ?? locator.last)
      ? { commandId: (locator.pending ?? locator.last)!.command.commandId }
      : {}),
  });
  return request<WorkflowFactsResult>(
    runtime,
    `${WORKFLOW_API}/facts?${search}`,
    locator.session,
    undefined,
    (value): value is WorkflowFactsResult =>
      isWorkflowFacts(value) &&
      (value.status !== 'found' ||
        (value.task.taskId === locator.taskId &&
          value.task.threadId === locator.session &&
          value.task.state.proposal.teachingSessionId === locator.session &&
          value.events.length === value.checkpoint.cursor.afterSeq)),
    false,
    signal,
  );
}

/** Imported identities query facts only; saved or pending commands are never imported. */
export function openWorkflowTask(runtime: LabRuntime, locator: TaskLocator, signal?: AbortSignal) {
  const target = validateTaskLocator(locator, { labId: 'enrollment-workflow', mode: runtime.mode });
  return readWorkflow(
    runtime,
    { session: target.teachingSessionId, taskId: target.taskId, pending: null, last: null },
    signal,
  );
}

export function workflowCommand(
  locator: WorkflowLocator,
  expectedVersion: number,
  payload: ApprovalCommand['payload'],
): WorkflowSaved {
  return {
    session: locator.session,
    command: { commandId: crypto.randomUUID(), taskId: locator.taskId, expectedVersion, payload },
  };
}
