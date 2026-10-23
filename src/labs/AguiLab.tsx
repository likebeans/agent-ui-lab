import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  Circle,
  CircleStop,
  LoaderCircle,
  MapPinned,
  RotateCcw,
  Unplug,
  Wrench,
} from 'lucide-react';
import { EventType, PROTOCOL_VERSION, type RunAgentInput } from '@ag-ui/core';
import type { LabProps } from '../../shared/trace';
import { consumeSse } from '../../shared/sse';
import { errorMessage, fetchJson, labFetch } from '../../shared/http';
import { STATIC_MODE } from '../../shared/runtime';
import {
  TRIP_CITIES,
  aguiReducer,
  createInitialAguiState,
  finalizeAguiStream,
  parseAguiEvent,
  type AguiLabState,
  type TripCity,
} from '../../shared/agui';

type Scenario = 'success' | 'error';

type CancelResponse = { runId: string; status: 'cancelling' };

const phaseLabels: Record<AguiLabState['phase'], string> = {
  idle: '等待开始',
  running: STATIC_MODE ? '本地事件接收中' : 'SSE 接收中',
  success: '运行成功',
  cancelled: '协议已取消',
  error: 'Agent 报错',
  truncated: STATIC_MODE ? '本地流已截断' : 'HTTP 流已截断',
};

