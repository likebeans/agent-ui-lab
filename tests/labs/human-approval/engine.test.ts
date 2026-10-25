import { describe, expect, it } from 'vitest';
import { createApprovalService } from '../../../shared/labs/human-approval/engine';
import { createMemoryApprovalStore } from '../../../shared/labs/human-approval/memory';
import type { ApprovalStore } from '../../../shared/labs/human-approval/ports';
import { approvalCommandFingerprint } from '../../../shared/labs/human-approval/schema';
import type {
  ApprovalAction,
  ApprovalCommand,
  ApprovalFactsResult,
  ApprovalResult,
  ApprovalTask,
  EnrollmentInput,
} from '../../../shared/labs/human-approval/types';

const context = { teachingSessionId: 'engine-session' };
const otherContext = { teachingSessionId: 'other-session' };
const input: EnrollmentInput = {
  attendeeName: '示例学员',
  workshopId: 'reliable-actions',
  seats: 2,
};

function fixture() {
  const store = createMemoryApprovalStore();
  let time = 1_000;
  let serial = 0;
  const service = createApprovalService(store, {
    now: () => time,
    createId: (kind) => `${kind}-${++serial}`,
  });
  return { store, service, setNow: (value: number) => (time = value) };
}

function propose(taskId = 'task-1', commandId = 'propose-1'): ApprovalCommand {
  return {
    taskId,
    commandId,
    expectedVersion: 0,
    payload: { type: 'propose', input, validity: 'short' },
  };
}

function commandFor(
  task: ApprovalTask,
  type: 'approve' | 'reject' | 'edit' = 'approve',
  commandId: string = type,
): ApprovalCommand {
  const identity = {
    proposalId: task.state.proposal.proposalId,
    proposalVersion: task.state.proposal.proposalVersion,
  };
  const payload: ApprovalAction =
    type === 'edit'
      ? { type, ...identity, input: { ...input, attendeeName: '修改后的学员', seats: 3 } }
      : { type, ...identity };
  return { taskId: task.taskId, commandId, expectedVersion: task.version, payload };
}

function accepted(result: ApprovalResult) {
  expect(result.status).toBe('accepted');
  if (result.status !== 'accepted') throw new Error(JSON.stringify(result));
  return result;
}

function found(result: ApprovalFactsResult) {
  expect(result.status).toBe('found');
  if (result.status !== 'found') throw new Error(JSON.stringify(result));
  return result;
}

function receipt(
  store: ApprovalStore,
  commandId: string,
  teachingSessionId = context.teachingSessionId,
) {
  return store.transaction((transaction) => transaction.getCommand(teachingSessionId, commandId));
}

