import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createApprovalService } from '../../../shared/labs/human-approval/engine';
import type {
  ApprovalCommand,
  ApprovalResult,
  ApprovalTask,
  Enrollment,
  StoredApprovalCommand,
} from '../../../shared/labs/human-approval/types';
import { createSqliteApprovalStore } from '../../../server/labs/human-approval/store';
import { openLabDatabase, type LabDatabase } from '../../../server/storage/sqlite';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const context = { teachingSessionId: 'store-session' };
const input = { attendeeName: '示例学员', workshopId: 'reliable-actions' as const, seats: 2 };

function directory() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'approval-store-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function connect(dataDir = directory()) {
  const database = openLabDatabase({ dataDir });
  cleanup.push(() => database.close());
  const store = createSqliteApprovalStore(database);
  return { dataDir, database, store };
}

function fixture() {
  const connection = connect();
  let now = 1_000;
  let serial = 0;
  const service = createApprovalService(connection.store, {
    now: () => now,
    createId: (kind) => `${kind}-${++serial}`,
    standardTtlMs: 300_000,
    shortTtlMs: 5_000,
  });
  return { ...connection, service, setNow: (value: number) => (now = value) };
}

function propose(taskId = 'task-1', commandId = 'propose-1'): ApprovalCommand {
  return {
    taskId,
    commandId,
    expectedVersion: 0,
    payload: { type: 'propose', input, validity: 'short' },
  };
}

function accepted(result: ApprovalResult) {
  expect(result.status).toBe('accepted');
  if (result.status !== 'accepted') throw new Error(JSON.stringify(result));
  return result;
}

