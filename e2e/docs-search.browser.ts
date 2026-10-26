import { expect, test, type Locator, type Page } from '@playwright/test';
import { parseDocsHash } from '../shared/doc-navigation';

async function result(page: Page, query: string, slug: string) {
  const search = page.getByRole('searchbox', { name: '搜索学习文档' });
  await search.scrollIntoViewIfNeeded();
  await search.fill(query);
  return page.locator(`.doc-search-results a[href^="#docs/${slug}?"]`);
}

async function expectHit(page: Page, target: Locator, text: string) {
  await expect(target).toBeFocused();
  await expect(target).toContainText(text);
  await expect(target).toBeInViewport();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hit = CSS.highlights.get('doc-search-hit');
        if (!hit) return null;
        const range = Array.from(hit)[0] as Range;
        const rect = range.getBoundingClientRect();
        const header = document.querySelector('.docs-topbar')!.getBoundingClientRect();
        return {
          visible: rect.top >= header.bottom && rect.top < innerHeight,
          text: range.toString(),
        };
      }),
    )
    .toMatchObject({ visible: true, text });
}

for (const mobile of [false, true]) {
  test(`document search locates and briefly highlights the actual section (${mobile ? 'phone dark' : 'desktop light'})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(
      mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 },
    );
    await page.emulateMedia({ colorScheme: mobile ? 'dark' : 'light', reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('./#docs/map');
    await page.getByRole('region', { name: '学习文档', exact: true }).waitFor();
    if (mobile) await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', mobile ? 'dark' : 'light');
    const entry = await result(page, 'PostMessageTransport', 'mcp-apps');
    await expect(entry.locator('.doc-search-section')).toHaveText('先看完整路径');
    const href = await entry.getAttribute('href');
    expect(parseDocsHash(href!)).toEqual({ slug: 'mcp-apps', section: '先看完整路径' });
    await entry.click();
    const target = page.locator('.doc-prose .doc-search-target');
    await expectHit(page, target, 'PostMessageTransport');
    await expect(page.getByRole('searchbox', { name: '搜索学习文档' })).toHaveValue('');
    await page.screenshot({
      path: testInfo.outputPath(`search-hit-${mobile ? 'phone' : 'desktop'}.png`),
      fullPage: false,
    });
    await expect(target).toHaveCount(0, { timeout: 6_000 });
    expect(await page.evaluate(() => CSS.highlights.has('doc-search-hit'))).toBe(false);

    const article = page.locator('.doc-prose');
    const identity = await article.elementHandle();
    const repeated = await result(page, 'PostMessageTransport', 'mcp-apps');
    await repeated.click();
    await expectHit(page, target, 'PostMessageTransport');
    expect(await identity!.evaluate((element) => element.isConnected)).toBe(true);
    await identity!.dispose();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
      mobile ? 375 : 1440,
    );
    await page.goBack();
    await expect(page).toHaveURL(/#docs\/map$/);
    await expect(target).toHaveCount(0);
    expect(await page.evaluate(() => CSS.highlights.has('doc-search-hit'))).toBe(false);
    expect(errors).toEqual([]);
  });
}

test('document search reveals code and table hits without losing their document anchors', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./#docs/map');
  const code = await result(page, '"version"', 'a2ui');
  await expect(code.locator('.doc-search-section')).toHaveText('四种消息');
  await code.click();
  const target = page.locator('.doc-prose .doc-search-target');
  await expectHit(page, target, '"version"');
  await expect(target).toHaveJSProperty('tagName', 'PRE');
  expect(parseDocsHash(new URL(page.url()).hash)?.section).toBe('四种消息');

  const table = await result(page, 'mutuallyExclusive', 'a2ui');
  await expect(table.locator('.doc-search-section')).toHaveText('扁平组件，而不是嵌套 JSX');
  await table.click();
  await expectHit(page, target, 'mutuallyExclusive');
  await expect(target).toHaveJSProperty('tagName', 'TD');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
