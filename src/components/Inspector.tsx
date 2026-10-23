import { useEffect, useRef, useState } from 'react';
import { Braces, Check, Copy, Download, Radio, Search, Trash2 } from 'lucide-react';
import type { TraceEntry } from '../../shared/trace';
import { STATIC_MODE } from '../../shared/runtime';

export function Inspector({
  entries,
  onClear,
  focusRequest,
}: {
  entries: TraceEntry[];
  onClear: () => void;
  focusRequest?: { label: string; occurrence?: number; token: number };
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [copyError, setCopyError] = useState('');
  const [focusNotice, setFocusNotice] = useState('');
  const handledFocus = useRef<number | null>(null);
  const selectedRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusRequest || handledFocus.current === focusRequest.token) return;
    const candidates = entries.filter((entry) => entry.label === focusRequest.label);
    const target = candidates.at(focusRequest.occurrence ?? -1);
    if (!target) {
      setFocusNotice('关联记录尚未到达，或已从本轮检查器中清除。');
      return;
    }
    handledFocus.current = focusRequest.token;
    setFocusNotice('');
    setQuery('');
    setSelected(target.id);
    setCopiedId(null);
  }, [focusRequest, entries]);
  useEffect(() => {
    if (focusRequest && selected !== null)
      selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, focusRequest]);
  const filtered = entries.filter((entry) =>
    `${entry.label} ${entry.direction}`.toLowerCase().includes(query.toLowerCase()),
  );
  const current = filtered.find((entry) => entry.id === selected) ?? filtered.at(-1);
  const copied = current !== undefined && copiedId === current.id;

  function download() {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `intelligent-ui-trace-${new Date().toISOString().replaceAll(':', '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copy() {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(current.payload, null, 2));
      setCopiedId(current.id);
      setCopyError('');
    } catch {
      setCopyError('浏览器未允许复制，可以使用导出按钮保存。');
    }
  }

  return (
    <aside className="inspector" aria-label="协议检查器">
      <div className="panel-heading">
        <span>
          <Radio size={16} aria-hidden="true" /> 协议检查器{' '}
          <span className="count">{entries.length}</span>
        </span>
        <div className="icon-actions">
          <button
            className="icon-button"
            disabled={!entries.length}
            onClick={download}
            aria-label="导出协议消息"
            title="导出 JSON"
          >
            <Download size={15} />
          </button>
          <button
            className="icon-button"
            disabled={!entries.length}
            onClick={() => {
              onClear();
              setSelected(null);
              setFocusNotice('');
              handledFocus.current = focusRequest?.token ?? null;
            }}
            aria-label="清空协议消息"
            title="清空"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <label className="trace-search">
        <Search size={14} aria-hidden="true" />
        <input
          aria-label="筛选协议消息"
          placeholder="筛选事件或方向…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="trace-list" aria-label="协议消息列表">
        {filtered.length === 0 ? (
          <div className="trace-empty">
            <Braces size={28} strokeWidth={1.3} aria-hidden="true" />
            <strong>{query ? '没有匹配的消息' : '每一次交互，都有迹可循'}</strong>
            <p>
              {query
                ? '试试其他事件名称。'
                : STATIC_MODE
                  ? '在对话或实验中发起操作，查看浏览器内协议消息与 iframe 通信。'
                  : '在对话或实验中发起操作，查看真实传输的协议消息。'}
            </p>
            <code>waiting for events…</code>
          </div>
        ) : (
          filtered.map((entry, index) => (
            <button
              key={entry.id}
              ref={entry.id === selected ? selectedRow : undefined}
              className={`trace-row ${entry.id === current?.id ? 'selected' : ''}`}
              onClick={() => {
                setSelected(entry.id);
                setCopiedId(null);
              }}
              aria-pressed={entry.id === current?.id}
            >
              <span className="trace-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="trace-row-content">
                <strong>{entry.label}</strong>
                <span>
                  {entry.direction}
                  {entry.transport === 'browser-memory' && ' · 浏览器内'}
                </span>
              </span>
              <span className="trace-time">
                +{((entry.time - (entries[0]?.time ?? entry.time)) / 1000).toFixed(1)}s
              </span>
            </button>
          ))
        )}
      </div>
      <div className="payload-heading">
        <span>
          RAW PAYLOAD <span>JSON</span>
        </span>
        <button
          className="icon-button"
          disabled={!current}
          onClick={copy}
          aria-label={copied ? '已复制消息' : '复制当前消息'}
          title={copied ? '已复制' : '复制 JSON'}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="payload">
        <code>
          {current
            ? JSON.stringify(current.payload, null, 2)
            : '{\n  "status": "ready",\n  "hint": "发送消息或开始实验"\n}'}
        </code>
      </pre>
      <p className="inspector-note">
        {current?.transport === 'browser-memory' && '浏览器内演示：逻辑路由标签不表示 HTTP 请求。'}
        {copyError ||
          focusNotice ||
          current?.note ||
          '点击任意消息，查看完整载荷。最近 300 条消息保留在内存中。'}
      </p>
    </aside>
  );
}
