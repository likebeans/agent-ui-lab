import type { StaticLabHandler } from '../static-handlers';
import type { CompatibilityReply } from './contract';
import { createCompatibilityEngine } from './engine';

const root = '/api/labs/a2ui-compatibility/documents';
const statusCodes = { snapshot: 200, accepted: 200, conflict: 409, invalid: 400, 'not-found': 404 };

function response(reply: CompatibilityReply): Response {
  return new Response(JSON.stringify(reply), {
    status: statusCodes[reply.kind],
    headers: { 'Content-Type': 'application/json', 'X-Lab-Transport': 'browser-memory' },
  });
}

export function createA2uiCompatibilityStaticHandler(): StaticLabHandler {
  const engine = createCompatibilityEngine();
  return async (path, options) => {
    const pathname = path.split('?')[0].replace(/\/$/u, '');
    const method = (options.method ?? 'GET').toUpperCase();
    const match = pathname.match(
      /^\/api\/labs\/a2ui-compatibility\/documents\/([^/]+)(?:\/(remote|actions))?$/u,
    );
    const create = pathname === root && method === 'POST';
    const read = match && !match[2] && method === 'GET';
    const write = match && match[2] && method === 'POST';
    if (!create && !read && !write) return undefined;
    options.signal?.throwIfAborted();

    let documentId = '';
    if (match) {
      try {
        documentId = decodeURIComponent(match[1]);
      } catch {
        return response({ kind: 'invalid', message: 'documentId 编码无效。', issues: [] });
      }
    }
    if (read) return response(engine.read(documentId));

    let input: unknown;
    try {
      if (typeof options.body === 'string' && options.body.length > 0) {
        input = JSON.parse(options.body);
        if (input === null || typeof input !== 'object') throw new Error('Expected JSON object');
      }
    } catch {
      return response({ kind: 'invalid', message: '请求 JSON 无效。', issues: [] });
    }
    if (create) return response(engine.create(input));
    return response(
      match?.[2] === 'remote' ? engine.change(documentId, input) : engine.act(documentId, input),
    );
  };
}
