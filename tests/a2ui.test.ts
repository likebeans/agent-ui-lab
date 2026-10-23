import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_VERSION,
  applyA2uiMessage,
  applyA2uiMessages,
  resolveA2uiAction,
  updateA2uiBinding,
} from '../shared/a2ui';
import {
  A2UI_SURFACE_ID,
  createA2uiActionMessages,
  createDeleteA2uiMessage,
  createInitialA2uiMessages,
  installA2uiRoutes,
} from '../server/a2ui';

describe('A2UI v0.9.1 runtime', () => {
  it('creates, initializes and renders a surface in protocol order', () => {
    const messages = createInitialA2uiMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({
      version: A2UI_VERSION,
      createSurface: {
        surfaceId: A2UI_SURFACE_ID,
        catalogId: A2UI_BASIC_CATALOG_ID,
      },
    });
    expect(messages[1]).toHaveProperty('updateDataModel.path', '/');
    expect(messages[2]).toHaveProperty('updateComponents.components');

    const surface = applyA2uiMessages(null, messages);
    expect(surface?.components.root).toEqual({ id: 'root', component: 'Card', child: 'form' });
    expect(surface?.model.form).toEqual({ destination: ['hangzhou'], traveler: '', days: '2' });
    expect(() => applyA2uiMessage(surface, messages[0])).toThrow('不能重复 createSurface');
  });

  it('derives a chat surface from validated prompt and context', () => {
    const messages = createInitialA2uiMessages({
      id: 'turn-shanghai',
      threadId: 'thread-trip',
      prompt: '生成一个上海四日游需求表单',
      protocol: 'a2ui',
      context: { city: '上海', days: 4 },
      history: [{ id: 'earlier', role: 'user', content: '我们接着规划行程' }],
    });
    const surface = applyA2uiMessages(null, messages);

    expect(surface?.model.form).toEqual({
      destination: ['shanghai'],
      traveler: '',
      days: '4',
    });
    expect(surface?.components.title).toEqual({
      id: 'title',
      component: 'Text',
      text: '生成一个上海四日游需求表单',
      variant: 'h1',
    });
    expect(surface?.components.destination).toMatchObject({
      component: 'ChoicePicker',
      options: [
        { label: '杭州', value: 'hangzhou' },
        { label: '成都', value: 'chengdu' },
        { label: '上海', value: 'shanghai' },
      ],
    });

    if (!surface) return;
    const action = resolveA2uiAction(
      updateA2uiBinding(surface, '/form/traveler', '小周'),
      'submit',
      '2026-10-22T03:00:00.000Z',
    );
    const updated = applyA2uiMessages(surface, createA2uiActionMessages(action));
    expect(updated?.model.result).toEqual({
      status: '已为 小周 生成 上海 4 天游览计划（演示数据，未预订）。',
    });
  });

  it('adds contextual party-size and budget fields with valid defaults', () => {
    const messages = createInitialA2uiMessages({
      id: 'turn-contextual-fields',
      threadId: 'thread-trip',
      prompt: '为多人同行生成表单，并包含同行人数和预算',
      protocol: 'a2ui',
      context: { city: '成都', days: 3 },
      history: [],
    });
    const surface = applyA2uiMessages(null, messages);
    expect(surface).not.toBeNull();
    if (!surface) return;

    expect(surface.model.form).toEqual({
      destination: ['chengdu'],
      traveler: '',
      days: '3',
      partySize: '2',
      budget: '3000',
    });
    expect(surface.components.partySize).toEqual({
      id: 'partySize',
      component: 'TextField',
      label: '同行人数',
      value: { path: '/form/partySize' },
    });
    expect(surface.components.budget).toEqual({
      id: 'budget',
      component: 'TextField',
      label: '预算（元）',
      value: { path: '/form/budget' },
    });
    expect(surface.components.form).toMatchObject({
      component: 'Column',
      children: expect.arrayContaining(['partySize', 'budget', 'submit']),
    });
    expect(surface.components.submit).toMatchObject({
      component: 'Button',
      action: {
        event: {
          context: {
            partySize: { path: '/form/partySize' },
            budget: { path: '/form/budget' },
          },
        },
      },
    });

    const named = updateA2uiBinding(surface, '/form/traveler', '小周');
    const action = resolveA2uiAction(named, 'submit', '2026-10-22T03:00:00.000Z');
    expect(action.action.context).toMatchObject({ partySize: '2', budget: '3000' });
    const updated = applyA2uiMessages(named, createA2uiActionMessages(action));
    expect(updated?.model.result).toEqual({
      status: '已为 小周 生成 成都 3 天游览计划，同行人数 2 人，预算 3000 元（演示数据，未预订）。',
    });
  });

  it('chooses each contextual field independently from the prompt', () => {
    const request = {
      id: 'turn-one-field',
      threadId: 'thread-trip',
      protocol: 'a2ui' as const,
      context: { city: '杭州' as const, days: 2 },
      history: [],
    };
    const partySurface = applyA2uiMessages(
      null,
      createInitialA2uiMessages({ ...request, prompt: '这是多人出行' }),
    );
    const budgetSurface = applyA2uiMessages(
      null,
      createInitialA2uiMessages({ ...request, id: 'turn-budget', prompt: '增加预算输入' }),
    );

    expect(partySurface?.components).toHaveProperty('partySize');
    expect(partySurface?.components).not.toHaveProperty('budget');
    expect(budgetSurface?.components).toHaveProperty('budget');
    expect(budgetSurface?.components).not.toHaveProperty('partySize');
  });

  it('keeps local bindings immutable and resolves action context values', () => {
    const initial = applyA2uiMessages(null, createInitialA2uiMessages());
    expect(initial).not.toBeNull();
    if (!initial) return;

    const withDestination = updateA2uiBinding(initial, '/form/destination', ['chengdu']);
    const edited = updateA2uiBinding(withDestination, '/form/days', '3');
    const named = updateA2uiBinding(edited, '/form/traveler', '小林');
    expect(initial.model.form).toEqual({ destination: ['hangzhou'], traveler: '', days: '2' });
    expect(named.model.form).toEqual({ destination: ['chengdu'], traveler: '小林', days: '3' });

    const action = resolveA2uiAction(named, 'submit', '2026-10-22T03:00:00.000Z');
    expect(action).toEqual({
      version: A2UI_VERSION,
      action: {
        name: 'save_trip',
        surfaceId: A2UI_SURFACE_ID,
        sourceComponentId: 'submit',
        timestamp: '2026-10-22T03:00:00.000Z',
        context: { destination: ['chengdu'], traveler: '小林', days: '3' },
      },
    });
  });

  it('applies server updates as full component replacements, then deletes the surface', () => {
    const initial = applyA2uiMessages(null, createInitialA2uiMessages());
    expect(initial).not.toBeNull();
    if (!initial) return;

    const action = resolveA2uiAction(
      updateA2uiBinding(
        updateA2uiBinding(
          updateA2uiBinding(initial, '/form/destination', ['xiamen']),
          '/form/traveler',
          '学习者',
        ),
        '/form/days',
        '4',
      ),
      'submit',
      '2026-10-22T03:00:00.000Z',
    );
    const updates = createA2uiActionMessages(action);
    const updated = applyA2uiMessages(initial, updates);
    expect(updated?.model.result).toEqual({
      status: '已为 学习者 生成 厦门 4 天游览计划（演示数据，未预订）。',
    });
    expect(updated?.components['submit-label']).toEqual({
      id: 'submit-label',
      component: 'Text',
      text: '重新生成计划',
    });
    expect(updated?.components['submit-label']).not.toHaveProperty('variant');

    expect(applyA2uiMessage(updated, createDeleteA2uiMessage(A2UI_SURFACE_ID))).toBeNull();
  });

  it('rejects unknown component types, missing references and cycles', () => {
    const initial = applyA2uiMessages(null, createInitialA2uiMessages());
    expect(initial).not.toBeNull();

    expect(() =>
      applyA2uiMessage(initial, {
        version: A2UI_VERSION,
        updateComponents: {
          surfaceId: A2UI_SURFACE_ID,
          components: [{ id: 'unsafe', component: 'Html', html: '<script />' }],
        },
      }),
    ).toThrow();

    expect(() =>
      applyA2uiMessage(initial, {
        version: A2UI_VERSION,
        updateComponents: {
          surfaceId: A2UI_SURFACE_ID,
          components: [{ id: 'root', component: 'Card', child: 'missing' }],
        },
      }),
    ).toThrow('引用不存在');

    expect(() =>
      applyA2uiMessage(initial, {
        version: A2UI_VERSION,
        updateComponents: {
          surfaceId: A2UI_SURFACE_ID,
          components: [{ id: 'root', component: 'Card', child: 'root' }],
        },
      }),
    ).toThrow('循环引用');
  });

  it('rejects legacy userAction payloads at the HTTP boundary', async () => {
    const app = express();
    app.use(express.json());
    installA2uiRoutes(app);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/a2ui/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: A2UI_VERSION, userAction: { name: 'save_trip' } }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('校验失败'),
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
