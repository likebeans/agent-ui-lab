import type { Express } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installChatRoutes, routeChat } from '../server/chat';
import { staticFetch } from '../shared/static-api';

function localChat(body: unknown) {
  const post = vi.fn();
  installChatRoutes({ post } as unknown as Express);
  const [path, handler] = post.mock.calls[0];
  expect(path).toBe('/api/chat');
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  handler({ body }, response);
  expect(response.json).toHaveBeenCalledOnce();
  return {
    status: response.status.mock.calls[0]?.[0] ?? 200,
    body: response.json.mock.calls[0][0],
  };
}

describe('conversation routing and shared trip context', () => {
  it('keeps trip context across changes of interface protocol', () => {
    const plan = routeChat({ prompt: '帮我规划成都两日游' });
    expect(plan).toMatchObject({ protocol: 'agui', context: { city: '成都', days: 2 } });
    const form = routeChat({ prompt: '把这些需求做成表单', context: plan.context });
    expect(form).toMatchObject({ protocol: 'a2ui', context: plan.context });
    const app = routeChat({ prompt: '打开这个城市的活动应用', context: form.context });
    expect(app).toMatchObject({ protocol: 'mcp', context: plan.context });
  });
  it('honors explicit protocol selection while updating context', () => {
    expect(
      routeChat({ prompt: '上海三天', mode: 'a2ui', context: { city: '杭州', days: 2 } }),
    ).toMatchObject({ protocol: 'a2ui', context: { city: '上海', days: 3 } });
    expect(() => routeChat({ prompt: '', mode: 'auto' })).toThrow();
    expect(() => routeChat({ prompt: 'test', context: { city: '杭州', days: 99 } })).toThrow();
  });

  it.each([
    ['1天', 1],
    ['2日', 2],
    ['3 天', 3],
    ['4 日', 4],
    ['5天', 5],
    ['6日', 6],
    ['7天', 7],
    ['一日', 1],
    ['二天', 2],
    ['两日', 2],
    ['三天', 3],
    ['四日', 4],
    ['五天', 5],
    ['六日', 6],
    ['七天', 7],
    ['３天', 3],
  ])('reads the complete duration %s', (duration, days) => {
    expect(routeChat({ prompt: `帮我规划成都${duration}游` }).context).toEqual({
      city: '成都',
      days,
    });
  });

  it.each([
    '12天',
    '十一日',
    '8天',
    '八日',
    '0天',
    '零日',
    '-2天',
    '负三日',
    '1.5天',
    '.5天',
    '两点五日',
    '１２天',
    '０天',
    '－２天',
    '１．５天',
    '− 2天',
    '半天',
    '两天半',
    '三至五天',
    '2–3天',
    '2或3天',
    '2/3天',
  ])('rejects %s without using a suffix or the previous duration', (duration) => {
    for (const mode of ['auto', 'agui', 'a2ui', 'mcp']) {
      expect(() =>
        routeChat({
          prompt: `生成上海${duration}的表单`,
          mode,
          context: { city: '成都', days: 6 },
        }),
      ).toThrow(/行程天数.*1–7.*整数/u);
    }
    try {
      routeChat({ prompt: `规划${duration}` });
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect((error as z.ZodError).issues[0]).toMatchObject({ path: ['prompt'] });
    }
  });

  it('only updates days from a quantity with a day unit', () => {
    const context = { city: '成都' as const, days: 6 };
    expect(routeChat({ prompt: '2人出行，预算3000元，生成上海表单', context }).context).toEqual({
      city: '上海',
      days: 6,
    });
    expect(routeChat({ prompt: '预算2000元，3人，规划杭州两天', context }).context).toEqual({
      city: '杭州',
      days: 2,
    });
    expect(routeChat({ prompt: '生成一个表单' }).context.days).toBe(3);
    expect(routeChat({ prompt: '2人、预算3000元、3天', context }).context.days).toBe(3);
    expect(routeChat({ prompt: '预算2.5万元，3人，行程三日', context }).context.days).toBe(3);
    expect(routeChat({ prompt: '预算3000元。3天', context }).context.days).toBe(3);
  });

  it('accepts repeated equivalent durations and asks for one duration when they disagree', () => {
    expect(routeChat({ prompt: '成都2天，也就是两日游，2人预算3000元' }).context.days).toBe(2);
    for (const prompt of ['成都2天或3天', '原本三天，改成两日', '两天和七天的表单']) {
      expect(() => routeChat({ prompt })).toThrow(/多个不同.*天数.*只保留一个/u);
    }
    expect(() => routeChat({ prompt: '12天改成两天' })).toThrow(/行程天数.*1–7.*整数/u);
    expect(() => routeChat({ prompt: '三日游，再住十一日' })).toThrow(/行程天数.*1–7.*整数/u);
  });

  it.each([
    ['规划杭州12天', 400],
    ['生成成都十一日表单', 400],
    ['打开上海8天的活动应用', 400],
    ['规划零天', 400],
    ['规划-3天', 400],
    ['规划1.5天', 400],
    ['规划2天或3天', 400],
    ['2人预算3500元，生成成都两日游表单', 200],
    ['预算2000元，打开活动应用', 200],
  ])('uses the same local and Pages result for %s', async (prompt, status) => {
    const body = { prompt, context: { city: '上海', days: 5 } };
    const local = localChat(body);
    expect(local.status).toBe(status);
    const pages = await staticFetch('/api/chat', { method: 'POST', body: JSON.stringify(body) });
    expect(pages.status).toBe(local.status);
    expect(await pages.json()).toEqual(local.body);
    if (local.status === 400) expect(local.body.error).toMatch(/天数/u);
  });
});
