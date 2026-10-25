import { expect, type Page } from '@playwright/test';

export function observeStaticRequests(page: Page) {
  const errors: string[] = [];
  const apiRequests: string[] = [];
  const assetFailures: string[] = [];
  const rootAssets: string[] = [];
  const base = process.env.PAGES_TEST_PATH ?? '/pages-test/';
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol !== 'http:') return;
    if (/\/(?:api(?:\/|$)|mcp$)/u.test(url.pathname)) apiRequests.push(url.pathname);
    if (!url.pathname.startsWith(base)) rootAssets.push(url.pathname);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) assetFailures.push(`${response.status()} ${response.url()}`);
  });
  return () => {
    expect(errors).toEqual([]);
    expect(apiRequests).toEqual([]);
    expect(assetFailures).toEqual([]);
    expect(rootAssets).toEqual([]);
  };
}
