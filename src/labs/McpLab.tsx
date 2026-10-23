import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type Tool,
  type Transport,
  type TransportSendOptions,
} from '@modelcontextprotocol/client';
import {
  AppBridge,
  PostMessageTransport,
  RESOURCE_MIME_TYPE,
  getToolUiResourceUri,
  type McpUiResourceMeta,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import { Box, CheckCircle2, Circle, LoaderCircle, PlugZap, RotateCw, Square } from 'lucide-react';
import type { LabProps, TraceInput } from '../../shared/trace';
import type { ChatTurnProps } from '../../shared/chat';
import { errorMessage } from '../../shared/http';
import { STATIC_MODE } from '../../shared/runtime';
import { PredictionLesson, type ExperimentEvidence } from '../components/PredictionLesson';

const RESOURCE_URI = 'ui://intelligent-ui/trip-picker';
const LIST_RESOURCE_URI = 'ui://intelligent-ui/trip-picker-list';
const TOOL_NAME = 'get_trip_activities';
const HOST_INFO = { name: 'intelligent-ui-learning-host', version: '0.1.0' };
const INITIAL_INPUT: ToolInput = { city: 'shanghai' };
const APP_MARKER = '<!-- intelligent-ui-lab:mcp-trip-picker -->';
const CITY_OPTIONS = [
  { id: 'shanghai', label: '上海' },
  { id: 'chengdu', label: '成都' },
  { id: 'hangzhou', label: '杭州' },
] as const;
const ALLOWED_RESOURCE_URIS = [RESOURCE_URI, LIST_RESOURCE_URI] as const;
const TOOL_METADATA_TRACE_LABEL = 'MCP tools/list response · actual discovered tool metadata';
const RESOURCE_LIST_TRACE_LABEL = 'MCP resources/list response · registered UI resources';

const EMPTY_METRICS: ExecutionMetrics = {
  resourceReads: 0,
  iframeMounts: 0,
  toolCalls: 0,
};

type Phase = 'idle' | 'opening' | 'waiting-app' | 'ready' | 'closing' | 'error';
type TraceDirection = TraceInput['direction'];
type CityId = (typeof CITY_OPTIONS)[number]['id'];
type ToolInput = { city: CityId };
type TraceChannel = 'server' | 'app';
type MetricName = keyof ExecutionMetrics;

type TripData = {
  city: CityId;
  cityLabel: string;
  theme: string;
  activities: Array<{
    id: string;
    title: string;
    summary: string;
    duration: string;
    pace: string;
  }>;
  source: 'local-fixture';
  deterministic: true;
};

type LoadedResource = {
  uri: string;
  mimeType: string;
  html: string;
  sourceExcerpt: string;
  sourceLength: number;
  meta?: McpUiResourceMeta;
  traceLabel: string;
};

type ResourceEvidence = Omit<LoadedResource, 'html'>;

type ResourceChoice = {
  uri: string;
  name: string;
  title?: string;
  mimeType?: string;
};

type HandshakeEvidence = {
  resourceUri: string;
  protocolVersion: string;
  appInfo: unknown;
  appCapabilities: unknown;
  hostInfo: typeof HOST_INFO;
  traceLabel: string;
};

type ToolResultEvidence = {
  input: ToolInput;
  result: CallToolResult;
  traceLabel: string;
};

type ExecutionMetrics = {
  resourceReads: number;
  iframeMounts: number;
  toolCalls: number;
};

type LayoutExperimentEvidence = {
  summary: string;
  traceLabel: string;
  payload: unknown;
};

type ReadyWaiter = {
  frameToken: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (cause: unknown) => void;
};

type Session = {
  generation: number;
  client: Client;
  bridge?: AppBridge;
  initialized: boolean;
  hostStarting: boolean;
  latestResult: CallToolResult;
  currentInput: ToolInput;
  tool: Tool;
  resources: ResourceChoice[];
  activeResource: LoadedResource;
  frameToken: number;
  readyWaiter?: ReadyWaiter;
};

type TraceContext = {
  method: string;
  detail?: string;
};

class TracedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private readonly pending = new Map<string, TraceContext>();

  constructor(
    private readonly inner: Transport,
    private readonly outgoing: TraceDirection,
    private readonly incoming: TraceDirection,
    private readonly trace: (entry: TraceInput) => void,
    private readonly note: string,
    private readonly channel: TraceChannel,
    private readonly scope?: string,
    private readonly observe?: (message: JSONRPCMessage) => void,
  ) {}

  get hasPerRequestStream(): boolean | undefined {
    return this.inner.hasPerRequestStream;
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  set sessionId(value: string | undefined) {
    this.inner.sessionId = value;
  }

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => {
      this.record(message, this.incoming);
      this.onmessage?.(message, extra);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.record(message, this.outgoing);
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.inner.setSupportedProtocolVersions?.(versions);
  }

  private record(message: JSONRPCMessage, direction: TraceDirection): void {
    let context: TraceContext = { method: 'JSON-RPC' };
    let kind: 'request' | 'notification' | 'response' | 'error' = 'notification';

    if ('method' in message) {
      context = { method: message.method, detail: requestDetail(message) };
      kind = 'id' in message ? 'request' : 'notification';
      if ('id' in message) this.pending.set(String(message.id), context);
    } else if ('id' in message) {
      context = this.pending.get(String(message.id)) ?? context;
      this.pending.delete(String(message.id));
      kind = 'error' in message ? 'error' : 'response';
    }

    const label = traceLabel(this.channel, context, kind, this.scope);
    this.observe?.(message);
    this.trace({
      protocol: 'mcp',
      direction,
      label,
      payload: tracePayload(message, context.method),
      note:
        context.method === 'resources/read'
          ? `${this.note} 为避免把 SDK bundle 当教材倾倒，HTML text 仅显示实际文档标记、根节点与长度。`
          : this.note,
    });
  }
}

function requestDetail(message: JSONRPCMessage): string | undefined {
  if (!('method' in message)) return undefined;
  const params = 'params' in message ? message.params : undefined;
  if (!params || typeof params !== 'object') return undefined;
  const values = params as Record<string, unknown>;
  if (message.method === 'resources/read' && typeof values.uri === 'string') return values.uri;
  if (message.method === 'tools/call') {
    const args = values.arguments;
    if (
      args &&
      typeof args === 'object' &&
      typeof (args as Record<string, unknown>).city === 'string'
    ) {
      return `city=${String((args as Record<string, unknown>).city)}`;
    }
  }
  return undefined;
}

function resourceReadTraceLabel(uri: string): string {
  return `MCP resources/read response · ${uri}`;
}

function toolCallTraceLabel(city: CityId): string {
  return `MCP tools/call response · city=${city}`;
}

function handshakeTraceLabel(uri: string): string {
  return `MCP Apps ui/notifications/initialized · ${uri}`;
}

function traceLabel(
  channel: TraceChannel,
  context: TraceContext,
  kind: 'request' | 'notification' | 'response' | 'error',
  scope?: string,
): string {
  if (channel === 'server' && kind === 'response') {
    if (context.method === 'tools/list') return TOOL_METADATA_TRACE_LABEL;
    if (context.method === 'resources/list') return RESOURCE_LIST_TRACE_LABEL;
    if (context.method === 'resources/read' && context.detail)
      return resourceReadTraceLabel(context.detail);
    if (context.method === 'tools/call' && context.detail)
      return `MCP tools/call response · ${context.detail}`;
  }
  if (
    channel === 'app' &&
    context.method === 'ui/notifications/initialized' &&
    kind === 'notification' &&
    scope
  ) {
    return handshakeTraceLabel(scope);
  }
  const prefix = channel === 'server' ? 'MCP' : 'MCP Apps';
  const detail = context.detail ?? (channel === 'app' ? scope : undefined);
  return `${prefix} ${context.method} ${kind}${detail ? ` · ${detail}` : ''}`;
}

function tracePayload(message: JSONRPCMessage, method: string): unknown {
  if (method !== 'resources/read' || !('result' in message)) return message;
  const record = message as unknown as Record<string, unknown>;
  const result = record.result;
  if (!result || typeof result !== 'object') return message;
  const resultRecord = result as Record<string, unknown>;
  if (!Array.isArray(resultRecord.contents)) return message;

  return {
    ...record,
    result: {
      ...resultRecord,
      contents: resultRecord.contents.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const content = item as Record<string, unknown>;
        if (typeof content.text !== 'string') return item;
        const { text, ...metadata } = content;
        return {
          ...metadata,
          sourceExcerpt: resourceSourceExcerpt(text),
          sourceLength: text.length,
          textOmitted: '自包含 SDK bundle 未在教学记录中展开',
        };
      }),
    },
  };
}

