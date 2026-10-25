import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalService } from '../../../shared/labs/human-approval/engine';
import { createMemoryApprovalStore } from '../../../shared/labs/human-approval/memory';
import {
  createStaticApprovalHandler,
  humanApprovalStaticHandler,
} from '../../../shared/labs/human-approval/static';
import {
  APPROVAL_API,
  DROP_RESPONSE_HEADER,
  TEACHING_SESSION_HEADER,
  type ApprovalCommand,
  type ApprovalResult,
  type ApprovalTask,
} from '../../../shared/labs/human-approval/types';
import { staticFetch } from '../../../shared/static-api';

const session = 'static-session';
const context = { teachingSessionId: session };
const input = { attendeeName: '示例学员', workshopId: 'agent-ui-basics' as const, seats: 2 };
const commandPath = `${APPROVAL_API}/commands`;

function propose(taskId = 'task-1', commandId = 'propose-1'): ApprovalCommand {
  return {
    taskId,
    commandId,
    expectedVersion: 0,
    payload: { type: 'propose', input, validity: 'short' },
  };
}

function approve(task: ApprovalTask, commandId = 'approve-1'): ApprovalCommand {
  return {
    taskId: task.taskId,
    commandId,
    expectedVersion: task.version,
    payload: {
      type: 'approve',
      proposalId: task.state.proposal.proposalId,
      proposalVersion: task.state.proposal.proposalVersion,
    },
  };
}

function post(command: unknown, headers: HeadersInit = {}): RequestInit {
  const allHeaders = new Headers(headers);
  if (!allHeaders.has(TEACHING_SESSION_HEADER)) allHeaders.set(TEACHING_SESSION_HEADER, session);
  return { method: 'POST', headers: allHeaders, body: JSON.stringify(command) };
}

function getHeaders(teachingSessionId = session): RequestInit {
  return { headers: { [TEACHING_SESSION_HEADER]: teachingSessionId } };
}

function factsPath(taskId = 'task-1', commandId?: string) {
  return `${APPROVAL_API}/facts?${new URLSearchParams({ taskId, ...(commandId ? { commandId } : {}) })}`;
}

function fixture() {
  let time = 1_000;
  let serial = 0;
  const service = createApprovalService(createMemoryApprovalStore(), {
    now: () => time,
    createId: (kind) => `${kind}-${++serial}`,
  });
  const handler = createStaticApprovalHandler({ service });
  return { service, handler, setNow: (value: number) => (time = value) };
}

async function json(response: Response | undefined, status = 200) {
  expect(response).toBeInstanceOf(Response);
  expect(response?.status).toBe(status);
  expect(response?.headers.get('Content-Type')).toBe('application/json');
  expect(response?.headers.get('X-Lab-Transport')).toBe('browser-memory');
  return response!.json();
}

