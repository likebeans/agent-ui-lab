import { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Copy, RefreshCw } from 'lucide-react';
import type { LabComponentProps } from '../../../shared/lab-contract';
import { errorMessage } from '../../../shared/http';
import { resolveA2uiAction, type A2uiSurface } from '../../../shared/a2ui';
import type { JsonValue } from '../../../shared/json-pointer';
import { COMPATIBILITY_DROP_RESPONSE_HEADER } from '../../../shared/labs/a2ui-compatibility/contract';
import type {
  ActionEnvelope,
  ClientCapabilities,
  CompatibilityReply,
  CompatibilityScenario,
  CompatibilitySnapshot,
  DraftState,
  FieldIssue,
  RemoteChange,
} from '../../../shared/labs/a2ui-compatibility/contract';
import {
  DEFAULT_CAPABILITIES,
  checkCompatibility,
  createDraft,
  rebaseDraft,
  resolveDraftConflict,
  trackDraftSubmission,
  updateDraft,
  validateFields,
} from '../../../shared/labs/a2ui-compatibility/draft';
import { readCompatibilityReply } from '../../../shared/labs/a2ui-compatibility/response';
import { SurfaceRenderer } from '../../components/A2uiSurfaceRenderer';
import styles from './lab.module.css';

interface SavedAction {
  documentId: string;
  envelope: ActionEnvelope;
  surface: A2uiSurface;
}

const basePath = '/api/labs/a2ui-compatibility/documents';
const scenarioLabels: Record<CompatibilityScenario, string> = {
  standard: '标准旅行表单',
  'unknown-catalog': '未知 catalog',
  'unknown-component': '未知组件类型',
};

function snapshotFrom(reply: CompatibilityReply): CompatibilitySnapshot | undefined {
  return 'snapshot' in reply ? reply.snapshot : undefined;
}

function readable(value: JsonValue | undefined) {
  return value === undefined
    ? '字段已移除'
    : typeof value === 'string'
      ? value || '空值'
      : JSON.stringify(value);
}

