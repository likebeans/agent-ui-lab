import { z } from 'zod';
import {
  A2UI_VERSION,
  a2uiClientActionSchema,
  applyA2uiMessages,
  normalizeA2uiPath,
  type A2uiSurface,
} from '../../a2ui';
import {
  A2UI_SURFACE_ID,
  createA2uiActionMessages,
  createInitialA2uiMessages,
} from '../../a2ui-agent';
import { readPointer, writePointer } from '../../json-pointer';
import type {
  CompatibilityEngine,
  CompatibilityReply,
  CompatibilityScenario,
  CompatibilitySnapshot,
  FieldIssue,
  FieldRule,
} from './contract';
import { validateFields } from './draft';

const documentIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u,
    'documentId 必须是 1 到 64 位字母、数字、下划线或连字符。',
  )
  .refine(
    (id) => id.trim() === id && !['__proto__', 'constructor', 'prototype'].includes(id),
    'documentId 不安全。',
  );
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const createSchema = z
  .object({
    documentId: documentIdSchema,
    scenario: z.enum(['standard', 'unknown-catalog', 'unknown-component']),
  })
  .strict();
const changeSchema = z
  .object({
    expectedRevision: revisionSchema,
    change: z.enum(['extend-days', 'add-budget', 'replace-surface']),
  })
  .strict();
const actionSchema = z
  .object({ expectedRevision: revisionSchema, action: a2uiClientActionSchema })
  .strict();

interface Authority {
  documentId: string;
  scenario: CompatibilityScenario;
  revision: number;
  generation: number;
  acceptedActions: number;
  surface: A2uiSurface;
  rules: FieldRule[];
}

function initialRules(): FieldRule[] {
  return [
    { componentId: 'destination', path: '/form/destination', label: '目的地', required: true },
    {
      componentId: 'traveler',
      path: '/form/traveler',
      label: '出行人姓名',
      required: true,
      maxLength: 40,
    },
    {
      componentId: 'days',
      path: '/form/days',
      label: '行程天数',
      required: true,
      integer: { min: 1, max: 7 },
    },
  ];
}

function surfaceId(documentId: string, generation: number): string {
  return `compat-${documentId}-${generation}`;
}

function snapshot(document: Authority): CompatibilitySnapshot {
  const surface = document.surface;
  const components: unknown[] = structuredClone(Object.values(surface.components));
  if (document.scenario === 'unknown-component') {
    const index = components.findIndex((component) => (component as { id: string }).id === 'intro');
    components[index] = {
      id: 'intro',
      component: 'WeatherMap',
      location: { path: '/form/destination' },
    };
  }
  const traveler = readPointer(surface.model, '/form/traveler');
  const days = readPointer(surface.model, '/form/days');
  const budget = readPointer(surface.model, '/form/budget');
  const destination = surface.components.destination;
  const selected = readPointer(surface.model, '/form/destination');
  const destinationLabel =
    destination.component === 'ChoicePicker' && Array.isArray(selected)
      ? (destination.options.find((option) => option.value === selected[0])?.label ?? '未选择')
      : '未选择';
  return {
    documentId: document.documentId,
    revision: document.revision,
    surfaceId: surface.surfaceId,
    scenario: document.scenario,
    messages: [
      {
        version: A2UI_VERSION,
        createSurface: {
          surfaceId: surface.surfaceId,
          catalogId:
            document.scenario === 'unknown-catalog'
              ? 'https://example.invalid/a2ui/extended-catalog.json'
              : surface.catalogId,
        },
      },
      {
        version: A2UI_VERSION,
        updateDataModel: {
          surfaceId: surface.surfaceId,
          path: '/',
          value: structuredClone(surface.model),
        },
      },
      { version: A2UI_VERSION, updateComponents: { surfaceId: surface.surfaceId, components } },
    ],
    rules: structuredClone(document.rules),
    fallbackText: `行程文档 ${document.documentId}（版本 ${document.revision}）：${destinationLabel} ${String(days)} 天，出行人 ${traveler || '未填写'}${budget === undefined ? '' : `，预算 ${String(budget)} 元`}。${String(readPointer(surface.model, '/result/status'))}`,
    acceptedActions: document.acceptedActions,
  };
}

function invalid(message: string, issues: FieldIssue[] = []): CompatibilityReply {
  return { kind: 'invalid', message, issues };
}

function invalidInput(error: z.ZodError): CompatibilityReply {
  return invalid(`请求校验失败：${error.issues[0]?.message ?? '输入无效。'}`);
}

function conflict(
  document: Authority,
  code: 'revision-mismatch' | 'surface-mismatch' | 'document-exists',
): CompatibilityReply {
  const messages = {
    'revision-mismatch': '文档版本已变化，请合并最新快照后重试。',
    'surface-mismatch': '动作属于已替换或其他文档的 Surface。',
    'document-exists': '此 documentId 已存在，请读取已有文档。',
  };
  return { kind: 'conflict', code, message: messages[code], snapshot: snapshot(document) };
}