export default function AguiLab({ onTrace, onResetTrace }: LabProps) {
  const [city, setCity] = useState<TripCity>('杭州');
  const [days, setDays] = useState(3);
  const [scenario, setScenario] = useState<Scenario>('success');
  const [preference, setPreference] = useState('喜欢慢节奏、城市漫步和本地小吃');
  const [state, setState] = useState(createInitialAguiState);
  const [connecting, setConnecting] = useState(false);
  const [requestError, setRequestError] = useState<string>();
  const [cancelError, setCancelError] = useState<string>();
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const cancelControllerRef = useRef<AbortController | undefined>(undefined);
  const manualAbortRef = useRef(false);
  const lastRequestRef = useRef<
    { city: TripCity; days: number; scenario: Scenario; preference: string } | undefined
  >(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      cancelControllerRef.current?.abort();
    };
  }, []);

  function commit(next: AguiLabState, sequence: number): void {
    if (!mountedRef.current || requestSequenceRef.current !== sequence) return;
    stateRef.current = next;
    setState(next);
  }

  function applyEvent(value: unknown, sequence: number): void {
    if (!mountedRef.current || requestSequenceRef.current !== sequence) return;
    const event = parseAguiEvent(value);
    setConnecting(false);
    onTrace({
      protocol: 'agui',
      direction: 'server→client',
      label: event.type,
      payload: event,
      note: traceNote(event.type),
    });
    commit(aguiReducer(stateRef.current, { kind: 'event', event }), sequence);
  }

  async function startRun(options = { city, days, scenario, preference }): Promise<void> {
    if (connecting || stateRef.current.phase === 'running') return;
    const sequence = ++requestSequenceRef.current;
    controllerRef.current?.abort();
    cancelControllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    manualAbortRef.current = false;
    lastRequestRef.current = options;
    stateRef.current = createInitialAguiState();
    setState(stateRef.current);
    setConnecting(true);
    setRequestError(undefined);
    setCancelError(undefined);
    onResetTrace();

    const runId = uniqueId('run');
    const input: RunAgentInput = {
      threadId: uniqueId('thread'),
      runId,
      protocolVersion: PROTOCOL_VERSION,
      messages: [
        {
          id: uniqueId('user'),
          role: 'user',
          content: `请规划${options.city}${options.days}天行程。旅行偏好：${options.preference.trim() || '无特别偏好'}。`,
        },
      ],
      tools: [
        {
          name: 'lookup_trip_fixture',
          description: '读取本地、确定性的城市行程 fixture。',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' }, days: { type: 'integer' } },
            required: ['city', 'days'],
          },
        },
      ],
      context: [{ description: '实验模式', value: 'deterministic-agent; no LLM' }],
      forwardedProps: options,
    };

    onTrace({
      protocol: 'agui',
      direction: 'client→server',
      label: 'POST /api/agui',
      payload: input,
      note: '标准 RunAgentInput；每次重试都会生成新的 runId。',
    });

    try {
      const response = await labFetch('/api/agui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      await consumeSse(response, (value) => applyEvent(value, sequence), controller.signal);
      if (!mountedRef.current || requestSequenceRef.current !== sequence) return;
      commit(finalizeAguiStream(stateRef.current), sequence);
    } catch (error) {
      if (!mountedRef.current || requestSequenceRef.current !== sequence) return;
      if (controller.signal.aborted) {
        if (manualAbortRef.current) {
          const next = aguiReducer(stateRef.current, {
            kind: 'transport-error',
            message: STATIC_MODE
              ? '浏览器主动中断了本地流；这不是 AG-UI cancelled 结果。'
              : '浏览器主动中断了 HTTP 连接；这不是 AG-UI cancelled 结果。',
          });
          commit(next, sequence);
        }
        return;
      }
      const message = errorMessage(error);
      setRequestError(message);
      commit(aguiReducer(stateRef.current, { kind: 'transport-error', message }), sequence);
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
        if (mountedRef.current && requestSequenceRef.current === sequence) setConnecting(false);
      }
    }
  }

  async function requestProtocolCancellation(): Promise<void> {
    const runId = stateRef.current.runId;
    if (!runId || stateRef.current.phase !== 'running') return;
    const sequence = requestSequenceRef.current;
    setCancelError(undefined);
    cancelControllerRef.current?.abort();
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    const payload = { runId };
    onTrace({
      protocol: 'agui',
      direction: 'client→server',
      label: `POST /api/agui/${runId}/cancel`,
      payload,
      note: STATIC_MODE
        ? '浏览器内取消处理器；本地流继续接收，Agent 会有序关闭开放事件。'
        : '实验扩展端点；SSE 保持连接，服务端会有序关闭开放事件。',
    });
    try {
      const result = await fetchJson<CancelResponse>(
        `/api/agui/${encodeURIComponent(runId)}/cancel`,
        { method: 'POST', body: '{}', signal: controller.signal },
      );
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        requestSequenceRef.current !== sequence
      )
        return;
      onTrace({
        protocol: 'agui',
        direction: 'server→client',
        label: '取消请求已接受',
        payload: result,
        note: '等待 RUN_FINISHED cancelled。',
      });
    } catch (error) {
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        requestSequenceRef.current === sequence
      )
        setCancelError(errorMessage(error));
    } finally {
      if (cancelControllerRef.current === controller) cancelControllerRef.current = undefined;
    }
  }

  function abortHttp(): void {
    if (!controllerRef.current || stateRef.current.phase !== 'running') return;
    manualAbortRef.current = true;
    onTrace({
      protocol: 'agui',
      direction: 'local',
      label: 'AbortController.abort()',
      payload: { runId: stateRef.current.runId },
      note: STATIC_MODE
        ? '仅中断浏览器内的本地流；不会伪造 RUN_FINISHED cancelled。'
        : '仅断开 HTTP；不会伪造 RUN_FINISHED cancelled。',
    });
    controllerRef.current.abort();
  }

  const isRunning = state.phase === 'running';
  const busy = connecting || isRunning;
  const canRetry = state.phase === 'error' || state.phase === 'truncated' || Boolean(requestError);

  return (
    <>
      <div className="panel-heading">
        <span>
          <Bot size={17} aria-hidden="true" /> 行程规划 Agent
        </span>
        <span
          className={`badge ${state.phase === 'success' ? 'success' : busy ? 'purple' : ''}`}
          role="status"
          aria-live="polite"
        >
          {busy && <LoaderCircle className="spinner" size={12} aria-hidden="true" />}
          {connecting
            ? STATIC_MODE
              ? '正在启动本地流'
              : '正在连接 SSE'
            : phaseLabels[state.phase]}
        </span>
      </div>

      <div className="lab-body">
        <p className="lab-description">
          {STATIC_MODE
            ? '确定性 Agent 在浏览器内生成 AG-UI 1.0 事件，并用本地 ReadableStream 演示 SSE 编码；没有 HTTP / SSE 网络连接。'
            : '确定性 Agent + fixture 数据（不调用 LLM），但请求、SSE、工具与状态事件都使用真实 AG-UI 1.0 契约。'}
        </p>

        <div className="form-row">
          <div className="form-field">
            <label htmlFor="agui-city">目的地</label>
            <select
              id="agui-city"
              value={city}
              onChange={(event) => setCity(event.target.value as TripCity)}
              disabled={busy}
            >
              {TRIP_CITIES.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="agui-days">行程天数</label>
            <select
              id="agui-days"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              disabled={busy}
            >
              {[2, 3, 4, 5].map((option) => (
                <option key={option} value={option}>
                  {option} 天
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-field">
          <label htmlFor="agui-scenario">运行场景</label>
          <select
            id="agui-scenario"
            value={scenario}
            onChange={(event) => setScenario(event.target.value as Scenario)}
            disabled={busy}
          >
            <option value="success">成功路径</option>
            <option value="error">模拟错误</option>
          </select>
        </div>

        <div className="form-field">
          <label htmlFor="agui-preference">旅行偏好</label>
          <textarea
            id="agui-preference"
            value={preference}
            onChange={(event) => setPreference(event.target.value)}
            disabled={busy}
            maxLength={160}
            aria-describedby="agui-preference-hint"
          />
          <span id="agui-preference-hint" className="hint">
            它会进入真实 RunAgentInput，方便观察请求如何影响 Agent 输出。
          </span>
        </div>

        <div className="button-row">
          <button
            type="button"
            className="button primary"
            onClick={() => void startRun()}
            disabled={busy}
          >
            {busy ? (
              <LoaderCircle className="spinner" size={15} aria-hidden="true" />
            ) : (
              <MapPinned size={15} aria-hidden="true" />
            )}
            {connecting ? '正在连接…' : '开始运行'}
          </button>
          {isRunning && (
            <button
              type="button"
              className="button danger"
              onClick={() => void requestProtocolCancellation()}
            >
              <CircleStop size={15} aria-hidden="true" /> 协议取消
            </button>
          )}
          {isRunning && (
            <button type="button" className="button secondary" onClick={abortHttp}>
              <Unplug size={15} aria-hidden="true" /> {STATIC_MODE ? '中断本地流' : '中断 HTTP'}
            </button>
          )}
          {canRetry && lastRequestRef.current && (
            <button
              type="button"
              className="button secondary"
              onClick={() => void startRun(lastRequestRef.current!)}
            >
              <RotateCcw size={15} aria-hidden="true" /> 重试运行
            </button>
          )}
        </div>
        <p className="hint">
          “协议取消”会收到 cancelled 终止事件；{STATIC_MODE ? '“中断本地流”' : '“中断 HTTP”'}
          只会产生截断流。组件卸载也只中断传输，且不会继续更新 React 状态。
        </p>

        {requestError && (
          <div className="error-banner" role="alert">
            {requestError}
          </div>
        )}
        {cancelError && (
          <div className="inline-error" role="alert">
            取消请求失败：{cancelError}{' '}
            <button
              type="button"
              className="text-button"
              onClick={() => void requestProtocolCancellation()}
            >
              重试取消
            </button>
          </div>
        )}

        {state.messages.map((message) => (
          <div key={message.id}>
            <div className="message-label">
              <Bot size={14} aria-hidden="true" /> assistant ·{' '}
              {message.complete ? '消息已关闭' : '正在流式生成'}
            </div>
            <div className="message-bubble assistant">{message.text || '…'}</div>
          </div>
        ))}

        {state.toolCalls.map((tool) => (
          <div className="tool-card" key={tool.id}>
            <strong>
              <Wrench size={13} aria-hidden="true" /> {tool.name}
            </strong>
            <div>
              状态：
              {tool.status === 'streaming'
                ? '参数流式到达'
                : tool.status === 'called'
                  ? '等待工具结果'
                  : '已返回结果'}
            </div>
            <pre>{tool.argsText || '等待参数…'}</pre>
            {tool.result && (
              <details>
                <summary>查看 fixture 结果</summary>
                <pre>{formatJson(tool.result)}</pre>
              </details>
            )}
          </div>
        ))}

        {state.agentState && (
          <section className="state-card" aria-labelledby="agui-state-title">
            <h3 id="agui-state-title">
              共享状态 · {state.agentState.city} {state.agentState.days} 天
            </h3>
            <div className="task-list">
              {state.agentState.tasks.map((task) => (
                <div key={task.id} className={`task-item ${task.status === 'done' ? 'done' : ''}`}>
                  {task.status === 'done' ? (
                    <Check size={14} aria-hidden="true" />
                  ) : (
                    <Circle size={14} aria-hidden="true" />
                  )}
                  {task.label}
                </div>
              ))}
            </div>
            {state.agentState.itinerary.length > 0 && (
              <div className="message-bubble">{state.agentState.itinerary.join('\n')}</div>
            )}
          </section>
        )}

        {state.phase === 'cancelled' && (
          <div className="hint">
            <CircleStop size={14} aria-hidden="true" /> {STATIC_MODE ? '浏览器内 Agent' : '服务端'}
            已关闭开放的消息/工具调用，并发送 `RUN_FINISHED` + `cancelled`。
          </div>
        )}
        {state.phase === 'truncated' && (
          <div className="error-banner">
            <AlertTriangle size={14} aria-hidden="true" /> {state.error}
          </div>
        )}
        {state.phase === 'error' && (
          <div className="error-banner">
            <AlertTriangle size={14} aria-hidden="true" /> {state.error}
          </div>
        )}
      </div>

      <div className="experiment-footer">
        教学客户端手写 reducer，仅覆盖本页事件；STATE_DELTA 只实现安全的 RFC 6902 replace 子集。
      </div>
    </>
  );
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function traceNote(type: string): string {
  if (type === EventType.STATE_DELTA) return 'RFC 6902 patch；本客户端只执行 replace。';
  if (type === EventType.TOOL_CALL_ARGS) return 'delta 可能被拆成多段，客户端先拼接再解析。';
  if (type === EventType.RUN_ERROR) return '这是格式正确的协议失败，不是 HTTP 错误。';
  if (type === EventType.RUN_FINISHED) return '终止事件决定 success / cancelled。';
  return '已通过 @ag-ui/core EventSchemas 校验。';
}

function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
