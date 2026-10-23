// Vite replaces this identifier; Node tests can import this module without browser globals.
declare const __LAB_INSTANCE_ID__: string;

export const LAB_INSTANCE_ID =
  typeof __LAB_INSTANCE_ID__ === 'string' ? __LAB_INSTANCE_ID__ : 'lab-unconfigured';

export interface LabHealth {
  status: 'ok';
  mode: 'local-deterministic' | 'browser-static';
  instanceId: string;
  /** Git revision when available; does not claim to fingerprint uncommitted changes. */
  sourceId?: string;
  protocols?: string[];
}

export function isLabHealth(value: unknown): value is LabHealth {
  if (!value || typeof value !== 'object') return false;
  const health = value as Record<string, unknown>;
  return (
    health.status === 'ok' &&
    (health.mode === 'local-deterministic' || health.mode === 'browser-static') &&
    typeof health.instanceId === 'string' &&
    health.instanceId.length > 0 &&
    (health.sourceId === undefined || typeof health.sourceId === 'string') &&
    (health.protocols === undefined ||
      (Array.isArray(health.protocols) &&
        health.protocols.every((value) => typeof value === 'string')))
  );
}

export function isExpectedInstance(
  value: unknown,
  expectedInstanceId = LAB_INSTANCE_ID,
): value is LabHealth {
  return isLabHealth(value) && value.instanceId === expectedInstanceId;
}