export function createCompatibilityEngine(): CompatibilityEngine {
  const documents = new Map<string, Authority>();

  function find(documentId: string): Authority | CompatibilityReply {
    const parsed = documentIdSchema.safeParse(documentId);
    if (!parsed.success) return invalidInput(parsed.error);
    return documents.get(parsed.data) ?? { kind: 'not-found', message: '文档不存在。' };
  }

  return {
    create(input) {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) return invalidInput(parsed.error);
      const existing = documents.get(parsed.data.documentId);
      if (existing) return conflict(existing, 'document-exists');
      const surface = applyA2uiMessages(null, createInitialA2uiMessages())!;
      surface.surfaceId = surfaceId(parsed.data.documentId, 1);
      const document: Authority = {
        ...parsed.data,
        revision: 1,
        generation: 1,
        acceptedActions: 0,
        surface,
        rules: initialRules(),
      };
      documents.set(document.documentId, document);
      return { kind: 'snapshot', snapshot: snapshot(document) };
    },

    read(documentId) {
      const document = find(documentId);
      if ('kind' in document) return document;
      return { kind: 'snapshot', snapshot: snapshot(document) };
    },

    change(documentId, input) {
      const document = find(documentId);
      if ('kind' in document) return document;
      const parsed = changeSchema.safeParse(input);
      if (!parsed.success) return invalidInput(parsed.error);
      if (parsed.data.expectedRevision !== document.revision) {
        return conflict(document, 'revision-mismatch');
      }
      const next = structuredClone(document);
      if (parsed.data.change === 'extend-days') {
        const days = Number(readPointer(next.surface.model, '/form/days'));
        next.surface.model = writePointer(
          next.surface.model,
          '/form/days',
          String(Math.min(7, days + 1)),
        );
      } else if (parsed.data.change === 'replace-surface') {
        next.generation += 1;
        next.surface.surfaceId = surfaceId(next.documentId, next.generation);
      } else if (!Object.hasOwn(next.surface.components, 'budget')) {
        next.surface.model = writePointer(next.surface.model, '/form/budget', '3000');
        next.surface.components.budget = {
          id: 'budget',
          component: 'TextField',
          label: '总预算（元）',
          value: { path: '/form/budget' },
        };
        const form = next.surface.components.form;
        const submit = next.surface.components.submit;
        if (form.component !== 'Column' || submit.component !== 'Button') {
          throw new Error('权威表单结构不完整。');
        }
        form.children.splice(form.children.indexOf('submit'), 0, 'budget');
        submit.action.event.context.budget = { path: '/form/budget' };
        next.rules.push({
          componentId: 'budget',
          path: '/form/budget',
          label: '总预算（元）',
          required: true,
          integer: { min: 1, max: 9_999_999 },
        });
      }
      next.revision += 1;
      documents.set(documentId, next);
      return { kind: 'snapshot', snapshot: snapshot(next) };
    },

    act(documentId, input) {
      const document = find(documentId);
      if ('kind' in document) return document;
      const parsed = actionSchema.safeParse(input);
      if (!parsed.success) return invalidInput(parsed.error);
      const { action } = parsed.data.action;
      if (action.surfaceId !== document.surface.surfaceId) {
        return conflict(document, 'surface-mismatch');
      }
      if (parsed.data.expectedRevision !== document.revision) {
        return conflict(document, 'revision-mismatch');
      }
      if (document.scenario !== 'standard') {
        return invalid('此快照需要纯文本回退，不能提交不兼容 Surface 的动作。');
      }
      const source = document.surface.components[action.sourceComponentId];
      if (!source || source.component !== 'Button' || source.action.event.name !== action.name) {
        return invalid('动作来源或名称不属于当前 Surface。');
      }
      const original = (input as { action: { action: typeof action } }).action.action;
      if (
        original.name !== action.name ||
        original.surfaceId !== action.surfaceId ||
        original.sourceComponentId !== action.sourceComponentId
      ) {
        return invalid('动作标识必须与当前 Surface 完全一致。');
      }
      const bindings = source.action.event.context;
      const keys = Object.keys(bindings);
      if (
        Object.keys(original.context).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(original.context, key))
      ) {
        return invalid('动作 context 必须恰好包含当前按钮声明的绑定字段。');
      }

      let surface = structuredClone(document.surface);
      for (const [key, reference] of Object.entries(bindings)) {
        surface.model = writePointer(
          surface.model,
          normalizeA2uiPath(reference.path),
          action.context[key],
        );
      }
      const issues = validateFields(surface, document.rules, 'server');
      if (issues.length > 0) return invalid('字段校验未通过。', issues);
      const budget = readPointer(surface.model, '/form/budget');
      const days = Number(readPointer(surface.model, '/form/days'));
      if (budget !== undefined && Number(budget) < days * 500) {
        return invalid('预算未满足服务端业务规则。', [
          {
            componentId: 'budget',
            path: '/form/budget',
            message: `总预算至少需要 ${days * 500} 元（每天 500 元）。`,
            layer: 'server',
          },
        ]);
      }
      // The legacy fixture produces the result text; only this engine owns identity,
      // revisions, full snapshots, and the canonical current action bindings.
      const updates = createA2uiActionMessages({
        ...parsed.data.action,
        action: { ...action, surfaceId: A2UI_SURFACE_ID },
      });
      surface = applyA2uiMessages(
        surface,
        updates.map((message) => {
          if ('updateDataModel' in message) {
            return {
              ...message,
              updateDataModel: { ...message.updateDataModel, surfaceId: surface.surfaceId },
            };
          }
          if ('updateComponents' in message) {
            return {
              ...message,
              updateComponents: { ...message.updateComponents, surfaceId: surface.surfaceId },
            };
          }
          throw new Error('动作返回了非预期的消息类型。');
        }),
      )!;
      const next: Authority = {
        ...document,
        surface,
        revision: document.revision + 1,
        acceptedActions: document.acceptedActions + 1,
      };
      documents.set(documentId, next);
      return { kind: 'accepted', snapshot: snapshot(next) };
    },
  };
}
