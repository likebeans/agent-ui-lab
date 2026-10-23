import { z } from 'zod';
import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_VERSION,
  a2uiClientActionSchema,
  a2uiMessagesSchema,
  type A2uiComponent,
  type A2uiMessage,
} from './a2ui';

export const A2UI_SURFACE_ID = 'trip-planner';

const initialModel = {
  form: {
    destination: ['hangzhou'],
    traveler: '',
    days: '2',
  },
  result: {
    status: '填写后提交，查看动作怎样闭环。',
  },
};

const initialComponents: A2uiComponent[] = [
  { id: 'root', component: 'Card', child: 'form' },
  {
    id: 'form',
    component: 'Column',
    children: ['title', 'intro', 'destination', 'traveler', 'days', 'submit', 'status'],
  },
  { id: 'title', component: 'Text', text: '生成一份周末行程计划', variant: 'h1' },
  {
    id: 'intro',
    component: 'Text',
    text: '这是 fixture 数据；确定性 Agent 只生成建议，不会真实预订。',
    variant: 'caption',
  },
  {
    id: 'destination',
    component: 'ChoicePicker',
    label: '目的地',
    variant: 'mutuallyExclusive',
    options: [
      { label: '杭州', value: 'hangzhou' },
      { label: '成都', value: 'chengdu' },
      { label: '厦门', value: 'xiamen' },
      { label: '上海', value: 'shanghai' },
    ],
    value: { path: '/form/destination' },
  },
  {
    id: 'traveler',
    component: 'TextField',
    label: '出行人姓名',
    value: { path: '/form/traveler' },
  },
  { id: 'days', component: 'TextField', label: '行程天数', value: { path: '/form/days' } },
  {
    id: 'submit',
    component: 'Button',
    child: 'submit-label',
    action: {
      event: {
        name: 'save_trip',
        context: {
          destination: { path: '/form/destination' },
          traveler: { path: '/form/traveler' },
          days: { path: '/form/days' },
        },
      },
    },
  },
  { id: 'submit-label', component: 'Text', text: '生成计划' },
  { id: 'status', component: 'Text', text: { path: '/result/status' }, variant: 'caption' },
];

const chatSurfaceRequestSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    threadId: z.string().trim().min(1).max(128),
    prompt: z.string().trim().min(1).max(1_000),
    protocol: z.literal('a2ui'),
    context: z
      .object({
        city: z.enum(['杭州', '成都', '上海']),
        days: z.number().int().min(1).max(7),
      })
      .strict(),
    history: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(128),
            role: z.enum(['user', 'assistant']),
            content: z.string().max(10_000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

const chatDestinationIds = {
  杭州: 'hangzhou',
  成都: 'chengdu',
  上海: 'shanghai',
} as const;

function createMessage(): A2uiMessage {
  return {
    version: A2UI_VERSION,
    createSurface: { surfaceId: A2UI_SURFACE_ID, catalogId: A2UI_BASIC_CATALOG_ID },
  };
}

function modelMessage(value: unknown, path = '/'): A2uiMessage {
  return {
    version: A2UI_VERSION,
    updateDataModel: { surfaceId: A2UI_SURFACE_ID, path, value },
  } as A2uiMessage;
}

function componentsMessage(components: unknown[]): A2uiMessage {
  return {
    version: A2UI_VERSION,
    updateComponents: { surfaceId: A2UI_SURFACE_ID, components },
  } as A2uiMessage;
}

function isEmptySurfaceRequest(input: unknown): boolean {
  return (
    input === undefined ||
    input === null ||
    (typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0)
  );
}

export function createInitialA2uiMessages(input?: unknown): A2uiMessage[] {
  const request = isEmptySurfaceRequest(input) ? null : chatSurfaceRequestSchema.parse(input);
  const model = structuredClone(initialModel) as {
    form: Record<string, string | string[]>;
    result: { status: string };
  };
  const components = structuredClone(initialComponents);

  if (request) {
    model.form.destination = [chatDestinationIds[request.context.city]];
    model.form.days = String(request.context.days);

    const title = components.find((component) => component.id === 'title');
    if (!title || title.component !== 'Text') throw new Error('fixture 缺少 title Text。');
    title.text = request.prompt;

    const destination = components.find((component) => component.id === 'destination');
    if (!destination || destination.component !== 'ChoicePicker') {
      throw new Error('fixture 缺少 destination ChoicePicker。');
    }
    destination.options = destination.options.filter((option) => option.value !== 'xiamen');

    const form = components.find((component) => component.id === 'form');
    const submit = components.find((component) => component.id === 'submit');
    if (!form || form.component !== 'Column' || !submit || submit.component !== 'Button') {
      throw new Error('fixture 表单结构不完整。');
    }

    const contextualFields: A2uiComponent[] = [];
    if (/同行人数|多人/u.test(request.prompt)) {
      model.form.partySize = '2';
      contextualFields.push({
        id: 'partySize',
        component: 'TextField',
        label: '同行人数',
        value: { path: '/form/partySize' },
      });
      submit.action.event.context.partySize = { path: '/form/partySize' };
    }
    if (/预算/u.test(request.prompt)) {
      model.form.budget = '3000';
      contextualFields.push({
        id: 'budget',
        component: 'TextField',
        label: '预算（元）',
        value: { path: '/form/budget' },
      });
      submit.action.event.context.budget = { path: '/form/budget' };
    }

    if (contextualFields.length > 0) {
      const submitIndex = form.children.indexOf('submit');
      form.children.splice(
        submitIndex < 0 ? form.children.length : submitIndex,
        0,
        ...contextualFields.map((field) => field.id),
      );
      components.push(...contextualFields);
    }
  }

  return a2uiMessagesSchema.parse([
    createMessage(),
    modelMessage(model),
    componentsMessage(components),
  ]);
}

const destinationNames: Record<string, string> = {
  hangzhou: '杭州',
  chengdu: '成都',
  xiamen: '厦门',
  shanghai: '上海',
};

export function createA2uiActionMessages(input: unknown): A2uiMessage[] {
  const request = a2uiClientActionSchema.parse(input);
  if (request.action.surfaceId !== A2UI_SURFACE_ID) throw new Error('动作的 surfaceId 不存在。');
  if (request.action.sourceComponentId !== 'submit' || request.action.name !== 'save_trip') {
    throw new Error('此 Surface 不支持该动作。');
  }

  const contextSchema = z
    .object({
      destination: z.array(z.enum(['hangzhou', 'chengdu', 'xiamen', 'shanghai'])).length(1),
      traveler: z.string().trim().min(1, '请填写出行人姓名。').max(40),
      days: z.string().regex(/^[1-7]$/, '行程天数必须是 1 到 7。'),
      partySize: z
        .string()
        .regex(/^(?:[1-9]|1\d|20)$/, '同行人数必须是 1 到 20。')
        .optional(),
      budget: z
        .string()
        .regex(/^[1-9]\d{0,6}$/, '预算必须是 1 到 9999999 的整数。')
        .optional(),
    })
    .strict();
  const context = contextSchema.parse(request.action.context);
  const place = destinationNames[context.destination[0]];
  const optionalDetails = [
    context.partySize ? `同行人数 ${context.partySize} 人` : null,
    context.budget ? `预算 ${context.budget} 元` : null,
  ].filter((detail): detail is string => detail !== null);
  const detailText = optionalDetails.length > 0 ? `，${optionalDetails.join('，')}` : '';

  return a2uiMessagesSchema.parse([
    modelMessage(
      `已为 ${context.traveler} 生成 ${place} ${context.days} 天游览计划${detailText}（演示数据，未预订）。`,
      '/result/status',
    ),
    componentsMessage([
      {
        id: 'submit-label',
        component: 'Text',
        text: '重新生成计划',
      },
    ]),
  ]);
}

export function createDeleteA2uiMessage(surfaceId: string): A2uiMessage {
  if (surfaceId !== A2UI_SURFACE_ID) throw new Error('要删除的 surfaceId 不存在。');
  return {
    version: A2UI_VERSION,
    deleteSurface: { surfaceId },
  };
}
