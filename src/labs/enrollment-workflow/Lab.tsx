import { useEffect, useRef, useState } from 'react';
import { Database, History, ShieldCheck } from 'lucide-react';
import type { LabComponentProps } from '../../../shared/lab-contract';
import type { TaskLocator as PortableTaskLocator } from '../../../shared/labs/task-locator';
import { TaskLocator } from '../../components/TaskLocator';
import {
  applyA2uiMessages,
  resolveA2uiAction,
  updateA2uiBinding,
  type A2uiSurface,
} from '../../../shared/a2ui';
import {
  appendWorkflowEvents,
  type WorkflowFacts,
} from '../../../shared/labs/enrollment-workflow/contract';
import { workflowForm } from '../../../shared/labs/enrollment-workflow/surface';
import { enrollmentInputSchema } from '../../../shared/labs/human-approval/schema';
import { WORKSHOPS, type ApprovalTask } from '../../../shared/labs/human-approval/types';
import { acceptedMatchesCommand } from '../human-approval/client';
import { SurfaceRenderer, type A2uiFieldIssue } from '../../components/A2uiSurfaceRenderer';
import {
  loadWorkflowLocator,
  newWorkflowLocator,
  openWorkflowTask,
  readWorkflow,
  restoreWorkflowSurface,
  saveWorkflowLocator,
  sendWorkflow,
  workflowCommand,
  type WorkflowLocator,
  type WorkflowSaved,
} from './client';
import styles from './lab.module.css';

const statusLabel = {
  queued: '等待开始',
  running: '执行中',
  'waiting-input': '等待人工确认',
  succeeded: '报名已完成',
  failed: '执行失败',
  cancelled: '已拒绝',
};
function formFor(task: ApprovalTask | null, taskId: string) {
  return applyA2uiMessages(null, workflowForm(task, taskId))!;
}
function dirty(surface: A2uiSurface, task: ApprovalTask | null) {
  if (!task) return false;
  return (
    JSON.stringify(surface.model.form) !== JSON.stringify(formFor(task, task.taskId).model.form)
  );
}