describe('approval validation', () => {
  it.each([
    ['blank name', { ...input, attendeeName: '  \t' }, 'attendeeName'],
    ['long name', { ...input, attendeeName: '学'.repeat(81) }, 'attendeeName'],
    ['wrong workshop', { ...input, workshopId: 'unknown' }, 'workshopId'],
    ['zero seats', { ...input, seats: 0 }, 'seats'],
    ['too many seats', { ...input, seats: 7 }, 'seats'],
    ['fractional seats', { ...input, seats: 1.5 }, 'seats'],
    ['string seats', { ...input, seats: '2' }, 'seats'],
  ])('rejects %s with field errors and no receipt', (_label, invalid, field) => {
    const { store, service } = fixture();
    const result = service.command(context, {
      ...propose(),
      payload: { ...propose().payload, input: invalid },
    });
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'INVALID_INPUT',
      fieldErrors: { [field]: expect.any(String) },
    });
    expect(receipt(store, 'propose-1')).toBeNull();
    expect(store.transaction((tx) => tx.getTask('task-1'))).toBeNull();
  });

  it.each([
    null,
    {},
    { ...propose(), commandId: '' },
    { ...propose(), commandId: ' command ' },
    { ...propose(), taskId: 'a/b' },
    { ...propose(), expectedVersion: -1 },
    { ...propose(), expectedVersion: 0.5 },
    { ...propose(), runId: 'client-run' },
    { ...propose(), payload: { ...propose().payload, validity: 'forever' } },
    { ...propose(), payload: { ...propose().payload, proposalId: 'client-proposal' } },
    { ...propose(), payload: { ...propose().payload, input: { ...input, admin: true } } },
    { ...propose(), payload: { type: 'approve', proposalId: 'p', proposalVersion: 0 } },
    { ...propose(), payload: { type: 'approve', proposalId: 'p', proposalVersion: 1, input } },
  ])('rejects malformed command %# before creating state or a receipt', (invalid) => {
    const { store, service } = fixture();
    expect(service.command(context, invalid)).toMatchObject({
      status: 'rejected',
      code: 'INVALID_INPUT',
    });
    expect(receipt(store, 'propose-1')).toBeNull();
    expect(store.transaction((tx) => tx.getTask('task-1'))).toBeNull();
  });

  it.each([
    undefined,
    {},
    { teachingSessionId: '' },
    { teachingSessionId: 'foreign/session' },
    { ...context, admin: true },
  ])('validates context %# for commands and facts', (invalid) => {
    const { store, service } = fixture();
    expect(service.command(invalid, propose())).toMatchObject({
      status: 'rejected',
      code: 'INVALID_INPUT',
    });
    expect(service.facts(invalid, { taskId: 'task-1' })).toMatchObject({
      status: 'rejected',
      code: 'INVALID_INPUT',
    });
    expect(receipt(store, 'propose-1')).toBeNull();
  });

  it('accepts the bounds and preserves whitespace in saved content', () => {
    const { service } = fixture();
    const command = propose();
    command.payload = {
      type: 'propose',
      input: { ...input, attendeeName: ` ${'学'.repeat(78)} `, seats: 6 },
      validity: 'standard',
    };
    const result = accepted(service.command(context, command));
    expect(result.result.task.state.proposal.content).toEqual(command.payload.input);
    expect(result.result.task.state.proposal.expiresAt).toBe(301_000);
  });
});