export default function CompatibilityLab({ runtime, active, onResetTrace }: LabComponentProps) {
  const [documentId, setDocumentId] = useState(() => `form-${crypto.randomUUID()}`);
  const [scenario, setScenario] = useState<CompatibilityScenario>('standard');
  const [limited, setLimited] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [incompatible, setIncompatible] = useState<CompatibilitySnapshot | null>(null);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [notice, setNotice] = useState('先创建表单，或输入另一页面的文档 ID 并读取。');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [saved, setSaved] = useState<SavedAction | null>(null);
  const [dropResponse, setDropResponse] = useState(false);
  const [unknownAction, setUnknownAction] = useState(false);
  const unknownActionRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const mounted = useRef<HTMLDivElement>(null);
  const errorSummary = useRef<HTMLDivElement>(null);
  const pendingErrorFocus = useRef(false);
  const idPrefix = useId();
  const capabilities: ClientCapabilities = limited
    ? {
        ...DEFAULT_CAPABILITIES,
        components: DEFAULT_CAPABILITIES.components.filter((name) => name !== 'ChoicePicker'),
      }
    : DEFAULT_CAPABILITIES;
  const displayed = draft?.snapshot ?? incompatible;
  const compatibility = displayed ? checkCompatibility(displayed, capabilities) : null;
  const ready = compatibility?.status === 'ready' && draft !== null;
  const inputMatches = !displayed || documentId === displayed.documentId;

  function focusField(componentId: string) {
    mounted.current
      ?.querySelector(
        `[data-a2ui-component-id="${componentId}"] input, [data-a2ui-component-id="${componentId}"] select`,
      )
      ?.scrollIntoView({ block: 'center' });
    mounted.current
      ?.querySelector<HTMLElement>(
        `[data-a2ui-component-id="${componentId}"] input, [data-a2ui-component-id="${componentId}"] select`,
      )
      ?.focus();
  }

  useEffect(() => {
    if (!active || !pendingErrorFocus.current || !issues.length) return;
    const frame = requestAnimationFrame(() => {
      errorSummary.current?.focus();
      pendingErrorFocus.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, issues]);

  function showIssues(next: FieldIssue[]) {
    pendingErrorFocus.current = next.length > 0;
    setIssues(next);
  }

  async function request(path: string, options: RequestInit = {}): Promise<CompatibilityReply> {
    const runId = `run-${crypto.randomUUID()}`;
    runtime.trace({
      protocol: 'a2ui',
      direction: 'client→server',
      runId,
      eventType: 'a2ui-compatibility/request',
      label: `${options.method ?? 'GET'} ${path}`,
      payload: typeof options.body === 'string' ? JSON.parse(options.body) : { documentId },
      note: 'expectedRevision 是应用层并发校验，action 内部仍是原始 A2UI 0.9.1 结构。',
    });
    const timeout = AbortSignal.timeout(8_000);
    const signal = AbortSignal.any([
      runtime.signal,
      timeout,
      ...(options.signal ? [options.signal] : []),
    ]);
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    signal.throwIfAborted();
    const response = await runtime.request(path, { ...options, signal, headers });
    const reply = await readCompatibilityReply(response);
    // A transport may finish consuming a body after timeout or unmount.
    signal.throwIfAborted();
    const snapshot = snapshotFrom(reply);
    runtime.trace({
      protocol: 'a2ui',
      direction: 'server→client',
      runId,
      eventType: `a2ui-compatibility/${reply.kind}`,
      label: `应用响应 · ${reply.kind} · HTTP ${response.status}`,
      payload: reply,
      note:
        runtime.mode === 'pages'
          ? '状态码来自浏览器内适配器；跨浏览器页面不共享内存。'
          : '服务端检查当前业务版本与 Surface，拒绝的动作不会执行。',
    });
    for (const message of snapshot?.messages ?? []) {
      const value = message !== null && typeof message === 'object' ? message : {};
      const eventType =
        ['createSurface', 'updateDataModel', 'updateComponents', 'deleteSurface'].find(
          (key) => key in value,
        ) ?? 'message';
      runtime.trace({
        protocol: 'a2ui',
        direction: 'server→client',
        runId,
        eventType,
        label: `A2UI ${eventType}`,
        payload: message,
        note: '此处是原始协议消息。documentId、revision 与字段规则保存在应用响应外层。',
      });
    }
    return reply;
  }

  function acceptSnapshot(snapshot: CompatibilitySnapshot, preserve: boolean) {
    const previous = draftRef.current;
    const previousDocument = previous?.snapshot.documentId ?? incompatible?.documentId;
    if (previousDocument !== snapshot.documentId) setDropResponse(false);
    const confirmed =
      unknownActionRef.current &&
      previousDocument === snapshot.documentId &&
      snapshot.revision >= (previous?.snapshot.revision ?? 0);
    if (previousDocument !== snapshot.documentId || confirmed) {
      unknownActionRef.current = false;
      setUnknownAction(false);
    }
    setSaved((previous) => (previous?.documentId === snapshot.documentId ? previous : null));
    // Preserve supported drafts even while the simulated client hides their controls.
    const result = checkCompatibility(snapshot, DEFAULT_CAPABILITIES);
    setIssues([]);
    if (result.status === 'fallback') {
      setIncompatible(snapshot);
      setDraft(null);
      draftRef.current = null;
      return;
    }
    const current = draftRef.current;
    const next =
      preserve && current?.snapshot.documentId === snapshot.documentId
        ? rebaseDraft(current, snapshot)
        : createDraft(snapshot);
    draftRef.current = next;
    setDraft(next);
    setIncompatible(null);
    setNotice(
      next.conflicts.length
        ? `发现 ${next.conflicts.length} 个字段冲突。草稿已保留，请逐项选择。`
        : `已读取版本 ${snapshot.revision}；未冲突的草稿保持不变。`,
    );
    return next;
  }

  async function perform(operation: () => Promise<void>, action = false) {
    if (inFlight.current || runtime.signal.aborted) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      if (!runtime.signal.aborted) {
        if (action) {
          unknownActionRef.current = true;
          setUnknownAction(true);
          setNotice('动作结果未知；草稿与已保存动作仍保留。请先读取远端，页面不会自动重发。');
        }
        setError(
          cause instanceof DOMException && cause.name === 'TimeoutError'
            ? '请求超时。请先读取远端确认版本与成功动作计数，再决定是否重试。'
            : errorMessage(cause),
        );
      }
    } finally {
      inFlight.current = false;
      if (!runtime.signal.aborted) setBusy(false);
    }
  }

  async function load(create: boolean) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(documentId)) {
      setError('文档 ID 需为 1–64 位字母、数字、下划线或连字符，且以字母或数字开头。');
      return;
    }
    if (create && draft) {
      setError('当前表单已打开。读取远端会保护草稿；创建新表单请先重置。');
      return;
    }
    await perform(async () => {
      const reply = await request(
        create ? basePath : `${basePath}/${encodeURIComponent(documentId)}`,
        create
          ? {
              method: 'POST',
              body: JSON.stringify({ documentId, scenario }),
            }
          : {},
      );
      if (reply.kind === 'invalid') {
        setError(reply.message);
        return;
      }
      if (reply.kind === 'not-found') {
        setError(reply.message);
        return;
      }
      const snapshot = snapshotFrom(reply);
      if (snapshot) {
        const wasUnknown = unknownActionRef.current;
        const next = acceptSnapshot(snapshot, true);
        if (wasUnknown && !unknownActionRef.current) {
          setNotice(
            `已读取远端版本 ${snapshot.revision}，成功动作共 ${snapshot.acceptedActions} 次。版本与计数不能单独证明是哪次动作成功；${next?.conflicts.length ? '后续草稿已保留，请先逐项选择冲突。' : '请核对远端值后决定下一步。'}页面没有重发动作。`,
          );
        }
      }
      if (reply.kind === 'conflict') setError(reply.message);
    });
  }

  async function change(change: RemoteChange) {
    const current = draftRef.current;
    if (!current || unknownActionRef.current) return;
    await perform(async () => {
      const reply = await request(
        `${basePath}/${encodeURIComponent(current.snapshot.documentId)}/remote`,
        {
          method: 'POST',
          body: JSON.stringify({ expectedRevision: current.snapshot.revision, change }),
        },
      );
      const snapshot = snapshotFrom(reply);
      if (snapshot) acceptSnapshot(snapshot, true);
      if (reply.kind === 'invalid' || reply.kind === 'not-found' || reply.kind === 'conflict')
        setError(reply.message);
    });
  }

  function actionEnvelope(): ActionEnvelope | undefined {
    const current = draftRef.current;
    if (!current) return;
    if (current.conflicts.length) {
      setError('先处理所有字段冲突，再提交当前草稿。');
      return;
    }
    const errors = validateFields(current.surface, current.snapshot.rules);
    if (errors.length) {
      showIssues(errors);
      setNotice('客户端字段校验未通过，未发送动作。');
      return;
    }
    return {
      expectedRevision: current.snapshot.revision,
      action: resolveA2uiAction(current.surface, 'submit'),
    };
  }

  async function submit(savedAction?: SavedAction) {
    const current = draftRef.current;
    if (!current) return;
    if (unknownActionRef.current) {
      setError('动作结果未知，请先读取远端确认版本与成功动作计数，再决定下一步。');
      return;
    }
    if (savedAction && savedAction.documentId !== current.snapshot.documentId) {
      setSaved(null);
      setError('保存的动作属于其他文档，请在当前文档重新保存。');
      return;
    }
    const input = savedAction?.envelope ?? actionEnvelope();
    if (!input) return;
    const submitted = current;
    await perform(async () => {
      const tracked = trackDraftSubmission(submitted, savedAction?.surface ?? submitted.surface);
      draftRef.current = tracked;
      setDraft(tracked);
      // Consume only when an action is actually initiated, including domain rejections.
      const drop = dropResponse;
      setDropResponse(false);
      const reply = await request(
        `${basePath}/${encodeURIComponent(submitted.snapshot.documentId)}/actions`,
        {
          method: 'POST',
          headers: drop ? { [COMPATIBILITY_DROP_RESPONSE_HEADER]: '1' } : undefined,
          body: JSON.stringify(input),
        },
      );
      // A domain reply confirms this submission's outcome; a transport failure leaves
      // the tracked edits in place until a later read can require conflict choices.
      draftRef.current = submitted;
      setDraft(submitted);
      if (reply.kind === 'invalid') {
        // Business errors may depend on several fields; show them inline only for the submitted form.
        const sameInputs =
          !savedAction ||
          JSON.stringify(resolveA2uiAction(current.surface, 'submit').action.context) ===
            JSON.stringify(input.action.action.context);
        const currentIssues = sameInputs ? reply.issues : [];
        showIssues(currentIssues);
        setError(reply.message);
        setNotice(
          savedAction
            ? '已保存动作被拒绝；字段错误仅在当前表单仍与该动作相同时标注。当前草稿已保留，可用表单按钮提交当前值。'
            : '服务端未执行动作；修改对应字段后重试。',
        );
        return;
      }
      if (reply.kind === 'not-found') {
        setError(reply.message);
        return;
      }
      if (reply.kind === 'accepted') {
        // Compare later edits with the submitted values, even if they equal the old baseline.
        if (savedAction) draftRef.current = { ...submitted, base: savedAction.surface };
        acceptSnapshot(reply.snapshot, savedAction !== undefined);
        setNotice(
          `服务端接受动作，当前版本 ${reply.snapshot.revision}；成功动作共 ${reply.snapshot.acceptedActions} 次。${savedAction ? '保存动作之后的输入仍保留在当前草稿。' : ''}`,
        );
        return;
      }
      acceptSnapshot(reply.snapshot, true);
      if (reply.kind === 'conflict') {
        setError(reply.message);
        setNotice('服务端拒绝过期动作，成功动作计数没有增加。请确认最新值后重新提交。');
      }
    }, true);
  }

  function edit(path: string, value: JsonValue) {
    const current = draftRef.current;
    if (!current) return;
    try {
      const next = updateDraft(current, path, value);
      draftRef.current = next;
      setDraft(next);
      setIssues((previous) => previous.filter((issue) => issue.path !== path));
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <section className={styles.root} aria-label="A2UI 兼容与编辑冲突操作区">
      <header className={styles.intro}>
        <h2>同一份声明，遇到不同客户端与不同版本</h2>
        <p>先生成表单，再改变能力、远端数据或业务版本。每次决定都可在检查器中追溯。</p>
        <p className={styles.mode}>
          {runtime.mode === 'pages'
            ? '静态演示：当前页面内存模拟服务端；两个浏览器页面不共享状态。'
            : '本地实验：两个页面使用相同文档 ID，可读取同一服务端表单；重启服务会重置。'}
        </p>
      </header>
      <fieldset className={styles.controls} disabled={busy}>
        <legend>1. 选择声明与客户端能力</legend>
        <label className={styles.field} htmlFor={`${idPrefix}-document`}>
          文档 ID
          <input
            id={`${idPrefix}-document`}
            type="text"
            value={documentId}
            maxLength={64}
            onChange={(event) => {
              setDocumentId(event.target.value);
              setCopied(false);
            }}
          />
        </label>
        <label className={styles.field} htmlFor={`${idPrefix}-scenario`}>
          声明场景
          <select
            id={`${idPrefix}-scenario`}
            value={scenario}
            disabled={!!displayed}
            onChange={(event) => setScenario(event.target.value as CompatibilityScenario)}
          >
            {Object.entries(scenarioLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={limited}
            disabled={busy}
            onChange={(event) => setLimited(event.target.checked)}
          />
          模拟不支持 ChoicePicker 的客户端
        </label>
        <div className={styles.actions}>
          <button
            className="button primary"
            type="button"
            disabled={!!draft}
            onClick={() => void load(true)}
          >
            创建表单
          </button>
          <button className="button secondary" type="button" onClick={() => void load(false)}>
            <RefreshCw size={15} aria-hidden="true" />
            读取远端
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(documentId);
                setCopied(true);
              } catch {
                document.getElementById(`${idPrefix}-document`)?.focus();
                setNotice('复制不可用，请在文档 ID 输入框中选择并复制。');
              }
            }}
          >
            <Copy size={15} aria-hidden="true" />
            {copied ? '已复制文档 ID' : '复制文档 ID'}
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setDraft(null);
              draftRef.current = null;
              setIncompatible(null);
              setSaved(null);
              setDropResponse(false);
              unknownActionRef.current = false;
              setUnknownAction(false);
              setIssues([]);
              setError('');
              setDocumentId(`form-${crypto.randomUUID()}`);
              setCopied(false);
              onResetTrace();
              setNotice('已重置当前界面。原服务端文档仍可通过 ID 读取。');
            }}
          >
            重置并使用新 ID
          </button>
        </div>
      </fieldset>
      {!inputMatches && (
        <p className={styles.hint}>
          当前显示文档 {displayed?.documentId}。点击“读取远端”切换到输入的
          ID；提交仍针对当前显示文档。
        </p>
      )}
      {displayed && (
        <dl className={styles.identity} aria-label="应用版本与动作计数">
          <div>
            <dt>文档</dt>
            <dd>{displayed.documentId}</dd>
          </div>
          <div>
            <dt>业务修订</dt>
            <dd data-testid="revision">{displayed.revision}</dd>
          </div>
          <div>
            <dt>Surface</dt>
            <dd>{displayed.surfaceId}</dd>
          </div>
          <div>
            <dt>成功动作</dt>
            <dd data-testid="accepted-actions">{displayed.acceptedActions}</dd>
          </div>
        </dl>
      )}
      {compatibility?.status === 'fallback' && (
        <div className={styles.fallback} role="status">
          <h3>当前客户端使用文字降级</h3>
          <p>{compatibility.text}</p>
          <ul>
            {compatibility.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p>catalog ID 只是能力标识。这里不会从该地址下载或执行组件代码。</p>
        </div>
      )}
      {ready && (
        <>
          <fieldset className={styles.controls} disabled={busy || unknownAction}>
            <legend>2. 修改服务端，观察草稿如何合并</legend>
            <p>
              这些按钮先改变服务端，再读取新快照。也可在另一个页面使用相同 ID
              操作，再回到这里“读取远端”。
            </p>
            <div className={styles.actions}>
              <button
                className="button secondary"
                type="button"
                onClick={() => void change('extend-days')}
              >
                远端延长一天
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => void change('add-budget')}
              >
                远端增加预算字段
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => void change('replace-surface')}
              >
                远端重建 Surface
              </button>
            </div>
          </fieldset>
          {draft.conflicts.length > 0 && (
            <section className={styles.conflicts} aria-label="草稿冲突">
              <h3>有更新与草稿冲突，当前输入已保留</h3>
              {draft.conflicts.map((conflict) => (
                <div className={styles.conflict} key={conflict.path}>
                  <strong>
                    {conflict.label} <code>{conflict.path}</code>
                  </strong>
                  <dl>
                    <div>
                      <dt>原值</dt>
                      <dd>{readable(conflict.base)}</dd>
                    </div>
                    <div>
                      <dt>我的草稿</dt>
                      <dd>{readable(conflict.local)}</dd>
                    </div>
                    <div>
                      <dt>远端新值</dt>
                      <dd>{readable(conflict.remote)}</dd>
                    </div>
                  </dl>
                  <div className={styles.actions}>
                    {(['local', 'remote'] as const).map((choice) => (
                      <button
                        className="button secondary"
                        type="button"
                        key={choice}
                        disabled={busy}
                        onClick={() => {
                          const next = resolveDraftConflict(
                            draftRef.current!,
                            conflict.path,
                            choice,
                          );
                          draftRef.current = next;
                          setDraft(next);
                          setError('');
                          setNotice(
                            next.conflicts.length
                              ? '还有字段需要选择。'
                              : '冲突已解决，可检查字段并提交。',
                          );
                        }}
                      >
                        {choice === 'local'
                          ? `保留我的${conflict.label}`
                          : `采用远端${conflict.label}`}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}
          {issues.length > 0 && (
            <div role="alert" tabIndex={-1} ref={errorSummary} className={styles.errors}>
              <h3>请检查以下字段</h3>
              <ul>
                {issues.map((issue) => (
                  <li key={`${issue.layer}-${issue.path}`}>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => focusField(issue.componentId)}
                    >
                      {issue.message}
                    </button>
                    <small>
                      {issue.layer === 'client' ? '客户端字段校验' : '服务端业务校验'} ·{' '}
                      {issue.componentId} · {issue.path} · save_trip
                    </small>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div ref={mounted} className={styles.surface} aria-label="生成的旅行表单">
            <SurfaceRenderer
              surface={draft.surface}
              disabled={busy}
              submitting={busy}
              onBindingChange={edit}
              onAction={() => void submit()}
              fieldIssues={issues}
              idPrefix={idPrefix}
            />
          </div>
          <section className={styles.controls} aria-label="过期动作实验">
            <h3>3. 保存动作，再改变版本</h3>
            <p>
              先填写有效输入并保存动作。修改远端版本或重建 Surface
              后，发送旧动作，观察服务端拒绝与成功动作计数。
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                className="button secondary"
                disabled={busy || unknownAction || !!draft.conflicts.length}
                onClick={() => {
                  const envelope = actionEnvelope();
                  if (!envelope) return;
                  const current = draftRef.current!;
                  setSaved({
                    documentId: current.snapshot.documentId,
                    envelope,
                    surface: structuredClone(current.surface),
                  });
                  setNotice(`已保存针对版本 ${envelope.expectedRevision} 的动作，尚未发送。`);
                }}
              >
                保存当前动作
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy || unknownAction || !saved}
                onClick={() => void submit(saved!)}
              >
                发送已保存动作
              </button>
            </div>
            {saved && (
              <p className={styles.hint}>
                保存的文档：{saved.documentId} · 业务修订：{saved.envelope.expectedRevision} ·
                Surface：
                {saved.envelope.action.action.surfaceId}
              </p>
            )}
          </section>
          <fieldset className={styles.controls} disabled={busy || unknownAction}>
            <legend>4. 提交后丢失响应</legend>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={dropResponse}
                aria-describedby={`${idPrefix}-drop-help`}
                onChange={(event) => setDropResponse(event.target.checked)}
              />
              下一次提交成功后丢失响应
            </label>
            <p id={`${idPrefix}-drop-help`} className={styles.hint}>
              勾选后，通过表单按钮或“发送已保存动作”发起下一次动作时消耗开关。只有服务端接受动作后才丢弃响应；校验或版本拒绝照常显示。读取、保存动作和客户端校验失败不会消耗开关。
            </p>
          </fieldset>
        </>
      )}
      {unknownAction && (
        <section className={styles.unknown} aria-label="动作结果待确认">
          <h3>动作结果未知，先读取远端</h3>
          <p>
            未收到可确认的动作回执；服务端可能已经执行。当前版本和计数仍是上次确认的快照，草稿与已保存动作仍保留。先读取远端核对业务修订、成功动作计数与字段值，再决定下一步。页面不会自动重发。
          </p>
          <div className={styles.actions}>
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void load(false)}
            >
              <RefreshCw size={15} aria-hidden="true" />
              读取远端确认结果
            </button>
          </div>
        </section>
      )}
      {error && (
        <p className={styles.error} role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          {error}
        </p>
      )}
      <p className={unknownAction ? styles.pendingNotice : styles.notice} role="status">
        {unknownAction ? (
          <AlertCircle size={16} aria-hidden="true" />
        ) : (
          <CheckCircle2 size={16} aria-hidden="true" />
        )}
        {busy ? '正在读取或校验…' : notice}
      </p>
      <details className={styles.evidence}>
        <summary>查看证据与应用边界</summary>
        <p>
          业务修订、字段规则和冲突策略属于本项目应用约定。原始 A2UI 消息只包含 0.9.1
          教学子集字段。这里只生成旅行建议，不预订或持久保存。
        </p>
        {displayed && (
          <button
            type="button"
            className="text-button"
            onClick={() => runtime.focusTrace({ eventType: 'updateComponents' })}
          >
            定位组件声明记录
          </button>
        )}
        {displayed && (
          <pre>
            <code>
              {JSON.stringify(
                {
                  documentId: displayed.documentId,
                  revision: displayed.revision,
                  rules: displayed.rules,
                  action: saved?.envelope ?? null,
                },
                null,
                2,
              )}
            </code>
          </pre>
        )}
      </details>
    </section>
  );
}
