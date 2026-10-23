import { EventType, PROTOCOL_VERSION, type AGUIEvent, type RunAgentInput } from '@ag-ui/core';
import { EventSchemas, RunAgentInputSchema } from '@ag-ui/core/schemas';
import { TRIP_CITIES, type TripCity, type TripState } from './agui';

interface TripPlan {
  city: TripCity;
  days: number;
  preference: string;
  itinerary: string[];
  tip: string;
}

const cityFixtures: Record<TripCity, { stops: string[]; tip: string }> = {
  杭州: {
    stops: ['西湖慢行与断桥', '灵隐寺与法喜寺', '龙井村与九溪', '运河街区夜游', '良渚博物院'],
    tip: '热门景点建议错峰，雨天带一把轻便伞。',
  },
  成都: {
    stops: [
      '人民公园与宽窄巷子',
      '熊猫基地与建设路',
      '武侯祠与锦里',
      '青城山一日游',
      '东郊记忆与望平街',
    ],
    tip: '熊猫基地尽量早到；点餐时可主动说明辣度。',
  },
  上海: {
    stops: [
      '外滩与北外滩',
      '武康路与衡山路',
      '上海博物馆与人民广场',
      '西岸美术馆与徐汇滨江',
      '朱家角水乡',
    ],
    tip: '跨区移动优先地铁，热门展馆记得提前预约。',
  },
};

export function buildTripPlan(city: TripCity, days: number, preference = ''): TripPlan {
  const fixture = cityFixtures[city];
  const stops = [...fixture.stops];
  if (/看展|博物|艺术/u.test(preference)) {
    stops.sort((left, right) => Number(/博物|美术/u.test(right)) - Number(/博物|美术/u.test(left)));
  } else if (/慢|漫步|散步/u.test(preference)) {
    stops.sort(
      (left, right) =>
        Number(/路|外滩|公园|湖/u.test(right)) - Number(/路|外滩|公园|湖/u.test(left)),
    );
  }
  return {
    city,
    days,
    preference,
    itinerary: Array.from(
      { length: days },
      (_, index) => `第 ${index + 1} 天 · ${stops[index % stops.length]}`,
    ),
    tip: fixture.tip,
  };
}

/** Apply the official schema and the lab's limits before starting a run in either transport. */
export function parseTripRunInput(value: unknown): RunAgentInput {
  const parsed = RunAgentInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`RunAgentInput 不合法：${parsed.error.issues[0]?.message ?? '未知字段错误'}`);
  }
  const validationError = validateInput(parsed.data);
  if (validationError) throw new Error(validationError);
  return parsed.data;
}

/** Cancellation is a protocol outcome; abort only disconnects the event transport. */
export async function streamTripRun(
  input: RunAgentInput,
  send: (event: AGUIEvent) => Promise<void>,
  control: { cancelRequested: boolean; signal: AbortSignal },
  delayMs: number,
): Promise<void> {
  const request = tripRequest(input);
  const messageId = `${input.runId}-message-1`;
  const finalMessageId = `${input.runId}-message-2`;
  const toolCallId = `${input.runId}-tool-1`;
  const toolResultMessageId = `${input.runId}-tool-result-1`;
  let openMessageId: string | undefined;
  let openToolCallId: string | undefined;
  let toolArgs = '';

  const sendEvent = async (event: AGUIEvent): Promise<void> => {
    control.signal.throwIfAborted();
    await send(EventSchemas.parse(event));
  };

  const emit = async (event: AGUIEvent) => {
    await sendEvent(event);
    await pause(control.signal, delayMs);
    if (control.cancelRequested) await finishCancelled();
  };

  const finishCancelled = async (): Promise<never> => {
    if (openMessageId) {
      await sendEvent({ type: EventType.TEXT_MESSAGE_END, messageId: openMessageId });
      openMessageId = undefined;
    }
    if (openToolCallId) {
      if (!isCompleteJson(toolArgs))
        await sendEvent({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: openToolCallId,
          delta: completeToolArgs(toolArgs, request),
        });
      await sendEvent({ type: EventType.TOOL_CALL_END, toolCallId: openToolCallId });
      openToolCallId = undefined;
    }
    await sendEvent({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      outcome: { type: 'cancelled' },
    });
    throw new RunCancelled();
  };

  try {
    await emit({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
      protocolVersion: PROTOCOL_VERSION,
    });

    const initialState: TripState = {
      city: request.city,
      days: request.days,
      status: 'planning',
      tasks: [
        { id: 'understand', label: '理解行程需求', status: 'pending' },
        { id: 'fixture', label: '调用本地行程工具', status: 'pending' },
        { id: 'compose', label: '整理可执行建议', status: 'pending' },
      ],
      itinerary: [],
    };
    await emit({ type: EventType.STATE_SNAPSHOT, snapshot: initialState });

    openMessageId = messageId;
    await emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
    await emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: '收到，我会用确定性 Agent 为你规划',
    });
    await emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: `${request.city} ${request.days} 天行程。`,
    });
    await sendEvent({ type: EventType.TEXT_MESSAGE_END, messageId });
    openMessageId = undefined;
    await pause(control.signal, delayMs);
    if (control.cancelRequested) await finishCancelled();

    await emit({
      type: EventType.STATE_DELTA,
      delta: [{ op: 'replace', path: '/tasks/0/status', value: 'done' }],
    });

    if (request.scenario === 'error') {
      await sendEvent({
        type: EventType.RUN_ERROR,
        message: '模拟的行程数据服务暂时不可用。',
        code: 'FIXTURE_UNAVAILABLE',
      });
      return;
    }

    openToolCallId = toolCallId;
    await emit({
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: 'lookup_trip_fixture',
      parentMessageId: messageId,
    });
    const args = JSON.stringify({
      city: request.city,
      days: request.days,
      preference: request.preference,
    });
    const splitAt = Math.max(1, Math.floor(args.length / 2));
    const firstArgs = args.slice(0, splitAt);
    toolArgs += firstArgs;
    await emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: firstArgs });
    const secondArgs = args.slice(splitAt);
    toolArgs += secondArgs;
    await emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: secondArgs });
    await sendEvent({ type: EventType.TOOL_CALL_END, toolCallId });
    openToolCallId = undefined;
    await pause(control.signal, delayMs);
    if (control.cancelRequested) await finishCancelled();

    const plan = buildTripPlan(request.city, request.days, request.preference);
    await emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: toolResultMessageId,
      toolCallId,
      content: JSON.stringify(plan),
    });
    await emit({
      type: EventType.STATE_DELTA,
      delta: [
        { op: 'replace', path: '/tasks/1/status', value: 'done' },
        { op: 'replace', path: '/itinerary', value: plan.itinerary },
      ],
    });

    openMessageId = finalMessageId;
    await emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: finalMessageId,
      role: 'assistant',
    });
    await emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: finalMessageId,
      delta: `行程已生成：${plan.itinerary.join('；')}。`,
    });
    await emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: finalMessageId,
      delta: ` 提醒：${plan.tip}`,
    });
    await sendEvent({ type: EventType.TEXT_MESSAGE_END, messageId: finalMessageId });
    openMessageId = undefined;
    await pause(control.signal, delayMs);
    if (control.cancelRequested) await finishCancelled();

    await emit({
      type: EventType.STATE_DELTA,
      delta: [
        { op: 'replace', path: '/tasks/2/status', value: 'done' },
        { op: 'replace', path: '/status', value: 'ready' },
      ],
    });
    await sendEvent({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      outcome: { type: 'success' },
    });
  } catch (error) {
    if (
      error instanceof RunCancelled ||
      control.signal.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    )
      return;
    throw error;
  }
}

