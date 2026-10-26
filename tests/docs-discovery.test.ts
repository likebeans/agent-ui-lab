import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DOC_CHAPTERS,
  discoverDocChapters,
  docHref,
  parseDocsHash,
  resolveDocImage,
  resolveDocLink,
  type DocChapter,
  type DocSlug,
} from '../shared/doc-navigation';
import { createDocuments, documents, searchDocuments } from '../src/docs/content';

const projectRoot = new URL('../', import.meta.url);
const curatedSources = Object.fromEntries(
  DOC_CHAPTERS.map((chapter) => [
    chapter.file,
    readFileSync(new URL(chapter.file, projectRoot), 'utf8'),
  ]),
);
const labSource = `<!-- An author comment, not the description. -->

# 基础 **实验** 与 \`Trace\`

观察 [事件](../01-ag-ui.md) 的流向，
验证同一条消息的结果。

## 验证步骤

使用 NestedSearchToken 检索实验正文。

## 验证步骤

第二次验证保留独立深链接。

\`\`\`md
# 代码中的标题
\`\`\`
`;
const nestedSources = {
  ...curatedSources,
  'docs/labs/zeta.md': '# 后续实验\n\n继续观察。',
  'docs/labs/foundation.md': labSource,
};
const registry = createDocuments(nestedSources);

function chapter(slug: DocSlug, file: string): DocChapter {
  return { slug, file, title: '自定义标题', description: '自定义说明', group: '实验文档' };
}

