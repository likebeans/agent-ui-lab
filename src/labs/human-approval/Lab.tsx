import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleHelp, Database, FilePenLine, ShieldCheck } from 'lucide-react';
import type { LabComponentProps } from '../../../shared/lab-contract';
import type { TaskLocator as PortableTaskLocator } from '../../../shared/labs/task-locator';
import { TaskLocator } from '../../components/TaskLocator';
import {
  WORKSHOPS,
  type ApprovalCommand,
  type ApprovalFacts,
  type ApprovalResult,
  type ApprovalTask,
  type Enrollment,
  type EnrollmentInput,
  type FieldErrors,
} from '../../../shared/labs/human-approval/types';
import {
  acceptedMatchesCommand,
  loadLocator,
  openApprovalTask,
  queryFacts,
  saveLocator,
  sendCommand,
  type RecoveryLocator,
  type SavedCommand,
} from './client';
import styles from './lab.module.css';

type Draft = { attendeeName: string; workshopId: EnrollmentInput['workshopId']; seats: string };
type FormError = { message: string; fields: FieldErrors };
const emptyDraft = (): Draft => ({
  attendeeName: '示例学员',
  workshopId: WORKSHOPS[0].id,
  seats: '1',
});
const toDraft = (input: EnrollmentInput): Draft => ({ ...input, seats: String(input.seats) });
const isDirty = (draft: Draft, input: EnrollmentInput) =>
  draft.attendeeName !== input.attendeeName ||
  draft.workshopId !== input.workshopId ||
  draft.seats !== String(input.seats);
const fieldIds = {
  attendeeName: 'approval-attendee-name',
  workshopId: 'approval-workshop',
  seats: 'approval-seats',
};
const actionNames = {
  propose: '生成提议',
  edit: '保存修改',
  approve: '确认报名',
  reject: '拒绝提议',
};
const proposalStatuses = {
  pending: '等待人工确认',
  approved: '已确认',
  rejected: '已拒绝',
  expired: '已过期',
};
const date = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false });

