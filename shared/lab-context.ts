import type { LabContext } from './lab-contract';

function isNamespace(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Interactions patch fields in each namespace against the latest conversation context. */
export function mergeLabContext(current: LabContext, patch: LabContext): LabContext {
  return {
    ...current,
    ...Object.fromEntries(
      Object.entries(patch).map(([namespace, value]) => [
        namespace,
        isNamespace(current[namespace]) && isNamespace(value)
          ? { ...current[namespace], ...value }
          : value,
      ]),
    ),
  };
}
