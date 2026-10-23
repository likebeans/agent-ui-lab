import { EventType, type AGUIEvent } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { pointerSegments, type JsonValue } from './json-pointer';

export const TRIP_CITIES = ['杭州', '成都', '上海'] as const;
export type TripCity = (typeof TRIP_CITIES)[number];

export interface TripTask {
  id: string;
  label: string;
  status: 'pending' | 'done';
}

export interface TripState {
  city: TripCity;
  days: number;
  status: 'planning' | 'ready';
  tasks: TripTask[];
  itinerary: string[];
}

export interface StreamedMessage {
  id: string;
  text: string;
  complete: boolean;
}

export interface StreamedToolCall {
  id: string;
  name: string;
  parentMessageId?: string;
  argsText: string;
  result?: string;
  status: 'streaming' | 'called' | 'result';
}

export type AguiRunPhase = 'idle' | 'running' | 'success' | 'cancelled' | 'error' | 'truncated';

export interface AguiLabState {
  phase: AguiRunPhase;
  threadId?: string;
  runId?: string;
  messages: StreamedMessage[];
  toolCalls: StreamedToolCall[];
  agentState: TripState | null;
  error?: string;
}

export type AguiReducerAction =
  | { kind: 'reset' }
  | { kind: 'event'; event: unknown }
  | { kind: 'transport-error'; message: string };

const SUPPORTED_EVENTS = new Set<string>([
  EventType.RUN_STARTED,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_RESULT,
  EventType.STATE_SNAPSHOT,
  EventType.STATE_DELTA,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
]);

export function createInitialAguiState(): AguiLabState {
  return { phase: 'idle', messages: [], toolCalls: [], agentState: null };
}

/** Validate every event at the network boundary and reject events outside this lab's finite subset. */
export function parseAguiEvent(value: unknown): AGUIEvent {
  const parsed = EventSchemas.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.join('.') || 'event';
    throw new Error(`AG-UI 事件不合法：${location} ${issue?.message ?? ''}`.trim());
  }
  if (!SUPPORTED_EVENTS.has(parsed.data.type))
    throw new Error(`教学客户端尚未实现事件 ${parsed.data.type}。`);
  if (parsed.data.type === EventType.TOOL_CALL_RESULT && typeof parsed.data.content !== 'string') {
    throw new Error('教学客户端仅实现字符串形式的 TOOL_CALL_RESULT.content。');
  }
  return parsed.data;
}

/**
 * Deliberately limited RFC 6902 support: only `replace`, only existing targets,
 * and only safe RFC 6901 pointers. It is not a generic JSON Patch implementation.
 */
export function applyReplaceOnlyPatch(document: JsonValue, patch: readonly unknown[]): JsonValue {
  let next = cloneJson(document);
  for (const rawOperation of patch) {
    if (
      !isRecord(rawOperation) ||
      rawOperation.op !== 'replace' ||
      typeof rawOperation.path !== 'string' ||
      !Object.hasOwn(rawOperation, 'value')
    ) {
      throw new Error('教学 reducer 仅支持包含 path 与 value 的 RFC 6902 replace 操作。');
    }
    assertJsonValue(rawOperation.value);
    next = replaceAtPointer(next, rawOperation.path, rawOperation.value);
  }
  return next;
}

