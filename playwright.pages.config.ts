import { defineConfig } from '@playwright/test';

const base = process.env.PAGES_TEST_PATH ?? '/pages-test/';
const origin = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/pages.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL: `${origin}${base}`,
    channel: process.env.PLAYWRIGHT_CHANNEL === 'chromium' ? undefined : 'chrome',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      process.env.PAGES_SKIP_BUILD === '1'
        ? 'npm run preview:pages'
        : 'npm run build:pages && npm run preview:pages',
    env: { PAGES_BASE_PATH: base },
    url: `${origin}${base}`,
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 120_000,
  },
});
