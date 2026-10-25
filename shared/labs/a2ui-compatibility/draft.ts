import {
  A2UI_BASIC_CATALOG_ID,
  a2uiMessagesSchema,
  applyA2uiMessages,
  jsonValueSchema,
  normalizeA2uiPath,
  resolveA2uiAction,
  validateA2uiBindings,
  validateA2uiComponentGraph,
  type A2uiComponent,
  type A2uiSurface,
} from '../../a2ui';
import {
  pointerSegments,
  readPointer,
  writePointer,
  type JsonObject,
  type JsonValue,
} from '../../json-pointer';
import type {
  ActionEnvelope,
  ClientCapabilities,
  CompatibilityResult,
  CompatibilitySnapshot,
  DraftConflict,
  DraftState,
  FieldIssue,
  FieldRule,
} from './contract';

export const DEFAULT_CAPABILITIES: ClientCapabilities = Object.freeze({
  catalogIds: Object.freeze([A2UI_BASIC_CATALOG_ID]),
  components: Object.freeze([
    'Card',
    'Column',
    'Text',
    'TextField',
    'ChoicePicker',
    'Button',
  ] as const),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function checkCompatibility(
  snapshot: CompatibilitySnapshot,
  capabilities: ClientCapabilities = DEFAULT_CAPABILITIES,
): CompatibilityResult {
  const reasons = new Set<string>();
  const fallback = (): CompatibilityResult => ({
    status: 'fallback',
    reasons: [...reasons],
    text: snapshot.fallbackText,
  });

  // Catalog identifiers are allowlist keys, never URLs to fetch or execute.
  if (!Array.isArray(snapshot.messages)) {
    reasons.add('A2UI 消息必须是数组。');
    return fallback();
  }
  for (const message of snapshot.messages) {
    if (!isRecord(message)) continue;
    if (isRecord(message.createSurface)) {
      const catalogId = message.createSurface.catalogId;
      if (catalogId !== A2UI_BASIC_CATALOG_ID || !capabilities.catalogIds.includes(catalogId)) {
        reasons.add(`不支持的 catalog：${String(catalogId)}。`);
      }
    }
    if (isRecord(message.updateComponents) && Array.isArray(message.updateComponents.components)) {
      for (const component of message.updateComponents.components) {
        const type = isRecord(component) ? component.component : undefined;
        if (
          !DEFAULT_CAPABILITIES.components.some((supported) => supported === type) ||
          !capabilities.components.some((supported) => supported === type)
        ) {
          reasons.add(`不支持的组件：${String(type)}。`);
        }
      }
    }
  }
  if (reasons.size > 0) return fallback();

  try {
    const messages = a2uiMessagesSchema.parse(snapshot.messages);
    const surface = applyA2uiMessages(null, messages);
    if (!surface || surface.surfaceId !== snapshot.surfaceId) {
      throw new Error('快照没有当前 Surface 的完整消息。');
    }
    validateA2uiComponentGraph(surface.components);
    validateA2uiBindings(surface);
    return { status: 'ready', surface };
  } catch (error) {
    reasons.add(error instanceof Error ? error.message : 'A2UI 消息无效。');
    return fallback();
  }
}

type EditableComponent = Extract<A2uiComponent, { component: 'TextField' | 'ChoicePicker' }>;

function editable(component: A2uiComponent | undefined): component is EditableComponent {
  return component?.component === 'TextField' || component?.component === 'ChoicePicker';
}

export function validateFields(
  surface: A2uiSurface,
  rules: readonly FieldRule[],
  layer: FieldIssue['layer'] = 'client',
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const rule of rules) {
    const component = surface.components[rule.componentId];
    let message: string | undefined;
    if (!editable(component) || component.value.path !== rule.path) {
      message = `${rule.label}的字段绑定已变化。`;
    } else {
      const value = readPointer(surface.model, normalizeA2uiPath(rule.path));
      if (component.component === 'ChoicePicker') {
        if (
          !Array.isArray(value) ||
          value.length > 1 ||
          !value.every(
            (item) =>
              typeof item === 'string' && component.options.some((option) => option.value === item),
          )
        ) {
          message = `${rule.label}必须选择一个受支持的选项。`;
        } else if (rule.required && value.length === 0) {
          message = `请选择${rule.label}。`;
        }
      } else if (typeof value !== 'string') {
        message = `${rule.label}必须是文本。`;
      } else if (rule.required && value.trim().length === 0) {
        message = `请填写${rule.label}。`;
      } else if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        message = `${rule.label}最多 ${rule.maxLength} 个字符。`;
      } else if (rule.integer && (rule.required || value.length > 0)) {
        const number = Number(value);
        if (
          !/^-?(?:0|[1-9]\d*)$/u.test(value) ||
          value.trim() !== value ||
          !Number.isSafeInteger(number) ||
          number < rule.integer.min ||
          number > rule.integer.max
        ) {
          message = `${rule.label}必须是 ${rule.integer.min} 到 ${rule.integer.max} 的整数。`;
        }
      }
    }
    if (message) issues.push({ componentId: rule.componentId, path: rule.path, message, layer });
  }
  return issues;
}

