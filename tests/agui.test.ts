import express from 'express';
import type { AddressInfo } from 'node:net';
import { EventType, PROTOCOL_VERSION, type AGUIEvent, type RunAgentInput } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTripPlan as buildServerTripPlan, installAguiRoutes } from '../server/agui';
import { buildTripPlan, parseTripRunInput, streamTripRun } from '../shared/agui-agent';
import {
  aguiReducer,
  applyReplaceOnlyPatch,
  createInitialAguiState,
  finalizeAguiStream,
  parseAguiEvent,
  type AguiLabState,
} from '../shared/agui';
import { consumeSse } from '../shared/sse';

const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];
let sequence = 0;

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  sequence += 1;
  return {
    threadId: `thread_${sequence}`,
    runId: `run_${sequence}`,
    protocolVersion: PROTOCOL_VERSION,
    messages: [{ id: `user_${sequence}`, role: 'user', content: '请规划上海 2 天游，偏好看展。' }],
    tools: [],
    context: [],
    forwardedProps: { city: '上海', days: 2, preference: '看展与艺术', scenario: 'success' },
    ...overrides,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '128kb' }));
  installAguiRoutes(app);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function collect(baseUrl: string, runInput: RunAgentInput): Promise<AGUIEvent[]> {
  const response = await fetch(`${baseUrl}/api/agui`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(runInput),
  });
  const events: AGUIEvent[] = [];
  await consumeSse(response, (value) => events.push(EventSchemas.parse(value)));
  return events;
}

function reduceEvents(events: AGUIEvent[]): AguiLabState {
  return events.reduce(
    (state, event) => aguiReducer(state, { kind: 'event', event }),
    createInitialAguiState(),
  );
}

