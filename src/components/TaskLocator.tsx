import { useEffect, useId, useRef, useState } from 'react';
import {
  formatTaskLocator,
  parseTaskLocator,
  type TaskLocator as Locator,
  type TaskLocatorScope,
} from '../../shared/labs/task-locator';
import styles from './TaskLocator.module.css';

interface Props extends TaskLocatorScope {
  current: Locator | null;
  disabled: boolean;
  hasUnsavedDraft: boolean;
  onOpen: (locator: Locator) => Promise<void>;
}

/** Shared query form; each lab owns validation of facts and the atomic state change. */
export function TaskLocator({ current, labId, mode, disabled, hasUnsavedDraft, onOpen }: Props) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  const [candidate, setCandidate] = useState<Locator | null>(null);
  const [opening, setOpening] = useState(false);
  const currentText = current ? formatTaskLocator(current) : '';
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const openingRef = useRef(false);
  const copyAttempt = useRef(0);
  const locked = disabled || opening;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      copyAttempt.current += 1;
    };
  }, []);
  useEffect(() => {
    setCandidate(null);
    setCopyNotice('');
    copyAttempt.current += 1;
  }, [currentText, labId, mode]);
  useEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);
  useEffect(() => {
    if (candidate) confirmationRef.current?.focus({ preventScroll: true });
  }, [candidate]);

  function selectCurrent() {
    outputRef.current?.focus();
    outputRef.current?.select();
  }
  async function copyCurrent() {
    if (!currentText) return;
    const attempt = ++copyAttempt.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(currentText);
      if (mounted.current && attempt === copyAttempt.current)
        setCopyNotice('定位信息已复制；其中不含草稿、业务事实或命令。');
    } catch {
      if (!mounted.current || attempt !== copyAttempt.current) return;
      selectCurrent();
      setCopyNotice('自动复制不可用，已选中定位信息。请使用系统复制操作。');
    }
  }
  async function open(locator: Locator) {
    if (locked || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setCandidate(null);
    setError('');
    try {
      await onOpen(locator);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : '查询未完成，当前任务与草稿保持不变。');
    } finally {
      openingRef.current = false;
      if (mounted.current) setOpening(false);
    }
  }

  return (
    <section className={styles.root} aria-label="任务定位信息">
      <h3>复制定位信息，打开已有任务</h3>
      <p className={styles.hint} id={`${id}-scope`}>
        {mode === 'pages'
          ? 'Pages 仅能恢复当前页面内存中的任务；独立标签页或刷新清空后会返回 NOT_FOUND。'
          : '本地模式可在重置实验后或新标签页中，通过同一实例的 SQLite 事实恢复旧任务。'}
        打开只查询事实，不会生成提议、确认或重发命令。
      </p>
      {current ? (
        <div className={styles.field}>
          <label htmlFor={`${id}-current`}>当前任务定位信息</label>
          <textarea
            id={`${id}-current`}
            ref={outputRef}
            readOnly
            rows={7}
            value={currentText}
            spellCheck={false}
            aria-describedby={`${id}-scope`}
          />
          <div className={styles.actions}>
            <button className="button secondary" type="button" onClick={() => void copyCurrent()}>
              复制定位信息
            </button>
            <button className="button secondary" type="button" onClick={selectCurrent}>
              选择定位信息
            </button>
          </div>
          {copyNotice && <p role="status">{copyNotice}</p>}
        </div>
      ) : (
        <p className={styles.hint}>
          生成提议后即可复制任务定位信息。也可直接粘贴已有任务的定位信息。
        </p>
      )}
      <form
        className={styles.form}
        aria-label="打开已有任务"
        aria-busy={opening}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (locked || openingRef.current) return;
          setError('');
          try {
            const locator = parseTaskLocator(text, { labId, mode });
            if (hasUnsavedDraft) setCandidate(locator);
            else void open(locator);
          } catch (cause) {
            setCandidate(null);
            setError(cause instanceof Error ? cause.message : '请粘贴有效的定位 JSON。');
          }
        }}
      >
        {error && (
          <div className={styles.error} role="alert" tabIndex={-1} ref={errorRef}>
            <p id={`${id}-error`}>{error}</p>
            <a
              href={`#${id}-input`}
              onClick={(event) => {
                event.preventDefault();
                inputRef.current?.focus();
              }}
            >
              返回定位信息输入框
            </a>
          </div>
        )}
        <div className={styles.field}>
          <label htmlFor={`${id}-input`}>粘贴任务定位信息</label>
          <textarea
            id={`${id}-input`}
            ref={inputRef}
            value={text}
            rows={6}
            maxLength={4096}
            disabled={locked}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-scope${error ? ` ${id}-error` : ''}`}
            onChange={(event) => {
              setText(event.target.value);
              setError('');
              setCandidate(null);
            }}
          />
        </div>
        <button className="button secondary" type="submit" disabled={locked || Boolean(candidate)}>
          {opening ? '正在查询已有任务…' : '打开已有任务'}
        </button>
        {disabled && <p className={styles.hint}>操作进行中或有待定命令时，不能切换任务。</p>}
        {candidate && (
          <div
            className={styles.confirmation}
            role="group"
            aria-label="放弃草稿确认"
            tabIndex={-1}
            ref={confirmationRef}
          >
            <p>
              当前有未保存草稿。打开任务 <code>{candidate.taskId}</code> 将放弃草稿。
              只有查询并校验成功才切换；查询失败仍保留当前内容。
            </p>
            <div className={styles.actions}>
              <button
                className="button secondary"
                type="button"
                disabled={locked}
                onClick={() => void open(candidate)}
              >
                放弃草稿并打开任务
              </button>
              <button className="button secondary" type="button" onClick={() => setCandidate(null)}>
                保留草稿，取消打开
              </button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}
