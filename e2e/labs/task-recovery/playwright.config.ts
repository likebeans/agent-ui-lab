import { defineConfig } from '@playwright/test';
import { loadRuntimeConfig } from '../../../config/runtime';

const runtime = loadRuntimeConfig();
const pages = process.env.LAB_RECOVERY_TEST_MODE === 'pages';
const basePath = pages ? '/w1-pages/' : '/';

export default defineConfig({
  testDir: '.',
  testMatch: '*.browser.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: `${runtime.dataDir}/browser-artifacts/${pages ? 'pages' : 'local'}`,
  use: {
    baseURL: `${pages ? runtime.previewOrigin : runtime.webOrigin}${basePath}`,
    channel: runtime.environment.PLAYWRIGHT_CHANNEL === 'chromium' ? undefined : 'chrome',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx e2e/labs/task-recovery/server.ts',
    cwd: runtime.rootDir,
    env: {
      ...runtime.environment,
      LAB_RECOVERY_TEST_MODE: pages ? 'pages' : 'local',
      PAGES_BASE_PATH: basePath,
    },
    url: `${pages ? runtime.previewOrigin : runtime.webOrigin}${basePath}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
