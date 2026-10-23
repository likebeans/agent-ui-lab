import { runFoundation } from './foundation/engine';

export type StaticLabHandler = (
  path: string,
  options: RequestInit,
) => Promise<Response | undefined>;

// This is the one static route registration point. Engines remain browser-safe.
const handlers: StaticLabHandler[] = [
  async (path, options) => {
    if (path !== '/api/labs/foundation/run' || (options.method ?? 'GET').toUpperCase() !== 'POST')
      return undefined;
    const input: unknown = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
    return new Response(JSON.stringify(runFoundation(input)), {
      headers: { 'Content-Type': 'application/json', 'X-Lab-Transport': 'browser-memory' },
    });
  },
];

export async function staticLabFetch(
  path: string,
  options: RequestInit,
): Promise<Response | undefined> {
  for (const handler of handlers) {
    const response = await handler(path, options);
    if (response) return response;
  }
  return undefined;
}
