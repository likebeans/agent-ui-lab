import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Cable,
  Check,
  ChevronRight,
  CircleHelp,
  Code2,
  ExternalLink,
  FlaskConical,
  Layers3,
  Menu,
  Moon,
  Route,
  Sparkles,
  Sun,
  Terminal,
  X,
} from 'lucide-react';
import type { TraceEntry, TraceInput, TraceSelector, TraceFocusRequest } from '../shared/trace';
import { Inspector } from './components/Inspector';
import { docHref } from '../shared/doc-navigation';
import { useTheme } from './useTheme';
import { labFetch } from '../shared/http';
import { isExpectedInstance } from '../shared/instance';
import { labs, getLab, labFromHash, labHref, supportsLabMode } from './labs/registry';
import { useLabRuntime } from './labs/useLabRuntime';
import { STATIC_MODE, describeTrace } from '../shared/runtime';
import { RuntimeNotice } from './components/RuntimeNotice';
import { RecoverableModule } from './components/RecoverableModule';

type Page = string;
type Tab = 'experiment' | 'mechanism' | 'source';

function initialPage(hash: string): Page {
  return labFromHash(hash)?.id ?? (hash === '#roadmap' ? 'roadmap' : 'overview');
}

export function App({
  hash = window.location.hash,
  active: workspaceActive = true,
}: {
  hash?: string;
  active?: boolean;
}) {
  const [page, setPage] = useState<Page>(() => initialPage(hash));
  const [tab, setTab] = useState<Tab>('experiment');
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [traceFocus, setTraceFocus] = useState<TraceFocusRequest>();
  const focusSequence = useRef(0);
  const focusTrace = useCallback((selector: TraceSelector) => {
    setTraceFocus({ ...selector, token: ++focusSequence.current });
  }, []);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!workspaceActive || !menuOpen) return;
    const sidebar = sidebarRef.current;
    sidebar?.querySelector<HTMLButtonElement>('.mobile-close')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !sidebar) return;
      const focusable = [
        ...sidebar.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'),
      ].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const desktop = window.matchMedia('(min-width: 781px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setMenuOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    desktop.addEventListener('change', closeOnDesktop);
    return () => {
      document.removeEventListener('keydown', handleKey);
      desktop.removeEventListener('change', closeOnDesktop);
      menuButtonRef.current?.focus();
    };
  }, [menuOpen, workspaceActive]);
  const [theme, setTheme] = useTheme();
  const [health, setHealth] = useState<'checking' | 'ready' | 'offline'>('checking');
  const [healthAttempt, setHealthAttempt] = useState(0);
  const sequence = useRef(0);
  const onTrace = useCallback((entry: TraceInput) => {
    const nextEntry = { ...describeTrace(entry), id: ++sequence.current, time: Date.now() };
    setEntries((previous) => [...previous, nextEntry].slice(-300));
  }, []);
  const onResetTrace = useCallback(() => setEntries([]), []);

  useEffect(() => {
    setPage(initialPage(hash));
    setTab('experiment');
    setEntries([]);
    setTraceFocus(undefined);
    setMenuOpen(false);
  }, [hash]);
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    labFetch('/api/health', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((value: unknown) => {
        if (!isExpectedInstance(value)) throw new Error('服务实例不匹配。');
        if (mounted) setHealth('ready');
      })
      .catch(() => {
        if (mounted) setHealth('offline');
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      mounted = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [healthAttempt]);

  const selectedLab = getLab(page);
  const active = selectedLab
    ? {
        ...selectedLab.presentation,
        number: selectedLab.number,
        files: selectedLab.sourceReferences,
      }
    : null;
  const chapter = selectedLab?.docs;
  function navigate(next: Page) {
    window.location.hash = getLab(next) ? labHref(next) : next;
  }

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        跳到主要内容
      </a>
      {menuOpen && (
        <button
          className="sidebar-scrim"
          onClick={() => setMenuOpen(false)}
          aria-label="关闭导航"
        />
      )}
      <aside
        id="workspace-sidebar"
        ref={sidebarRef}
        className={`sidebar ${menuOpen ? 'open' : ''}`}
        role={menuOpen ? 'dialog' : undefined}
        aria-modal={menuOpen || undefined}
        aria-label={menuOpen ? '工作区导航' : undefined}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) setMenuOpen(false);
        }}
      >
        <div className="brand">
          <a className="brand-mark" href="#overview" aria-label="Agent UI Lab 首页">
            <FlaskConical size={21} aria-hidden="true" />
          </a>
          <span>
            Agent UI<span className="brand-subtitle">THE LEARNING LAB</span>
          </span>
          <button
            type="button"
            className="mobile-close icon-button"
            onClick={() => setMenuOpen(false)}
            aria-label="收起导航"
          >
            <X size={18} />
          </button>
        </div>
        <div className="workspace-label">
          <span className="workspace-avatar">L</span>
          <span>
            我的学习空间<small>Local workspace</small>
          </span>
          <span className="local-pill">{STATIC_MODE ? '静态' : '本地'}</span>
        </div>
        <nav aria-label="主要导航">
          <a href="#chat" className="nav-link">
            <Sparkles size={18} aria-hidden="true" /> 返回 Agent 对话
          </a>
          <p className="nav-caption">开始探索</p>
          <a
            href="#overview"
            className={`nav-link ${page === 'overview' ? 'active' : ''}`}
            aria-current={page === 'overview' ? 'page' : undefined}
          >
            <BookOpen size={18} aria-hidden="true" /> 学习总览
          </a>
          <p className="nav-caption spaced">
            能力实验 <span>{String(labs.length).padStart(2, '0')}</span>
          </p>
          {labs.map((lab) => {
            const id = lab.id;
            const item = { ...lab.presentation, number: lab.number };
            const Icon = item.icon;
            return (
              <a
                key={id}
                href={labHref(id)}
                className={`nav-link ${page === id ? 'active' : ''}`}
                aria-current={page === id ? 'page' : undefined}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.name}</span>
                <span className="nav-number">{item.number}</span>
              </a>
            );
          })}
          <p className="nav-caption spaced">继续深入</p>
          <a href={docHref('map')} className="nav-link">
            <BookOpen size={18} aria-hidden="true" /> 学习文档
          </a>
          <a
            href="#roadmap"
            className={`nav-link ${page === 'roadmap' ? 'active' : ''}`}
            aria-current={page === 'roadmap' ? 'page' : undefined}
          >
            <Route size={18} aria-hidden="true" /> 实践路线
          </a>
          <a
            href="https://github.com/ag-ui-protocol/ag-ui"
            target="_blank"
            rel="noreferrer"
            className="nav-link"
          >
            <Code2 size={18} aria-hidden="true" /> 官方源码{' '}
            <ArrowUpRight size={14} className="trailing-icon" aria-hidden="true" />
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Sparkles size={16} aria-hidden="true" />
            <strong>从看见，到理解，再到构建。</strong>
            <p>
              每个实验，都能沿着协议消息
              <br />
              找到对应的实现。
            </p>
            <a href="#roadmap">
              查看学习路线 <ArrowRight size={13} aria-hidden="true" />
            </a>
          </div>
          <div className="sidebar-footer">
            <span>
              <span className="status-dot" /> {STATIC_MODE ? '静态学习环境' : '本地实验环境'}
            </span>
            <span>v0.1</span>
          </div>
        </div>
      </aside>

      <div className="main-shell" inert={menuOpen}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu icon-button"
              ref={menuButtonRef}
              aria-expanded={menuOpen}
              aria-controls="workspace-sidebar"
              onClick={() => setMenuOpen(true)}
              aria-label="打开导航"
            >
              <Menu size={19} />
            </button>
            <FlaskConical size={15} aria-hidden="true" />
            <span>Workspace</span>
            <ChevronRight size={13} aria-hidden="true" />
            <strong>{active?.name ?? (page === 'roadmap' ? '实践路线' : '学习总览')}</strong>
          </div>
          <div className="topbar-actions">
            <span className={`backend-status ${health}`}>
              <span className="status-dot" />
              {STATIC_MODE
                ? '浏览器内运行'
                : health === 'ready'
                  ? '服务已连接'
                  : health === 'checking'
                    ? '连接中'
                    : '服务未连接'}
            </span>
            <a
              className="icon-button"
              href={docHref(chapter ?? 'map')}
              aria-label="打开学习文档"
              title="学习文档"
            >
              <BookOpen size={18} aria-hidden="true" />
            </a>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              aria-label={theme === 'light' ? '切换深色模式' : '切换浅色模式'}
            >
              {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
            </button>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className={`main-content ${active ? 'lab-content' : ''}`}
        >
          <RuntimeNotice />
          {page === 'overview' && <Overview navigate={navigate} />}
          {page === 'roadmap' && <Roadmap navigate={navigate} />}
          {active && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    <span className={`protocol-mini ${active.color}`}>{active.number}</span>{' '}
                    INTERACTION LAB <span className="eyebrow-divider">/</span> {active.transport}
                  </div>
                  <h1>
                    {active.name}
                    <span className="heading-tag">{active.label}</span>
                  </h1>
                  <p>
                    {active.subtitle}。{active.description}
                  </p>
                </div>
                <a
                  className="button secondary docs-button"
                  href={active.docs ?? docHref(chapter ?? 'map')}
                  target={active.docs ? '_blank' : undefined}
                  rel={active.docs ? 'noreferrer' : undefined}
                >
                  {active.docs ? '官方文档' : '实验文档'}{' '}
                  <ArrowUpRight size={15} aria-hidden="true" />
                </a>
              </div>
              <div className="lab-tabs" role="tablist" aria-label="实验视图">
                {(
                  [
                    ['experiment', FlaskConical, '交互实验'],
                    ['mechanism', Layers3, '原理拆解'],
                    ['source', Code2, '源码导读'],
                  ] as const
                ).map(([id, Icon, label]) => (
                  <button
                    key={id}
                    id={`tab-${id}`}
                    role="tab"
                    tabIndex={tab === id ? 0 : -1}
                    aria-selected={tab === id}
                    aria-controls={`panel-${id}`}
                    className={tab === id ? 'selected' : ''}
                    onClick={() => setTab(id)}
                    onKeyDown={(event) => {
                      const tabs: Tab[] = ['experiment', 'mechanism', 'source'];
                      const index = tabs.indexOf(tab);
                      const next =
                        event.key === 'ArrowRight'
                          ? (index + 1) % 3
                          : event.key === 'ArrowLeft'
                            ? (index + 2) % 3
                            : event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? 2
                                : -1;
                      if (next !== -1) {
                        event.preventDefault();
                        setTab(tabs[next]);
                        document.getElementById(`tab-${tabs[next]}`)?.focus();
                      }
                    }}
                  >
                    <Icon size={16} aria-hidden="true" />
                    {label}
                  </button>
                ))}
                <span className="tabs-note">本地数据 · 无需 API Key</span>
              </div>
              <div
                id="panel-experiment"
                role="tabpanel"
                aria-labelledby="tab-experiment"
                hidden={tab !== 'experiment'}
              >
                <ol className="flow-strip">
                  {active.steps.map((step, index) => (
                    <li key={step}>
                      <span>{index + 1}</span>
                      {step}
                      {index < active.steps.length - 1 && (
                        <ArrowRight size={14} aria-hidden="true" />
                      )}
                    </li>
                  ))}
                </ol>
                {health === 'offline' && (
                  <div className="error-banner">
                    后端未连接。请在项目目录运行 <code>npm run dev</code>。
                    <button
                      className="text-button"
                      onClick={() => {
                        setHealth('checking');
                        setHealthAttempt((attempt) => attempt + 1);
                      }}
                    >
                      重新检测连接
                    </button>
                  </div>
                )}
                <div className="lab-workbench">
                  <div className="experiment-panel">
                    {selectedLab && (
                      <RegisteredExperiment
                        key={selectedLab.id}
                        labId={selectedLab.id}
                        active={workspaceActive && tab === 'experiment'}
                        onTrace={onTrace}
                        onResetTrace={onResetTrace}
                        focusTrace={focusTrace}
                      />
                    )}
                  </div>
                  <Inspector
                    key={page}
                    entries={entries.filter((entry) => entry.labId === page)}
                    focusRequest={traceFocus}
                    onClear={onResetTrace}
                  />
                </div>
                <div className="learning-tip">
                  <CircleHelp size={17} aria-hidden="true" />
                  <p>
                    <strong>带着问题操作：</strong>
                    {active.question}{' '}
                    <button className="text-button" onClick={() => setTab('mechanism')}>
                      查看原理 <ArrowRight size={13} aria-hidden="true" />
                    </button>{' '}
                    <a className="text-link" href={docHref(chapter ?? 'map')}>
                      阅读完整教程 <BookOpen size={13} aria-hidden="true" />
                    </a>
                  </p>
                </div>
              </div>
              {tab === 'mechanism' && (
                <section
                  id="panel-mechanism"
                  role="tabpanel"
                  aria-labelledby="tab-mechanism"
                  className="reading-panel"
                >
                  <span className="eyebrow">UNDER THE HOOD</span>
                  <h2>{active.question}</h2>
                  <p className="reading-lead">{active.explanation}</p>
                  <div className="concept-list">
                    {active.concepts.map(([title, text], index) => (
                      <article key={title}>
                        <span className="concept-number">0{index + 1}</span>
                        <div>
                          <h3>{title}</h3>
                          <p>{text}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                  <div className="callout">
                    <strong>它们可以组合使用。</strong>
                    <p>
                      AG-UI 管 Agent 与前端的事件；A2UI 管声明式界面；MCP Apps
                      管工具提供的应用。可以让 AG-UI 携带 A2UI 消息，也可以在 Host 中嵌入 MCP
                      App。这三个实验先把各自边界单独跑通。
                    </p>
                  </div>
                  <a
                    className="text-link"
                    href={active.docs ?? docHref(chapter ?? 'map')}
                    target={active.docs ? '_blank' : undefined}
                    rel={active.docs ? 'noreferrer' : undefined}
                  >
                    {active.docs ? '阅读官方协议定义' : '阅读实验接入说明'}{' '}
                    <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </section>
              )}
              {tab === 'source' && (
                <section
                  id="panel-source"
                  role="tabpanel"
                  aria-labelledby="tab-source"
                  className="reading-panel"
                >
                  <span className="eyebrow">FOLLOW THE CODE</span>
                  <h2>从消息，追到实现。</h2>
                  <p className="reading-lead">
                    按下面的顺序在编辑器里打开文件，和右侧检查器中的 payload 对照。
                    <a className="text-link" href={docHref(chapter ?? 'map')}>
                      打开 {active.name} 完整学习笔记
                    </a>
                    ，可以边读教程边返回当前实验。
                  </p>
                  <div className="source-list">
                    {active.files.map((file, index) => (
                      <div key={file}>
                        <span>0{index + 1}</span>
                        <Code2 size={19} aria-hidden="true" />
                        <code>{file}</code>
                        <span>
                          {file.startsWith('server')
                            ? '服务端'
                            : file.startsWith('shared')
                              ? '共用协议与生成逻辑'
                              : '前端'}
                        </span>
                      </div>
                    ))}
                  </div>
                  <h3>动手改一处，再观察差异</h3>
                  <p>{active.exercise}</p>
                  <div className="terminal-block">
                    <Terminal size={16} aria-hidden="true" />
                    <code>npm run check</code>
                    <span>测试 + 类型检查 + 构建</span>
                  </div>
                </section>
              )}
            </>
          )}
        </main>
        <footer className="page-footer">
          <span>
            Agent UI Lab <span className="footer-separator">/</span> 理解协议，构建交互。
          </span>
          <span>
            Built for curiosity <Sparkles size={12} aria-hidden="true" />
          </span>
        </footer>
      </div>
    </div>
  );
}

function RegisteredExperiment({
  labId,
  active,
  onTrace,
  onResetTrace,
  focusTrace,
}: {
  labId: string;
  active: boolean;
  onTrace: (entry: TraceInput) => void;
  onResetTrace: () => void;
  focusTrace: (selector: TraceSelector) => void;
}) {
  const lab = getLab(labId)!;
  const identity = useMemo(() => ({ labId }), [labId]);
  const runtime = useLabRuntime(identity, onTrace, focusTrace);
  if (!supportsLabMode(lab, runtime.mode)) return <p role="status">此实验暂不支持当前运行模式。</p>;
  return (
    <RecoverableModule
      load={lab.load}
      componentProps={{ runtime, active, onResetTrace }}
      name={`${lab.presentation.name} 实验`}
      returnTo="#overview"
      returnLabel="返回学习总览"
      active={active}
    />
  );
}

function Overview({ navigate }: { navigate: (page: Page) => void }) {
  return (
    <>
      <div className="overview-kicker">
        <span className="status-dot" /> YOUR NEXT FRONTEND CHAPTER
      </div>
      <div className="overview-title">
        <div>
          <h1>
            让 AI 不止于对话<span className="accent-dot">。</span>
          </h1>
          <p>
            面向前端开发者的交互式学习与参考实现。
            <br className="mobile-break" /> 从第一条消息，到一个完整应用。
          </p>
        </div>
        <span className="edition-label">
          LEARN BY BUILDING <span>VOL. 001 — PROTOCOLS</span>
        </span>
      </div>
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="hero-label">
            <FlaskConical size={15} aria-hidden="true" /> 你的 Agent UI 实验台
          </span>
          <h2>
            看得见的界面，
            <br />
            读得懂的底层。
          </h2>
          <p>
            运行一个实验，检查每条协议消息。
            <br />
            把「它是怎么做到的」变成「我也能构建它」。
          </p>
          <button className="button primary" onClick={() => navigate('agui')}>
            开始第一个实验 <ArrowRight size={16} aria-hidden="true" />
          </button>
          <div className="hero-footnote">
            <Check size={13} aria-hidden="true" /> 无需模型密钥 <span>·</span> 本地真实通信{' '}
            <span>·</span> 源码可读
          </div>
        </div>
        <div className="hero-illustration" aria-hidden="true">
          <div className="illustration-window">
            <div className="window-top">
              <span />
              <span />
              <span />
              <code>intelligent-interface.tsx</code>
            </div>
            <div className="code-sample">
              <span className="code-comment">// From intent to interface</span>
              <span>
                <b>const</b> interaction = {'{'}
              </span>
              <span>
                {' '}
                <i>intent</i>: <em>"Build something useful"</em>,
              </span>
              <span>
                {' '}
                <i>protocol</i>: <em>"open"</em>,
              </span>
              <span>
                {' '}
                <i>possibilities</i>: <strong>Infinity</strong>
              </span>
              <span>{'}'};</span>
            </div>
            <div className="illustration-result">
              <span className="result-symbol">
                <Sparkles size={21} />
              </span>
              <div>
                <strong>从意图，到交互</strong>
                <span>Interface is ready.</span>
              </div>
              <span className="result-check">
                <Check size={16} />
              </span>
            </div>
          </div>
          <div className="floating-tag">
            <span className="status-dot" /> Let's make it interactive.
          </div>
        </div>
      </section>
      <div className="section-heading">
        <div>
          <span className="eyebrow">THE LAB COLLECTION</span>
          <h2>按能力，选择一个实验。</h2>
        </div>
        <span className="section-caption">
          独立理解，也能协同工作 <ArrowDown size={14} aria-hidden="true" />
        </span>
      </div>
      <div className="protocol-grid">
        {labs.map((lab) => {
          const id = lab.id;
          const item = { ...lab.presentation, number: lab.number };
          const Icon = item.icon;
          return (
            <button key={id} className={`protocol-card ${item.color}`} onClick={() => navigate(id)}>
              <div className="protocol-card-top">
                <span className="protocol-icon">
                  <Icon size={23} strokeWidth={1.7} aria-hidden="true" />
                </span>
                <span className="protocol-card-number">LAB {item.number}</span>
              </div>
              <h3>
                {item.name}
                <ArrowUpRight size={19} aria-hidden="true" />
              </h3>
              <strong>{item.label}</strong>
              <p>{item.description}</p>
              <div className="protocol-card-footer">
                <code>{item.transport}</code>
                <span>
                  进入实验 <ArrowRight size={14} aria-hidden="true" />
                </span>
              </div>
            </button>
          );
        })}
      </div>
      <section className="start-guide">
        <div className="start-guide-icon">
          <Route size={24} aria-hidden="true" />
        </div>
        <div>
          <h3>第一次接触？按这条路线开始。</h3>
          <p>先理解事件流，再认识声明式 UI，最后把工具变成应用。每一步都有实验和源码。</p>
        </div>
        <button className="button secondary" onClick={() => navigate('roadmap')}>
          查看实践路线 <ArrowRight size={15} aria-hidden="true" />
        </button>
      </section>
      <div className="honesty-note">
        <Cable size={15} aria-hidden="true" />
        <p>
          实验使用真实 HTTP / SSE / MCP 通信；Agent
          决策与业务数据由本地代码生成。协议边界在这里变得可观察，接入模型是下一步。
        </p>
      </div>
    </>
  );
}

function Roadmap({ navigate }: { navigate: (page: Page) => void }) {
  const lessons: { title: string; body: string; action: string; page: Page; done: string }[] = [
    {
      title: '先读懂一条事件流',
      body: '运行 AG-UI 助手，观察请求、文本片段、工具参数、状态快照。再取消一次运行，触发一次错误。',
      action: '打开 AG-UI',
      page: 'agui',
      done: '能解释“请求结束”和“工具执行结束”的区别。',
    },
    {
      title: '让数据驱动一棵组件树',
      body: '在 A2UI 中生成行程表单，修改字段并提交。对照组件 JSON、数据模型和动作载荷。',
      action: '打开 A2UI',
      page: 'a2ui',
      done: '能给 Renderer 增加一个白名单组件，并把值绑定到模型。',
    },
    {
      title: '打通应用与宿主之间的桥',
      body: '打开 MCP App，检查工具发现、资源读取和握手。操作应用，让它通过宿主重新调用工具。',
      action: '打开 MCP Apps',
      page: 'mcp',
      done: '能画出 App → Host → MCP Server 的调用边界。',
    },
    {
      title: '在远端变化时保护编辑',
      body: '进入 A2UI 兼容实验，验证能力降级和动态校验。保存动作后继续编辑，再制造远端更新，比较草稿、版本与成功计数。',
      action: '打开兼容与编辑冲突',
      page: 'a2ui-compatibility',
      done: '能保留本地草稿、解决字段冲突，并解释过期动作为什么被拒绝。',
    },
    {
      title: '断开连接后恢复任务',
      body: '启动任务后断开接流，再恢复连接并刷新。对照 checkpoint、事件游标和本地工具执行次数，区分恢复与重新执行。',
      action: '打开任务恢复',
      page: 'task-recovery',
      done: '能证明恢复接续同一个 run，且已提交的本地工具结果没有重复执行。',
    },
    {
      title: '让用户确认成为可查询的事实',
      body: '生成报名提议，修改并确认。模拟提交后丢失响应，再查询业务事实，使用原命令重试并检查报名记录数。',
      action: '打开人工确认',
      page: 'human-approval',
      done: '能区分等待确认、结果未知与已确认，并证明重复提交没有重复报名。',
    },
    {
      title: '把表单、确认与恢复连成一次报名',
      body: '保存 A2UI 表单提议，确认具体版本，再模拟响应丢失。沿同一个 task 和 run 查询事件、命令收据与报名事实。',
      action: '打开活动报名联合实验',
      page: 'enrollment-workflow',
      done: '能解释草稿、已保存提议与报名事实的区别，并用同一报名 ID 证明原命令重试没有重复写入。',
    },
    {
      title: '从实验走向真实开发',
      body: '先按 docs/08-independent-project.md 独立完成只读活动报名准备，再沿 docs/04-real-development.md 接入真实模型与业务 API，补齐鉴权、权限和部署。',
      action: '回到实验总览',
      page: 'overview',
      done: '能明确区分模型决策、协议转换、业务执行与 UI 渲染。',
    },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">A PATH TO BUILDING</span>
          <h1>从会看，到会做。</h1>
          <p>每完成一个实验，就多掌握一段真实开发链路。按自己的节奏来。</p>
        </div>
        <Route size={32} strokeWidth={1.3} aria-hidden="true" />
      </div>
      <div className="roadmap-list">
        {lessons.map((lesson, index) => (
          <article key={lesson.title}>
            <span className="lesson-number">0{index + 1}</span>
            <div>
              <span className="eyebrow">CHAPTER 0{index + 1}</span>
              <h2>{lesson.title}</h2>
              <p>{lesson.body}</p>
              <div className="lesson-outcome">
                <Check size={15} aria-hidden="true" />
                {lesson.done}
              </div>
              <button className="text-button" onClick={() => navigate(lesson.page)}>
                {lesson.action} <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="callout">
        <strong>推荐的阅读方式</strong>
        <p>
          把浏览器和编辑器并排放置：左边操作实验，右边从 docs/README.md
          开始，沿消息追到对应的类型、路由与渲染器。读完后合上笔记，自己解释一次数据的往返。
        </p>
      </div>
    </>
  );
}
