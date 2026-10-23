import { defineConfig } from '@playwright/test';
import { loadRuntimeConfig, reuseExistingServer } from './config/runtime.ts';

const config = loadRuntimeConfig();
const base = config.environment.PAGES_TEST_PATH ?? '/pages-test/';
const origin = config.previewOrigin;
// The specs use this path when checking subpath assets and network isolation.
process.env.PAGES_TEST_PATH = base;

export default defineConfig({
  globalSetup: './config/playwright-pages-health.ts',
  testDir: './e2e',
  testMatch: '**/pages.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL: `${origin}${base}`,
    channel: config.environment.PLAYWRIGHT_CHANNEL === 'chromium' ? undefined : 'chrome',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      config.environment.PAGES_SKIP_BUILD === '1'
        ? 'npm run preview:pages'
        : 'npm run build:pages && npm run preview:pages',
    env: { ...config.environment, PAGES_BASE_PATH: base },
    url: `${origin}${base}`,
    reuseExistingServer: reuseExistingServer(config.environment),
    stdout: 'pipe',
    timeout: 120_000,
  },
});
