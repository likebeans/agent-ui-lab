import { loadRuntimeConfig } from './runtime.ts';
import { assertPageInstance } from '../scripts/runtime-preflight.ts';

export default async function verifyPagesInstance(): Promise<void> {
  const config = loadRuntimeConfig();
  const base = config.environment.PAGES_TEST_PATH ?? '/pages-test/';
  await assertPageInstance(`${config.previewOrigin}${base}`, config.instanceId);
}
