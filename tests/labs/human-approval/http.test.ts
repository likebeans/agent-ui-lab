import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { installHumanApprovalRoutes } from '../../../server/labs/human-approval/routes';
import { createServer } from '../../../server/index';
import { loadRuntimeConfig } from '../../../config/runtime';
import {
  APPROVAL_API,
  DROP_RESPONSE_HEADER,
  TEACHING_SESSION_HEADER,
  type ApprovalCommand,
  type ApprovalResult,
  type ApprovalTask,
} from '../../../shared/labs/human-approval/types';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function directory() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'approval-http-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fixture() {
  const app = express();
  app.use(express.json());
  const routes = installHumanApprovalRoutes(app, { dataDir: directory() });
  cleanup.push(() => routes.close());
  app.use((_request, response) => response.status(404).json({ error: '未找到此接口。' }));
  return listen(createHttpServer(app));
}

const session = 'http-session';
const input = { attendeeName: '教学体验者', workshopId: 'agent-ui-basics' as const, seats: 2 };
const proposal = (suffix = 'one'): ApprovalCommand => ({
  taskId: `task-${suffix}`,
  commandId: `propose-${suffix}`,
  expectedVersion: 0,
  payload: { type: 'propose', input, validity: 'standard' },
});

function decision(task: ApprovalTask, type: 'approve' | 'reject' = 'approve'): ApprovalCommand {
  return {
    taskId: task.taskId,
    commandId: `${type}-${task.taskId}`,
    expectedVersion: task.version,
    payload: {
      type,
      proposalId: task.state.proposal.proposalId,
      proposalVersion: task.state.proposal.proposalVersion,
    },
  };
}

function post(origin: string, command: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin}${APPROVAL_API}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TEACHING_SESSION_HEADER]: session, ...headers },
    body: JSON.stringify(command),
  });
}

async function create(origin: string, suffix = 'one'): Promise<ApprovalTask> {
  const response = await post(origin, proposal(suffix));
  expect(response.status).toBe(200);
  const value = (await response.json()) as ApprovalResult;
  if (value.status !== 'accepted') throw new Error(JSON.stringify(value));
  return value.result.task;
}

function facts(origin: string, taskId: string, commandId?: string, teachingSession = session) {
  const query = new URLSearchParams({ taskId });
  if (commandId) query.set('commandId', commandId);
  return fetch(`${origin}${APPROVAL_API}/facts?${query}`, {
    headers: { [TEACHING_SESSION_HEADER]: teachingSession },
  });
}