function accepted(result: ApprovalResult) {
  if (result.status !== 'accepted') throw new Error(JSON.stringify(result));
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('static approval routes', () => {
  it('serves commands and facts as JSON using the session header and no network', async () => {
    const network = vi.fn(() => {
      throw new Error('Network must not be used');
    });
    vi.stubGlobal('fetch', network);
    const { handler } = fixture();
    const initial = await json(await handler(commandPath, post(propose())));
    expect(initial).toMatchObject({
      status: 'accepted',
      replayed: false,
      result: { task: { taskId: 'task-1', threadId: session, version: 1 } },
    });
    const command = approve(initial.result.task);
    const committed = await json(await handler(commandPath, post(command)));
    expect(committed).toMatchObject({
      status: 'accepted',
      result: { task: { status: 'succeeded' }, enrollment: { content: input } },
    });
    expect(
      await json(await handler(factsPath('task-1', command.commandId), getHeaders())),
    ).toMatchObject({
      status: 'found',
      asOf: 1_000,
      durability: 'memory',
      recordCount: 1,
      task: committed.result.task,
      enrollment: committed.result.enrollment,
      receipt: committed,
    });
    expect(await json(await handler(commandPath, post(command)))).toEqual({
      ...committed,
      replayed: true,
    });
    expect(network).not.toHaveBeenCalled();
  });

  it('creates isolated memory stores for independently constructed handlers', async () => {
    const first = createStaticApprovalHandler();
    const second = createStaticApprovalHandler();
    await json(await first(commandPath, post(propose())));
    expect(await json(await second(factsPath(), getHeaders()), 404)).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await json(await first(factsPath(), getHeaders()))).toMatchObject({ recordCount: 0 });
  });

  it.each([
    '/api/labs/other/facts',
    '/api/labs/human-approval-extra/commands',
    '/api/labs/human-approvalish',
    'https://example.test/api/labs/human-approval/commands',
    '//example.test/api/labs/human-approval/facts',
  ])('does not handle a path outside the exact namespace: %s', async (path) => {
    const { handler } = fixture();
    expect(await handler(path, post(propose()))).toBeUndefined();
  });

  it.each([
    APPROVAL_API,
    `${APPROVAL_API}/unknown`,
    `${APPROVAL_API}/commands/`,
    `${APPROVAL_API}/facts/child`,
    `${APPROVAL_API}//commands`,
    `${APPROVAL_API}/../commands`,
  ])('returns JSON 404 for unknown paths inside the namespace: %s', async (path) => {
    expect(await json(await fixture().handler(path, post(propose())), 404)).toMatchObject({
      error: expect.any(String),
    });
  });

  it.each([
    [commandPath, undefined, 'POST'],
    [commandPath, 'GET', 'POST'],
    [commandPath, 'DELETE', 'POST'],
    [`${APPROVAL_API}/facts`, 'POST', 'GET'],
    [`${APPROVAL_API}/facts`, 'HEAD', 'GET'],
  ])('rejects an unsupported method %s %s', async (path, method, allow) => {
    const response = await fixture().handler(path, { method });
    await json(response, 405);
    expect(response!.headers.get('Allow')).toBe(allow);
  });

  it('supports query strings and method casing without changing route matching', async () => {
    const { handler } = fixture();
    await json(await handler(`${commandPath}?ignored=1`, { ...post(propose()), method: 'post' }));
    expect(
      await json(await handler(factsPath(), { ...getHeaders(), method: 'get' })),
    ).toMatchObject({ status: 'found' });
  });

  it.each(['{', '{"payload":', 'undefined', ''])(
    'returns the exact malformed JSON error for %j',
    async (body) => {
      const { handler, service } = fixture();
      expect(await json(await handler(commandPath, { ...post({}), body }), 400)).toEqual({
        status: 'rejected',
        code: 'INVALID_INPUT',
        reason: '请求正文必须是有效 JSON。',
      });
      expect(service.facts(context, { taskId: 'task-1' })).toMatchObject({ code: 'NOT_FOUND' });
    },
  );

  it.each([undefined, 'null', '{}', '[]', '2'])(
    'rejects missing or invalid command body %j',
    async (body) => {
      const { handler } = fixture();
      expect(await json(await handler(commandPath, { ...post({}), body }), 400)).toMatchObject({
        status: 'rejected',
        code: 'INVALID_INPUT',
      });
    },
  );

  it('returns 400 for bad input or missing session and accepts HeadersInit forms', async () => {
    const { handler } = fixture();
    expect(
      await json(
        await handler(commandPath, { method: 'POST', body: JSON.stringify(propose()) }),
        400,
      ),
    ).toMatchObject({ code: 'INVALID_INPUT' });
    const invalid = propose();
    invalid.payload = { type: 'propose', validity: 'short', input: { ...input, seats: 7 } };
    expect(await json(await handler(commandPath, post(invalid)), 400)).toMatchObject({
      code: 'INVALID_INPUT',
      fieldErrors: { seats: expect.any(String) },
    });
    await json(
      await handler(commandPath, {
        ...post(propose()),
        headers: [[TEACHING_SESSION_HEADER.toLowerCase(), session]],
      }),
    );
    expect(
      await json(
        await handler(factsPath(), {
          headers: new Headers({ [TEACHING_SESSION_HEADER]: session }),
        }),
      ),
    ).toMatchObject({ status: 'found' });
  });

  it.each([
    `${APPROVAL_API}/facts`,
    `${APPROVAL_API}/facts?taskId=`,
    `${APPROVAL_API}/facts?taskId=task-1&taskId=task-2`,
    `${APPROVAL_API}/facts?taskId=task-1&commandId=a&commandId=b`,
    `${APPROVAL_API}/facts?taskId=task-1&unexpected=true`,
    `${APPROVAL_API}/facts?taskId=task-1&commandId=`,
  ])('rejects malformed facts query %s', async (path) => {
    expect(await json(await fixture().handler(path, getHeaders()), 400)).toMatchObject({
      status: 'rejected',
      code: 'INVALID_INPUT',
    });
  });

  it('maps session errors to 403, missing resources to 404 and conflicts to 409 without leaking data', async () => {
    const { handler } = fixture();
    const initial = await json(await handler(commandPath, post(propose())));
    const task: ApprovalTask = initial.result.task;
    const foreign = { [TEACHING_SESSION_HEADER]: 'another-session' };
    for (const response of [
      await handler(commandPath, post(approve(task), foreign)),
      await handler(factsPath('task-1', 'propose-1'), { headers: foreign }),
    ])
      expect(await json(response, 403)).toEqual({
        status: 'rejected',
        code: 'SESSION_MISMATCH',
        reason: '任务不属于当前教学会话。',
      });
    expect(await json(await handler(factsPath('absent'), getHeaders()), 404)).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      await json(await handler(commandPath, post({ ...approve(task), expectedVersion: 0 })), 409),
    ).toMatchObject({ status: 'conflict', code: 'VERSION_CONFLICT' });
    const staleProposal = approve(task, 'stale-proposal');
    staleProposal.payload = {
      type: 'approve',
      proposalId: task.state.proposal.proposalId,
      proposalVersion: 2,
    };
    expect(await json(await handler(commandPath, post(staleProposal)), 409)).toMatchObject({
      code: 'PROPOSAL_VERSION_CONFLICT',
    });
    expect(
      await json(await handler(commandPath, post({ ...propose(), expectedVersion: 1 })), 409),
    ).toMatchObject({ code: 'KEY_REUSED' });
  });

  it('rejects a facts command key from another task using the backend rejection status', async () => {
    const { handler } = fixture();
    await json(await handler(commandPath, post(propose())));
    await json(await handler(commandPath, post(propose('task-2', 'propose-2'))));
    expect(
      await json(await handler(factsPath('task-2', 'propose-1'), getHeaders()), 409),
    ).toMatchObject({ status: 'rejected', code: 'KEY_REUSED' });
  });

  it('returns 410 at expiry and exposes an expired snapshot with the original receipt', async () => {
    const { handler, setNow } = fixture();
    const initial = await json(await handler(commandPath, post(propose())));
    setNow(6_000);
    const failure = await json(await handler(commandPath, post(approve(initial.result.task))), 410);
    expect(failure).toMatchObject({ status: 'rejected', code: 'EXPIRED' });
    expect(await json(await handler(factsPath('task-1', 'approve-1'), getHeaders()))).toMatchObject(
      {
        asOf: 6_000,
        task: { version: 1, state: { proposal: { status: 'expired' } } },
        recordCount: 0,
        receipt: failure,
      },
    );
    expect(await json(await handler(commandPath, post(propose())))).toEqual({
      ...initial,
      replayed: true,
    });
  });
});

