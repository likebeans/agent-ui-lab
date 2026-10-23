import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react';
import {
  explainAguiFrame,
  changedStatePaths,
  experimentWithAguiEvent,
  type AguiFrame,
  type AguiRegion,
} from '../../shared/agui-learning';
import type { ChatTurnProps } from '../../shared/chat';
import type { AguiLabState } from '../../shared/agui';
import { errorMessage } from '../../shared/http';
import { STATIC_MODE } from '../../shared/runtime';
import { PredictionLesson } from './PredictionLesson';

export function AguiLearningPanel({
  frames,
  active,
  cursor,
  onCursor,
  region,
  onTrace,
  onInspectTrace,
}: {
  frames: AguiFrame[];
  active: boolean;
  cursor: number | null;
  onCursor: (value: number | null) => void;
  region: AguiRegion | null;
} & Pick<ChatTurnProps, 'onTrace' | 'onInspectTrace'>) {
  const [playing, setPlaying] = useState(false);
  const editorFrame = useRef<AguiFrame | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [experiment, setExperiment] = useState<ReturnType<typeof explainAguiFrame> | null>(null);
  const [preview, setPreview] = useState<AguiLabState | null>(null);
  const [error, setError] = useState('');
  const index = cursor === null ? frames.length - 1 : Math.min(cursor, frames.length - 1);
  const frame = frames[index];
  const detail = frame ? explainAguiFrame(frame) : null;
  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', stopWhenHidden);
    return () => document.removeEventListener('visibilitychange', stopWhenHidden);
  }, []);
  useEffect(() => {
    if (!active || editorFrame.current === frame) return;
    editorFrame.current = frame;
    setDraft(frame ? JSON.stringify(frame.event, null, 2) : '');
    setExperiment(null);
    setPreview(null);
    setError('');
  }, [active, frame]);
  useEffect(() => {
    if (!playing) return;
    if (!active || index >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => onCursor(index + 1), 800);
    return () => window.clearTimeout(timer);
  }, [playing, active, index, frames.length, onCursor]);

  function applyDraft() {
    if (!frame) return;
    try {
      if (draft.length > 20000) throw new Error('单条实验事件最多 20,000 字符。');
      const event = JSON.parse(draft);
      const after = experimentWithAguiEvent(frame, event);
      const next = explainAguiFrame({ event, before: frame.before, after });
      setExperiment(next);
      setPreview(after);
      setError('');
      onTrace({
        protocol: 'agui',
        direction: 'local',
        label: 'learning/agui-event',
        payload: { event, before: next.before, after: next.after },
        note: '本地 reducer 实验，不重新请求 Agent，不修改真实对话。',
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="learning-panel" aria-label="AG-UI 事件回放学习">
      <p className="hint">
        {STATIC_MODE ? '记录来自本轮浏览器内事件流，没有网络 SSE。' : '记录来自本轮真实 SSE。'}
        暂停只冻结上方界面，事件继续接收；回放不重新发请求，也不修改后续对话上下文。
      </p>
      <div className="learning-controls">
        <button
          type="button"
          disabled={!frames.length}
          onClick={() => {
            setPlaying(false);
            onCursor(cursor === null ? frames.length - 1 : null);
          }}
        >
          {cursor === null ? (
            <Pause size={14} aria-hidden="true" />
          ) : (
            <Play size={14} aria-hidden="true" />
          )}
          {cursor === null ? '暂停展示' : '回到实时'}
        </button>
        <button
          type="button"
          disabled={index <= 0}
          onClick={() => {
            setPlaying(false);
            onCursor(index - 1);
          }}
        >
          <SkipBack size={14} aria-hidden="true" />
          上一步
        </button>
        <button
          type="button"
          disabled={index >= frames.length - 1}
          onClick={() => {
            setPlaying(false);
            onCursor(index + 1);
          }}
        >
          <SkipForward size={14} aria-hidden="true" />
          下一步
        </button>
        <button
          type="button"
          disabled={!frames.length}
          onClick={() => {
            onCursor(0);
            setPlaying(false);
          }}
        >
          <RotateCcw size={14} aria-hidden="true" />
          从头回放
        </button>
        <button
          type="button"
          disabled={!frames.length}
          onClick={() => {
            if (playing) setPlaying(false);
            else {
              if (index >= frames.length - 1) onCursor(0);
              setPlaying(true);
            }
          }}
        >
          {playing ? '暂停回放' : '自动回放'}
        </button>
      </div>
      {frame && detail && (
        <>
          <label className="learning-field">
            事件位置 · {index + 1} / {frames.length}
            <input
              type="range"
              min="0"
              max={Math.max(0, frames.length - 1)}
              value={Math.max(0, index)}
              onChange={(event) => {
                setPlaying(false);
                onCursor(Number(event.target.value));
              }}
              aria-label="回放事件位置"
            />
          </label>
          <label className="learning-field">
            选择一条实际事件
            <select
              aria-label="选择回放事件"
              value={index}
              onChange={(event) => {
                setPlaying(false);
                onCursor(Number(event.target.value));
              }}
            >
              {frames.map((item, i) => (
                <option key={i} value={i}>
                  {i + 1}. {item.event.type}
                </option>
              ))}
            </select>
          </label>
          <div className="causal-evidence">
            <div className="learning-eyebrow">
              事件 → 状态 →{' '}
              {detail.region === 'text'
                ? '回复文字'
                : detail.region === 'tool'
                  ? '工具卡片'
                  : detail.region === 'state'
                    ? '任务与行程'
                    : '运行状态'}
            </div>
            <strong>{frame.event.type}</strong>
            <p>{detail.effect}</p>
            <ul className="changed-paths" aria-label="本事件改变的字段">
              {changedStatePaths(detail.before, detail.after).map((change) => (
                <li key={change.path}>
                  <code>{change.path}</code>
                  <span>
                    {JSON.stringify(change.before)} → {JSON.stringify(change.after)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="state-comparison">
              <div>
                <h4>更新前</h4>
                <pre>{JSON.stringify(detail.before, null, 2)}</pre>
              </div>
              <div>
                <h4>更新后</h4>
                <pre>{JSON.stringify(detail.after, null, 2)}</pre>
              </div>
            </div>
            <code className="source-location">{detail.source}</code>
            {onInspectTrace && (
              <button
                type="button"
                className="learning-link"
                onClick={() =>
                  onInspectTrace(
                    frame.event.type,
                    -frames.slice(index).filter((item) => item.event.type === frame.event.type)
                      .length,
                  )
                }
              >
                在检查器中定位 {frame.event.type}
              </button>
            )}
            {region && (
              <p className="hint">
                已从界面上的“追溯”入口选中关联事件；上方浅色边框标出它影响的区域。
              </p>
            )}
          </div>
          <details className="learning-experiment">
            <summary>改一条事件，试运行 reducer</summary>
            <p>
              例如选择 TEXT_MESSAGE_CONTENT，修改
              delta。结果仅在下面预览；真实记录与对话保持不变。校验失败时保留上次有效预览。
            </p>
            <label className="learning-field">
              实验事件 JSON
              <textarea
                aria-label="实验事件 JSON"
                value={draft}
                maxLength={20000}
                spellCheck={false}
                onFocus={() => {
                  setPlaying(false);
                  onCursor(index);
                }}
                onChange={(event) => setDraft(event.target.value)}
                rows={9}
              />
            </label>
            <div className="learning-actions">
              <button type="button" onClick={applyDraft}>
                验证并试运行事件
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(JSON.stringify(frame.event, null, 2));
                  setExperiment(null);
                  setPreview(null);
                  setError('');
                }}
              >
                恢复原事件
              </button>
            </div>
            {error && (
              <p className="error-banner" role="alert">
                事件被拒绝：{error}
              </p>
            )}
            {experiment && (
              <div className="experiment-result">
                <strong>本地试运行结果</strong>
                <p>{experiment.effect}</p>
                {preview && (
                  <div className="event-preview" aria-label="实验界面预览">
                    <div className="learning-eyebrow">实验界面预览 · 与真实对话隔离</div>
                    {experiment.region === 'text' && (
                      <p className="agent-prose">
                        {(experiment.after as { text?: string } | null)?.text || '空消息'}
                      </p>
                    )}
                    {experiment.region === 'tool' &&
                      preview.toolCalls.map((tool) => (
                        <div key={tool.id}>
                          <strong>{tool.name}</strong>
                          <p>
                            {tool.status === 'result'
                              ? '已返回结果'
                              : tool.status === 'called'
                                ? '执行中'
                                : '接收参数'}
                          </p>
                        </div>
                      ))}
                    {experiment.region === 'state' && preview.agentState && (
                      <>
                        <p>
                          {preview.agentState.city} · {preview.agentState.days} 天 ·{' '}
                          {preview.agentState.status}
                        </p>
                        <ul>
                          {preview.agentState.tasks.map((task) => (
                            <li key={task.id}>
                              {task.status === 'done' ? '已完成' : '待处理'} · {task.label}
                            </li>
                          ))}
                        </ul>
                        {preview.agentState.itinerary.map((day) => (
                          <p key={day}>{day}</p>
                        ))}
                      </>
                    )}
                    {experiment.region === 'lifecycle' && <p>phase: {preview.phase}</p>}
                  </div>
                )}
                <details>
                  <summary>实验状态 JSON</summary>
                  <pre>{JSON.stringify(experiment.after, null, 2)}</pre>
                </details>
              </div>
            )}
          </details>
        </>
      )}
      <PredictionLesson
        title="文本增量是追加还是替换？"
        question="对已有文字应用一条 TEXT_MESSAGE_CONTENT，新 delta 会怎样影响这条消息？"
        options={[
          { id: 'append', label: '追加到原有文字后面' },
          { id: 'replace', label: '替换原有文字' },
        ]}
        runLabel="用本轮事件验证"
        explanation="这里执行的是与聊天相同的 aguiReducer。文本增量按 messageId 追加；STATE_SNAPSHOT 则替换共享状态，两者语义不同。"
        onInspectTrace={onInspectTrace}
        runExperiment={async () => {
          const candidate = frames.find(
            (item) =>
              item.event.type === 'TEXT_MESSAGE_CONTENT' &&
              item.before.messages.some(
                (message) =>
                  'messageId' in item.event &&
                  message.id === item.event.messageId &&
                  message.text.length > 0,
              ),
          );
          if (!candidate || candidate.event.type !== 'TEXT_MESSAGE_CONTENT')
            throw new Error('先让本轮接收至少两条文本增量，再验证。');
          const event = candidate.event;
          const before = candidate.before.messages.find(
            (message) => message.id === event.messageId,
          )!.text;
          const after = experimentWithAguiEvent(candidate, event).messages.find(
            (message) => message.id === event.messageId,
          )!.text;
          const payload = {
            before,
            delta: event.delta,
            after,
            appended: after === before + event.delta,
          };
          onTrace({
            protocol: 'agui',
            direction: 'local',
            label: 'learning/agui-append',
            payload,
            note: '重新对记录状态执行真实 reducer；无 HTTP 请求。',
          });
          return {
            correctOptionId: payload.appended ? 'append' : 'replace',
            summary: `原文字“${before}”加上增量“${event.delta}”后，得到“${after}”。`,
            payload,
            traceLabel: 'learning/agui-append',
          };
        }}
      />
    </div>
  );
}