function compatibleSurface(
  snapshot: CompatibilitySnapshot,
  capabilities: ClientCapabilities,
): A2uiSurface {
  const result = checkCompatibility(snapshot, capabilities);
  if (result.status === 'fallback') {
    throw new Error(`${result.text}\n${result.reasons.join('\n')}`);
  }
  return result.surface;
}

export function createDraft(
  snapshot: CompatibilitySnapshot,
  capabilities: ClientCapabilities = DEFAULT_CAPABILITIES,
): DraftState {
  const base = compatibleSurface(snapshot, capabilities);
  return {
    snapshot: structuredClone(snapshot),
    base,
    surface: structuredClone(base),
    conflicts: [],
  };
}

export function trackDraftSubmission(state: DraftState, submitted: A2uiSurface): DraftState {
  const edits = new Set(state.unconfirmedEdits);
  for (const component of Object.values(state.surface.components)) {
    if (!editable(component)) continue;
    const previous = submitted.components[component.id];
    if (
      !editable(previous) ||
      previous.value.path !== component.value.path ||
      !equalValue(
        readPointer(submitted.model, normalizeA2uiPath(previous.value.path)),
        readPointer(state.surface.model, normalizeA2uiPath(component.value.path)),
      )
    ) {
      edits.add(component.id);
    }
  }
  // Keep an empty list too: edits made after a lost reply still need protection.
  return { ...state, unconfirmedEdits: [...edits] };
}

export function updateDraft(state: DraftState, path: string, value: JsonValue): DraftState {
  const bound = Object.values(state.surface.components).some(
    (component) => editable(component) && component.value.path === path,
  );
  const historic = !bound && canMirrorHistoricValue(state.base, path);
  if (!bound && !(historic && state.conflicts.some((conflict) => conflict.path === path))) {
    throw new Error(`路径不是可编辑字段：${path}`);
  }
  const nextValue = jsonValueSchema.parse(value);
  let model = bound
    ? writePointer(state.surface.model, normalizeA2uiPath(path), nextValue)
    : state.surface.model;
  const conflicts = state.conflicts.map((conflict) => {
    const component = state.surface.components[conflict.componentId];
    const currentPath = editable(component) ? component.value.path : undefined;
    if (bound ? currentPath !== path : conflict.path !== path) return conflict;
    if (currentPath) model = setValue(model, currentPath, nextValue);
    // Historic conflict paths are identities, not aliases for newly bound fields.
    if (canMirrorHistoricValue(state.base, conflict.path)) {
      model = setValue(model, conflict.path, nextValue);
    }
    return { ...conflict, local: structuredClone(nextValue) };
  });
  const unconfirmedEdits = state.unconfirmedEdits
    ? [
        ...new Set([
          ...state.unconfirmedEdits,
          ...Object.values(state.surface.components)
            .filter((component) => editable(component) && component.value.path === path)
            .map((component) => component.id),
        ]),
      ]
    : undefined;
  return { ...state, surface: { ...state.surface, model }, conflicts, unconfirmedEdits };
}

function equalValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalValue(value, right[index]))
    );
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalValue(left[key], right[key]))
  );
}

// Restoring a removed binding must remove the local value, not write undefined into JSON.
function setValue(model: JsonObject, path: string, value: JsonValue | undefined): JsonObject {
  const normalized = normalizeA2uiPath(path);
  if (value !== undefined) return writePointer(model, normalized, value);
  const result = structuredClone(model);
  const segments = pointerSegments(normalized);
  let target: JsonValue = result;
  for (const segment of segments.slice(0, -1)) {
    if (target === null || typeof target !== 'object' || !Object.hasOwn(target, segment)) {
      return result;
    }
    target = (target as JsonObject)[segment];
  }
  if (target !== null && typeof target === 'object' && segments.length > 0) {
    if (Array.isArray(target)) {
      const index = Number(segments.at(-1));
      if (Number.isInteger(index) && index >= 0 && index < target.length) target.splice(index, 1);
    } else {
      delete target[segments.at(-1)!];
    }
  }
  return result;
}

// Mirror a historic value only into a wholly unclaimed model location. An existing
// value (including an object), or a scalar/array ancestor, belongs to the new snapshot.
function canMirrorHistoricValue(base: A2uiSurface, path: string): boolean {
  const segments = pointerSegments(normalizeA2uiPath(path));
  for (const component of Object.values(base.components)) {
    const bindings = editable(component)
      ? [component.value]
      : component.component === 'Button'
        ? Object.values(component.action.event.context)
        : component.component === 'Text' && typeof component.text !== 'string'
          ? [component.text]
          : [];
    if (
      bindings.some((binding) => {
        const bound = pointerSegments(normalizeA2uiPath(binding.path));
        return segments
          .slice(0, Math.min(segments.length, bound.length))
          .every((segment, index) => segment === bound[index]);
      })
    ) {
      return false;
    }
  }
  let target: JsonValue = base.model;
  for (const segment of segments) {
    if (target === null || Array.isArray(target) || typeof target !== 'object') return false;
    if (!Object.hasOwn(target, segment)) return true;
    target = target[segment];
  }
  return false;
}

