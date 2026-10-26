import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronRight,
  ExternalLink,
  FileText,
  List,
  MessageSquare,
  Moon,
  Search,
  Sun,
  X,
} from 'lucide-react';
import { docHref, parseDocsHash, resolveDocImage, resolveDocLink } from '../shared/doc-navigation';
import { documents, searchDocuments, type DocumentSearchMatch } from './docs/content';
import { useTheme } from './useTheme';
import { RuntimeNotice } from './components/RuntimeNotice';
import './docs.css';

interface DocsReaderProps {
  hash: string;
  returnTo: string;
}

/** Locate literal text across inline Markdown nodes without changing the rendered article. */
function searchRanges(root: HTMLElement, query: string): Range[] {
  const nodes: { node: Text; start: number; end: number }[] = [];
  const walker = window.document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest('.doc-heading-link')) continue;
    const start = text.length;
    text += node.data;
    nodes.push({ node, start, end: text.length });
  }
  // Lowercasing can expand a character (for example İ), so retain original DOM offsets.
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of text) {
    const end = offset + character.length;
    for (let index = 0; index < character.toLocaleLowerCase().length; index++) {
      starts.push(offset);
      ends.push(end);
    }
    offset = end;
  }
  const folded = text.toLocaleLowerCase();
  const ranges: Range[] = [];
  const terms = new Set(query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean));
  for (const term of terms) {
    let found = folded.indexOf(term);
    while (found >= 0) {
      const start = starts[found];
      const end = ends[found + term.length - 1];
      const first = nodes.find((entry) => entry.end > start);
      const last = nodes.find((entry) => entry.end >= end);
      if (first && last) {
        const range = window.document.createRange();
        range.setStart(first.node, start - first.start);
        range.setEnd(last.node, end - last.start);
        ranges.push(range);
      }
      found = folded.indexOf(term, found + term.length);
    }
  }
  return ranges.sort((left, right) => left.compareBoundaryPoints(Range.START_TO_START, right));
}

function revealSearchHit(target: HTMLElement, range?: Range) {
  target.scrollIntoView({ block: 'start', behavior: 'instant' });
  if (!range) return;
  const origin = range.startContainer.parentElement;
  const horizontal = origin?.closest<HTMLElement>('pre, .doc-table-scroll');
  if (horizontal) {
    const hit = range.getBoundingClientRect();
    const frame = horizontal.getBoundingClientRect();
    if (hit.left < frame.left || hit.right > frame.right)
      horizontal.scrollLeft += hit.left - frame.left - 20;
    if (hit.top < frame.top || hit.bottom > frame.bottom)
      horizontal.scrollTop += hit.top - frame.top - 20;
  }
  const hit = range.getBoundingClientRect();
  const topbar = target.closest('.docs-reader')?.querySelector('.docs-topbar');
  const top = (topbar?.getBoundingClientRect().bottom ?? 76) + 24;
  if (hit.top < top || hit.bottom > window.innerHeight - 24)
    window.scrollBy({ top: hit.top - top, behavior: 'instant' });
}

