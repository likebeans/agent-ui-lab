import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import projectReadme from '../../README.md?raw';
import { DOC_CHAPTERS, discoverDocChapters, type DocChapter } from '../../shared/doc-navigation';

interface MarkdownNode {
  type: string;
  value?: string;
  depth?: number;
  children?: MarkdownNode[];
  position?: { start: { offset?: number } };
}

export interface DocumentHeading {
  id: string;
  text: string;
  depth: number;
  offset?: number;
}

export interface LearningDocument extends DocChapter {
  source: string;
  headings: DocumentHeading[];
  plainText: string;
}

function nodeText(node: MarkdownNode): string {
  if (node.value !== undefined) return node.value;
  return (node.children ?? []).map(nodeText).join('');
}

function inspectMarkdown(source: string) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as MarkdownNode;
  const headings: DocumentHeading[] = [];
  const used = new Set<string>();
  const text: string[] = [];
  function visit(node: MarkdownNode) {
    if (node.type === 'heading') {
      const label = nodeText(node);
      const base =
        label
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, '')
          .trim()
          .replace(/\s+/gu, '-') || 'section';
      let id = base;
      let duplicate = 1;
      while (used.has(id)) id = `${base}-${duplicate++}`;
      used.add(id);
      headings.push({
        id,
        text: label,
        depth: node.depth ?? 2,
        offset: node.position?.start.offset,
      });
    }
    if (['paragraph', 'heading', 'code', 'tableCell'].includes(node.type))
      text.push(nodeText(node));
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  const firstHeading = tree.children?.find((node) => node.type === 'heading');
  const firstParagraph = tree.children?.find((node) => node.type === 'paragraph');
  return {
    headings,
    plainText: text.join('\n'),
    title: firstHeading ? nodeText(firstHeading).replace(/\s+/gu, ' ').trim() : '',
    description: firstParagraph ? nodeText(firstParagraph).replace(/\s+/gu, ' ').trim() : '',
  };
}

/** Build a reader registry from canonical repository-relative Markdown sources. */
export function createDocuments(
  sources: Readonly<Record<string, string>>,
  chapters: readonly DocChapter[] = DOC_CHAPTERS,
): LearningDocument[] {
  const inspected = new Map(
    Object.entries(sources).map(([file, source]) => [file, { source, ...inspectMarkdown(source) }]),
  );
  const registry = discoverDocChapters(
    Array.from(inspected, ([file, { title, description }]) => ({ file, title, description })),
    chapters,
  );
  return registry.map((chapter) => {
    const content = inspected.get(chapter.file);
    if (!content) throw new Error(`找不到学习文档：${chapter.file}`);
    const { source, headings, plainText } = content;
    return { ...chapter, source, headings, plainText };
  });
}

const sources = import.meta.glob<string>('../../docs/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const documents = createDocuments({
  'README.md': projectReadme,
  ...Object.fromEntries(Object.entries(sources).map(([file, source]) => [file.slice(6), source])),
});

export function searchDocuments(query: string, registry: readonly LearningDocument[] = documents) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return registry.flatMap((document) => {
    if (!terms.length) return [{ document, excerpt: document.description }];
    const searchable =
      `${document.title}\n${document.description}\n${document.plainText}`.toLocaleLowerCase();
    if (!terms.every((term) => searchable.includes(term))) return [];
    const body = document.plainText.replace(/\s+/gu, ' ');
    const found = body.toLocaleLowerCase().indexOf(terms[0]);
    const start = Math.max(0, found - 24);
    return [
      {
        document,
        excerpt: `${start ? '…' : ''}${body.slice(start, start + 100)}${body.length > start + 100 ? '…' : ''}`,
      },
    ];
  });
}