async function pause(signal: AbortSignal, delayMs: number): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function tripRequest(input: RunAgentInput): {
  city: TripCity;
  days: number;
  preference: string;
  scenario: 'success' | 'error';
} {
  const props = isRecord(input.forwardedProps) ? input.forwardedProps : {};
  const prompt = [...input.messages].reverse().find((message) => message.role === 'user');
  const text = prompt && typeof prompt.content === 'string' ? prompt.content : '';
  const cityFromText = TRIP_CITIES.find((city) => text.includes(city));
  const city = TRIP_CITIES.includes(props.city as TripCity)
    ? (props.city as TripCity)
    : (cityFromText ?? '杭州');
  const daysFromText = Number(text.match(/([1-7])\s*天/u)?.[1]);
  const days = Number.isInteger(props.days) ? Number(props.days) : daysFromText || 3;
  const preference = typeof props.preference === 'string' ? props.preference.trim() : text;
  const scenario = props.scenario === 'error' ? 'error' : 'success';
  return { city, days, preference, scenario };
}

function validateInput(input: RunAgentInput): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(input.threadId))
    return 'threadId 只能包含字母、数字、下划线和连字符，且不超过 80 字符。';
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(input.runId))
    return 'runId 只能包含字母、数字、下划线和连字符，且不超过 80 字符。';
  if (input.protocolVersion && input.protocolVersion !== PROTOCOL_VERSION)
    return `本实验只支持 AG-UI ${PROTOCOL_VERSION}。`;
  if (input.messages.length === 0 || input.messages.length > 50)
    return 'messages 数量必须在 1 到 50 之间。';
  const userMessage = [...input.messages].reverse().find((message) => message.role === 'user');
  const userText =
    userMessage && typeof userMessage.content === 'string' ? userMessage.content.trim() : '';
  if (!userText || userText.length > 500) return '最后一条用户文本必须包含 1 到 500 个字符。';
  if (input.tools.length > 20 || input.context.length > 20)
    return 'tools 或 context 数量超过实验上限。';
  if (input.forwardedProps !== undefined && !isRecord(input.forwardedProps))
    return 'forwardedProps 必须是对象。';
  if (isRecord(input.forwardedProps)) {
    const { city, days, scenario, preference } = input.forwardedProps;
    if (city !== undefined && !TRIP_CITIES.includes(city as TripCity))
      return 'city 仅支持杭州、成都或上海。';
    if (
      days !== undefined &&
      (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 7)
    )
      return 'days 必须是 1 到 7 的整数。';
    if (scenario !== undefined && scenario !== 'success' && scenario !== 'error')
      return 'scenario 仅支持 success 或 error。';
    if (preference !== undefined && (typeof preference !== 'string' || preference.length > 300))
      return 'preference 必须是不超过 300 字符的字符串。';
  }
  return undefined;
}

function completeToolArgs(
  current: string,
  request: { city: TripCity; days: number; preference: string },
): string {
  const complete = JSON.stringify({
    city: request.city,
    days: request.days,
    preference: request.preference,
  });
  return complete.startsWith(current) ? complete.slice(current.length) : '{}';
}

function isCompleteJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class RunCancelled extends Error {}
