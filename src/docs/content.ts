import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import projectReadme from '../../README.md?raw';
import { DOC_CHAPTERS, discoverDocChapters, type DocChapter } from '../../shared/doc-navigation';

interface MarkdownNode {
  type: string;
  value?: string;
  depth?: number;
  identifier?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number } };
}

export interface DocumentHeading {
  id: string;
  text: string;
  depth: number;
  offset?: number;
}

interface DocumentSearchBlock {
  text: string;
  offset?: number;
  section?: DocumentHeading;
}

export interface LearningDocument extends DocChapter {
  source: string;
  headings: DocumentHeading[];
  plainText: string;
  searchBlocks: DocumentSearchBlock[];
}

export interface DocumentSearchMatch {
  document: LearningDocument;
  excerpt: string;
  section?: DocumentHeading;
  targetOffset?: number;
}

function nodeText(node: MarkdownNode): string {
  if (node.type === 'html') return '';
  if (node.value !== undefined) return node.value;
  return (node.children ?? []).map(nodeText).join('');
}

function inspectMarkdown(source: string) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as MarkdownNode;
  const footnotes = new Map<string, MarkdownNode>();
  const visibleFootnotes = new Set<MarkdownNode>();
  function collectFootnotes(node: MarkdownNode) {
    if (node.type === 'footnoteDefinition') {
      const id = (node.identifier ?? '').toUpperCase();
      if (!footnotes.has(id)) footnotes.set(id, node);
    }
    for (const child of node.children ?? []) collectFootnotes(child);
  }
  function collectReferences(node: MarkdownNode) {
    if (node.type === 'footnoteDefinition') return;
    if (node.type === 'footnoteReference') {
      const definition = footnotes.get((node.identifier ?? '').toUpperCase());
      if (definition && !visibleFootnotes.has(definition)) {
        visibleFootnotes.add(definition);
        for (const child of definition.children ?? []) collectReferences(child);
      }
    }
    for (const child of node.children ?? []) collectReferences(child);
  }
  // The renderer emits only referenced footnotes, using the first definition of each ID.
  collectFootnotes(tree);
  collectReferences(tree);
  const headings: DocumentHeading[] = [];
  const used = new Set<string>();
  const searchBlocks: DocumentSearchBlock[] = [];
  let section: DocumentHeading | undefined;
  function visit(node: MarkdownNode) {
    if (node.type === 'footnoteDefinition' && !visibleFootnotes.has(node)) return;
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
      section = {
        id,
        text: label,
        depth: node.depth ?? 2,
        offset: node.position?.start.offset,
      };
      headings.push(section);
    }
    if (['paragraph', 'heading', 'code', 'tableCell'].includes(node.type))
      searchBlocks.push({ text: nodeText(node), offset: node.position?.start.offset, section });
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  const firstHeading = tree.children?.find((node) => node.type === 'heading');
  const firstParagraph = tree.children?.find((node) => node.type === 'paragraph');
  return {
    headings,
    searchBlocks,
    plainText: searchBlocks.map((block) => block.text).join('\n'),
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
    const { source, headings, plainText, searchBlocks } = content;
    return { ...chapter, source, headings, plainText, searchBlocks };
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

export function searchDocuments(
  query: string,
  registry: readonly LearningDocument[] = documents,
): DocumentSearchMatch[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return registry.flatMap((document) => {
    if (!terms.length) return [{ document, excerpt: document.description }];
    const searchable =
      `${document.title}\n${document.description}\n${document.plainText}`.toLocaleLowerCase();
    if (!terms.every((term) => searchable.includes(term))) return [];
    let block: DocumentSearchBlock | undefined;
    let score = 0;
    for (const candidate of document.searchBlocks) {
      const text = candidate.text.toLocaleLowerCase();
      const hits = terms.filter((term) => text.includes(term)).length;
      // Prefer the block covering most terms, then a subsection over the introduction.
      const candidateScore = hits ? hits * 2 + Number((candidate.section?.depth ?? 0) > 1) : 0;
      if (candidateScore > score) {
        block = candidate;
        score = candidateScore;
      }
    }
    const metadata = terms.some((term) => document.description.toLocaleLowerCase().includes(term))
      ? document.description
      : document.title;
    const body = (block?.text ?? metadata).replace(/\s+/gu, ' ');
    const found = Math.min(
      ...terms.map((term) => body.toLocaleLowerCase().indexOf(term)).filter((index) => index >= 0),
    );
    const start = Number.isFinite(found) ? Math.max(0, found - 24) : 0;
    return [
      {
        document,
        section: block?.section,
        targetOffset: block?.offset,
        excerpt: `${start ? '…' : ''}${body.slice(start, start + 100)}${body.length > start + 100 ? '…' : ''}`,
      },
    ];
  });
}