describe('shared AG-UI trip engine', () => {
  it('applies official schema defaults and preserves the server trip-plan export', () => {
    const runInput = input();
    const { tools: _tools, context: _context, ...minimal } = runInput;
    expect(parseTripRunInput(minimal)).toEqual(runInput);
    expect(buildServerTripPlan).toBe(buildTripPlan);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['official schema', { messages: 'invalid' }, 'RunAgentInput 不合法：'],
    ['thread ID', { threadId: 'bad id' }, 'threadId 只能包含'],
    ['run ID', { runId: 'x'.repeat(81) }, 'runId 只能包含'],
    ['protocol version', { protocolVersion: '0.0' }, `本实验只支持 AG-UI ${PROTOCOL_VERSION}。`],
    ['missing messages', { messages: [] }, 'messages 数量必须在 1 到 50 之间。'],
    [
      'too many messages',
      {
        messages: Array.from({ length: 51 }, (_, id) => ({
          id: `${id}`,
          role: 'user',
          content: '行程',
        })),
      },
      'messages 数量必须在 1 到 50 之间。',
    ],
    [
      'blank user text',
      { messages: [{ id: 'user', role: 'user', content: '   ' }] },
      '最后一条用户文本必须包含 1 到 500 个字符。',
    ],
    [
      'long user text',
      { messages: [{ id: 'user', role: 'user', content: '游'.repeat(501) }] },
      '最后一条用户文本必须包含 1 到 500 个字符。',
    ],
    [
      'too many tools',
      { tools: Array.from({ length: 21 }, () => ({ name: 'tool', description: 'fixture' })) },
      'tools 或 context 数量超过实验上限。',
    ],
    [
      'too much context',
      { context: Array.from({ length: 21 }, () => ({ description: 'fixture', value: 'value' })) },
      'tools 或 context 数量超过实验上限。',
    ],
    ['non-object props', { forwardedProps: [] }, 'forwardedProps 必须是对象。'],
    ['unsupported city', { forwardedProps: { city: '北京' } }, 'city 仅支持杭州、成都或上海。'],
    ['days outside range', { forwardedProps: { days: 8 } }, 'days 必须是 1 到 7 的整数。'],
    ['non-integer days', { forwardedProps: { days: 1.5 } }, 'days 必须是 1 到 7 的整数。'],
    [
      'unknown scenario',
      { forwardedProps: { scenario: 'other' } },
      'scenario 仅支持 success 或 error。',
    ],
    [
      'long preference',
      { forwardedProps: { preference: '游'.repeat(301) } },
      'preference 必须是不超过 300 字符的字符串。',
    ],
  ])('rejects %s with the same error before HTTP streaming', async (_name, overrides, message) => {
    const runInput = { ...input(), ...overrides };
    expect(() => parseTripRunInput(runInput)).toThrow(message);
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runInput),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ error: expect.stringContaining(message) });
  });

  it.each(['success', 'error'] as const)(
    'emits identical schema-valid %s events over a callback and HTTP',
    async (scenario) => {
      const runInput = parseTripRunInput(input({ forwardedProps: { scenario } }));
      const events: AGUIEvent[] = [];
      await streamTripRun(
        runInput,
        async (event) => {
          events.push(EventSchemas.parse(event));
        },
        { cancelRequested: false, signal: new AbortController().signal },
        0,
      );
      const baseUrl = await startServer();
      expect(events).toEqual(await collect(baseUrl, runInput));
      expect(reduceEvents(events).phase).toBe(scenario);
      if (scenario === 'success') {
        expect(events.map((event) => event.type)).toEqual([
          EventType.RUN_STARTED,
          EventType.STATE_SNAPSHOT,
          EventType.TEXT_MESSAGE_START,
          EventType.TEXT_MESSAGE_CONTENT,
          EventType.TEXT_MESSAGE_CONTENT,
          EventType.TEXT_MESSAGE_END,
          EventType.STATE_DELTA,
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
          EventType.STATE_DELTA,
          EventType.TEXT_MESSAGE_START,
          EventType.TEXT_MESSAGE_CONTENT,
          EventType.TEXT_MESSAGE_CONTENT,
          EventType.TEXT_MESSAGE_END,
          EventType.STATE_DELTA,
          EventType.RUN_FINISHED,
        ]);
        expect(reduceEvents(events).agentState).toMatchObject({ city: '上海', days: 2 });
      } else {
        expect(events.at(-1)).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'FIXTURE_UNAVAILABLE',
        });
        expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
      }
    },
  );

  it.each(Array.from({ length: 18 }, (_, index) => index))(
    'closes open streams when cancelled after event %i',
    async (cancelAfter) => {
      const runInput = parseTripRunInput(input());
      const control = { cancelRequested: false, signal: new AbortController().signal };
      const events: AGUIEvent[] = [];
      await streamTripRun(
        runInput,
        async (event) => {
          events.push(EventSchemas.parse(event));
          if (events.length === cancelAfter + 1) control.cancelRequested = true;
        },
        control,
        0,
      );

      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_FINISHED,
        threadId: runInput.threadId,
        runId: runInput.runId,
        outcome: { type: 'cancelled' },
      });
      expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1);
      const state = reduceEvents(events);
      expect(state.phase).toBe('cancelled');
      expect(state.messages.every((message) => message.complete)).toBe(true);
      for (const tool of state.toolCalls) {
        expect(tool.status).not.toBe('streaming');
        expect(JSON.parse(tool.argsText)).toEqual({
          city: '上海',
          days: 2,
          preference: '看展与艺术',
        });
      }
    },
  );

  it('does not emit events for a transport that was already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('transport closed'));
    const send = vi.fn(async (_event: AGUIEvent) => {});
    await streamTripRun(input(), send, { cancelRequested: true, signal: controller.signal }, 0);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([EventType.TEXT_MESSAGE_START, EventType.TOOL_CALL_ARGS])(
    'treats abort during %s as truncation even if cancellation is also requested',
    async (abortAfter) => {
      const controller = new AbortController();
      const control = { cancelRequested: false, signal: controller.signal };
      const events: AGUIEvent[] = [];
      await streamTripRun(
        input(),
        async (event) => {
          events.push(event);
          if (event.type === abortAfter) {
            control.cancelRequested = true;
            controller.abort();
          }
        },
        control,
        0,
      );
      expect(events.at(-1)?.type).toBe(abortAfter);
      expect(finalizeAguiStream(reduceEvents(events)).phase).toBe('truncated');
    },
  );

  it('stops cancellation cleanup if the transport aborts while closing a message', async () => {
    const controller = new AbortController();
    const control = { cancelRequested: false, signal: controller.signal };
    const events: AGUIEvent[] = [];
    await streamTripRun(
      input(),
      async (event) => {
        events.push(event);
        if (event.type === EventType.TEXT_MESSAGE_START) control.cancelRequested = true;
        if (event.type === EventType.TEXT_MESSAGE_END) controller.abort();
      },
      control,
      0,
    );
    expect(events.at(-1)?.type).toBe(EventType.TEXT_MESSAGE_END);
    expect(finalizeAguiStream(reduceEvents(events)).phase).toBe('truncated');
  });

  it('aborts a pending event delay promptly and removes its timer and listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    try {
      const events: AGUIEvent[] = [];
      const running = streamTripRun(
        input(),
        async (event) => {
          events.push(event);
        },
        { cancelRequested: false, signal: controller.signal },
        1_000,
      );
      await vi.advanceTimersByTimeAsync(20);
      expect(events.map((event) => event.type)).toEqual([EventType.RUN_STARTED]);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort(new Error('transport closed'));
      await running;
      expect(vi.getTimerCount()).toBe(0);
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(finalizeAguiStream(reduceEvents(events)).phase).toBe('truncated');
    } finally {
      removeListener.mockRestore();
      vi.useRealTimers();
    }
  });

  it('awaits the event consumer and propagates consumer failures', async () => {
    let rejectSend!: (reason: Error) => void;
    const blocked = new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    });
    const send = vi.fn((_event: AGUIEvent) => blocked);
    const running = streamTripRun(
      input(),
      send,
      { cancelRequested: false, signal: new AbortController().signal },
      0,
    );
    expect(send).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
    const failure = new Error('consumer failed');
    const rejected = expect(running).rejects.toBe(failure);
    rejectSend(failure);
    await rejected;
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('AG-UI 1.0 deterministic lab', () => {
  it('streams a schema-valid lifecycle and reconstructs text, fragmented tool args and state', async () => {
    const baseUrl = await startServer();
    const events = await collect(baseUrl, input());
    const types = events.map((event) => event.type);

    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types.filter((type) => type === EventType.TOOL_CALL_ARGS)).toHaveLength(2);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
    expect(types).toContain(EventType.STATE_SNAPSHOT);
    expect(types).toContain(EventType.STATE_DELTA);

    const state = reduceEvents(events);
    expect(state.phase).toBe('success');
    expect(state.messages.map((message) => message.text).join(' ')).toContain('上海');
    expect(state.toolCalls[0]).toMatchObject({ name: 'lookup_trip_fixture', status: 'result' });
    expect(JSON.parse(state.toolCalls[0]!.argsText)).toEqual({
      city: '上海',
      days: 2,
      preference: '看展与艺术',
    });
    expect(state.agentState?.status).toBe('ready');
    expect(state.agentState?.tasks.every((task) => task.status === 'done')).toBe(true);
    expect(state.agentState?.itinerary[0]).toContain('博物馆');
  });

  it('supports only safe replace patches and rejects unsupported operations and paths', () => {
    const source = { safe: { value: 1 }, items: ['a', 'b'] };
    expect(
      applyReplaceOnlyPatch(source, [{ op: 'replace', path: '/safe/value', value: 2 }]),
    ).toEqual({ safe: { value: 2 }, items: ['a', 'b'] });
    expect(source).toEqual({ safe: { value: 1 }, items: ['a', 'b'] });
    expect(() =>
      applyReplaceOnlyPatch(source, [{ op: 'add', path: '/safe/other', value: 2 }]),
    ).toThrow('仅支持');
    expect(() =>
      applyReplaceOnlyPatch(source, [{ op: 'replace', path: '/missing', value: 2 }]),
    ).toThrow('不存在');
    expect(() =>
      applyReplaceOnlyPatch(source, [{ op: 'replace', path: '/__proto__/polluted', value: true }]),
    ).toThrow();
  });

  it('rejects invalid input before opening SSE', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input({ runId: 'bad id with spaces' })),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('runId'),
    });
  });

  it('uses RUN_ERROR as the terminal event for a simulated in-stream failure', async () => {
    const baseUrl = await startServer();
    const runInput = input({
      forwardedProps: { city: '成都', days: 3, preference: '慢节奏', scenario: 'error' },
    });
    const events = await collect(baseUrl, runInput);
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'FIXTURE_UNAVAILABLE' });
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
    expect(reduceEvents(events)).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('不可用'),
    });
  });

  it('accepts protocol cancellation and closes with RUN_FINISHED cancelled', async () => {
    const baseUrl = await startServer();
    const runInput = input({
      forwardedProps: { city: '杭州', days: 5, preference: '散步', scenario: 'success' },
    });
    const response = await fetch(`${baseUrl}/api/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(runInput),
    });
    const events: AGUIEvent[] = [];
    let cancelRequest: Promise<Response> | undefined;
    await consumeSse(response, (value) => {
      const event = EventSchemas.parse(value);
      events.push(event);
      if (event.type === EventType.RUN_STARTED && !cancelRequest) {
        cancelRequest = fetch(`${baseUrl}/api/agui/${runInput.runId}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      }
    });

    expect(cancelRequest).toBeDefined();
    expect((await cancelRequest!).status).toBe(202);
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      threadId: runInput.threadId,
      runId: runInput.runId,
      outcome: { type: 'cancelled' },
    });
    expect(reduceEvents(events).phase).toBe('cancelled');
  });

  it('distinguishes a truncated transport from protocol cancellation and allows reset', () => {
    const started = aguiReducer(createInitialAguiState(), {
      kind: 'event',
      event: parseAguiEvent({
        type: EventType.RUN_STARTED,
        threadId: 'thread',
        runId: 'run',
        protocolVersion: '1.0',
      }),
    });
    const truncated = finalizeAguiStream(started);
    expect(truncated).toMatchObject({ phase: 'truncated', error: expect.stringContaining('截断') });
    expect(aguiReducer(truncated, { kind: 'reset' })).toEqual(createInitialAguiState());
  });

  it('rejects malformed events and terminal runs with open streams', () => {
    expect(() => parseAguiEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm' })).toThrow(
      '不合法',
    );
    let state = aguiReducer(createInitialAguiState(), {
      kind: 'event',
      event: {
        type: EventType.RUN_STARTED,
        threadId: 'thread',
        runId: 'run',
        protocolVersion: '1.0',
      },
    });
    state = aguiReducer(state, {
      kind: 'event',
      event: { type: EventType.TEXT_MESSAGE_START, messageId: 'message', role: 'assistant' },
    });
    expect(() =>
      aguiReducer(state, {
        kind: 'event',
        event: {
          type: EventType.RUN_FINISHED,
          threadId: 'thread',
          runId: 'run',
          outcome: { type: 'success' },
        },
      }),
    ).toThrow('未关闭');
  });
});
