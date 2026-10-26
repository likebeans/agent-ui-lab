import { describe, expect, it, vi } from 'vitest';
import { applyA2uiMessages, resolveA2uiAction } from '../../shared/a2ui';
import type { LabRuntime } from '../../shared/lab-contract';
import type { WorkflowFacts } from '../../shared/labs/enrollment-workflow/contract';
import { createWorkflowService } from '../../shared/labs/enrollment-workflow/engine';
import { createMemoryWorkflowStore } from '../../shared/labs/enrollment-workflow/memory';
import { workflowForm } from '../../shared/labs/enrollment-workflow/surface';
import type { ApprovalCommand } from '../../shared/labs/human-approval/types';
import {
  readWorkflow,
  openWorkflowTask,
  type WorkflowLocator,
} from '../../src/labs/enrollment-workflow/client';
import type { TaskLocator } from '../../shared/labs/task-locator';

function fixture() {
  const session = 'restore-form-session';
  const taskId = 'restore-form-task';
  const service = createWorkflowService(createMemoryWorkflowStore());
  const command: ApprovalCommand = {
    taskId,
    commandId: 'restore-form-propose',
    expectedVersion: 0,
    payload: {
      type: 'propose',
      validity: 'standard',
      input: { attendeeName: '示例学员', workshopId: 'agent-ui-basics', seats: 1 },
    },
  };
  const action = resolveA2uiAction(applyA2uiMessages(null, workflowForm(null, taskId))!, 'submit');
  service.command({ teachingSessionId: session }, command, action);
  const value = service.facts({ teachingSessionId: session }, { taskId });
  if (value.status !== 'found') throw new Error('Expected workflow facts');
  const locator: WorkflowLocator = {
    session,
    taskId,
    pending: { session, command, action },
    last: null,
  };
  function runtime(response: WorkflowFacts): LabRuntime {
    return {
      mode: 'local',
      identity: { labId: 'enrollment-workflow' },
      signal: new AbortController().signal,
      request: async () => new Response(JSON.stringify(response)),
      trace() {},
      focusTrace() {},
    };
  }
  return { value, locator, runtime, service };
}

function changeModel(value: WorkflowFacts, patch: Record<string, unknown>) {
  const message = value.messages.find((entry) => 'updateDataModel' in entry);
  if (!message || !('updateDataModel' in message)) throw new Error('Expected model update');
  Object.assign(message.updateDataModel.value as object, patch);
}

const invalidForms: Array<[string, (value: WorkflowFacts) => void]> = [
  [
    'empty declarations',
    (value) => {
      value.messages = [];
    },
  ],
  [
    'a deleted surface',
    (value) => {
      value.messages.push({
        version: 'v0.9.1',
        deleteSurface: { surfaceId: 'enrollment-workflow-form' },
      });
    },
  ],
  ['a foreign task', (value) => changeModel(value, { taskId: 'other-task' })],
  ['an obsolete version', (value) => changeModel(value, { version: 0 })],
  [
    'content from another proposal',
    (value) =>
      changeModel(value, {
        form: { attendeeName: '另一个提议', workshopId: ['agent-ui-basics'], seats: '3' },
      }),
  ],
  [
    'a missing root',
    (value) => {
      const update = value.messages.find((entry) => 'updateComponents' in entry);
      if (update && 'updateComponents' in update)
        update.updateComponents.components = update.updateComponents.components.filter(
          (entry) => entry.id !== 'root',
        );
    },
  ],
  [
    'an invalid binding',
    (value) => {
      const update = value.messages.find((entry) => 'updateComponents' in entry);
      if (update && 'updateComponents' in update) {
        const field = update.updateComponents.components.find((entry) => entry.id === 'seats');
        if (field?.component === 'TextField') field.value.path = '/form/missing';
      }
    },
  ],
  [
    'an unrelated field binding',
    (value) => {
      const update = value.messages.find((entry) => 'updateComponents' in entry);
      if (update && 'updateComponents' in update) {
        const field = update.updateComponents.components.find((entry) => entry.id === 'seats');
        if (field?.component === 'TextField') field.value.path = '/form/attendeeName';
      }
    },
  ],
];

describe('workflow recovery form validation', () => {
  it('accepts the complete form returned by the workflow engine', async () => {
    const { value, locator, runtime } = fixture();
    expect(await readWorkflow(runtime(value), locator)).toEqual({ kind: 'known', value });
  });

  it.each(invalidForms)(
    'rejects %s without changing the pending command or current facts',
    async (_label, mutate) => {
      const { value, locator, runtime } = fixture();
      const originalFacts = structuredClone(value);
      const originalLocator = structuredClone(locator);
      const malformed = structuredClone(value);
      mutate(malformed);
      expect(await readWorkflow(runtime(malformed), locator)).toMatchObject({ kind: 'unknown' });
      expect(locator).toEqual(originalLocator);
      expect(value).toEqual(originalFacts);
    },
  );
});

