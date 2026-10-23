import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import projectReadme from '../../README.md?raw';
import { DOC_CHAPTERS } from '../../shared/doc-navigation';

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
  return { headings, plainText: text.join('\n') };
}

const sources = import.meta.glob<string>('../../docs/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const documents = DOC_CHAPTERS.map((chapter) => {
  const source = chapter.file === 'README.md' ? projectReadme : sources[`../../${chapter.file}`];
  if (typeof source !== 'string') throw new Error(`找不到学习文档：${chapter.file}`);
  return { ...chapter, source, ...inspectMarkdown(source) };
});

export function searchDocuments(query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return documents.flatMap((document) => {
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
