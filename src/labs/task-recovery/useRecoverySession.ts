import { useEffect, useRef, useState } from 'react';
import { EventSchemas } from '@ag-ui/core/schemas';
import { z } from 'zod';
import type { LabRuntime } from '../../../shared/lab-contract';
import { errorMessage } from '../../../shared/http';
import { consumeSse } from '../../../shared/sse';
import { deliverRecoveryEvent, recoverProjection } from '../../../shared/labs/task-recovery/client';
import {
  RECOVERY_API,
  initialRecoveryState,
  isTerminal,
  recoveryIdSchema,
  type DeliveryOutcome,
  type RecoveryAction,
  type RecoveryCommand,
  type RecoveryCommandResult,
  type RecoveryEvent,
  type RecoveryProjection,
  type RecoveryReadResult,
  type RecoveryTask,
} from '../../../shared/labs/task-recovery/contract';

type Persistence = RecoveryReadResult['persistence'];
type Busy = 'create' | 'query' | 'recover' | 'start' | 'retry' | 'cancel' | 'gap' | 'reset' | null;
export type Connection =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'ended'
  | 'recovering'
  | 'paused'
  | 'error';
type Identity = { threadId: string; taskId: string };
type Scope = { generation: number; controller: AbortController };
type Stream = { scope: Scope; controller: AbortController };
type TaskResponse = { task: RecoveryTask; persistence: Persistence };
type ReplayResponse = { events: RecoveryEvent[]; persistence: Persistence };

const envelopeSchema = z
  .object({
    taskId: recoveryIdSchema,
    runId: recoveryIdSchema,
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    payload: z.unknown(),
  })
  .strict();

function parseEvent(value: unknown): RecoveryEvent {
  const envelope = envelopeSchema.parse(value);
  EventSchemas.parse(envelope.payload);
  // Validate without replacing the original AG-UI payload with a display model.
  return value as RecoveryEvent;
}

export function recoveryId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function locationIdentity(): Identity {
  const query = new URL(window.location.href).searchParams;
  const threadId = query.get('recoveryThread');
  const taskId = query.get('recoveryTask');
  return {
    threadId: recoveryIdSchema.safeParse(threadId).success ? threadId! : recoveryId('thread'),
    taskId: recoveryIdSchema.safeParse(taskId).success ? taskId! : '',
  };
}

