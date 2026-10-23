import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { documents } from '../src/docs/content';
import {
  DOC_CHAPTERS,
  docHref,
  isDocsHash,
  parseDocsHash,
  resolveDocLink,
  resolveDocImage,
  type DocSlug,
} from '../shared/doc-navigation';

const projectRoot = new URL('../', import.meta.url);

describe('document manifest', () => {
  it('covers every learning document and the project README in reading order', () => {
    expect(DOC_CHAPTERS.map((chapter) => chapter.slug)).toEqual([
      'map',
      'first-session',
      'learning-method',
      'ag-ui',
      'a2ui',
      'mcp-apps',
      'reference',
      'exercises',
      'real-development',
      'project',
    ]);
    const files = DOC_CHAPTERS.map((chapter) => chapter.file);
    const markdownFiles = readdirSync(new URL('docs/', projectRoot))
      .filter((file) => file.endsWith('.md'))
      .map((file) => `docs/${file}`);
    expect(new Set(files).size).toBe(10);
    expect([...files].sort()).toEqual(['README.md', ...markdownFiles].sort());
    for (const chapter of DOC_CHAPTERS) {
      expect(chapter.title).toMatch(/\p{Script=Han}/u);
      expect(chapter.description).toMatch(/\p{Script=Han}/u);
      expect(chapter.group).toMatch(/\p{Script=Han}/u);
      expect(resolveDocLink(`/${chapter.file}`, 'map')).toBe(docHref(chapter.slug));
    }
  });
});

describe('document hash routes', () => {
  it.each(['#docs', '#docs/', '#docs/map', '#docs/unknown', '#docs/map?section=开始'])(
    'recognizes the docs namespace: %s',
    (hash) => expect(isDocsHash(hash)).toBe(true),
  );

  it.each(['', '#docsfoo', '#docs-map', '#docs?section=开始', '#chat', '/#docs', 'docs/map'])(
    'does not claim other routes: %s',
    (hash) => {
      expect(isDocsHash(hash)).toBe(false);
      expect(parseDocsHash(hash)).toBeNull();
    },
  );

  it('opens the learning map from the short route', () => {
    expect(parseDocsHash('#docs')).toEqual({ slug: 'map', section: '' });
    expect(docHref('map')).toBe('#docs/map');
    expect(docHref('map', '')).toBe('#docs/map');
  });

  it.each([
    ['ag-ui', 'HTTP/SSE 的职责'],
    ['未知/章节', '消息对照-1'],
    ['space + & ? # %', '重复标题-2 + &section=other ? # / %'],
    ['%E4%B8%AD', '%25'],
    ['', ''],
  ])('round-trips slug %s and its exact section', (slug, section) => {
    expect(parseDocsHash(docHref(slug, section))).toEqual({ slug, section });
  });

  it('keeps duplicate-heading suffixes distinct and section values out of the query syntax', () => {
    const sections = ['标题', '标题-1', '标题-2', '标题&section=标题-1'];
    const hrefs = sections.map((section) => docHref('map', section));
    expect(new Set(hrefs).size).toBe(sections.length);
    expect(hrefs.map((href) => parseDocsHash(href)?.section)).toEqual(sections);
    expect(docHref('map', 'a+b &section=c')).toBe('#docs/map?section=a%2Bb%20%26section%3Dc');
    expect(parseDocsHash('#docs/map?section=first&section=second')?.section).toBe('first');
    expect(parseDocsHash('#docs/map?section=a+b')?.section).toBe('a b');
  });

  it('retains unknown names for the not-found view instead of selecting a real chapter', () => {
    expect(parseDocsHash('#docs/missing-chapter')).toEqual({
      slug: 'missing-chapter',
      section: '',
    });
    expect(parseDocsHash('#docs/__proto__')).toEqual({ slug: '__proto__', section: '' });
    expect(parseDocsHash('#docs/..%2FREADME.md')).toEqual({ slug: '../README.md', section: '' });
  });

  it.each(['#docs/%', '#docs/%ZZ?section=%', '#docs/%E0%A4%A?section=%E0%A4%A'])(
    'handles malformed percent encodings without throwing: %s',
    (hash) => {
      expect(() => parseDocsHash(hash)).not.toThrow();
      const route = parseDocsHash(hash)!;
      expect(parseDocsHash(docHref(route.slug, route.section))).toEqual(route);
      expect(resolveDocLink(hash, 'map')).toBe(docHref(route.slug, route.section));
    },
  );
});

