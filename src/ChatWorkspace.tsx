import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Bot,
  Boxes,
  Braces,
  Check,
  ChevronRight,
  Code2,
  LayoutTemplate,
  LoaderCircle,
  MessageSquare,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Radio,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import type { ChatContext, ChatRequest, ChatRoute, ChatTurnProps } from '../shared/chat';
import type { ProtocolId, TraceEntry, TraceInput } from '../shared/trace';
import { fetchJson, errorMessage, labFetch } from '../shared/http';
import { STATIC_MODE, describeTrace } from '../shared/runtime';
import { RuntimeNotice } from './components/RuntimeNotice';
import { Inspector } from './components/Inspector';
import { docHref, type DocSlug } from '../shared/doc-navigation';
import { useTheme } from './useTheme';
import './chat.css';
import './learning.css';

const AguiTurn = lazy(() =>
  import('./components/AguiChatTurn').then((module) => ({ default: module.AguiChatTurn })),
);
const A2uiTurn = lazy(() =>
  import('./labs/A2uiLab').then((module) => ({ default: module.A2uiChatTurn })),
);
const McpTurn = lazy(() =>
  import('./labs/McpLab').then((module) => ({ default: module.McpChatTurn })),
);

const protocolInfo = {
  agui: {
    name: 'AG-UI',
    icon: Radio,
    short: '事件驱动回复',
    detail: '文本、工具调用、状态变更通过同一条事件流，变成消息里的不同界面。',
    prompt: '帮我规划杭州三日游，喜欢慢节奏和本地小吃',
    suggestion: '把这些出行需求做成一个可填写的表单',
    source: 'shared/agui-agent.ts → shared/agui.ts → AguiChatTurn',
  },
  a2ui: {
    name: 'A2UI',
    icon: LayoutTemplate,
    short: '声明生成组件',
    detail: '服务端提供组件声明与数据，聊天宿主用受支持的 React 组件渲染，交互再产生 action。',
    prompt: '生成一个成都两日游的需求表单，我来补充信息',
    suggestion: '打开这个城市的活动应用，让我挑一挑',
    source: 'shared/a2ui-agent.ts → A2UI schema → SurfaceRenderer',
  },
  mcp: {
    name: 'MCP Apps',
    icon: Boxes,
    short: '工具自带应用',
    detail: 'MCP 工具关联 ui:// 资源，宿主读取 HTML，完成 App 握手后在消息中展示它。',
    prompt: '打开上海的城市活动应用',
    suggestion: '再帮我规划一个三日游，加入散步路线',
    source: 'tools/list → resources/read → AppBridge → iframe App',
  },
} as const;

type Turn = { request: ChatRequest; explanation: string; summary?: string; entries: TraceEntry[] };
type Message = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  turnId?: string;
  interaction?: boolean;
};
const initialContext: ChatContext = { city: '杭州', days: 3 };

class TurnBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch() {
    this.props.onFailure();
  }
  render() {
    return this.state.error ? (
      <p className="error-banner" role="alert">
        这条回复渲染失败。可以在下方重新发送请求。
      </p>
    ) : (
      this.props.children
    );
  }
}

