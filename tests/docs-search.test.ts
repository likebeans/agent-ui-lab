import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { docHref, parseDocsHash } from '../shared/doc-navigation';
import { createDocuments, searchDocuments } from '../src/docs/content';

const source = `# 搜索实验

导言保留 IntroToken。

## 验证步骤

这里观察第一轮结果。

## 验证步骤

第二轮包含 **NeedleToken**，应定位到这个段落。
`;
const registry = createDocuments({ 'docs/labs/search.md': source }, []);

describe('document search destinations', () => {
  it('links a full-text match to its actual section, including duplicate heading slugs', () => {
    const [match] = searchDocuments('needletoken', registry);
    expect(match.section).toMatchObject({ id: '验证步骤-1', text: '验证步骤' });
    expect(match.targetOffset).toBe(source.indexOf('第二轮包含'));
    expect(match.excerpt).toContain('NeedleToken');
    const href = docHref(match.document.slug, match.section?.id);
    expect(parseDocsHash(href)).toEqual({ slug: 'labs/search', section: '验证步骤-1' });
    expect(match.document.headings.some((heading) => heading.id === match.section?.id)).toBe(true);
  });

  it('keeps document-wide multiword matching while targeting body terms even after a metadata term', () => {
    const local = createDocuments({ 'docs/labs/search.md': source }, [
      {
        slug: 'labs/search',
        file: 'docs/labs/search.md',
        title: 'RegistryTitle',
        description: 'RegistryDescription',
        group: '实验文档',
      },
    ]);
    for (const query of [
      'RegistryTitle NeedleToken',
      'NeedleToken RegistryTitle',
      'RegistryDescription IntroToken NeedleToken',
    ]) {
      const matches = searchDocuments(query, local);
      expect(matches, query).toHaveLength(1);
      expect(matches[0].section?.id, query).toBe('验证步骤-1');
      expect(matches[0].targetOffset, query).toBe(source.indexOf('第二轮包含'));
      expect(matches[0].excerpt, query).toContain('NeedleToken');
    }
    expect(searchDocuments('NeedleToken MissingToken', local)).toEqual([]);
  });

  it('uses existing headings or the chapter start for title, description and introductory matches', () => {
    const sources = {
      'docs/labs/fallback.md': 'PrefaceToken before headings.\n\n# ActualTitle\n\nIntroToken.',
    };
    const local = createDocuments(sources, [
      {
        slug: 'labs/fallback',
        file: 'docs/labs/fallback.md',
        title: 'MetadataTitle',
        description: 'MetadataDescription',
        group: '实验文档',
      },
    ]);
    for (const query of ['MetadataTitle', 'MetadataDescription']) {
      const [match] = searchDocuments(query, local);
      expect(match.section, query).toBeUndefined();
      expect(match.targetOffset, query).toBeUndefined();
      expect(parseDocsHash(docHref(match.document.slug, match.section?.id))?.section).toBe('');
      expect(match.excerpt, query).toContain(query);
    }
    expect(searchDocuments('ActualTitle', local)[0]).toMatchObject({
      section: { id: 'actualtitle', text: 'ActualTitle' },
      targetOffset: sources['docs/labs/fallback.md'].indexOf('# ActualTitle'),
    });
    expect(searchDocuments('IntroToken', local)[0]).toMatchObject({
      section: { id: 'actualtitle' },
      targetOffset: sources['docs/labs/fallback.md'].indexOf('IntroToken'),
    });
    expect(searchDocuments('PrefaceToken', local)[0]).toMatchObject({ targetOffset: 0 });
    expect(searchDocuments('PrefaceToken', local)[0].section).toBeUndefined();
    expect(searchDocuments('   ', local)).toEqual([
      { document: local[0], excerpt: 'MetadataDescription' },
    ]);
  });

  it('targets code and table cells without treating fenced headings as section anchors', () => {
    const markdown =
      '# 实验\n\n## 代码\n\n```ts\n# FakeHeading\nconst token = "CodeToken";\n```\n\n## 表格\n\n| 字段 | 内容 |\n| --- | --- |\n| key | TableToken |\n';
    const local = createDocuments({ 'docs/labs/blocks.md': markdown }, []);
    expect(searchDocuments('CodeToken', local)[0]).toMatchObject({
      section: { id: '代码', text: '代码' },
      targetOffset: markdown.indexOf('```ts'),
    });
    expect(searchDocuments('TableToken', local)[0]).toMatchObject({
      section: { id: '表格', text: '表格' },
      targetOffset: markdown.indexOf('| TableToken'),
    });
    expect(searchDocuments('FakeHeading', local)[0].section?.id).toBe('代码');
    const [withoutHeadings] = searchDocuments(
      'CodeToken',
      createDocuments({ 'docs/labs/code.md': '```txt\nCodeToken\n```' }, []),
    );
    expect(withoutHeadings.section).toBeUndefined();
    expect(withoutHeadings.targetOffset).toBe(0);
  });

  it('indexes only rendered footnotes, including references reached through another footnote', () => {
    const markdown = `# Footnote search

## Body

Visible reference[^used] and case-insensitive reference[^CASE].

[^unused]: InvisibleNeedle links to another hidden footnote[^hidden].

[^hidden]: OrphanNeedle.

[^used]: VisibleNeedle links to a visible footnote[^nested].

[^nested]: NestedNeedle links back to the first footnote[^used].

[^case]: CaseNeedle.

[^USED]: DuplicateNeedle.
`;
    const local = createDocuments({ 'docs/labs/footnotes.md': markdown }, []);
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, {
        children: markdown,
        remarkPlugins: [remarkGfm],
        skipHtml: true,
        components: {
          p: ({ node, children }) =>
            createElement('p', { 'data-doc-offset': node?.position?.start.offset }, children),
        },
      }),
    );
    for (const query of ['InvisibleNeedle', 'OrphanNeedle', 'DuplicateNeedle']) {
      expect(html, query).not.toContain(query);
      expect(searchDocuments(query, local), query).toEqual([]);
    }
    for (const query of ['VisibleNeedle', 'NestedNeedle', 'CaseNeedle']) {
      const [match] = searchDocuments(query, local);
      expect(html, query).toContain(query);
      expect(match, query).toMatchObject({
        section: { id: 'body' },
        targetOffset: markdown.indexOf(query),
      });
      expect(html, query).toContain(`data-doc-offset="${match.targetOffset}"`);
    }
  });

  it('matches literal punctuation and rendered inline text while ignoring skipped HTML attributes', () => {
    const markdown =
      '# 安全\n\n## 真实内容\n\nBefore **Inline**Token and `a[b].*` plus <span data-secret="HiddenAttribute">VisibleToken</span>.\n\n<script>HiddenScript</script>';
    const local = createDocuments({ 'docs/labs/safe.md': markdown }, []);
    for (const query of ['inlinetoken', 'a[b].*', 'VisibleToken']) {
      expect(searchDocuments(query, local)[0], query).toMatchObject({
        section: { id: '真实内容' },
        targetOffset: markdown.indexOf('Before'),
      });
    }
    for (const query of ['HiddenAttribute', 'HiddenScript', '[data-secret='])
      expect(searchDocuments(query, local), query).toEqual([]);
  });
});
