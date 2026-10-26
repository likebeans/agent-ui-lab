import { EventSchemas } from '@ag-ui/core/schemas';
import { z } from 'zod';
import { routeChat } from './chat-agent';
import { LAB_INSTANCE_ID } from './instance';
import { staticLabFetch } from './labs/static-handlers';
import {
  createInitialA2uiMessages,
  createA2uiActionMessages,
  createDeleteA2uiMessage,
} from './a2ui-agent';
import { parseTripRunInput, streamTripRun } from './agui-agent';

const activeRuns = new Map<string, { cancelRequested: boolean; signal: AbortSignal }>();
const recentRunIds = new Set<string>();

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Lab-Transport': 'browser-memory' },
  });
}

// These are local teaching routes. No HTTP request is sent in Pages mode.
export async function staticFetch(path: string, options: RequestInit = {}): Promise<Response> {
  options.signal?.throwIfAborted();
  const method = (options.method ?? 'GET').toUpperCase();
  try {
    if (path === '/api/health' && method === 'GET')
      return json({ status: 'ok', mode: 'browser-static', instanceId: LAB_INSTANCE_ID });
    const labResponse = await staticLabFetch(path, options);
    options.signal?.throwIfAborted();
    if (labResponse) return labResponse;
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
    if (path === '/api/chat' && method === 'POST') return json(routeChat(body));
    if (path === '/api/a2ui/surface' && (method === 'GET' || method === 'POST'))
      return json({ messages: createInitialA2uiMessages(body), agent: 'deterministic-fixture' });
    if (path === '/api/a2ui/action' && method === 'POST')
      return json({ messages: createA2uiActionMessages(body), agent: 'deterministic-fixture' });
    const surface = path.match(/^\/api\/a2ui\/surface\/([^/]+)$/u);
    if (surface && method === 'DELETE')
      return json({ messages: [createDeleteA2uiMessage(decodeURIComponent(surface[1]))] });
    const cancel = path.match(/^\/api\/agui\/([^/]+)\/cancel$/u);
    if (cancel && method === 'POST') {
      const runId = decodeURIComponent(cancel[1]);
      const run = activeRuns.get(runId);
      if (!run) return json({ error: '运行不存在或已经结束。' }, 404);
      run.cancelRequested = true;
      return json({ runId, status: 'cancelling' }, 202);
    }
    if (path !== '/api/agui' || method !== 'POST')
      return json({ error: '静态学习版没有此教学路由。' }, 404);

    const input = parseTripRunInput(body);
    if (activeRuns.size >= 12) return json({ error: '同时运行的实验过多，请稍后重试。' }, 429);
    if (activeRuns.has(input.runId) || recentRunIds.has(input.runId))
      return json({ error: 'runId 已使用；重试必须创建新的 runId。' }, 409);
    recentRunIds.add(input.runId);
    if (recentRunIds.size > 256) recentRunIds.delete(recentRunIds.values().next().value!);
    const controller = new AbortController();
    const run = { cancelRequested: false, signal: controller.signal };
    activeRuns.set(input.runId, run);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(sink) {
        const onAbort = () => sink.error(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        const send = async (event: Parameters<typeof EventSchemas.parse>[0]) => {
          controller.signal.throwIfAborted();
          const validated = EventSchemas.parse(event);
          sink.enqueue(encoder.encode(`data: ${JSON.stringify(validated)}\n\n`));
        };
        let failed = false;
        void streamTripRun(input, send, run, 150)
          .catch((error: unknown) => {
            failed = true;
            if (!controller.signal.aborted) sink.error(error);
          })
          .finally(() => {
            activeRuns.delete(input.runId);
            controller.signal.removeEventListener('abort', onAbort);
            options.signal?.removeEventListener('abort', abort);
            if (!failed && !controller.signal.aborted) sink.close();
          });
      },
      cancel() {
        controller.abort();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Lab-Transport': 'browser-memory',
      },
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return json(
      {
        error:
          error instanceof z.ZodError
            ? error.issues[0]?.message
            : error instanceof Error
              ? error.message
              : '静态演示请求不合法。',
      },
      400,
    );
  }
}