export function aguiReducer(state: AguiLabState, action: AguiReducerAction): AguiLabState {
  if (action.kind === 'reset') return createInitialAguiState();
  if (action.kind === 'transport-error') {
    if (isProtocolTerminal(state.phase)) return state;
    return { ...state, phase: 'truncated', error: action.message };
  }

  const event = parseAguiEvent(action.event);
  const isLateRunError =
    event.type === EventType.RUN_ERROR &&
    (state.phase === 'success' || state.phase === 'cancelled');
  if (isProtocolTerminal(state.phase) && event.type !== EventType.RUN_STARTED && !isLateRunError) {
    throw new Error(`运行已经结束，不能再接收 ${event.type}。`);
  }

  switch (event.type) {
    case EventType.RUN_STARTED:
      if (state.phase === 'running') throw new Error('收到嵌套的 RUN_STARTED。');
      return {
        ...createInitialAguiState(),
        phase: 'running',
        threadId: event.threadId,
        runId: event.runId,
      };

    case EventType.TEXT_MESSAGE_START:
      assertRunning(state, event.type);
      if (event.role && event.role !== 'assistant')
        throw new Error('教学 reducer 仅渲染 assistant 文本消息。');
      if (state.messages.some((message) => !message.complete))
        throw new Error('上一条文本消息尚未结束。');
      if (state.messages.some((message) => message.id === event.messageId))
        throw new Error(`消息 ID 重复：${event.messageId}`);
      return {
        ...state,
        messages: [...state.messages, { id: event.messageId, text: '', complete: false }],
      };

    case EventType.TEXT_MESSAGE_CONTENT:
      assertRunning(state, event.type);
      return {
        ...state,
        messages: updateOne(
          state.messages,
          (message) => message.id === event.messageId && !message.complete,
          (message) => ({ ...message, text: message.text + event.delta }),
          `找不到可追加的消息：${event.messageId}`,
        ),
      };

    case EventType.TEXT_MESSAGE_END:
      assertRunning(state, event.type);
      return {
        ...state,
        messages: updateOne(
          state.messages,
          (message) => message.id === event.messageId && !message.complete,
          (message) => ({ ...message, complete: true }),
          `找不到可结束的消息：${event.messageId}`,
        ),
      };

    case EventType.TOOL_CALL_START:
      assertRunning(state, event.type);
      if (state.toolCalls.some((tool) => tool.status === 'streaming'))
        throw new Error('上一条工具调用尚未结束。');
      if (state.toolCalls.some((tool) => tool.id === event.toolCallId))
        throw new Error(`工具调用 ID 重复：${event.toolCallId}`);
      return {
        ...state,
        toolCalls: [
          ...state.toolCalls,
          {
            id: event.toolCallId,
            name: event.toolCallName,
            parentMessageId: event.parentMessageId,
            argsText: '',
            status: 'streaming',
          },
        ],
      };

    case EventType.TOOL_CALL_ARGS:
      assertRunning(state, event.type);
      return {
        ...state,
        toolCalls: updateOne(
          state.toolCalls,
          (tool) => tool.id === event.toolCallId && tool.status === 'streaming',
          (tool) => ({ ...tool, argsText: tool.argsText + event.delta }),
          `找不到可追加参数的工具调用：${event.toolCallId}`,
        ),
      };

    case EventType.TOOL_CALL_END:
      assertRunning(state, event.type);
      return {
        ...state,
        toolCalls: updateOne(
          state.toolCalls,
          (tool) => tool.id === event.toolCallId && tool.status === 'streaming',
          (tool) => {
            try {
              JSON.parse(tool.argsText);
            } catch {
              throw new Error(`工具参数不是完整 JSON：${event.toolCallId}`);
            }
            return { ...tool, status: 'called' };
          },
          `找不到可结束的工具调用：${event.toolCallId}`,
        ),
      };

    case EventType.TOOL_CALL_RESULT:
      assertRunning(state, event.type);
      return {
        ...state,
        toolCalls: updateOne(
          state.toolCalls,
          (tool) => tool.id === event.toolCallId && tool.status === 'called',
          (tool) => ({ ...tool, result: event.content as string, status: 'result' }),
          `找不到等待结果的工具调用：${event.toolCallId}`,
        ),
      };

    case EventType.STATE_SNAPSHOT:
      assertRunning(state, event.type);
      return { ...state, agentState: parseTripState(event.snapshot) };

    case EventType.STATE_DELTA: {
      assertRunning(state, event.type);
      if (!state.agentState) throw new Error('STATE_DELTA 到达前没有 STATE_SNAPSHOT。');
      const patched = applyReplaceOnlyPatch(state.agentState as unknown as JsonValue, event.delta);
      return { ...state, agentState: parseTripState(patched) };
    }

    case EventType.RUN_FINISHED:
      assertRunning(state, event.type);
      if (state.threadId !== event.threadId || state.runId !== event.runId)
        throw new Error('终止事件与当前运行 ID 不一致。');
      assertNoOpenItems(state);
      if (event.outcome?.type === 'interrupt')
        throw new Error('教学 reducer 未实现 interrupt outcome。');
      return { ...state, phase: event.outcome?.type === 'cancelled' ? 'cancelled' : 'success' };

    case EventType.RUN_ERROR:
      if (state.phase !== 'idle' && state.phase !== 'success' && state.phase !== 'cancelled')
        assertRunning(state, event.type);
      // RUN_ERROR terminates the run and implicitly closes anything still open.
      return {
        ...state,
        phase: 'error',
        messages: state.messages.map((message) => ({ ...message, complete: true })),
        toolCalls: state.toolCalls.map((tool) =>
          tool.status === 'streaming' ? { ...tool, status: 'called' } : tool,
        ),
        error: event.message,
      };

    default:
      throw new Error(`教学客户端尚未实现事件 ${(event as AGUIEvent).type}。`);
  }
}

