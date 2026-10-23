import { defineConfig } from '@playwright/test';
import { loadRuntimeConfig, reuseExistingServer } from './config/runtime.ts';

const config = loadRuntimeConfig();

export default defineConfig({
  globalSetup: './config/playwright-health.ts',
  testDir: './e2e',
  testIgnore: '**/pages.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: config.webOrigin,
    channel: config.environment.PLAYWRIGHT_CHANNEL === 'chromium' ? undefined : 'chrome',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    env: config.environment,
    url: `${config.webOrigin}/api/health`,
    reuseExistingServer: reuseExistingServer(config.environment),
    timeout: 30_000,
  },
});
