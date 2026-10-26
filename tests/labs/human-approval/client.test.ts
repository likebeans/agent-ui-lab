import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LabRuntime } from '../../../shared/lab-contract';
import { createApprovalService } from '../../../shared/labs/human-approval/engine';
import { createMemoryApprovalStore } from '../../../shared/labs/human-approval/memory';
import {
  TEACHING_SESSION_HEADER,
  type ApprovalFacts,
} from '../../../shared/labs/human-approval/types';
import type { TaskLocator } from '../../../shared/labs/task-locator';
import {
  APPROVAL_REQUEST_TIMEOUT_MS,
  openApprovalTask,
  sendCommand,
  type SavedCommand,
} from '../../../src/labs/human-approval/client';

const saved: SavedCommand = {
  teachingSessionId: 'deadline-session',
  purpose: 'operation',
  command: {
    taskId: 'deadline-task',
    commandId: 'deadline-command',
    expectedVersion: 1,
    payload: { type: 'approve', proposalId: 'deadline-proposal', proposalVersion: 1 },
  },
};

function runtime(request: LabRuntime['request']): LabRuntime {
  return {
    mode: 'local',
    identity: { labId: 'human-approval' },
    signal: new AbortController().signal,
    request,
    trace: vi.fn(),
    focusTrace: vi.fn(),
  };
}

afterEach(() => vi.useRealTimers());

describe('approval client response deadline', () => {
  it.each(['request', 'body'] as const)(
    'bounds a never-ending %s and ignores its eventual result',
    async (stage) => {
      vi.useFakeTimers();
      let finish: (value: any) => void = () => {};
      const waiting = new Promise<any>((resolve) => {
        finish = resolve;
      });
      const response = { status: 200, text: () => waiting } as Response;
      const request = vi.fn<LabRuntime['request']>(async () =>
        stage === 'request' ? waiting : response,
      );
      const client = runtime(request);
      const before = structuredClone(saved);
      const pending = sendCommand(client, saved);
      await vi.advanceTimersByTimeAsync(APPROVAL_REQUEST_TIMEOUT_MS);
      expect(await pending).toMatchObject({
        kind: 'unknown',
        reason: expect.stringContaining('超时'),
      });
      expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(saved).toEqual(before);
      expect(client.trace).toHaveBeenCalledTimes(1);
      finish(stage === 'request' ? new Response('{}') : '{}');
      await Promise.resolve();
      await Promise.resolve();
      expect(client.trace).toHaveBeenCalledTimes(1);
    },
  );

  it('releases promptly when the runtime is aborted even if its transport ignores the signal', async () => {
    const controller = new AbortController();
    const client = { ...runtime(() => new Promise(() => {})), signal: controller.signal };
    const pending = sendCommand(client, saved);
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'unknown' });
  });
});

function factsFixture() {
  const service = createApprovalService(createMemoryApprovalStore(), { now: () => 1_000 });
  const locator: TaskLocator = {
    version: 1,
    labId: 'human-approval',
    mode: 'local',
    teachingSessionId: 'open-session',
    taskId: 'open-task',
  };
  const context = { teachingSessionId: locator.teachingSessionId };
  service.command(context, {
    taskId: locator.taskId,
    commandId: 'open-propose',
    expectedVersion: 0,
    payload: {
      type: 'propose',
      validity: 'standard',
      input: { attendeeName: '恢复学员', workshopId: 'agent-ui-basics', seats: 2 },
    },
  });
  const proposal = service.facts(context, { taskId: locator.taskId });
  if (proposal.status !== 'found') throw new Error('Expected proposal');
  service.command(context, {
    taskId: locator.taskId,
    commandId: 'open-approve',
    expectedVersion: proposal.task.version,
    payload: {
      type: 'approve',
      proposalId: proposal.task.state.proposal.proposalId,
      proposalVersion: proposal.task.state.proposal.proposalVersion,
    },
  });
  const facts = service.facts(context, { taskId: locator.taskId });
  if (facts.status !== 'found') throw new Error('Expected facts');
  return { locator, facts, service, context };
}

