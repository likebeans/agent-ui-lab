import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { applyA2uiMessages, updateA2uiBinding, type A2uiSurface } from '../../shared/a2ui';
import { createInitialA2uiMessages } from '../../shared/a2ui-agent';
import {
  SurfaceRenderer,
  type SurfaceRendererProps,
} from '../../src/components/A2uiSurfaceRenderer';
import { SurfaceRenderer as LegacySurfaceRenderer } from '../../src/labs/A2uiLab';

function createSurface(): A2uiSurface {
  const surface = applyA2uiMessages(null, createInitialA2uiMessages());
  if (!surface) throw new Error('Fixture did not create a surface.');
  return surface;
}

function rendererProps(overrides: Partial<SurfaceRendererProps> = {}): SurfaceRendererProps {
  return {
    surface: createSurface(),
    disabled: false,
    submitting: false,
    onBindingChange: vi.fn(),
    onAction: vi.fn(),
    ...overrides,
  };
}

function render(overrides: Partial<SurfaceRendererProps> = {}): string {
  return renderToStaticMarkup(createElement(SurfaceRenderer, rendererProps(overrides)));
}

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))?.[1];
}

function fields(markup: string) {
  return [...markup.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gu)].map(([label]) => ({
    label,
    control: label.match(/<(?:input|select)\b[^>]*>/u)![0],
  }));
}

