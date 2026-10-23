import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, FlaskConical, LoaderCircle, RotateCcw } from 'lucide-react';
import { errorMessage } from '../../shared/http';

export interface ExperimentEvidence {
  correctOptionId: string;
  summary: string;
  payload: unknown;
  traceLabel?: string;
}

export interface PredictionLessonProps {
  title: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  explanation: string;
  runLabel: string;
  disabled?: boolean;
  runExperiment: () => Promise<ExperimentEvidence>;
  onInspectTrace?: (label: string) => void;
}

export function PredictionLesson({
  title,
  question,
  options,
  explanation,
  runLabel,
  disabled = false,
  runExperiment,
  onInspectTrace,
}: PredictionLessonProps) {
  const radioGroup = useId();
  const [choice, setChoice] = useState('');
  const [prediction, setPrediction] = useState('');
  const [result, setResult] = useState<ExperimentEvidence | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run() {
    if (!choice || disabled || lock.current) return;
    lock.current = true;
    setPrediction(choice);
    setResult(null);
    setRunning(true);
    setError('');
    try {
      const evidence = await runExperiment();
      if (!options.some((option) => option.id === evidence.correctOptionId)) {
        throw new Error('实验结果不属于当前题目的选项。');
      }
      if (mounted.current) setResult(evidence);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (mounted.current) setRunning(false);
    }
  }

  return (
    <section className="prediction-lesson" aria-label={title}>
      <div className="learning-eyebrow">
        <FlaskConical size={15} aria-hidden="true" />
        先预测，再验证
      </div>
      <h3>{title}</h3>
      <p className="hint">选一个预测，再执行实际操作；反馈会附上本次结果。</p>
      <fieldset disabled={disabled || running || result !== null}>
        <legend>{question}</legend>
        {options.map((option) => (
          <label key={option.id} className="prediction-option">
            <input
              type="radio"
              name={radioGroup}
              value={option.id}
              checked={choice === option.id}
              onChange={() => setChoice(option.id)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      {!result && (
        <button
          className="button secondary"
          type="button"
          disabled={disabled || !choice || running}
          onClick={() => void run()}
        >
          {running ? (
            <LoaderCircle className="spinner" size={14} aria-hidden="true" />
          ) : (
            <FlaskConical size={14} aria-hidden="true" />
          )}
          {running ? '正在执行实验…' : runLabel}
        </button>
      )}
      {error && (
        <p className="error-banner" role="alert">
          实验未完成：{error}。可以重试；本次不判分。
        </p>
      )}
      {result && (
        <div className="prediction-result" role="status">
          <strong>
            <CheckCircle2 size={15} aria-hidden="true" />
            {prediction === result.correctOptionId
              ? '预测与实际结果一致'
              : '实际结果与你的预测不同'}
          </strong>
          <p>{result.summary}</p>
          <p>{explanation}</p>
          <details>
            <summary>查看本次实验的证据</summary>
            <pre>{JSON.stringify(result.payload, null, 2)}</pre>
          </details>
          <div className="learning-actions">
            {result.traceLabel && onInspectTrace && (
              <button type="button" onClick={() => onInspectTrace(result.traceLabel!)}>
                定位本次协议记录
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setResult(null);
                setChoice('');
                setError('');
              }}
            >
              <RotateCcw size={13} aria-hidden="true" />
              重新预测
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
