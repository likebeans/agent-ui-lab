import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Bot,
  Braces,
  Check,
  ChevronRight,
  Code2,
  LoaderCircle,
  Menu,
  MessageSquare,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import type { LabContext, LabChatRequest, LabChatTurnProps } from '../shared/lab-contract';
import { mergeLabContext } from '../shared/lab-context';
import type { TraceEntry, TraceInput, TraceSelector, TraceFocusRequest } from '../shared/trace';
import { errorMessage, labFetch } from '../shared/http';
import { isExpectedInstance } from '../shared/instance';
import { chatLabs, getLab } from './labs/registry';
import { resolveChatLab } from './labs/chat';
import { useLabRuntime } from './labs/useLabRuntime';
import { tripContext } from './labs/legacy';
import { STATIC_MODE, describeTrace } from '../shared/runtime';
import { RuntimeNotice } from './components/RuntimeNotice';
import { RecoverableModule } from './components/RecoverableModule';
import { Inspector } from './components/Inspector';
import { docHref } from '../shared/doc-navigation';
import { useTheme } from './useTheme';
import './chat.css';
import './learning.css';

type Turn = {
  request: LabChatRequest;
  explanation: string;
  summary?: string;
  entries: TraceEntry[];
};
type Message = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  turnId?: string;
  interaction?: boolean;
  failure?: { reason: string; mode: string };
};
const initialContext: LabContext = { trip: { city: '杭州', days: 3 } };

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
  onRetry,
  onInteraction,
  onInspect,
  selected,
  active,
  busy,
}: {
  turn: Turn;
  selected: boolean;
  active: boolean;
  busy: boolean;
  onTrace: (id: string, entry: TraceInput) => void;
  onComplete: (id: string, summary: string) => void;
  onRetry: (id: string) => void;
  onInteraction: (
    id: string,
    exchange: { user: string; assistant: string; context?: LabContext },
  ) => void;
  onInspect: (id: string, selector?: TraceSelector) => void;
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
    (exchange: { user: string; assistant: string; context?: LabContext }) =>
      onInteraction(turn.request.id, exchange),
    [onInteraction, turn.request.id],
  );
  const lab = getLab(turn.request.labId)!;
  const info = lab.presentation;
  const Icon = info.icon;
  const identity = useMemo(
    () => ({ labId: lab.id, threadId: turn.request.threadId, turnId: turn.request.id }),
    [lab.id, turn.request],
  );
  const focusTrace = useCallback(
    (selector: TraceSelector) => onInspect(turn.request.id, selector),
    [onInspect, turn.request.id],
  );
  const runtime = useLabRuntime(identity, trace, focusTrace);
  const props: LabChatTurnProps = {
    runtime,
    active,
    request: turn.request,
    onComplete: complete,
    onInteraction: interact,
    onInspectTrace: focusTrace,
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
          <strong>Agent UI Agent</strong>
          <span className={`protocol-tag ${turn.request.labId}`}>
            <Icon size={12} />
            {info.name}
          </span>
        </div>
        <TurnBoundary onFailure={() => complete('回复渲染失败')}>
          <RecoverableModule
            load={lab.chat!.load}
            componentProps={props}
            name={`${info.name} 回复`}
            active={active}
            retryDisabled={busy}
            loadErrorsOnly
            onFailure={() => complete('回复模块加载失败')}
            onRetry={() => onRetry(turn.request.id)}
          />
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
        <a className="turn-doc-link" href={docHref(lab.docs)}>
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
  const promptRevision = useRef(0);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigation = useRef<HTMLDivElement>(null);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState('auto');
  const [context, setContext] = useState<LabContext>(initialContext);
  const [pending, setPending] = useState<string | null>(null);
  const [routing, setRouting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [traceFocus, setTraceFocus] = useState<(TraceFocusRequest & { turnId: string }) | null>(
    null,
  );
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
  const [showJump, setShowJump] = useState(false);
  const threadId = useRef(`thread-${crypto.randomUUID()}`);
  const generation = useRef(0);
  const activeTurns = useRef(new Set<string>());
  const sequence = useRef(0);
  const sending = useRef(false);
  const routingController = useRef<AbortController | null>(null);
  const routingUpdates = useRef<LabContext | null>(null);
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

  const closeNavigation = useCallback(() => {
    setNavigationOpen(false);
    navigationToggle.current?.focus();
  }, []);
  useEffect(() => {
    if (!navigationOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeNavigation();
    };
    const outside = (event: PointerEvent) => {
      if (!navigation.current?.contains(event.target as Node)) setNavigationOpen(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
    };
  }, [navigationOpen, closeNavigation]);
  useEffect(() => {
    if (!active || inspectorOpen) setNavigationOpen(false);
  }, [active, inspectorOpen]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 780px)');
    const changed = () => {
      if (!media.matches) setNavigationOpen(false);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let active = true;
    setHealth('checking');
    void labFetch('/api/health', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((value: unknown) => {
        if (!isExpectedInstance(value)) throw new Error('服务实例不匹配。');
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
  const onRetry = useCallback((id: string) => {
    if (!activeTurns.current.has(id)) return;
    sending.current = true;
    setPending(id);
    setTurns((previous) =>
      previous.map((turn) => (turn.request.id === id ? { ...turn, summary: undefined } : turn)),
    );
  }, []);
  const onInteraction = useCallback(
    (id: string, exchange: { user: string; assistant: string; context?: LabContext }) => {
      if (!activeTurns.current.has(id)) return;
      const patch = exchange.context;
      if (patch) {
        if (routingUpdates.current !== null)
          routingUpdates.current = mergeLabContext(routingUpdates.current, patch);
        setContext((previous) => mergeLabContext(previous, patch));
      }
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

  async function send(value?: string, retryMessage?: Message) {
    const draft = value ?? prompt;
    const text = draft.trim();
    if (!text || text.length > 500 || sending.current || busy) return;
    const editedMessage =
      value === undefined
        ? messages.find((message) => message.id === editingMessageId && message.failure)
        : undefined;
    const previousMessage = retryMessage ?? editedMessage;
    const draftRevision = promptRevision.current;
    sending.current = true;
    const epoch = generation.current;
    const id = crypto.randomUUID();
    const userMessageId = previousMessage?.id ?? `user-${id}`;
    const requestMode = previousMessage?.failure?.mode ?? mode;
    const controller = new AbortController();
    routingController.current = controller;
    routingUpdates.current = {};
    const timeout = setTimeout(() => controller.abort(), 8000);
    setRouting(true);
    if (!retryMessage) {
      setPrompt('');
      setEditingMessageId(null);
    }
    follow.current = true;
    setMessages((previous) =>
      previousMessage
        ? previous.map((message) =>
            message.id === userMessageId ? { ...message, text, failure: undefined } : message,
          )
        : [...previous, { id: userMessageId, role: 'user', text }],
    );
    try {
      const route = await resolveChatLab(text, requestMode, context, controller.signal);
      if (epoch !== generation.current) return;
      if (retryMessage) {
        if (
          retryMessage.id === editingMessageId &&
          promptRevision.current === draftRevision &&
          prompt.trim() === text
        )
          setPrompt('');
        setEditingMessageId((current) => (current === retryMessage.id ? null : current));
      }
      // Successful interactions during routing take precedence over its request snapshot.
      const nextContext = mergeLabContext(route.context, routingUpdates.current ?? {});
      routingUpdates.current = null;
      const history = messages.flatMap((message) => {
        if (message.failure || message.id === userMessageId) return [];
        const turn = turns.find((item) => item.request.id === message.turnId);
        const content = message.text ?? turn?.summary;
        return content ? [{ id: message.id, role: message.role, content }] : [];
      });
      const request: LabChatRequest = {
        id,
        threadId: threadId.current,
        prompt: text,
        labId: route.labId,
        context: nextContext,
        history: history.slice(-48),
      };
      setContext(nextContext);
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
      const reason = controller.signal.aborted
        ? '请求超时，请确认本地服务连接后重试。'
        : errorMessage(cause);
      setMessages((previous) =>
        previous.map((message) =>
          message.id === userMessageId
            ? { ...message, failure: { reason, mode: requestMode } }
            : message,
        ),
      );
      // Restore only a submitted composer draft that the user has not edited since.
      // A deliberately cleared next draft also counts as an edit.
      if (value === undefined && promptRevision.current === draftRevision) {
        setPrompt(draft);
        setEditingMessageId(userMessageId);
      }
      sending.current = false;
    } finally {
      clearTimeout(timeout);
      if (epoch === generation.current) {
        routingUpdates.current = null;
        setRouting(false);
      }
    }
  }

  function editFailedMessage(message: Message) {
    promptRevision.current += 1;
    setPrompt(message.text ?? '');
    setEditingMessageId(message.id);
    input.current?.focus();
  }

  function reset() {
    generation.current += 1;
    promptRevision.current += 1;
    setEditingMessageId(null);
    routingController.current?.abort();
    routingUpdates.current = null;
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
    setPrompt('');
    follow.current = true;
    input.current?.focus();
  }

  const inspectTurn = useCallback((id: string, selector?: TraceSelector) => {
    setSelectedId(id);
    setTraceFocus(selector ? { ...selector, turnId: id, token: ++focusSequence.current } : null);
    setInspectorOpen(true);
  }, []);
  const lastLab = getLab(turns.at(-1)?.request.labId ?? '');
  const trip = tripContext(context);

  return (
    <div className={`conversation-app ${inspectorOpen ? 'with-inspector' : ''}`}>
      <aside className="chat-sidebar" aria-label="聊天工作区" inert={compact && inspectorOpen}>
        <a className="chat-brand" href="#chat">
          <span>
            <Sparkles size={20} />
          </span>
          <div>
            Agent UI<small>LEARN THROUGH CONVERSATION</small>
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
          {chatLabs.map((lab) => {
            const id = lab.id;
            const info = { ...lab.presentation, ...lab.chat! };
            const Icon = info.icon;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  promptRevision.current += 1;
                  setEditingMessageId(null);
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
            Agent UI Lab <span>v0.2</span>
          </span>
        </div>
      </aside>
      <section className="chat-main" inert={compact && inspectorOpen}>
        <header className="chat-topbar">
          <div>
            <div
              className="chat-mobile-navigation"
              ref={navigation}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setNavigationOpen(false);
              }}
            >
              <button
                ref={navigationToggle}
                type="button"
                className="icon-button"
                aria-label={navigationOpen ? '关闭聊天导航' : '打开聊天导航'}
                aria-expanded={navigationOpen}
                aria-controls="chat-mobile-navigation"
                onClick={() => setNavigationOpen((open) => !open)}
              >
                {navigationOpen ? (
                  <X size={19} aria-hidden="true" />
                ) : (
                  <Menu size={19} aria-hidden="true" />
                )}
              </button>
              <nav
                id="chat-mobile-navigation"
                className="chat-mobile-navigation-links"
                aria-label="聊天导航"
                hidden={!navigationOpen}
              >
                <a href="#overview" onClick={closeNavigation}>
                  <Code2 size={17} aria-hidden="true" />
                  独立实验与源码导读
                  <ArrowRight size={15} aria-hidden="true" />
                </a>
                <a href="#roadmap" onClick={closeNavigation}>
                  <ArrowRight size={17} aria-hidden="true" />
                  实践路线
                  <ArrowRight size={15} aria-hidden="true" />
                </a>
                <a href={docHref('map')} onClick={closeNavigation}>
                  <BookOpen size={17} aria-hidden="true" />
                  学习文档
                  <ArrowRight size={15} aria-hidden="true" />
                </a>
              </nav>
            </div>
            <Bot size={19} />
            <strong>Agent 对话</strong>
            <span className="chat-header-divider" />
            <span className="chat-context">
              {turns.length ? `${trip.city} · ${trip.days} 天` : '从对话到界面'}
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
                  <strong>Agent UI Agent</strong>
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
                      {chatLabs.map((lab) => {
                        const id = lab.id;
                        const info = { ...lab.presentation, ...lab.chat! };
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
                              <strong>{info.starter}</strong>
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
                    busy={busy}
                    selected={turn.request.id === selectedId && inspectorOpen}
                    onTrace={onTrace}
                    onComplete={onComplete}
                    onRetry={onRetry}
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
                    {message.failure && (
                      <div className="chat-message-failure">
                        <p role="alert">未能发送：{message.failure.reason}</p>
                        <div className="chat-failure-actions">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => editFailedMessage(message)}
                          >
                            修改这条消息
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void send(message.text, message)}
                          >
                            重试这条消息
                          </button>
                        </div>
                      </div>
                    )}
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
            {!busy && lastLab?.chat && (
              <div className="follow-up">
                <span>继续这个对话</span>
                <button type="button" onClick={() => void send(lastLab.chat!.suggestion)}>
                  {lastLab.chat!.suggestion}
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
          {editingMessageId && (
            <p className="composer-editing" role="status">
              正在修改未发送的消息
              <button type="button" onClick={() => setEditingMessageId(null)}>
                改为新消息
              </button>
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
              onChange={(event) => {
                promptRevision.current += 1;
                setPrompt(event.target.value);
              }}
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
                  {chatLabs.map((lab) => (
                    <option key={lab.id} value={lab.id}>
                      {lab.presentation.name} · {lab.chat!.short}
                    </option>
                  ))}
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
                  ? getLab(selectedTurn.request.labId)?.presentation.name
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
                  ? getLab(selectedTurn.request.labId)?.chat?.source
                  : '每条消息都来自实际 HTTP、SSE 或 App 桥接'}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