function decision(task: ApprovalTask, commandId = 'approve-1'): ApprovalCommand {
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

function count(database: LabDatabase, table: string) {
  return database.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count;
}

describe('SQLite approval storage', () => {
  it('reopens complete tasks, receipts and enrollment facts without losing fields', () => {
    const { dataDir, database, service } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const command = decision(task);
    const result = accepted(service.command(context, command));
    const before = service.facts(context, { taskId: task.taskId, commandId: command.commandId });
    expect(before).toMatchObject({
      status: 'found',
      durability: 'sqlite',
      recordCount: 1,
      task: { status: 'succeeded', version: 2 },
      receipt: result,
      enrollment: {
        taskId: task.taskId,
        commandId: command.commandId,
        teachingSessionId: context.teachingSessionId,
        content: input,
      },
    });
    database.close();

    const reopened = connect(dataDir);
    const nextService = createApprovalService(reopened.store, { now: () => 1_000 });
    expect(
      nextService.facts(context, { taskId: task.taskId, commandId: command.commandId }),
    ).toEqual(before);
    expect(nextService.command(context, command)).toEqual({ ...result, replayed: true });
    expect(count(reopened.database, 'human_approval_enrollments')).toBe(1);
    expect(count(reopened.database, 'human_approval_commands')).toBe(2);
  });

  it('replays the same committed command after expiry and preserves the original receipt on key reuse', () => {
    const { service, setNow, store } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const command = decision(task);
    const result = accepted(service.command(context, command));
    setNow(task.state.proposal.expiresAt + 1);
    expect(service.command(context, command)).toEqual({ ...result, replayed: true });
    expect(
      service.command(context, {
        ...command,
        payload: { ...command.payload, type: 'reject' },
      }),
    ).toMatchObject({ code: 'KEY_REUSED' });
    expect(
      store.transaction((tx) => tx.getCommand(context.teachingSessionId, command.commandId)),
    ).toMatchObject({ result });
    expect(service.facts(context, { taskId: task.taskId })).toMatchObject({ recordCount: 1 });
  });

  it('rolls back the decision, enrollment and receipt if receipt insertion fails', () => {
    const { service, database, store } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    database.db.exec(`
      CREATE TRIGGER fail_approval_receipt
      BEFORE INSERT ON human_approval_commands
      WHEN NEW.command_id = 'approve-1'
      BEGIN
        SELECT RAISE(ABORT, 'injected receipt failure');
      END;
    `);
    expect(() => service.command(context, decision(task))).toThrow(/injected receipt failure/u);
    expect(store.transaction((tx) => tx.getTask(task.taskId))).toEqual(task);
    expect(store.transaction((tx) => tx.getEnrollment(task.taskId))).toBeNull();
    expect(
      store.transaction((tx) => tx.getCommand(context.teachingSessionId, 'approve-1')),
    ).toBeNull();
    expect(count(database, 'human_approval_enrollments')).toBe(0);
    expect(count(database, 'human_approval_commands')).toBe(1);

    database.db.exec('DROP TRIGGER fail_approval_receipt');
    expect(service.command(context, decision(task))).toMatchObject({ status: 'accepted' });
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
    expect(service.command(context, decision(task))).toMatchObject({ status: 'accepted' });
  });

  it('isolates sessions and persists domain failures while rejecting malformed commands without receipts', () => {
    const { service, store, database } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const command = decision(task);
    const foreign = { teachingSessionId: 'another-session' };
    expect(service.facts(foreign, { taskId: task.taskId, commandId: 'propose-1' })).toMatchObject({
      status: 'rejected',
      code: 'SESSION_MISMATCH',
    });
    expect(service.command(foreign, command)).toMatchObject({
      status: 'rejected',
      code: 'SESSION_MISMATCH',
    });
    expect(store.transaction((tx) => tx.getTask(task.taskId))).toEqual(task);
    expect(
      store.transaction((tx) => tx.getCommand(context.teachingSessionId, 'approve-1')),
    ).toBeNull();

    const failure = service.command(context, { ...command, expectedVersion: 0 });
    expect(failure).toMatchObject({ status: 'conflict', code: 'VERSION_CONFLICT' });
    expect(
      service.facts(context, { taskId: task.taskId, commandId: command.commandId }),
    ).toMatchObject({
      receipt: failure,
      enrollment: null,
      recordCount: 0,
    });
    const receipts = count(database, 'human_approval_commands');
    expect(service.command(context, { ...command, commandId: '' })).toMatchObject({
      status: 'rejected',
      code: 'INVALID_INPUT',
    });
    expect(count(database, 'human_approval_commands')).toBe(receipts);
    expect(
      service.facts(context, { taskId: task.taskId, commandId: 'not-yet-recorded' }),
    ).toMatchObject({
      status: 'found',
      receipt: null,
    });
  });

  it('preserves JSON extensions and enforces immutable command keys, session ownership and one enrollment', () => {
    const { service, store, database } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const extended = { ...task, extra: { futureField: ['retained', 3] } };
    store.transaction((tx) => tx.putTask(extended));
    expect(store.transaction((tx) => tx.getTask(task.taskId))).toEqual(extended);
    expect(() =>
      store.transaction((tx) =>
        tx.putTask({
          ...extended,
          threadId: 'another-session',
          state: {
            proposal: { ...extended.state.proposal, teachingSessionId: 'another-session' },
          },
        }),
      ),
    ).toThrow(/session/u);
    expect(store.transaction((tx) => tx.getTask(task.taskId))).toEqual(extended);

    const result = accepted(service.command(context, decision(task)));
    const enrollment = result.result.enrollment!;
    expect(() =>
      store.transaction((tx) =>
        tx.putEnrollment({ ...enrollment, enrollmentId: 'second-enrollment' }),
      ),
    ).toThrow(/UNIQUE/u);
    expect(() =>
      store.transaction((tx) =>
        tx.putEnrollment({
          ...enrollment,
          enrollmentId: 'orphan',
          taskId: 'absent',
          proposalId: 'other',
        }),
      ),
    ).toThrow(/FOREIGN KEY/u);

    const receipt = store.transaction((tx) =>
      tx.getCommand(context.teachingSessionId, 'approve-1'),
    )!;
    expect(() =>
      store.transaction((tx) => tx.putCommand({ ...receipt, fingerprint: 'different' })),
    ).toThrow(/UNIQUE/u);
    expect(
      store.transaction((tx) => tx.getCommand(context.teachingSessionId, 'approve-1')),
    ).toEqual(receipt);
    expect(count(database, 'human_approval_enrollments')).toBe(1);

    const extendedReceipt = {
      ...receipt,
      commandId: 'extended-receipt',
      futureField: { keep: true },
    } satisfies StoredApprovalCommand & { futureField: object };
    store.transaction((tx) => tx.putCommand(extendedReceipt));
    expect(
      store.transaction((tx) => tx.getCommand(context.teachingSessionId, 'extended-receipt')),
    ).toEqual(extendedReceipt);
    const extendedEnrollment = {
      ...enrollment,
      enrollmentId: 'extended-enrollment',
      taskId: 'task-2',
      proposalId: 'proposal-2',
      futureField: { keep: true },
    } satisfies Enrollment & { futureField: object };
    store.transaction((tx) => {
      tx.putTask({ ...task, taskId: 'task-2' });
      tx.putEnrollment(extendedEnrollment);
    });
    expect(store.transaction((tx) => tx.getEnrollment('task-2'))).toEqual(extendedEnrollment);
  });

  it('keeps a reader snapshot consistent while an approval commits on another connection', () => {
    const { dataDir, service, database } = fixture();
    const task = accepted(service.command(context, propose())).result.task;
    const reader = connect(dataDir).database.db;
    reader.exec('BEGIN');
    try {
      const readTask = () =>
        JSON.parse(
          reader
            .prepare('SELECT snapshot_json FROM human_approval_tasks WHERE task_id = ?')
            .get(task.taskId)!.snapshot_json as string,
        );
      expect(readTask()).toEqual(task);
      accepted(service.command(context, decision(task)));
      expect(readTask()).toEqual(task);
      expect(
        reader
          .prepare('SELECT enrollment_json FROM human_approval_enrollments WHERE task_id = ?')
          .get(task.taskId),
      ).toBeUndefined();
    } finally {
      reader.exec('ROLLBACK');
    }
    expect(service.facts(context, { taskId: task.taskId })).toMatchObject({
      task: { status: 'succeeded', version: 2 },
      recordCount: 1,
    });
    expect(count(database, 'human_approval_enrollments')).toBe(1);
  });
});

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workerSource = `
  import { openLabDatabase } from ${JSON.stringify(new URL('../../../server/storage/sqlite.ts', import.meta.url).href)};
  import { createSqliteApprovalStore } from ${JSON.stringify(new URL('../../../server/labs/human-approval/store.ts', import.meta.url).href)};
  import { createApprovalService } from ${JSON.stringify(new URL('../../../shared/labs/human-approval/engine.ts', import.meta.url).href)};
  const database = openLabDatabase({ dataDir: process.env.APPROVAL_TEST_DIR });
  const service = createApprovalService(createSqliteApprovalStore(database));
  process.once('message', ({ context, command }) => {
    try {
      const result = service.command(context, command);
      database.close();
      process.send({ result }, () => process.disconnect());
    } catch (error) {
      database.close();
      process.send({ error: String(error) }, () => process.disconnect());
      process.exitCode = 1;
    }
  });
  process.send({ ready: true });
`;

async function worker(dataDir: string) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', workerSource],
    {
      cwd: root,
      env: { ...process.env, APPROVAL_TEST_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let errors = '';
  child.stderr!.on('data', (chunk) => (errors += String(chunk)));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Approval worker exited ${code}: ${errors}`)));
    child.once('message', () => resolve());
  });
  return child;
}

function runWorker(child: ChildProcess, command: ApprovalCommand) {
  return new Promise<ApprovalResult>((resolve, reject) => {
    child.once('message', (message: { result?: ApprovalResult; error?: string }) => {
      if (message.result) resolve(message.result);
      else reject(new Error(message.error));
    });
    child.send({ context, command });
  });
}

describe('independent SQLite processes', () => {
  it.each(['different', 'same'] as const)(
    'serializes competing approvals using %s command keys',
    async (keys) => {
      const { dataDir, service, database } = fixture();
      const initial = propose();
      initial.payload = { type: 'propose', input, validity: 'standard' };
      // The workers use the real clock, so create this proposal with the same clock.
      const liveService = createApprovalService(createSqliteApprovalStore(database));
      const task = accepted(liveService.command(context, initial)).result.task;
      const [first, second] = await Promise.all([worker(dataDir), worker(dataDir)]);
      const commands = [
        decision(task),
        decision(task, keys === 'same' ? 'approve-1' : 'approve-2'),
      ];
      const results = await Promise.all([
        runWorker(first, commands[0]),
        runWorker(second, commands[1]),
      ]);
      expect(count(database, 'human_approval_enrollments')).toBe(1);
      if (keys === 'same') {
        expect(results.every((result) => result.status === 'accepted')).toBe(true);
        expect(
          results.map((result) => result.status === 'accepted' && result.replayed).sort(),
        ).toEqual([false, true]);
        expect(count(database, 'human_approval_commands')).toBe(2);
      } else {
        expect(results.filter((result) => result.status === 'accepted')).toHaveLength(1);
        expect(results.filter((result) => result.status !== 'accepted')).toHaveLength(1);
        expect(count(database, 'human_approval_commands')).toBe(3);
      }
      expect(service.facts(context, { taskId: task.taskId })).toMatchObject({
        task: { status: 'succeeded', version: 2 },
        recordCount: 1,
      });
    },
    15_000,
  );
});
