import { useState } from 'react';
import type { LabComponentProps } from '../../../shared/lab-contract';
import { errorMessage } from '../../../shared/http';
import type { runFoundation } from '../../../shared/labs/foundation/engine';
import styles from './lab.module.css';

export default function FoundationLab({ runtime, onResetTrace }: LabComponentProps) {
  const [text, setText] = useState('从操作追到消息和源码');
  const [result, setResult] = useState<ReturnType<typeof runFoundation> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [runId, setRunId] = useState('');

  async function run() {
    if (busy) return;
    const id = `run-${crypto.randomUUID()}`;
    const payload = { text };
    setBusy(true);
    setError('');
    setResult(null);
    setRunId(id);
    runtime.trace({
      direction: 'client→server',
      eventType: 'foundation/request',
      runId: id,
      label: 'POST /api/labs/foundation/run',
      payload,
    });
    try {
      const response = await runtime.request('/api/labs/foundation/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `请求失败 (${response.status})`);
      if (runtime.signal.aborted) return;
      setResult(value);
      runtime.trace({
        direction: 'server→client',
        eventType: 'foundation/result',
        runId: id,
        label: '实验计算结果',
        payload: value,
      });
    } catch (cause) {
      if (!runtime.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!runtime.signal.aborted) setBusy(false);
    }
  }

  return (
    <section className={styles.root} aria-label="实验接入示例操作区">
      <h2>一个实验，两种运行方式</h2>
      <p>修改输入后执行，在检查器中观察原始结果与关联 ID。</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <label htmlFor="foundation-text">要观察的内容</label>
        <input
          id="foundation-text"
          type="text"
          value={text}
          maxLength={120}
          required
          onChange={(event) => setText(event.target.value)}
        />
        <div className={styles.actions}>
          <button className="button primary" disabled={busy || !text.trim()} type="submit">
            {busy ? '正在执行…' : '运行接入示例'}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setResult(null);
              setError('');
              setRunId('');
              onResetTrace();
            }}
          >
            重置示例
          </button>
        </div>
      </form>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className={styles.result}>
          <strong>已完成：{result.characters} 个字符</strong>
          <p>{result.text}</p>
          <button
            className="text-button"
            type="button"
            onClick={() =>
              runtime.focusTrace({
                labId: runtime.identity.labId,
                runId,
                eventType: 'foundation/result',
              })
            }
          >
            定位本次结果记录
          </button>
        </div>
      )}
      <p className={styles.note}>此示例未使用 AG-UI、A2UI 或 MCP；它验证实验注册和公共运行接口。</p>
    </section>
  );
}