function TurnContent({
  turn,
  onTrace,
  onComplete,
  onInteraction,
  onInspect,
  selected,
  active,
}: {
  turn: Turn;
  selected: boolean;
  active: boolean;
  onTrace: (id: string, entry: TraceInput) => void;
  onComplete: (id: string, summary: string) => void;
  onInteraction: (
    id: string,
    exchange: { user: string; assistant: string; context?: Partial<ChatContext> },
  ) => void;
  onInspect: (id: string, label?: string, occurrence?: number) => void;
}) {
  const trace = useCallback(
    (entry: TraceInput) => onTrace(turn.request.id, entry),
    [onTrace, turn.request.id],
  );
  const complete = useCallback(
    (summary: string) => onComplete(turn.request.id, summary),
    [onComplete, turn.request.id],
  );
  const interact = useCallback(
    (exchange: { user: string; assistant: string; context?: Partial<ChatContext> }) =>
      onInteraction(turn.request.id, exchange),
    [onInteraction, turn.request.id],
  );
  const info = protocolInfo[turn.request.protocol];
  const Icon = info.icon;
  const props: ChatTurnProps = {
    active,
    request: turn.request,
    onTrace: trace,
    onComplete: complete,
    onInteraction: interact,
    onInspectTrace: (label, occurrence) => onInspect(turn.request.id, label, occurrence),
  };
  return (
    <article
      className={`chat-message assistant-message ${selected ? 'inspected' : ''}`}
      aria-label={`${info.name} Agent 回复`}
    >
      <div className="assistant-avatar">
        <Bot size={18} />
      </div>
      <div className="assistant-body">
        <div className="message-byline">
          <strong>Intelligent UI Agent</strong>
          <span className={`protocol-tag ${turn.request.protocol}`}>
            <Icon size={12} />
            {info.name}
          </span>
        </div>
        <TurnBoundary onFailure={() => complete('回复渲染失败')}>
          <Suspense
            fallback={
              <p className="chat-run-status">
                <LoaderCircle className="spinner" size={14} />
                正在准备回复…
              </p>
            }
          >
            {turn.request.protocol === 'agui' ? (
              <AguiTurn {...props} />
            ) : turn.request.protocol === 'a2ui' ? (
              <A2uiTurn {...props} />
            ) : (
              <McpTurn {...props} />
            )}
          </Suspense>
        </TurnBoundary>
        <button
          className="inspect-turn"
          type="button"
          aria-label={`查看本轮 ${info.name} 协议`}
          onClick={() => onInspect(turn.request.id)}
        >
          <Braces size={14} />
          {turn.entries.length} 条协议消息<span>查看这一轮如何工作</span>
          <ArrowRight size={13} />
        </button>
        <a
          className="turn-doc-link"
          href={docHref(
            (
              { agui: 'ag-ui', a2ui: 'a2ui', mcp: 'mcp-apps' } satisfies Record<ProtocolId, DocSlug>
            )[turn.request.protocol],
          )}
        >
          <BookOpen size={14} aria-hidden="true" /> 阅读 {info.name} 完整教程
          <ArrowRight size={13} aria-hidden="true" />
        </a>
      </div>
    </article>
  );
}