describe('reusable A2UI surface renderer', () => {
  it('keeps the original named export and generates distinct control IDs across surfaces', () => {
    expect(LegacySurfaceRenderer).toBe(SurfaceRenderer);
    const props = rendererProps();
    const markup = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(SurfaceRenderer, props),
        createElement(SurfaceRenderer, props),
      ),
    );
    const renderedFields = fields(markup);
    expect(renderedFields).toHaveLength(6);
    const ids = renderedFields.map(({ control }) => attribute(control, 'id'));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { label, control } of renderedFields) {
      expect(attribute(label, 'for')).toBe(attribute(control, 'id'));
      expect(attribute(control, 'aria-invalid')).toBeUndefined();
      expect(attribute(control, 'aria-describedby')).toBeUndefined();
    }
    expect(markup).toContain('data-a2ui-component-id="traveler"');
    expect(markup).toContain('data-a2ui-component-id="submit-label"');
    expect(markup).not.toContain('aria-current=');
    expect(props.onBindingChange).not.toHaveBeenCalled();
    expect(props.onAction).not.toHaveBeenCalled();
  });

  it('connects only matching field errors without including them in the label', () => {
    const fieldIssues: SurfaceRendererProps['fieldIssues'] = [
      { componentId: 'traveler', path: '/form/traveler', message: '请输入姓名', layer: 'client' },
      {
        componentId: 'traveler',
        path: '/form/traveler',
        message: '姓名未通过校验',
        layer: 'server',
      },
      {
        componentId: 'destination',
        path: '/form/destination',
        message: '请选择目的地',
        layer: 'server',
      },
      {
        componentId: 'traveler',
        path: '/old/traveler',
        message: '旧绑定路径错误',
        layer: 'server',
      },
      { componentId: 'other', path: '/form/traveler', message: '其他组件错误', layer: 'client' },
    ];
    const markup = render({ fieldIssues, idPrefix: 'w3-form', selectedComponentId: 'traveler' });
    const renderedFields = fields(markup);
    for (const { label, control } of renderedFields) {
      const isDays = label.includes('行程天数');
      expect(attribute(control, 'id')).toMatch(/^w3-form-/u);
      expect(attribute(control, 'aria-invalid')).toBe(isDays ? undefined : 'true');
      const errorId = attribute(control, 'aria-describedby');
      if (isDays) {
        expect(errorId).toBeUndefined();
      } else {
        expect(errorId).toBeTruthy();
        expect(markup.indexOf(`id="${errorId}"`)).toBeGreaterThan(
          markup.indexOf(label) + label.length,
        );
      }
      for (const issue of fieldIssues) expect(label).not.toContain(issue.message);
    }
    expect(markup).toContain('<span>出行人姓名</span>');
    expect(markup).toContain('data-a2ui-component-id="traveler" aria-current="true"');
    expect(markup).toContain('data-a2ui-error-layer="client">请输入姓名</p>');
    expect(markup).toContain('data-a2ui-error-layer="server">姓名未通过校验</p>');
    expect(markup).toContain('请选择目的地');
    expect(markup).not.toContain('旧绑定路径错误');
    expect(markup).not.toContain('其他组件错误');

    const cleared = render({ idPrefix: 'w3-form' });
    expect(cleared).not.toContain('aria-invalid=');
    expect(cleared).not.toContain('aria-describedby=');
    expect(fields(cleared).map(({ control }) => attribute(control, 'id'))).toEqual(
      renderedFields.map(({ control }) => attribute(control, 'id')),
    );
  });

  it('keeps IDs and error descriptions distinct when a field is referenced in two branches', () => {
    const surface = createSurface();
    surface.components.root = { id: 'root', component: 'Column', children: ['left', 'right'] };
    surface.components.left = { id: 'left', component: 'Column', children: ['traveler'] };
    surface.components.right = { id: 'right', component: 'Column', children: ['traveler'] };
    const markup = render({
      surface,
      idPrefix: 'shared-prefix',
      fieldIssues: [
        { componentId: 'traveler', path: '/form/traveler', message: '请输入姓名', layer: 'client' },
      ],
    });
    const renderedFields = fields(markup);
    expect(renderedFields).toHaveLength(2);
    expect(new Set(renderedFields.map(({ control }) => attribute(control, 'id'))).size).toBe(2);
    expect(
      new Set(renderedFields.map(({ control }) => attribute(control, 'aria-describedby'))).size,
    ).toBe(2);
  });

  it('renders controlled model changes, contextual budget fields, and busy action labels', () => {
    const initial = applyA2uiMessages(
      null,
      createInitialA2uiMessages({
        id: 'turn-renderer-budget',
        threadId: 'thread-renderer',
        prompt: '增加同行人数和预算',
        protocol: 'a2ui',
        context: { city: '成都', days: 3 },
        history: [],
      }),
    )!;
    const surface = updateA2uiBinding(initial, '/form/budget', '4200');
    const props = rendererProps({ surface });
    const markup = render(props);
    expect(fields(markup)).toHaveLength(5);
    expect(markup).toContain('<span>预算（元）</span>');
    expect(markup).toContain('value="4200"');
    expect(markup).toContain('<option value="chengdu" selected="">成都</option>');
    expect(markup).toContain('data-a2ui-component-id="submit-label">生成计划</span>');
    expect(initial.model.form).toMatchObject({ budget: '3000' });

    const busy = render({ ...props, disabled: true, submitting: true });
    for (const { control } of fields(busy)) expect(control).toContain('disabled=""');
    expect(busy).toMatch(/<button\b[^>]*disabled=""/u);
    expect(busy).toContain('正在生成…');
    expect(busy).not.toContain('>生成计划<');
    expect(busy).toMatch(/<svg\b[^>]*class="[^"]*\bspinner\b[^"]*"[^>]*aria-hidden="true"/u);
    expect(props.onBindingChange).not.toHaveBeenCalled();
    expect(props.onAction).not.toHaveBeenCalled();
  });

  it('retains missing-reference, cycle, depth, and button-child guards', () => {
    const missing = createSurface();
    missing.components.root = { id: 'root', component: 'Card', child: 'missing' };
    expect(() => render({ surface: missing })).toThrow('渲染时找不到组件：missing');

    const cyclic = createSurface();
    cyclic.components.root = { id: 'root', component: 'Card', child: 'root' };
    expect(() => render({ surface: cyclic })).toThrow('渲染时检测到循环或过深引用：root');

    const deep = createSurface();
    deep.components.root = { id: 'root', component: 'Card', child: 'nested-1' };
    for (let depth = 1; depth < 64; depth++) {
      deep.components[`nested-${depth}`] = {
        id: `nested-${depth}`,
        component: 'Card',
        child: `nested-${depth + 1}`,
      };
    }
    deep.components['nested-64'] = { id: 'nested-64', component: 'Text', text: 'Depth 64' };
    expect(render({ surface: deep })).toContain('Depth 64');
    deep.components['nested-64'] = { id: 'nested-64', component: 'Card', child: 'nested-65' };
    deep.components['nested-65'] = { id: 'nested-65', component: 'Text', text: 'Too deep' };
    expect(() => render({ surface: deep })).toThrow('渲染时检测到循环或过深引用：nested-65');

    const invalidButton = createSurface();
    const button = invalidButton.components.submit;
    if (button.component !== 'Button') throw new Error('Fixture is missing its button.');
    button.child = 'traveler';
    expect(() => render({ surface: invalidButton })).toThrow('Button submit 的 child 不是 Text');
  });

  it('retains binding type checks and escapes text and field errors', () => {
    const surface = createSurface();
    surface.model.form = { destination: ['hangzhou'], traveler: 42, days: '2' };
    expect(() => render({ surface })).toThrow('traveler 的绑定值类型不正确');
    surface.model.form = { destination: 'hangzhou', traveler: '', days: '2' };
    expect(() => render({ surface })).toThrow('destination 的绑定值类型不正确');

    const escaped = createSurface();
    escaped.components.title = {
      id: 'title',
      component: 'Text',
      text: '<script>alert(1)</script>',
    };
    const markup = render({
      surface: escaped,
      fieldIssues: [
        {
          componentId: 'traveler',
          path: '/form/traveler',
          message: '<img src=x>',
          layer: 'server',
        },
      ],
    });
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).toContain('&lt;img src=x&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img');
  });
});
