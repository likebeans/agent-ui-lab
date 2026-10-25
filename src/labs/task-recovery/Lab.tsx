import { useEffect, useId, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Copy,
  Database,
  FileSearch,
  History,
  Link2,
  LoaderCircle,
  Play,
  RotateCcw,
  Unplug,
  Waypoints,
  Wrench,
} from 'lucide-react';
import type { LabComponentProps, TaskStatus } from '../../../shared/lab-contract';
import { isTerminal, recoveryIdSchema } from '../../../shared/labs/task-recovery/contract';
import { useRecoverySession, type Connection } from './useRecoverySession';
import styles from './lab.module.css';

const statusLabels: Record<TaskStatus, string> = {
  queued: '等待开始',
  running: '执行中',
  'waiting-input': '等待输入',
  succeeded: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
};
const connectionLabels: Record<Connection, string> = {
  idle: '尚未接流',
  connecting: '正在建立连接',
  connected: '接流中',
  disconnected: '已断开接流',
  ended: '任务终止，接流已结束',
  recovering: '正在恢复记录',
  paused: '展示已暂停',
  error: '连接或请求异常',
};
const toolLabels = {
  idle: '尚未调用',
  arguments: '接收参数',
  running: '本地工具执行中',
  completed: '本地工具已完成',
};