function portable(locator: WorkflowLocator, mode: LabRuntime['mode'] = 'local'): TaskLocator {
  return {
    version: 1,
    labId: 'enrollment-workflow',
    mode,
    teachingSessionId: locator.session,
    taskId: locator.taskId,
  };
}

describe('opening a workflow identity is query-only', () => {
  it.each(['local', 'pages'] as const)(
    'reads %s checkpoint, full events and surface without importing or sending commands',
    async (mode) => {
      const { value, locator, runtime, service } = fixture();
      const before = structuredClone(value);
      const response = { ...value, receipt: null };
      const request = vi.fn<LabRuntime['request']>(async () => Response.json(response));
      expect(
        await openWorkflowTask({ ...runtime(value), mode, request }, portable(locator, mode)),
      ).toEqual({
        kind: 'known',
        value: response,
      });
      expect(request).toHaveBeenCalledTimes(1);
      const [path, options] = request.mock.calls[0];
      expect(path).toBe(`/api/labs/enrollment-workflow/facts?taskId=${locator.taskId}&afterSeq=0`);
      expect(options?.method).toBe('GET');
      expect(options?.body).toBeUndefined();
      expect(new Headers(options?.headers).get('X-Teaching-Session')).toBe(locator.session);
      expect(
        service.facts({ teachingSessionId: locator.session }, { taskId: locator.taskId }),
      ).toMatchObject({
        task: before.task,
        events: before.events,
        checkpoint: before.checkpoint,
        recordCount: 0,
      });
    },
  );

  it.each([
    ...invalidForms,
    [
      'foreign thread',
      (value: WorkflowFacts) => {
        value.task.threadId = 'foreign-session';
      },
    ],
    [
      'foreign proposal session',
      (value: WorkflowFacts) => {
        value.task.state.proposal.teachingSessionId = 'foreign-session';
      },
    ],
    [
      'foreign task',
      (value: WorkflowFacts) => {
        value.task.taskId = 'foreign-task';
      },
    ],
    [
      'missing event',
      (value: WorkflowFacts) => {
        value.events.shift();
      },
    ],
    [
      'foreign event',
      (value: WorkflowFacts) => {
        value.events[0].taskId = 'foreign-task';
      },
    ],
    [
      'wrong run',
      (value: WorkflowFacts) => {
        value.checkpoint.cursor.runId = 'foreign-run';
      },
    ],
    [
      'incomplete checkpoint',
      (value: WorkflowFacts) => {
        delete (value as Partial<WorkflowFacts>).checkpoint;
      },
    ],
  ] as Array<[string, (value: WorkflowFacts) => void]>)(
    'rejects %s while leaving caller locator, pending command and facts unchanged',
    async (_label, mutate) => {
      const { value, locator, runtime } = fixture();
      const before = structuredClone({ value, locator });
      const malformed = structuredClone(value);
      mutate(malformed);
      expect(await openWorkflowTask(runtime(malformed), portable(locator))).toMatchObject({
        kind: 'unknown',
      });
      expect({ value, locator }).toEqual(before);
    },
  );

  it.each(['NOT_FOUND', 'SESSION_MISMATCH'] as const)(
    'keeps %s read-only with no fallback command',
    async (code) => {
      const { locator, value, runtime } = fixture();
      const request = vi.fn<LabRuntime['request']>(async () =>
        Response.json({ status: 'rejected', code, reason: '未打开任务' }),
      );
      expect(
        await openWorkflowTask({ ...runtime(value), request }, portable(locator)),
      ).toMatchObject({
        kind: 'known',
        value: { status: 'rejected', code },
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects cross-lab, cross-mode or command-bearing identities before requesting', () => {
    const { locator, value, runtime } = fixture();
    const request = vi.fn<LabRuntime['request']>();
    const client = { ...runtime(value), request };
    const target = portable(locator);
    expect(() => openWorkflowTask(client, { ...target, labId: 'human-approval' })).toThrow();
    expect(() => openWorkflowTask(client, { ...target, mode: 'pages' })).toThrow();
    expect(() =>
      openWorkflowTask(client, { ...target, pending: locator.pending } as TaskLocator),
    ).toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('releases an aborted open query and ignores its late response', async () => {
    const { locator, value, runtime } = fixture();
    const controller = new AbortController();
    let finish!: (response: Response) => void;
    const client = {
      ...runtime(value),
      request: () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      trace: vi.fn(),
    };
    const opening = openWorkflowTask(client, portable(locator), controller.signal);
    controller.abort();
    expect(await opening).toMatchObject({ kind: 'unknown' });
    expect(client.trace).toHaveBeenCalledTimes(1);
    finish(Response.json(value));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.trace).toHaveBeenCalledTimes(1);
  });
});