export default function DocsReader({ hash, returnTo }: DocsReaderProps) {
  const route = parseDocsHash(hash);
  const document = documents.find((item) => item.slug === route?.slug);
  const section = route?.section ?? '';
  const [query, setQuery] = useState('');
  const searchDestination = useRef<{
    match: DocumentSearchMatch;
    query: string;
  } | null>(null);
  const [searchNavigation, setSearchNavigation] = useState(0);
  const [theme, setTheme] = useTheme();
  const article = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const contents = useRef<HTMLDetailsElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const chapters = useRef<HTMLDetailsElement>(null);
  const position = document ? documents.indexOf(document) : -1;
  const previous = documents[position - 1];
  const next = documents[position + 1];
  const matches = searchDocuments(query);
  const returnLabel = returnTo === '#chat' ? '返回 Agent 对话' : '返回独立实验';

  useEffect(() => {
    const media = window.matchMedia('(max-width: 780px)');
    const changed = () => {
      if (chapters.current) chapters.current.open = !media.matches;
    };
    changed();
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    const previousTitle = window.document.title;
    return () => {
      window.document.title = previousTitle;
    };
  }, []);
  useEffect(() => {
    window.document.title = `${document?.title ?? '未找到章节'} · Agent UI`;
    const destination = searchDestination.current;
    const match = destination?.match;
    const fromSearch =
      match?.document.slug === route?.slug && (match?.section?.id ?? '') === section;
    if (fromSearch) searchDestination.current = null;
    const sectionHeading =
      section && article.current
        ? Array.from(article.current.querySelectorAll<HTMLElement>('[data-section]')).find(
            (element) => element.dataset.section === section,
          )
        : undefined;
    const targetOffset = fromSearch ? match?.targetOffset : undefined;
    const blocks = article.current
      ? Array.from(article.current.querySelectorAll<HTMLElement>('[data-doc-offset]'))
      : [];
    const searchTarget =
      targetOffset === undefined
        ? undefined
        : (blocks.find((element) => Number(element.dataset.docOffset) === targetOffset) ??
          // Tight Markdown lists omit their paragraph element; focus the containing item.
          blocks
            .reverse()
            .find(
              (element) =>
                Number(element.dataset.docOffset) <= targetOffset &&
                Number(element.dataset.docEnd) > targetOffset,
            ));
    const node = searchTarget ?? sectionHeading ?? heading.current ?? article.current;
    setQuery('');
    if (contents.current) contents.current.open = false;
    if (window.innerWidth <= 780 && chapters.current) chapters.current.open = false;
    node?.focus({ preventScroll: true });
    if (searchTarget || sectionHeading || fromSearch)
      node?.scrollIntoView({ block: 'start', behavior: 'instant' });
    else window.scrollTo({ top: 0, behavior: 'instant' });
    if (!fromSearch || !node || !destination) return;

    node.classList.add('doc-search-target');
    const ranges = searchRanges(node, destination.query);
    revealSearchHit(node, ranges[0]);
    const highlights = window.CSS?.highlights;
    const highlight =
      typeof Highlight !== 'undefined' && ranges.length ? new Highlight(...ranges) : undefined;
    if (highlight) highlights?.set('doc-search-hit', highlight);
    const timer = window.setTimeout(clearHighlight, 4_000);
    function clearHighlight() {
      node?.classList.remove('doc-search-target');
      if (highlight && highlights?.get('doc-search-hit') === highlight)
        highlights.delete('doc-search-hit');
    }
    return () => {
      window.clearTimeout(timer);
      clearHighlight();
    };
  }, [route?.slug, section, searchNavigation]);

  const markdownComponents = useMemo<Components>(() => {
    function headingNode(level: number, offset: number | undefined, children: ReactNode) {
      const item = document?.headings.find((entry) => entry.offset === offset);
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag
          id={item?.id}
          data-section={item?.id}
          data-doc-offset={offset}
          tabIndex={-1}
          ref={level === 1 ? heading : undefined}
        >
          {children}
          {item && document && (
            <a
              className="doc-heading-link"
              href={docHref(document.slug, item.id)}
              aria-label={`链接到 ${item.text}`}
            >
              #
            </a>
          )}
        </Tag>
      );
    }
    return {
      h1: ({ children, node }) => headingNode(1, node?.position?.start.offset, children),
      h2: ({ children, node }) => headingNode(2, node?.position?.start.offset, children),
      h3: ({ children, node }) => headingNode(3, node?.position?.start.offset, children),
      h4: ({ children, node }) => headingNode(4, node?.position?.start.offset, children),
      h5: ({ children, node }) => headingNode(5, node?.position?.start.offset, children),
      h6: ({ children, node }) => headingNode(6, node?.position?.start.offset, children),
      a: ({ children, href }) =>
        href ? (
          <a
            href={href}
            {...(/^https?:\/\//i.test(href) ? { target: '_blank', rel: 'noreferrer' } : {})}
          >
            {children}
            {/^https?:\/\//i.test(href) && (
              <ExternalLink size={11} className="doc-external" aria-hidden="true" />
            )}
          </a>
        ) : (
          <span>{children}</span>
        ),
      p: ({ children, node }) => (
        <p data-doc-offset={node?.position?.start.offset} tabIndex={-1}>
          {children}
        </p>
      ),
      li: ({ children, node }) => (
        <li
          data-doc-offset={node?.position?.start.offset}
          data-doc-end={node?.position?.end.offset}
          tabIndex={-1}
        >
          {children}
        </li>
      ),
      th: ({ children, node, ...props }) => (
        <th {...props} data-doc-offset={node?.position?.start.offset} tabIndex={-1}>
          {children}
        </th>
      ),
      td: ({ children, node, ...props }) => (
        <td {...props} data-doc-offset={node?.position?.start.offset} tabIndex={-1}>
          {children}
        </td>
      ),
      table: ({ children }) => (
        <div
          className="doc-table-scroll"
          role="region"
          aria-label="可横向滚动的文档表格"
          tabIndex={0}
        >
          <table>{children}</table>
        </div>
      ),
      pre: ({ children, node }) => (
        <pre data-doc-offset={node?.position?.start.offset} tabIndex={0}>
          {children}
        </pre>
      ),
      img: ({ src, alt }) =>
        src ? (
          <img src={src} alt={alt ?? ''} loading="lazy" decoding="async" />
        ) : (
          <span>{alt}</span>
        ),
    };
  }, [document]);

  const toc = document?.headings.filter((item) => item.depth === 2 || item.depth === 3) ?? [];
  const tocLinks = (
    <nav aria-label="本章目录">
      {toc.map((item) => (
        <a
          key={item.id}
          className={item.depth === 3 ? 'doc-toc-nested' : ''}
          href={docHref(document!.slug, item.id)}
          aria-current={section === item.id ? 'location' : undefined}
        >
          {item.text}
        </a>
      ))}
    </nav>
  );

  return (
    <section className="docs-reader" aria-label="学习文档">
      <a
        className="skip-link"
        href="#doc-article"
        onClick={(event) => {
          event.preventDefault();
          heading.current?.focus();
          heading.current?.scrollIntoView({ block: 'start' });
        }}
      >
        跳到文档正文
      </a>
      <header className="docs-topbar">
        <a className="docs-brand" href={docHref('map')}>
          <span>
            <BookOpen size={20} aria-hidden="true" />
          </span>
          <strong>
            学习文档<small>Agent UI Lab</small>
          </strong>
        </a>
        <div className="docs-top-actions">
          <a className="doc-return" href={returnTo}>
            <ArrowLeft size={15} aria-hidden="true" />
            <span>{returnLabel}</span>
          </a>
          <button
            className="icon-button"
            type="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? '切换浅色模式' : '切换深色模式'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>
      <div className="docs-layout">
        <aside className="docs-sidebar" aria-label="文档导航">
          <div className="docs-library-label">
            <FileText size={14} aria-hidden="true" />
            教程与实践<span>{documents.length} 篇</span>
          </div>
          <label className="doc-search">
            <Search size={16} aria-hidden="true" />
            <input
              ref={search}
              type="search"
              aria-label="搜索学习文档"
              placeholder="搜索标题与全文…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('');
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  search.current?.focus();
                }}
                aria-label="清空文档搜索"
              >
                <X size={14} />
              </button>
            )}
          </label>
          {query ? (
            <div className="doc-search-results">
              <p role="status">找到 {matches.length} 篇相关文档</p>
              {matches.length ? (
                matches.map((match) => (
                  <a
                    key={match.document.slug}
                    href={docHref(match.document.slug, match.section?.id)}
                    onClick={(event) => {
                      if (
                        event.button ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      searchDestination.current = { match, query };
                      setQuery('');
                      if (
                        match.document.slug === document?.slug &&
                        (match.section?.id ?? '') === section
                      ) {
                        event.preventDefault();
                        setSearchNavigation((current) => current + 1);
                      }
                    }}
                  >
                    <strong>{match.document.title}</strong>
                    <span className="doc-search-section">{match.section?.text ?? '本章开头'}</span>
                    <span>{match.excerpt}</span>
                    <small>
                      阅读本章 <ArrowRight size={12} aria-hidden="true" />
                    </small>
                  </a>
                ))
              ) : (
                <p className="doc-search-empty">试试“预算”“SSE”或“握手”。</p>
              )}
            </div>
          ) : (
            <details className="doc-chapters" ref={chapters} open={window.innerWidth > 780}>
              <summary>
                <List size={15} aria-hidden="true" />
                全部章节
              </summary>
              <nav aria-label="学习章节">
                {documents.map((chapter, index) => (
                  <a
                    key={chapter.slug}
                    href={docHref(chapter.slug)}
                    aria-current={chapter.slug === document?.slug ? 'page' : undefined}
                  >
                    <span className="doc-chapter-number">{String(index + 1).padStart(2, '0')}</span>
                    <span>
                      <strong>{chapter.title}</strong>
                      <small>{chapter.description}</small>
                    </span>
                    <ChevronRight size={13} aria-hidden="true" />
                  </a>
                ))}
              </nav>
            </details>
          )}
          <div className="doc-sidebar-note">
            <BookOpen size={16} aria-hidden="true" />
            <p>从教程走到实验，再沿真实消息追到代码。</p>
            <a href="#chat">
              <MessageSquare size={14} aria-hidden="true" />
              打开 Agent 对话
            </a>
          </div>
        </aside>
        <main className="doc-main" id="doc-article">
          <RuntimeNotice />
          {document ? (
            <>
              <div className="doc-breadcrumb">
                <a href={docHref('map')}>学习文档</a>
                <ChevronRight size={13} aria-hidden="true" />
                <span>{document.title}</span>
              </div>
              <div className="doc-chapter-meta">
                <span>
                  第 {position + 1} / {documents.length} 章
                </span>
                <span>{document.group}</span>
              </div>
              <details className="doc-mobile-toc" ref={contents}>
                <summary>
                  <List size={15} aria-hidden="true" />
                  本章目录<span>{toc.length} 节</span>
                </summary>
                {tocLinks}
              </details>
              <article
                className="doc-prose"
                ref={article}
                aria-label={document.title}
                tabIndex={-1}
              >
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  urlTransform={(url, key) => {
                    if (key === 'src') {
                      const image = resolveDocImage(url, document.slug, documents);
                      return image ? `${import.meta.env.BASE_URL}${image}` : '';
                    }
                    return defaultUrlTransform(resolveDocLink(url, document.slug, documents) ?? '');
                  }}
                  components={markdownComponents}
                >
                  {document.source}
                </Markdown>
              </article>
              <nav className="doc-pagination" aria-label="章节翻页">
                {previous ? (
                  <a href={docHref(previous.slug)}>
                    <ArrowLeft size={16} aria-hidden="true" />
                    <span>
                      <small>上一章</small>
                      <strong>{previous.title}</strong>
                    </span>
                  </a>
                ) : (
                  <span />
                )}
                {next ? (
                  <a href={docHref(next.slug)}>
                    <span>
                      <small>下一章</small>
                      <strong>{next.title}</strong>
                    </span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </a>
                ) : (
                  <a href={returnTo}>
                    <span>
                      <small>读完了，动手试试</small>
                      <strong>{returnLabel}</strong>
                    </span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </a>
                )}
              </nav>
              <footer className="doc-footer">
                <span>
                  内容来源 <code>{document.file}</code>
                </span>
                <a href={returnTo}>
                  {returnLabel} <ArrowRight size={13} aria-hidden="true" />
                </a>
              </footer>
            </>
          ) : (
            <div className="doc-not-found">
              <FileText size={32} aria-hidden="true" />
              <h1 ref={heading} tabIndex={-1}>
                未找到这个章节
              </h1>
              <p>可以从左侧章节中选择，或回到学习地图。</p>
              <a className="button primary" href={docHref('map')}>
                打开学习地图 <ArrowRight size={15} aria-hidden="true" />
              </a>
            </div>
          )}
        </main>
        <aside className="doc-desktop-toc" aria-label="章节索引">
          <strong>
            <List size={14} aria-hidden="true" />
            本章目录
          </strong>
          {tocLinks}
          <a className="doc-toc-return" href={returnTo}>
            <ArrowLeft size={14} aria-hidden="true" />
            {returnLabel}
          </a>
        </aside>
      </div>
    </section>
  );
}