export default function EnrollmentWorkflowLab({
  runtime,
  active,
  onResetTrace,
}: LabComponentProps) {
  const [boot] = useState(() => loadWorkflowLocator(runtime.mode));
  const [locator, setLocator] = useState(boot.locator);
  const locatorRef = useRef(locator);
  const [facts, setFacts] = useState<WorkflowFacts | null>(null);
  const factsRef = useRef(facts);
  const [surface, setSurface] = useState(() => formFor(null, locator.taskId));
  const surfaceRef = useRef(surface);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const openingRef = useRef<AbortController | null>(null);
  const [needsRead, setNeedsRead] = useState(boot.restored);
  const [pendingQueried, setPendingQueried] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(boot.storageAvailable);
  const [notice, setNotice] = useState(
    boot.restored ? '已找回任务身份，正在查询已提交事实。' : '先填写表单，生成需要人工确认的提议。',
  );
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<A2uiFieldIssue[]>([]);
  const errorRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState(false);
  const [stale, setStale] = useState<WorkflowSaved | null>(null);
  const [conflict, setConflict] = useState(false);
  const [missing, setMissing] = useState(false);
  const mounted = useRef(false);
  const booted = useRef(false);
  const task = facts?.task ?? null;
  const proposal = task?.state.proposal;
  const changed = dirty(surface, task);
  const locked = !active || busy || needsRead || Boolean(locator.pending) || conflict;
  const ended =
    task?.status === 'succeeded' || task?.status === 'cancelled' || proposal?.status === 'expired';
  locatorRef.current = locator;
  factsRef.current = facts;
  surfaceRef.current = surface;

  function alive() {
    return mounted.current && !runtime.signal.aborted;
  }
  function remember(next: WorkflowLocator) {
    locatorRef.current = next;
    setLocator(next);
    setStorageAvailable(saveWorkflowLocator(runtime.mode, next));
  }
  function apply(value: WorkflowFacts, replace: boolean) {
    const previous = factsRef.current;
    if (previous?.task.taskId === value.task.taskId && previous.task.version > value.task.version)
      return;
    const preserve = dirty(surfaceRef.current, previous?.task ?? null);
    const revisionChanged = previous && previous.task.version !== value.task.version;
    const events = appendWorkflowEvents(
      [],
      value.events,
      value.task.taskId,
      value.checkpoint.cursor.runId,
    );
    if (events.length !== value.checkpoint.cursor.afterSeq)
      throw new Error('事件记录与 checkpoint 不一致。');
    const next = restoreWorkflowSurface(value);
    setFacts(value);
    factsRef.current = value;
    if (replace || !previous || !preserve) {
      setSurface(next);
      surfaceRef.current = next;
      setConflict(false);
    } else if (revisionChanged) setConflict(true);
    traceFacts(value, previous?.task.taskId === value.task.taskId ? previous.events.length : 0);
  }
  function traceFacts(value: WorkflowFacts, previousEventCount = 0) {
    for (const event of value.events.slice(previousEventCount)) {
      runtime.trace({
        taskId: event.taskId,
        threadId: value.task.threadId,
        runId: event.runId,
        seq: event.seq,
        protocol: 'agui',
        eventType: event.payload.type,
        direction: runtime.mode === 'pages' ? 'browser-agent→client' : 'server→client',
        transport: runtime.mode === 'pages' ? 'browser-memory' : 'HTTP',
        label: `持久事件 ${event.seq} · ${event.payload.type}`,
        payload: event.payload,
        note: '通过事实查询重放已提交记录；此处使用 HTTP JSON 批量读取，不是 SSE。',
      });
    }
    runtime.trace({
      taskId: value.task.taskId,
      threadId: value.task.threadId,
      runId: value.checkpoint.cursor.runId,
      eventType: 'enrollment-workflow/checkpoint',
      direction: 'local',
      label: '任务 checkpoint 与事实',
      payload: {
        checkpoint: value.checkpoint,
        recordCount: value.recordCount,
        enrollment: value.enrollment,
      },
    });
  }
  async function refresh(replace = false) {
    const current = locatorRef.current;
    const reply = await readWorkflow(runtime, current);
    if (!alive() || locatorRef.current.taskId !== current.taskId) return;
    if (reply.kind === 'unknown') {
      setError(reply.reason);
      setNeedsRead(true);
      return;
    }
    if (current.pending) setPendingQueried(true);
    if (reply.value.status !== 'found') {
      setError(`${reply.value.code}：${reply.value.reason}`);
      setMissing(reply.value.code === 'NOT_FOUND');
      setNeedsRead(true);
      return;
    }
    try {
      apply(reply.value, replace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '恢复记录不完整。');
      setNeedsRead(true);
      return;
    }
    setMissing(false);
    setNeedsRead(false);
    if (current.pending && reply.value.receipt) {
      const receipt = reply.value.receipt;
      if (
        receipt.status === 'accepted' &&
        !acceptedMatchesCommand(receipt, {
          teachingSessionId: current.session,
          command: current.pending.command,
          purpose: 'operation',
        })
      ) {
        setError('命令回执与原请求不匹配，继续保留原命令。');
        return;
      }
      remember({ ...current, pending: null, last: current.pending });
    }
    setNotice(
      `已从${reply.value.durability === 'sqlite' ? ' SQLite' : '当前页面内存'}恢复同一任务与运行；报名记录数 ${reply.value.recordCount}。`,
    );
  }
  async function query() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await refresh();
    } finally {
      busyRef.current = false;
      if (alive()) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (!booted.current) {
      booted.current = true;
      if (boot.restored) void query();
      else setStorageAvailable(saveWorkflowLocator(runtime.mode, locatorRef.current));
    }
    return () => {
      mounted.current = false;
      openingRef.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (error && active) errorRef.current?.focus({ preventScroll: true });
  }, [error, active]);

  async function dispatch(
    saved: WorkflowSaved,
    options: { retry?: boolean; experiment?: boolean; replace?: boolean } = {},
  ) {
    if (busyRef.current || (!options.retry && (locatorRef.current.pending || needsRead))) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setIssues([]);
    setPendingQueried(false);
    remember({ ...locatorRef.current, pending: saved, last: saved });
    if (saved.action)
      runtime.trace({
        protocol: 'a2ui',
        taskId: saved.command.taskId,
        eventType: 'enrollment-workflow/action',
        direction: 'local',
        label: '解析后的 A2UI 表单动作',
        payload: saved.action,
      });
    try {
      const reply = await sendWorkflow(
        runtime,
        saved,
        !options.retry && !options.experiment && drop,
      );
      if (!alive()) return;
      if (reply.kind === 'unknown') {
        setNotice('结果未知，原命令已保留。');
        setError(`${reply.reason} 这不能证明报名失败。`);
        return;
      }
      remember({ ...locatorRef.current, pending: null, last: saved });
      if (reply.value.status !== 'accepted') setError(`${reply.value.code}：${reply.value.reason}`);
      await refresh(reply.value.status === 'accepted' && Boolean(options.replace));
      if (!alive()) return;
      if (reply.value.status !== 'accepted')
        setNotice('命令被明确拒绝；已重新查询任务，保存的内容和报名记录保持不变。');
      else if (reply.value.replayed)
        setNotice('原命令已重放；返回同一回执，事件与报名记录没有重复写入。');
      else if (saved.command.payload.type === 'edit')
        setNotice('修改已保存，提议版本已更新。旧确认不能授权新内容，请重新核对。');
    } finally {
      busyRef.current = false;
      if (alive()) setBusy(false);
    }
  }
  function submit(source: string) {
    if (locked || ended) return;
    const action = resolveA2uiAction(surface, source);
    const context = action.action.context;
    const parsed = enrollmentInputSchema.safeParse({
      attendeeName: context.attendeeName,
      workshopId: Array.isArray(context.workshopId) ? context.workshopId[0] : null,
      seats:
        typeof context.seats === 'string' && context.seats.trim() ? Number(context.seats) : NaN,
    });
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.flatMap((issue) => {
          const field = String(issue.path[0]);
          return ['attendeeName', 'workshopId', 'seats'].includes(field)
            ? [
                {
                  componentId: field,
                  path: `/form/${field}`,
                  message: issue.message,
                  layer: 'client' as const,
                },
              ]
            : [];
        }),
      );
      setError('请修正表单中的报名信息。');
      return;
    }
    const saved = workflowCommand(
      locatorRef.current,
      task?.version ?? 0,
      task
        ? {
            type: 'edit',
            proposalId: proposal!.proposalId,
            proposalVersion: proposal!.proposalVersion,
            input: parsed.data,
          }
        : { type: 'propose', input: parsed.data, validity: 'standard' },
    );
    saved.action = action;
    void dispatch(saved, { replace: true });
  }
  function decision(type: 'approve' | 'reject') {
    if (!task || !proposal || locked || changed || ended) return;
    void dispatch(
      workflowCommand(locatorRef.current, task.version, {
        type,
        proposalId: proposal.proposalId,
        proposalVersion: proposal.proposalVersion,
      }),
    );
  }
  async function openExisting(target: PortableTaskLocator) {
    if (!active || busyRef.current || locatorRef.current.pending)
      throw new Error('请先完成当前操作并核实待定命令，再打开已有任务。');
    const previous = locatorRef.current;
    const controller = new AbortController();
    openingRef.current = controller;
    busyRef.current = true;
    setBusy(true);
    try {
      const reply = await openWorkflowTask(runtime, target, controller.signal);
      if (!alive() || controller.signal.aborted || locatorRef.current !== previous) return;
      if (reply.kind === 'unknown')
        throw new Error(`打开任务的事实查询结果未知。${reply.reason} 当前任务与草稿保持不变。`);
      if (reply.value.status !== 'found')
        throw new Error(
          `${reply.value.code}：${reply.value.reason} 当前任务与草稿保持不变。${
            runtime.mode === 'pages' && reply.value.code === 'NOT_FOUND'
              ? 'Pages 只保留当前页面内存；独立标签页或刷新后无法恢复，也不会自动生成提议。'
              : ''
          }`,
        );
      const value = reply.value;
      const events = appendWorkflowEvents(
        [],
        value.events,
        value.task.taskId,
        value.checkpoint.cursor.runId,
      );
      if (events.length !== value.checkpoint.cursor.afterSeq)
        throw new Error('事件记录与 checkpoint 不一致，当前任务与草稿保持不变。');
      const nextSurface = restoreWorkflowSurface(value);
      if (
        factsRef.current?.task.taskId === value.task.taskId &&
        factsRef.current.task.version > value.task.version
      )
        throw new Error('查询返回了比当前已核实版本更旧的任务，当前任务与草稿保持不变。');
      // Publish identity, surface and facts only after every query contract has passed.
      remember({
        session: target.teachingSessionId,
        taskId: target.taskId,
        pending: null,
        last: null,
      });
      setFacts(value);
      factsRef.current = value;
      setSurface(nextSurface);
      surfaceRef.current = nextSurface;
      setNeedsRead(false);
      setPendingQueried(false);
      setMissing(false);
      setConflict(false);
      setStale(null);
      setError('');
      setIssues([]);
      setDrop(false);
      setNotice(`已打开已有任务。报名记录数：${value.recordCount}；本次只查询事实。`);
      onResetTrace();
      traceFacts(value);
    } finally {
      if (openingRef.current === controller) {
        openingRef.current = null;
        busyRef.current = false;
        if (alive()) setBusy(false);
      }
    }
  }
  function reset() {
    if (busyRef.current || locator.pending) return;
    const next = newWorkflowLocator();
    remember(next);
    setFacts(null);
    factsRef.current = null;
    const empty = formFor(null, next.taskId);
    setSurface(empty);
    surfaceRef.current = empty;
    setNeedsRead(false);
    setMissing(false);
    setConflict(false);
    setStale(null);
    setError('');
    setIssues([]);
    setDrop(false);
    setNotice('已切换到新的任务身份，旧任务与事实没有被删除。');
    onResetTrace();
  }

  return (
    <section className={styles.root} aria-label="活动报名联合实验操作区" aria-busy={busy}>
      <header className={styles.intro}>
        <p className={styles.eyebrow}>
          <ShieldCheck size={16} aria-hidden="true" /> 恢复 × 表单 × 人工确认
        </p>
        <h2>一次报名，从可编辑草稿到可恢复事实</h2>
        <p>先保存提议，再确认具体版本。刷新或丢失响应后，沿同一任务与运行查询已提交事实。</p>
      </header>
      <aside className={styles.boundary} aria-label="联合实验运行边界">
        <Database size={18} aria-hidden="true" />
        <div>
          <strong>
            {runtime.mode === 'pages' ? '静态学习版 · 当前页面内存' : '本地 HTTP · SQLite 联合事务'}
          </strong>
          <p>
            {runtime.mode === 'pages'
              ? '刷新会清空任务和业务事实。保留的身份与待定命令不会自动写入新模拟，请显式开始新任务。'
              : '任务、命令回执、AG-UI 事件和报名记录一同提交。刷新或重启服务后可查询；事件通过 HTTP JSON 批量重放。'}
          </p>
          <p>
            使用确定性样本与 A2UI 表单，不会向真实活动报名；人工确认使用应用命令，未将 A2UI 嵌入
            AG-UI。
          </p>
        </div>
      </aside>
      {!storageAvailable && (
        <p role="status">
          浏览器无法保存恢复身份。当前操作仍可用；刷新前请自行记录下方会话与任务 ID。
        </p>
      )}
      <div className={styles.notice} role="status">
        {busy ? '正在核对完整结果…' : notice}
      </div>
      {error && (
        <div className={styles.error} role="alert" tabIndex={-1} ref={errorRef}>
          <strong>{error}</strong>
          {issues.map((issue) => (
            <button
              className="text-button"
              key={issue.componentId}
              type="button"
              onClick={() => {
                const field = document.querySelector<HTMLElement>(
                  `[data-a2ui-component-id="${issue.componentId}"] input, [data-a2ui-component-id="${issue.componentId}"] select`,
                );
                field?.focus();
              }}
            >
              {issue.message}
            </button>
          ))}
        </div>
      )}
      <div className={styles.actions}>
        <button
          className="button secondary"
          type="button"
          disabled={!active || busy}
          onClick={() => void query()}
        >
          <History size={16} aria-hidden="true" />
          查询事实并恢复
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!active || busy || Boolean(locator.pending)}
          onClick={reset}
        >
          开始新任务
        </button>
      </div>
      {locator.pending && (
        <aside className={styles.recovery} aria-label="待定命令恢复">
          <strong>待定命令：先查询，再重试</strong>
          <p>
            命令 ID：<code>{locator.pending.command.commandId}</code>
            。重新提交会保留原会话、版本、参数和命令 ID。
          </p>
          <button
            className="button secondary"
            type="button"
            disabled={!active || busy || !pendingQueried || (runtime.mode === 'pages' && missing)}
            onClick={() => void dispatch(locator.pending!, { retry: true })}
          >
            重试原命令
          </button>
          {missing && runtime.mode === 'pages' && (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                remember({ ...locatorRef.current, pending: null });
                setNotice('已结束这次恢复。原命令保留为记录；请显式开始新任务。');
              }}
            >
              结束已清空模拟的恢复
            </button>
          )}
        </aside>
      )}
      <div className={styles.columns}>
        <section className={styles.panel} aria-label="报名草稿">
          <h3>1. 填写并保存提议</h3>
          <SurfaceRenderer
            surface={surface}
            disabled={locked || Boolean(ended)}
            submitting={busy}
            fieldIssues={issues}
            onBindingChange={(path, value) => {
              const next = updateA2uiBinding(surfaceRef.current, path, value);
              setSurface(next);
              surfaceRef.current = next;
              setIssues([]);
            }}
            onAction={submit}
          />
          {changed && <p className={styles.note}>当前有未保存修改，保存后才能确认。</p>}
          {conflict && (
            <div className={styles.recovery}>
              <strong>已保存版本改变，本地草稿仍保留。</strong>
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setSurface(formFor(task, locator.taskId));
                  setConflict(false);
                }}
              >
                采用已保存内容
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setSurface(updateA2uiBinding(surfaceRef.current, '/version', task!.version));
                  setConflict(false);
                }}
              >
                保留草稿并重新保存
              </button>
            </div>
          )}
        </section>
        <section className={styles.panel} aria-label="已保存提议与报名事实">
          <h3>2. 核对已保存版本</h3>
          {proposal ? (
            <>
              <p className={styles.state}>
                {statusLabel[task!.status]}
                {proposal.status === 'expired' ? ' · 提议已过期' : ''}
              </p>
              <dl className={styles.summary}>
                <dt>报名姓名</dt>
                <dd>{proposal.content.attendeeName}</dd>
                <dt>工作坊</dt>
                <dd>
                  {WORKSHOPS.find((workshop) => workshop.id === proposal.content.workshopId)?.title}
                </dd>
                <dt>报名人数</dt>
                <dd>{proposal.content.seats}</dd>
                <dt>提议版本</dt>
                <dd>{proposal.proposalVersion}</dd>
                <dt>报名记录数</dt>
                <dd data-testid="workflow-record-count">{facts!.recordCount}</dd>
                <dt>报名 ID</dt>
                <dd>{facts!.enrollment?.enrollmentId ?? '尚未写入'}</dd>
              </dl>
              <p className={styles.note}>
                确认仅授权以上已保存内容。有效期至{' '}
                {new Date(proposal.expiresAt).toLocaleTimeString('zh-CN')}。
              </p>
              <div className={styles.actions}>
                <button
                  className="button primary"
                  type="button"
                  disabled={locked || changed || Boolean(ended)}
                  onClick={() => decision('approve')}
                >
                  确认此版本并报名
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={locked || changed || Boolean(ended)}
                  onClick={() => decision('reject')}
                >
                  拒绝此提议
                </button>
              </div>
            </>
          ) : (
            <p className={styles.note}>先从左侧表单生成提议。表单草稿不会写入报名记录。</p>
          )}
        </section>
      </div>
      <TaskLocator
        labId="enrollment-workflow"
        mode={runtime.mode}
        current={
          facts || locator.pending || locator.last || needsRead
            ? {
                version: 1,
                labId: 'enrollment-workflow',
                mode: runtime.mode,
                teachingSessionId: locator.session,
                taskId: locator.taskId,
              }
            : null
        }
        disabled={!active || busy || Boolean(locator.pending)}
        hasUnsavedDraft={
          JSON.stringify(surface.model.form) !==
          JSON.stringify(formFor(task, locator.taskId).model.form)
        }
        onOpen={openExisting}
      />
      <details className={styles.panel}>
        <summary>3. 验证旧确认与丢失响应</summary>
        <div className={styles.experiments}>
          <label>
            <input
              type="checkbox"
              checked={drop}
              disabled={busy}
              onChange={(event) => setDrop(event.target.checked)}
            />
            模拟命令提交后丢失响应
          </label>
          <p className={styles.note}>
            在确认前打开此开关，观察结果未知，再查询事实。新任务可用于另一轮实验。
          </p>
          <div className={styles.actions}>
            <button
              className="button secondary"
              type="button"
              disabled={locked || !task || changed || Boolean(ended)}
              onClick={() =>
                setStale(
                  workflowCommand(locatorRef.current, task!.version, {
                    type: 'approve',
                    proposalId: proposal!.proposalId,
                    proposalVersion: proposal!.proposalVersion,
                  }),
                )
              }
            >
              保存当前确认命令
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={locked || !stale}
              onClick={() => void dispatch(stale!, { experiment: true })}
            >
              发送保存的旧确认
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={locked || !locator.last}
              onClick={() => void dispatch(locator.last!, { retry: true })}
            >
              重放最后命令
            </button>
          </div>
          <p className={styles.note}>
            先保存确认命令，再修改并保存表单。发送旧确认应被版本校验拒绝；重放成功命令不会再次写入。
          </p>
        </div>
      </details>
      <section className={styles.panel} aria-label="任务与事件证据">
        <h3>4. 对照任务、checkpoint 与原始记录</h3>
        <dl className={styles.summary}>
          <dt>会话 ID</dt>
          <dd>
            <code>{locator.session}</code>
          </dd>
          <dt>任务 ID</dt>
          <dd>
            <code>{locator.taskId}</code>
          </dd>
          <dt>运行 ID</dt>
          <dd>
            <code>{task?.currentRunId ?? '生成提议时创建'}</code>
          </dd>
          <dt>事件游标</dt>
          <dd>{facts?.checkpoint.cursor.afterSeq ?? 0}</dd>
          <dt>存储</dt>
          <dd>{facts?.durability ?? '尚未查询'}</dd>
        </dl>
        {facts && (
          <ol className={styles.events} aria-label="已提交事件">
            {facts.events.map((event) => (
              <li key={event.seq}>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    runtime.focusTrace({ taskId: event.taskId, runId: event.runId, seq: event.seq })
                  }
                >
                  {event.seq}. {event.payload.type}
                </button>
              </li>
            ))}
          </ol>
        )}
        <p className={styles.note}>
          等待人工输入期间没有 RUN_FINISHED；确认或拒绝后才结束同一
          run。事件序号用于去重与连续性检查，业务幂等由命令收据与唯一约束保证。
        </p>
      </section>
    </section>
  );
}
