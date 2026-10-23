import { EventType, PROTOCOL_VERSION, type AGUIEvent } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { describe, expect, it } from 'vitest';
import { a2uiResponseSchema, applyA2uiMessages, resolveA2uiAction } from '../shared/a2ui';
import { staticFetch } from '../shared/static-api';
import { consumeSse } from '../shared/sse';

function post(body: unknown, signal?: AbortSignal): RequestInit {
  return { method: 'POST', body: JSON.stringify(body), signal };
}

function runInput() {
  return {
    threadId: 'static-thread',
    runId: `run-${crypto.randomUUID()}`,
    protocolVersion: PROTOCOL_VERSION,
    messages: [{ id: 'user', role: 'user', content: '杭州三日游' }],
    tools: [],
    context: [],
    forwardedProps: { city: '杭州', days: 3 },
  };
}

describe('Pages local route contract', () => {
  it('returns schema-valid A2UI responses and resolves actions through the shared validator', async () => {
    const response = await staticFetch('/api/a2ui/surface', post({}));
    expect(response.headers.get('X-Lab-Transport')).toBe('browser-memory');
    const payload = a2uiResponseSchema.parse(await response.json());
    const surface = applyA2uiMessages(null, payload.messages)!;
    surface.model.form = { destination: ['chengdu'], traveler: '静态学习者', days: '3' };
    const action = resolveA2uiAction(surface, 'submit');
    const updated = a2uiResponseSchema.parse(
      await (await staticFetch('/api/a2ui/action', post(action))).json(),
    );
    expect(applyA2uiMessages(surface, updated.messages)?.model.result).toMatchObject({
      status: expect.stringContaining('静态学习者'),
    });
    const invalid = structuredClone(action);
    invalid.action.sourceComponentId = 'unsupported';
    expect((await staticFetch('/api/a2ui/action', post(invalid))).status).toBe(400);
    const deleted = a2uiResponseSchema.parse(
      await (await staticFetch('/api/a2ui/surface/trip-planner', { method: 'DELETE' })).json(),
    );
    expect(applyA2uiMessages(surface, deleted.messages)).toBeNull();
  });

  it('confirms protocol cancellation with a terminal event and prevents run ID reuse', async () => {
    const input = runInput();
    const response = await staticFetch('/api/agui', post(input));
    const cancel = await staticFetch(`/api/agui/${input.runId}/cancel`, post({}));
    expect(cancel.status).toBe(202);
    const events: AGUIEvent[] = [];
    await consumeSse(response, (value) => events.push(EventSchemas.parse(value)));
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
    });
    expect((await staticFetch('/api/agui', post(input))).status).toBe(409);
    expect((await staticFetch(`/api/agui/${input.runId}/cancel`, post({}))).status).toBe(404);
  });

  it('aborts the local stream without inventing a cancellation event', async () => {
    const controller = new AbortController();
    const input = runInput();
    const response = await staticFetch('/api/agui', post(input, controller.signal));
    const events: AGUIEvent[] = [];
    const consuming = consumeSse(response, (value) => events.push(EventSchemas.parse(value)));
    controller.abort();
    await expect(consuming).rejects.toThrow();
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
    await expect(
      staticFetch('/api/chat', post({ prompt: '表单' }, controller.signal)),
    ).rejects.toThrow();
  });
});
