import { z } from 'zod';
import {
  pointerSegments,
  readPointer,
  writePointer,
  type JsonObject,
  type JsonValue,
} from './json-pointer';

export const A2UI_VERSION = 'v0.9.1' as const;
export const A2UI_BASIC_CATALOG_ID =
  'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json' as const;
export const A2UI_ROOT_ID = 'root' as const;

const safeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value), '名称不安全。');
const componentIdSchema = safeNameSchema;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

function isProtocolPointer(value: string): boolean {
  if (!value.startsWith('/')) return false;
  try {
    pointerSegments(value === '/' ? '' : value);
    return true;
  } catch {
    return false;
  }
}

const protocolPointerSchema = z
  .string()
  .refine(isProtocolPointer, '绑定路径必须是合法的绝对 JSON Pointer。');

export const a2uiPathReferenceSchema = z.object({ path: protocolPointerSchema }).strict();
export type A2uiPathReference = z.infer<typeof a2uiPathReferenceSchema>;

const cardSchema = z
  .object({
    id: componentIdSchema,
    component: z.literal('Card'),
    child: componentIdSchema,
  })
  .strict();

const columnSchema = z
  .object({
    id: componentIdSchema,
    component: z.literal('Column'),
    children: z.array(componentIdSchema).max(100),
  })
  .strict();

const textSchema = z
  .object({
    id: componentIdSchema,
    component: z.literal('Text'),
    text: z.union([z.string(), a2uiPathReferenceSchema]),
    variant: z.enum(['h1', 'h2', 'caption']).optional(),
  })
  .strict();

const textFieldSchema = z
  .object({
    id: componentIdSchema,
    component: z.literal('TextField'),
    label: z.string().min(1).max(120),
    value: a2uiPathReferenceSchema,
  })
  .strict();

const choiceOptionSchema = z
  .object({
    label: z.string().min(1).max(120),
    value: z.string().min(1).max(120),
  })
  .strict();

const choicePickerSchema = z
  .object({
    id: componentIdSchema,
    component: z.literal('ChoicePicker'),
    label: z.string().min(1).max(120),
    variant: z.literal('mutuallyExclusive'),
    options: z.array(choiceOptionSchema).min(1).max(30),
    value: a2uiPathReferenceSchema,
  })
  .strict();

