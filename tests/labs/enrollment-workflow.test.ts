import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventType } from '@ag-ui/core';
import { applyA2uiMessages, resolveA2uiAction, updateA2uiBinding } from '../../shared/a2ui';
import { createWorkflowService } from '../../shared/labs/enrollment-workflow/engine';
import { createMemoryWorkflowStore } from '../../shared/labs/enrollment-workflow/memory';
import {
  appendWorkflowEvents,
  type WorkflowFacts,
  type WorkflowStore,
} from '../../shared/labs/enrollment-workflow/contract';
import { workflowForm } from '../../shared/labs/enrollment-workflow/surface';
import { createWorkflowStaticHandler } from '../../shared/labs/enrollment-workflow/static';
import type { ApprovalCommand, ApprovalResult } from '../../shared/labs/human-approval/types';
import { openLabDatabase } from '../../server/storage/sqlite';
import { createSqliteWorkflowStore } from '../../server/labs/enrollment-workflow/store';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const context = { teachingSessionId: 'workflow-session' };
const input = { attendeeName: '联合学习者', workshopId: 'agent-ui-basics' as const, seats: 2 };
const propose: ApprovalCommand = {
  taskId: 'workflow-task',
  commandId: 'propose-1',
  expectedVersion: 0,
  payload: { type: 'propose', input, validity: 'standard' },
};
function formAction(command: ApprovalCommand, task: WorkflowFacts['task'] | null = null) {
  let surface = applyA2uiMessages(null, workflowForm(task, command.taskId))!;
  if (command.payload.type !== 'propose' && command.payload.type !== 'edit')
    throw new Error('Form command required');
  const content = command.payload.input;
  surface = updateA2uiBinding(surface, '/form/attendeeName', content.attendeeName);
  surface = updateA2uiBinding(surface, '/form/workshopId', [content.workshopId]);
  surface = updateA2uiBinding(surface, '/form/seats', String(content.seats));
  return resolveA2uiAction(surface, 'submit', '2026-10-26T12:00:00.000Z');
}
function accepted(result: ApprovalResult) {
  expect(result.status).toBe('accepted');
  if (result.status !== 'accepted') throw new Error('Expected accepted');
  return result;
}
function facts(service: ReturnType<typeof createWorkflowService>, commandId?: string) {
  const value = service.facts(context, {
    taskId: propose.taskId,
    ...(commandId ? { commandId } : {}),
  });
  expect(value.status).toBe('found');
  if (value.status !== 'found') throw new Error('Expected facts');
  return value;
}
function decision(snapshot: WorkflowFacts, commandId = 'approve-1'): ApprovalCommand {
  const task = snapshot.task;
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
function sqlite() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'enrollment-workflow-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const database = openLabDatabase({ dataDir });
  cleanup.push(() => database.close());
  return { dataDir, database, store: createSqliteWorkflowStore(database) };
}

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`enrollment workflow (${kind})`, () => {
    function setup() {
      return createWorkflowService(
        kind === 'memory' ? createMemoryWorkflowStore() : sqlite().store,
      );
    }
    it('rejects native async transactions before invocation and prevents later writes', async () => {
      const store = kind === 'memory' ? createMemoryWorkflowStore() : sqlite().store;
      const service = createWorkflowService(store);
      accepted(service.command(context, propose, formAction(propose)));
      const before = facts(service);
      let invoked = false;
      expect(() =>
        // @ts-expect-error Untyped callers must be rejected before invoking an async callback.
        store.transaction(async (transaction) => {
          invoked = true;
          await Promise.resolve();
          transaction.putTask({ ...before.task, version: 99 });
        }),
      ).toThrow(/synchronous/u);
      expect(invoked).toBe(false);
      await Promise.resolve();
      expect(invoked).toBe(false);
      expect(facts(service)).toEqual({ ...before, asOf: expect.any(Number) });
    });
    it('rolls back task and event changes if a synchronous transaction returns a promise', () => {
      const store = kind === 'memory' ? createMemoryWorkflowStore() : sqlite().store;
      const service = createWorkflowService(store);
      accepted(service.command(context, propose, formAction(propose)));
      const before = facts(service);
      expect(() =>
        // @ts-expect-error Promise results are excluded even for synchronous callbacks.
        store.transaction((transaction) => {
          transaction.putTask({ ...before.task, version: 99 });
          transaction.appendEvent({ ...before.events.at(-1)!, seq: before.events.length + 1 });
          return Promise.resolve();
        }),
      ).toThrow(/synchronous/u);
      expect(facts(service)).toEqual({ ...before, asOf: expect.any(Number) });
    });
    it('waits for input in one run and commits one result and event sequence after an exact retry', () => {
      const service = setup();
      const receipt = accepted(service.command(context, propose, formAction(propose)));
      const waiting = facts(service);
      expect(waiting.task.status).toBe('waiting-input');
      expect(waiting.task.currentRunId).toBeTruthy();
      expect(waiting.events.map((event) => event.payload.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.STATE_SNAPSHOT,
        EventType.CUSTOM,
      ]);
      const approve = decision(waiting);
      const confirmed = accepted(service.command(context, approve));
      const completed = facts(service, approve.commandId);
      expect(completed.task.currentRunId).toBe(receipt.result.task.currentRunId);
      expect(completed.recordCount).toBe(1);
      expect(completed.enrollment?.content).toEqual(input);
      expect(
        completed.events.filter((event) => event.payload.type === EventType.RUN_FINISHED),
      ).toHaveLength(1);
      expect(
        completed.events.filter((event) => event.payload.type === EventType.TOOL_CALL_RESULT),
      ).toHaveLength(1);
      expect(service.command(context, approve)).toEqual({ ...confirmed, replayed: true });
      expect(facts(service, approve.commandId)).toEqual({ ...completed, asOf: expect.any(Number) });
      expect(service.command(context, { ...approve, taskId: 'different-task' })).toMatchObject({
        status: 'conflict',
        code: 'KEY_REUSED',
      });
    });
    it('rejects stale content, a foreign session and a mismatched protocol action without changing facts', () => {
      const service = setup();
      expect(
        service.command(context, propose, {
          ...formAction(propose),
          action: { ...formAction(propose).action, context: {} },
        }),
      ).toMatchObject({ status: 'rejected', code: 'INVALID_INPUT' });
      accepted(service.command(context, propose, formAction(propose)));
      const waiting = facts(service);
      const old = decision(waiting);
      const task = waiting.task;
      const edit: ApprovalCommand = {
        taskId: task.taskId,
        commandId: 'edit-1',
        expectedVersion: task.version,
        payload: {
          type: 'edit',
          proposalId: task.state.proposal.proposalId,
          proposalVersion: 1,
          input: { ...input, seats: 3 },
        },
      };
      accepted(service.command(context, edit, formAction(edit, task)));
      const edited = facts(service);
      expect(service.command(context, old)).toMatchObject({
        status: 'conflict',
        code: 'VERSION_CONFLICT',
      });
      expect(
        service.command({ teachingSessionId: 'foreign-session' }, decision(edited, 'other')),
      ).toMatchObject({ status: 'rejected', code: 'SESSION_MISMATCH' });
      expect(facts(service)).toEqual({ ...edited, asOf: expect.any(Number) });
      expect(edited.task.currentRunId).toBe(waiting.task.currentRunId);
      expect(edited.task.state.proposal.proposalVersion).toBe(2);
      expect(edited.recordCount).toBe(0);
    });
    it('replays a contiguous suffix and rejects foreign or future cursors', () => {
      const service = setup();
      accepted(service.command(context, propose, formAction(propose)));
      const first = facts(service);
      accepted(service.command(context, decision(first)));
      const all = facts(service);
      const suffix = service.facts(context, {
        taskId: propose.taskId,
        runId: first.task.currentRunId!,
        afterSeq: first.events.length,
      });
      expect(suffix.status).toBe('found');
      if (suffix.status !== 'found') throw new Error('Expected suffix');
      expect(
        appendWorkflowEvents(first.events, suffix.events, propose.taskId, first.task.currentRunId!),
      ).toEqual(all.events);
      expect(
        appendWorkflowEvents(all.events, all.events, propose.taskId, first.task.currentRunId!),
      ).toEqual(all.events);
      expect(() =>
        appendWorkflowEvents([], [all.events[1]], propose.taskId, first.task.currentRunId!),
      ).toThrow(/连续/u);
      expect(
        service.facts(context, { taskId: propose.taskId, runId: 'wrong-run', afterSeq: 0 }),
      ).toMatchObject({ status: 'rejected' });
      expect(service.facts(context, { taskId: propose.taskId, afterSeq: 999 })).toMatchObject({
        status: 'rejected',
      });
    });
  });
}