export function rebaseDraft(
  state: DraftState,
  snapshot: CompatibilitySnapshot,
  capabilities: ClientCapabilities = DEFAULT_CAPABILITIES,
): DraftState {
  if (snapshot.documentId !== state.snapshot.documentId) {
    throw new Error('不能将其他文档的快照合并到当前草稿。');
  }
  // Delayed responses, including duplicate replies, cannot roll back accepted authority.
  if (snapshot.revision <= state.snapshot.revision) return state;
  const base = compatibleSurface(snapshot, capabilities);
  let model = structuredClone(base.model);
  const conflicts: DraftConflict[] = [];
  const retainedValues: NonNullable<DraftState['retainedValues']> = [];
  const candidates = new Map<string, DraftConflict>();

  for (const retained of state.retainedValues ?? []) {
    const component = base.components[retained.componentId];
    if (editable(component)) {
      candidates.set(retained.componentId, {
        componentId: retained.componentId,
        path: retained.path,
        label: component.label,
        base: undefined,
        local: retained.value,
        remote: undefined,
      });
    } else {
      retainedValues.push(structuredClone(retained));
      if (canMirrorHistoricValue(base, retained.path)) {
        model = setValue(model, retained.path, retained.value);
      }
    }
  }

  for (const component of Object.values(state.base.components)) {
    if (
      !editable(component) ||
      state.conflicts.some((conflict) => conflict.componentId === component.id)
    )
      continue;
    const path = component.value.path;
    const before = readPointer(state.base.model, normalizeA2uiPath(path));
    const local = readPointer(state.surface.model, normalizeA2uiPath(path));
    if (state.unconfirmedEdits?.includes(component.id) || !equalValue(before, local)) {
      candidates.set(component.id, {
        componentId: component.id,
        path,
        label: component.label,
        base: before,
        local,
        remote: undefined,
      });
    }
  }
  // A conflict keeps its original ancestor and survives even when a later remote edit
  // happens to match the local value. Component identity survives reuse of its old path.
  for (const conflict of state.conflicts) candidates.set(conflict.componentId, conflict);

  for (const candidate of candidates.values()) {
    const component = base.components[candidate.componentId];
    const currentField = editable(component) ? component : undefined;
    const remote = currentField
      ? readPointer(base.model, normalizeA2uiPath(currentField.value.path))
      : undefined;
    const bindingChanged = !currentField || currentField.value.path !== candidate.path;
    const pending = state.conflicts.some(
      (conflict) => conflict.componentId === candidate.componentId,
    );
    if (currentField) model = setValue(model, currentField.value.path, candidate.local);
    if (canMirrorHistoricValue(base, candidate.path)) {
      model = setValue(model, candidate.path, candidate.local);
    }
    if (
      pending ||
      bindingChanged ||
      // A newer snapshot cannot identify which action ran. Require a choice for
      // divergent later edits instead of treating the submitted values as authority.
      ((state.unconfirmedEdits?.includes(candidate.componentId) ||
        !equalValue(candidate.base, remote)) &&
        !equalValue(candidate.local, remote))
    ) {
      conflicts.push(structuredClone({ ...candidate, remote }));
    }
  }

  return {
    snapshot: structuredClone(snapshot),
    base,
    surface: { ...structuredClone(base), model },
    conflicts,
    retainedValues,
  };
}

export function resolveDraftConflict(
  state: DraftState,
  path: string,
  decision: 'local' | 'remote',
): DraftState {
  const conflict = state.conflicts.find((entry) => entry.path === path);
  if (!conflict) return state;
  const component = state.base.components[conflict.componentId];
  const currentPath = editable(component) ? component.value.path : undefined;
  let model = state.surface.model;
  const retainedValues = structuredClone(
    (state.retainedValues ?? []).filter((entry) => entry.componentId !== conflict.componentId),
  );
  if (canMirrorHistoricValue(state.base, path)) {
    model = setValue(model, path, undefined);
  }
  if (currentPath) {
    model = setValue(
      model,
      currentPath,
      decision === 'local'
        ? conflict.local
        : readPointer(state.base.model, normalizeA2uiPath(currentPath)),
    );
  } else if (decision === 'local') {
    // A removed value survives future rebases independently of whichever field now
    // owns its historic path, and cannot leak into the current action context.
    retainedValues.push({
      componentId: conflict.componentId,
      path,
      value: structuredClone(conflict.local),
    });
    if (canMirrorHistoricValue(state.base, path)) {
      model = setValue(model, path, conflict.local);
    }
  }
  return {
    ...state,
    surface: { ...state.surface, model },
    conflicts: state.conflicts.filter((entry) => entry.componentId !== conflict.componentId),
    retainedValues,
  };
}

export function buildActionEnvelope(state: DraftState, sourceId = 'submit'): ActionEnvelope {
  if (state.conflicts.length > 0) throw new Error('请先解决所有字段冲突，再提交动作。');
  const issues = validateFields(state.surface, state.snapshot.rules);
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join('\n'));
  return {
    expectedRevision: state.snapshot.revision,
    action: resolveA2uiAction(state.surface, sourceId),
  };
}