function resourceSourceExcerpt(html: string): string {
  const doctype = html.match(/<!doctype html>/i)?.[0];
  const title = html.match(/<title>[^<]*<\/title>/i)?.[0];
  const marker = html.includes(APP_MARKER) ? APP_MARKER : undefined;
  const root = html.match(/<div id="app"[^>]*><\/div>/i)?.[0];
  return [doctype, title, marker, root].filter(Boolean).join('\n');
}

function resourceMeta(content: { _meta?: Record<string, unknown> }): McpUiResourceMeta | undefined {
  const ui = content._meta?.ui;
  return ui && typeof ui === 'object' ? (ui as McpUiResourceMeta) : undefined;
}

function parseAppResource(
  result: Awaited<ReturnType<Client['readResource']>>,
  uri: string,
): LoadedResource {
  const content = result.contents.find((item) => item.uri === uri && 'text' in item);
  if (!content || !('text' in content) || content.mimeType !== RESOURCE_MIME_TYPE) {
    throw new Error(`资源必须返回 ${RESOURCE_MIME_TYPE} 文本。`);
  }
  if (!content.text.includes(APP_MARKER)) throw new Error('拒绝加载非本实验生成的 App HTML。');
  const meta = resourceMeta(content);
  if (!meta?.csp || (meta.csp.connectDomains?.length ?? 0) > 0) {
    throw new Error('资源 CSP 必须明确禁止外部网络连接。');
  }
  return {
    uri,
    mimeType: content.mimeType,
    html: content.text,
    sourceExcerpt: resourceSourceExcerpt(content.text),
    sourceLength: content.text.length,
    meta,
    traceLabel: resourceReadTraceLabel(uri),
  };
}

function toResourceEvidence(resource: LoadedResource): ResourceEvidence {
  const { html: _html, ...evidence } = resource;
  return evidence;
}

function isTripData(value: unknown): value is TripData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TripData>;
  return (
    CITY_OPTIONS.some((city) => city.id === candidate.city) &&
    typeof candidate.cityLabel === 'string' &&
    typeof candidate.theme === 'string' &&
    candidate.source === 'local-fixture' &&
    candidate.deterministic === true &&
    Array.isArray(candidate.activities)
  );
}

function tripData(result: CallToolResult): TripData {
  if (!isTripData(result.structuredContent))
    throw new Error('工具结果缺少预期的 structuredContent。');
  return result.structuredContent;
}

function cityLabel(city: CityId): string {
  return CITY_OPTIONS.find((option) => option.id === city)?.label ?? city;
}

function initialCityForChat(chat?: ChatTurnProps): CityId {
  if (!chat) return INITIAL_INPUT.city;
  return ({ 杭州: 'hangzhou', 成都: 'chengdu', 上海: 'shanghai' } as const)[
    chat.request.context.city
  ];
}

function nextCity(city: CityId): CityId {
  return CITY_OPTIONS.find((option) => option.id !== city)?.id ?? 'shanghai';
}

function lifecycleLabel(phase: Phase): string {
  if (phase === 'opening')
    return STATIC_MODE ? '正在启动浏览器内 MCP Server' : '正在连接 MCP Server';
  if (phase === 'waiting-app') return '正在等待 App 握手';
  if (phase === 'ready') return 'App 与宿主已连接';
  if (phase === 'closing') return '正在关闭';
  if (phase === 'error') return '打开失败';
  return '尚未运行';
}

export function McpChatTurn(props: ChatTurnProps) {
  return <McpLab onTrace={props.onTrace} onResetTrace={() => {}} chat={props} />;
}

