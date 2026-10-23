import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Circle, RotateCcw } from 'lucide-react';
import { z } from 'zod';
import type { ChatTurnProps } from '../../shared/chat';
import { errorMessage } from '../../shared/http';
import { STATIC_MODE } from '../../shared/runtime';
import { readPointer, type JsonObject, type JsonValue } from '../../shared/json-pointer';
import {
  a2uiComponentSchema,
  jsonValueSchema,
  updateA2uiBinding,
  validateA2uiBindings,
  validateA2uiComponentGraph,
  type A2uiComponent,
  type A2uiSurface,
} from '../../shared/a2ui';
import { PredictionLesson } from './PredictionLesson';

const MAX_DRAFT_LENGTH = 30_000;

type WorkshopDocument = {
  components: A2uiComponent[];
  model: JsonObject;
};

type PresetName = 'layout-reference' | 'broken-binding' | 'budget-field';

export interface A2uiActionEvidence {
  actionName: string;
  sourceComponentId: string;
  context: Record<string, JsonValue>;
  status: string;
  submittedSurface: A2uiSurface;
}

interface BudgetInspection {
  draftValid: boolean;
  componentBound: boolean;
  includedInLayout: boolean;
  modelValueBound: boolean;
  actionContextBound: boolean;
  budgetValue?: string;
}

interface A2uiWorkshopProps extends Pick<ChatTurnProps, 'onTrace' | 'onInspectTrace'> {
  initialSurface: A2uiSurface;
  surface: A2uiSurface;
  disabled: boolean;
  actionEvidence: A2uiActionEvidence | null;
  onCommit: (surface: A2uiSurface) => void;
  onReset: (surface: A2uiSurface) => void;
}

function cloneSurface(surface: A2uiSurface): A2uiSurface {
  return structuredClone(surface);
}

function documentFromSurface(surface: A2uiSurface): WorkshopDocument {
  return {
    components: structuredClone(Object.values(surface.components)),
    model: structuredClone(surface.model),
  };
}

function serializeDocument(document: WorkshopDocument): string {
  return JSON.stringify(document, null, 2);
}