describe('nested document discovery', () => {
  it('preserves all curated chapters and appends labs in stable slug order', () => {
    expect(
      registry
        .slice(0, DOC_CHAPTERS.length)
        .map(({ source, headings, plainText, searchBlocks, ...item }) => item),
    ).toEqual(DOC_CHAPTERS);
    expect(registry.slice(DOC_CHAPTERS.length).map((item) => item.slug)).toEqual([
      'labs/foundation',
      'labs/zeta',
    ]);
    const reversed = createDocuments(Object.fromEntries(Object.entries(nestedSources).reverse()));
    expect(reversed.map((item) => item.slug)).toEqual(registry.map((item) => item.slug));
  });

  it('extracts title and description from actual Markdown nodes without changing the source', () => {
    const document = registry.find((item) => item.slug === 'labs/foundation')!;
    expect(document.title).toBe('基础 实验 与 Trace');
    expect(document.description).toBe('观察 事件 的流向， 验证同一条消息的结果。');
    expect(document.group).toBe('实验文档');
    expect(document.source).toBe(labSource);
    expect(document.headings.map(({ id }) => id)).toEqual([
      '基础-实验-与-trace',
      '验证步骤',
      '验证步骤-1',
    ]);
    for (const heading of document.headings) {
      expect(document.source.slice(heading.offset)).toMatch(/^#{1,2} /u);
    }
  });

  it('supports setext titles and stable defaults when a heading or paragraph is absent', () => {
    const minimal = createDocuments(
      {
        'docs/labs/setext.md': '实验标题\n========\n\n实验说明。',
        'docs/labs/empty.md': '',
        'docs/labs/code-only.md': '```md\n# 代码标题\n```',
      },
      [],
    );
    expect(minimal.find((item) => item.slug === 'labs/setext')).toMatchObject({
      title: '实验标题',
      description: '实验说明。',
    });
    for (const id of ['empty', 'code-only']) {
      expect(minimal.find((item) => item.slug === `labs/${id}`)).toMatchObject({
        title: id,
        description: '实验说明与操作步骤。',
        headings: [],
      });
    }
  });

  it('keeps an explicitly curated lab once without overwriting its metadata', () => {
    const curatedLab = chapter('labs/foundation', 'docs/labs/foundation.md');
    expect(
      discoverDocChapters(
        [{ file: curatedLab.file, title: '发现的标题', description: '发现的说明' }],
        [curatedLab],
      ),
    ).toEqual([curatedLab]);
  });

  it('does not mutate supplied registries or leak discoveries into other calls', () => {
    const curated = Object.freeze([...DOC_CHAPTERS]);
    const sources = Object.freeze([Object.freeze({ file: 'docs/labs/one.md', title: 'One' })]);
    expect(discoverDocChapters(sources, curated).at(-1)?.slug).toBe('labs/one');
    expect(discoverDocChapters([], curated)).toEqual(DOC_CHAPTERS);
    expect(curated).toHaveLength(DOC_CHAPTERS.length);
    expect(resolveDocLink('/docs/labs/foundation.md', 'map')).toBeNull();
    expect(resolveDocLink('/docs/labs/foundation.md', 'map', registry)).toBe(
      docHref('labs/foundation'),
    );
  });

  it('rejects duplicate sources, curated slugs, curated files and generated slug collisions', () => {
    expect(() =>
      discoverDocChapters([
        { file: 'docs/labs/foundation.md' },
        { file: 'docs/labs/foundation.md' },
      ]),
    ).toThrow(/重复/u);
    expect(() => discoverDocChapters([], [DOC_CHAPTERS[0], DOC_CHAPTERS[0]])).toThrow(/重复/u);
    expect(() =>
      discoverDocChapters(
        [],
        [chapter('labs/one', 'docs/labs/shared.md'), chapter('labs/two', 'docs/labs/shared.md')],
      ),
    ).toThrow(/重复/u);
    expect(() =>
      discoverDocChapters(
        [{ file: 'docs/labs/foundation.md' }],
        [chapter('labs/foundation', 'docs/labs/other.md')],
      ),
    ).toThrow(/重复/u);
  });

  it.each([
    '/docs/labs/foundation.md',
    '../docs/labs/foundation.md',
    'docs/../docs/labs/foundation.md',
    'docs/labs/../foundation.md',
    'docs/labs/./foundation.md',
    'docs/labs//foundation.md',
    'docs/labs/%66oundation.md',
    'docs/labs/%2e%2e.md',
    'docs/labs/%ZZ.md',
    'docs/labs/foundation.md?raw=true',
    'docs/labs/foundation.md#title',
    'docs/labs/foundation.md\u0000',
    'docs\\labs\\foundation.md',
    'docs/labs/nested/foundation.md',
    'docs/labs/Uppercase.md',
    'docs/labs/space name.md',
    'docs/labs/-leading.md',
    'docs/labs/trailing-.md',
    'docs/labs/double--dash.md',
    'docs/labs/foundation.txt',
  ])('rejects noncanonical discovery path %s', (file) => {
    expect(() => discoverDocChapters([{ file }])).toThrow(/无效/u);
  });

  it('ignores unregistered documents outside the lab namespace and reports missing curated sources', () => {
    expect(discoverDocChapters([{ file: 'docs/notes/extra.md', title: '笔记' }])).toEqual(
      DOC_CHAPTERS,
    );
    expect(() => createDocuments({})).toThrow('找不到学习文档：docs/README.md');
  });

  it('loads checked-in nested lab documents through the browser content registry', () => {
    const files = readdirSync(new URL('docs/', projectRoot), { recursive: true, encoding: 'utf8' })
      .filter((file) => /^labs\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(file))
      .map((file) => `docs/${file}`)
      .sort();
    expect(documents.slice(0, DOC_CHAPTERS.length).map((item) => item.slug)).toEqual(
      DOC_CHAPTERS.map((item) => item.slug),
    );
    expect(
      documents.filter((item) => item.slug.startsWith('labs/')).map((item) => item.file),
    ).toEqual(files);
    for (const file of files) {
      const document = documents.find((item) => item.file === file)!;
      expect(document.source).toBe(readFileSync(new URL(file, projectRoot), 'utf8'));
      expect(searchDocuments(document.title).some((match) => match.document === document)).toBe(
        true,
      );
      expect(resolveDocLink(`/${file}`, 'project', documents)).toBe(docHref(document.slug));
    }
  });
});

describe('nested document search and navigation', () => {
  it('searches nested titles, descriptions and full text using the same registry', () => {
    for (const query of [
      '基础 实验 与 trace',
      '验证同一条消息',
      'nestedsearchtoken',
      'NestedSearchToken 基础',
    ]) {
      const matches = searchDocuments(query, registry);
      expect(
        matches.map(({ document }) => document.slug),
        query,
      ).toContain('labs/foundation');
    }
    expect(
      searchDocuments('nestedsearchtoken', registry).map(({ document }) => document.slug),
    ).toEqual(['labs/foundation']);
    expect(searchDocuments('nestedsearchtoken', registry)[0].excerpt).toContain(
      'NestedSearchToken',
    );
    expect(searchDocuments('unknown-search-token-9fb', registry)).toEqual([]);
    expect(searchDocuments('', registry).map(({ document }) => document.slug)).toEqual(
      registry.map((document) => document.slug),
    );
  });

  it.each<[string, DocSlug, DocSlug, string]>([
    ['labs/foundation.md', 'map', 'labs/foundation', ''],
    ['docs/labs/foundation.md', 'project', 'labs/foundation', ''],
    ['/docs/labs/foundation.md', 'a2ui', 'labs/foundation', ''],
    ['../01-ag-ui.md#事件', 'labs/foundation', 'ag-ui', '事件'],
    ['../README.md', 'labs/foundation', 'map', ''],
    ['../../README.md', 'labs/foundation', 'project', ''],
    ['zeta.md', 'labs/foundation', 'labs/zeta', ''],
    ['./zeta.md#下一步', 'labs/foundation', 'labs/zeta', '下一步'],
    ['../labs/zeta.md', 'labs/foundation', 'labs/zeta', ''],
    ['%2e%2e/README.md', 'labs/foundation', 'map', ''],
    ['#验证步骤-1', 'labs/foundation', 'labs/foundation', '验证步骤-1'],
  ])('resolves nested link %s from %s', (href, current, target, section) => {
    expect(resolveDocLink(href, current, registry)).toBe(docHref(target, section));
  });

  it('recovers a nested document and duplicate heading from a copied deep link after rebuilding', () => {
    const href = docHref('labs/foundation', '验证步骤-1');
    expect(href).toBe('#docs/labs%2Ffoundation?section=%E9%AA%8C%E8%AF%81%E6%AD%A5%E9%AA%A4-1');
    const location = new URL(`https://example.test/project/${href}`);
    const route = parseDocsHash(location.hash)!;
    const reopened = createDocuments(nestedSources).find((item) => item.slug === route.slug)!;
    expect(reopened.file).toBe('docs/labs/foundation.md');
    expect(reopened.headings.find((item) => item.id === route.section)?.text).toBe('验证步骤');
    expect(resolveDocLink('/#docs/labs/foundation?section=验证步骤-1', 'map', registry)).toBe(href);
  });

  it('keeps unknown deep links for the not-found view without inventing documents', () => {
    const href = docHref('labs/missing', '步骤');
    const route = parseDocsHash(href)!;
    expect(registry.find((item) => item.slug === route.slug)).toBeUndefined();
    expect(resolveDocLink(href, 'labs/foundation', registry)).toBe(href);
    expect(resolveDocLink('missing.md', 'labs/foundation', registry)).toBeNull();
    expect(resolveDocLink('foundation.md', 'labs/missing', registry)).toBeNull();
    expect(
      resolveDocImage('../../public/readme/screenshots/agent-chat.png', 'labs/missing', registry),
    ).toBeNull();
  });

  it.each([
    '../../../README.md',
    '../../../docs/labs/foundation.md',
    '%2e%2e/%2e%2e/%2e%2e/README.md',
    '/../../docs/labs/foundation.md',
    'missing.md',
    './%E0%A4%A.md',
    './%2Ffoundation.md',
    './foundation%00.md',
    './foundation%5C.md',
    'foundation.md?raw',
    'foundation.md/',
    '//example.test/docs/labs/foundation.md',
  ])('rejects unknown or unsafe nested destination %s', (href) => {
    expect(resolveDocLink(href, 'labs/foundation', registry)).toBeNull();
  });

  it('resolves README screenshots relative to nested chapters without allowing new image sources', () => {
    expect(
      resolveDocImage(
        '../../public/readme/screenshots/agent-chat.png',
        'labs/foundation',
        registry,
      ),
    ).toBe('readme/screenshots/agent-chat.png');
    for (const href of [
      '../../../public/readme/screenshots/agent-chat.png',
      '../../public/readme/screenshots/agent-chat.png?track=1',
      '../../public/readme/screenshots/agent-chat.svg',
      './image.png',
      'https://example.test/image.png',
    ])
      expect(resolveDocImage(href, 'labs/foundation', registry)).toBeNull();
  });
});

describe('lab workspace destinations', () => {
  it.each(['foundation', 'event-flow', 'lab-2', 'w0'])('accepts safe workspace id %s', (id) => {
    expect(resolveDocLink(`#labs/${id}`, 'map', registry)).toBe(`#labs/${id}`);
    expect(resolveDocLink(`/#labs/${id}`, 'labs/foundation', registry)).toBe(`#labs/${id}`);
  });

  it.each([
    '#labs',
    '#labs/',
    '#labs//foundation',
    '#labs/../chat',
    '#labs/foundation/../../chat',
    '#labs/%2e%2e',
    '#labs/%66oundation',
    '#labs/foundation%2Fother',
    '#labs/foundation%5Cother',
    '#labs/foundation%00',
    '#labs/foundation%ZZ',
    '#labs/foundation?section=other',
    '#labs/foundation#other',
    '#labs/foundation/',
    '#labs/Uppercase',
    '#labs/-leading',
    '#labs/double--dash',
    '#labs/space name',
    '#labs/javascript:alert(1)',
    '#labs%2Ffoundation',
  ])('rejects malformed workspace route %s without treating it as a heading', (hash) => {
    expect(resolveDocLink(hash, 'labs/foundation', registry)).toBeNull();
    expect(resolveDocLink(`/${hash}`, 'labs/foundation', registry)).toBeNull();
  });

  it('keeps arbitrary headings inside the current document instead of promoting them to app routes', () => {
    expect(resolveDocLink('#unknown/path', 'labs/foundation', registry)).toBe(
      docHref('labs/foundation', 'unknown/path'),
    );
    expect(resolveDocLink('/#unknown/path', 'labs/foundation', registry)).toBeNull();
    expect(resolveDocLink('#labs-overview', 'labs/foundation', registry)).toBe(
      docHref('labs/foundation', 'labs-overview'),
    );
  });
});
