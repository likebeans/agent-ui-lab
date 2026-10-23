import { loadRuntimeConfig } from './runtime.ts';
import { assertLocalInstance } from './health.ts';
import { assertPageInstance } from '../scripts/runtime-preflight.ts';

export default async function verifyPlaywrightInstance(): Promise<void> {
  const config = loadRuntimeConfig();
  await assertPageInstance(config.webOrigin, config.instanceId);
  await assertLocalInstance(config.webOrigin, config.instanceId);
  await assertLocalInstance(config.apiOrigin, config.instanceId);
}