describe('approval HTTP adapter', () => {
  it('writes one enrollment, queries authoritative facts, and replays the same command', async () => {
    const origin = await fixture();
    const task = await create(origin);
    const command = decision(task);
    const result = await (await post(origin, command)).json();
    expect(result).toMatchObject({ status: 'accepted', replayed: false, version: 2 });
    expect(await (await post(origin, command)).json()).toEqual({ ...result, replayed: true });
    const queried = await facts(origin, task.taskId, command.commandId);
    expect(queried.headers.get('cache-control')).toBe('no-store');
    expect(await queried.json()).toMatchObject({
      status: 'found',
      durability: 'sqlite',
      recordCount: 1,
      task: { status: 'succeeded', version: 2 },
      enrollment: { commandId: command.commandId, content: input },
      receipt: result,
    });
    const altered = await post(origin, {
      ...command,
      payload: { ...command.payload, type: 'reject' },
    });
    expect(altered.status).toBe(409);
    expect(await altered.json()).toMatchObject({ status: 'conflict', code: 'KEY_REUSED' });
    expect(await (await facts(origin, task.taskId)).json()).toMatchObject({ recordCount: 1 });
  });

  it('rejects without enrollment and refuses old task and content versions after editing', async () => {
    const origin = await fixture();
    const task = await create(origin);
    const old = decision(task);
    const edit: ApprovalCommand = {
      ...old,
      commandId: 'edit-one',
      payload: {
        type: 'edit',
        proposalId: task.state.proposal.proposalId,
        proposalVersion: 1,
        input: { ...input, seats: 3 },
      },
    };
    expect(await (await post(origin, edit)).json()).toMatchObject({
      status: 'accepted',
      version: 2,
    });
    expect(await (await post(origin, old)).json()).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      await (await post(origin, { ...old, commandId: 'old-content', expectedVersion: 2 })).json(),
    ).toMatchObject({ code: 'PROPOSAL_VERSION_CONFLICT' });
    const current = await (await facts(origin, task.taskId)).json();
    expect(await (await post(origin, decision(current.task, 'reject'))).json()).toMatchObject({
      status: 'accepted',
      result: { task: { status: 'cancelled' }, enrollment: null },
    });
    expect(await (await facts(origin, task.taskId)).json()).toMatchObject({
      recordCount: 0,
      enrollment: null,
    });
  });

  it('keeps teaching-session identity in the header and denies foreign facts and replay', async () => {
    const origin = await fixture();
    const task = await create(origin);
    const command = decision(task);
    await (await post(origin, command)).json();
    const foreign = await facts(origin, task.taskId, command.commandId, 'foreign-session');
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual(
      expect.objectContaining({ status: 'rejected', code: 'SESSION_MISMATCH' }),
    );
    const replay = await post(origin, command, { [TEACHING_SESSION_HEADER]: 'foreign-session' });
    expect(replay.status).toBe(403);
    expect(await replay.json()).not.toHaveProperty('result');
    const other = await create(origin, 'other');
    const unrelatedReceipt = await facts(origin, other.taskId, command.commandId);
    expect(unrelatedReceipt.status).toBe(409);
    expect(await unrelatedReceipt.json()).toMatchObject({ status: 'rejected', code: 'KEY_REUSED' });
    const bodySpoof = await post(origin, { ...proposal('spoof'), teachingSessionId: session });
    expect(bodySpoof.status).toBe(400);
    expect(await bodySpoof.json()).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('reports schema, JSON, method and query failures as explicit results', async () => {
    const origin = await fixture();
    const invalid = await post(origin, {
      ...proposal(),
      payload: { type: 'propose', validity: 'standard', input: { ...input, seats: 0 } },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: 'INVALID_INPUT',
      fieldErrors: { seats: expect.any(String) },
    });
    const malformed = await fetch(`${origin}${APPROVAL_API}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TEACHING_SESSION_HEADER]: session },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ status: 'rejected', code: 'INVALID_INPUT' });
    const method = await fetch(`${origin}${APPROVAL_API}/commands`);
    expect(method.status).toBe(405);
    const missing = await facts(origin, 'not-created');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'NOT_FOUND' });
    const repeatedQuery = await fetch(`${origin}${APPROVAL_API}/facts?taskId=one&taskId=two`, {
      headers: { [TEACHING_SESSION_HEADER]: session },
    });
    expect(repeatedQuery.status).toBe(400);
    expect(await repeatedQuery.json()).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('commits before deliberately dropping the response, then recovers by facts and the original key', async () => {
    const origin = await fixture();
    const task = await create(origin);
    const command = decision(task);
    await expect(post(origin, command, { [DROP_RESPONSE_HEADER]: '1' })).rejects.toThrow();
    const authoritative = await (await facts(origin, task.taskId, command.commandId)).json();
    expect(authoritative).toMatchObject({
      recordCount: 1,
      receipt: { status: 'accepted' },
      enrollment: { commandId: command.commandId, content: input },
    });
    expect(await (await post(origin, command)).json()).toMatchObject({
      status: 'accepted',
      replayed: true,
    });
    expect(await (await facts(origin, task.taskId)).json()).toMatchObject({ recordCount: 1 });
  });

  it('registers the module in createServer using the supplied instance data directory', async () => {
    const dataDir = directory();
    const app = createServer({ ...loadRuntimeConfig(), dataDir });
    cleanup.push(() => app.locals.closeLabs());
    const origin = await listen(createHttpServer(app));
    const task = await create(origin, 'registered');
    expect(await (await facts(origin, task.taskId)).json()).toMatchObject({
      status: 'found',
      durability: 'sqlite',
    });
  });
});

const root = new URL('../../../', import.meta.url);
const serverSource = `
  import express from 'express';
  import { installHumanApprovalRoutes } from ${JSON.stringify(new URL('../../../server/labs/human-approval/routes.ts', import.meta.url).href)};
  const app = express();
  app.use(express.json());
  const routes = installHumanApprovalRoutes(app, { dataDir: process.env.APPROVAL_TEST_DIR });
  const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  process.once('SIGTERM', () => server.close(() => { routes.close(); process.exit(0); }));
`;

async function serverProcess(dataDir: string) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', serverSource],
    {
      cwd: root,
      env: { ...process.env, APPROVAL_TEST_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Approval server exited: ${stderr}`)));
    child.once('message', (message: { port: number }) => resolve(message.port));
  });
  return { child, exited, origin: `http://127.0.0.1:${port}` };
}

it('keeps committed records and command receipts after a real server process restart', async () => {
  const dataDir = directory();
  const first = await serverProcess(dataDir);
  const task = await create(first.origin, 'restart');
  const command = decision(task);
  const result = await (await post(first.origin, command)).json();
  first.child.kill('SIGTERM');
  await first.exited;
  const second = await serverProcess(dataDir);
  expect(await (await facts(second.origin, task.taskId, command.commandId)).json()).toMatchObject({
    status: 'found',
    recordCount: 1,
    receipt: result,
    enrollment: { commandId: command.commandId, content: input },
  });
  expect(await (await post(second.origin, command)).json()).toEqual({ ...result, replayed: true });
}, 15_000);
