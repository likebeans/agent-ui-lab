import { runFoundation } from './foundation/engine';
import { createA2uiCompatibilityStaticHandler } from './a2ui-compatibility/static';
import { humanApprovalStaticHandler } from './human-approval/static';
import { RECOVERY_API } from './task-recovery/contract';
import { createRecoveryFixture } from './task-recovery/memory';

const recoveryFixture = createRecoveryFixture();

export type StaticLabHandler = (
  path: string,
  options: RequestInit,
) => Promise<Response | undefined>;

// This is the one static route registration point. Engines remain browser-safe.
const handlers: StaticLabHandler[] = [
  createA2uiCompatibilityStaticHandler(),
  humanApprovalStaticHandler,
  async (path, options) => {
    if (!path.startsWith(`${RECOVERY_API}/`)) return undefined;
    return recoveryFixture.handle(new Request(new URL(path, 'http://fixture.local'), options));
  },
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