describe('static response loss and aborts', () => {
  it('commits the command before throwing response-loss TypeError and recovers the exact receipt', async () => {
    const { handler } = fixture();
    const initial = await json(await handler(commandPath, post(propose())));
    const command = approve(initial.result.task);
    await expect(
      handler(commandPath, post(command, { [DROP_RESPONSE_HEADER]: '1' })),
    ).rejects.toBeInstanceOf(TypeError);
    const facts = await json(await handler(factsPath('task-1', command.commandId), getHeaders()));
    expect(facts).toMatchObject({
      recordCount: 1,
      task: { status: 'succeeded' },
      receipt: { status: 'accepted', replayed: false },
    });
    expect(await json(await handler(commandPath, post(command)))).toEqual({
      ...facts.receipt,
      replayed: true,
    });
    expect(await json(await handler(factsPath(), getHeaders()))).toMatchObject({ recordCount: 1 });
  });

  it('drops only the exact injected value on command routes and preserves failed receipts too', async () => {
    const { handler } = fixture();
    const initial = await json(
      await handler(commandPath, post(propose(), { [DROP_RESPONSE_HEADER]: 'true' })),
    );
    const command = { ...approve(initial.result.task), expectedVersion: 0 };
    await expect(
      handler(commandPath, post(command, { [DROP_RESPONSE_HEADER]: '1' })),
    ).rejects.toBeInstanceOf(TypeError);
    expect(
      await json(
        await handler(factsPath('task-1', command.commandId), {
          headers: { [TEACHING_SESSION_HEADER]: session, [DROP_RESPONSE_HEADER]: '1' },
        }),
      ),
    ).toMatchObject({ recordCount: 0, receipt: { status: 'conflict', code: 'VERSION_CONFLICT' } });
  });

  it('prevents command execution for an already aborted signal', async () => {
    const { handler, service } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      handler(commandPath, { ...post(propose()), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.facts(context, { taskId: 'task-1' })).toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      handler(factsPath(), { ...getHeaders(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('honors an abort raised immediately after commit without undoing the committed fact', async () => {
    const { service } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const controller = new AbortController();
    const handler = createStaticApprovalHandler({
      service: {
        command(context, input) {
          const result = service.command(context, input);
          controller.abort();
          return result;
        },
        facts: service.facts,
      },
    });
    await expect(
      handler(commandPath, { ...post(approve(task)), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.facts(context, { taskId: task.taskId, commandId: 'approve-1' })).toMatchObject({
      recordCount: 1,
      receipt: { status: 'accepted' },
    });
  });

  it('honors an abort after facts were read', async () => {
    const { service } = fixture();
    service.command(context, propose());
    const controller = new AbortController();
    const handler = createStaticApprovalHandler({
      service: {
        command: service.command,
        facts(context, query) {
          const result = service.facts(context, query);
          controller.abort();
          return result;
        },
      },
    });
    await expect(
      handler(factsPath(), { ...getHeaders(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('registers the singleton and preserves committed facts when the outer wrapper converts response loss to {error}', async () => {
    const taskId = `wrapper-${crypto.randomUUID()}`;
    const initialCommand = propose(taskId, `propose-${crypto.randomUUID()}`);
    const initial = await json(await staticFetch(commandPath, post(initialCommand)));
    const command = approve(initial.result.task, `approve-${crypto.randomUUID()}`);
    const lost = await json(
      await staticFetch(commandPath, post(command, { [DROP_RESPONSE_HEADER]: '1' })),
      400,
    );
    expect(lost).toEqual({ error: expect.any(String) });
    expect(lost.status).toBeUndefined();
    expect(lost.code).toBeUndefined();
    const facts = await json(
      await humanApprovalStaticHandler(factsPath(taskId, command.commandId), getHeaders()),
    );
    expect(facts).toMatchObject({ recordCount: 1, receipt: { status: 'accepted' } });
    expect(await json(await staticFetch(commandPath, post(command)))).toEqual({
      ...facts.receipt,
      replayed: true,
    });
  });
});