function rememberIdentity(identity: Identity): void {
  const url = new URL(window.location.href);
  url.searchParams.set('recoveryThread', identity.threadId);
  if (identity.taskId) url.searchParams.set('recoveryTask', identity.taskId);
  else url.searchParams.delete('recoveryTask');
  window.history.replaceState(window.history.state, '', url);
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function useRecoverySession(runtime: LabRuntime, active: boolean) {
  const [identity, setIdentity] = useState(locationIdentity);
  const [task, setTask] = useState<RecoveryTask | null>(null);
  const [projection, setProjection] = useState<RecoveryProjection | null>(null);
  const [tasks, setTasks] = useState<RecoveryTask[]>([]);
  const [persistence, setPersistence] = useState<Persistence | null>(null);
  const [connection, setConnection] = useState<Connection>('idle');
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState('新建一个确定性任务，或按 URL 中的身份查询已有任务。');
  const [error, setError] = useState('');
  const [cancellation, setCancellation] = useState<
    'none' | 'requesting' | 'confirmed' | 'unconfirmed'
  >('none');
  const [checkpointSeq, setCheckpointSeq] = useState<number | null>(null);
  const [readTime, setReadTime] = useState('');
  const [lastEvent, setLastEvent] = useState<RecoveryEvent | null>(null);
  const [hasOldEvent, setHasOldEvent] = useState(false);
  const current = useRef({ identity, task, projection });
  const runtimeRef = useRef(runtime);
  const activeRef = useRef(active);
  const mounted = useRef(false);
  const generation = useRef(0);
  const operation = useRef<Scope | null>(null);
  const stream = useRef<Stream | null>(null);
  const busyRef = useRef<Busy>(null);
  const wantsConnection = useRef(true);
  const history = useRef<RecoveryEvent[]>([]);
  const oldEvent = useRef<RecoveryEvent | null>(null);
  const cancelRequested = useRef(false);
  runtimeRef.current = runtime;
  activeRef.current = active;

  function valid(scope: Scope): boolean {
    return (
      mounted.current &&
      activeRef.current &&
      !runtimeRef.current.signal.aborted &&
      generation.current === scope.generation &&
      !scope.controller.signal.aborted
    );
  }

  function closeStream(): void {
    const previous = stream.current;
    stream.current = null;
    previous?.controller.abort();
  }

  function invalidate(): void {
    generation.current += 1;
    operation.current?.controller.abort();
    operation.current = null;
    closeStream();
  }

  function begin(kind: Busy): Scope | null {
    if (
      !mounted.current ||
      !activeRef.current ||
      runtimeRef.current.signal.aborted ||
      busyRef.current
    )
      return null;
    invalidate();
    setConnection((value) =>
      value === 'connected' || value === 'connecting' ? 'disconnected' : value,
    );
    const scope = { generation: generation.current, controller: new AbortController() };
    operation.current = scope;
    busyRef.current = kind;
    setBusy(kind);
    setError('');
    return scope;
  }

  function finish(scope: Scope): void {
    if (!valid(scope)) return;
    busyRef.current = null;
    setBusy(null);
  }

  function fail(cause: unknown, scope: Scope): void {
    if (!valid(scope)) return;
    setError(errorMessage(cause));
    setConnection('error');
    if (busyRef.current === 'cancel' && current.current.task?.status !== 'cancelled')
      setCancellation('unconfirmed');
  }

  function selectIdentity(next: Identity): void {
    if (
      next.taskId !== current.current.identity.taskId ||
      next.threadId !== current.current.identity.threadId
    ) {
      history.current = [];
      oldEvent.current = null;
      setHasOldEvent(false);
      setLastEvent(null);
      current.current.task = null;
      current.current.projection = null;
      setTask(null);
      setProjection(null);
      cancelRequested.current = false;
      setCancellation('none');
      setCheckpointSeq(null);
      setReadTime('');
      setTasks([]);
    }
    current.current.identity = next;
    setIdentity(next);
    rememberIdentity(next);
  }

  function putTask(next: RecoveryTask, storage?: Persistence): void {
    const changedRun = current.current.task?.currentRunId !== next.currentRunId;
    current.current.task = next;
    setTask(next);
    setReadTime(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    if (storage) setPersistence(storage);
    if (changedRun) {
      cancelRequested.current = false;
      setLastEvent(null);
      setCancellation(next.status === 'cancelled' ? 'confirmed' : 'none');
    } else if (next.status === 'cancelled') setCancellation('confirmed');
    else if (cancelRequested.current && busyRef.current !== 'cancel')
      setCancellation('unconfirmed');
  }

  function putProjection(next: RecoveryProjection): void {
    current.current.projection = next;
    setProjection(next);
  }

  function keepEvent(event: RecoveryEvent): void {
    if (
      !history.current.some(
        (item) =>
          item.taskId === event.taskId && item.runId === event.runId && item.seq === event.seq,
      )
    ) {
      history.current = [...history.current.slice(-79), event];
    }
    setLastEvent(event);
  }

  async function json<T>(
    path: string,
    scope: Scope,
    options: RequestInit = {},
    command = false,
  ): Promise<T> {
    const rt = runtimeRef.current;
    const id = current.current.identity;
    const method = options.method ?? 'GET';
    rt.trace({
      ...id,
      runId: current.current.task?.currentRunId ?? undefined,
      direction: 'client→server',
      eventType: 'task-recovery/request',
      label: `${method} ${path}`,
      payload: options.body ? JSON.parse(String(options.body)) : { path },
    });
    const response = await rt.request(path, { ...options, signal: scope.controller.signal });
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new ApiError(
        `任务接口未返回 JSON（${response.status}）。请确认 W1 adapter 已登记。`,
        response.status,
      );
    }
    const value = await response.json();
    if (!valid(scope)) throw new DOMException('已切换任务或暂停展示', 'AbortError');
    rt.trace({
      ...id,
      runId: current.current.task?.currentRunId ?? undefined,
      direction: 'server→client',
      eventType: 'task-recovery/response',
      label: `${method} ${response.status}`,
      payload: value,
    });
    if (
      !response.ok &&
      !(command && (value?.status === 'conflict' || value?.status === 'rejected'))
    ) {
      throw new ApiError(
        typeof value?.error === 'string' ? value.error : `请求失败（${response.status}）`,
        response.status,
      );
    }
    return value as T;
  }

  function taskPath(taskId: string): string {
    return `${RECOVERY_API}/tasks/${encodeURIComponent(taskId)}`;
  }

  async function readRecovery(scope: Scope): Promise<RecoveryReadResult> {
    const id = current.current.identity;
    const result = await json<RecoveryReadResult>(`${taskPath(id.taskId)}/recovery`, scope);
    if (result.task.taskId !== id.taskId || result.task.threadId !== id.threadId) {
      throw new Error('任务与当前 thread/task 身份不一致，未应用恢复数据。');
    }
    const next = recoverProjection(result);
    if (!valid(scope)) return result;
    putTask(result.task, result.persistence);
    putProjection(next);
    setCheckpointSeq(result.checkpoint.cursor.afterSeq);
    for (const value of result.events) {
      const event = parseEvent(value);
      keepEvent(event);
      traceEvent(event, 'checkpoint 后的记录重放');
    }
    runtimeRef.current.trace({
      ...id,
      runId: next.runId || undefined,
      seq: next.afterSeq,
      direction: 'local',
      eventType: 'task-recovery/restored',
      label: 'checkpoint + events 已恢复投影',
      payload: {
        checkpointCursor: result.checkpoint.cursor,
        cursor: { runId: next.runId, afterSeq: next.afterSeq },
      },
      note: '恢复只读取已有记录；未调用任务命令或工具。',
    });
    return result;
  }

  function traceEvent(event: RecoveryEvent, note: string, injected = false): void {
    runtimeRef.current.trace({
      protocol: 'agui',
      direction: injected ? 'local' : 'server→client',
      threadId: current.current.identity.threadId,
      taskId: event.taskId,
      runId: event.runId,
      seq: event.seq,
      eventType: event.payload.type,
      label: injected ? `注入：${event.payload.type}` : event.payload.type,
      payload: event.payload,
      note,
    });
  }

  function deliver(event: RecoveryEvent, injected = false): DeliveryOutcome {
    const before = current.current.projection;
    if (!before) throw new Error('尚无客户端投影，请先查询任务。');
    const outcome = deliverRecoveryEvent(before, event);
    traceEvent(event, `投递结果：${outcome.type}；应用序号保留在 envelope 外层。`, injected);
    if (outcome.type === 'applied') {
      putProjection(outcome.projection);
      keepEvent(event);
    }
    return outcome;
  }

  async function replay(
    scope: Scope,
    projectionToRead: RecoveryProjection,
  ): Promise<RecoveryEvent[]> {
    const query = new URLSearchParams({
      runId: projectionToRead.runId,
      afterSeq: String(projectionToRead.afterSeq),
    });
    const result = await json<ReplayResponse>(
      `${taskPath(projectionToRead.taskId)}/replay?${query}`,
      scope,
    );
    return result.events.map(parseEvent);
  }

  async function repair(scope: Scope, before: RecoveryProjection): Promise<void> {
    setConnection('recovering');
    try {
      const events = await replay(scope, before);
      for (const event of events) {
        if (!valid(scope)) return;
        const outcome = deliver(event);
        if (outcome.type === 'gap') throw new Error('补拉仍有缺口，改用 checkpoint 恢复。');
      }
    } catch (cause) {
      if (!valid(scope)) return;
      runtimeRef.current.trace({
        ...current.current.identity,
        runId: before.runId,
        direction: 'local',
        eventType: 'task-recovery/replay-fallback',
        label: '补拉不可用，查询权威 checkpoint',
        payload: { reason: errorMessage(cause) },
      });
    }
    if (!valid(scope)) return;
    await readRecovery(scope);
    if (valid(scope)) {
      setNotice('序号缺口已恢复：补拉记录并查询 checkpoint；没有重新执行工具。');
      connect(scope);
    }
  }

  function connect(scope: Scope): void {
    const selected = current.current;
    if (!valid(scope)) return;
    if (!wantsConnection.current) {
      setConnection('disconnected');
      return;
    }
    if (!selected.task?.currentRunId || !selected.projection) {
      setConnection('idle');
      return;
    }
    if (isTerminal(selected.task.status)) {
      setConnection('ended');
      return;
    }
    closeStream();
    const entry: Stream = { scope, controller: new AbortController() };
    stream.current = entry;
    const cursor = selected.projection;
    const query = new URLSearchParams({ runId: cursor.runId, afterSeq: String(cursor.afterSeq) });
    setConnection('connecting');
    const isCurrent = () =>
      valid(scope) && stream.current === entry && !entry.controller.signal.aborted;
    void (async () => {
      try {
        const response = await runtimeRef.current.request(
          `${taskPath(cursor.taskId)}/events?${query}`,
          {
            headers: { Accept: 'text/event-stream' },
            signal: AbortSignal.any([scope.controller.signal, entry.controller.signal]),
          },
        );
        if (!isCurrent()) {
          await response.body?.cancel();
          return;
        }
        if (response.ok) setConnection('connected');
        await consumeSse(
          response,
          (value) => {
            if (!isCurrent()) return;
            const outcome = deliver(parseEvent(value));
            if (outcome.type === 'gap') {
              closeStream();
              busyRef.current = 'recover';
              setBusy('recover');
              setNotice(`检测到序号缺口：cursor ${outcome.projection.afterSeq}，正在补拉记录…`);
              void repair(scope, outcome.projection)
                .catch((cause) => fail(cause, scope))
                .finally(() => finish(scope));
            }
          },
          entry.controller.signal,
        );
        if (!isCurrent()) return;
        // EOF alone is not a task outcome. Keep this stream's identity while querying,
        // so failures still reach the guarded catch instead of leaving a live label.
        const value = await json<TaskResponse>(taskPath(cursor.taskId), scope);
        if (!isCurrent()) return;
        if (value.task.currentRunId !== cursor.runId) {
          await readRecovery(scope);
          if (!isCurrent()) return;
          stream.current = null;
          connect(scope);
          return;
        }
        if (
          isTerminal(value.task.status) &&
          !isTerminal(current.current.projection?.state.status ?? 'queued')
        ) {
          await readRecovery(scope);
          if (!isCurrent()) return;
        } else putTask(value.task, value.persistence);
        stream.current = null;
        setConnection(isTerminal(value.task.status) ? 'ended' : 'disconnected');
        if (!isTerminal(value.task.status))
          setNotice('事件连接已结束，任务尚未终止。点击“恢复连接”继续查询与接流。');
      } catch (cause) {
        if (!isCurrent()) return;
        stream.current = null;
        setConnection('error');
        setError(`接流中断：${errorMessage(cause)}。任务结果请通过“查询任务”确认。`);
      }
    })();
  }

  async function query(input: Identity, resume = false): Promise<void> {
    const scope = begin(resume ? 'recover' : 'query');
    if (!scope) return;
    wantsConnection.current = resume;
    try {
      recoveryIdSchema.parse(input.threadId);
      if (input.taskId) recoveryIdSchema.parse(input.taskId);
      selectIdentity(input);
      setConnection(resume ? 'recovering' : 'disconnected');
      if (!input.taskId) {
        const result = await json<{ tasks: RecoveryTask[]; persistence: Persistence }>(
          `${RECOVERY_API}/tasks?${new URLSearchParams({ threadId: input.threadId })}`,
          scope,
        );
        setTasks(result.tasks);
        setPersistence(result.persistence);
        if (result.tasks.length !== 1) {
          setConnection('idle');
          setNotice(
            result.tasks.length
              ? `此 thread 有 ${result.tasks.length} 个任务，请选择一个查询。`
              : '此 thread 暂无任务，可以新建任务。',
          );
          return;
        }
        selectIdentity({ threadId: input.threadId, taskId: result.tasks[0].taskId });
      }
      await readRecovery(scope);
      if (!valid(scope)) return;
      setNotice(
        resume
          ? '已通过 checkpoint + events 恢复；正在按当前 run 继续接流。'
          : '已查询权威状态并重建投影；当前未接流。',
      );
      if (resume) connect(scope);
    } catch (cause) {
      if (valid(scope) && cause instanceof ApiError && cause.status === 404) {
        current.current.task = null;
        current.current.projection = null;
        setTask(null);
        setProjection(null);
        setConnection('idle');
        const detail =
          runtimeRef.current.mode === 'pages'
            ? 'Pages 的 memory-fixture 刷新后会清空。URL 只保留身份，请新建任务。'
            : '请检查 thread/task 身份与当前本地数据目录。';
        setError(`未找到任务。${detail}`);
      } else fail(cause, scope);
      if (valid(scope) && cancelRequested.current && current.current.task?.status !== 'cancelled')
        setCancellation('unconfirmed');
    } finally {
      finish(scope);
    }
  }

  async function create(input: Identity): Promise<void> {
    const scope = begin('create');
    if (!scope) return;
    try {
      recoveryIdSchema.parse(input.threadId);
      const taskId = input.taskId || recoveryId('task');
      recoveryIdSchema.parse(taskId);
      selectIdentity({ threadId: input.threadId, taskId });
      const result = await json<TaskResponse>(`${RECOVERY_API}/tasks`, scope, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: input.threadId,
          taskId,
          commandId: recoveryId('command'),
        }),
      });
      putTask(result.task, result.persistence);
      await readRecovery(scope);
      if (!valid(scope)) return;
      setConnection('idle');
      setNotice('任务已创建，状态 queued。点击“开始执行”启动一个新 run。');
    } catch (cause) {
      fail(cause, scope);
    } finally {
      finish(scope);
    }
  }

  async function command(type: RecoveryAction['type']): Promise<void> {
    if (!current.current.task) return;
    const scope = begin(type);
    if (!scope) return;
    if (type === 'cancel') {
      cancelRequested.current = true;
      setCancellation('requesting');
      setNotice('取消请求中；等待服务端命令结果，断开接流不会确认任务取消。');
    } else {
      cancelRequested.current = false;
      wantsConnection.current = true;
      setCancellation('none');
    }
    try {
      const previous = current.current.task;
      if (type === 'retry' && previous?.currentRunId) {
        const saved = [...history.current]
          .reverse()
          .find(
            (event) => event.taskId === previous.taskId && event.runId === previous.currentRunId,
          );
        const recorded =
          saved ??
          (
            await replay(scope, {
              taskId: previous.taskId,
              runId: previous.currentRunId,
              afterSeq: 0,
              state: initialRecoveryState(),
            })
          ).at(-1);
        oldEvent.current = recorded ?? null;
        setHasOldEvent(Boolean(recorded));
      }
      const latest = await json<TaskResponse>(taskPath(current.current.identity.taskId), scope);
      putTask(latest.task, latest.persistence);
      const payload: RecoveryAction =
        type === 'cancel' ? { type } : { type, runId: recoveryId('run') };
      const body: RecoveryCommand = {
        commandId: recoveryId('command'),
        taskId: latest.task.taskId,
        expectedVersion: latest.task.version,
        payload,
      };
      const result = await json<RecoveryCommandResult>(
        `${taskPath(body.taskId)}/commands`,
        scope,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        true,
      );
      if (result.status !== 'accepted') {
        if (type === 'cancel') setCancellation('unconfirmed');
        await readRecovery(scope);
        setError(
          `${result.status === 'conflict' ? '版本冲突' : '命令被拒绝'}：${result.reason}。已刷新状态，请确认后重试。`,
        );
        if (wantsConnection.current) connect(scope);
        else setConnection('disconnected');
        return;
      }
      putTask(result.result);
      await readRecovery(scope);
      if (!valid(scope)) return;
      if (type === 'cancel') {
        const confirmed = current.current.task?.status === 'cancelled';
        setCancellation(confirmed ? 'confirmed' : 'unconfirmed');
        setNotice(
          confirmed
            ? '服务端已确认取消。关闭连接与取消任务是两个独立操作。'
            : '命令已返回，但任务没有进入 cancelled，请以服务端状态为准。',
        );
      } else
        setNotice(
          type === 'retry'
            ? '重新执行已创建新 run；旧 run 的迟到事件会被拒绝。'
            : '任务已开始；执行独立于浏览器接流连接。',
        );
      connect(scope);
    } catch (cause) {
      fail(cause, scope);
    } finally {
      finish(scope);
    }
  }

  function disconnect(): void {
    if (busyRef.current || !activeRef.current) return;
    wantsConnection.current = false;
    invalidate();
    setConnection('disconnected');
    setNotice('已断开接流，仅关闭浏览器连接。任务仍可在后台继续；请查询权威状态。');
  }

  async function inject(kind: 'duplicate' | 'old' | 'gap'): Promise<void> {
    const selected = current.current.projection;
    if (!selected?.runId) return;
    const scope = begin(kind === 'gap' ? 'gap' : 'query');
    if (!scope) return;
    try {
      if (kind === 'old') {
        const event = oldEvent.current;
        if (!event || event.taskId !== selected.taskId || event.runId === selected.runId)
          throw new Error('请先完成一次运行，再点击“重新执行（新 run）”保留旧 run 记录。');
        const outcome = deliver(event, true);
        setNotice(`旧 run 事件投递结果：${outcome.type}；当前 run、cursor 与结果保持不变。`);
      } else {
        const events = await replay(scope, { ...selected, afterSeq: 0 });
        if (kind === 'duplicate') {
          const event = [...events].reverse().find((item) => item.seq <= selected.afterSeq);
          if (!event) throw new Error('还没有已应用事件，请接收事件或恢复后再注入。');
          const outcome = deliver(event, true);
          setNotice(`重复事件投递结果：${outcome.type}；cursor 与本地工具执行计数保持不变。`);
        } else {
          if (events.length < 2) throw new Error('至少需要两条已记录事件；请稍后再注入缺口。');
          // A local delivery experiment: reuse real recorded envelopes, omit #1, then deliver #2.
          // This seed is a browser projection, not a server checkpoint or persisted task fact.
          putProjection({
            taskId: selected.taskId,
            runId: selected.runId,
            afterSeq: 0,
            state: initialRecoveryState(),
          });
          const outcome = deliver(events[1], true);
          if (outcome.type !== 'gap') throw new Error('记录没有产生预期序号缺口，请查询任务。');
          setNotice(`已模拟漏收第 1 条记录，收到 seq ${events[1].seq}；正在恢复…`);
          await repair(scope, outcome.projection);
          return;
        }
      }
      connect(scope);
    } catch (cause) {
      fail(cause, scope);
    } finally {
      finish(scope);
    }
  }

  async function resetFixture(): Promise<void> {
    if (runtimeRef.current.mode !== 'pages') return;
    const scope = begin('reset');
    if (!scope) return;
    try {
      const response = await runtimeRef.current.request(`${RECOVERY_API}/fixture`, {
        method: 'DELETE',
        signal: scope.controller.signal,
      });
      if (!valid(scope)) return;
      if (!response.ok)
        throw new Error(
          `此 adapter 未提供内存样本重置（${response.status}）。刷新页面也会清空 Pages 样本。`,
        );
      selectIdentity({ threadId: current.current.identity.threadId, taskId: '' });
      setTasks([]);
      setPersistence('memory-fixture');
      setConnection('idle');
      setNotice('内存样本已重置，后台样本任务与记录已清空。请新建任务。');
    } catch (cause) {
      fail(cause, scope);
    } finally {
      finish(scope);
    }
  }

  useEffect(() => {
    mounted.current = true;
    busyRef.current = null;
    setBusy(null);
    if (active && !runtimeRef.current.signal.aborted) {
      void query(current.current.identity, true);
    } else {
      setConnection('paused');
      if (cancelRequested.current && current.current.task?.status !== 'cancelled')
        setCancellation('unconfirmed');
    }
    return () => {
      mounted.current = false;
      invalidate();
    };
  }, [active, runtime.signal]);

  return {
    identity,
    task,
    projection,
    tasks,
    persistence,
    connection,
    busy,
    notice,
    error,
    cancellation,
    checkpointSeq,
    readTime,
    lastEvent,
    hasOldEvent,
    create,
    query,
    command,
    disconnect,
    inject,
    resetFixture,
  };
}
