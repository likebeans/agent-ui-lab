import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  LayoutTemplate,
  LoaderCircle,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { ChatContext, ChatTurnProps } from '../../shared/chat';
import type { LabProps, TraceInput } from '../../shared/trace';
import { fetchJson, errorMessage } from '../../shared/http';
import { readPointer, type JsonValue } from '../../shared/json-pointer';
import { A2uiWorkshop, type A2uiActionEvidence } from '../components/A2uiWorkshop';
import { SurfaceRenderer } from '../components/A2uiSurfaceRenderer';
import {
  a2uiResponseSchema,
  applyA2uiMessages,
  normalizeA2uiPath,
  resolveA2uiAction,
  updateA2uiBinding,
  type A2uiComponent,
  type A2uiMessage,
  type A2uiSurface,
} from '../../shared/a2ui';

export { SurfaceRenderer } from '../components/A2uiSurfaceRenderer';
export type { SurfaceRendererProps, A2uiFieldIssue } from '../components/A2uiSurfaceRenderer';

type RequestState = 'idle' | 'loading' | 'submitting' | 'deleting';
type RetryKind = 'load' | 'submit' | 'delete' | null;

function messageLabel(message: A2uiMessage): string {
  if ('createSurface' in message) return 'createSurface';
  if ('updateDataModel' in message) return 'updateDataModel';
  if ('updateComponents' in message) return 'updateComponents';
  return 'deleteSurface';
}

function receiveA2uiMessages(
  current: A2uiSurface | null,
  payload: unknown,
  onTrace: (entry: TraceInput) => void,
): { messages: A2uiMessage[]; next: A2uiSurface | null } {
  const parsed = a2uiResponseSchema.parse(payload);
  const next = applyA2uiMessages(current, parsed.messages);
  for (const message of parsed.messages) {
    onTrace({
      protocol: 'a2ui',
      direction: 'server→client',
      label: messageLabel(message),
      payload: message,
      note:
        messageLabel(message) === 'updateComponents'
          ? 'Renderer 按组件 ID 全量替换定义，再从 root 解析引用。'
          : undefined,
    });
  }
  return { messages: parsed.messages, next };
}

const reactElementByComponent: Record<A2uiComponent['component'], string> = {
  Card: '<div>',
  Column: '<div>',
  Text: '<div> / <span>',
  TextField: '<input>',
  ChoicePicker: '<select>',
  Button: '<button>',
};

const destinationLabels: Record<string, string> = {
  hangzhou: '杭州',
  chengdu: '成都',
  xiamen: '厦门',
  shanghai: '上海',
};

const chatCities: Partial<Record<string, ChatContext['city']>> = {
  hangzhou: '杭州',
  chengdu: '成都',
  shanghai: '上海',
};

