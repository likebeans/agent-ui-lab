import { useEffect, useRef, useState } from 'react';
import { Check, Circle, CircleStop, LoaderCircle, RotateCcw, Unplug, Wrench } from 'lucide-react';
import { PROTOCOL_VERSION, type RunAgentInput } from '@ag-ui/core';
import {
  aguiReducer,
  createInitialAguiState,
  finalizeAguiStream,
  parseAguiEvent,
} from '../../shared/agui';
import type { ChatTurnProps } from '../../shared/chat';
import { consumeSse } from '../../shared/sse';
import { errorMessage, fetchJson, labFetch } from '../../shared/http';
import { STATIC_MODE } from '../../shared/runtime';
import { eventRegion, type AguiFrame, type AguiRegion } from '../../shared/agui-learning';
import { AguiLearningPanel } from './AguiLearningPanel';

const labels = {
  idle: '连接中',
  running: '正在生成',
  success: '已完成',
  cancelled: '已取消',
  error: '运行失败',
  truncated: '连接已中断',
};

export function AguiChatTurn({
  active = true,
  request,
  onTrace,
  onComplete,
  onInspectTrace,
}: ChatTurnProps) {
  const [liveState, setState] = useState(createInitialAguiState);
  const [frames, setFrames] = useState<AguiFrame[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [region, setRegion] = useState<AguiRegion | null>(null);
  const [learningOpen, setLearningOpen] = useState(false);
  const [revealRequest, setRevealRequest] = useState(0);
  const learningDetails = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (revealRequest) learningDetails.current?.scrollIntoView({ block: 'start' });
  }, [revealRequest]);
  const state = cursor === null ? liveState : (frames[cursor]?.after ?? liveState);
  const [connecting, setConnecting] = useState(true);
  const [cancelError, setCancelError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [events, setEvents] = useState<string[]>([]);
  const stateRef = useRef(state);
  const controllerRef = useRef<AbortController | null>(null);
  const callbacks = useRef({ onTrace, onComplete });
  callbacks.current = { onTrace, onComplete };

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    const initial = createInitialAguiState();
    stateRef.current = initial;
    setState(initial);
    setEvents([]);
    setFrames([]);
    setCursor(null);
    setRegion(null);
    setConnecting(true);
    setCancelError('');
    const runId = `run-${crypto.randomUUID()}`;
    const input: RunAgentInput = {
      threadId: request.threadId,
      runId,
      protocolVersion: PROTOCOL_VERSION,
      messages: [
        ...request.history.slice(-48),
        { id: request.id, role: 'user', content: request.prompt },
      ],
      tools: [
        {
          name: 'lookup_trip_fixture',
          description: '读取本地城市行程样本。',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' },
              days: { type: 'integer' },
              preference: { type: 'string' },
            },
            required: ['city', 'days'],
          },
        },
      ],
      context: [{ description: '对话上下文', value: JSON.stringify(request.context) }],
      forwardedProps: {
        ...request.context,
        preference: request.prompt.slice(0, 300),
        scenario: /错误|故障|失败/u.test(request.prompt) ? 'error' : 'success',
      },
    };
    callbacks.current.onTrace({
      protocol: 'agui',
      direction: 'client→server',
      label: 'POST /api/agui',
      payload: input,
      note: '同一聊天使用同一 threadId；每次运行使用新的 runId。',
    });
    const commit = (next: typeof initial) => {
      stateRef.current = next;
      if (active) setState(next);
    };
    void (async () => {
      try {
        const response = await labFetch('/api/agui', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        await consumeSse(
          response,
          (value) => {
            if (!active) return;
            const event = parseAguiEvent(value);
            setConnecting(false);
            setEvents((previous) =>
              previous.includes(event.type) ? previous : [...previous, event.type],
            );
            callbacks.current.onTrace({
              protocol: 'agui',
              direction: 'server→client',
              label: event.type,
              payload: event,
            });
            const before = stateRef.current;
            const after = aguiReducer(before, { kind: 'event', event });
            setFrames((previous) => [...previous, { event, before, after }]);
            commit(after);
          },
          controller.signal,
        );
        if (active) commit(finalizeAguiStream(stateRef.current));
      } catch (error) {
        if (active)
          commit(
            aguiReducer(stateRef.current, {
              kind: 'transport-error',
              message: controller.signal.aborted
                ? STATIC_MODE
                  ? '本地事件流已中断，没有收到取消确认。'
                  : 'HTTP 已中断，没有收到服务端取消确认。'
                : errorMessage(error),
            }),
          );
      } finally {
        if (active) {
          setConnecting(false);
          callbacks.current.onComplete(
            stateRef.current.messages.map((message) => message.text).join('\n') ||
              stateRef.current.error ||
              labels[stateRef.current.phase],
          );
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [request, attempt]);

  async function cancelRun() {
    const runId = stateRef.current.runId;
    if (!runId) return;
    const signal = controllerRef.current?.signal;
    setCancelError('');
    callbacks.current.onTrace({
      protocol: 'agui',
      direction: 'client→server',
      label: '请求协议取消',
      payload: { runId },
    });
    try {
      await fetchJson(`/api/agui/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        body: '{}',
        signal,
      });
    } catch (error) {
      if (!signal?.aborted) setCancelError(errorMessage(error));
    }
  }

  function traceRegion(target: AguiRegion, ownerId?: string) {
    const visibleFrames = cursor === null ? frames : frames.slice(0, cursor + 1);
    const matches = visibleFrames.map((frame) => {
      const event = frame.event;
      if (target === 'text')
        return event.type === 'TEXT_MESSAGE_CONTENT' && event.messageId === ownerId;
      if (target === 'tool')
        return (
          eventRegion(event) === target && 'toolCallId' in event && event.toolCallId === ownerId
        );
      return eventRegion(event) === target;
    });
    const index = matches.lastIndexOf(true);
    if (index < 0) return;
    setCursor(index);
    setRegion(target);
    setLearningOpen(true);
    setRevealRequest((value) => value + 1);
  }

  const busy = connecting || liveState.phase === 'running';
  const selectedEvent = cursor === null ? null : frames[cursor]?.event;
  const highlighted = selectedEvent ? eventRegion(selectedEvent) : null;
  const highlightedMessageId =
    selectedEvent && 'messageId' in selectedEvent ? selectedEvent.messageId : undefined;
  const highlightedToolId =
    selectedEvent && 'toolCallId' in selectedEvent ? selectedEvent.toolCallId : undefined;
  return (
    <div className="chat-agui">
      <div className="chat-run-status" role="status">
        {busy ? <LoaderCircle size={14} className="spinner" /> : <Check size={14} />}{' '}
        {connecting ? '正在建立事件流' : labels[liveState.phase]}
        <span>{STATIC_MODE ? 'AG-UI · 浏览器内事件流' : 'AG-UI · SSE'}</span>
      </div>
      <div className="learning-controls agui-playback-toolbar">
        <button
          type="button"
          disabled={!frames.length}
          onClick={() => {
            setCursor(cursor === null ? frames.length - 1 : null);
            setLearningOpen(true);
          }}
        >
          {cursor === null ? '暂停展示并观察' : '结束回放，回到实时'}
        </button>
        {cursor !== null && (
          <span>
            正在展示第 {cursor + 1} / {frames.length} 条事件 · {labels[state.phase]}
          </span>
        )}
      </div>
      {state.messages[0] && (
        <p
          className={`agent-prose ${highlighted === 'text' && state.messages[0].id === highlightedMessageId ? 'causal-highlight' : ''}`}
        >
          {state.messages[0].text || '正在接收文本…'}
          {!state.messages[0].complete && <span className="stream-caret" />}
          <button
            className="causal-link"
            type="button"
            onClick={() => traceRegion('text', state.messages[0].id)}
          >
            追溯文字更新
          </button>
        </p>
      )}
      {state.agentState && (
        <div className={`chat-task-card ${highlighted === 'state' ? 'causal-highlight' : ''}`}>
          <div className="chat-card-label">
            STATE → 任务进度{' '}
            <button className="causal-link" type="button" onClick={() => traceRegion('state')}>
              追溯状态更新
            </button>
          </div>
          {state.agentState.tasks.map((task) => (
            <div className={task.status === 'done' ? 'task-item done' : 'task-item'} key={task.id}>
              {task.status === 'done' ? <Check size={14} /> : <Circle size={14} />}
              {task.label}
            </div>
          ))}
        </div>
      )}
      {state.toolCalls.map((tool) => (
        <details
          className={`chat-tool-call ${highlighted === 'tool' && tool.id === highlightedToolId ? 'causal-highlight' : ''}`}
          key={tool.id}
          open={tool.status !== 'result'}
        >
          <summary>
            <Wrench size={14} /> {tool.name}
            <span>
              {tool.status === 'result'
                ? '已返回结果'
                : tool.status === 'called'
                  ? '执行中'
                  : '接收参数'}
            </span>
          </summary>
          <button
            className="causal-link"
            type="button"
            onClick={() => traceRegion('tool', tool.id)}
          >
            追溯工具卡片
          </button>
          <pre>{tool.argsText || '等待 TOOL_CALL_ARGS…'}</pre>
          {tool.result && <pre>{tool.result}</pre>}
        </details>
      ))}
      {state.messages.slice(1).map((message) => (
        <p
          className={`agent-prose ${highlighted === 'text' && message.id === highlightedMessageId ? 'causal-highlight' : ''}`}
          key={message.id}
        >
          {message.text || '…'}
          {!message.complete && <span className="stream-caret" />}
          <button
            className="causal-link"
            type="button"
            onClick={() => traceRegion('text', message.id)}
          >
            追溯这段文字
          </button>
        </p>
      ))}
      {state.agentState && state.agentState.itinerary.length > 0 && (
        <div className={`chat-itinerary ${highlighted === 'state' ? 'causal-highlight' : ''}`}>
          {state.agentState.itinerary.map((day, index) => (
            <div key={day}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <p>{day.replace(/^第 \d+ 天 · /u, '')}</p>
            </div>
          ))}
        </div>
      )}
      {(state.error || cancelError) && (
        <p className="error-banner" role="alert">
          {cancelError || state.error}
        </p>
      )}
      {state.phase === 'cancelled' && (
        <p className="hint">服务端已发送 RUN_FINISHED，outcome 为 cancelled。</p>
      )}
      <div className="chat-run-actions">
        {busy && (
          <>
            <button type="button" onClick={() => void cancelRun()} disabled={!liveState.runId}>
              <CircleStop size={14} />
              取消运行
            </button>
            <button type="button" onClick={() => controllerRef.current?.abort()}>
              <Unplug size={14} />
              {STATIC_MODE ? '中断本地流' : '中断 HTTP'}
            </button>
          </>
        )}
        {!busy && (liveState.phase === 'error' || liveState.phase === 'truncated') && (
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            <RotateCcw size={14} />
            重试这一轮
          </button>
        )}
      </div>
      <details
        ref={learningDetails}
        className="chat-disclosure"
        open={learningOpen}
        onToggle={(event) => setLearningOpen(event.currentTarget.open)}
      >
        <summary>
          事件如何变成这条回复 <span>{events.length} 种事件 · 单步回放与实验</span>
        </summary>
        <div className="event-map">
          <p>
            <code>TEXT_MESSAGE_CONTENT</code>
            <span>追加上方回复文本</span>
          </p>
          <p>
            <code>TOOL_CALL_*</code>
            <span>更新工具卡片和参数</span>
          </p>
          <p>
            <code>STATE_SNAPSHOT / DELTA</code>
            <span>更新任务进度与行程卡片</span>
          </p>
          <p>
            <code>RUN_FINISHED / ERROR</code>
            <span>决定运行终态</span>
          </p>
        </div>
        <div className="event-pills">
          {events.map((event) => (
            <code key={event}>{event}</code>
          ))}
        </div>
        <AguiLearningPanel
          key={attempt}
          active={active && learningOpen}
          frames={frames}
          cursor={cursor}
          onCursor={setCursor}
          region={region}
          onTrace={onTrace}
          onInspectTrace={onInspectTrace}
        />
      </details>
    </div>
  );
}