describe('approval state machine', () => {
  it('creates a proposal with server identity and explicit task/session binding', () => {
    const { service } = fixture();
    const result = accepted(service.command(context, propose('client-task')));
    expect(result).toEqual({
      status: 'accepted',
      version: 1,
      replayed: false,
      result: {
        enrollment: null,
        task: {
          taskId: 'client-task',
          threadId: context.teachingSessionId,
          version: 1,
          status: 'waiting-input',
          currentRunId: null,
          state: {
            proposal: {
              proposalId: 'proposal-1',
              proposalVersion: 1,
              teachingSessionId: context.teachingSessionId,
              content: input,
              status: 'pending',
              createdAt: 1_000,
              expiresAt: 6_000,
              decidedAt: null,
            },
          },
        },
      },
    });
  });

  it('edits saved content without renewing expiry and approves exactly that content', () => {
    const { service, setNow } = fixture();
    const initial = accepted(service.command(context, propose())).result.task;
    setNow(2_000);
    const edit = commandFor(initial, 'edit');
    const edited = accepted(service.command(context, edit)).result.task;
    expect(edited).toMatchObject({
      version: 2,
      status: 'waiting-input',
      currentRunId: null,
      state: {
        proposal: {
          proposalId: initial.state.proposal.proposalId,
          proposalVersion: 2,
          createdAt: 1_000,
          expiresAt: 6_000,
          content: { attendeeName: '修改后的学员', seats: 3 },
        },
      },
    });
    if (edit.payload.type !== 'edit') throw new Error('Expected edit');
    edit.payload.input.attendeeName = '未保存草稿';
    setNow(3_000);
    const result = accepted(service.command(context, commandFor(edited)));
    expect(result.result.task).toMatchObject({
      version: 3,
      status: 'succeeded',
      currentRunId: 'run-3',
      state: {
        proposal: {
          status: 'approved',
          proposalVersion: 2,
          decidedAt: 3_000,
        },
      },
    });
    expect(result.result.enrollment).toEqual({
      enrollmentId: 'enrollment-2',
      taskId: initial.taskId,
      proposalId: 'proposal-1',
      proposalVersion: 2,
      teachingSessionId: context.teachingSessionId,
      commandId: 'approve',
      createdAt: 3_000,
      content: { attendeeName: '修改后的学员', workshopId: input.workshopId, seats: 3 },
    });
    expect(found(service.facts(context, { taskId: initial.taskId }))).toMatchObject({
      recordCount: 1,
      enrollment: result.result.enrollment,
    });
  });

  it('rejects without creating a business record or a run', () => {
    const { service } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const result = accepted(service.command(context, commandFor(task, 'reject')));
    expect(result.result).toMatchObject({
      enrollment: null,
      task: {
        status: 'cancelled',
        version: 2,
        currentRunId: null,
        state: { proposal: { status: 'rejected', decidedAt: 1_000 } },
      },
    });
    expect(service.facts(context, { taskId: task.taskId })).toMatchObject({
      recordCount: 0,
      enrollment: null,
    });
  });

  it('independently checks task version, proposal identity and proposal content version', () => {
    const { service } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const edited = accepted(service.command(context, commandFor(task, 'edit'))).result.task;
    expect(service.command(context, commandFor(task, 'approve', 'stale-task'))).toMatchObject({
      status: 'conflict',
      code: 'VERSION_CONFLICT',
      version: 2,
    });
    const staleContent = commandFor(edited, 'approve', 'stale-content');
    staleContent.payload = {
      type: 'approve',
      proposalId: task.state.proposal.proposalId,
      proposalVersion: 1,
    };
    expect(service.command(context, staleContent)).toMatchObject({
      status: 'conflict',
      code: 'PROPOSAL_VERSION_CONFLICT',
      version: 2,
    });
    const wrongProposal = commandFor(edited, 'approve', 'wrong-proposal');
    wrongProposal.payload = { type: 'approve', proposalId: 'another-proposal', proposalVersion: 2 };
    expect(service.command(context, wrongProposal)).toMatchObject({
      status: 'rejected',
      code: 'NOT_FOUND',
    });
    expect(service.facts(context, { taskId: task.taskId })).toMatchObject({
      task: edited,
      enrollment: null,
      recordCount: 0,
    });
    expect(service.command(context, commandFor(edited))).toMatchObject({ status: 'accepted' });
  });

  it.each(['approve', 'reject'] as const)(
    'makes %s terminal even after the deadline',
    (decision) => {
      const { service, setNow, store } = fixture();
      const task = accepted(service.command(context, propose())).result.task;
      const decided = accepted(service.command(context, commandFor(task, decision, 'decision')))
        .result.task;
      setNow(10_000);
      for (const type of ['approve', 'reject', 'edit'] as const) {
        expect(service.command(context, commandFor(decided, type, `after-${type}`))).toMatchObject({
          status: 'conflict',
          code: 'INVALID_STATE',
          version: 2,
        });
      }
      expect(
        service.command(context, { ...propose(), commandId: 'repropose', expectedVersion: 2 }),
      ).toMatchObject({ status: 'conflict', code: 'INVALID_STATE' });
      expect(store.transaction((tx) => tx.getTask(task.taskId))).toEqual(decided);
      expect(service.facts(context, { taskId: task.taskId })).toMatchObject({
        task: decided,
        recordCount: decision === 'approve' ? 1 : 0,
      });
    },
  );

  it.each(['approve', 'reject', 'edit'] as const)(
    'expires %s at the exact deadline without updating stored state',
    (type) => {
      const { service, setNow, store } = fixture();
      const task = accepted(service.command(context, propose())).result.task;
      setNow(5_999);
      expect(service.facts(context, { taskId: task.taskId })).toMatchObject({
        task: { state: { proposal: { status: 'pending' } } },
      });
      setNow(6_000);
      const command = commandFor(task, type);
      const failure = service.command(context, command);
      expect(failure).toMatchObject({ status: 'rejected', code: 'EXPIRED' });
      expect(
        service.facts(context, { taskId: task.taskId, commandId: command.commandId }),
      ).toMatchObject({
        status: 'found',
        asOf: 6_000,
        durability: 'memory',
        recordCount: 0,
        enrollment: null,
        task: { version: 1, status: 'waiting-input', state: { proposal: { status: 'expired' } } },
        receipt: failure,
      });
      expect(store.transaction((tx) => tx.getTask(task.taskId))).toEqual(task);
      expect(receipt(store, 'propose-1')?.result).toMatchObject({
        result: { task: { state: { proposal: { status: 'pending' } } } },
      });
    },
  );

  it('supports injected TTLs and different command keys still create only one enrollment', () => {
    const store = createMemoryApprovalStore();
    const service = createApprovalService(store, {
      now: () => 50,
      standardTtlMs: 200,
      shortTtlMs: 10,
    });
    const first = accepted(service.command(context, propose())).result.task;
    expect(first.state.proposal.expiresAt).toBe(60);
    const standard = propose('standard-task', 'standard-propose');
    standard.payload = { type: 'propose', input, validity: 'standard' };
    expect(accepted(service.command(context, standard)).result.task.state.proposal.expiresAt).toBe(
      250,
    );
    const result = accepted(service.command(context, commandFor(first)));
    expect(result.result.task.currentRunId).toMatch(/^run-/u);
    expect(service.command(context, commandFor(first, 'approve', 'second-approve'))).toMatchObject({
      status: 'conflict',
      code: 'VERSION_CONFLICT',
    });
    expect(service.facts(context, { taskId: first.taskId })).toMatchObject({
      recordCount: 1,
      enrollment: result.result.enrollment,
    });
  });
});

