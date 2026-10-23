export const DOC_CHAPTERS = [
  {
    slug: 'map',
    file: 'docs/README.md',
    title: '学习地图',
    description: '分清角色与协议，找到适合自己的学习顺序。',
    group: '开始学习',
  },
  {
    slug: 'first-session',
    file: 'docs/00-first-session.md',
    title: '第一次学习',
    description: '用 30 分钟对话体验事件、表单与工具应用。',
    group: '开始学习',
  },
  {
    slug: 'learning-method',
    file: 'docs/07-learning-method.md',
    title: '从观察到独立开发',
    description: '追溯原因、修改输入，再用实验验证预测。',
    group: '开始学习',
  },
  {
    slug: 'ag-ui',
    file: 'docs/01-ag-ui.md',
    title: 'AG-UI：从事件到界面',
    description: '理解事件流、状态更新与运行生命周期。',
    group: '理解协议',
  },
  {
    slug: 'a2ui',
    file: 'docs/02-a2ui.md',
    title: 'A2UI：从声明到组件',
    description: '连接组件声明、数据绑定与用户动作。',
    group: '理解协议',
  },
  {
    slug: 'mcp-apps',
    file: 'docs/03-mcp-apps.md',
    title: 'MCP Apps：从工具到应用',
    description: '沿工具、资源与握手理解应用和宿主的边界。',
    group: '理解协议',
  },
  {
    slug: 'reference',
    file: 'docs/06-protocol-reference.md',
    title: '消息对照速查',
    description: '对照消息方向、协议字段与实验记录。',
    group: '实践与参考',
  },
  {
    slug: 'exercises',
    file: 'docs/05-exercises.md',
    title: '练习清单',
    description: '从聊天内实验走向源码修改与组合挑战。',
    group: '实践与参考',
  },
  {
    slug: 'real-development',
    file: 'docs/04-real-development.md',
    title: '真实开发路径',
    description: '逐步接入真实 Agent、业务服务、持久化与部署。',
    group: '实践与参考',
  },
  {
    slug: 'project',
    file: 'README.md',
    title: '项目说明',
    description: '查看启动方式、项目结构、版本与常见问题。',
    group: '实践与参考',
  },
] as const;

export type DocSlug = (typeof DOC_CHAPTERS)[number]['slug'];

const APP_HASHES = new Set(['#chat', '#overview', '#agui', '#a2ui', '#mcp', '#roadmap']);
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Keep a malformed hand-written fragment as text instead of breaking navigation.
    return value;
  }
}

export function isDocsHash(hash: string): boolean {
  return hash === '#docs' || hash.startsWith('#docs/');
}

export function parseDocsHash(hash: string): { slug: string; section: string } | null {
  if (!isDocsHash(hash)) return null;
  if (hash === '#docs') return { slug: 'map', section: '' };

  const route = hash.slice('#docs/'.length);
  const queryIndex = route.indexOf('?');
  const slug = decodeFragment(queryIndex < 0 ? route : route.slice(0, queryIndex));
  const query = queryIndex < 0 ? '' : route.slice(queryIndex + 1);
  return { slug, section: new URLSearchParams(query).get('section') ?? '' };
}

export function docHref(slug: string, section = ''): string {
  const hash = `#docs/${encodeURIComponent(slug)}`;
  return section ? `${hash}?section=${encodeURIComponent(section)}` : hash;
}

function resolveDocFile(path: string, currentSlug: DocSlug): string | null {
  const current = DOC_CHAPTERS.find((chapter) => chapter.slug === currentSlug);
  if (!current || path.includes('?') || path.endsWith('/')) return null;

  const segments = path.startsWith('/') ? [] : current.file.split('/').slice(0, -1);
  for (const encodedSegment of path.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(encodedSegment);
    } catch {
      return null;
    }
    if (segment.includes('/') || UNSAFE_PATH_CHARACTERS.test(segment)) return null;
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      // Do not turn a path outside the repository into a known document at its root.
      if (!segments.length) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

/** Serve repository screenshots from Vite's public directory, including under a base path. */
export function resolveDocImage(href: string, currentSlug: DocSlug): string | null {
  const value = href.trim();
  if (!value || UNSAFE_PATH_CHARACTERS.test(value)) return null;
  const file = resolveDocFile(value, currentSlug);
  return file && /^public\/readme\/screenshots\/[a-z0-9][a-z0-9-]*\.png$/u.test(file)
    ? file.slice('public/'.length)
    : null;
}

/** Resolve a Markdown link destination, without rewriting Markdown or source-code references. */
export function resolveDocLink(href: string, currentSlug: DocSlug): string | null {
  const value = href.trim();
  if (!value || UNSAFE_PATH_CHARACTERS.test(value) || value.startsWith('//')) return null;

  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    try {
      const { protocol } = new URL(value);
      return ['http:', 'https:', 'mailto:'].includes(protocol) ? value : null;
    } catch {
      return null;
    }
  }

  const hash = value.startsWith('/#') ? value.slice(1) : value;
  if (APP_HASHES.has(hash)) return hash;
  const docsRoute = parseDocsHash(hash);
  if (docsRoute) return docHref(docsRoute.slug, docsRoute.section);
  if (value.startsWith('#')) return docHref(currentSlug, decodeFragment(value.slice(1)));

  const fragmentIndex = value.indexOf('#');
  const path = fragmentIndex < 0 ? value : value.slice(0, fragmentIndex);
  const file = resolveDocFile(path, currentSlug);
  const chapter = DOC_CHAPTERS.find((item) => item.file === file);
  if (!chapter) return null;
  const section = fragmentIndex < 0 ? '' : decodeFragment(value.slice(fragmentIndex + 1));
  return docHref(chapter.slug, section);
}