export function ChatWorkspace({ active = true }: { active?: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'auto' | ProtocolId>('auto');
  const [context, setContext] = useState<ChatContext>(initialContext);
  const [pending, setPending] = useState<string | null>(null);
  const [routing, setRouting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [traceFocus, setTraceFocus] = useState<{
    turnId: string;
    label: string;
    occurrence?: number;
    token: number;
  } | null>(null);
  const focusSequence = useRef(0);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1280);
  const [compact, setCompact] = useState(() => window.innerWidth < 1280);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1279px)');
    const changed = () => setCompact(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const [theme, setTheme] = useTheme();
  const [health, setHealth] = useState<'checking' | 'ready' | 'offline'>('checking');
  const [healthAttempt, setHealthAttempt] = useState(0);
  const [error, setError] = useState('');
  const [showJump, setShowJump] = useState(false);
  const threadId = useRef(`thread-${crypto.randomUUID()}`);
  const generation = useRef(0);
  const activeTurns = useRef(new Set<string>());
  const sequence = useRef(0);
  const sending = useRef(false);
  const routingController = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const inspector = useRef<HTMLDivElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const selectedTurn = turns.find((turn) => turn.request.id === selectedId) ?? turns.at(-1);
  const busy = routing || pending !== null;
  useEffect(() => {
    sending.current = busy;
  }, [busy]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let active = true;
    setHealth('checking');
    void labFetch('/api/health', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error();
        if (active) setHealth('ready');
      })
      .catch(() => {
        if (active) setHealth('offline');
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [healthAttempt]);
  useEffect(
    () => () => {
      generation.current += 1;
      activeTurns.current.clear();
      routingController.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const region = scroll.current;
    if (!active || !region) return;
    const content = region.firstElementChild;
    const resize = new ResizeObserver(() => {
      if (follow.current) region.scrollTop = region.scrollHeight;
    });
    if (content) resize.observe(content);
    return () => resize.disconnect();
  }, [active]);
  useEffect(() => {
    if (!active || !inspectorOpen || !compact) return;
    const root = inspector.current;
    root?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInspectorOpen(false);
      if (event.key !== 'Tab' || !root) return;
      const elements = [
        ...root.querySelectorAll<HTMLElement>('button:not(:disabled), input, a[href]'),
      ].filter((node) => node.getClientRects().length);
      if (event.shiftKey && document.activeElement === elements[0]) {
        event.preventDefault();
        elements.at(-1)?.focus();
      }
      if (!event.shiftKey && document.activeElement === elements.at(-1)) {
        event.preventDefault();
        elements[0]?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      inspectorToggle.current?.focus();
    };
  }, [inspectorOpen, compact, active]);

  const onTrace = useCallback((id: string, entry: TraceInput) => {
    const next = { ...describeTrace(entry), id: ++sequence.current, time: Date.now() };
    setTurns((previous) =>
      previous.map((turn) =>
        turn.request.id === id ? { ...turn, entries: [...turn.entries, next].slice(-300) } : turn,
      ),
    );
  }, []);
  const onComplete = useCallback((id: string, summary: string) => {
    setTurns((previous) =>
      previous.map((turn) => (turn.request.id === id ? { ...turn, summary } : turn)),
    );
    setPending((current) => (current === id ? null : current));
  }, []);
  const onInteraction = useCallback(
    (id: string, exchange: { user: string; assistant: string; context?: Partial<ChatContext> }) => {
      if (!activeTurns.current.has(id)) return;
      if (exchange.context) setContext((previous) => ({ ...previous, ...exchange.context }));
      setMessages((previous) =>
        previous.some((message) => message.turnId === id)
          ? [
              ...previous,
              { id: crypto.randomUUID(), role: 'user', text: exchange.user, interaction: true },
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                text: exchange.assistant,
                interaction: true,
              },
            ]
          : previous,
      );
    },
    [],
  );

  async function send(value = prompt) {
    const text = value.trim();
    if (!text || text.length > 500 || sending.current || busy) return;
    sending.current = true;
    const epoch = generation.current;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    routingController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    setRouting(true);
    setError('');
    setPrompt('');
    follow.current = true;
    setMessages((previous) => [...previous, { id: `user-${id}`, role: 'user', text }]);
    try {
      const route = await fetchJson<ChatRoute>('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ prompt: text, mode, context }),
        signal: controller.signal,
      });
      if (epoch !== generation.current) return;
      if (!['agui', 'a2ui', 'mcp'].includes(route.protocol))
        throw new Error('服务端返回了未知的协议。');
      const history = messages.flatMap((message) => {
        const turn = turns.find((item) => item.request.id === message.turnId);
        const content = message.text ?? turn?.summary;
        return content ? [{ id: message.id, role: message.role, content }] : [];
      });
      const request: ChatRequest = {
        id,
        threadId: threadId.current,
        prompt: text,
        protocol: route.protocol,
        context: route.context,
        history: history.slice(-48),
      };
      setContext(route.context);
      activeTurns.current.add(id);
      setTurns((previous) => [
        ...previous,
        { request, explanation: route.explanation, entries: [] },
      ]);
      setMessages((previous) => [
        ...previous,
        { id: `agent-${id}`, role: 'assistant', turnId: id },
      ]);
      setSelectedId(id);
      setPending(id);
    } catch (cause) {
      if (epoch !== generation.current) return;
      setError(
        controller.signal.aborted ? '请求超时，请确认本地服务连接后重试。' : errorMessage(cause),
      );
      setPrompt(text);
      setMessages((previous) => previous.filter((message) => message.id !== `user-${id}`));
      sending.current = false;
    } finally {
      clearTimeout(timeout);
      if (epoch === generation.current) setRouting(false);
    }
  }

  function reset() {
    generation.current += 1;
    routingController.current?.abort();
    sending.current = false;
    threadId.current = `thread-${crypto.randomUUID()}`;
    activeTurns.current.clear();
    setMessages([]);
    setTurns([]);
    setContext(initialContext);
    setPending(null);
    setRouting(false);
    setSelectedId(null);
    setTraceFocus(null);
    setError('');
    setPrompt('');
    follow.current = true;
    input.current?.focus();
  }

  function inspectTurn(id: string, label?: string, occurrence?: number) {
    setSelectedId(id);
    setTraceFocus(label ? { turnId: id, label, occurrence, token: ++focusSequence.current } : null);
    setInspectorOpen(true);
  }
  const lastProtocol = turns.at(-1)?.request.protocol;

  return (
    <div className={`conversation-app ${inspectorOpen ? 'with-inspector' : ''}`}>
      <aside className="chat-sidebar" aria-label="聊天工作区" inert={compact && inspectorOpen}>
        <a className="chat-brand" href="#chat">
          <span>
            <Sparkles size={20} />
          </span>
          <div>
            Intelligent UI<small>LEARN THROUGH CONVERSATION</small>
          </div>
        </a>
        <button className="new-chat" type="button" onClick={reset}>
          <Plus size={17} />
          新对话<span>↗</span>
        </button>
        <div className="chat-sidebar-label">当前对话</div>
        <div className="active-chat">
          <MessageSquare size={16} />
          <span>{messages[0]?.text?.slice(0, 14) || '认识你的智能界面'}</span>
        </div>
        <div className="chat-sidebar-guide">
          <div className="chat-sidebar-label">在聊天中探索</div>
          {(Object.keys(protocolInfo) as ProtocolId[]).map((id) => {
            const info = protocolInfo[id];
            const Icon = info.icon;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setPrompt(info.prompt);
                  input.current?.focus();
                }}
              >
                <Icon size={16} />
                <span>
                  <strong>{info.name}</strong>
                  <small>{info.short}</small>
                </span>
                <ChevronRight size={13} />
              </button>
            );
          })}
        </div>
        <div className="chat-sidebar-bottom">
          <div className="local-agent-note">
            <span className="online-dot" />
            本地规则 Agent
            <p>
              {STATIC_MODE ? '浏览器内协议实验 · 无需 API Key' : '真实协议通信 · 无需 API Key'}
              <br />
              当前不调用大模型
            </p>
          </div>
          <a href={docHref('map')}>
            <BookOpen size={15} aria-hidden="true" />
            学习文档
            <ArrowRight size={13} aria-hidden="true" />
          </a>
          <a href="#overview">
            <Code2 size={15} />
            独立实验与源码导读
            <ArrowRight size={13} />
          </a>
          <span className="chat-version">
            Intelligent UI Lab <span>v0.2</span>
          </span>
        </div>
      </aside>
      <section className="chat-main" inert={compact && inspectorOpen}>
        <header className="chat-topbar">
          <div>
            <Bot size={19} />
            <strong>Agent 对话</strong>
            <span className="chat-header-divider" />
            <span className="chat-context">
              {turns.length ? `${context.city} · ${context.days} 天` : '从对话到界面'}
            </span>
          </div>
          <div className="chat-top-actions">
            <span className={`connection-state ${health}`}>
              <i />
              {STATIC_MODE
                ? '浏览器内运行'
                : health === 'ready'
                  ? '服务已连接'
                  : health === 'offline'
                    ? '服务未连接'
                    : '正在连接'}
            </span>
            <a
              className="icon-button"
              href={docHref('map')}
              aria-label="打开学习文档"
              title="学习文档"
            >
              <BookOpen size={18} aria-hidden="true" />
            </a>
            <button
              type="button"
              className="icon-button mobile-new-chat"
              onClick={reset}
              aria-label="新对话"
            >
              <Plus size={18} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? '切换浅色模式' : '切换深色模式'}
            >
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button
              ref={inspectorToggle}
              type="button"
              className={`inspect-toggle ${inspectorOpen ? 'active' : ''}`}
              onClick={() => setInspectorOpen(!inspectorOpen)}
              aria-expanded={inspectorOpen}
              aria-label={inspectorOpen ? '关闭协议面板' : '打开协议面板'}
            >
              {inspectorOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
              <span>协议面板</span>
            </button>
          </div>
        </header>
        <RuntimeNotice />
        <div
          className="conversation-scroll"
          ref={scroll}
          onClickCapture={(event) => {
            if ((event.target as Element).closest('button, summary, input, select, textarea')) {
              follow.current = false;
            }
          }}
          onFocusCapture={(event) => {
            if ((event.target as Element).closest('input, select, textarea'))
              follow.current = false;
          }}
          onScroll={() => {
            const node = scroll.current;
            if (node) {
              follow.current = node.scrollHeight - node.clientHeight - node.scrollTop < 100;
              setShowJump(!follow.current);
            }
          }}
        >
          <div className="conversation-content">
            <div className="conversation-date">一个对话，三种界面能力</div>
            <article className="chat-message assistant-message welcome-message">
              <div className="assistant-avatar">
                <Sparkles size={18} />
              </div>
              <div className="assistant-body">
                <div className="message-byline">
                  <strong>Intelligent UI Agent</strong>
                  <span>你的协议学习搭档</span>
                </div>
                <h1>聊一聊，让界面自然发生。</h1>
                <p className="agent-prose">
                  告诉我你的出行想法。我可以一边回复一边展示执行进度，生成你能填写的表单，也能把工具自带的应用带进对话。
                </p>
                {messages.length === 0 && (
                  <>
                    <details className="learning-orientation">
                      <summary>怎样从“看见界面”走到“会开发”？</summary>
                      <ol>
                        <li>追溯：从文字、工具和组件找到协议消息与状态变化。</li>
                        <li>动手：修改事件、组件声明或工具输入，比较实际结果。</li>
                        <li>验证：先预测，再执行实验；用证据检查理解。</li>
                      </ol>
                      <p>
                        AG-UI 管执行事件，A2UI 管组件描述，MCP Apps
                        管工具提供的应用。它们可在产品中组合；这里每轮聚焦一种能力，方便逐层学习。所有练习与结果仅在当前页面保留。
                      </p>
                      <a className="turn-doc-link" href={docHref('first-session')}>
                        <BookOpen size={14} aria-hidden="true" /> 跟着第一次学习教程操作
                        <ArrowRight size={13} aria-hidden="true" />
                      </a>
                    </details>
                    <p className="welcome-hint">
                      从下面一句开始，观察同一段对话怎样长出不同的 UI。
                    </p>
                    <div className="conversation-starters">
                      {(Object.keys(protocolInfo) as ProtocolId[]).map((id) => {
                        const info = protocolInfo[id];
                        const Icon = info.icon;
                        return (
                          <button
                            type="button"
                            key={id}
                            disabled={busy}
                            onClick={() => void send(info.prompt)}
                          >
                            <span className={`starter-icon ${id}`}>
                              <Icon size={17} />
                            </span>
                            <span>
                              <strong>
                                {id === 'agui'
                                  ? '帮我规划杭州三日游'
                                  : id === 'a2ui'
                                    ? '生成一个出行需求表单'
                                    : '打开城市活动应用'}
                              </strong>
                              <small>
                                {info.short} · {info.name}
                              </small>
                            </span>
                            <ArrowUp size={15} />
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </article>
            {messages.map((message) => {
              const turn = message.turnId
                ? turns.find((item) => item.request.id === message.turnId)
                : undefined;
              if (turn)
                return (
                  <TurnContent
                    key={message.id}
                    turn={turn}
                    active={active}
                    selected={turn.request.id === selectedId && inspectorOpen}
                    onTrace={onTrace}
                    onComplete={onComplete}
                    onInteraction={onInteraction}
                    onInspect={inspectTurn}
                  />
                );
              return (
                <article
                  key={message.id}
                  className={`chat-message ${message.role === 'user' ? 'user-message' : 'assistant-message'} ${message.interaction ? 'interaction-message' : ''}`}
                  aria-label={message.role === 'user' ? '你的消息' : 'Agent 回复'}
                >
                  {message.role === 'assistant' && (
                    <div className="assistant-avatar">
                      <Bot size={18} />
                    </div>
                  )}
                  <div className={message.role === 'user' ? 'user-bubble' : 'assistant-body'}>
                    {message.interaction && (
                      <span className="interaction-label">
                        <Check size={12} />
                        {message.role === 'user' ? '界面操作' : '操作结果'}
                      </span>
                    )}
                    <p className="agent-prose">{message.text}</p>
                  </div>
                </article>
              );
            })}
            {routing && (
              <div className="chat-message assistant-message">
                <div className="assistant-avatar">
                  <Bot size={18} />
                </div>
                <p className="chat-run-status" role="status">
                  <LoaderCircle size={14} className="spinner" />
                  正在选择这次回复的界面能力…
                </p>
              </div>
            )}
            {!busy && lastProtocol && (
              <div className="follow-up">
                <span>继续这个对话</span>
                <button
                  type="button"
                  onClick={() => void send(protocolInfo[lastProtocol].suggestion)}
                >
                  {protocolInfo[lastProtocol].suggestion}
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="composer-area">
          {showJump && (
            <button
              className="jump-latest"
              type="button"
              onClick={() => {
                follow.current = true;
                scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'instant' });
              }}
            >
              <ArrowDown size={14} />
              回到最新消息
            </button>
          )}
          {health === 'offline' && (
            <p className="composer-error" role="alert">
              本地服务未连接。
              <button type="button" onClick={() => setHealthAttempt((value) => value + 1)}>
                重新检测
              </button>
            </p>
          )}
          {error && (
            <p className="composer-error" role="alert">
              {error}
            </p>
          )}
          <form
            className="chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label htmlFor="chat-prompt">发送消息给 Agent</label>
            <textarea
              id="chat-prompt"
              ref={input}
              value={prompt}
              maxLength={500}
              rows={2}
              placeholder={
                busy
                  ? 'Agent 正在回复，你可以先写下下一句话…'
                  : '试试「帮我规划杭州三日游」，然后让它生成表单…'
              }
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-toolbar">
              <label className="protocol-mode">
                <Sparkles size={14} />
                <select
                  aria-label="协议选择"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as typeof mode)}
                >
                  <option value="auto">按需求选择示例</option>
                  <option value="agui">AG-UI · 事件流</option>
                  <option value="a2ui">A2UI · 生成组件</option>
                  <option value="mcp">MCP Apps · 工具应用</option>
                </select>
              </label>
              <span className="composer-key-hint">Enter 发送 · Shift + Enter 换行</span>
              <button
                className="send-message"
                type="submit"
                disabled={busy || !prompt.trim()}
                aria-label="发送消息"
              >
                {busy ? <LoaderCircle className="spinner" size={18} /> : <ArrowUp size={19} />}
              </button>
            </div>
          </form>
          <p className="composer-note">
            本地确定性演示，支持杭州、成都、上海的行程、表单与活动。对话仅保存在当前页面。
          </p>
        </div>
      </section>
      {inspectorOpen && (
        <>
          <button
            className="chat-inspector-scrim"
            aria-label="收起协议面板"
            onClick={() => setInspectorOpen(false)}
          />
          <div
            ref={inspector}
            className="chat-inspector-panel"
            role={compact ? 'dialog' : undefined}
            aria-modal={compact || undefined}
            aria-label="本轮协议详情"
          >
            <div className="chat-inspector-header">
              <div>
                <Code2 size={17} />
                <strong>看见底层</strong>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="收起协议检查器"
                onClick={() => setInspectorOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="inspector-intro">
              <span className="chat-sidebar-label">
                {selectedTurn ? '当前查看的回复' : 'CONVERSATION → INTERFACE'}
              </span>
              <h2>
                {selectedTurn
                  ? protocolInfo[selectedTurn.request.protocol].name
                  : '聊天背后，正在发生什么？'}
              </h2>
              <p>
                {selectedTurn?.explanation ??
                  '发送一条消息后，这里会显示该轮对话真实产生的协议消息。你也可以从任意回复底部切换查看。'}
              </p>
              {selectedTurn && (
                <div className="inspected-prompt">“{selectedTurn.request.prompt}”</div>
              )}
            </div>
            <Inspector
              key={selectedTurn?.request.id ?? 'empty'}
              entries={selectedTurn?.entries ?? []}
              focusRequest={
                traceFocus?.turnId === selectedTurn?.request.id
                  ? (traceFocus ?? undefined)
                  : undefined
              }
              onClear={() =>
                setTurns((previous) =>
                  previous.map((turn) =>
                    turn.request.id === selectedTurn?.request.id ? { ...turn, entries: [] } : turn,
                  ),
                )
              }
            />
            <div className="chat-inspector-foot">
              <Braces size={14} />
              <span>
                {selectedTurn
                  ? protocolInfo[selectedTurn.request.protocol].source
                  : '每条消息都来自实际 HTTP、SSE 或 App 桥接'}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