export default function HumanApprovalLab({ runtime, active, onResetTrace }: LabComponentProps) {
  const [boot] = useState(() => {
    const loaded = loadLocator(runtime.mode);
    const locator: RecoveryLocator = loaded.locator ?? {
      version: 1,
      teachingSessionId: crypto.randomUUID(),
      taskId: null,
      pending: null,
      archivedPending: null,
    };
    return {
      ...loaded,
      locator,
      restored: loaded.locator !== null && loaded.locator.taskId !== null,
    };
  });
  const locatorRef = useRef(boot.locator);
  const [locator, setLocator] = useState(boot.locator);
  const [storageAvailable, setStorageAvailable] = useState(boot.storageAvailable);
  const [task, setTask] = useState<ApprovalTask | null>(null);
  const taskRef = useRef(task);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const draftRef = useRef(draft);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [facts, setFacts] = useState<ApprovalFacts | null>(null);
  const [lastCommand, setLastCommand] = useState<SavedCommand | null>(null);
  const [staleDecision, setStaleDecision] = useState<SavedCommand | null>(null);
  const [experimentCommand, setExperimentCommand] = useState<SavedCommand | null>(null);
  const [experimentResult, setExperimentResult] = useState('');
  const [notice, setNotice] = useState('先生成一份报名提议，再核对内容并作出决定。');
  const [recoveryReason, setRecoveryReason] = useState(
    boot.locator.pending ? '页面恢复了待定命令；尚未查询到该命令的完整结果。' : '',
  );
  const [queriedPending, setQueriedPending] = useState(false);
  const [restoreRequired, setRestoreRequired] = useState(boot.restored);
  const [pagesResetRequired, setPagesResetRequired] = useState(false);
  const [busy, setBusy] = useState<'sending' | 'querying' | null>(null);
  const busyRef = useRef(false);
  const openingRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<FormError | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  const mounted = useRef(false);
  const [validity, setValidity] = useState<'standard' | 'short'>('standard');
  const [dropResponse, setDropResponse] = useState(false);
  const [now, setNow] = useState(Date.now);
  taskRef.current = task;
  draftRef.current = draft;
  activeRef.current = active;

  useEffect(() => {
    mounted.current = true;
    setStorageAvailable(saveLocator(runtime.mode, locatorRef.current));
    return () => {
      mounted.current = false;
      openingRef.current?.abort();
    };
  }, [runtime.mode]);

  useEffect(() => {
    if (error && activeRef.current) errorRef.current?.focus();
  }, [error]);

  const proposal = task?.state.proposal;
  useEffect(() => {
    if (!proposal || proposal.status !== 'pending') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [proposal?.proposalId, proposal?.status]);

  function alive() {
    return mounted.current && !runtime.signal.aborted;
  }

  function remember(next: RecoveryLocator) {
    locatorRef.current = next;
    setLocator(next);
    setStorageAvailable(saveLocator(runtime.mode, next));
  }

  function fail(message: string, fields: FieldErrors = {}) {
    setError({ message, fields });
  }

  function readInput(): EnrollmentInput | null {
    const fields: FieldErrors = {};
    if (!draft.attendeeName.trim()) fields.attendeeName = '请填写报名姓名。';
    else if (draft.attendeeName.length > 80) fields.attendeeName = '姓名不能超过 80 个字符。';
    if (!WORKSHOPS.some((workshop) => workshop.id === draft.workshopId))
      fields.workshopId = '请选择有效的工作坊。';
    const seats = Number(draft.seats);
    if (!draft.seats.trim() || !Number.isInteger(seats) || seats < 1 || seats > 6)
      fields.seats = '报名人数必须是 1 到 6 之间的整数。';
    if (Object.keys(fields).length) {
      fail('请修正以下报名信息，再提交。', fields);
      return null;
    }
    return { attendeeName: draft.attendeeName, workshopId: draft.workshopId, seats };
  }

  function applySnapshot(next: ApprovalTask, record: Enrollment | null, replaceDraft: boolean) {
    const previous = taskRef.current;
    if (previous?.taskId === next.taskId && previous.version > next.version) return;
    const preserveDraft = previous && isDirty(draftRef.current, previous.state.proposal.content);
    taskRef.current = next;
    setTask(next);
    setEnrollment(record);
    if (replaceDraft || !previous || !preserveDraft) {
      const nextDraft = toDraft(next.state.proposal.content);
      draftRef.current = nextDraft;
      setDraft(nextDraft);
    }
    setNow(Date.now());
  }

  function explainResult(result: ApprovalResult, saved: SavedCommand) {
    if (saved.purpose === 'experiment') {
      setExperimentResult(
        result.status === 'accepted'
          ? '边界实验返回 accepted，请查询事实核对实际状态。'
          : `${result.code}：${result.reason} 当前提议和已知报名记录仍保留。`,
      );
      return;
    }
    if (result.status !== 'accepted') {
      setNotice('命令已收到明确拒绝或冲突，请核对原因；可查询最新事实或重新生成提议。');
      fail(
        `${result.code}：${result.reason}`,
        result.status === 'rejected' ? result.fieldErrors : {},
      );
      return;
    }
    const current = taskRef.current;
    if (current?.taskId === result.result.task.taskId && current.version > result.version) {
      setNotice(
        `原命令已重放，返回历史版本 ${result.version} 的回执。当前仍显示已核实的任务版本 ${current.version}，业务事实未改变。`,
      );
      return;
    }
    applySnapshot(result.result.task, result.result.enrollment, saved.purpose === 'operation');
    if (saved.purpose === 'operation') setFacts(null);
    const replay = result.replayed ? '原命令已重放，返回已保存的结果。' : '';
    const messages = {
      propose: '报名提议已生成，请核对已保存内容。尚未写入报名记录。',
      edit: '修改已保存，提议内容版本已更新。请重新核对再确认。',
      approve: '报名已确认，已收到包含报名记录的领域结果。可查询事实核对记录数量与身份。',
      reject: '提议已拒绝，没有写入报名记录。',
    };
    setNotice(replay + messages[saved.command.payload.type]);
  }

  async function dispatch(saved: SavedCommand, options: { retry?: boolean; drop?: boolean } = {}) {
    if (busyRef.current || (!options.retry && locatorRef.current.pending)) return;
    if (pagesResetRequired || (restoreRequired && !options.retry)) return;
    busyRef.current = true;
    setBusy('sending');
    setError(null);
    setQueriedPending(false);
    if (saved.purpose === 'experiment') {
      setExperimentCommand(saved);
      setExperimentResult('');
    } else setLastCommand(saved);
    // Store the exact command and session before the request can leave this page.
    remember({ ...locatorRef.current, taskId: saved.command.taskId, pending: saved });
    try {
      const reply = await sendCommand(runtime, saved, options.drop);
      if (!alive()) return;
      if (reply.kind === 'unknown') {
        setRecoveryReason(reply.reason);
        return;
      }
      remember({ ...locatorRef.current, pending: null });
      setRestoreRequired(false);
      setRecoveryReason('');
      explainResult(reply.value, saved);
    } finally {
      busyRef.current = false;
      if (alive()) setBusy(null);
    }
  }

  function command(payload: ApprovalCommand['payload']): SavedCommand {
    return {
      teachingSessionId: locatorRef.current.teachingSessionId,
      purpose: 'operation',
      command: {
        taskId: task!.taskId,
        commandId: crypto.randomUUID(),
        expectedVersion: task!.version,
        payload,
      },
    };
  }

  function propose() {
    if (busyRef.current || locatorRef.current.pending || restoreRequired || pagesResetRequired)
      return;
    const input = readInput();
    if (!input) return;
    setStaleDecision(null);
    setExperimentCommand(null);
    setExperimentResult('');
    void dispatch({
      teachingSessionId: locatorRef.current.teachingSessionId,
      purpose: 'operation',
      command: {
        taskId: crypto.randomUUID(),
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        payload: { type: 'propose', input, validity },
      },
    });
  }

  function save() {
    if (busyRef.current || locatorRef.current.pending || !proposal || proposal.status !== 'pending')
      return;
    const input = readInput();
    if (!input) return;
    if (!isDirty(draft, proposal.content)) return;
    setStaleDecision({
      ...command({
        type: 'approve',
        proposalId: proposal.proposalId,
        proposalVersion: proposal.proposalVersion,
      }),
      purpose: 'experiment',
    });
    void dispatch(
      command({
        type: 'edit',
        proposalId: proposal.proposalId,
        proposalVersion: proposal.proposalVersion,
        input,
      }),
    );
  }

  function decide(type: 'approve' | 'reject') {
    if (busyRef.current || locatorRef.current.pending || !proposal || proposal.status !== 'pending')
      return;
    if (type === 'approve' && isDirty(draft, proposal.content)) {
      fail('表单有未保存修改。请先保存并核对最新提议，再确认报名。');
      return;
    }
    if (type === 'approve' && Date.now() >= proposal.expiresAt) {
      fail('提议已过期，请重新生成报名提议。');
      return;
    }
    void dispatch(
      command({ type, proposalId: proposal.proposalId, proposalVersion: proposal.proposalVersion }),
      {
        drop: type === 'approve' && dropResponse,
      },
    );
  }

  async function inspectFacts() {
    const current = locatorRef.current;
    if (busyRef.current || !current.taskId) return;
    busyRef.current = true;
    setBusy('querying');
    setError(null);
    const pending = current.pending;
    const commandId =
      pending?.command.commandId ??
      (lastCommand?.command.taskId === current.taskId ? lastCommand.command.commandId : undefined);
    try {
      const reply = await queryFacts(runtime, current.teachingSessionId, current.taskId, commandId);
      if (!alive()) return;
      if (pending) setQueriedPending(true);
      if (reply.kind === 'unknown') {
        if (pending) setRecoveryReason(`事实查询也未得到完整结果。${reply.reason}`);
        else fail(`事实查询结果未知。${reply.reason}`);
        return;
      }
      const result = reply.value;
      if (result.status === 'rejected') {
        if (runtime.mode === 'pages' && result.code === 'NOT_FOUND') {
          setPagesResetRequired(true);
          setRestoreRequired(false);
        }
        if (pending)
          setRecoveryReason(`事实查询返回 ${result.code}：${result.reason} 原命令仍待核实。`);
        else {
          setRestoreRequired(false);
          fail(`事实查询返回 ${result.code}：${result.reason} 可重新生成提议。`);
        }
        return;
      }
      setFacts(result);
      applySnapshot(result.task, result.enrollment, false);
      setRestoreRequired(false);
      setPagesResetRequired(false);
      if (!pending) {
        setNotice(
          `事实已查询，报名记录数：${result.recordCount}。查询时间：${date(result.asOf)}。`,
        );
        return;
      }
      const receipt = result.receipt;
      const recorded = result.enrollment;
      const action = pending.command.payload;
      const matchingRecord =
        action.type === 'approve' &&
        recorded &&
        recorded.commandId === pending.command.commandId &&
        recorded.taskId === pending.command.taskId &&
        recorded.teachingSessionId === pending.teachingSessionId &&
        recorded.proposalId === action.proposalId &&
        recorded.proposalVersion === action.proposalVersion;
      if (receipt?.status === 'accepted' && !acceptedMatchesCommand(receipt, pending)) {
        setRecoveryReason('查到的回执与原命令的内容或身份不匹配，结果仍未知。');
        return;
      }
      if (receipt || matchingRecord) {
        remember({ ...locatorRef.current, pending: null });
        setRecoveryReason('');
        if (pending.purpose === 'experiment') {
          setExperimentResult(
            receipt && receipt.status !== 'accepted'
              ? `${receipt.code}：${receipt.reason} 已通过查询取得回执，当前业务事实仍保留。`
              : '已查询到边界命令的明确结果，请对照报名事实。',
          );
        } else {
          setLastCommand(pending);
          if (receipt && receipt.status !== 'accepted') {
            setNotice('已通过查询取得原命令的明确拒绝或冲突，请核对原因后继续。');
            fail(
              `${receipt.code}：${receipt.reason}`,
              receipt.status === 'rejected' ? receipt.fieldErrors : {},
            );
          } else setNotice(`已通过事实查询核实原命令。报名记录数：${result.recordCount}。`);
        }
      } else
        setRecoveryReason(
          '暂未查到原命令回执或对应报名记录。空查询不能证明请求永远不会提交，结果仍未知。',
        );
    } finally {
      busyRef.current = false;
      if (alive()) setBusy(null);
    }
  }

  async function openExisting(target: PortableTaskLocator) {
    if (!activeRef.current || busyRef.current || locatorRef.current.pending)
      throw new Error('请先完成当前操作并核实待定命令，再打开已有任务。');
    const previous = locatorRef.current;
    const controller = new AbortController();
    openingRef.current = controller;
    busyRef.current = true;
    setBusy('querying');
    try {
      const reply = await openApprovalTask(runtime, target, controller.signal);
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
      const result = reply.value;
      if (
        taskRef.current?.taskId === result.task.taskId &&
        taskRef.current.version > result.task.version
      )
        throw new Error('查询返回了比当前已核实版本更旧的任务，当前任务与草稿保持不变。');
      // Everything above is read-only. Commit the validated identity and facts together.
      remember({
        version: 1,
        teachingSessionId: target.teachingSessionId,
        taskId: target.taskId,
        pending: null,
        archivedPending: null,
      });
      applySnapshot(result.task, result.enrollment, true);
      setFacts(result);
      setLastCommand(null);
      setStaleDecision(null);
      setExperimentCommand(null);
      setExperimentResult('');
      setError(null);
      setRestoreRequired(false);
      setPagesResetRequired(false);
      setRecoveryReason('');
      setQueriedPending(false);
      setDropResponse(false);
      setValidity('standard');
      setNotice(`已打开已有任务。报名记录数：${result.recordCount}；本次只查询事实。`);
      onResetTrace();
      runtime.trace({
        taskId: result.task.taskId,
        threadId: result.task.threadId,
        eventType: 'human-approval/facts',
        direction: runtime.mode === 'pages' ? 'browser-agent→client' : 'server→client',
        transport: runtime.mode === 'pages' ? 'browser-memory' : 'HTTP',
        label: '打开已有任务：已校验事实',
        payload: result,
      });
    } finally {
      if (openingRef.current === controller) {
        openingRef.current = null;
        busyRef.current = false;
        if (alive()) setBusy(null);
      }
    }
  }

  function wrongSession() {
    if (!proposal || busyRef.current || locatorRef.current.pending) return;
    void dispatch({
      ...command({
        type: 'approve',
        proposalId: proposal.proposalId,
        proposalVersion: proposal.proposalVersion,
      }),
      teachingSessionId: crypto.randomUUID(),
      purpose: 'experiment',
    });
  }

  function changedArguments() {
    if (!lastCommand || busyRef.current || locatorRef.current.pending) return;
    const original = lastCommand.command.payload;
    const payload: ApprovalCommand['payload'] =
      original.type === 'propose' || original.type === 'edit'
        ? { ...original, input: { ...original.input, seats: original.input.seats === 1 ? 2 : 1 } }
        : { ...original, type: original.type === 'approve' ? 'reject' : 'approve' };
    void dispatch({
      ...lastCommand,
      purpose: 'experiment',
      command: { ...lastCommand.command, payload },
    });
  }

  function reset() {
    const current = locatorRef.current;
    if (busyRef.current || (current.pending && !pagesResetRequired)) return;
    remember({
      version: 1,
      teachingSessionId: crypto.randomUUID(),
      taskId: null,
      pending: null,
      archivedPending: current.pending ?? current.archivedPending,
    });
    taskRef.current = null;
    setTask(null);
    const nextDraft = emptyDraft();
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setEnrollment(null);
    setFacts(null);
    setLastCommand(null);
    setStaleDecision(null);
    setExperimentCommand(null);
    setExperimentResult('');
    setError(null);
    setRestoreRequired(false);
    setPagesResetRequired(false);
    setRecoveryReason('');
    setQueriedPending(false);
    setDropResponse(false);
    setNotice('已开始新的教学会话，请生成报名提议。');
    onResetTrace();
  }

  const dirty = proposal ? isDirty(draft, proposal.content) : false;
  const expired = proposal ? now >= proposal.expiresAt : false;
  const pending = locator.pending;
  const locked = Boolean(busy || pending || restoreRequired || pagesResetRequired);
  const canDecide = proposal?.status === 'pending' && !expired && !locked;
  const staleIsOutdated = Boolean(
    staleDecision &&
    task &&
    proposal &&
    staleDecision.command.taskId === task.taskId &&
    staleDecision.command.expectedVersion < task.version &&
    staleDecision.command.payload.type === 'approve' &&
    staleDecision.command.payload.proposalVersion < proposal.proposalVersion,
  );
  const displayedCommand = pending ?? lastCommand;
  const displayedRecord = facts ? facts.enrollment : enrollment;
  const status =
    busy === 'sending'
      ? '正在发送命令，等待完整领域结果…'
      : busy === 'querying'
        ? '正在查询报名事实…'
        : pending
          ? '结果未知：保留原命令，先查询事实。'
          : pagesResetRequired
            ? '浏览器模拟已刷新，请显式重置后生成新提议。'
            : restoreRequired
              ? '已恢复查询定位信息，请查询事实恢复提议。'
              : notice;

  return (
    <section className={styles.root} aria-label="人工确认操作区">
      <header className={styles.intro}>
        <h2>核对一份提议，再确认一次业务动作</h2>
        <p>
          以虚构姓名报名工作坊，观察提议、人工决定与报名事实。修改后先保存，再确认已保存的最新内容。
        </p>
        <p className={styles.boundary}>
          <Database size={18} aria-hidden="true" />
          <span>
            {runtime.mode === 'pages'
              ? '浏览器内模拟，刷新后重置。状态与报名记录只在当前页面内存中，不代表真实服务端写入。'
              : '本地 HTTP · SQLite 持久化。命令回执、提议与报名记录在同一事务内提交，可查询服务端事实。'}
            教学会话仅用于实验隔离，请使用虚构资料。
          </span>
        </p>
      </header>

      <div className={styles.status} role="status" aria-live={active ? 'polite' : 'off'}>
        {pending ? (
          <CircleHelp size={18} aria-hidden="true" />
        ) : (
          <ShieldCheck size={18} aria-hidden="true" />
        )}
        <span>{status}</span>
      </div>

      {!storageAvailable && (
        <p className={styles.recovery}>
          浏览器会话存储不可用。原命令仍保留在本页面内存中；刷新或关闭页面可能丢失查询定位信息。会话存储只用于恢复线索，不保存业务事实。
        </p>
      )}

      {pagesResetRequired && (
        <div className={styles.recovery}>
          <h3>刷新后的模拟状态已清空</h3>
          <p>
            上次任务的定位信息和待定命令仍作为线索保留，但浏览器内存中的模拟任务已经重置。请点击“重置浏览器模拟”，再生成新提议；旧命令不会自动变成新报名。
          </p>
          <button
            className="button secondary"
            type="button"
            disabled={Boolean(busy)}
            onClick={reset}
          >
            重置浏览器模拟
          </button>
        </div>
      )}

      {restoreRequired && !pending && (
        <div className={styles.recovery}>
          <h3>{runtime.mode === 'pages' ? '先查询模拟状态' : '先恢复服务端事实'}</h3>
          <p>
            本页只恢复了教学会话和任务 ID。请“查询事实”读取提议与报名记录。
            {runtime.mode === 'pages'
              ? '切换实验后模拟状态可能仍在；页面刷新后的内存是否丢失，以查询结果为准。'
              : '也可以重置当前实验开始新任务。'}
          </p>
        </div>
      )}

      {pending && (
        <div className={styles.recovery} role="region" aria-label="待定命令恢复">
          <h3>{busy === 'sending' ? '原命令已保留，正在等待响应' : '结果未知'}</h3>
          <p>{recoveryReason || '尚未收到完整领域结果，请保留当前命令。'}</p>
          <p>
            新提议、编辑、确认、拒绝和边界实验暂时锁定。先点击“查询事实”；仍未查明时，可用相同教学会话、命令
            ID 和完整参数重试。
          </p>
          <div className={styles.actions}>
            <button
              className="button secondary"
              type="button"
              disabled={Boolean(busy) || !queriedPending || pagesResetRequired}
              onClick={() => void dispatch(pending, { retry: true })}
            >
              以原命令重试
            </button>
          </div>
        </div>
      )}

      <div className={styles.columns}>
        <form
          className={styles.panel}
          aria-label="报名提议表单"
          noValidate
          aria-busy={Boolean(busy)}
          onSubmit={(event) => {
            event.preventDefault();
            if (proposal?.status === 'pending') save();
            else propose();
          }}
        >
          <h3>报名信息</h3>
          {error && (
            <div
              className={styles.error}
              ref={errorRef}
              tabIndex={-1}
              role={active ? 'alert' : undefined}
              aria-labelledby="approval-error-title"
            >
              <h3 id="approval-error-title">请核对操作结果</h3>
              <p>{error.message}</p>
              {Object.keys(error.fields).length > 0 && (
                <ul>
                  {(Object.entries(error.fields) as Array<[keyof EnrollmentInput, string]>).map(
                    ([field, message]) => (
                      <li key={field}>
                        <a
                          href={`#${fieldIds[field]}`}
                          onClick={(event) => {
                            event.preventDefault();
                            if (activeRef.current)
                              document.getElementById(fieldIds[field])?.focus();
                          }}
                        >
                          {message}
                        </a>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </div>
          )}
          <div className={styles.field}>
            <label htmlFor={fieldIds.attendeeName}>姓名</label>
            <input
              id={fieldIds.attendeeName}
              value={draft.attendeeName}
              maxLength={80}
              autoComplete="off"
              disabled={locked}
              required
              aria-invalid={Boolean(error?.fields.attendeeName)}
              aria-describedby={`approval-name-hint${error?.fields.attendeeName ? ' approval-name-error' : ''}`}
              onChange={(event) => setDraft({ ...draft, attendeeName: event.target.value })}
            />
            <small id="approval-name-hint">使用虚构姓名，最多 80 个字符。</small>
            {error?.fields.attendeeName && (
              <p className={styles.fieldError} id="approval-name-error">
                {error.fields.attendeeName}
              </p>
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor={fieldIds.workshopId}>工作坊</label>
            <select
              id={fieldIds.workshopId}
              value={draft.workshopId}
              disabled={locked}
              aria-invalid={Boolean(error?.fields.workshopId)}
              aria-describedby={error?.fields.workshopId ? 'approval-workshop-error' : undefined}
              onChange={(event) =>
                setDraft({ ...draft, workshopId: event.target.value as Draft['workshopId'] })
              }
            >
              {WORKSHOPS.map((workshop) => (
                <option key={workshop.id} value={workshop.id}>
                  {workshop.title}
                </option>
              ))}
            </select>
            {error?.fields.workshopId && (
              <p className={styles.fieldError} id="approval-workshop-error">
                {error.fields.workshopId}
              </p>
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor={fieldIds.seats}>报名人数</label>
            <input
              id={fieldIds.seats}
              type="number"
              inputMode="numeric"
              min={1}
              max={6}
              step={1}
              required
              value={draft.seats}
              disabled={locked}
              aria-invalid={Boolean(error?.fields.seats)}
              aria-describedby={`approval-seats-hint${error?.fields.seats ? ' approval-seats-error' : ''}`}
              onChange={(event) => setDraft({ ...draft, seats: event.target.value })}
            />
            <small id="approval-seats-hint">每次报名 1 到 6 人。</small>
            {error?.fields.seats && (
              <p className={styles.fieldError} id="approval-seats-error">
                {error.fields.seats}
              </p>
            )}
          </div>
          {dirty && (
            <p className={styles.recovery}>
              有未保存修改。保存前不能确认；拒绝只针对下面已保存的提议。
            </p>
          )}
          {proposal?.status === 'pending' && expired && (
            <p className={styles.recovery}>
              提议已过期，请重新生成报名提议。旧内容不能继续授权确认。
            </p>
          )}
          <div className={styles.actions}>
            <button className="button primary" type="button" disabled={locked} onClick={propose}>
              <FilePenLine size={16} aria-hidden="true" />
              生成报名提议
            </button>
            <button
              className="button secondary"
              type="submit"
              disabled={locked || !dirty || proposal?.status !== 'pending' || expired}
            >
              保存修改
            </button>
          </div>
          <div className={styles.actions}>
            <button
              className="button primary"
              type="button"
              disabled={!canDecide || dirty}
              onClick={() => decide('approve')}
            >
              <CheckCircle2 size={16} aria-hidden="true" />
              确认报名
            </button>
            <button
              className="button danger"
              type="button"
              disabled={!canDecide}
              onClick={() => decide('reject')}
            >
              拒绝提议
            </button>
          </div>
          <p className={styles.note}>
            确认只执行已保存的姓名、工作坊和人数。请求发送完成并不能单独证明报名已写入。
          </p>
        </form>

        <section className={styles.panel} aria-label="已保存提议">
          <h3>已保存提议</h3>
          {proposal && task ? (
            <>
              <p className={styles.status}>
                {expired && proposal.status === 'pending'
                  ? '已过期'
                  : proposalStatuses[proposal.status]}
              </p>
              <dl className={styles.summary}>
                <dt>姓名</dt>
                <dd>{proposal.content.attendeeName}</dd>
                <dt>工作坊</dt>
                <dd>
                  {WORKSHOPS.find((workshop) => workshop.id === proposal.content.workshopId)?.title}
                </dd>
                <dt>报名人数</dt>
                <dd>{proposal.content.seats}</dd>
                <dt>任务版本</dt>
                <dd>{task.version}</dd>
                <dt>提议内容版本</dt>
                <dd>{proposal.proposalVersion}</dd>
                <dt>任务 ID</dt>
                <dd>
                  <code>{task.taskId}</code>
                </dd>
                <dt>提议 ID</dt>
                <dd>
                  <code>{proposal.proposalId}</code>
                </dd>
                <dt>教学会话</dt>
                <dd>
                  <code>{proposal.teachingSessionId}</code>
                </dd>
                <dt>创建时间</dt>
                <dd>{date(proposal.createdAt)}</dd>
                <dt>有效期至</dt>
                <dd>
                  <time dateTime={new Date(proposal.expiresAt).toISOString()}>
                    {date(proposal.expiresAt)}
                  </time>
                </dd>
              </dl>
            </>
          ) : (
            <p className={styles.note}>
              尚无已核实提议。生成提议或查询已有任务后，这里显示可确认的内容与版本。
            </p>
          )}
        </section>
      </div>

      <section className={styles.panel} aria-label="报名事实">
        <h3>查询报名事实</h3>
        <p>读取权威任务、命令回执与报名记录。查询不到回执和记录时，待定命令仍保持结果未知。</p>
        <div className={styles.actions}>
          <button
            className="button secondary"
            type="button"
            disabled={Boolean(busy) || !locator.taskId}
            onClick={() => void inspectFacts()}
          >
            查询事实
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={locked || !lastCommand}
            onClick={() => {
              if (lastCommand) void dispatch({ ...lastCommand, purpose: 'replay' });
            }}
          >
            重放上次命令
          </button>
        </div>
        <p>
          <strong>报名记录数：{facts ? facts.recordCount : '尚未查询'}</strong>
        </p>
        {facts && (
          <p className={styles.note}>
            查询时间：{date(facts.asOf)} ·{' '}
            {facts.durability === 'sqlite' ? 'SQLite 持久化事实' : '当前页面内存模拟'} · 命令回执：
            {facts.receipt?.status ?? '未查到'}
          </p>
        )}
        {displayedRecord ? (
          <article className={styles.record} aria-label="已核实报名记录">
            <h3>已核实报名记录</h3>
            <p>
              {displayedRecord.content.attendeeName} ·{' '}
              {
                WORKSHOPS.find((workshop) => workshop.id === displayedRecord.content.workshopId)
                  ?.title
              }{' '}
              · {displayedRecord.content.seats} 人
            </p>
            <dl className={styles.summary}>
              <dt>报名 ID</dt>
              <dd>
                <code>{displayedRecord.enrollmentId}</code>
              </dd>
              <dt>任务 ID</dt>
              <dd>
                <code>{displayedRecord.taskId}</code>
              </dd>
              <dt>提议 ID</dt>
              <dd>
                <code>{displayedRecord.proposalId}</code>
              </dd>
              <dt>提议内容版本</dt>
              <dd>{displayedRecord.proposalVersion}</dd>
              <dt>命令 ID</dt>
              <dd>
                <code>{displayedRecord.commandId}</code>
              </dd>
              <dt>教学会话</dt>
              <dd>
                <code>{displayedRecord.teachingSessionId}</code>
              </dd>
              <dt>写入时间</dt>
              <dd>{date(displayedRecord.createdAt)}</dd>
            </dl>
          </article>
        ) : (
          <p className={styles.note}>
            {facts ? '本次查询没有报名记录。' : '尚未取得报名记录证据。'}
          </p>
        )}
        <button
          className="button secondary"
          type="button"
          disabled={!facts || !active}
          onClick={() =>
            runtime.focusTrace({
              eventType: 'human-approval/facts',
              taskId: facts!.task.taskId,
            })
          }
        >
          在检查器中定位事实
        </button>
      </section>

      <TaskLocator
        labId="human-approval"
        mode={runtime.mode}
        current={
          locator.taskId
            ? {
                version: 1,
                labId: 'human-approval',
                mode: runtime.mode,
                teachingSessionId: locator.teachingSessionId,
                taskId: locator.taskId,
              }
            : null
        }
        disabled={!active || Boolean(busy || pending)}
        hasUnsavedDraft={isDirty(draft, proposal?.content ?? { ...emptyDraft(), seats: 1 })}
        onOpen={openExisting}
      />

      <section className={styles.panel} aria-label="当前命令">
        <h3>当前命令</h3>
        <p className={styles.note}>
          任务和命令 ID
          由浏览器生成。恢复时使用原教学会话与完整命令；会话存储只保留本浏览器标签页的查询线索和待定命令。
        </p>
        <dl className={styles.summary}>
          <dt>当前教学会话</dt>
          <dd>
            <code>{locator.teachingSessionId}</code>
          </dd>
          <dt>查询任务 ID</dt>
          <dd>
            <code>{locator.taskId ?? '尚未创建'}</code>
          </dd>
          {displayedCommand && (
            <>
              <dt>操作</dt>
              <dd>{actionNames[displayedCommand.command.payload.type]}</dd>
              <dt>命令 ID</dt>
              <dd>
                <code>{displayedCommand.command.commandId}</code>
              </dd>
              <dt>发送教学会话</dt>
              <dd>
                <code>{displayedCommand.teachingSessionId}</code>
              </dd>
            </>
          )}
        </dl>
        {displayedCommand && (
          <pre className={styles.command} aria-label="原始报名命令">
            {JSON.stringify(displayedCommand.command, null, 2)}
          </pre>
        )}
        {locator.archivedPending && (
          <details>
            <summary>上次页面的待定命令线索</summary>
            <p className={styles.note}>
              此命令仅供核对上次页面的未知结果，不代表新任务已执行，也不会自动重发。
            </p>
            <pre className={styles.command}>{JSON.stringify(locator.archivedPending, null, 2)}</pre>
          </details>
        )}
      </section>

      <details className={styles.experiments}>
        <summary>边界实验</summary>
        <div>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={dropResponse}
              disabled={locked}
              onChange={(event) => setDropResponse(event.target.checked)}
            />
            <span>模拟丢失确认响应</span>
          </label>
          <p className={styles.note}>
            确认命令提交后丢弃响应。页面应显示结果未知；先查询事实，再用原命令重试或重放，检查报名仍只有一条。恢复重试不会再次注入丢失响应。
          </p>
          <div className={styles.field}>
            <label htmlFor="approval-validity">新提议有效期</label>
            <select
              id="approval-validity"
              value={validity}
              disabled={locked}
              onChange={(event) => setValidity(event.target.value as typeof validity)}
            >
              <option value="standard">标准有效期</option>
              <option value="short">短有效期（用于过期实验）</option>
            </select>
            <small>仅影响下一份新提议，以返回的有效期时间为准。</small>
          </div>
          <p className={styles.note}>
            保存修改时保留保存前的确认命令，用它观察版本冲突。以下实验的拒绝结果单独显示，已知提议与报名记录继续保留。
          </p>
          <div className={styles.actions}>
            <button
              className="button secondary"
              type="button"
              disabled={locked || !staleIsOutdated}
              onClick={() => {
                if (staleDecision && staleIsOutdated) void dispatch(staleDecision);
              }}
            >
              尝试旧版本确认
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={locked || !proposal}
              onClick={wrongSession}
            >
              尝试错误会话确认
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={locked || !lastCommand}
              onClick={changedArguments}
            >
              尝试同键异参
            </button>
          </div>
          {experimentResult && (
            <p className={styles.recovery} role="status" aria-live={active ? 'polite' : 'off'}>
              {experimentResult}
            </p>
          )}
          {experimentCommand && (
            <pre className={styles.command} aria-label="边界实验命令">
              {JSON.stringify(experimentCommand, null, 2)}
            </pre>
          )}
        </div>
      </details>
      <div className={styles.actions}>
        <button
          className="button secondary"
          type="button"
          disabled={Boolean(busy) || Boolean(pending) || pagesResetRequired}
          onClick={reset}
        >
          重置实验
        </button>
        <span className={styles.note}>
          {runtime.mode === 'local'
            ? '清空当前页面和检查器，开始新的教学会话。本地已写入的 SQLite 记录仍然保留。'
            : '清空当前页面和检查器，开始新的模拟教学会话。'}
        </span>
      </div>
    </section>
  );
}