export default function McpLab({
  onTrace,
  onResetTrace,
  chat,
}: LabProps & { chat?: ChatTurnProps }) {
  const initialCity = useRef(initialCityForChat(chat)).current;
  const initialInput = useRef<ToolInput>({ city: initialCity }).current;
  const [phase, setPhase] = useState<Phase>('idle');
  const [frameHtml, setFrameHtml] = useState<string>();
  const [frameKey, setFrameKey] = useState(0);
  const [error, setError] = useState('');
  const [toolTitle, setToolTitle] = useState('');
  const [discoveredTool, setDiscoveredTool] = useState<Tool>();
  const [resourceChoices, setResourceChoices] = useState<ResourceChoice[]>([]);
  const [activeResource, setActiveResource] = useState<ResourceEvidence>();
  const [handshake, setHandshake] = useState<HandshakeEvidence>();
  const [toolResult, setToolResult] = useState<ToolResultEvidence>();
  const [currentInput, setCurrentInput] = useState<ToolInput>(initialInput);
  const [experimentCity, setExperimentCity] = useState<CityId>(nextCity(initialCity));
  const [selectedResourceUri, setSelectedResourceUri] = useState(LIST_RESOURCE_URI);
  const [metrics, setMetrics] = useState<ExecutionMetrics>(EMPTY_METRICS);
  const [experimentBusy, setExperimentBusy] = useState(false);
  const [layoutError, setLayoutError] = useState('');
  const [layoutEvidence, setLayoutEvidence] = useState<LayoutExperimentEvidence>();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sessionRef = useRef<Session | undefined>(undefined);
  const connectingClientRef = useRef<Client | undefined>(undefined);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const phaseRef = useRef<Phase>('idle');
  const traceRef = useRef(onTrace);
  const resetTraceRef = useRef(onResetTrace);
  const chatRef = useRef(chat);
  const metricsRef = useRef<ExecutionMetrics>(EMPTY_METRICS);
  const operationSequenceRef = useRef(0);
  const activeOperationRef = useRef<number | undefined>(undefined);
  const didAutoOpen = useRef(false);
  const didComplete = useRef(false);
  chatRef.current = chat;
  traceRef.current = onTrace;
  resetTraceRef.current = onResetTrace;
  phaseRef.current = phase;

  useEffect(() => {
    if (!chat || didAutoOpen.current) return;
    didAutoOpen.current = true;
    void openApp();
  }, []);

  useEffect(() => {
    if (didComplete.current || !chat || (phase !== 'ready' && phase !== 'error')) return;
    didComplete.current = true;
    chatRef.current?.onComplete(
      phase === 'ready'
        ? `已打开${chat.request.context.city}活动应用，可在回复内切换城市。`
        : `应用打开失败：${error}`,
    );
  }, [phase, error, chat]);

  useEffect(() => {
    if (experimentCity === currentInput.city) setExperimentCity(nextCity(currentInput.city));
  }, [currentInput.city, experimentCity]);

  useEffect(() => {
    if (!activeResource || selectedResourceUri !== activeResource.uri) return;
    const alternate = resourceChoices.find((resource) => resource.uri !== activeResource.uri);
    if (alternate) setSelectedResourceUri(alternate.uri);
  }, [activeResource, resourceChoices, selectedResourceUri]);

  useLayoutEffect(() => {
    if (frameHtml) void connectHostToFrame();
  }, [frameHtml, frameKey]);

  useEffect(() => {
    mountedRef.current = true;
    const themeObserver = new MutationObserver(() => {
      const session = sessionRef.current;
      if (session?.initialized) {
        void Promise.resolve(
          session.bridge?.sendHostContextChange({
            theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
          }),
        ).catch(() => undefined);
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      themeObserver.disconnect();
      mountedRef.current = false;
      generationRef.current += 1;
      invalidateOperation();
      const session = sessionRef.current;
      sessionRef.current = undefined;
      void connectingClientRef.current?.close().catch(() => undefined);
      connectingClientRef.current = undefined;
      if (session) void disposeSession(session, false);
    };
  }, []);

  function updatePhase(next: Phase): void {
    phaseRef.current = next;
    if (mountedRef.current) setPhase(next);
  }

  function current(generation: number): boolean {
    return mountedRef.current && generation === generationRef.current;
  }

  function currentFrame(session: Session, frameToken: number): boolean {
    return (
      current(session.generation) &&
      sessionRef.current === session &&
      session.frameToken === frameToken
    );
  }

  function updateMetrics(next: ExecutionMetrics): void {
    metricsRef.current = next;
    if (mountedRef.current) setMetrics(next);
  }

  function resetMetrics(): void {
    updateMetrics({ ...EMPTY_METRICS });
  }

  function incrementMetric(metric: MetricName): void {
    updateMetrics({
      ...metricsRef.current,
      [metric]: metricsRef.current[metric] + 1,
    });
  }

  function invalidateOperation(): void {
    operationSequenceRef.current += 1;
    activeOperationRef.current = undefined;
    if (mountedRef.current) setExperimentBusy(false);
  }

  function beginOperation(): number {
    if (activeOperationRef.current !== undefined) throw new Error('另一个 MCP 实验仍在执行。');
    const operation = ++operationSequenceRef.current;
    activeOperationRef.current = operation;
    if (mountedRef.current) setExperimentBusy(true);
    return operation;
  }

  function operationCurrent(operation: number, session: Session): boolean {
    return (
      activeOperationRef.current === operation &&
      sessionRef.current === session &&
      current(session.generation)
    );
  }

  function finishOperation(operation: number): void {
    if (activeOperationRef.current !== operation) return;
    activeOperationRef.current = undefined;
    if (mountedRef.current) setExperimentBusy(false);
  }

  function rejectReadyWaiter(session: Session, cause: unknown): void {
    const waiter = session.readyWaiter;
    session.readyWaiter = undefined;
    waiter?.reject(cause);
  }

  async function disposeBridge(session: Session, graceful: boolean): Promise<void> {
    const bridge = session.bridge;
    session.bridge = undefined;
    session.initialized = false;
    session.hostStarting = false;
    session.frameToken += 1;
    rejectReadyWaiter(session, new Error('iframe 在握手完成前被关闭。'));
    if (graceful && bridge) {
      await Promise.race([
        bridge.teardownResource({}),
        new Promise<void>((resolve) => window.setTimeout(resolve, 800)),
      ]).catch(() => undefined);
    }
    await bridge?.close().catch(() => undefined);
  }

  async function disposeSession(session: Session, graceful: boolean): Promise<void> {
    await disposeBridge(session, graceful);
    await session.client.close().catch(() => undefined);
  }

  async function requestResource(client: Client, uri: string): Promise<LoadedResource> {
    incrementMetric('resourceReads');
    return parseAppResource(await client.readResource({ uri }), uri);
  }

  async function requestToolResult(client: Client, input: ToolInput): Promise<CallToolResult> {
    incrementMetric('toolCalls');
    return client.callTool({ name: TOOL_NAME, arguments: input });
  }

  function rememberToolResult(
    session: Session,
    input: ToolInput,
    result: CallToolResult,
  ): ToolResultEvidence {
    const evidence = {
      input,
      result,
      traceLabel: toolCallTraceLabel(input.city),
    };
    session.currentInput = input;
    session.latestResult = result;
    if (current(session.generation) && sessionRef.current === session) {
      setCurrentInput(input);
      setToolResult(evidence);
    }
    return evidence;
  }

  function mountResource(
    session: Session,
    resource: LoadedResource,
    waitForReady: boolean,
  ): Promise<void> | undefined {
    const frameToken = ++session.frameToken;
    session.activeResource = resource;
    session.initialized = false;
    session.hostStarting = false;
    let readyPromise: Promise<void> | undefined;
    if (waitForReady) {
      let resolveReady!: () => void;
      let rejectReady!: (cause: unknown) => void;
      readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      session.readyWaiter = {
        frameToken,
        promise: readyPromise,
        resolve: resolveReady,
        reject: rejectReady,
      };
    }
    setActiveResource(toResourceEvidence(resource));
    setHandshake(undefined);
    incrementMetric('iframeMounts');
    setFrameKey((value) => value + 1);
    setFrameHtml(resource.html);
    return readyPromise;
  }

  async function closeApp(): Promise<void> {
    const generation = ++generationRef.current;
    invalidateOperation();
    const session = sessionRef.current;
    const wasInitialized = Boolean(session?.initialized);
    sessionRef.current = undefined;
    if (mountedRef.current) updatePhase('closing');
    if (session) await disposeSession(session, true);
    if (!current(generation)) return;
    setFrameHtml(undefined);
    setToolTitle('');
    setError('');
    updatePhase('idle');
    if (chatRef.current) {
      didComplete.current = true;
      chatRef.current.onComplete('活动应用已关闭，可以重新打开。');
    }
    traceRef.current({
      protocol: 'mcp',
      direction: 'local',
      label: 'Host closed MCP App',
      payload: { graceful: wasInitialized },
      note: 'Host 在移除 iframe 前请求 App teardown，并关闭两条 transport。',
    });
  }

  async function openApp(): Promise<void> {
    didComplete.current = false;
    const generation = ++generationRef.current;
    invalidateOperation();
    const oldSession = sessionRef.current;
    sessionRef.current = undefined;
    updatePhase('opening');
    await connectingClientRef.current?.close().catch(() => undefined);
    if (oldSession) await disposeSession(oldSession, true);
    if (!current(generation)) return;

    resetTraceRef.current();
    resetMetrics();
    setFrameHtml(undefined);
    setToolTitle('');
    setDiscoveredTool(undefined);
    setResourceChoices([]);
    setActiveResource(undefined);
    setHandshake(undefined);
    setToolResult(undefined);
    setCurrentInput(initialInput);
    setExperimentCity(nextCity(initialInput.city));
    setSelectedResourceUri(LIST_RESOURCE_URI);
    setLayoutError('');
    setLayoutEvidence(undefined);
    setError('');
    updatePhase('opening');

    const client = new Client(HOST_INFO, {
      capabilities: {
        extensions: {
          'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] },
        },
      },
    });
    connectingClientRef.current = client;
    try {
      const inner = STATIC_MODE
        ? await (await import('../static-mcp')).createStaticMcpTransport()
        : new StreamableHTTPClientTransport(new URL('/mcp', window.location.href));
      if (!current(generation)) {
        await inner.close();
        return;
      }
      const transport = new TracedTransport(
        inner,
        'client→server',
        'server→client',
        (entry) => {
          if (current(generation)) traceRef.current(entry);
        },
        STATIC_MODE
          ? '官方 InMemoryTransport 在浏览器内连接 MCP Client / Server；没有 HTTP 请求。'
          : '官方 Streamable HTTP transport 的真实 JSON-RPC 消息。',
        'server',
      );
      await client.connect(transport);
      if (!current(generation)) {
        await client.close().catch(() => undefined);
        return;
      }

      const tools = await client.listTools();
      const tool = tools.tools.find((candidate) => candidate.name === TOOL_NAME);
      if (!tool) throw new Error(`服务端没有暴露 ${TOOL_NAME} 工具。`);
      const advertisedUri = getToolUiResourceUri(tool);
      if (advertisedUri !== RESOURCE_URI) throw new Error('工具没有关联预期的默认 ui:// 资源。');

      const listed = await client.listResources();
      const listedByUri = new Map(listed.resources.map((resource) => [resource.uri, resource]));
      const resources = ALLOWED_RESOURCE_URIS.map((uri) => listedByUri.get(uri))
        .filter((resource): resource is NonNullable<typeof resource> => Boolean(resource))
        .map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          title: resource.title,
          mimeType: resource.mimeType,
        }));
      if (resources.length !== ALLOWED_RESOURCE_URIS.length) {
        throw new Error('服务端没有同时注册卡片与列表两个受控 UI 资源。');
      }

      const resource = await requestResource(client, advertisedUri);
      const firstResult = await requestToolResult(client, initialInput);
      if (firstResult.isError) throw new Error('初次工具调用返回错误。');
      tripData(firstResult);
      if (!current(generation)) {
        await client.close().catch(() => undefined);
        return;
      }

      const session: Session = {
        generation,
        client,
        initialized: false,
        hostStarting: false,
        latestResult: firstResult,
        currentInput: initialInput,
        tool,
        resources,
        activeResource: resource,
        frameToken: 0,
      };
      sessionRef.current = session;
      setDiscoveredTool(tool);
      setResourceChoices(resources);
      setToolTitle(tool.title ?? tool.name);
      setToolResult({
        input: initialInput,
        result: firstResult,
        traceLabel: toolCallTraceLabel(initialInput.city),
      });
      updatePhase('waiting-app');
      mountResource(session, resource, false);
    } catch (cause) {
      await client.close().catch(() => undefined);
      if (!current(generation)) return;
      setError(errorMessage(cause));
      updatePhase('error');
    } finally {
      if (connectingClientRef.current === client) connectingClientRef.current = undefined;
    }
  }

  async function connectHostToFrame(): Promise<void> {
    const session = sessionRef.current;
    const frameWindow = iframeRef.current?.contentWindow;
    if (!session || !frameWindow || session.hostStarting || !current(session.generation)) return;
    const frameToken = session.frameToken;
    const resourceUri = session.activeResource.uri;
    session.hostStarting = true;
    let initializeRecord:
      { protocolVersion: string; appInfo: unknown; appCapabilities: unknown } | undefined;

    const bridge = new AppBridge(
      null,
      HOST_INFO,
      { serverTools: {} },
      {
        hostContext: {
          platform: 'web',
          locale: 'zh-CN',
          theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
          displayMode: 'inline',
          availableDisplayModes: ['inline'],
          toolInfo: { id: 'initial-trip-fixture', tool: session.tool },
        },
      },
    );
    session.bridge = bridge;
    bridge.addEventListener('sizechange', ({ height }) => {
      const frame = iframeRef.current;
      if (!frame || !currentFrame(session, frameToken) || session.bridge !== bridge) return;
      if (typeof height === 'number' && Number.isFinite(height)) {
        frame.style.height = `${Math.min(1600, Math.max(340, Math.ceil(height) + 2))}px`;
      }
    });

    bridge.oncalltool = async (params) => {
      if (!currentFrame(session, frameToken) || !session.initialized) {
        return {
          content: [{ type: 'text', text: '当前 App 会话尚未就绪。' }],
          isError: true,
        };
      }
      if (params.name !== TOOL_NAME) {
        traceRef.current({
          protocol: 'mcp',
          direction: 'local',
          label: 'Host blocked tool',
          payload: params,
          note: '教学 Host 只允许 App 调用只读 fixture 工具。',
        });
        return {
          content: [{ type: 'text', text: '宿主拒绝了未在白名单中的工具。' }],
          isError: true,
        };
      }
      const city = String(params.arguments?.city) as CityId;
      if (!CITY_OPTIONS.some((option) => option.id === city)) {
        return {
          content: [{ type: 'text', text: '城市不在教学 fixture 白名单中。' }],
          isError: true,
        };
      }
      if (activeOperationRef.current !== undefined) {
        return {
          content: [{ type: 'text', text: '当前实验正在执行，请完成后重试城市切换。' }],
          isError: true,
        };
      }
      const operation = beginOperation();
      try {
        const input = { city };
        const result = await requestToolResult(session.client, input);
        if (currentFrame(session, frameToken) && !result.isError) {
          rememberToolResult(session, input, result);
          chatRef.current?.onInteraction({
            user: `在活动应用中选择了${cityLabel(city)}`,
            assistant: `已通过 App → Host → MCP Server 更新${cityLabel(city)}的活动。结果保留在上方应用中。`,
            context: { city: cityLabel(city) as '上海' | '成都' | '杭州' },
          });
        }
        return result;
      } finally {
        finishOperation(operation);
      }
    };

    let initializedResolve: (() => void) | undefined;
    const initialized = new Promise<void>((resolve) => {
      initializedResolve = resolve;
    });
    bridge.addEventListener('initialized', () => {
      if (!currentFrame(session, frameToken) || session.bridge !== bridge) return;
      session.initialized = true;
      setHandshake({
        resourceUri,
        protocolVersion: initializeRecord?.protocolVersion ?? '由 AppBridge 协商',
        appInfo: bridge.getAppVersion() ?? initializeRecord?.appInfo,
        appCapabilities: bridge.getAppCapabilities() ?? initializeRecord?.appCapabilities,
        hostInfo: HOST_INFO,
        traceLabel: handshakeTraceLabel(resourceUri),
      });
      initializedResolve?.();
    });

    const transport = new TracedTransport(
      new PostMessageTransport(frameWindow, frameWindow),
      'host→app',
      'app→host',
      (entry) => {
        if (currentFrame(session, frameToken)) traceRef.current(entry);
      },
      '官方 PostMessageTransport 的真实 JSON-RPC 消息；event.source 绑定当前 iframe。',
      'app',
      resourceUri,
      (message) => {
        if (!('method' in message) || message.method !== 'ui/initialize') return;
        const params = 'params' in message ? message.params : undefined;
        if (!params || typeof params !== 'object') return;
        const values = params as Record<string, unknown>;
        initializeRecord = {
          protocolVersion: String(values.protocolVersion ?? 'unknown'),
          appInfo: values.appInfo,
          appCapabilities: values.appCapabilities,
        };
      },
    );

    try {
      await bridge.connect(transport);
      if (!currentFrame(session, frameToken) || session.bridge !== bridge) return;
      let handshakeTimer: number | undefined;
      try {
        await Promise.race([
          initialized,
          new Promise<never>((_, reject) => {
            handshakeTimer = window.setTimeout(
              () => reject(new Error('等待 App 初始化超时。')),
              8000,
            );
          }),
        ]);
      } finally {
        window.clearTimeout(handshakeTimer);
      }
      if (!currentFrame(session, frameToken) || session.bridge !== bridge) return;

      await bridge.sendToolInput({ arguments: session.currentInput });
      await bridge.sendToolResult(session.latestResult);
      if (!currentFrame(session, frameToken) || session.bridge !== bridge) return;
      updatePhase('ready');
      if (session.readyWaiter?.frameToken === frameToken) {
        const waiter = session.readyWaiter;
        session.readyWaiter = undefined;
        waiter.resolve();
      }
    } catch (cause) {
      if (!currentFrame(session, frameToken) || session.bridge !== bridge) return;
      rejectReadyWaiter(session, cause);
      await disposeSession(session, false);
      if (!current(session.generation) || sessionRef.current !== session) return;
      sessionRef.current = undefined;
      setFrameHtml(undefined);
      setError(errorMessage(cause));
      updatePhase('error');
    }
  }

  function readySession(): Session {
    const session = sessionRef.current;
    if (
      phaseRef.current !== 'ready' ||
      !session ||
      !session.initialized ||
      !session.bridge ||
      !current(session.generation)
    ) {
      throw new Error('MCP App 尚未就绪；没有发送任何实验请求。');
    }
    return session;
  }

  async function runToolExperiment(): Promise<ExperimentEvidence> {
    const session = readySession();
    if (experimentCity === session.currentInput.city) {
      throw new Error('请选择与当前输入不同的城市；没有发送任何实验请求。');
    }
    const operation = beginOperation();
    const input = { city: experimentCity };
    const before = { ...metricsRef.current };
    const beforeData = tripData(session.latestResult);
    const frameWindow = iframeRef.current?.contentWindow;

    try {
      const result = await requestToolResult(session.client, input);
      if (result.isError) throw new Error('实验工具调用返回错误。');
      const afterData = tripData(result);
      if (!operationCurrent(operation, session) || !session.bridge || !session.initialized) {
        throw new Error('实验完成前 App 会话已关闭；结果未转发。');
      }
      await session.bridge.sendToolResult(result);
      if (!operationCurrent(operation, session)) {
        throw new Error('实验结果返回后 App 会话已关闭。');
      }
      rememberToolResult(session, input, result);
      const after = { ...metricsRef.current };
      const iframePreserved = iframeRef.current?.contentWindow === frameWindow;
      const comparison = {
        resourceReads: after.resourceReads - before.resourceReads,
        iframeMounts: after.iframeMounts - before.iframeMounts,
        toolCalls: after.toolCalls - before.toolCalls,
      };
      if (!iframePreserved || comparison.iframeMounts !== 0 || comparison.toolCalls !== 1) {
        throw new Error('实验期间发生了其他操作，无法单独判断本次工具更新；请重试。');
      }
      return {
        correctOptionId: comparison.resourceReads === 0 ? 'no-resource-read' : 'must-read-resource',
        summary: `实际新增 ${comparison.toolCalls} 次 tools/call、${comparison.resourceReads} 次 resources/read；${afterData.cityLabel}数据已通过现有 AppBridge 发给原 iframe。`,
        payload: {
          experiment: 'A · 只更换真实工具结果',
          input,
          toolData: {
            before: {
              city: beforeData.cityLabel,
              firstActivity: beforeData.activities[0]?.title,
            },
            after: {
              city: afterData.cityLabel,
              firstActivity: afterData.activities[0]?.title,
            },
          },
          executionCounts: { before, after },
          comparison,
          iframePreserved,
          forwardedBy: 'Host · session.client.callTool → existing AppBridge.sendToolResult',
          source: 'shared/mcp-server.ts · registerAppTool handler → cityFixtures',
        },
        traceLabel: toolCallTraceLabel(input.city),
      };
    } finally {
      finishOperation(operation);
    }
  }

  async function runLayoutExperiment(): Promise<void> {
    setLayoutError('');
    setLayoutEvidence(undefined);
    let session: Session;
    try {
      session = readySession();
    } catch (cause) {
      setLayoutError(errorMessage(cause));
      return;
    }
    if (selectedResourceUri === session.activeResource.uri) {
      setLayoutError('请选择与当前布局不同的已注册资源；没有发送 resources/read。');
      return;
    }
    const selected = session.resources.find((resource) => resource.uri === selectedResourceUri);
    if (
      !selected ||
      !ALLOWED_RESOURCE_URIS.includes(selected.uri as (typeof ALLOWED_RESOURCE_URIS)[number])
    ) {
      setLayoutError('所选 URI 不在本实验从 resources/list 得到的受控资源中。');
      return;
    }

    let operation: number;
    try {
      operation = beginOperation();
    } catch (cause) {
      setLayoutError(errorMessage(cause));
      return;
    }
    const before = { ...metricsRef.current };
    const beforeResource = session.activeResource.uri;
    const beforeData = tripData(session.latestResult);
    const oldFrameWindow = iframeRef.current?.contentWindow;

    try {
      const resource = await requestResource(session.client, selected.uri);
      if (!operationCurrent(operation, session)) throw new Error('读取资源时 App 会话已关闭。');
      const preservedInput = { ...session.currentInput };
      await disposeBridge(session, true);
      if (!operationCurrent(operation, session)) throw new Error('切换布局时 App 会话已关闭。');
      updatePhase('waiting-app');
      const ready = mountResource(session, resource, true);
      await ready;
      if (!operationCurrent(operation, session))
        throw new Error('新布局握手完成前 App 会话已关闭。');
      const after = { ...metricsRef.current };
      const afterData = tripData(session.latestResult);
      setLayoutEvidence({
        summary: `Host 已读取 ${selected.uri} 并重新创建 App；${afterData.cityLabel}仍来自切换前的最后一次真实工具结果。`,
        traceLabel: resource.traceLabel,
        payload: {
          experiment: 'B · Host 主动选择另一个已注册 UI 资源',
          resource: { before: beforeResource, after: selected.uri },
          toolMetadata: {
            advertisedResourceUri: getToolUiResourceUri(session.tool),
            changed: false,
            note: '工具 metadata 仍指向默认资源；本实验由 Host 明确选择 alternate resource。',
          },
          currentInput: { before: preservedInput, after: session.currentInput },
          toolData: {
            before: {
              city: beforeData.cityLabel,
              firstActivity: beforeData.activities[0]?.title,
            },
            after: {
              city: afterData.cityLabel,
              firstActivity: afterData.activities[0]?.title,
            },
          },
          executionCounts: { before, after },
          comparison: {
            resourceReads: after.resourceReads - before.resourceReads,
            iframeMounts: after.iframeMounts - before.iframeMounts,
            toolCalls: after.toolCalls - before.toolCalls,
          },
          iframeRecreated: iframeRef.current?.contentWindow !== oldFrameWindow,
          source: STATIC_MODE
            ? 'shared/mcp-server.ts · registerTripAppResource → dist/mcp-app/*.html'
            : 'shared/mcp-server.ts · registerTripAppResource → server/mcp-resource.ts · buildAppHtml',
        },
      });
    } catch (cause) {
      if (operationCurrent(operation, session) && mountedRef.current) {
        setLayoutError(errorMessage(cause));
      }
    } finally {
      finishOperation(operation);
    }
  }

  const busy = phase === 'opening' || phase === 'waiting-app' || phase === 'closing';
  const completed = phase === 'ready';
  const connectedToServer = phase !== 'idle' && phase !== 'opening' && phase !== 'error';
  const inspectTrace = (label: string) => chatRef.current?.onInspectTrace?.(label);

  if (chat)
    return (
      <div className="chat-mcp">
        <p className="agent-prose">
          我找到一个自带界面的城市活动工具。它的 UI 由 MCP Server 提供，直接在这条回复里打开。
        </p>
        <div className="chat-resource-card">
          <Box size={18} aria-hidden="true" />
          <div>
            <strong>{toolTitle || '城市活动选择器'}</strong>
            <code>{activeResource?.uri ?? RESOURCE_URI}</code>
          </div>
          <span className="badge">MCP App</span>
        </div>
        <div className="chat-run-status" role="status">
          {busy ? (
            <LoaderCircle size={14} className="spinner" aria-hidden="true" />
          ) : (
            <CheckCircle2 size={14} aria-hidden="true" />
          )}
          {lifecycleLabel(phase)}
        </div>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {frameHtml && (
          <iframe
            key={frameKey}
            ref={iframeRef}
            className="mcp-frame"
            title="城市活动选择器 MCP App"
            sandbox="allow-scripts"
            srcDoc={frameHtml}
          />
        )}
        <div className="chat-run-actions">
          {!busy && (
            <button type="button" onClick={() => void openApp()}>
              <RotateCw size={14} aria-hidden="true" />
              {phase === 'error' ? '重试打开' : completed ? '重新打开应用' : '打开应用'}
            </button>
          )}
          {frameHtml && (
            <button type="button" onClick={() => void closeApp()} disabled={phase === 'closing'}>
              <Square size={14} aria-hidden="true" />
              关闭应用
            </button>
          )}
        </div>
        <details className="chat-disclosure">
          <summary>
            工具为什么自带界面 <span>资源 → 宿主 → 应用</span>
          </summary>
          <div className="generation-steps">
            <Step done={connectedToServer} label="tools/list → _meta.ui.resourceUri" />
            <Step done={Boolean(frameHtml)} label="resources/read → text/html;profile=mcp-app" />
            <Step done={completed} label="AppBridge → ui/initialize → 工具结果" />
          </div>
          <p className="hint">
            宿主读取工具关联的 HTML 资源，放入仅允许脚本的 iframe。应用中的交互通过宿主代理到 MCP
            服务，不直接访问业务接口。
          </p>
          <pre>
            {JSON.stringify(
              {
                tool: TOOL_NAME,
                advertisedResourceUri: getToolUiResourceUri(discoveredTool ?? {}),
                actualResourceUri: activeResource?.uri ?? RESOURCE_URI,
                mimeType: activeResource?.mimeType ?? RESOURCE_MIME_TYPE,
                input: currentInput,
                sandbox: 'allow-scripts',
              },
              null,
              2,
            )}
          </pre>
        </details>
        <McpLearningPanel
          phase={phase}
          tool={discoveredTool}
          resourceChoices={resourceChoices}
          activeResource={activeResource}
          handshake={handshake}
          toolResult={toolResult}
          currentInput={currentInput}
          metrics={metrics}
          experimentCity={experimentCity}
          onExperimentCityChange={setExperimentCity}
          runToolExperiment={runToolExperiment}
          selectedResourceUri={selectedResourceUri}
          onSelectedResourceChange={setSelectedResourceUri}
          runLayoutExperiment={runLayoutExperiment}
          experimentBusy={experimentBusy}
          layoutError={layoutError}
          layoutEvidence={layoutEvidence}
          onInspectTrace={inspectTrace}
          canInspectTrace={Boolean(chat.onInspectTrace)}
        />
      </div>
    );

  return (
    <>
      <div className="panel-heading">
        <span>
          <Box size={17} aria-hidden="true" /> MCP App Host
        </span>
        <span className={`badge ${completed ? 'success' : ''}`}>{lifecycleLabel(phase)}</span>
      </div>
      <div className="lab-body" aria-busy={busy}>
        <p className="lab-description">
          {STATIC_MODE
            ? '这是静态学习 Host：官方 MCP Client / Server 在浏览器内通过 InMemoryTransport 交换 JSON-RPC，MCP Apps 的 iframe 握手与工具代理真实执行。'
            : '这是本地确定性 Host：真实运行 MCP Streamable HTTP 与 MCP Apps 2026-01-26 协议。'}
          数据来自只读 fixture，不调用 LLM 或外部 API。
        </p>

        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}

        <div className="button-row">
          <button
            className="button primary"
            type="button"
            onClick={() => {
              void openApp();
            }}
            disabled={busy}
          >
            {busy && phase !== 'closing' ? (
              <LoaderCircle className="spinner" size={15} aria-hidden="true" />
            ) : phase === 'error' ? (
              <RotateCw size={15} aria-hidden="true" />
            ) : (
              <PlugZap size={15} aria-hidden="true" />
            )}
            {phase === 'error' ? '重试打开' : completed ? '重新打开' : '打开 MCP App'}
          </button>
          {(frameHtml || phase === 'waiting-app' || completed) && (
            <button
              className="button secondary"
              type="button"
              onClick={() => {
                void closeApp();
              }}
              disabled={phase === 'closing'}
            >
              <Square size={14} aria-hidden="true" /> 关闭 App
            </button>
          )}
          <span className="run-status" role="status" aria-live="polite">
            {busy && <LoaderCircle className="spinner" size={13} aria-hidden="true" />}
            {lifecycleLabel(phase)}
          </span>
        </div>

        <div className="state-card">
          <h3>真实协议链路</h3>
          <div className="task-list">
            <Step done={connectedToServer} label="MCP initialize + tools/list" />
            <Step done={Boolean(frameHtml)} label="resources/read 获取自包含 App HTML" />
            <Step done={Boolean(frameHtml)} label="tools/call 获取首次 fixture 结果" />
            <Step done={completed} label="App ↔ AppBridge 初始化握手" />
          </div>
        </div>

        {toolTitle && (
          <div className="tool-card">
            <strong>{TOOL_NAME}</strong>
            <pre>
              {JSON.stringify(
                { title: toolTitle, input: currentInput, allowlist: [TOOL_NAME], readOnly: true },
                null,
                2,
              )}
            </pre>
          </div>
        )}

        {frameHtml ? (
          <iframe
            key={frameKey}
            ref={iframeRef}
            className="mcp-frame"
            title="城市活动选择器 MCP App"
            sandbox="allow-scripts"
            srcDoc={frameHtml}
          />
        ) : phase === 'idle' ? (
          <div className="empty-state">
            <Box size={25} aria-hidden="true" />
            <h3>App 还没有打开</h3>
            <p>点击上方按钮后，Host 才会发现工具、读取资源并创建隔离 iframe。</p>
          </div>
        ) : null}

        <p className="mcp-resource">
          <Circle size={8} fill="currentColor" aria-hidden="true" />{' '}
          {activeResource?.uri ?? RESOURCE_URI} · {activeResource?.mimeType ?? RESOURCE_MIME_TYPE}
        </p>
      </div>
      <div className="experiment-footer">
        iframe 仅启用 <code>allow-scripts</code>，没有 <code>allow-same-origin</code>；本地 Host
        只代理 <code>{TOOL_NAME}</code>，不代表完整第三方宿主安全模型。
      </div>
    </>
  );
}