describe('opening a human approval identity is query-only', () => {
  it.each(['local', 'pages'] as const)(
    'validates complete %s facts with one GET, no command ID, and no business mutation',
    async (mode) => {
      const { locator, facts, service, context } = factsFixture();
      const before = structuredClone(facts);
      const request = vi.fn<LabRuntime['request']>(async () =>
        Response.json(service.facts(context, { taskId: locator.taskId })),
      );
      expect(await openApprovalTask({ ...runtime(request), mode }, { ...locator, mode })).toEqual({
        kind: 'known',
        value: facts,
      });
      expect(request).toHaveBeenCalledTimes(1);
      const [path, options] = request.mock.calls[0];
      expect(path).toBe(`/api/labs/human-approval/facts?taskId=${locator.taskId}`);
      expect(options?.method ?? 'GET').toBe('GET');
      expect(options?.body).toBeUndefined();
      expect(new Headers(options?.headers).get(TEACHING_SESSION_HEADER)).toBe(
        locator.teachingSessionId,
      );
      expect(service.facts(context, { taskId: locator.taskId })).toMatchObject({
        task: before.task,
        enrollment: before.enrollment,
        recordCount: 1,
      });
    },
  );

  const invalidFacts: Array<[string, (facts: ApprovalFacts) => void]> = [
    [
      'task identity',
      (facts) => {
        facts.task.taskId = 'foreign-task';
      },
    ],
    [
      'session identity',
      (facts) => {
        facts.task.threadId = 'foreign-session';
      },
    ],
    [
      'proposal identity',
      (facts) => {
        facts.task.state.proposal.teachingSessionId = 'foreign';
      },
    ],
    [
      'enrollment identity',
      (facts) => {
        facts.enrollment!.taskId = 'foreign-task';
      },
    ],
    [
      'record count',
      (facts) => {
        facts.recordCount = 0;
      },
    ],
    [
      'incomplete enrollment',
      (facts) => {
        delete (facts.enrollment as Partial<NonNullable<ApprovalFacts['enrollment']>>).commandId;
      },
    ],
    [
      'unrelated receipt',
      (facts) => {
        facts.receipt = {
          status: 'accepted',
          version: facts.task.version,
          replayed: true,
          result: { task: { ...facts.task, taskId: 'foreign-task' }, enrollment: facts.enrollment },
        };
      },
    ],
  ];
  it.each(invalidFacts)('rejects %s without changing caller state', async (_name, mutate) => {
    const { locator, facts } = factsFixture();
    const original = structuredClone({ locator, facts });
    const response = structuredClone(facts);
    mutate(response);
    expect(
      await openApprovalTask(
        runtime(async () => Response.json(response)),
        locator,
      ),
    ).toMatchObject({
      kind: 'unknown',
    });
    expect({ locator, facts }).toEqual(original);
  });

  it.each(['NOT_FOUND', 'SESSION_MISMATCH'] as const)(
    'returns %s without issuing a fallback command',
    async (code) => {
      const { locator } = factsFixture();
      const request = vi.fn<LabRuntime['request']>(async () =>
        Response.json({ status: 'rejected', code, reason: '未打开任务' }),
      );
      expect(await openApprovalTask(runtime(request), locator)).toMatchObject({
        kind: 'known',
        value: { status: 'rejected', code },
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects cross-lab, cross-mode and command-bearing identities before any request', () => {
    const { locator } = factsFixture();
    const request = vi.fn<LabRuntime['request']>();
    const client = runtime(request);
    expect(() => openApprovalTask(client, { ...locator, labId: 'enrollment-workflow' })).toThrow();
    expect(() => openApprovalTask(client, { ...locator, mode: 'pages' })).toThrow();
    expect(() => openApprovalTask(client, { ...locator, pending: saved } as TaskLocator)).toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('aborts an open query on unmount and ignores a late transport result', async () => {
    const { locator, facts } = factsFixture();
    let finish!: (response: Response) => void;
    const controller = new AbortController();
    const client = runtime(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const opening = openApprovalTask(client, locator, controller.signal);
    controller.abort();
    expect(await opening).toMatchObject({ kind: 'unknown' });
    expect(client.trace).toHaveBeenCalledTimes(1);
    finish(Response.json(facts));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.trace).toHaveBeenCalledTimes(1);
  });
});
