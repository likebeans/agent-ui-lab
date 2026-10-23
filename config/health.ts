import { isExpectedInstance, type LabHealth } from '../shared/instance.ts';

export async function assertLocalInstance(baseURL: string, instanceId: string): Promise<LabHealth> {
  const url = new URL('api/health', baseURL.endsWith('/') ? baseURL : `${baseURL}/`);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(`Cannot reach lab health at ${url}. Start the configured lab first.`, {
      cause: error,
    });
  }
  const health: unknown = await response.json().catch(() => undefined);
  if (
    !response.ok ||
    !isExpectedInstance(health, instanceId) ||
    health.mode !== 'local-deterministic'
  ) {
    throw new Error(`Lab health at ${url} does not belong to local instance "${instanceId}".`);
  }
  return health;
}