/** A clean EOF is still truncated unless a protocol terminal event was received. */
export function finalizeAguiStream(state: AguiLabState): AguiLabState {
  if (isProtocolTerminal(state.phase)) return state;
  return aguiReducer(state, {
    kind: 'transport-error',
    message: 'SSE 在协议终止事件到达前结束；这是一条截断流。',
  });
}

function parseTripState(value: unknown): TripState {
  if (!isRecord(value)) throw new Error('Agent 状态必须是对象。');
  if (!TRIP_CITIES.includes(value.city as TripCity)) throw new Error('Agent 状态包含未知城市。');
  if (!Number.isInteger(value.days) || (value.days as number) < 1 || (value.days as number) > 7)
    throw new Error('Agent 状态中的天数不合法。');
  if (value.status !== 'planning' && value.status !== 'ready')
    throw new Error('Agent 状态中的运行状态不合法。');
  if (!Array.isArray(value.tasks) || value.tasks.length > 8)
    throw new Error('Agent 状态中的任务列表不合法。');
  const tasks = value.tasks.map((task) => {
    if (
      !isRecord(task) ||
      typeof task.id !== 'string' ||
      typeof task.label !== 'string' ||
      (task.status !== 'pending' && task.status !== 'done')
    ) {
      throw new Error('Agent 状态中的任务项不合法。');
    }
    return { id: task.id, label: task.label, status: task.status } satisfies TripTask;
  });
  if (
    !Array.isArray(value.itinerary) ||
    value.itinerary.length > 7 ||
    !value.itinerary.every((item) => typeof item === 'string')
  ) {
    throw new Error('Agent 状态中的行程列表不合法。');
  }
  return {
    city: value.city as TripCity,
    days: value.days as number,
    status: value.status,
    tasks,
    itinerary: [...value.itinerary],
  };
}

function replaceAtPointer(document: JsonValue, path: string, value: JsonValue): JsonValue {
  const segments = pointerSegments(path);
  if (segments.length === 0) return cloneJson(value);
  const root = cloneJson(document);
  let target: JsonValue = root;

  for (const segment of segments.slice(0, -1)) target = readChild(target, segment, path);

  const key = segments.at(-1)!;
  if (Array.isArray(target)) {
    target[arrayIndex(key, target.length, path)] = cloneJson(value);
  } else if (isRecord(target)) {
    if (!Object.hasOwn(target, key)) throw new Error(`replace 的目标不存在：${path}`);
    target[key] = cloneJson(value);
  } else {
    throw new Error(`replace 的父节点不是容器：${path}`);
  }
  return root;
}

function readChild(value: JsonValue, key: string, path: string): JsonValue {
  if (Array.isArray(value)) return value[arrayIndex(key, value.length, path)]!;
  if (!isRecord(value) || !Object.hasOwn(value, key))
    throw new Error(`replace 的目标不存在：${path}`);
  return value[key] as JsonValue;
}

function arrayIndex(segment: string, length: number, path: string): number {
  if (!/^(0|[1-9]\d*)$/u.test(segment)) throw new Error(`数组下标不合法：${path}`);
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index >= length)
    throw new Error(`replace 的数组目标不存在：${path}`);
  return index;
}

function assertJsonValue(value: unknown, seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new Error('Patch value 必须是 JSON 值。');
  if (seen.has(value)) throw new Error('Patch value 不能包含循环引用。');
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item) => assertJsonValue(item, seen));
  else
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error('Patch value 包含不安全的对象键。');
      assertJsonValue(item, seen);
    }
  seen.delete(value);
}

function assertRunning(state: AguiLabState, eventType: string): void {
  if (state.phase !== 'running') throw new Error(`${eventType} 到达时没有活动运行。`);
}

function assertNoOpenItems(state: AguiLabState): void {
  if (state.messages.some((message) => !message.complete))
    throw new Error('运行结束时仍有未关闭的文本消息。');
  if (state.toolCalls.some((tool) => tool.status === 'streaming'))
    throw new Error('运行结束时仍有未关闭的工具调用。');
}

function isProtocolTerminal(phase: AguiRunPhase): boolean {
  return phase === 'success' || phase === 'cancelled' || phase === 'error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function updateOne<T>(
  items: T[],
  predicate: (item: T) => boolean,
  update: (item: T) => T,
  error: string,
): T[] {
  const index = items.findIndex(predicate);
  if (index < 0) throw new Error(error);
  return items.map((item, itemIndex) => (itemIndex === index ? update(item) : item));
}