function McpLearningPanel({
  phase,
  tool,
  resourceChoices,
  activeResource,
  handshake,
  toolResult,
  currentInput,
  metrics,
  experimentCity,
  onExperimentCityChange,
  runToolExperiment,
  selectedResourceUri,
  onSelectedResourceChange,
  runLayoutExperiment,
  experimentBusy,
  layoutError,
  layoutEvidence,
  onInspectTrace,
  canInspectTrace,
}: {
  phase: Phase;
  tool?: Tool;
  resourceChoices: ResourceChoice[];
  activeResource?: ResourceEvidence;
  handshake?: HandshakeEvidence;
  toolResult?: ToolResultEvidence;
  currentInput: ToolInput;
  metrics: ExecutionMetrics;
  experimentCity: CityId;
  onExperimentCityChange: (city: CityId) => void;
  runToolExperiment: () => Promise<ExperimentEvidence>;
  selectedResourceUri: string;
  onSelectedResourceChange: (uri: string) => void;
  runLayoutExperiment: () => Promise<void>;
  experimentBusy: boolean;
  layoutError: string;
  layoutEvidence?: LayoutExperimentEvidence;
  onInspectTrace: (label: string) => void;
  canInspectTrace: boolean;
}) {
  const panelId = useId();
  const ready = phase === 'ready';
  const alternateSelected = Boolean(
    activeResource && selectedResourceUri && selectedResourceUri !== activeResource.uri,
  );

  return (
    <details className="chat-disclosure mcp-learning-panel">
      <summary>
        动手验证 MCP Apps 因果链 <span>预测 → 运行 → 证据</span>
      </summary>
      <div className="mcp-learning-body learning-panel">
        <p className="hint">
          下面四条边界记录都来自本轮真实 SDK 执行。资源源码只展示文档标记与根节点，不展开自包含 SDK
          bundle。
        </p>
        <ol className="mcp-boundary-records" aria-label="MCP Apps 因果边界">
          <BoundaryRecord
            title="1. 工具发现"
            ready={Boolean(tool)}
            owner="MCP Server · registerAppTool → Host · Client.listTools"
            traceLabel={tool ? TOOL_METADATA_TRACE_LABEL : undefined}
            traceButtonLabel="定位实际 tools/list 记录"
            onInspectTrace={onInspectTrace}
            canInspectTrace={canInspectTrace}
          >
            <pre>{JSON.stringify(tool ?? { status: '等待 tools/list' }, null, 2)}</pre>
          </BoundaryRecord>
          <BoundaryRecord
            title="2. UI 资源读取"
            ready={Boolean(activeResource)}
            owner="MCP Server · registerTripAppResource/read callback → Host · Client.readResource"
            traceLabel={activeResource?.traceLabel}
            traceButtonLabel="定位实际 resources/read 记录"
            onInspectTrace={onInspectTrace}
            canInspectTrace={canInspectTrace}
          >
            <pre>
              {JSON.stringify(activeResource ?? { status: '等待 resources/read' }, null, 2)}
            </pre>
          </BoundaryRecord>
          <BoundaryRecord
            title="3. App ↔ Host 握手"
            ready={Boolean(handshake)}
            owner="iframe App · App.connect ↔ Host · AppBridge.connect"
            traceLabel={handshake?.traceLabel}
            traceButtonLabel="定位实际 initialized 记录"
            onInspectTrace={onInspectTrace}
            canInspectTrace={canInspectTrace}
          >
            <pre>{JSON.stringify(handshake ?? { status: '等待 ui/initialize' }, null, 2)}</pre>
          </BoundaryRecord>
          <BoundaryRecord
            title="4. 工具结果进入 App"
            ready={Boolean(toolResult)}
            owner="cityFixtures → registerAppTool handler → Client.callTool → AppBridge"
            traceLabel={toolResult?.traceLabel}
            traceButtonLabel="定位实际 tools/call 结果"
            onInspectTrace={onInspectTrace}
            canInspectTrace={canInspectTrace}
          >
            <pre>{JSON.stringify(toolResult ?? { status: '等待 tools/call' }, null, 2)}</pre>
          </BoundaryRecord>
        </ol>

        <section className="mcp-experiment-summary" aria-labelledby={`${panelId}-counts`}>
          <h3 id={`${panelId}-counts`}>当前真实执行计数</h3>
          <p>
            当前输入：<code>{JSON.stringify(currentInput)}</code> · 当前布局资源：
            <code>{activeResource?.uri ?? '尚未读取'}</code>
          </p>
          <table className="mcp-experiment-metrics">
            <caption>Host 发起的读取、挂载与调用；App 是否就绪另见握手记录</caption>
            <thead>
              <tr>
                <th scope="col">resources/read</th>
                <th scope="col">iframe 挂载</th>
                <th scope="col">tools/call</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{metrics.resourceReads}</td>
                <td>{metrics.iframeMounts}</td>
                <td>{metrics.toolCalls}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section
          className="mcp-experiment-controls learning-experiment"
          aria-labelledby={`${panelId}-a`}
        >
          <h3 id={`${panelId}-a`}>实验 A · 只更换真实工具结果</h3>
          <label className="mcp-experiment-control learning-field">
            <span>实验 A 的工具输入城市</span>
            <select
              aria-label="实验 A 的工具输入城市"
              value={experimentCity}
              disabled={!ready || experimentBusy}
              onChange={(event) => onExperimentCityChange(event.target.value as CityId)}
            >
              {CITY_OPTIONS.map((city) => (
                <option key={city.id} value={city.id}>
                  {city.label}
                  {city.id === currentInput.city ? '（当前）' : ''}
                </option>
              ))}
            </select>
          </label>
          <PredictionLesson
            disabled={!ready || experimentBusy}
            title="工具结果与 UI 资源是否绑定重读"
            question="只更换工具结果，是否必须重新读取 UI 资源？"
            options={[
              { id: 'no-resource-read', label: '不需要；原 App 可以接收新的真实工具结果' },
              { id: 'must-read-resource', label: '必须；每次 tools/call 后都要 resources/read' },
            ]}
            explanation="MCP App 资源定义界面代码，工具结果提供数据。Host 可把新的 tools/call 结果发给已经握手的 App；数据更新不要求重读资源。本实验切换布局时才主动读取另一份资源并重建 App。"
            runLabel={`调用工具并切换到${cityLabel(experimentCity)}`}
            runExperiment={runToolExperiment}
            onInspectTrace={canInspectTrace ? onInspectTrace : undefined}
          />
          {!ready && <p className="hint">App 就绪后才能运行；未就绪时不会发送实验请求。</p>}
        </section>

        <section
          className="mcp-experiment-controls learning-experiment"
          aria-labelledby={`${panelId}-b`}
        >
          <h3 id={`${panelId}-b`}>实验 B · Host 主动更换已注册布局资源</h3>
          <p className="hint">
            这是 Host 的受控选择：工具 metadata 始终仍指向默认 <code>{RESOURCE_URI}</code>
            ，并不表示工具描述发生了变化。
          </p>
          <label className="mcp-experiment-control learning-field">
            <span>实验 B 的 UI 布局资源</span>
            <select
              aria-label="实验 B 的 UI 布局资源"
              value={selectedResourceUri}
              disabled={!ready || experimentBusy || resourceChoices.length < 2}
              onChange={(event) => onSelectedResourceChange(event.target.value)}
            >
              {resourceChoices.map((resource) => (
                <option key={resource.uri} value={resource.uri}>
                  {resource.title ?? resource.name} · {resource.uri}
                </option>
              ))}
            </select>
          </label>
          <div className="learning-controls">
            <button
              className="button secondary"
              type="button"
              disabled={!ready || experimentBusy || !alternateSelected}
              onClick={() => void runLayoutExperiment()}
            >
              {experimentBusy ? (
                <LoaderCircle className="spinner" size={14} aria-hidden="true" />
              ) : (
                <RotateCw size={14} aria-hidden="true" />
              )}
              {experimentBusy ? '正在读取并重载资源…' : '读取所选资源并重载 App'}
            </button>
          </div>
          {layoutError && (
            <p className="error-banner" role="alert">
              实验未完成：{layoutError}。本次不修改结论。
            </p>
          )}
          {layoutEvidence && (
            <div className="mcp-experiment-evidence" role="status">
              <strong>
                <CheckCircle2 size={15} aria-hidden="true" /> Host 资源实验已完成
              </strong>
              <p>{layoutEvidence.summary}</p>
              <details>
                <summary>查看本次布局实验的证据</summary>
                <pre>{JSON.stringify(layoutEvidence.payload, null, 2)}</pre>
              </details>
              <button
                className="learning-link"
                type="button"
                disabled={!canInspectTrace}
                onClick={() => onInspectTrace(layoutEvidence.traceLabel)}
              >
                定位本次 resources/read 记录
              </button>
            </div>
          )}
        </section>
      </div>
    </details>
  );
}

