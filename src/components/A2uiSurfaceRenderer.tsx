import { useId, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import {
  A2UI_ROOT_ID,
  normalizeA2uiPath,
  resolveA2uiText,
  type A2uiComponent,
  type A2uiSurface,
} from '../../shared/a2ui';
import { readPointer, type JsonValue } from '../../shared/json-pointer';
import styles from './A2uiSurfaceRenderer.module.css';

export interface A2uiFieldIssue {
  componentId: string;
  path: string;
  message: string;
  layer: 'client' | 'server';
}

export interface SurfaceRendererProps {
  surface: A2uiSurface;
  disabled: boolean;
  submitting: boolean;
  selectedComponentId?: string | null;
  fieldIssues?: readonly A2uiFieldIssue[];
  /** Prefixes each control's React-generated ID; locate fields by data-a2ui-component-id. */
  idPrefix?: string;
  onBindingChange: (path: string, value: JsonValue) => void;
  onAction: (sourceComponentId: string) => void;
}

type FieldComponent = Extract<A2uiComponent, { component: 'TextField' | 'ChoicePicker' }>;

function selectionProps(id: string, selectedComponentId?: string | null) {
  return {
    'data-a2ui-component-id': id,
    'aria-current': selectedComponentId === id ? ('true' as const) : undefined,
  };
}

function SurfaceField({
  surface,
  component,
  disabled,
  selectedComponentId,
  fieldIssues,
  idPrefix,
  onBindingChange,
}: Pick<
  SurfaceRendererProps,
  'surface' | 'disabled' | 'selectedComponentId' | 'fieldIssues' | 'idPrefix' | 'onBindingChange'
> & { component: FieldComponent }) {
  const generatedId = useId();
  const controlId = `${idPrefix ?? 'a2ui'}-${generatedId}-${encodeURIComponent(component.id)}`;
  const issues = fieldIssues?.filter(
    (issue) => issue.componentId === component.id && issue.path === component.value.path,
  );
  const hasIssues = Boolean(issues?.length);
  const errorId = `${controlId}-errors`;
  const controlProps = {
    id: controlId,
    disabled,
    'aria-invalid': hasIssues || undefined,
    'aria-describedby': hasIssues ? errorId : undefined,
  };

  return (
    <div
      className={`${styles.component} ${styles.field}`}
      {...selectionProps(component.id, selectedComponentId)}
    >
      <label className="a2ui-field" htmlFor={controlId}>
        <span>{component.label}</span>
        {component.component === 'TextField' ? (
          <input
            {...controlProps}
            type="text"
            value={bindingValue(surface, component, 'string')}
            autoComplete={component.id === 'traveler' ? 'name' : 'off'}
            onChange={(event) => onBindingChange(component.value.path, event.target.value)}
          />
        ) : (
          <select
            {...controlProps}
            value={bindingValue(surface, component, 'string-array')[0] ?? ''}
            onChange={(event) => onBindingChange(component.value.path, [event.target.value])}
          >
            {component.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </label>
      {hasIssues ? (
        <div className={styles.errors} id={errorId} aria-live="polite">
          {issues?.map((issue, index) => (
            <p key={`${issue.layer}-${index}`} data-a2ui-error-layer={issue.layer}>
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SurfaceRenderer({
  surface,
  disabled,
  submitting,
  selectedComponentId,
  fieldIssues,
  idPrefix,
  onBindingChange,
  onAction,
}: SurfaceRendererProps) {
  function renderComponent(id: string, ancestors: ReadonlySet<string>): ReactNode {
    if (ancestors.has(id) || ancestors.size > 64)
      throw new Error(`渲染时检测到循环或过深引用：${id}`);
    if (!Object.hasOwn(surface.components, id)) throw new Error(`渲染时找不到组件：${id}`);
    const component = surface.components[id];
    const nextAncestors = new Set(ancestors).add(id);

    switch (component.component) {
      case 'Card':
        return (
          <div
            className={`a2ui-card ${styles.component}`}
            key={id}
            {...selectionProps(id, selectedComponentId)}
          >
            {renderComponent(component.child, nextAncestors)}
          </div>
        );
      case 'Column':
        return (
          <div
            className={`a2ui-column ${styles.component}`}
            key={id}
            {...selectionProps(id, selectedComponentId)}
          >
            {component.children.map((child) => renderComponent(child, nextAncestors))}
          </div>
        );
      case 'Text':
        return (
          <div
            className={`a2ui-text ${component.variant ?? ''} ${styles.component}`}
            key={id}
            aria-live={component.id === 'status' ? 'polite' : undefined}
            {...selectionProps(id, selectedComponentId)}
          >
            {resolveA2uiText(surface, component)}
          </div>
        );
      case 'TextField':
      case 'ChoicePicker':
        return (
          <SurfaceField
            key={id}
            surface={surface}
            component={component}
            disabled={disabled}
            selectedComponentId={selectedComponentId}
            fieldIssues={fieldIssues}
            idPrefix={idPrefix}
            onBindingChange={onBindingChange}
          />
        );
      case 'Button': {
        const label = Object.hasOwn(surface.components, component.child)
          ? surface.components[component.child]
          : undefined;
        if (!label || label.component !== 'Text')
          throw new Error(`Button ${component.id} 的 child 不是 Text。`);
        return (
          <button
            className={`button primary ${styles.component}`}
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onAction(component.id)}
            {...selectionProps(id, selectedComponentId)}
          >
            {submitting ? <LoaderCircle className="spinner" size={15} aria-hidden="true" /> : null}
            {submitting ? (
              '正在生成…'
            ) : (
              <span className={styles.component} {...selectionProps(label.id, selectedComponentId)}>
                {resolveA2uiText(surface, label)}
              </span>
            )}
          </button>
        );
      }
      default:
        return assertNever(component);
    }
  }

  return renderComponent(A2UI_ROOT_ID, new Set());
}

function bindingValue(
  surface: A2uiSurface,
  component: FieldComponent,
  expected: 'string' | 'string-array',
): string | string[] {
  const value = readPointer(surface.model, normalizeA2uiPath(component.value.path));
  if (expected === 'string' && typeof value === 'string') return value;
  if (
    expected === 'string-array' &&
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string')
  )
    return value;
  throw new Error(`${component.id} 的绑定值类型不正确。`);
}

function assertNever(value: never): never {
  throw new Error(`Renderer 不支持组件：${JSON.stringify(value)}`);
}