export function A2uiChatTurn({
  request,
  onTrace,
  onComplete,
  onInteraction,
  onInspectTrace,
}: ChatTurnProps) {
  const [surface, setSurface] = useState<A2uiSurface | null>(null);
  const [initialSurface, setInitialSurface] = useState<A2uiSurface | null>(null);
  const [messages, setMessages] = useState<A2uiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);
  const [actionEvidence, setActionEvidence] = useState<A2uiActionEvidence | null>(null);
  const surfaceRef = useRef<A2uiSurface | null>(null);
  const mounted = useRef(true);
  const activeRequestId = useRef(request.id);
  const controllers = useRef(new Set<AbortController>());
  const completedRequest = useRef<string | null>(null);
  const callbacks = useRef({ onTrace, onComplete, onInteraction });
  const rendererId = useId();
  callbacks.current = { onTrace, onComplete, onInteraction };

  const requestJson = useCallback(async (url: string, options: RequestInit): Promise<unknown> => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort('timeout'), 8_000);
    try {
      return await fetchJson<unknown>(url, { ...options, signal: controller.signal });
    } catch (requestError) {
      if (controller.signal.reason === 'timeout')
        throw new Error('请求超时，请确认本地服务已启动后重试。');
      throw requestError;
    } finally {
      window.clearTimeout(timeout);
      controllers.current.delete(controller);
    }
  }, []);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    activeRequestId.current = request.id;
    surfaceRef.current = null;
    setSurface(null);
    setInitialSurface(null);
    setMessages([]);
    setSelectedComponentId(null);
    setActionEvidence(null);
    setSubmitting(false);
    setError('');
    setLoading(true);

    const completeOnce = (summary: string) => {
      if (completedRequest.current === request.id) return;
      completedRequest.current = request.id;
      callbacks.current.onComplete(summary);
    };

    callbacks.current.onTrace({
      protocol: 'a2ui',
      direction: 'client→server',
      label: 'surface/request',
      payload: { method: 'POST', path: '/api/a2ui/surface', body: request },
      note: '本地确定性 builder 根据本轮 prompt 与 context 组装声明；这里没有调用 LLM。',
    });

    void (async () => {
      try {
        const payload = await requestJson('/api/a2ui/surface', {
          method: 'POST',
          body: JSON.stringify(request),
        });
        if (!active) return;
        const received = receiveA2uiMessages(null, payload, callbacks.current.onTrace);
        if (!received.next) throw new Error('服务端未创建 Surface。');
        surfaceRef.current = received.next;
        setSurface(received.next);
        setInitialSurface(structuredClone(received.next));
        setMessages(received.messages);
        const summary = surfaceSummary(received.next);
        completeOnce(`${summary}，可以继续填写并提交。`);
      } catch (requestError) {
        if (!active) return;
        const message = errorMessage(requestError);
        setError(message);
        callbacks.current.onTrace({
          protocol: 'a2ui',
          direction: 'local',
          label: 'request/error',
          payload: { message },
        });
        completeOnce(`A2UI 表单生成失败：${message}`);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      mounted.current = false;
      if (activeRequestId.current === request.id) activeRequestId.current = '';
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [request, requestJson]);

  const updateBinding = useCallback((path: string, value: JsonValue) => {
    const current = surfaceRef.current;
    if (!current) return;
    try {
      const next = updateA2uiBinding(current, path, value);
      surfaceRef.current = next;
      setSurface(next);
      setError('');
      callbacks.current.onTrace({
        protocol: 'a2ui',
        direction: 'local',
        label: 'binding/write',
        payload: { surfaceId: current.surfaceId, path, value },
        note: '本地双向绑定只更新这一轮的内存数据模型，不改组件声明。',
      });
    } catch (bindingError) {
      const message = errorMessage(bindingError);
      setError(message);
      callbacks.current.onTrace({
        protocol: 'a2ui',
        direction: 'local',
        label: 'binding/error',
        payload: { path, message },
      });
    }
  }, []);

  const replaceLocalSurface = useCallback(
    (next: A2uiSurface) => {
      if (!mounted.current || activeRequestId.current !== request.id) return;
      surfaceRef.current = next;
      setSurface(next);
      setActionEvidence(null);
      setSelectedComponentId(null);
      setError('');
    },
    [request.id],
  );

  const submitAction = useCallback(
    async (sourceComponentId: string) => {
      const current = surfaceRef.current;
      const submittedRequestId = request.id;
      if (!current || submitting || activeRequestId.current !== submittedRequestId) return;
      let action;
      try {
        action = resolveA2uiAction(current, sourceComponentId);
      } catch (actionError) {
        setError(errorMessage(actionError));
        return;
      }

      setSubmitting(true);
      setError('');
      callbacks.current.onTrace({
        protocol: 'a2ui',
        direction: 'client→server',
        label: `action/${action.action.name}`,
        payload: action,
        note: '表单绑定值已解析为 action.context；服务端仍会重新校验。',
      });

      try {
        const payload = await requestJson('/api/a2ui/action', {
          method: 'POST',
          body: JSON.stringify(action),
        });
        if (!mounted.current || activeRequestId.current !== submittedRequestId) return;
        const received = receiveA2uiMessages(current, payload, callbacks.current.onTrace);
        if (!received.next) throw new Error('动作响应意外删除了 Surface。');
        surfaceRef.current = received.next;
        setSurface(received.next);
        const assistant = resultStatus(received.next);
        setActionEvidence({
          actionName: action.action.name,
          sourceComponentId: action.action.sourceComponentId,
          context: structuredClone(action.action.context),
          status: assistant,
          submittedSurface: structuredClone(current),
        });
        const exchange = submittedExchange(action.action.context, assistant);
        callbacks.current.onInteraction(exchange);
      } catch (requestError) {
        if (!mounted.current || activeRequestId.current !== submittedRequestId) return;
        const message = errorMessage(requestError);
        setError(message);
        callbacks.current.onTrace({
          protocol: 'a2ui',
          direction: 'local',
          label: 'request/error',
          payload: { message },
        });
      } finally {
        if (mounted.current && activeRequestId.current === submittedRequestId) setSubmitting(false);
      }
    },
    [request.id, requestJson, submitting],
  );

  if (loading) {
    return (
      <div className="chat-surface">
        <p className="chat-run-status" role="status">
          <LoaderCircle className="spinner" size={14} aria-hidden="true" />
          正在接收 A2UI 声明
          <span>本地确定性 builder</span>
        </p>
      </div>
    );
  }

  if (!surface) {
    return (
      <div className="chat-surface">
        <p className="agent-prose">这次没有生成可渲染的 Surface。</p>
        <p className="error-banner" role="alert">
          <AlertCircle size={15} aria-hidden="true" /> {error || 'A2UI 响应为空。'}
        </p>
      </div>
    );
  }

  const components = Object.values(surface.components);
  const selectedComponent = selectedComponentId
    ? surface.components[selectedComponentId]
    : undefined;
  const generationMessages = messages.filter(
    (message) =>
      'createSurface' in message || 'updateDataModel' in message || 'updateComponents' in message,
  );

  return (
    <div className="chat-surface">
      <p className="agent-prose">
        {surfaceSummary(surface)}。下面是真实可操作的生成表单；声明由本地确定性 builder
        组装，浏览器只把受支持的目录组件映射为 React 元素。
      </p>

      <div className="generation-steps" aria-label="本轮 A2UI 三阶段生成过程">
        <div className="chat-card-label">实际收到的 A2UI 消息</div>
        {generationMessages.map((message, index) => (
          <div className="task-item done" key={`${messageLabel(message)}-${index}`}>
            <CheckCircle2 size={14} aria-hidden="true" />
            <span>
              <code>{messageLabel(message)}</code> · {generationStep(message)}
            </span>
          </div>
        ))}
      </div>

      {error ? (
        <p className="error-banner" role="alert">
          <AlertCircle size={15} aria-hidden="true" /> {error}
        </p>
      ) : null}

      <div className="a2ui-renderer" id={rendererId} aria-label="A2UI 生成表单">
        <SurfaceRenderer
          surface={surface}
          disabled={submitting}
          submitting={submitting}
          selectedComponentId={selectedComponentId}
          onBindingChange={updateBinding}
          onAction={submitAction}
        />
      </div>

      <details className="chat-disclosure">
        <summary>
          声明如何变成 React 组件
          <span>{components.length} 个声明 · 当前数据模型</span>
        </summary>
        <p className="hint">
          <code>createSurface.catalogId</code> 选择 Basic Catalog；声明只携带目录中的类型名和属性，
          <code>SurfaceRenderer.renderComponent</code> 再用固定 switch 映射为 React
          节点，不执行服务端代码，也不是 LLM 生成 React 代码。选择声明可定位并追溯上方对应组件。
        </p>
        <div className="component-map" aria-label="A2UI 声明到 React 元素的本地映射">
          {components.map((component) => (
            <button
              type="button"
              key={component.id}
              aria-controls={rendererId}
              aria-pressed={selectedComponentId === component.id}
              aria-label={`定位声明 ${component.id}：${component.component} 映射为 ${reactElementByComponent[component.component]}`}
              onClick={() =>
                setSelectedComponentId((selected) =>
                  selected === component.id ? null : component.id,
                )
              }
            >
              <code>{component.id}</code> · {component.component} →{' '}
              {reactElementByComponent[component.component]}
            </button>
          ))}
        </div>
        {selectedComponent ? (
          <div className="causal-evidence" aria-live="polite">
            <div className="learning-eyebrow">声明 → 绑定 → 渲染节点 → 源函数</div>
            <strong>
              {selectedComponent.id} · {selectedComponent.component}
            </strong>
            <p>
              声明 <code>{selectedComponent.id}</code>
              {componentBindingDescription(selectedComponent)} →{' '}
              {reactElementByComponent[selectedComponent.component]} →{' '}
              <code>{componentSourceFunction(selectedComponent)}</code>
            </p>
            <code className="source-location">
              src/components/A2uiSurfaceRenderer.tsx · SurfaceRenderer.renderComponent
            </code>
            {onInspectTrace ? (
              <button
                type="button"
                className="learning-link"
                onClick={() => {
                  onTrace({
                    protocol: 'a2ui',
                    direction: 'local',
                    label: 'learning/a2ui-component',
                    payload: {
                      component: selectedComponent,
                      model: surface.model,
                      source:
                        'src/components/A2uiSurfaceRenderer.tsx · SurfaceRenderer.renderComponent',
                    },
                    note: '当前 renderer 使用的声明与模型快照，包含已应用的本地修改；不是服务端消息。',
                  });
                  onInspectTrace('learning/a2ui-component');
                }}
              >
                在检查器中查看当前组件声明
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="chat-card-label">updateComponents.components</div>
        <pre>{JSON.stringify(components, null, 2)}</pre>
        <div className="chat-card-label">当前数据模型</div>
        <pre>{JSON.stringify(surface.model, null, 2)}</pre>
      </details>

      {initialSurface ? (
        <A2uiWorkshop
          key={request.id}
          initialSurface={initialSurface}
          surface={surface}
          disabled={submitting}
          actionEvidence={actionEvidence}
          onCommit={replaceLocalSurface}
          onReset={replaceLocalSurface}
          onTrace={onTrace}
          onInspectTrace={onInspectTrace}
        />
      ) : null}
    </div>
  );
}

export default function A2uiLab({ onTrace, onResetTrace }: LabProps) {
  const [surface, setSurface] = useState<A2uiSurface | null>(null);
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [retryKind, setRetryKind] = useState<RetryKind>(null);
  const [lastMessages, setLastMessages] = useState<A2uiMessage[]>([]);
  const mounted = useRef(true);
  const controllers = useRef(new Set<AbortController>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, []);

  const requestJson = useCallback(async (url: string, options?: RequestInit): Promise<unknown> => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort('timeout'), 8_000);
    try {
      return await fetchJson<unknown>(url, { ...options, signal: controller.signal });
    } catch (requestError) {
      if (controller.signal.reason === 'timeout')
        throw new Error('请求超时，请确认本地服务已启动后重试。');
      throw requestError;
    } finally {
      window.clearTimeout(timeout);
      controllers.current.delete(controller);
    }
  }, []);

  const receiveMessages = useCallback(
    (current: A2uiSurface | null, payload: unknown) =>
      receiveA2uiMessages(current, payload, onTrace),
    [onTrace],
  );

  const fail = useCallback(
    (requestError: unknown, retry: Exclude<RetryKind, null>) => {
      if (!mounted.current) return;
      const message = errorMessage(requestError);
      setError(message);
      setRetryKind(retry);
      setRequestState('idle');
      onTrace({
        protocol: 'a2ui',
        direction: 'local',
        label: 'request/error',
        payload: { message },
      });
    },
    [onTrace],
  );

  const loadSurface = useCallback(async () => {
    if (requestState !== 'idle') return;
    setRequestState('loading');
    setError(null);
    setRetryKind(null);
    onTrace({
      protocol: 'a2ui',
      direction: 'client→server',
      label: 'surface/request',
      payload: { method: 'POST', path: '/api/a2ui/surface' },
      note: '请求确定性 Agent 生成 fixture Surface；这里没有调用 LLM。',
    });
    try {
      const payload = await requestJson('/api/a2ui/surface', { method: 'POST', body: '{}' });
      if (!mounted.current) return;
      const received = receiveMessages(null, payload);
      if (!received.next) throw new Error('服务端未创建 Surface。');
      setSurface(received.next);
      setLastMessages(received.messages);
      setRequestState('idle');
    } catch (requestError) {
      fail(requestError, 'load');
    }
  }, [fail, onTrace, receiveMessages, requestJson, requestState]);

  const submitAction = useCallback(async () => {
    if (!surface || requestState !== 'idle') return;
    let action;
    try {
      action = resolveA2uiAction(surface, 'submit');
    } catch (actionError) {
      fail(actionError, 'submit');
      return;
    }
    setRequestState('submitting');
    setError(null);
    setRetryKind(null);
    onTrace({
      protocol: 'a2ui',
      direction: 'client→server',
      label: `action/${action.action.name}`,
      payload: action,
      note: 'context 已在客户端从绑定路径解析；发送的是 action，不是 userAction。',
    });
    try {
      const payload = await requestJson('/api/a2ui/action', {
        method: 'POST',
        body: JSON.stringify(action),
      });
      if (!mounted.current) return;
      const received = receiveMessages(surface, payload);
      if (!received.next) throw new Error('动作响应意外删除了 Surface。');
      setSurface(received.next);
      setLastMessages(received.messages);
      setRequestState('idle');
    } catch (requestError) {
      fail(requestError, 'submit');
    }
  }, [fail, onTrace, receiveMessages, requestJson, requestState, surface]);

  const deleteSurface = useCallback(async () => {
    if (!surface || requestState !== 'idle') return;
    const current = surface;
    onResetTrace();
    setRequestState('deleting');
    setError(null);
    setRetryKind(null);
    onTrace({
      protocol: 'a2ui',
      direction: 'client→server',
      label: 'surface/delete',
      payload: { method: 'DELETE', surfaceId: current.surfaceId },
    });
    try {
      const payload = await requestJson(
        `/api/a2ui/surface/${encodeURIComponent(current.surfaceId)}`,
        { method: 'DELETE' },
      );
      if (!mounted.current) return;
      const received = receiveMessages(current, payload);
      if (received.next !== null) throw new Error('服务端未返回 deleteSurface。');
      setSurface(null);
      setLastMessages(received.messages);
      setRequestState('idle');
    } catch (requestError) {
      fail(requestError, 'delete');
    }
  }, [fail, onResetTrace, onTrace, receiveMessages, requestJson, requestState, surface]);

  const updateBinding = useCallback(
    (path: string, value: JsonValue) => {
      if (!surface) return;
      setError(null);
      setRetryKind(null);
      try {
        const next = updateA2uiBinding(surface, path, value);
        setSurface(next);
        onTrace({
          protocol: 'a2ui',
          direction: 'local',
          label: 'binding/write',
          payload: { surfaceId: surface.surfaceId, path, value },
          note: '本地双向绑定只更新数据模型，不改组件声明。',
        });
      } catch (bindingError) {
        const message = errorMessage(bindingError);
        setError(message);
        onTrace({
          protocol: 'a2ui',
          direction: 'local',
          label: 'binding/error',
          payload: { path, message },
        });
      }
    },
    [onTrace, surface],
  );

  const retry =
    retryKind === 'load' ? loadSurface : retryKind === 'submit' ? submitAction : deleteSurface;
  const busy = requestState !== 'idle';

  return (
    <>
      <div className="panel-heading">
        <span>
          <LayoutTemplate size={17} aria-hidden="true" /> A2UI Runtime
        </span>
        <span className="badge purple">v0.9.1 · 单 Surface</span>
      </div>
      <div className="lab-body">
        <p className="lab-description">
          确定性 Agent 使用 fixture 数据下发真实 A2UI 消息。Renderer 仅允许六种目录组件，不执行 HTML
          或脚本；本实验不会预订行程。
        </p>

        <div className="button-row">
          {!surface ? (
            <button className="button primary" type="button" onClick={loadSurface} disabled={busy}>
              {requestState === 'loading' ? (
                <LoaderCircle className="spinner" size={15} aria-hidden="true" />
              ) : (
                <LayoutTemplate size={15} aria-hidden="true" />
              )}
              {requestState === 'loading' ? '正在生成…' : '生成 A2UI 界面'}
            </button>
          ) : (
            <>
              <span className="run-status">
                <CheckCircle2 size={14} aria-hidden="true" /> Surface：{surface.surfaceId}
              </span>
              <button
                className="button danger"
                type="button"
                onClick={deleteSurface}
                disabled={busy}
              >
                {requestState === 'deleting' ? (
                  <LoaderCircle className="spinner" size={15} aria-hidden="true" />
                ) : (
                  <Trash2 size={15} aria-hidden="true" />
                )}
                {requestState === 'deleting' ? '正在删除…' : '删除 Surface 并重置'}
              </button>
            </>
          )}
        </div>

        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={15} aria-hidden="true" /> {error}
            {retryKind && (
              <button className="button secondary" type="button" onClick={retry} disabled={busy}>
                <RefreshCw size={14} aria-hidden="true" /> 重试
              </button>
            )}
          </div>
        )}

        {surface ? (
          <>
            <div className="a2ui-renderer" aria-label="A2UI 生成界面">
              <SurfaceRenderer
                surface={surface}
                disabled={busy}
                submitting={requestState === 'submitting'}
                onBindingChange={updateBinding}
                onAction={submitAction}
              />
            </div>
            <details className="a2ui-json">
              <summary>查看扁平组件声明（按 ID 引用）</summary>
              <pre>{JSON.stringify(Object.values(surface.components), null, 2)}</pre>
            </details>
            <details className="a2ui-json">
              <summary>查看当前数据模型（双向绑定）</summary>
              <pre>{JSON.stringify(surface.model, null, 2)}</pre>
            </details>
            <details className="a2ui-json">
              <summary>查看最近一组服务端消息</summary>
              <pre>{JSON.stringify(lastMessages, null, 2)}</pre>
            </details>
          </>
        ) : (
          <div className="empty-state">
            <LayoutTemplate size={28} aria-hidden="true" />
            <h3>尚未创建 Surface</h3>
            <p>
              点击“生成 A2UI 界面”，依次观察 createSurface、updateDataModel 与 updateComponents。
            </p>
          </div>
        )}
      </div>
      <div className="experiment-footer">
        官方 Basic Catalog：<code>…/specification/v0_9/catalogs/basic/catalog.json</code> · 组件按
        ID 全量替换 · 根路径 <code>/</code> 在 A2UI 边界归一化
      </div>
    </>
  );
}

function surfaceSummary(surface: A2uiSurface): string {
  const destination = bindingValueByPath(surface, '/form/destination');
  const days = bindingValueByPath(surface, '/form/days');
  const destinationId = Array.isArray(destination) ? destination[0] : undefined;
  const city = typeof destinationId === 'string' ? destinationLabels[destinationId] : undefined;
  return `已按“${city ?? '当前城市'} · ${typeof days === 'string' ? days : '?'} 天”生成 A2UI Surface`;
}

function resultStatus(surface: A2uiSurface): string {
  const status = bindingValueByPath(surface, '/result/status');
  return typeof status === 'string' ? status : '表单已提交。';
}

function submittedExchange(
  context: Record<string, JsonValue>,
  assistant: string,
): { user: string; assistant: string; context?: ChatContext } {
  const destination = Array.isArray(context.destination) ? context.destination[0] : undefined;
  const traveler = typeof context.traveler === 'string' ? context.traveler : '';
  const daysText = typeof context.days === 'string' ? context.days : '';
  const partySize = typeof context.partySize === 'string' ? context.partySize : '';
  const budget = typeof context.budget === 'string' ? context.budget : '';
  const city = typeof destination === 'string' ? destinationLabels[destination] : undefined;
  const days = Number(daysText);
  const sharedCity = typeof destination === 'string' ? chatCities[destination] : undefined;
  const nextContext =
    sharedCity && Number.isInteger(days) && days >= 1 && days <= 7
      ? { city: sharedCity, days }
      : undefined;
  const optionalDetails = [
    partySize ? `${partySize} 人` : null,
    budget ? `预算 ${budget} 元` : null,
  ].filter((detail): detail is string => detail !== null);
  return {
    user: `提交表单：${traveler} · ${city ?? '未知目的地'} · ${daysText} 天${optionalDetails.length > 0 ? ` · ${optionalDetails.join(' · ')}` : ''}`,
    assistant,
    ...(nextContext ? { context: nextContext } : {}),
  };
}

function componentBindingDescription(component: A2uiComponent): string {
  if (component.component === 'TextField' || component.component === 'ChoicePicker') {
    return ` 读取并写回 ${component.value.path}`;
  }
  if (component.component === 'Text' && typeof component.text !== 'string') {
    return ` 读取 ${component.text.path}`;
  }
  if (component.component === 'Button') {
    const paths = Object.values(component.action.event.context).map((reference) => reference.path);
    return ` 解析 action.context（${paths.join('、') || '空'}）`;
  }
  if (component.component === 'Card') return ` 引用 child=${component.child}`;
  if (component.component === 'Column')
    return ` 按 children 引用 ${component.children.length} 个节点`;
  return ' 使用静态 text';
}

function componentSourceFunction(component: A2uiComponent): string {
  if (component.component === 'TextField' || component.component === 'ChoicePicker') {
    return 'bindingValue + updateA2uiBinding';
  }
  if (component.component === 'Text') return 'resolveA2uiText';
  if (component.component === 'Button') return 'resolveA2uiAction';
  return 'renderComponent';
}

function generationStep(message: A2uiMessage): string {
  if ('createSurface' in message) return `创建 ${message.createSurface.surfaceId}`;
  if ('updateDataModel' in message) return `写入数据模型 ${message.updateDataModel.path}`;
  if ('updateComponents' in message)
    return `声明 ${message.updateComponents.components.length} 个组件`;
  return `删除 ${message.deleteSurface.surfaceId}`;
}

function bindingValueByPath(surface: A2uiSurface, path: string): JsonValue | undefined {
  return readPointer(surface.model, normalizeA2uiPath(path));
}
