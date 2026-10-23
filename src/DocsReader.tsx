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
import { documents, searchDocuments } from './docs/content';
import { useTheme } from './useTheme';
import { RuntimeNotice } from './components/RuntimeNotice';
import './docs.css';

interface DocsReaderProps {
  hash: string;
  returnTo: string;
}

export default function DocsReader({ hash, returnTo }: DocsReaderProps) {
  const route = parseDocsHash(hash);
  const document = documents.find((item) => item.slug === route?.slug);
  const section = route?.section ?? '';
  const [query, setQuery] = useState('');
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
    window.document.title = `${document?.title ?? '未找到章节'} · Intelligent UI`;
    const target =
      section && article.current
        ? Array.from(article.current.querySelectorAll<HTMLElement>('[data-section]')).find(
            (element) => element.dataset.section === section,
          )
        : undefined;
    const node = target ?? heading.current;
    node?.focus({ preventScroll: true });
    if (target) target.scrollIntoView({ block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'instant' });
    setQuery('');
    if (contents.current) contents.current.open = false;
    if (window.innerWidth <= 780 && chapters.current) chapters.current.open = false;
  }, [route?.slug, section]);

  const markdownComponents = useMemo<Components>(() => {
    function headingNode(level: number, offset: number | undefined, children: ReactNode) {
      const item = document?.headings.find((entry) => entry.offset === offset);
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag
          id={item?.id}
          data-section={item?.id}
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
      pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
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
            学习文档<small>Intelligent UI Lab</small>
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
                matches.map(({ document: result, excerpt }) => (
                  <a
                    key={result.slug}
                    href={docHref(result.slug)}
                    onClick={() => {
                      setQuery('');
                      if (result.slug === document?.slug && !section) {
                        heading.current?.focus({ preventScroll: true });
                        heading.current?.scrollIntoView({ block: 'start' });
                      }
                    }}
                  >
                    <strong>{result.title}</strong>
                    <span>{excerpt}</span>
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
              <article className="doc-prose" ref={article} aria-label={document.title}>
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  urlTransform={(url, key) => {
                    if (key === 'src') {
                      const image = resolveDocImage(url, document.slug);
                      return image ? `${import.meta.env.BASE_URL}${image}` : '';
                    }
                    return defaultUrlTransform(resolveDocLink(url, document.slug) ?? '');
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