describe('README screenshot destinations', () => {
  it.each<[string, DocSlug]>([
    ['public/readme/screenshots/agent-chat.png', 'project'],
    ['./public/readme/screenshots/agent-chat.png', 'project'],
    ['../public/readme/screenshots/agent-chat.png', 'map'],
  ])('resolves a repository screenshot from %s', (href, slug) => {
    expect(resolveDocImage(href, slug)).toBe('readme/screenshots/agent-chat.png');
  });
  it.each([
    'https://example.com/pixel.png',
    '//example.com/pixel.png',
    'data:image/svg+xml,<svg/>',
    'public/readme/screenshots/../secret.png',
    'public/readme/screenshots/demo.svg',
    'public/readme/screenshots/demo.png?tracking=1',
    '../../public/readme/screenshots/demo.png',
  ])('ignores unsupported screenshot destination %s', (href) => {
    expect(resolveDocImage(href, 'project')).toBeNull();
  });
});

describe('Markdown link destinations', () => {
  it.each<[string, DocSlug, DocSlug]>([
    ['./01-ag-ui.md', 'map', 'ag-ui'],
    ['07-learning-method.md', 'ag-ui', 'learning-method'],
    ['./02-a2ui.md', 'mcp-apps', 'a2ui'],
    ['../docs/06-protocol-reference.md', 'exercises', 'reference'],
    ['./docs/03-mcp-apps.md', 'project', 'mcp-apps'],
    ['docs/00-first-session.md', 'project', 'first-session'],
    ['/docs/04-real-development.md', 'map', 'real-development'],
    ['./%30%35-exercises.md', 'map', 'exercises'],
  ])('resolves %s from %s', (href, currentSlug, targetSlug) => {
    expect(resolveDocLink(href, currentSlug)).toBe(docHref(targetSlug));
  });

  it.each<[string, DocSlug, DocSlug]>([
    ['README.md', 'ag-ui', 'map'],
    ['./README.md', 'map', 'map'],
    ['../README.md', 'ag-ui', 'project'],
    ['README.md', 'project', 'project'],
    ['docs/README.md', 'project', 'map'],
    ['/README.md', 'map', 'project'],
    ['/docs/README.md', 'project', 'map'],
  ])('distinguishes the README at %s from %s', (href, currentSlug, targetSlug) => {
    expect(resolveDocLink(href, currentSlug)).toBe(docHref(targetSlug));
  });

  it('preserves literal and encoded headings, including reserved characters and duplicate suffixes', () => {
    expect(resolveDocLink('01-ag-ui.md#HTTP/SSE 的职责', 'map')).toBe(
      docHref('ag-ui', 'HTTP/SSE 的职责'),
    );
    expect(resolveDocLink('../README.md#%E5%90%AF%E5%8A%A8', 'a2ui')).toBe(
      docHref('project', '启动'),
    );
    expect(resolveDocLink('#标题-1', 'reference')).toBe(docHref('reference', '标题-1'));
    expect(resolveDocLink('#a+b%26c%3Fd%23e', 'map')).toBe(docHref('map', 'a+b&c?d#e'));
    expect(resolveDocLink('#bad%ZZ', 'map')).toBe(docHref('map', 'bad%ZZ'));
    expect(resolveDocLink('#', 'map')).toBe(docHref('map'));
    expect(resolveDocLink('README.md#', 'map')).toBe(docHref('map'));
    expect(resolveDocLink('#docsfoo', 'map')).toBe(docHref('map', 'docsfoo'));
  });

  it.each(['chat', 'overview', 'agui', 'a2ui', 'mcp', 'roadmap'])(
    'keeps the known app route %s within the current app',
    (route) => {
      expect(resolveDocLink(`#${route}`, 'map')).toBe(`#${route}`);
      expect(resolveDocLink(`/#${route}`, 'map')).toBe(`#${route}`);
    },
  );

  it.each(['foundation', 'task-state', 'w0', 'a2ui-2'])(
    'keeps canonical lab workspace links: %s',
    (id) => {
      expect(resolveDocLink(`#labs/${id}`, 'map')).toBe(`#labs/${id}`);
      expect(resolveDocLink(`/#labs/${id}`, 'project')).toBe(`#labs/${id}`);
    },
  );

  it.each([
    '#labs/',
    '#labs/..',
    '#labs/../chat',
    '#labs/foundation/../../chat',
    '#labs//foundation',
    '#labs/foundation/',
    '#labs/foundation?next=chat',
    '#labs/foundation#chat',
    '#labs/%66oundation',
    '#labs/%2e%2e',
    '#labs/foundation%2F..',
    '#labs/foundation%5C..',
    '#labs/foundation%00',
    '#labs/foundation%ZZ',
    '#labs%2Ffoundation',
    '#labs/Uppercase',
    '#labs/-foundation',
    '#labs/foundation-',
    '#labs/foundation--other',
    '#labs/javascript:alert(1)',
    '#labs/https://example.com',
    '/#unregistered-workspace',
  ])('rejects malformed or arbitrary workspace routes: %s', (href) => {
    expect(resolveDocLink(href, 'map')).toBeNull();
  });

  it('continues to treat ordinary fragments as local document headings', () => {
    expect(resolveDocLink('#labs-notes', 'map')).toBe(docHref('map', 'labs-notes'));
    expect(resolveDocLink('#unknown-workspace', 'map')).toBe(docHref('map', 'unknown-workspace'));
  });

  it('normalizes existing docs routes without losing unknown chapters', () => {
    expect(resolveDocLink('#docs', 'project')).toBe('#docs/map');
    expect(resolveDocLink('/#docs/a2ui?section=数据绑定', 'map')).toBe(docHref('a2ui', '数据绑定'));
    expect(resolveDocLink('#docs/unknown?section=标题-2', 'map')).toBe(
      docHref('unknown', '标题-2'),
    );
    expect(resolveDocLink('#docs/javascript:alert(1)', 'map')).toBe('#docs/javascript%3Aalert(1)');
    expect(resolveDocLink('#docs/%2F%2Fexample.com', 'map')).toBe('#docs/%2F%2Fexample.com');
    expect(resolveDocLink(docHref('map', '%25'), 'project')).toBe(docHref('map', '%25'));
  });

  it.each([
    'https://docs.ag-ui.com/spec/1.0/events/lifecycle',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3100/#chat',
    'https://example.com/docs/README.md#参考',
    'HTTPS://example.com/reference?q=one+two',
    'mailto:reader@example.com?subject=%E5%AD%A6%E4%B9%A0',
  ])('preserves supported external destinations: %s', (href) => {
    expect(resolveDocLink(href, 'map')).toBe(href);
  });

  it.each([
    '',
    ' ',
    'missing.md',
    'missing.md#heading',
    '../src/Root.tsx',
    'src/Root.tsx',
    '`/#agui`',
    '`docs/README.md`',
    'docs/README.md',
    'README.md?raw=true',
    'README.md/',
    '/#unknown',
    '../../README.md',
    '/../../docs/README.md',
    '%2e%2e/%2e%2e/README.md',
    '%2FREADME.md',
    './README%2Emd%00',
    './README%5Cmd',
    './%E0%A4%A.md',
    '//example.com/docs/README.md',
    '\\example.com\\README.md',
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1) ',
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    'javascript%3Aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///docs/README.md',
    'ftp://example.com/README.md',
    'ui://intelligent-ui/trip-picker',
    'https://',
  ])('rejects unsupported paths and unsafe destinations: %s', (href) => {
    expect(resolveDocLink(href, 'map')).toBeNull();
  });

  it('does not resolve a relative path outside the project README directory', () => {
    expect(resolveDocLink('../README.md', 'project')).toBeNull();
    expect(resolveDocLink('../docs/README.md', 'project')).toBeNull();
  });

  it('resolves the checked-in Markdown links and angle autolinks as renderer destinations', () => {
    const localServers = new Set<string>();
    for (const chapter of documents) {
      const markdown = readFileSync(new URL(chapter.file, projectRoot), 'utf8');
      for (const match of markdown.matchAll(/(!?)\[[^\]]*\]\(([^\s)]+)\)/g)) {
        if (match[1] === '!') {
          const image = resolveDocImage(match[2], chapter.slug, documents);
          expect(image, `${chapter.file}: ${match[2]}`).not.toBeNull();
          expect(readFileSync(new URL(`public/${image}`, projectRoot)).byteLength).toBeGreaterThan(
            0,
          );
          continue;
        }
        const resolved = resolveDocLink(match[2], chapter.slug, documents);
        expect(resolved, `${chapter.file}: ${match[2]}`).not.toBeNull();
        const route = parseDocsHash(resolved!);
        if (route) expect(documents.some((item) => item.slug === route.slug)).toBe(true);
        else expect(resolved).toMatch(/^(?:https?:\/\/|#labs\/)/u);
      }
      // Markdown removes the angle brackets before passing an autolink to the link renderer.
      for (const match of markdown.matchAll(/<(https?:\/\/[^>]+)>/g)) {
        expect(resolveDocLink(match[1], chapter.slug, documents)).toBe(match[1]);
        if (match[1].startsWith('http://127.0.0.1:')) localServers.add(match[1]);
      }
    }
    expect([...localServers].sort()).toEqual([
      'http://127.0.0.1:3100',
      'http://127.0.0.1:4173',
      'http://127.0.0.1:5173',
    ]);
  });
});
