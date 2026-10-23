import { describe, expect, it } from 'vitest';
import { routeChat } from '../server/chat';

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
});
