import { createWorkflowService } from './engine';
import { createMemoryWorkflowStore } from './memory';
import { WORKFLOW_API, WORKFLOW_DROP_HEADER, workflowEnvelopeSchema } from './contract';
import { queryFromSearch, workflowHttpStatus } from './transport';
import { TEACHING_SESSION_HEADER } from '../human-approval/types';

export function createWorkflowStaticHandler() {
  const service = createWorkflowService(createMemoryWorkflowStore());
  function json(value: unknown, status: number) {
    return new Response(JSON.stringify(value), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Lab-Transport': 'browser-memory',
      },
    });
  }
  return async (path: string, options: RequestInit = {}): Promise<Response | undefined> => {
    const url = new URL(path, 'http://fixture.local');
    if (url.pathname !== WORKFLOW_API && !url.pathname.startsWith(`${WORKFLOW_API}/`))
      return undefined;
    options.signal?.throwIfAborted();
    const commands = url.pathname === `${WORKFLOW_API}/commands`;
    const facts = url.pathname === `${WORKFLOW_API}/facts`;
    if (!commands && !facts) return json({ error: '没有此组合实验路由。' }, 404);
    if ((options.method ?? 'GET').toUpperCase() !== (commands ? 'POST' : 'GET'))
      return json(
        { status: 'rejected', code: 'INVALID_INPUT', reason: '此接口不支持该请求方法。' },
        405,
      );
    const headers = new Headers(options.headers);
    const context = { teachingSessionId: headers.get(TEACHING_SESSION_HEADER) ?? '' };
    if (facts) {
      const result = service.facts(context, queryFromSearch(url.searchParams));
      return json(result, workflowHttpStatus(result));
    }
    let envelope;
    try {
      envelope = workflowEnvelopeSchema.safeParse(JSON.parse(String(options.body)));
    } catch {
      return json(
        { status: 'rejected', code: 'INVALID_INPUT', reason: '请求正文必须是有效 JSON。' },
        400,
      );
    }
    if (!envelope.success)
      return json({ status: 'rejected', code: 'INVALID_INPUT', reason: '组合命令格式无效。' }, 400);
    const result = service.command(context, envelope.data.command, envelope.data.action);
    if (headers.get(WORKFLOW_DROP_HEADER) === '1')
      throw new TypeError('组合命令提交后的响应已中断。');
    return json(result, workflowHttpStatus(result));
  };
}