export default function TaskRecoveryLab({ runtime, active }: LabComponentProps) {
  const session = useRecoverySession(runtime, active);
  const { task, projection, busy } = session;
  const fieldId = useId();
  const [threadInput, setThreadInput] = useState(session.identity.threadId);
  const [taskInput, setTaskInput] = useState(session.identity.taskId);
  const [formError, setFormError] = useState('');
  const [resetArmed, setResetArmed] = useState(false);
  const [injectionOpen, setInjectionOpen] = useState(false);
  const locked = !active || Boolean(busy);
  const live = session.connection === 'connected' || session.connection === 'connecting';
  const pages = runtime.mode === 'pages';
  const terminal = task ? isTerminal(task.status) : false;
  const currentRun = task?.currentRunId;

  useEffect(() => {
    setThreadInput(session.identity.threadId);
    setTaskInput(session.identity.taskId);
    setFormError('');
  }, [session.identity.threadId, session.identity.taskId]);

  function inputIdentity() {
    const value = { threadId: threadInput.trim(), taskId: taskInput.trim() };
    if (
      !recoveryIdSchema.safeParse(value.threadId).success ||
      (value.taskId && !recoveryIdSchema.safeParse(value.taskId).success)
    ) {
      setFormError('ID 需为 1–96 个字母、数字、下划线或连字符，并以字母或数字开头。');
      return null;
    }
    setFormError('');
    return value;
  }

  const cancelText =
    session.cancellation === 'requesting'
      ? '取消请求中，尚未确认'
      : session.cancellation === 'confirmed'
        ? '服务端已确认取消'
        : session.cancellation === 'unconfirmed'
          ? '取消未确认，请查询任务状态'
          : '未请求取消';

  return (
    <section className={styles.root} aria-label="任务恢复实验操作区" aria-busy={Boolean(busy)}>
      <header className={styles.intro}>
        <p className={styles.eyebrow}>
          <History size={16} aria-hidden="true" /> W1 · TASK RECOVERY
        </p>
        <h2>连接可以断，任务有自己的进度</h2>
        <p>
          运行一个本地样本任务，断开接流后再查询。对照服务端状态与客户端投影，观察恢复如何只重放记录。
        </p>
      </header>

      <aside
        className={`${styles.modeNotice} ${pages ? styles.fixtureNotice : ''}`}
        aria-label="运行方式与持久化边界"
      >
        <Database size={18} aria-hidden="true" />
        <div>
          <strong>
            {pages ? 'Pages · memory-fixture 内存模拟' : '本地 HTTP · SQLite 任务存储'}
          </strong>
          <p>
            {pages
              ? '仅在当前页面内模拟独立任务和接流。刷新会清空任务、记录和工具计数；URL 保留的身份不能恢复已清空的数据。'
              : '任务、checkpoint 与事件记录保存在本地数据目录。刷新后按 URL 身份读取；任务执行不依赖 SSE 连接。'}
          </p>
          <p className={styles.small}>
            接口报告的存储方式：<code>{session.persistence ?? '尚未查询'}</code> · 确定性样本，无
            LLM。
          </p>
        </div>
      </aside>

      <section className={styles.section} aria-labelledby={`${fieldId}-identity-title`}>
        <div className={styles.sectionHeading}>
          <h3 id={`${fieldId}-identity-title`}>1. 选择任务身份</h3>
          <span>URL 只保存 thread / task ID</span>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = inputIdentity();
            if (value) void session.create(value);
          }}
        >
          <div className={styles.fields}>
            <div className={styles.field}>
              <label htmlFor={`${fieldId}-thread`}>Thread ID（会话）</label>
              <input
                id={`${fieldId}-thread`}
                value={threadInput}
                maxLength={96}
                required
                autoComplete="off"
                spellCheck={false}
                disabled={locked}
                aria-describedby={`${fieldId}-id-help${formError ? ` ${fieldId}-id-error` : ''}`}
                aria-invalid={Boolean(formError)}
                onChange={(event) => {
                  setThreadInput(event.target.value);
                  setFormError('');
                }}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor={`${fieldId}-task`}>Task ID（任务，可选）</label>
              <input
                id={`${fieldId}-task`}
                value={taskInput}
                maxLength={96}
                autoComplete="off"
                spellCheck={false}
                disabled={locked}
                placeholder="新建时留空，自动生成"
                aria-describedby={`${fieldId}-id-help${formError ? ` ${fieldId}-id-error` : ''}`}
                aria-invalid={Boolean(formError)}
                onChange={(event) => {
                  setTaskInput(event.target.value);
                  setFormError('');
                }}
              />
            </div>
          </div>
          <p id={`${fieldId}-id-help`} className={styles.help}>
            查询时留空 Task ID 可列出此 thread 的任务。创建另一任务前，先清空或更换 Task ID。
          </p>
          {formError && (
            <p id={`${fieldId}-id-error`} className={styles.error} role="alert">
              {formError}
            </p>
          )}
          <div className={styles.actions}>
            <button
              className={`button ${task ? 'secondary' : 'primary'}`}
              type="submit"
              disabled={locked || !threadInput.trim()}
            >
              {busy === 'create' ? (
                <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )}
              {busy === 'create' ? '正在新建…' : '新建任务'}
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={locked || !threadInput.trim()}
              onClick={() => {
                const value = inputIdentity();
                if (value) void session.query(value);
              }}
            >
              <FileSearch size={16} aria-hidden="true" />
              {busy === 'query' ? '正在查询…' : '查询任务'}
            </button>
          </div>
        </form>
        {session.tasks.length > 1 && (
          <ul className={styles.taskList} aria-label="此会话的任务">
            {session.tasks.map((item) => (
              <li key={item.taskId}>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() =>
                    void session.query({ threadId: item.threadId, taskId: item.taskId }, true)
                  }
                >
                  <code>{item.taskId}</code>
                  <span>
                    {statusLabels[item.status]} · v{item.version}
                  </span>
                  <span>选择并恢复</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby={`${fieldId}-actions-title`}>
        <div className={styles.sectionHeading}>
          <h3 id={`${fieldId}-actions-title`}>2. 执行与连接</h3>
          <span>连接状态与任务取消分别确认</span>
        </div>
        <div className={styles.actions}>
          <button
            className="button primary"
            type="button"
            disabled={locked || task?.status !== 'queued'}
            onClick={() => void session.command('start')}
          >
            <Play size={16} aria-hidden="true" />
            {busy === 'start' ? '正在开始…' : '开始执行'}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={locked || !live}
            onClick={session.disconnect}
          >
            <Unplug size={16} aria-hidden="true" />
            断开接流
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={locked || !session.identity.taskId || live}
            onClick={() => void session.query(session.identity, true)}
          >
            <Link2 size={16} aria-hidden="true" />
            {busy === 'recover' ? '正在恢复…' : '恢复连接'}
          </button>
          <button
            className="button danger"
            type="button"
            disabled={locked || task?.status !== 'running'}
            onClick={() => void session.command('cancel')}
          >
            {busy === 'cancel' ? (
              <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />
            ) : (
              <CircleStop size={16} aria-hidden="true" />
            )}
            {busy === 'cancel' ? '取消请求中…' : '取消任务'}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={locked || !terminal}
            onClick={() => void session.command('retry')}
          >
            <RotateCcw size={16} aria-hidden="true" />
            {busy === 'retry' ? '正在创建新 run…' : '重新执行（新 run）'}
          </button>
        </div>
        <p className={styles.help}>
          先新建，再开始执行。只有运行中的任务可取消；完成、失败或取消后可创建新
          run。断开接流后，当前显示的状态可能落后。
        </p>
        <div className={styles.feedback} role="status" aria-live="polite" aria-atomic="true">
          {busy ? (
            <LoaderCircle size={17} className={styles.spinner} aria-hidden="true" />
          ) : (
            <Waypoints size={17} aria-hidden="true" />
          )}
          <p>{session.notice}</p>
        </div>
        {session.error && (
          <div className={styles.error} role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <p>{session.error}</p>
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby={`${fieldId}-facts-title`}>
        <div className={styles.sectionHeading}>
          <h3 id={`${fieldId}-facts-title`}>3. 对照任务事实</h3>
          <span>服务端快照按查询时点展示</span>
        </div>
        <dl className={styles.identityFacts}>
          <div>
            <dt>Thread / 会话</dt>
            <dd>
              <code>{session.identity.threadId}</code>
            </dd>
          </div>
          <div>
            <dt>Task / 任务</dt>
            <dd>
              <code>{session.identity.taskId || '尚未选择'}</code>
            </dd>
          </div>
          <div>
            <dt>当前 run</dt>
            <dd>
              <code>{currentRun || '尚未开始'}</code>
            </dd>
          </div>
          <div>
            <dt>接流连接</dt>
            <dd>
              <span className={styles.connection} data-live={live}>
                {connectionLabels[session.connection]}
              </span>
            </dd>
          </div>
          <div>
            <dt>取消确认</dt>
            <dd>{cancelText}</dd>
          </div>
        </dl>
        <div className={styles.comparison}>
          <section className={styles.factPanel} aria-labelledby={`${fieldId}-authority`}>
            <h4 id={`${fieldId}-authority`}>服务端权威状态 · 最近查询</h4>
            <dl className={styles.facts}>
              <div>
                <dt>任务状态</dt>
                <dd>{task ? `${statusLabels[task.status]} (${task.status})` : '尚未读取'}</dd>
              </div>
              <div>
                <dt>版本 version</dt>
                <dd>{task?.version ?? '—'}</dd>
              </div>
              <div>
                <dt>本地 toolExecutionCount</dt>
                <dd>{task?.state.toolExecutionCount ?? '—'}</dd>
              </div>
              <div>
                <dt>读取时间</dt>
                <dd>{session.readTime || '—'}</dd>
              </div>
            </dl>
            <p className={styles.small}>查询或收到命令结果后更新。断连时后台可能已继续推进。</p>
          </section>
          <section className={styles.factPanel} aria-labelledby={`${fieldId}-projection`}>
            <h4 id={`${fieldId}-projection`}>客户端投影 · 已确认连续记录</h4>
            <dl className={styles.facts}>
              <div>
                <dt>投影状态</dt>
                <dd>
                  {projection
                    ? `${statusLabels[projection.state.status]} (${projection.state.status})`
                    : '尚未恢复'}
                </dd>
              </div>
              <div>
                <dt>cursor / afterSeq</dt>
                <dd>{projection?.afterSeq ?? '—'}</dd>
              </div>
              <div>
                <dt>恢复 checkpoint seq</dt>
                <dd>{session.recovery?.checkpointCursor.afterSeq ?? '—'}</dd>
              </div>
              <div>
                <dt>投影 toolExecutionCount</dt>
                <dd>{projection?.state.toolExecutionCount ?? '—'}</dd>
              </div>
            </dl>
            <p className={styles.small}>
              重复或旧 run 不改变投影；发现 gap 时 cursor 不跳过缺失记录。
            </p>
            {session.recovery && (
              <p className={styles.small}>
                本次恢复到 afterSeq {session.recovery.cursor.afterSeq}，重放{' '}
                {session.recovery.replayedEventCount} 条增量事件；之后接流可继续推进当前投影。
              </p>
            )}
            <button
              className={`button secondary ${styles.traceButton}`}
              type="button"
              disabled={locked || !session.recovery}
              onClick={() => {
                const recovery = session.recovery;
                if (!recovery) return;
                runtime.focusTrace({
                  labId: runtime.identity.labId,
                  threadId: recovery.threadId,
                  taskId: recovery.taskId,
                  runId: recovery.cursor.runId,
                  seq: recovery.cursor.afterSeq,
                  eventType: 'task-recovery/restored',
                });
              }}
            >
              <FileSearch size={16} aria-hidden="true" />
              定位本次恢复记录
            </button>
          </section>
        </div>
        {projection && (
          <p className={styles.cursor}>
            投影 run：<code>{projection.runId || '尚未开始'}</code> · afterSeq{' '}
            <code>{projection.afterSeq}</code>
          </p>
        )}
        <p className={styles.help}>
          toolExecutionCount
          只统计此本地样本的工具记录。恢复与重放不执行工具；此计数不证明外部服务副作用的
          exactly-once。
        </p>
      </section>

      <section className={styles.section} aria-labelledby={`${fieldId}-output-title`}>
        <div className={styles.sectionHeading}>
          <h3 id={`${fieldId}-output-title`}>4. 从记录还原的内容</h3>
          <span>
            <Wrench size={14} aria-hidden="true" />{' '}
            {projection ? toolLabels[projection.state.toolStatus] : '尚未调用'}
          </span>
        </div>
        <div className={styles.output}>
          <p className={projection?.state.text ? styles.resultText : styles.empty}>
            {projection?.state.text || '开始任务后，这里显示 AG-UI 文本记录重建出的内容。'}
          </p>
          {Boolean(projection?.state.cards.length) && (
            <ul className={styles.cards} aria-label="本地样本结果卡片">
              {projection!.state.cards.map((card) => (
                <li key={card.id}>
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <div>
                    <strong>{card.title}</strong>
                    <p>{card.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button
            className={`button secondary ${styles.traceButton}`}
            type="button"
            disabled={!active || !session.lastEvent}
            onClick={() => {
              const event = session.lastEvent;
              if (!event) return;
              runtime.focusTrace({
                labId: runtime.identity.labId,
                taskId: event.taskId,
                runId: event.runId,
                seq: event.seq,
                eventType: event.payload.type,
              });
            }}
          >
            <FileSearch size={16} aria-hidden="true" />
            定位最近事件记录
          </button>
        </div>
      </section>

      <details
        className={styles.experiments}
        open={injectionOpen}
        onToggle={(event) => setInjectionOpen(event.currentTarget.open)}
      >
        <summary>
          <span>投递故障实验</span>
          <span className={styles.small}>重复 · 迟到旧 run · 序号缺口</span>
        </summary>
        <div className={styles.experimentBody}>
          <p>
            只改变浏览器如何投递已有事件。缺口实验暂时从空投影漏投第 1 条记录，再补拉记录并恢复
            checkpoint；服务端任务事实保持不变。
          </p>
          <div className={styles.actions}>
            <button
              className="button secondary"
              type="button"
              disabled={locked || !projection?.afterSeq}
              onClick={() => void session.inject('duplicate')}
            >
              <Copy size={16} aria-hidden="true" />
              注入重复事件
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={locked || !session.hasOldEvent}
              onClick={() => void session.inject('old')}
            >
              <History size={16} aria-hidden="true" />
              注入旧 run 事件
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={locked || !currentRun}
              onClick={() => void session.inject('gap')}
            >
              <Unplug size={16} aria-hidden="true" />
              {busy === 'gap' ? '正在补拉缺口…' : '注入序号缺口'}
            </button>
          </div>
          <p className={styles.help}>
            旧 run 按钮在“重新执行（新
            run）”后可用。注入后检查投递结果、cursor、结果卡片和本地工具执行计数。
          </p>
        </div>
      </details>

      {pages && (
        <div className={styles.fixtureReset}>
          <p>重置会清空此页内全部 W1 样本任务、记录和工具计数。</p>
          <div className={styles.actions}>
            <button
              className="button secondary"
              type="button"
              disabled={locked}
              onClick={() => {
                if (!resetArmed) {
                  setResetArmed(true);
                  return;
                }
                setResetArmed(false);
                void session.resetFixture();
              }}
            >
              <RotateCcw size={16} aria-hidden="true" />
              {resetArmed ? '确认重置内存样本' : '重置内存样本'}
            </button>
            {resetArmed && (
              <button
                className="button secondary"
                type="button"
                disabled={locked}
                onClick={() => setResetArmed(false)}
              >
                保留样本
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