function serializeSurface(surface: A2uiSurface): string {
  return serializeDocument(documentFromSurface(surface));
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseWorkshopDraft(draft: string, base: A2uiSurface): A2uiSurface {
  if (draft.length > MAX_DRAFT_LENGTH) {
    throw new Error(`Workshop JSON 最多 ${MAX_DRAFT_LENGTH.toLocaleString()} 个字符。`);
  }

  const input: unknown = JSON.parse(draft);
  if (input === null || Array.isArray(input) || typeof input !== 'object') {
    throw new Error('Workshop JSON 必须是包含 components 与 model 的对象。');
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'components' || keys[1] !== 'model') {
    throw new Error('Workshop JSON 只能包含 components 与 model。');
  }

  const components = a2uiComponentSchema.array().max(200).parse(record.components);
  const parsedModel = jsonValueSchema.parse(record.model);
  if (!isJsonObject(parsedModel)) throw new Error('model 必须是 JSON 对象。');

  const componentMap: Record<string, A2uiComponent> = {};
  for (const component of components) {
    if (Object.hasOwn(componentMap, component.id)) {
      throw new Error(`组件 ID 重复：${component.id}`);
    }
    componentMap[component.id] = structuredClone(component);
  }

  validateA2uiComponentGraph(componentMap);
  const next: A2uiSurface = {
    surfaceId: base.surfaceId,
    catalogId: base.catalogId,
    components: componentMap,
    model: structuredClone(parsedModel),
  };
  validateA2uiBindings(next);
  return next;
}

function readableError(cause: unknown): string {
  if (cause instanceof z.ZodError) {
    return cause.issues[0]?.message ?? 'JSON 不符合 A2UI schema。';
  }
  return errorMessage(cause);
}

function formModel(document: WorkshopDocument): JsonObject {
  const value = document.model.form;
  if (!isJsonObject(value)) throw new Error('初始 Surface 缺少 form 数据对象。');
  return value;
}

function presetDocument(name: PresetName, initialSurface: A2uiSurface): WorkshopDocument {
  const document = documentFromSurface(initialSurface);
  const form = document.components.find((component) => component.id === 'form');
  if (!form || form.component !== 'Column') throw new Error('初始 Surface 缺少 form Column。');

  if (name === 'layout-reference') {
    form.children = form.children.filter((id) => id !== 'traveler');
    return document;
  }

  const days = document.components.find((component) => component.id === 'days');
  if (name === 'broken-binding') {
    if (!days || days.component !== 'TextField') {
      throw new Error('初始 Surface 缺少 days TextField。');
    }
    days.value = { path: '/form/notARealField' };
    return document;
  }

  const budget: A2uiComponent = {
    id: 'budget',
    component: 'TextField',
    label: '预算（元）',
    value: { path: '/form/budget' },
  };
  const existingBudget = document.components.findIndex((component) => component.id === 'budget');
  if (existingBudget >= 0) document.components[existingBudget] = budget;
  else document.components.push(budget);

  formModel(document).budget = '3000';
  if (!form.children.includes('budget')) {
    const submitIndex = form.children.indexOf('submit');
    form.children.splice(submitIndex < 0 ? form.children.length : submitIndex, 0, 'budget');
  }

  const submit = document.components.find((component) => component.id === 'submit');
  if (!submit || submit.component !== 'Button') {
    throw new Error('初始 Surface 缺少 submit Button。');
  }
  submit.action.event.context.budget = { path: '/form/budget' };
  return document;
}

function inspectBudgetSurface(surface: A2uiSurface): BudgetInspection {
  const budget = surface.components.budget;
  const form = surface.components.form;
  const submit = surface.components.submit;
  const budgetValue = readPointer(surface.model, '/form/budget');
  return {
    draftValid: true,
    componentBound: budget?.component === 'TextField' && budget.value.path === '/form/budget',
    includedInLayout: form?.component === 'Column' && form.children.includes('budget'),
    modelValueBound: typeof budgetValue === 'string' && budgetValue.trim().length > 0,
    actionContextBound:
      submit?.component === 'Button' && submit.action.event.context.budget?.path === '/form/budget',
    ...(typeof budgetValue === 'string' ? { budgetValue } : {}),
  };
}

function inspectBudgetDraft(draft: string, base: A2uiSurface): BudgetInspection {
  try {
    return inspectBudgetSurface(parseWorkshopDraft(draft, base));
  } catch {
    return {
      draftValid: false,
      componentBound: false,
      includedInLayout: false,
      modelValueBound: false,
      actionContextBound: false,
    };
  }
}

function completeBudgetStructure(inspection: BudgetInspection): boolean {
  return (
    inspection.draftValid &&
    inspection.componentBound &&
    inspection.includedInLayout &&
    inspection.modelValueBound &&
    inspection.actionContextBound
  );
}

export function A2uiWorkshop({
  initialSurface,
  surface,
  disabled,
  actionEvidence,
  onCommit,
  onReset,
  onTrace,
  onInspectTrace,
}: A2uiWorkshopProps) {
  const initial = useRef(cloneSurface(initialSurface));
  const current = useRef(surface);
  const mounted = useRef(true);
  const generation = useRef(0);
  const dirty = useRef(false);
  const callbacks = useRef({ onCommit, onReset, onTrace });
  const [draft, setDraft] = useState(() => serializeSurface(initial.current));
  const [validationError, setValidationError] = useState('');
  const [result, setResult] = useState('');
  const [lessonVersion, setLessonVersion] = useState(0);
  callbacks.current = { onCommit, onReset, onTrace };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  useEffect(() => {
    current.current = surface;
    if (!dirty.current) setDraft(serializeSurface(surface));
  }, [surface]);

  const applyDraft = useCallback(() => {
    if (disabled || !mounted.current) return;
    try {
      const next = parseWorkshopDraft(draft, current.current);
      if (!mounted.current) return;
      current.current = next;
      dirty.current = false;
      setDraft(serializeSurface(next));
      setValidationError('');
      setResult('草稿已通过 schema、引用图与绑定校验，并提交给上方同一个 renderer。');
      callbacks.current.onCommit(next);
      callbacks.current.onTrace({
        protocol: 'a2ui',
        direction: 'local',
        label: 'learning/a2ui-validation',
        payload: {
          accepted: true,
          componentIds: Object.keys(next.components),
          model: next.model,
        },
        note: '本地事务校验成功后才替换真实 Surface；没有发送 HTTP 请求。',
      });
    } catch (cause) {
      if (!mounted.current) return;
      const message = readableError(cause);
      setValidationError(message);
      setResult('');
      callbacks.current.onTrace({
        protocol: 'a2ui',
        direction: 'local',
        label: 'learning/a2ui-validation',
        payload: { accepted: false, message, draftLength: draft.length },
        note: '草稿在本地被拒绝；renderer 继续使用上一份有效 Surface。',
      });
    }
  }, [disabled, draft]);

  const loadPreset = useCallback((name: PresetName) => {
    if (!mounted.current) return;
    try {
      const nextDraft = serializeDocument(presetDocument(name, initial.current));
      dirty.current = true;
      setDraft(nextDraft);
      setValidationError('');
      setResult('预设只写入编辑器；点击“验证并应用”后才会影响 renderer。');
      callbacks.current.onTrace({
        protocol: 'a2ui',
        direction: 'local',
        label: 'learning/a2ui-preset',
        payload: { preset: name, committed: false },
        note: '预设从本轮最初收到的 Surface 生成，只更新有界 JSON 草稿。',
      });
    } catch (cause) {
      setValidationError(readableError(cause));
    }
  }, []);

  const reset = useCallback(() => {
    if (disabled || !mounted.current) return;
    generation.current += 1;
    const next = cloneSurface(initial.current);
    current.current = next;
    dirty.current = false;
    setDraft(serializeSurface(next));
    setValidationError('');
    setResult('已恢复本轮最初接收的声明与数据模型。');
    setLessonVersion((version) => version + 1);
    callbacks.current.onReset(next);
    callbacks.current.onTrace({
      protocol: 'a2ui',
      direction: 'local',
      label: 'learning/a2ui-reset',
      payload: {
        surfaceId: next.surfaceId,
        componentIds: Object.keys(next.components),
        model: next.model,
      },
      note: '重置到本轮服务端最初下发的声明与模型；旧本地实验结果已失效。',
    });
  }, [disabled]);

  const runBindingExperiment = useCallback(async () => {
    if (disabled) throw new Error('动作提交期间不能运行本地绑定实验。');
    const experimentGeneration = generation.current;
    const beforeSurface = current.current;
    const field =
      beforeSurface.components.days?.component === 'TextField'
        ? beforeSurface.components.days
        : Object.values(beforeSurface.components).find(
            (component): component is Extract<A2uiComponent, { component: 'TextField' }> =>
              component.component === 'TextField',
          );
    if (!field) throw new Error('当前 Surface 没有可实验的 TextField 绑定。');
    const beforeValue = readPointer(beforeSurface.model, field.value.path);
    if (typeof beforeValue !== 'string') throw new Error('所选绑定当前不是字符串。');
    const afterValue =
      field.id === 'days' ? (beforeValue === '3' ? '4' : '3') : `${beforeValue}（实验）`;
    const beforeModel = structuredClone(beforeSurface.model);
    const beforeComponents = structuredClone(beforeSurface.components);
    const next = updateA2uiBinding(beforeSurface, field.value.path, afterValue);
    const componentsUnchanged =
      JSON.stringify(beforeComponents) === JSON.stringify(next.components);

    if (!mounted.current || experimentGeneration !== generation.current) {
      throw new Error('实验已重置，本次结果未写入。');
    }
    current.current = next;
    dirty.current = false;
    setDraft(serializeSurface(next));
    setValidationError('');
    setResult(`已把 ${field.value.path} 从“${beforeValue}”改为“${afterValue}”。`);
    callbacks.current.onCommit(next);
    const payload = {
      path: field.value.path,
      beforeValue,
      afterValue,
      beforeModel,
      afterModel: next.model,
      componentsUnchanged,
      httpRequest: false,
    };
    callbacks.current.onTrace({
      protocol: 'a2ui',
      direction: 'local',
      label: 'learning/a2ui-binding',
      payload,
      note: '直接运行真实 updateA2uiBinding；只改本轮内存模型，不发业务 HTTP 请求。',
    });
    return {
      correctOptionId: componentsUnchanged ? 'model-only' : 'declaration-too',
      summary: `${field.value.path} 的值从“${beforeValue}”变为“${afterValue}”；组件声明${componentsUnchanged ? '保持不变' : '也发生了变化'}。`,
      payload,
      traceLabel: 'learning/a2ui-binding',
    };
  }, [disabled]);

  const draftInspection = inspectBudgetDraft(draft, current.current);
  const draftReady = completeBudgetStructure(draftInspection);
  const submittedInspection = actionEvidence
    ? inspectBudgetSurface(actionEvidence.submittedSurface)
    : null;
  const actionBudget = actionEvidence?.context.budget;
  const actionVerified = Boolean(
    actionEvidence &&
    draftReady &&
    submittedInspection &&
    completeBudgetStructure(submittedInspection) &&
    actionEvidence.actionName === 'save_trip' &&
    actionEvidence.sourceComponentId === 'submit' &&
    typeof actionBudget === 'string' &&
    actionBudget === draftInspection.budgetValue &&
    actionBudget === submittedInspection.budgetValue,
  );
  const statusVerified = Boolean(
    actionVerified &&
    typeof actionBudget === 'string' &&
    actionEvidence?.status.includes(`预算 ${actionBudget} 元`),
  );

  return (
    <details className="learning-experiment" aria-label="A2UI 声明 Workshop">
      <summary>A2UI Workshop：改声明，观察同一个 renderer</summary>
      <p>
        编辑对象只允许 <code>components</code> 与 <code>model</code>。应用前依次运行现有
        schema、引用图和绑定校验；失败时上方界面保留上一份有效状态。
      </p>

      <div className="learning-controls" aria-label="A2UI Workshop 预设">
        <span>从初始 Surface 载入：</span>
        <button type="button" disabled={disabled} onClick={() => loadPreset('layout-reference')}>
          布局引用移除（保留定义）
        </button>
        <button type="button" disabled={disabled} onClick={() => loadPreset('broken-binding')}>
          错误绑定路径（应拒绝）
        </button>
        <button type="button" disabled={disabled} onClick={() => loadPreset('budget-field')}>
          预算字段 + action.context
        </button>
      </div>

      <label className="learning-field">
        Surface 草稿 JSON
        <textarea
          aria-label="A2UI Surface 草稿 JSON"
          value={draft}
          maxLength={MAX_DRAFT_LENGTH}
          rows={14}
          spellCheck={false}
          onChange={(event) => {
            dirty.current = true;
            setDraft(event.target.value);
            setValidationError('');
            setResult('');
          }}
        />
      </label>
      <div className="learning-actions">
        <button type="button" disabled={disabled} onClick={applyDraft}>
          验证并应用到真实界面
        </button>
        <button type="button" disabled={disabled} onClick={reset}>
          <RotateCcw size={13} aria-hidden="true" />
          重置为初始声明与模型
        </button>
      </div>
      {validationError && (
        <p className="error-banner" role="alert">
          <AlertCircle size={14} aria-hidden="true" /> 草稿被拒绝：{validationError}
        </p>
      )}
      {result && (
        <p className="experiment-result" role="status">
          {result}
        </p>
      )}

      <div className="causal-evidence" aria-label="预算字段练习验证">
        <div className="learning-eyebrow">
          结构证据 → 真实 action → {STATIC_MODE ? '浏览器内处理结果' : '服务端回显'}
        </div>
        <strong>练习：让预算从声明进入动作闭环</strong>
        <div className="task-list">
          <EvidenceCheck passed={draftInspection.draftValid}>当前草稿通过严格校验</EvidenceCheck>
          <EvidenceCheck
            passed={draftInspection.componentBound && draftInspection.includedInLayout}
          >
            budget TextField 已绑定 /form/budget 并进入 form 布局
          </EvidenceCheck>
          <EvidenceCheck passed={draftInspection.modelValueBound}>
            model 中存在非空预算值
          </EvidenceCheck>
          <EvidenceCheck passed={draftInspection.actionContextBound}>
            submit.action.event.context 引用了预算路径
          </EvidenceCheck>
          <EvidenceCheck passed={actionVerified}>
            {`${STATIC_MODE ? '浏览器内 action 处理器' : '真实 /api/a2ui/action'}收到同一预算值`}
          </EvidenceCheck>
          <EvidenceCheck passed={statusVerified}>
            {`${STATIC_MODE ? '浏览器内更新消息' : '服务端状态'}回显该预算`}
          </EvidenceCheck>
        </div>
        <p>
          {statusVerified
            ? `已完成：action.context.budget 与状态中的“预算 ${String(actionBudget)} 元”一致。`
            : draftReady
              ? '结构已就绪。先应用草稿，在真实表单填写姓名，再点击“生成计划”完成端点验证。'
              : '可手动编辑或载入预算预设；判定来自当前 JSON 结构和真实动作证据，不来自预设按钮。'}
        </p>
      </div>

      <PredictionLesson
        key={lessonVersion}
        title="本地绑定会改组件声明吗？"
        question="把一个 TextField 的绑定值写成新字符串后，哪一部分会变化？"
        options={[
          { id: 'model-only', label: '只更新数据模型，组件声明不变' },
          { id: 'declaration-too', label: '数据模型和组件声明都会变化' },
        ]}
        explanation="双向绑定把声明中的 path 当作地址。updateA2uiBinding 会校验并生成新 model；声明仍是同一组目录组件。"
        runLabel="运行本地绑定实验"
        disabled={disabled}
        runExperiment={runBindingExperiment}
        onInspectTrace={onInspectTrace}
      />
    </details>
  );
}

function EvidenceCheck({ passed, children }: { passed: boolean; children: string }) {
  return (
    <div className={`task-item ${passed ? 'done' : ''}`}>
      {passed ? (
        <CheckCircle2 size={14} aria-hidden="true" />
      ) : (
        <Circle size={14} aria-hidden="true" />
      )}
      <span>{children}</span>
    </div>
  );
}
