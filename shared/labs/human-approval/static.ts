import { createApprovalService, type ApprovalService } from './engine';
import { createMemoryApprovalStore } from './memory';
import {
  APPROVAL_API,
  DROP_RESPONSE_HEADER,
  TEACHING_SESSION_HEADER,
  type ApprovalFactsResult,
  type ApprovalResult,
} from './types';

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json');
  responseHeaders.set('X-Lab-Transport', 'browser-memory');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function httpStatus(result: ApprovalResult | ApprovalFactsResult): number {
  if (result.status === 'accepted' || result.status === 'found') return 200;
  if (result.status === 'conflict') return 409;
  switch (result.code) {
    case 'SESSION_MISMATCH':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'KEY_REUSED':
      return 409;
    case 'EXPIRED':
      return 410;
    default:
      return 400;
  }
}

export function createStaticApprovalHandler({
  service = createApprovalService(createMemoryApprovalStore()),
}: { service?: ApprovalService } = {}): (
  path: string,
  options?: RequestInit,
) => Promise<Response | undefined> {
  return async (path, options = {}) => {
    const queryStart = path.indexOf('?');
    const pathname = queryStart < 0 ? path : path.slice(0, queryStart);
    if (pathname !== APPROVAL_API && !pathname.startsWith(`${APPROVAL_API}/`)) return undefined;
    options.signal?.throwIfAborted();
    const commandRoute = pathname === `${APPROVAL_API}/commands`;
    const factsRoute = pathname === `${APPROVAL_API}/facts`;
    if (!commandRoute && !factsRoute) return json({ error: '没有此审批教学路由。' }, 404);
    const expectedMethod = commandRoute ? 'POST' : 'GET';
    if ((options.method ?? 'GET').toUpperCase() !== expectedMethod)
      return json({ error: '此审批路由不支持该请求方法。' }, 405, { Allow: expectedMethod });

    const headers = new Headers(options.headers);
    const context = { teachingSessionId: headers.get(TEACHING_SESSION_HEADER) ?? '' };
    let result: ApprovalResult | ApprovalFactsResult;
    if (commandRoute) {
      let input: unknown;
      try {
        input = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
      } catch {
        return json(
          {
            status: 'rejected',
            code: 'INVALID_INPUT',
            reason: '请求正文必须是有效 JSON。',
          } satisfies ApprovalResult,
          400,
        );
      }
      result = service.command(context, input);
      options.signal?.throwIfAborted();
      // Model a lost response only after the transaction has committed.
      if (headers.get(DROP_RESPONSE_HEADER) === '1')
        throw new TypeError('审批命令响应连接已中断。');
    } else {
      const query: Record<string, string | string[]> = Object.create(null);
      const search = new URLSearchParams(queryStart < 0 ? '' : path.slice(queryStart + 1));
      for (const key of new Set(search.keys())) {
        const values = search.getAll(key);
        query[key] = values.length === 1 ? values[0] : values;
      }
      result = service.facts(context, query);
    }
    options.signal?.throwIfAborted();
    return json(result, httpStatus(result));
  };
}

export const humanApprovalStaticHandler = createStaticApprovalHandler();
