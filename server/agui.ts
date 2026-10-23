import { EventType, type AGUIEvent, type RunAgentInput } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import type { Express, Response } from 'express';
import { parseTripRunInput, streamTripRun } from '../shared/agui-agent';

export { buildTripPlan } from '../shared/agui-agent';

const EVENT_DELAY_MS = process.env.NODE_ENV === 'test' ? 2 : 150;
const MAX_ACTIVE_RUNS = 12;
const MAX_RECENT_RUNS = 256;
const RECENT_RUN_TTL_MS = 10 * 60 * 1000;

interface ActiveRun {
  cancelRequested: boolean;
  disconnected: boolean;
  controller: AbortController;
}

const activeRuns = new Map<string, ActiveRun>();
const recentRunIds = new Map<string, number>();

export function installAguiRoutes(app: Express): void {
  app.post('/api/agui', (request, response) => {
    let input: RunAgentInput;
    try {
      input = parseTripRunInput(request.body);
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : 'RunAgentInput 不合法。',
      });
      return;
    }
    if (activeRuns.size >= MAX_ACTIVE_RUNS) {
      response.status(429).json({ error: '同时运行的实验过多，请稍后重试。' });
      return;
    }
    pruneRecentRuns();
    if (activeRuns.has(input.runId) || recentRunIds.has(input.runId)) {
      response.status(409).json({ error: 'runId 已使用；重试必须创建新的 runId。' });
      return;
    }

    const run: ActiveRun = {
      cancelRequested: false,
      disconnected: false,
      controller: new AbortController(),
    };
    activeRuns.set(input.runId, run);
    recentRunIds.set(input.runId, Date.now());
    trimRecentRuns();

    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    const onClose = () => {
      if (!response.writableEnded) {
        run.disconnected = true;
        run.controller.abort();
      }
    };
    response.on('close', onClose);

    void streamTripRun(
      input,
      (event) => sendEvent(response, event),
      {
        get cancelRequested() {
          return run.cancelRequested;
        },
        signal: run.controller.signal,
      },
      EVENT_DELAY_MS,
    )
      .catch(async (error: unknown) => {
        if (run.disconnected || response.writableEnded || response.destroyed) return;
        const message = error instanceof Error ? error.message : '确定性 Agent 执行失败。';
        try {
          await sendEvent(response, {
            type: EventType.RUN_ERROR,
            message,
            code: 'DETERMINISTIC_AGENT_ERROR',
          });
        } catch (sendError) {
          if (!(sendError instanceof ClientDisconnected)) console.error(sendError);
        }
      })
      .finally(() => {
        activeRuns.delete(input.runId);
        response.off('close', onClose);
        if (!response.writableEnded && !run.disconnected) response.end();
      });
  });

  app.post('/api/agui/:runId/cancel', (request, response) => {
    const runId = String(request.params.runId ?? '');
    const run = activeRuns.get(runId);
    if (!run) {
      response.status(404).json({ error: '运行不存在或已经结束。' });
      return;
    }
    run.cancelRequested = true;
    response.status(202).json({ runId, status: 'cancelling' });
  });
}

async function sendEvent(response: Response, event: AGUIEvent): Promise<void> {
  const validated = EventSchemas.parse(event);
  if (response.destroyed || response.writableEnded) throw new ClientDisconnected();
  const canContinue = response.write(`data: ${JSON.stringify(validated)}\n\n`);
  if (!canContinue)
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new ClientDisconnected());
      };
      const cleanup = () => {
        response.off('drain', onDrain);
        response.off('close', onClose);
      };
      response.once('drain', onDrain);
      response.once('close', onClose);
    });
}

function pruneRecentRuns(): void {
  const threshold = Date.now() - RECENT_RUN_TTL_MS;
  for (const [runId, createdAt] of recentRunIds)
    if (createdAt < threshold && !activeRuns.has(runId)) recentRunIds.delete(runId);
}

function trimRecentRuns(): void {
  while (recentRunIds.size > MAX_RECENT_RUNS) {
    const oldest = recentRunIds.keys().next().value as string | undefined;
    if (!oldest) return;
    if (activeRuns.has(oldest)) {
      const createdAt = recentRunIds.get(oldest)!;
      recentRunIds.delete(oldest);
      recentRunIds.set(oldest, createdAt);
    } else recentRunIds.delete(oldest);
  }
}

class ClientDisconnected extends Error {}