function BoundaryRecord({
  title,
  ready,
  owner,
  traceLabel: label,
  traceButtonLabel,
  onInspectTrace,
  canInspectTrace,
  children,
}: {
  title: string;
  ready: boolean;
  owner: string;
  traceLabel?: string;
  traceButtonLabel: string;
  onInspectTrace: (label: string) => void;
  canInspectTrace: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={`mcp-boundary-record causal-evidence ${ready ? 'done' : ''}`}>
      <div className="mcp-boundary-heading">
        {ready ? (
          <CheckCircle2 size={14} aria-hidden="true" />
        ) : (
          <Circle size={14} aria-hidden="true" />
        )}
        <strong>{title}</strong>
      </div>
      <p className="mcp-boundary-owner source-location">所有权 / 来源函数：{owner}</p>
      <details>
        <summary>查看本条边界的实际数据</summary>
        {children}
      </details>
      {label && (
        <button
          className="learning-link"
          type="button"
          disabled={!canInspectTrace}
          onClick={() => onInspectTrace(label)}
        >
          {traceButtonLabel}
        </button>
      )}
    </li>
  );
}

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <div className={`task-item ${done ? 'done' : ''}`}>
      {done ? (
        <CheckCircle2 size={14} aria-hidden="true" />
      ) : (
        <Circle size={14} aria-hidden="true" />
      )}
      {label}
    </div>
  );
}