it('rolls back the business fact, command receipt and event log together when event persistence fails', () => {
  const { store } = sqlite();
  let fail = false;
  const faulty: WorkflowStore = {
    durability: 'sqlite',
    transaction(operation) {
      return store.transaction((transaction) =>
        operation({
          ...transaction,
          appendEvent(event) {
            if (fail) throw new Error('event persistence failed');
            transaction.appendEvent(event);
          },
        }),
      );
    },
  };
  const service = createWorkflowService(faulty);
  accepted(service.command(context, propose, formAction(propose)));
  const before = facts(service);
  const approve = decision(before);
  fail = true;
  expect(() => service.command(context, approve)).toThrow('event persistence failed');
  fail = false;
  expect(facts(service, approve.commandId)).toEqual({
    ...before,
    asOf: expect.any(Number),
    receipt: null,
  });
  accepted(service.command(context, approve));
  expect(facts(service).recordCount).toBe(1);
});

it('restores the waiting proposal, run, receipts and enrollment after reopening SQLite', () => {
  const { dataDir, database, store } = sqlite();
  const first = createWorkflowService(store);
  accepted(first.command(context, propose, formAction(propose)));
  const waiting = facts(first);
  database.close();
  const secondDb = openLabDatabase({ dataDir });
  cleanup.push(() => secondDb.close());
  const second = createWorkflowService(createSqliteWorkflowStore(secondDb));
  expect(facts(second)).toEqual({ ...waiting, asOf: expect.any(Number) });
  const approve = decision(waiting);
  const confirmed = accepted(second.command(context, approve));
  secondDb.close();
  const thirdDb = openLabDatabase({ dataDir });
  cleanup.push(() => thirdDb.close());
  const third = createWorkflowService(createSqliteWorkflowStore(thirdDb));
  expect(facts(third, approve.commandId)).toMatchObject({
    recordCount: 1,
    task: { currentRunId: waiting.task.currentRunId },
    receipt: confirmed,
  });
  expect(third.command(context, approve)).toEqual({ ...confirmed, replayed: true });
});

it('the Pages adapter commits before losing a response and uses a separate memory store per page', async () => {
  const handle = createWorkflowStaticHandler();
  const headers = {
    'Content-Type': 'application/json',
    'X-Teaching-Session': context.teachingSessionId,
    'X-Workflow-Drop-Response': '1',
  };
  await expect(
    handle('/api/labs/enrollment-workflow/commands', {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: propose, action: formAction(propose) }),
    }),
  ).rejects.toThrow(/响应/u);
  const response = await handle(`/api/labs/enrollment-workflow/facts?taskId=${propose.taskId}`, {
    headers,
  });
  expect(response?.headers.get('X-Lab-Transport')).toBe('browser-memory');
  expect(await response?.json()).toMatchObject({
    status: 'found',
    recordCount: 0,
    task: { status: 'waiting-input' },
  });
  const other = createWorkflowStaticHandler();
  expect(
    (await other(`/api/labs/enrollment-workflow/facts?taskId=${propose.taskId}`, { headers }))
      ?.status,
  ).toBe(404);
});
