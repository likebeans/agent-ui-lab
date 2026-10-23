import type { AGUIEvent } from '@ag-ui/core';
import { aguiReducer, type AguiLabState } from './agui';

export type AguiRegion = 'text' | 'tool' | 'state' | 'lifecycle';
export interface AguiFrame {
  event: AGUIEvent;
  before: AguiLabState;
  after: AguiLabState;
}

export function eventRegion(event: AGUIEvent): AguiRegion {
  if (event.type.startsWith('TEXT_MESSAGE_')) return 'text';
  if (event.type.startsWith('TOOL_CALL_')) return 'tool';
  if (event.type.startsWith('STATE_')) return 'state';
  return 'lifecycle';
}

export function explainAguiFrame(frame: AguiFrame) {
  const { event, before, after } = frame;
  const region = eventRegion(event);
  if (region === 'text' && 'messageId' in event) {
    const oldMessage = before.messages.find((message) => message.id === event.messageId);
    const newMessage = after.messages.find((message) => message.id === event.messageId);
    return {
      region,
      before: oldMessage ?? null,
      after: newMessage ?? null,
      effect:
        event.type === 'TEXT_MESSAGE_CONTENT'
          ? '将 delta 追加到同一 messageId 的 text；React 读取新的 text 更新这段回复。'
          : event.type === 'TEXT_MESSAGE_START'
            ? '创建空消息，后续增量通过 messageId 找到它。'
            : '将 complete 标为 true，收起流式光标。',
      source: 'shared/agui.ts · aguiReducer → messages → AguiChatTurn 的文本段落',
    };
  }
  if (region === 'tool' && 'toolCallId' in event) {
    return {
      region,
      before: before.toolCalls.find((tool) => tool.id === event.toolCallId) ?? null,
      after: after.toolCalls.find((tool) => tool.id === event.toolCallId) ?? null,
      effect:
        event.type === 'TOOL_CALL_END'
          ? '参数已拼接并通过 JSON 校验，卡片进入执行中；此时没有工具结果。'
          : event.type === 'TOOL_CALL_RESULT'
            ? '保存 content，卡片显示已返回结果。'
            : '通过 toolCallId 创建卡片或追加 argsText；不执行收到的参数文本。',
      source: 'shared/agui.ts · aguiReducer → toolCalls → AguiChatTurn 的工具卡片',
    };
  }
  if (region === 'state') {
    return {
      region,
      before: before.agentState,
      after: after.agentState,
      effect:
        event.type === 'STATE_SNAPSHOT'
          ? '用 snapshot 替换整个 agentState。任务和行程组件读取新状态。'
          : '只替换 delta 指定的已有路径；其他字段保留。本教学实现只支持 replace。',
      source: 'shared/agui.ts · aguiReducer / applyReplaceOnlyPatch → agentState → 任务与行程',
    };
  }
  return {
    region,
    before: { phase: before.phase, error: before.error ?? null },
    after: { phase: after.phase, error: after.error ?? null },
    effect: '运行生命周期控制状态标签。协议终态与 HTTP 连接是否关闭是两件事。',
    source: 'shared/agui.ts · aguiReducer → phase → AguiChatTurn 的运行状态',
  };
}

export function changedStatePaths(
  before: unknown,
  after: unknown,
  path = '',
): Array<{ path: string; before: unknown; after: unknown }> {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object'
  ) {
    const previous = before as Record<string, unknown>;
    const next = after as Record<string, unknown>;
    return [...new Set([...Object.keys(previous), ...Object.keys(next)])].flatMap((key) =>
      changedStatePaths(
        previous[key],
        next[key],
        `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      ),
    );
  }
  return [{ path: path || '/', before: before ?? null, after: after ?? null }];
}

/** Run an edited event against a recorded state without mutating the real conversation. */
export function experimentWithAguiEvent(frame: AguiFrame, value: unknown): AguiLabState {
  return aguiReducer(frame.before, { kind: 'event', event: value });
}
