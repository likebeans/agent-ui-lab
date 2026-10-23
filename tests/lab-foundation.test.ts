import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLabRegistry, getLab, labFromHash, labHref, labs } from '../src/labs/registry';
import foundation from '../src/labs/foundation/manifest';
import { runFoundation } from '../shared/labs/foundation/engine';
import { staticFetch } from '../shared/static-api';
import { correlateTrace, findTrace, type TraceEntry } from '../shared/trace';
import { createServer } from '../server/index';
import { resolveChatLab } from '../src/labs/chat';
import { mergeLabContext } from '../shared/lab-context';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(close.splice(0).map((cleanup) => cleanup()));
});

describe('lab registration', () => {
  it('discovers all manifests including a lab without protocols and retains legacy links', () => {
    expect(labs.map((lab) => lab.id)).toEqual(['agui', 'a2ui', 'mcp', 'foundation']);
    expect(getLab('foundation')?.protocols).toEqual([]);
    for (const id of ['agui', 'a2ui', 'mcp']) {
      expect(labFromHash(`#${id}`)?.id).toBe(id);
      expect(labFromHash(labHref(id))?.id).toBe(id);
    }
    for (const hash of ['#labs/../agui', '#labs/agui/extra', '#labs/%61gui', '#labs/missing'])
      expect(labFromHash(hash)).toBeUndefined();
  });

  it('validates identity, duplicates and required metadata without mutating definitions', () => {
    expect(() => createLabRegistry([foundation, foundation])).toThrow(/重复/u);
    expect(() => createLabRegistry([{ ...foundation, id: '../other' }])).toThrow(/无效/u);
    expect(() => createLabRegistry([{ ...foundation, modes: [] }])).toThrow(/不完整/u);
    const defs = Object.freeze([{ ...foundation, id: 'later', order: 100 }, foundation]);
    expect(createLabRegistry(defs).map((lab) => lab.id)).toEqual(['foundation', 'later']);
    expect(defs[0].id).toBe('later');
  });

  it('loads a component only when its loader is invoked', async () => {
    let loads = 0;
    const registry = createLabRegistry([
      {
        ...foundation,
        load: async () => {
          loads++;
          return { default: () => null };
        },
      },
    ]);
    expect(loads).toBe(0);
    await registry[0].load();
    expect(loads).toBe(1);
  });

  it('keeps non-travel context through a custom chat resolver', async () => {
    const lab = getLab('foundation')!;
    const previous = lab.chat;
    lab.chat = {
      short: '测试',
      prompt: '测试',
      starter: '测试',
      suggestion: '继续',
      source: 'test',
      load: async () => ({ default: () => null }),
      resolve: async (_prompt, context) => ({
        labId: 'foundation',
        context,
        explanation: 'custom',
      }),
    };
    try {
      const context = { review: { revision: 3, draft: '材料' } };
      await expect(
        resolveChatLab('审核材料', 'foundation', context, new AbortController().signal),
      ).resolves.toEqual({ labId: 'foundation', context, explanation: 'custom' });
    } finally {
      lab.chat = previous;
    }
  });
});

it('merges interaction fields against the latest namespace without restoring an old turn snapshot', () => {
  const current = Object.freeze({
    trip: Object.freeze({ city: '成都', days: 4 }),
    review: Object.freeze({ revision: 3, draft: '材料' }),
  });
  const next = mergeLabContext(current, { trip: { city: '杭州' } });
  expect(next).toEqual({
    trip: { city: '杭州', days: 4 },
    review: { revision: 3, draft: '材料' },
  });
  expect(next.review).toBe(current.review);
  expect(current.trip).toEqual({ city: '成都', days: 4 });
  expect(mergeLabContext(next, { review: null, selection: ['one'] })).toMatchObject({
    trip: { city: '杭州', days: 4 },
    review: null,
    selection: ['one'],
  });
});

describe('trace identity', () => {
  it('correlates the actual AG-UI run without changing the original payload', () => {
    const payload = Object.freeze({
      type: 'RUN_STARTED',
      threadId: 'thread-real',
      runId: 'run-real',
    });
    const input = {
      protocol: 'agui' as const,
      direction: 'server→client' as const,
      label: '显示文案',
      payload,
    };
    const result = correlateTrace(input, { labId: 'agui', turnId: 'turn-1' });
    expect(result).toMatchObject({
      labId: 'agui',
      turnId: 'turn-1',
      threadId: 'thread-real',
      runId: 'run-real',
      eventType: 'RUN_STARTED',
    });
    expect(result.payload).toBe(payload);
    expect(input).not.toHaveProperty('labId');
  });

  it('locates evidence by lab/run/event independent of labels', () => {
    const entries: TraceEntry[] = [
      {
        id: 1,
        time: 0,
        labId: 'one',
        runId: 'run-1',
        eventType: 'result',
        seq: 2,
        direction: 'local',
        label: '相同显示名',
        payload: 1,
      },
      {
        id: 2,
        time: 1,
        labId: 'two',
        runId: 'run-2',
        eventType: 'result',
        seq: 2,
        direction: 'local',
        label: '相同显示名',
        payload: 2,
      },
    ];
    expect(findTrace(entries, { labId: 'one', runId: 'run-1', eventType: 'result' })?.id).toBe(1);
    expect(findTrace(entries, { labId: 'one', seq: 3 })).toBeUndefined();
    expect(findTrace(entries, { label: '相同显示名', occurrence: 0 })?.id).toBe(1);
  });
});

it('uses one validated engine contract for HTTP and static lab handlers', async () => {
  const server = createHttpServer(createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close.push(() => new Promise((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (value: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  for (const input of [{ text: '  你好🌱  ' }, { text: '' }, { text: 'yes', extra: true }]) {
    const [http, local] = await Promise.all([
      fetch(`${origin}/api/labs/foundation/run`, post(input)),
      staticFetch('/api/labs/foundation/run', post(input)),
    ]);
    expect(http.status).toBe(local.status);
    expect(await http.json()).toEqual(await local.json());
  }
  expect(runFoundation({ text: '  你好🌱  ' })).toEqual({
    text: '你好🌱',
    characters: 3,
    engine: 'deterministic-fixture',
  });
});