describe('command receipts and facts', () => {
  it('replays original accepted snapshots after edits, terminal decisions and expiry', () => {
    const { service, setNow } = fixture();
    const initialCommand = propose();
    const initial = accepted(service.command(context, initialCommand));
    const task = initial.result.task;
    const edited = accepted(service.command(context, commandFor(task, 'edit'))).result.task;
    const approval = commandFor(edited);
    const committed = accepted(service.command(context, approval));
    setNow(100_000);
    expect(service.command(context, initialCommand)).toEqual({ ...initial, replayed: true });
    expect(service.command(context, approval)).toEqual({ ...committed, replayed: true });
    expect(
      found(service.facts(context, { taskId: task.taskId, commandId: approval.commandId })).receipt,
    ).toEqual(committed);
    expect(
      found(service.facts(context, { taskId: task.taskId, commandId: initialCommand.commandId }))
        .receipt,
    ).toEqual(initial);
  });

  it('uses a sorted full-request fingerprint, preserving valid name whitespace and versions', () => {
    const { service, store } = fixture();
    const command = propose();
    const result = accepted(service.command(context, command));
    const reordered = {
      payload: {
        validity: 'short',
        input: { seats: 2, workshopId: input.workshopId, attendeeName: input.attendeeName },
        type: 'propose',
      },
      expectedVersion: 0,
      taskId: command.taskId,
      commandId: command.commandId,
    };
    expect(approvalCommandFingerprint(command)).toBe(approvalCommandFingerprint(reordered));
    expect(service.command(context, reordered)).toEqual({ ...result, replayed: true });
    for (const modified of [
      { ...command, expectedVersion: 1 },
      {
        ...command,
        payload: {
          ...command.payload,
          input: { ...input, attendeeName: ` ${input.attendeeName} ` },
        },
      },
      { ...command, payload: { ...command.payload, validity: 'standard' } },
      { ...command, taskId: 'different-task' },
    ])
      expect(service.command(context, modified)).toMatchObject({
        status: 'conflict',
        code: 'KEY_REUSED',
      });
    expect(receipt(store, command.commandId)?.result).toEqual(result);
    expect(service.facts(context, { taskId: 'different-task' })).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('persists and replays the exact original failure even after the task changes', () => {
    const { service, store } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const invalidVersion = { ...commandFor(task), expectedVersion: 0 };
    const failure = service.command(context, invalidVersion);
    expect(failure).toMatchObject({ status: 'conflict', code: 'VERSION_CONFLICT', version: 1 });
    const edited = accepted(service.command(context, commandFor(task, 'edit'))).result.task;
    expect(service.command(context, invalidVersion)).toEqual(failure);
    expect(
      service.command(context, { ...commandFor(edited), commandId: invalidVersion.commandId }),
    ).toMatchObject({ status: 'conflict', code: 'KEY_REUSED' });
    expect(receipt(store, invalidVersion.commandId)?.result).toEqual(failure);
    expect(
      service.facts(context, { taskId: task.taskId, commandId: invalidVersion.commandId }),
    ).toMatchObject({ task: edited, receipt: failure });
  });

  it('records missing-task and new-task-version failures without reserving the task', () => {
    const { service, store } = fixture();
    const missing = {
      ...propose(),
      commandId: 'missing',
      payload: { type: 'approve', proposalId: 'missing-proposal', proposalVersion: 1 },
    };
    const failure = service.command(context, missing);
    expect(failure).toMatchObject({ status: 'rejected', code: 'NOT_FOUND' });
    expect(receipt(store, 'missing')?.result).toEqual(failure);
    expect(service.command(context, { ...propose(), expectedVersion: 1 })).toMatchObject({
      status: 'conflict',
      code: 'VERSION_CONFLICT',
      version: 0,
    });
    const initial = { ...propose(), commandId: 'valid-propose' };
    expect(service.command(context, initial)).toMatchObject({ status: 'accepted' });
    expect(service.command(context, missing)).toEqual(failure);
  });

  it('checks ownership before receipt replay and never records foreign access', () => {
    const { service, store } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const foreign = accepted(
      service.command(otherContext, propose('foreign-task', 'foreign-propose')),
    ).result.task;
    for (const result of [
      service.command(otherContext, commandFor(task)),
      service.command(context, { ...propose(), taskId: foreign.taskId }),
      service.facts(otherContext, { taskId: task.taskId, commandId: 'propose-1' }),
      service.facts(context, { taskId: foreign.taskId, commandId: 'propose-1' }),
    ])
      expect(result).toEqual({
        status: 'rejected',
        code: 'SESSION_MISMATCH',
        reason: '任务不属于当前教学会话。',
      });
    expect(receipt(store, 'approve', otherContext.teachingSessionId)).toBeNull();
    expect(receipt(store, 'propose-1')?.taskId).toBe(task.taskId);
    expect(service.facts(context, { taskId: task.taskId })).toMatchObject({ task, recordCount: 0 });
  });

  it('scopes the same command ID by session and rejects facts with another task receipt', () => {
    const { service } = fixture();
    accepted(service.command(context, propose('task-1')));
    accepted(service.command(otherContext, propose('task-2')));
    accepted(service.command(context, propose('task-3', 'propose-3')));
    expect(service.facts(context, { taskId: 'task-3', commandId: 'propose-1' })).toMatchObject({
      status: 'rejected',
      code: 'KEY_REUSED',
    });
    expect(service.facts(context, { taskId: 'absent', commandId: 'propose-1' })).toMatchObject({
      status: 'rejected',
      code: 'KEY_REUSED',
    });
    expect(service.facts(context, { taskId: 'task-1', commandId: 'not-recorded' })).toMatchObject({
      status: 'found',
      receipt: null,
    });
    expect(service.facts(context, { taskId: 'task-1' })).toMatchObject({
      status: 'found',
      receipt: null,
    });
    expect(service.facts(otherContext, { taskId: 'task-2', commandId: 'propose-1' })).toMatchObject(
      { status: 'found', receipt: { result: { task: { taskId: 'task-2' } } } },
    );
  });

  it.each([
    null,
    {},
    { taskId: '' },
    { taskId: ['task-1'] },
    { taskId: 'task-1', commandId: '' },
    { taskId: 'task-1', extra: true },
  ])('rejects malformed facts query %#', (query) => {
    expect(fixture().service.facts(context, query)).toMatchObject({
      status: 'rejected',
      code: 'INVALID_INPUT',
    });
  });

  it('reads task, enrollment and receipt in one store transaction', () => {
    const { service: initialService, store } = fixture();
    const task = accepted(initialService.command(context, propose())).result.task;
    accepted(initialService.command(context, commandFor(task)));
    let transactions = 0;
    const calls: string[] = [];
    const service = createApprovalService({
      durability: 'memory',
      transaction(operation) {
        transactions += 1;
        return store.transaction((tx) =>
          operation({
            ...tx,
            getTask(id) {
              calls.push('task');
              return tx.getTask(id);
            },
            getCommand(session, id) {
              calls.push('receipt');
              return tx.getCommand(session, id);
            },
            getEnrollment(id) {
              calls.push('enrollment');
              return tx.getEnrollment(id);
            },
          }),
        );
      },
    });
    expect(service.facts(context, { taskId: task.taskId, commandId: 'approve' })).toMatchObject({
      recordCount: 1,
    });
    expect(transactions).toBe(1);
    expect(calls).toEqual(['task', 'receipt', 'enrollment']);
  });
});

describe('memory transaction integrity', () => {
  it('rolls back task, enrollment and receipt together on a late failure', () => {
    const { store, service } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const broken = createApprovalService(
      {
        durability: 'memory',
        transaction(operation) {
          return store.transaction((tx) =>
            operation({
              ...tx,
              putCommand(command) {
                tx.putCommand(command);
                throw new Error('injected receipt failure');
              },
            }),
          );
        },
      },
      { now: () => 1_000 },
    );
    expect(() => broken.command(context, commandFor(task))).toThrow('injected receipt failure');
    expect(store.transaction((tx) => tx.getTask(task.taskId))).toEqual(task);
    expect(store.transaction((tx) => tx.getEnrollment(task.taskId))).toBeNull();
    expect(receipt(store, 'approve')).toBeNull();
    expect(service.command(context, commandFor(task))).toMatchObject({ status: 'accepted' });
  });

  it('deep-copies reads, writes and returned receipts', () => {
    const { store, service } = fixture();
    const initial = accepted(service.command(context, propose()));
    const task = structuredClone(initial.result.task);
    initial.result.task.state.proposal.content.attendeeName = 'mutated result';
    store.transaction((tx) => {
      const read = tx.getTask(task.taskId)!;
      read.state.proposal.content.attendeeName = 'mutated read';
      tx.putTask(task);
      task.state.proposal.content.attendeeName = 'mutated write argument';
      tx.getCommand(context.teachingSessionId, 'propose-1')!.result = {
        status: 'rejected',
        code: 'INVALID_INPUT',
        reason: 'mutated receipt',
      };
    });
    const facts = found(service.facts(context, { taskId: 'task-1', commandId: 'propose-1' }));
    expect(facts.task.state.proposal.content).toEqual(input);
    expect(facts.receipt).toMatchObject({
      status: 'accepted',
      result: { task: { state: { proposal: { content: input } } } },
    });
    facts.task.state.proposal.content.seats = 6;
    expect(found(service.facts(context, { taskId: 'task-1' })).task.state.proposal.content).toEqual(
      input,
    );
  });

  it('enforces immutable command keys, task ownership, enrollment identity and foreign keys', () => {
    const { store, service } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const existing = receipt(store, 'propose-1')!;
    expect(() =>
      store.transaction((tx) => tx.putCommand({ ...existing, fingerprint: 'different' })),
    ).toThrow(/UNIQUE/u);
    expect(() =>
      store.transaction((tx) =>
        tx.putTask({
          ...task,
          state: {
            proposal: { ...task.state.proposal, teachingSessionId: otherContext.teachingSessionId },
          },
        }),
      ),
    ).toThrow(/session/u);
    const approved = accepted(service.command(context, commandFor(task)));
    const enrollment = approved.result.enrollment!;
    expect(() =>
      store.transaction((tx) => tx.putEnrollment({ ...enrollment, enrollmentId: 'new-id' })),
    ).toThrow(/UNIQUE/u);
    expect(() =>
      store.transaction((tx) =>
        tx.putEnrollment({
          ...enrollment,
          enrollmentId: 'orphan',
          taskId: 'missing',
          proposalId: 'missing',
        }),
      ),
    ).toThrow(/FOREIGN KEY/u);
    const second = accepted(service.command(context, propose('task-2', 'propose-2'))).result.task;
    expect(() =>
      store.transaction((tx) =>
        tx.putEnrollment({
          ...enrollment,
          taskId: second.taskId,
          proposalId: second.state.proposal.proposalId,
        }),
      ),
    ).toThrow(/UNIQUE/u);
    expect(() =>
      store.transaction((tx) =>
        tx.putEnrollment({ ...enrollment, enrollmentId: 'another-id', taskId: second.taskId }),
      ),
    ).toThrow(/UNIQUE/u);
    expect(store.transaction((tx) => tx.getEnrollment(task.taskId))).toEqual(enrollment);
  });

  it('supports nested savepoints and rolls a successful inner write back with its outer transaction', () => {
    const { store, service } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    store.transaction((outer) => {
      outer.putTask({ ...task, version: 2 });
      expect(() =>
        store.transaction((inner) => {
          inner.putTask({ ...task, version: 3 });
          throw new Error('inner failure');
        }),
      ).toThrow('inner failure');
      expect(outer.getTask(task.taskId)?.version).toBe(2);
      store.transaction((inner) => inner.putTask({ ...task, version: 4 }));
      expect(outer.getTask(task.taskId)?.version).toBe(4);
    });
    expect(() =>
      store.transaction(() => {
        store.transaction((inner) => inner.putTask({ ...task, version: 5 }));
        throw new Error('outer failure');
      }),
    ).toThrow('outer failure');
    expect(store.transaction((tx) => tx.getTask(task.taskId)?.version)).toBe(4);
  });

  it('rejects native async callbacks before invocation so they cannot write later', async () => {
    const { store, service } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    let invoked = false;
    expect(() =>
      // @ts-expect-error Untyped callers must also be rejected before invoking an async callback.
      store.transaction(async (tx) => {
        invoked = true;
        tx.putTask({ ...task, version: 2 });
        await Promise.resolve();
        tx.putTask({ ...task, version: 3 });
      }),
    ).toThrow(/synchronous/u);
    expect(invoked).toBe(false);
    await Promise.resolve();
    expect(invoked).toBe(false);
    expect(store.transaction((tx) => tx.getTask(task.taskId))).toEqual(task);
  });

  it('rolls back writes when a synchronous callback returns a promise', () => {
    const { store, service } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    expect(() =>
      // @ts-expect-error Promise results are excluded even when the callback is not native async.
      store.transaction((tx) => {
        tx.putTask({ ...task, version: 2 });
        return Promise.resolve();
      }),
    ).toThrow(/synchronous/u);
    expect(store.transaction((tx) => tx.getTask(task.taskId))).toEqual(task);
    expect(service.command(context, commandFor(task))).toMatchObject({ status: 'accepted' });
  });
});