const buttonSchema = z
  .object({
    id: componentIdSchema,
    component: z.literal('Button'),
    child: componentIdSchema,
    action: z
      .object({
        event: z
          .object({
            name: safeNameSchema,
            context: z.record(safeNameSchema, a2uiPathReferenceSchema),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const a2uiComponentSchema = z.discriminatedUnion('component', [
  cardSchema,
  columnSchema,
  textSchema,
  textFieldSchema,
  choicePickerSchema,
  buttonSchema,
]);
export type A2uiComponent = z.infer<typeof a2uiComponentSchema>;
export type A2uiTextComponent = z.infer<typeof textSchema>;

const createSurfaceMessageSchema = z
  .object({
    version: z.literal(A2UI_VERSION),
    createSurface: z
      .object({
        surfaceId: componentIdSchema,
        catalogId: z.literal(A2UI_BASIC_CATALOG_ID),
      })
      .strict(),
  })
  .strict();

const updateDataModelMessageSchema = z
  .object({
    version: z.literal(A2UI_VERSION),
    updateDataModel: z
      .object({
        surfaceId: componentIdSchema,
        path: protocolPointerSchema,
        value: jsonValueSchema,
      })
      .strict(),
  })
  .strict();

const updateComponentsMessageSchema = z
  .object({
    version: z.literal(A2UI_VERSION),
    updateComponents: z
      .object({
        surfaceId: componentIdSchema,
        components: z.array(a2uiComponentSchema).max(200),
      })
      .strict(),
  })
  .strict();

const deleteSurfaceMessageSchema = z
  .object({
    version: z.literal(A2UI_VERSION),
    deleteSurface: z.object({ surfaceId: componentIdSchema }).strict(),
  })
  .strict();

export const a2uiMessageSchema = z.union([
  createSurfaceMessageSchema,
  updateDataModelMessageSchema,
  updateComponentsMessageSchema,
  deleteSurfaceMessageSchema,
]);
export const a2uiMessagesSchema = z.array(a2uiMessageSchema).max(100);
export const a2uiResponseSchema = z
  .object({
    messages: a2uiMessagesSchema,
    agent: z.literal('deterministic-fixture').optional(),
  })
  .strict();
export type A2uiMessage = z.infer<typeof a2uiMessageSchema>;

export const a2uiClientActionSchema = z
  .object({
    version: z.literal(A2UI_VERSION),
    action: z
      .object({
        name: safeNameSchema,
        surfaceId: componentIdSchema,
        sourceComponentId: componentIdSchema,
        timestamp: z.string().datetime({ offset: true }),
        context: z.record(safeNameSchema, jsonValueSchema),
      })
      .strict(),
  })
  .strict();
export type A2uiClientAction = z.infer<typeof a2uiClientActionSchema>;

export interface A2uiSurface {
  surfaceId: string;
  catalogId: typeof A2UI_BASIC_CATALOG_ID;
  model: JsonObject;
  components: Record<string, A2uiComponent>;
}

export function normalizeA2uiPath(path: string): string {
  if (!isProtocolPointer(path)) throw new Error(`A2UI 路径不合法：${path}`);
  return path === '/' ? '' : path;
}

function childIds(component: A2uiComponent): string[] {
  if (component.component === 'Card' || component.component === 'Button') return [component.child];
  if (component.component === 'Column') return component.children;
  return [];
}

export function validateA2uiComponentGraph(components: Record<string, A2uiComponent>): void {
  if (!Object.hasOwn(components, A2UI_ROOT_ID))
    throw new Error('A2UI 组件树缺少 id 为 root 的根组件。');
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(id: string, depth: number): void {
    if (depth > 64) throw new Error('A2UI 组件树超过 64 层，已停止解析。');
    if (!Object.hasOwn(components, id)) throw new Error(`A2UI 组件引用不存在：${id}`);
    const component = components[id];
    if (visiting.has(id)) throw new Error(`A2UI 组件存在循环引用：${id}`);
    if (visited.has(id)) return;
    if (
      component.component === 'Column' &&
      new Set(component.children).size !== component.children.length
    ) {
      throw new Error(`Column ${component.id} 包含重复子组件引用。`);
    }
    visiting.add(id);
    for (const childId of childIds(component)) visit(childId, depth + 1);
    if (
      component.component === 'Button' &&
      (!Object.hasOwn(components, component.child) ||
        components[component.child].component !== 'Text')
    ) {
      throw new Error(`Button ${component.id} 的 child 必须引用 Text 组件。`);
    }
    visiting.delete(id);
    visited.add(id);
  }

  visit(A2UI_ROOT_ID, 0);
  for (const id of Object.keys(components)) visit(id, 0);
}

function boundValue(model: JsonObject, reference: A2uiPathReference, owner: string): JsonValue {
  const value = readPointer(model, normalizeA2uiPath(reference.path));
  if (value === undefined) throw new Error(`${owner} 的绑定路径不存在：${reference.path}`);
  return value;
}

export function validateA2uiBindings(surface: A2uiSurface): void {
  for (const component of Object.values(surface.components)) {
    if (component.component === 'Text' && typeof component.text !== 'string') {
      const value = boundValue(surface.model, component.text, component.id);
      if (value !== null && typeof value === 'object')
        throw new Error(`Text ${component.id} 只能绑定标量值。`);
    }
    if (component.component === 'TextField') {
      if (typeof boundValue(surface.model, component.value, component.id) !== 'string') {
        throw new Error(`TextField ${component.id} 必须绑定字符串。`);
      }
    }
    if (component.component === 'ChoicePicker') {
      const value = boundValue(surface.model, component.value, component.id);
      if (
        !Array.isArray(value) ||
        value.length > 1 ||
        !value.every((item) => typeof item === 'string')
      ) {
        throw new Error(`ChoicePicker ${component.id} 必须绑定至多一个值的字符串数组。`);
      }
    }
    if (component.component === 'Button') {
      for (const reference of Object.values(component.action.event.context)) {
        boundValue(surface.model, reference, component.id);
      }
    }
  }
}

export function applyA2uiMessage(current: A2uiSurface | null, input: unknown): A2uiSurface | null {
  const message = a2uiMessageSchema.parse(input);
  if ('createSurface' in message) {
    if (current) throw new Error(`Surface 已存在，不能重复 createSurface：${current.surfaceId}`);
    return {
      surfaceId: message.createSurface.surfaceId,
      catalogId: message.createSurface.catalogId,
      model: {},
      components: {},
    };
  }
  if (!current) throw new Error('收到更新消息前必须先 createSurface。');

  const surfaceId =
    'updateDataModel' in message
      ? message.updateDataModel.surfaceId
      : 'updateComponents' in message
        ? message.updateComponents.surfaceId
        : message.deleteSurface.surfaceId;
  if (surfaceId !== current.surfaceId) throw new Error(`消息属于未知 Surface：${surfaceId}`);
  if ('deleteSurface' in message) return null;

  if ('updateDataModel' in message) {
    const model = writePointer(
      current.model,
      normalizeA2uiPath(message.updateDataModel.path),
      message.updateDataModel.value,
    );
    const next = { ...current, model };
    if (Object.keys(next.components).length > 0) validateA2uiBindings(next);
    return next;
  }

  const replacements = new Map<string, A2uiComponent>();
  for (const component of message.updateComponents.components) {
    if (replacements.has(component.id))
      throw new Error(`同一更新中出现重复组件 ID：${component.id}`);
    replacements.set(component.id, structuredClone(component));
  }
  const components = { ...current.components };
  for (const [id, component] of replacements) components[id] = component;
  validateA2uiComponentGraph(components);
  const next = { ...current, components };
  validateA2uiBindings(next);
  return next;
}

export function applyA2uiMessages(
  initial: A2uiSurface | null,
  inputs: readonly unknown[],
): A2uiSurface | null {
  return inputs.reduce<A2uiSurface | null>(
    (surface, message) => applyA2uiMessage(surface, message),
    initial,
  );
}

export function updateA2uiBinding(
  surface: A2uiSurface,
  path: string,
  value: JsonValue,
): A2uiSurface {
  const next = { ...surface, model: writePointer(surface.model, normalizeA2uiPath(path), value) };
  validateA2uiBindings(next);
  return next;
}

export function resolveA2uiText(surface: A2uiSurface, component: A2uiTextComponent): string {
  if (typeof component.text === 'string') return component.text;
  const value = boundValue(surface.model, component.text, component.id);
  return value === null ? '' : String(value);
}

export function resolveA2uiAction(
  surface: A2uiSurface,
  sourceComponentId: string,
  timestamp = new Date().toISOString(),
): A2uiClientAction {
  const component = Object.hasOwn(surface.components, sourceComponentId)
    ? surface.components[sourceComponentId]
    : undefined;
  if (!component || component.component !== 'Button') {
    throw new Error(`动作来源不是受支持的 Button：${sourceComponentId}`);
  }
  const context: Record<string, JsonValue> = {};
  for (const [key, reference] of Object.entries(component.action.event.context)) {
    context[key] = structuredClone(boundValue(surface.model, reference, component.id));
  }
  return a2uiClientActionSchema.parse({
    version: A2UI_VERSION,
    action: {
      name: component.action.event.name,
      surfaceId: surface.surfaceId,
      sourceComponentId,
      timestamp,
      context,
    },
  });
}
